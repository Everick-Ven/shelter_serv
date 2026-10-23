import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { baseUrl } from '../config.js';
import type { UserRow } from '../db/types.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { signValue, unsignValue } from '../lib/tokens.js';
import { authenticate } from '../plugins/auth.js';
import { OAuthError, type OAuthProviderName } from '../providers/auth/types.js';

const STATE_COOKIE = 'shelter_oauth_state';
const STATE_TTL_SECONDS = 600;

const startQuery = z.object({
  redirect: z.string().max(512).optional(),
});

/**
 * Разрешён ли редирект после входа. Принимаем только:
 *  - относительный путь, начинающийся с одного `/` (не `//`, не `/\`),
 *  - либо абсолютный URL из ALLOWED_ORIGINS / PUBLIC_BASE_URL.
 * Всё прочее — классический open redirect, отклоняем.
 */
export function safeRedirect(value: string | undefined, env: {
  ALLOWED_ORIGINS: string[];
  PUBLIC_BASE_URL?: string;
}): string {
  const fallback = '/manage';
  if (!value) return fallback;
  const v = value.trim();
  if (!v) return fallback;
  if (v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\')) {
    // Запрещаем управляющие символы и переносы строк (header splitting).
    if (/[\r\n\t]/.test(v)) return fallback;
    return v;
  }
  try {
    const url = new URL(v);
    if (url.protocol !== 'https:') return fallback;
    const allowed = new Set(env.ALLOWED_ORIGINS.map((o) => new URL(o).origin));
    if (env.PUBLIC_BASE_URL) allowed.add(new URL(env.PUBLIC_BASE_URL).origin);
    return allowed.has(url.origin) ? `${url.pathname}${url.search}${url.hash}` : fallback;
  } catch {
    return fallback;
  }
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { env, store, sessions, authProviders } = app.deps;

  const providerNames = Object.keys(authProviders).filter((k) => authProviders[k]?.enabled);

  app.get('/api/v1/auth/providers', async () => ({
    providers: providerNames.map((name) => ({
      name,
      label: name === 'google' ? 'Google' : name === 'yandex' ? 'Yandex ID' : name,
      startUrl: `/api/v1/auth/${name}/start`,
    })),
    devLogin: env.DEV_LOGIN_ENABLED,
    /**
     * Админка входит логином+паролем независимо от OAuth. Демо-подсказка
     * показывается только вне production (в production она равна null).
     */
    adminLogin: {
      enabled: true,
      /** Кнопка «Демо-вход» без пароля: только вне production. */
      demoLogin: app.deps.adminAuth.demoLoginEnabled(),
    },
  }));

  /**
   * Демо-вход в панель БЕЗ пароля (только вне production): одна кнопка на
   * экране входа. В production отвечает 403 — доступ даёт только пароль.
   */
  app.post(
    '/manage/api/demo-login',
    {
      config: {
        rateLimit: { max: env.RATE_LIMIT_AUTH_MAX, timeWindow: env.RATE_LIMIT_AUTH_WINDOW },
      },
    },
    async (request, reply) => {
      if (!app.deps.adminAuth.demoLoginEnabled()) {
        throw forbidden('demo_login_disabled', 'Демо-вход отключён в production');
      }
      const user = await app.deps.adminAuth.ensureDemoAdmin();
      const session = await sessions.issue(user, {
        userAgent: request.headers['user-agent'] ?? null,
        ip: request.ip,
      });
      reply.setCookie(env.COOKIE_NAME, session.token, sessions.cookieOptions(session.expiresAt));
      await store.eventInsert('admin.demo_login', user.id, null);
      request.log.info({ userId: user.id }, 'admin demo login (no password, non-production)');
      return { ok: true, user: publicUser(user) };
    },
  );

  /**
   * Вход в панель `/manage`: логин + пароль. Работает без настроенного OAuth.
   * Rate limit жёсткий: перебор пароля должен быть дорогим.
   */
  app.post<{ Body: unknown }>(
    '/manage/api/login',
    {
      config: {
        rateLimit: {
          max: env.RATE_LIMIT_AUTH_MAX,
          timeWindow: env.RATE_LIMIT_AUTH_WINDOW,
        },
      },
    },
    async (request, reply) => {
      const body = z
        .object({
          /** Email или короткий логин администратора (по умолчанию `admin`). */
          email: z.string().min(1).max(254),
          password: z.string().min(1).max(256),
        })
        .safeParse(request.body ?? {});
      if (!body.success) throw badRequest('invalid_body', 'Нужны логин и пароль');

      const user = await app.deps.adminAuth.verify(body.data.email, body.data.password);
      const session = await sessions.issue(user, {
        userAgent: request.headers['user-agent'] ?? null,
        ip: request.ip,
      });
      reply.setCookie(env.COOKIE_NAME, session.token, sessions.cookieOptions(session.expiresAt));
      await store.eventInsert('admin.login', user.id, { method: 'password' });
      request.log.info({ userId: user.id }, 'admin logged in with password');
      return { ok: true, user: publicUser(user) };
    },
  );

  /** Текущая сессия панели (для bootstrap SPA): 401, если не авторизован. */
  app.get('/manage/api/session', { preHandler: [authenticate] }, async (request) => {
    if (request.currentUser!.role !== 'admin') throw forbidden('admin_only', 'Панель доступна только администраторам');
    return { authenticated: true, user: publicUser(request.currentUser!) };
  });

  /** Выход из панели: сессия отзывается сервером, cookie стирается. */
  app.post('/manage/api/logout', { preHandler: [authenticate] }, async (request, reply) => {
    if (request.currentSessionId) await sessions.revoke(request.currentSessionId);
    reply.clearCookie(env.COOKIE_NAME, { path: '/' });
    await store.eventInsert('admin.logout', request.currentUser!.id, null);
    return { ok: true };
  });

  app.get('/api/v1/auth/session', { preHandler: [authenticate] }, async (request) => ({
    authenticated: true,
    user: publicUser(request.currentUser!),
  }));

  app.get<{ Params: { provider: string }; Querystring: unknown }>(
    '/api/v1/auth/:provider/start',
    async (request, reply) => {
      const providerName = request.params.provider;
      const provider = authProviders[providerName];
      if (!provider || !provider.enabled) throw notFound('provider_not_found', `Unknown auth provider: ${providerName}`);

      const parsed = startQuery.safeParse(request.query ?? {});
      if (!parsed.success) throw badRequest('invalid_query', 'Invalid query parameters');
      const redirect = safeRedirect(parsed.data.redirect, env);

      const state = signValue(env.SESSION_SECRET, `${providerName}|${redirect}`, STATE_TTL_SECONDS);
      reply.setCookie(STATE_COOKIE, state, {
        path: '/',
        httpOnly: true,
        secure: env.COOKIE_SECURE,
        sameSite: 'lax',
        maxAge: STATE_TTL_SECONDS,
        domain: env.COOKIE_DOMAIN,
      });

      const url = provider.authorizeUrl({ state, redirectUri: redirectUriFor(providerName, request) });
      await store.eventInsert('auth.start', null, { provider: providerName });
      return reply.redirect(url);
    },
  );

  app.get<{ Params: { provider: string }; Querystring: unknown }>(
    '/api/v1/auth/:provider/callback',
    async (request, reply) => {
      const providerName = request.params.provider;
      const provider = authProviders[providerName];
      if (!provider || !provider.enabled) throw notFound('provider_not_found', `Unknown auth provider: ${providerName}`);

      const q = z
        .object({ code: z.string().min(1).max(2048), state: z.string().min(1).max(2048) })
        .safeParse(request.query ?? {});
      if (!q.success) {
        // OAuth-провайдер мог вернуть error=access_denied — это не 500.
        throw badRequest('invalid_callback', 'Missing code or state');
      }

      // CSRF: state из query обязан совпасть с подписанным state из cookie.
      const cookieState = (request.cookies as Record<string, string | undefined>)[STATE_COOKIE];
      if (!cookieState || cookieState !== q.data.state) {
        await store.eventInsert('auth.state_mismatch', null, { provider: providerName });
        throw forbidden('state_mismatch', 'OAuth state mismatch');
      }
      const payload = unsignValue(env.SESSION_SECRET, cookieState);
      if (!payload) throw forbidden('state_expired', 'OAuth state expired or invalid');
      const [stateProvider, stateRedirect] = payload.split('|');
      if (stateProvider !== providerName) throw forbidden('state_mismatch', 'OAuth state provider mismatch');
      reply.clearCookie(STATE_COOKIE, { path: '/' });

      let profile;
      try {
        profile = await provider.exchangeCode({ code: q.data.code, redirectUri: redirectUriFor(providerName, request) });
      } catch (err) {
        if (err instanceof OAuthError) {
          await store.eventInsert('auth.failed', null, { provider: providerName, code: err.code });
          if (err.code === 'upstream_unavailable') throw err;
          throw badRequest(err.code, 'Sign-in failed');
        }
        throw err;
      }

      const user = await findOrCreateUser(profile.provider, profile.providerUserId, {
        email: profile.email,
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        emailVerified: profile.emailVerified,
      });

      const session = await sessions.issue(user, {
        userAgent: request.headers['user-agent'] ?? null,
        ip: request.ip,
      });
      reply.setCookie(env.COOKIE_NAME, session.token, sessions.cookieOptions(session.expiresAt));
      await store.eventInsert('auth.success', user.id, { provider: profile.provider });

      const target = safeRedirect(stateRedirect, env);
      return reply.redirect(target);
    },
  );

  app.post('/api/v1/auth/logout', { preHandler: [authenticate] }, async (request, reply) => {
    if (request.currentSessionId) await sessions.revoke(request.currentSessionId);
    reply.clearCookie(env.COOKIE_NAME, { path: '/' });
    await store.eventInsert('auth.logout', request.currentUser!.id, null);
    return { ok: true };
  });

  /**
   * DEV-вход (только если DEV_LOGIN_ENABLED и не production).
   * Создаёт аккаунт, но НИКОГДА не выдаёт подписку.
   */
  app.post<{ Body: unknown }>('/api/v1/auth/dev-login', async (request, reply) => {
    if (!env.DEV_LOGIN_ENABLED || env.NODE_ENV === 'production') {
      throw forbidden('dev_login_disabled', 'Dev login is disabled');
    }
    const body = z.object({ email: z.string().email().max(254), name: z.string().max(120).optional() }).safeParse(request.body ?? {});
    if (!body.success) throw badRequest('invalid_body', 'email is required');

    const provider = authProviders.dev;
    if (!provider) throw notFound('provider_not_found', 'Dev provider is not configured');
    const profile = await provider.exchangeCode({ code: body.data.email, redirectUri: baseUrl(env) });

    const user = await findOrCreateUser(profile.provider, profile.providerUserId, {
      email: profile.email,
      name: body.data.name ?? profile.name,
      avatarUrl: null,
      emailVerified: false,
    });
    const session = await sessions.issue(user, { userAgent: request.headers['user-agent'] ?? null, ip: request.ip });
    reply.setCookie(env.COOKIE_NAME, session.token, sessions.cookieOptions(session.expiresAt));
    await store.eventInsert('auth.dev_login', user.id, null);
    return { ok: true, user: publicUser(user) };
  });

  // ---------------------------------------------------------------------

  function redirectUriFor(providerName: string, request: FastifyRequest): string {
    const configured =
      providerName === 'google' ? env.GOOGLE_REDIRECT_URI : providerName === 'yandex' ? env.YANDEX_REDIRECT_URI : undefined;
    if (configured) return configured;
    return `${baseUrl(env)}/api/v1/auth/${providerName}/callback`;
  }

  async function findOrCreateUser(
    provider: OAuthProviderName,
    providerUserId: string,
    data: { email: string | null; name: string | null; avatarUrl: string | null; emailVerified: boolean },
  ) {
    const existingIdentity = await store.identityFind(provider, providerUserId);
    if (existingIdentity) {
      const user = await store.userById(existingIdentity.userId);
      if (user && !user.deletedAt) {
        await store.identityUpsert({ userId: user.id, provider, providerUserId, email: data.email });
        if (data.name || data.avatarUrl) {
          await store.userUpdateProfile(user.id, {
            name: data.name ?? undefined,
            avatarUrl: data.avatarUrl ?? undefined,
          });
        }
        const fresh = await store.userById(user.id);
        return promoteIfBootstrapAdmin(fresh ?? user);
      }
    }

    // Тот же email у другого провайдера — связываем с существующим аккаунтом,
    // только если email подтверждён провайдером.
    if (data.email && data.emailVerified) {
      const byEmail = await store.userByEmail(data.email);
      if (byEmail && !byEmail.deletedAt) {
        await store.identityUpsert({ userId: byEmail.id, provider, providerUserId, email: data.email });
        return promoteIfBootstrapAdmin(byEmail);
      }
    }

    const created = await store.userCreate({
      email: data.emailVerified ? data.email : data.email,
      name: data.name,
      avatarUrl: data.avatarUrl,
      role: isBootstrapAdmin(data.email) ? 'admin' : 'user',
    });
    await store.identityUpsert({ userId: created.id, provider, providerUserId, email: data.email });
    // Новому пользователю — подписки нет. Доступ выдаётся только оплатой или grant'ом.
    await store.subscriptionUpsert(created.id, { status: 'none' });
    return created;
  }

  function isBootstrapAdmin(email: string | null): boolean {
    if (!email) return false;
    return env.ADMIN_BOOTSTRAP_EMAILS.map((e) => e.toLowerCase()).includes(email.toLowerCase());
  }

  async function promoteIfBootstrapAdmin(user: UserRow): Promise<UserRow> {
    if (user.role !== 'admin' && isBootstrapAdmin(user.email)) {
      const updated = await store.userSetRole(user.id, 'admin');
      if (updated) return updated;
    }
    return user;
  }
}

export function publicUser(user: {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role: string;
  createdAt: string;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    createdAt: user.createdAt,
  };
}
