import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import type { Env } from './config.js';
import { baseUrl } from './config.js';
import { errorBody, HttpError } from './http/errors.js';
import type { AppDeps } from './types.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { checkoutRoutes } from './routes/checkout.js';
import { webhookRoutes } from './routes/webhooks.js';
import { updatesRoutes } from './routes/updates.js';
import { adminRoutes } from './routes/admin.js';

export interface BuildAppOptions {
  deps: AppDeps;
  logger?: boolean | Record<string, unknown>;
}

export { rawBodyOf } from './http/raw-body.js';

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { deps } = opts;
  const env: Env = deps.env;

  const app = Fastify({
    logger: opts.logger ?? { level: env.LOG_LEVEL },
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 1_048_576,
    // HTTPS терминируется прокси; сами сокеты не создаём в небезопасном режиме.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array' } },
  });

  app.decorate('deps', deps);

  // --- raw body для подписей ------------------------------------------------
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 1_048_576 },
    (req, body, done) => {
      (req as unknown as { rawBody?: string }).rawBody = typeof body === 'string' ? body : String(body ?? '');
      const text = (req as unknown as { rawBody: string }).rawBody;
      if (!text) return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error, undefined);
      }
    },
  );
  app.addContentTypeParser(
    ['text/plain', 'application/x-www-form-urlencoded'],
    { parseAs: 'string', bodyLimit: 1_048_576 },
    (req, body, done) => {
      const text = typeof body === 'string' ? body : String(body ?? '');
      (req as unknown as { rawBody?: string }).rawBody = text;
      try {
        done(null, JSON.parse(text));
      } catch {
        done(null, text);
      }
    },
  );

  // --- безопасность ---------------------------------------------------------
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", 'https://accounts.google.com', 'https://oauth.yandex.ru'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        upgradeInsecureRequests: env.NODE_ENV === 'production' ? [] : null,
      },
    },
    hsts: env.REQUIRE_HTTPS
      ? { maxAge: env.HSTS_MAX_AGE, includeSubDomains: true, preload: true }
      : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  await app.register(cookie, { secret: env.SESSION_SECRET });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Отдельные лимиты задаются на маршрутах (auth/checkout/admin/webhook).
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true },
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true,
      'retry-after': true,
    },
    errorResponseBuilder: (request, context) => ({
      error: {
        code: 'rate_limited',
        message: `Too many requests. Retry in ${context.after}`,
        details: { limit: context.max, window: context.ttl },
      },
    }),
    // Для health-проб лимиты не применяем.
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
  });

  // --- HTTPS only -----------------------------------------------------------
  if (env.REQUIRE_HTTPS) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/healthz' || request.url === '/readyz') return;
      const proto = env.TRUST_PROXY
        ? (request.headers['x-forwarded-proto'] as string | undefined) ?? request.protocol
        : request.protocol;
      if (proto === 'https') return;
      // Локальная разработка/тесты без TLS: не ломаем, только логируем.
      if (env.NODE_ENV !== 'production') return;
      const host = (request.headers.host ?? '').split(':')[0];
      if (!host) return reply.code(400).send(errorBody(new HttpError(400, 'bad_request', 'Missing host')));
      return reply.redirect(`https://${host}${request.url}`, 301);
    });
  }

  app.addHook('onRequest', async (request, reply) => {
    // Базовые заголовки, которые не покрывает helmet.
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');

    const origin = request.headers.origin;
    if (!origin) return;
    const allowed = allowedOrigins(env);
    if (allowed.has(origin)) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('vary', 'origin');
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
      reply.header('access-control-allow-headers', 'content-type, x-idempotency-key');
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
  });

  // --- ошибки ---------------------------------------------------------------
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error instanceof HttpError ? error.status : (error.statusCode ?? 500);
    if (status >= 500) {
      request.log.error({ err: error, url: request.url }, 'request failed');
    } else {
      request.log.debug({ err: error, url: request.url }, 'request rejected');
    }
    if (error instanceof HttpError) {
      return reply.code(status).send(errorBody(error));
    }
    if (error.validation) {
      return reply.code(400).send(
        errorBody(new HttpError(400, 'validation_error', error.message)),
      );
    }
    if (status === 429) {
      return reply.code(429).send(
        errorBody(new HttpError(429, 'rate_limited', error.message || 'Too many requests')),
      );
    }
    return reply.code(status >= 500 ? 500 : status).send(
      errorBody(new HttpError(status, error.code ?? 'internal_error', error.message)),
    );
  });

  // Симуляция оплаты доступна только в dev-профиле с mock-провайдером.
  // Хук закрывает и маршрут, и статический файл /checkout/mock.html.
  if (!(env.PAYMENT_PROVIDER === 'mock' && env.NODE_ENV !== 'production')) {
    app.addHook('onRequest', async (request, reply) => {
      if (request.url === '/checkout/mock' || request.url.startsWith('/checkout/mock.')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
      }
    });
  }

  // --- маршруты API ---------------------------------------------------------
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(checkoutRoutes);
  await app.register(webhookRoutes);
  await app.register(updatesRoutes);
  await app.register(adminRoutes);

  // --- статика: витрина на / и панель на /manage -----------------------------
  const publicDir = path.resolve(env.PUBLIC_DIR.startsWith('/') ? env.PUBLIC_DIR : path.resolve(process.cwd(), env.PUBLIC_DIR));
  if (existsSync(publicDir)) {
    await app.register(fastifyStatic, {
      root: publicDir,
      prefix: '/',
      index: ['index.html'],
      wildcard: false,
      maxAge: env.NODE_ENV === 'production' ? 300_000 : 0,
      dotfiles: 'deny',
    });

    // Точка входа панели управления: домен/manage (роль admin проверяет API).
    const manageIndex = path.join(publicDir, 'manage', 'index.html');
    app.get('/manage', async (_request, reply) => {
      if (!existsSync(manageIndex)) {
        return reply.code(500).type('text/html; charset=utf-8').send('<h1>Manage panel is not installed</h1>');
      }
      return reply.type('text/html; charset=utf-8').sendFile('manage/index.html');
    });

    // Личный кабинет пользователя: подписка, оплата, заказы, профиль.
    app.get('/account', async (_request, reply) =>
      reply.type('text/html; charset=utf-8').sendFile('account/index.html'),
    );

    // Возврат с оплаты: статус подтверждается сервером, а не фактом возврата.
    app.get('/checkout/success', async (_request, reply) =>
      reply.type('text/html; charset=utf-8').sendFile('checkout/success.html'),
    );

    // Симуляция оплаты существует только в dev-профиле с mock-провайдером.
    // В остальных случаях маршрут и сам файл закрыты (404), чтобы в production
    // не было даже страницы, напоминающей о «бесплатной оплате».
    if (env.PAYMENT_PROVIDER === 'mock' && env.NODE_ENV !== 'production') {
      app.get('/checkout/mock', async (_request, reply) =>
        reply.type('text/html; charset=utf-8').sendFile('checkout/mock.html'),
      );
    }

    // SPA-подобная витрина: неизвестные не-API пути отдаём как index.html.
    registerNotFoundHandler(app, publicDir);
  } else {
    app.log.warn({ publicDir }, 'public directory not found: static site is disabled');
    registerNotFoundHandler(app, null);
  }

  app.get('/api/v1/config', async () => ({
    name: 'SHELTER',
    baseUrl: baseUrl(env),
    supportEmail: env.SUPPORT_EMAIL,
    authProviders: Object.keys(deps.authProviders).filter((k) => deps.authProviders[k]?.enabled && k !== 'dev'),
    devLogin: env.DEV_LOGIN_ENABLED,
    payments: { provider: env.PAYMENT_PROVIDER },
    updates: { enabled: env.UPDATES_ENABLED, channel: await deps.updates.getChannel() },
  }));

  return app;
}

