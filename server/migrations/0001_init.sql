-- ============================================================================
-- SHELTER server — initial schema
-- Idempotent: безопасен для повторного запуска (IF NOT EXISTS).
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
    version     TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Пользователи
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT,
    name          TEXT,
    avatar_url    TEXT,
    role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    deleted_at    TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

-- Email уникален только пока аккаунт жив: после DELETE /me email зануляется,
-- поэтому уникальность частичная (по email IS NOT NULL AND deleted_at IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS users_email_active_uniq
    ON users (lower(email))
    WHERE deleted_at IS NULL AND email IS NOT NULL;

CREATE INDEX IF NOT EXISTS users_created_at_idx ON users (created_at DESC);

-- ---------------------------------------------------------------------------
-- OAuth-идентичности (Google / Yandex). Один пользователь — несколько провайдеров.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_identities (
    provider         TEXT NOT NULL CHECK (provider IN ('google', 'yandex')),
    provider_user_id TEXT NOT NULL,
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS user_identities_user_idx ON user_identities (user_id);

-- ---------------------------------------------------------------------------
-- Сессии: в БД хранится ТОЛЬКО sha256-хэш токена.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    user_agent  TEXT,
    ip_hash     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Подписки. Источник правды о премиуме — эта таблица + orders.
-- paid_order_count / first_payment_at здесь НЕ хранятся (TZ): они вычисляются
-- из orders через COUNT(*) / MIN(paid_at) WHERE status = 'paid'.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
    user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL DEFAULT 'none'
                 CHECK (status IN ('active', 'expired', 'cancelled', 'refunded', 'revoked', 'none')),
    plan_id      TEXT,
    started_at   TIMESTAMPTZ,
    expires_at   TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    source       TEXT CHECK (source IN ('payment', 'admin_grant')),
    last_order_id TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions (status);
CREATE INDEX IF NOT EXISTS subscriptions_expires_idx ON subscriptions (expires_at)
    WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- Заказы (checkout). Сумма и срок всегда из серверного каталога тарифов.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id                  TEXT PRIMARY KEY,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id             TEXT NOT NULL,
    amount_minor        BIGINT NOT NULL CHECK (amount_minor > 0),
    currency            TEXT NOT NULL DEFAULT 'RUB',
    days                INT NOT NULL CHECK (days > 0),
    status              TEXT NOT NULL DEFAULT 'created'
                        CHECK (status IN ('created', 'pending', 'paid', 'failed', 'expired', 'refunded')),
    provider            TEXT NOT NULL,
    provider_payment_id TEXT,
    idempotency_key     TEXT UNIQUE,
    checkout_url        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ,
    paid_at             TIMESTAMPTZ,
    refunded_at         TIMESTAMPTZ,
    metadata            JSONB
);

CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_paid_user_idx ON orders (user_id) WHERE status = 'paid';
CREATE INDEX IF NOT EXISTS orders_provider_payment_idx ON orders (provider_payment_id)
    WHERE provider_payment_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Платёжные уведомления: журнал + идемпотентность обработчика webhook'ов.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_events (
    id         TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    event_id   TEXT NOT NULL,
    order_id   TEXT REFERENCES orders(id) ON DELETE SET NULL,
    type       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('processed', 'ignored', 'failed')),
    payload    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, event_id)
);

CREATE INDEX IF NOT EXISTS payment_events_created_idx ON payment_events (created_at DESC);

-- ---------------------------------------------------------------------------
-- Релизы браузера (канал обновлений, P1). Кэш GitHub Releases.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS releases (
    id            TEXT PRIMARY KEY,
    tag_name      TEXT NOT NULL UNIQUE,
    version       TEXT NOT NULL,
    channel       TEXT NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta')),
    name          TEXT,
    body          TEXT,
    html_url      TEXT,
    published_at  TIMESTAMPTZ,
    is_prerelease BOOLEAN NOT NULL DEFAULT false,
    is_draft      BOOLEAN NOT NULL DEFAULT false,
    assets        JSONB NOT NULL DEFAULT '[]'::jsonb,
    fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS releases_channel_idx ON releases (channel, published_at DESC);

-- ---------------------------------------------------------------------------
-- Серверные настройки (канал обновлений, минимальная версия и т.п.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- События (аналитика/аудит, в т.ч. попытки доступа без подписки)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id         BIGSERIAL PRIMARY KEY,
    type       TEXT NOT NULL,
    user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    payload    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_type_created_idx ON events (type, created_at DESC);
CREATE INDEX IF NOT EXISTS events_created_idx ON events (created_at DESC);
