import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env as loadEnvOrDie, ConfigError } from './config.js';
import { createPgStore, PgStore } from './db/pg.js';
import { createMemoryStore } from './db/memory.js';
import type { Store } from './db/types.js';
import { SessionService } from './services/sessions.js';
import { SubscriptionService } from './services/subscriptions.js';
import { UpdatesService } from './services/updates.js';
import { AdminAuthService } from './services/admins.js';
import { buildProviders } from './providers/index.js';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  let env;
  try {
    env = loadEnvOrDie();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  let store: Store;
  if (env.STORE_DRIVER === 'pg') {
    store = await createPgStore({
      connectionString: env.DATABASE_URL as string,
      max: env.PG_POOL_MAX,
      ssl: env.PG_SSL,
    });
    // Миграции при старте: `docker compose up` с нуля поднимает схему сам.
    if (process.env.RUN_MIGRATIONS_ON_BOOT !== 'false') {
      await runMigrations({
        connectionString: env.DATABASE_URL as string,
        dir: path.resolve(__dirname, '..', 'migrations'),
        ssl: env.PG_SSL,
        log: (msg: string) => console.log(msg),
      });
    }
  } else {
    // Только локальная разработка/демо: данные живут до перезапуска процесса.
    console.warn('[boot] STORE_DRIVER=memory — данные не сохраняются. Не использовать в production.');
    store = createMemoryStore();
  }

  const providers = buildProviders(env);
  const sessions = new SessionService(store, env);
  const subscriptions = new SubscriptionService(store);
  const updates = new UpdatesService(store, env);
  const adminAuth = new AdminAuthService(store, env);

  const app = await buildApp({
    deps: {
      env,
      store,
      sessions,
      subscriptions,
      updates,
      adminAuth,
      authProviders: providers.authProviders,
      payments: providers.payments,
      publicDir: path.resolve(env.PUBLIC_DIR.startsWith('/') ? env.PUBLIC_DIR : path.resolve(process.cwd(), env.PUBLIC_DIR)),
    },
    logger: { level: env.LOG_LEVEL },
  });

  // Просроченные заказы закрываем фоново (не блокируя старт).
  const expireTimer = setInterval(async () => {
    try {
      const n = await store.ordersExpire(new Date());
      if (n > 0) app.log.info({ expired: n }, 'expired stale orders');
    } catch (err) {
      app.log.error({ err }, 'order expiry job failed');
    }
  }, 60_000);
  expireTimer.unref?.();

  // Первичное наполнение кэша релизов — тоже фоново.
  if (env.UPDATES_ENABLED) {
    void updates
      .refreshFromGitHub()
      .then((r) => app.log.info({ fetched: r.fetched }, 'update channel warmed up'))
      .catch((err) => app.log.warn({ err }, 'update channel warm-up failed'));
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    clearInterval(expireTimer);
    try {
      await app.close();
      await (store as PgStore).close?.();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`SHELTER server listening on ${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();