/**
 * 404-обработчик:
 *  - для /api/* и /manage/api/* всегда JSON (клиенту браузера не нужен HTML);
 *  - для остальных GET — витрина (если publicDir на месте), иначе HTML-404.
 */
function registerNotFoundHandler(app: FastifyInstance, publicDir: string | null): void {
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/') || request.url.startsWith('/manage/api/');
    if (isApi || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Route not found' } });
    }
    if (publicDir && existsSync(path.join(publicDir, 'index.html'))) {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }
    return reply.code(404).type('text/html; charset=utf-8').send(notFoundPage());
  });
}

export function allowedOrigins(env: Env): Set<string> {
  const set = new Set<string>(env.ALLOWED_ORIGINS.filter(Boolean));
  if (env.PUBLIC_BASE_URL) set.add(env.PUBLIC_BASE_URL.replace(/\/+$/, ''));
  return set;
}

function notFoundPage(): string {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>404 — SHELTER</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
main{text-align:center;padding:40px}h1{font-size:64px;margin:0 0 12px;letter-spacing:-.02em}p{opacity:.65;margin:0 0 24px}
a{color:#2997ff;text-decoration:none}</style></head>
<body><main><h1>404</h1><p>Страница не найдена</p><a href="/">На главную</a></main></body></html>`;
}
