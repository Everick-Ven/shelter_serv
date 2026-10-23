import { z } from 'zod';
import 'dotenv/config';

/**
 * Все секреты — только из окружения. Никаких значений по умолчанию для секретов:
 * если обязательный секрет не задан, приложение НЕ стартует (fail-fast),
 * а не начинает работать в небезопасном режиме.
 */

const bool = (defaultValue: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return defaultValue;
      if (typeof v === 'boolean') return v;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const int = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

/** Целое неотрицательное: 0 допустим (например, PORT=0 или отключённый кэш). */
const uint = (defaultValue: number) =>
  z.coerce.number().int().min(0).default(defaultValue);

const csv = (defaultValue: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : defaultValue,
    );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  HOST: z.string().default('0.0.0.0'),
  PORT: uint(8080),
  /** Публичный базовый URL (https://shelter.example.com). Обязателен в production. */
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Разрешённые Origin для CORS/cookie. В production — только https-хосты. */
  ALLOWED_ORIGINS: csv([]),
  /**
   * TLS терминируется обратным прокси (nginx/caddy/ALB).
   * trustProxy включаем только если прокси доверенный и корректно выставляет
   * X-Forwarded-Proto/For. Rate-limit и https-enforcement опираются на это.
   */
  TRUST_PROXY: bool(false),
  /** Принудительный редирект http -> https (за исключением healthz). */
  REQUIRE_HTTPS: bool(true),
  HSTS_MAX_AGE: int(31536000),

  /**
   * Драйвер хранилища: `pg` (боевой) или `memory` (локальное демо/разработка
   * без PostgreSQL). В production `memory` запрещён.
   */
  STORE_DRIVER: z.enum(['pg', 'memory']).default('pg'),
  DATABASE_URL: z.string().optional(),
  PG_POOL_MAX: int(10),
  PG_SSL: bool(false),

  /** Секрет подписи/шифрования сессий. Минимум 32 байта. */
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),
  COOKIE_NAME: z.string().default('shelter_session'),
  COOKIE_SECURE: bool(true),
  COOKIE_DOMAIN: z.string().optional(),
  SESSION_TTL_SECONDS: int(60 * 60 * 24 * 30),
  /** Скользящее продление сессии, сек. */
  SESSION_RENEW_AFTER_SECONDS: int(60 * 60 * 24 * 7),

  // ---- OAuth: Google ----
  GOOGLE_ENABLED: bool(false),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),

  // ---- OAuth: Yandex ----
  YANDEX_ENABLED: bool(false),
  YANDEX_CLIENT_ID: z.string().optional(),
  YANDEX_CLIENT_SECRET: z.string().optional(),
  YANDEX_REDIRECT_URI: z.string().optional(),

  // ---- Dev-логин (ТОЛЬКО для локальной разработки/тестов) ----
  /**
   * Отключён по умолчанию и принудительно выключается в production.
   * Не является способом получения платного доступа: даёт только аккаунт,
   * entitlement всегда проверяется отдельно и fail-closed.
   */
  DEV_LOGIN_ENABLED: bool(false),

  // ---- Платежи ----
  PAYMENT_PROVIDER: z.enum(['yookassa', 'mock']).default('mock'),
  /** shopId + секретный ключ YooKassa (секрет — только из env) */
  YOOKASSA_SHOP_ID: z.string().optional(),
  YOOKASSA_SECRET_KEY: z.string().optional(),
  /**
   * Подпись уведомлений: HMAC-ключ, выданный платёжным провайдером.
   * Без него webhook отклоняется (401) — платёж не засчитывается.
   */
  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  PAYMENT_SUCCESS_URL: z.string().optional(),
  PAYMENT_CANCEL_URL: z.string().optional(),
  /** false = двухстадийная оплата (платёж подтверждается отдельным событием). */
  YOOKASSA_CAPTURE: bool(true),
  /** Защита от повторной доставки одного и того же уведомления. */
  PAYMENT_IDEMPOTENCY_TTL_SECONDS: int(60 * 60 * 24 * 7),
  /** Сколько секунд заказ ждёт оплаты, прежде чем стать expired. */
  ORDER_TTL_SECONDS: int(60 * 30),

  // ---- Update channel (GitHub Releases, P1) ----
  UPDATES_ENABLED: bool(true),
  GITHUB_REPO: z.string().default('Everick-Ven/shelter'),
  /** Необязательный токен — только для повышения лимитов API. В код не пишем. */
  GITHUB_TOKEN: z.string().optional(),
  UPDATES_CHANNEL: z.enum(['stable', 'beta']).default('stable'),
  UPDATES_CACHE_TTL_SECONDS: uint(300),
  UPDATES_MIN_CLIENT_VERSION: z.string().optional(),

  // ---- Rate limit ----
  RATE_LIMIT_MAX: int(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  RATE_LIMIT_AUTH_MAX: int(10),
  RATE_LIMIT_AUTH_WINDOW: z.string().default('10 minutes'),
  RATE_LIMIT_CHECKOUT_MAX: int(20),
  RATE_LIMIT_CHECKOUT_WINDOW: z.string().default('10 minutes'),
  RATE_LIMIT_ADMIN_MAX: int(600),
  RATE_LIMIT_ADMIN_WINDOW: z.string().default('1 minute'),

  // ---- Вход администратора: логин + пароль ----
  /**
   * Парольный вход в панель `/manage` — основной способ для оператора.
   * OAuth остаётся для аккаунтов приложения, а не для админки.
   *
   * В development без явного ADMIN_PASSWORD создаётся ДЕМО-доступ
   * (admin@shelter.local / shelter-demo-admin), чтобы панель можно было
   * проверить сразу после `docker compose up`. В production демо-пароль
   * запрещён: ADMIN_PASSWORD обязателен, не короче 12 символов.
   */
  ADMIN_EMAIL: z
    .union([z.literal(''), z.string().email()])
    .optional()
    .transform((v) => (v ? v.toLowerCase() : 'admin@shelter.local')),
  /**
   * Короткий логин администратора (без @): наряду с email принимается
   * в /manage/api/login. По умолчанию `admin`.
   */
  ADMIN_LOGIN: z
    .union([z.literal(''), z.string().min(2).max(64)])
    .optional()
    .transform((v) => (v ? v.toLowerCase() : 'admin')),
  /** Пустая строка из env/compose трактуется как «не задан». */
  ADMIN_PASSWORD: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v : undefined))
    .pipe(z.string().min(8, 'ADMIN_PASSWORD must be at least 8 chars').optional()),

  // ---- Прочее ----
  ADMIN_BOOTSTRAP_EMAILS: csv([]),
  SUPPORT_EMAIL: z.string().default('support@shelter.local'),
  /** Каталог со статикой (сайт + /manage). */
  PUBLIC_DIR: z.string().default('public'),
});

