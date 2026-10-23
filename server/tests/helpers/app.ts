import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { loadEnv, type Env } from '../../src/config.js';
import { createMemoryStore } from '../../src/db/memory.js';
import type { Store } from '../../src/db/types.js';
import { SessionService } from '../../src/services/sessions.js';
import { SubscriptionService } from '../../src/services/subscriptions.js';
import { UpdatesService } from '../../src/services/updates.js';
import { buildProviders } from '../../src/providers/index.js';
import { buildApp } from '../../src/app.js';
import type { AuthProvider } from '../../src/providers/auth/types.js';
import type { PaymentProvider } from '../../src/providers/payments/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');

export const TEST_SECRETS = {
  SESSION_SECRET: 'test-session-secret-0123456789abcdef-xyz',
  PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-0123456789abcdef',
};

export interface TestEnvOverrides {
  [key: string]: string | boolean | number | undefined;
}

/**
 * Конфигурация для тестов: NODE_ENV=test, mock-платежи, фейковые OAuth,
 * HTTPS-enforcement выключен (тестируем логику, а не TLS-терминатор).
 */
export function testEnv(overrides: TestEnvOverrides = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    HOST: '127.0.0.1',
    PORT: '0',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    SESSION_SECRET: TEST_SECRETS.SESSION_SECRET,
    PAYMENT_WEBHOOK_SECRET: TEST_SECRETS.PAYMENT_WEBHOOK_SECRET,
    PAYMENT_PROVIDER: 'mock',
    COOKIE_SECURE: 'false',
    REQUIRE_HTTPS: 'false',
    TRUST_PROXY: 'false',
    DEV_LOGIN_ENABLED: 'true',
    GOOGLE_ENABLED: 'true',
    GOOGLE_CLIENT_ID: 'test-google-client',
    GOOGLE_CLIENT_SECRET: 'test-google-secret',
    YANDEX_ENABLED: 'true',
    YANDEX_CLIENT_ID: 'test-yandex-client',
    YANDEX_CLIENT_SECRET: 'test-yandex-secret',
    ADMIN_BOOTSTRAP_EMAILS: 'admin@shelter.test',
    UPDATES_ENABLED: 'true',
    UPDATES_CACHE_TTL_SECONDS: '0',
    GITHUB_REPO: 'Everick-Ven/shelter',
    PUBLIC_DIR: PUBLIC_DIR,
    RATE_LIMIT_MAX: '100000',
    RATE_LIMIT_CHECKOUT_MAX: '100000',
    ...overrides,
  } as unknown as NodeJS.ProcessEnv);
}

export interface TestApp {
  app: FastifyInstance;
  env: Env;
  store: Store;
  sessions: SessionService;
  subscriptions: SubscriptionService;
  updates: UpdatesService;
  authProviders: Record<string, AuthProvider>;
  payments: PaymentProvider;
  close: () => Promise<void>;
}

export async function createTestApp(
  overrides: TestEnvOverrides = {},
  providerOverrides: {
    authProviders?: Record<string, AuthProvider>;
    payments?: PaymentProvider;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<TestApp> {
  const env = testEnv(overrides);
  const store = createMemoryStore();
  const providers = buildProviders(env, providerOverrides);
  const sessions = new SessionService(store, env);
  const subscriptions = new SubscriptionService(store);
  const updates = new UpdatesService(store, env, providerOverrides.fetchImpl);

  const app = await buildApp({
    deps: {
      env,
      store,
      sessions,
      subscriptions,
      updates,
      authProviders: providers.authProviders,
      payments: providers.payments,
      publicDir: PUBLIC_DIR,
    },
    logger: false,
  });
  await app.ready();

  return {
    app,
    env,
    store,
    sessions,
    subscriptions,
    updates,
    authProviders: providers.authProviders,
    payments: providers.payments,
    close: async () => {
      await app.close();
    },
  };
}

/** Авторизация через dev-вход; возвращает cookie-строку для inject(). */
export async function loginAs(
  t: TestApp,
  email: string,
  opts: { name?: string } = {},
): Promise<{ cookie: string; userId: string }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    payload: { email, name: opts.name },
  });
  if (res.statusCode !== 200) {
    throw new Error(`dev-login failed (${res.statusCode}): ${res.body}`);
  }
  const cookie = res.cookies.find((c) => c.name === t.env.COOKIE_NAME);
  if (!cookie) throw new Error('session cookie was not set');
  const body = res.json() as { user: { id: string } };
  return { cookie: `${cookie.name}=${cookie.value}`, userId: body.user.id };
}

/** Полный OAuth-поток через фейкового провайдера (start -> callback). */
export async function oauthLogin(
  t: TestApp,
  provider: 'google' | 'yandex',
  profile: { providerUserId: string; email?: string | null; name?: string | null; emailVerified?: boolean },
  opts: { redirect?: string } = {},
): Promise<{ cookie: string; statusCode: number; location?: string }> {
  const startUrl = `/api/v1/auth/${provider}/start${opts.redirect ? `?redirect=${encodeURIComponent(opts.redirect)}` : ''}`;
  const start = await t.app.inject({ method: 'GET', url: startUrl });
  if (start.statusCode !== 302) throw new Error(`oauth start failed: ${start.statusCode}`);
  const stateCookie = start.cookies.find((c) => c.name === 'shelter_oauth_state');
  if (!stateCookie) throw new Error('state cookie was not set');
  const state = stateCookie.value;

  const code = Buffer.from(
    JSON.stringify({
      provider,
      providerUserId: profile.providerUserId,
      email: profile.email ?? null,
      emailVerified: profile.emailVerified ?? true,
      name: profile.name ?? null,
      avatarUrl: null,
    }),
    'utf8',
  ).toString('base64url');

  const callback = await t.app.inject({
    method: 'GET',
    url: `/api/v1/auth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    headers: { cookie: `shelter_oauth_state=${state}` },
  });

  const sessionCookie = callback.cookies.find((c) => c.name === t.env.COOKIE_NAME);
  return {
    cookie: sessionCookie ? `${sessionCookie.name}=${sessionCookie.value}` : '',
    statusCode: callback.statusCode,
    location: callback.headers.location as string | undefined,
  };
}