export type Env = z.infer<typeof envSchema>;

export class ConfigError extends Error {}

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;

  // Production-инварианты: нарушать нельзя даже «временно».
  if (env.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (env.STORE_DRIVER !== 'pg') problems.push('STORE_DRIVER=memory is not allowed in production');
    if (!env.DATABASE_URL) problems.push('DATABASE_URL is required');
    if (!env.PUBLIC_BASE_URL) problems.push('PUBLIC_BASE_URL is required in production');
    else if (!env.PUBLIC_BASE_URL.startsWith('https://'))
      problems.push('PUBLIC_BASE_URL must be https:// in production');
    if (!env.COOKIE_SECURE) problems.push('COOKIE_SECURE must be true in production');
    if (env.DEV_LOGIN_ENABLED) problems.push('DEV_LOGIN_ENABLED must be false in production');
    if (!env.ADMIN_PASSWORD) problems.push('ADMIN_PASSWORD is required in production (no demo password)');
    else if (env.ADMIN_PASSWORD === '1234567890')
      problems.push('ADMIN_PASSWORD must not be the demo password in production');
    else if (env.ADMIN_PASSWORD.length < 12)
      problems.push('ADMIN_PASSWORD must be at least 12 chars in production');
    if (env.PAYMENT_PROVIDER === 'mock')
      problems.push('PAYMENT_PROVIDER=mock is not allowed in production');
    if (env.GOOGLE_ENABLED && (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET))
      problems.push('GOOGLE_ENABLED requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
    if (env.YANDEX_ENABLED && (!env.YANDEX_CLIENT_ID || !env.YANDEX_CLIENT_SECRET))
      problems.push('YANDEX_ENABLED requires YANDEX_CLIENT_ID and YANDEX_CLIENT_SECRET');
    if (problems.length) throw new ConfigError(`Production config violations:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  if (env.STORE_DRIVER === 'pg' && !env.DATABASE_URL) {
    throw new ConfigError('DATABASE_URL is required when STORE_DRIVER=pg');
  }

  return env;
}

export function env(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

/** Базовый URL без завершающего слэша. */
export function baseUrl(e: Env = env()): string {
  return (e.PUBLIC_BASE_URL ?? `http://${e.HOST === '0.0.0.0' ? 'localhost' : e.HOST}:${e.PORT}`).replace(/\/+$/, '');
}
