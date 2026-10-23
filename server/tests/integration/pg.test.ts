/**
 * Интеграционные тесты с настоящей PostgreSQL.
 *
 * Запускаются только если задан DATABASE_URL (в docker compose / CI):
 *   DATABASE_URL=postgres://shelter:shelter@localhost:5432/shelter npm run test:integration
 *
 * Без DATABASE_URL файл пропускается целиком — unit-тесты от этого не зависят.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';
import { createPgStore, type PgStore } from '../../src/db/pg.js';
import { buildApp } from '../../src/app.js';
import { SessionService } from '../../src/services/sessions.js';
import { SubscriptionService } from '../../src/services/subscriptions.js';
import { UpdatesService } from '../../src/services/updates.js';
import { buildProviders } from '../../src/providers/index.js';
import { PLANS } from '../../src/domain/plans.js';
import { generateOpaqueId, hmacSha256Hex } from '../../src/lib/tokens.js';
import { addDays, nowUtc } from '../../src/lib/time.js';
import { PUBLIC_DIR, testEnv, TEST_SECRETS } from '../helpers/app.js';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../../src/config.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const describeOrSkip = DATABASE_URL ? describe : describe.skip;

describeOrSkip('PostgreSQL integration', () => {
  let store: PgStore;
  let adminClient: pg.Client;
  const runId = createHash('sha256').update(String(Date.now()) + Math.random()).digest('hex').slice(0, 8);

  beforeAll(async () => {
    const applied = await runMigrations({
      connectionString: DATABASE_URL,
      dir: new URL('../../migrations', import.meta.url).pathname,
      log: () => {},
    });
    expect(Array.isArray(applied.applied)).toBe(true);

    store = await createPgStore({ connectionString: DATABASE_URL, max: 5 });
    adminClient = new pg.Client({ connectionString: DATABASE_URL });
    await adminClient.connect();
  }, 60_000);

  afterAll(async () => {
    try {
      await store?.close();
      await adminClient?.end();
    } catch {
      /* ignore */
    }
  });

  it('миграции идемпотентны: повторный пропуск ничего не применяет', async () => {
    const again = await runMigrations({
      connectionString: DATABASE_URL,
      dir: new URL('../../migrations', import.meta.url).pathname,
      log: () => {},
    });
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBeGreaterThan(0);
  });

  it('схема на месте: таблицы и ограничения созданы', async () => {
    const { rows } = await adminClient.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const names = rows.map((r: { table_name: string }) => r.table_name);
    for (const expected of [
      'users',
      'user_identities',
      'sessions',
      'subscriptions',
      'orders',
      'payment_events',
      'releases',
      'app_settings',
      'events',
      'schema_migrations',
    ]) {
      expect(names).toContain(expected);
    }

    // В subscriptions нет колонок paid_order_count / first_payment_at (TZ).
    const cols = await adminClient.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'subscriptions'`,
    );
    const colNames = cols.rows.map((r: { column_name: string }) => r.column_name);
    expect(colNames).not.toContain('paid_order_count');
    expect(colNames).not.toContain('first_payment_at');
  });

  it('пользователь, сессия и хэш токена: в БД нет открытого токена', async () => {
    const user = await store.userCreate({ email: `it-${runId}@shelter.test`, name: 'IT', avatarUrl: null });
    const token = generateOpaqueId('tok');
    const session = await store.sessionCreate({
      userId: user.id,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: addDays(nowUtc(), 1),
    });
    const found = await store.sessionByTokenHash(createHash('sha256').update(token).digest('hex'));
    expect(found?.id).toBe(session.id);
    const { rows } = await adminClient.query(`SELECT token_hash FROM sessions WHERE id = $1`, [session.id]);
    expect(rows[0].token_hash).not.toContain(token.slice(5));
  });

  it('paid_order_count / first_payment_at считаются из orders (COUNT/MIN)', async () => {
    const user = await store.userCreate({ email: `stats-${runId}@shelter.test`, name: null, avatarUrl: null });
    const mk = async (status: 'paid' | 'created', amount: number, paidAt: Date | null) => {
      const id = generateOpaqueId('ord');
      await store.orderCreate({
        id,
        userId: user.id,
        planId: 'monthly',
        amountMinor: amount,
        currency: 'RUB',
        days: 30,
        provider: 'yookassa',
      });
      if (status === 'paid') await store.orderSetStatus(id, 'paid', { paidAt: paidAt ?? nowUtc() });
      return id;
    };
    await mk('paid', 29900, new Date('2026-01-05T10:00:00Z'));
    await mk('paid', 29900, new Date('2026-02-05T10:00:00Z'));
    await mk('created', 29900, null);

    const stats = await store.orderPaidStatsForUser(user.id);
    expect(stats.count).toBe(2);
    expect(stats.lifetimeMinor).toBe(59800);
    expect(stats.firstPaymentAt).toBe('2026-01-05T10:00:00.000Z');

    const view = await store.adminUserView(user.id);
    expect(view?.paidOrderCount).toBe(2);
    expect(view?.firstPaymentAt).toBe('2026-01-05T10:00:00.000Z');
  });

  it('уникальность payment_events (provider, event_id) обеспечивает идемпотентность webhook', async () => {
    const first = await store.paymentEventInsert({
      id: generateOpaqueId('pev'),
      provider: 'mock',
      eventId: `evt_${runId}`,
      type: 'paid',
      status: 'processed',
    });
    const second = await store.paymentEventInsert({
      id: generateOpaqueId('pev'),
      provider: 'mock',
      eventId: `evt_${runId}`,
      type: 'paid',
      status: 'processed',
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it('CHECK-ограничения БД не пускают произвольные статусы и суммы', async () => {
    const user = await store.userCreate({ email: `chk-${runId}@shelter.test`, name: null, avatarUrl: null });
    await expect(
      adminClient.query(
        `INSERT INTO orders (id, user_id, plan_id, amount_minor, currency, days, status, provider)
         VALUES ($1,$2,'monthly',29900,'RUB',30,'hacked','mock')`,
        [generateOpaqueId('ord'), user.id],
      ),
    ).rejects.toThrow();
    await expect(
      adminClient.query(
        `INSERT INTO orders (id, user_id, plan_id, amount_minor, currency, days, status, provider)
         VALUES ($1,$2,'monthly',0,'RUB',30,'created','mock')`,
        [generateOpaqueId('ord'), user.id],
      ),
    ).rejects.toThrow();
  });

  it('анонимизация пользователя (DELETE /me) чистит персональные данные в БД', async () => {
    const user = await store.userCreate({ email: `del-${runId}@shelter.test`, name: 'Del', avatarUrl: 'https://x/y.png' });
    await store.identityUpsert({ userId: user.id, provider: 'google', providerUserId: `g_${runId}`, email: user.email });
    await store.sessionCreate({
      userId: user.id,
      tokenHash: createHash('sha256').update(`t_${runId}`).digest('hex'),
      expiresAt: addDays(nowUtc(), 1),
    });
    await store.eventInsert('test.event', user.id, { a: 1 });

    await store.userAnonymize(user.id);

    const after = await store.userById(user.id);
    expect(after?.email).toBeNull();
    expect(after?.name).toBeNull();
    expect(after?.avatarUrl).toBeNull();
    expect(after?.deletedAt).not.toBeNull();
    expect(await store.identitiesByUser(user.id)).toEqual([]);
    const sessions = await store.sessionsListForUser(user.id);
    expect(sessions.every((s) => s.revokedAt)).toBe(true);
  });

  describe('HTTP-слой поверх PostgreSQL', () => {
    let app: FastifyInstance;
    let env: Env;

    beforeAll(async () => {
      env = testEnv({ DATABASE_URL, STORE_DRIVER: 'pg' });
      const providers = buildProviders(env);
      app = await buildApp({
        deps: {
          env,
          store,
          sessions: new SessionService(store, env),
          subscriptions: new SubscriptionService(store),
          updates: new UpdatesService(store, env),
          authProviders: providers.authProviders,
          payments: providers.payments,
          publicDir: PUBLIC_DIR,
        },
        logger: false,
      });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
    });

    it('полный путь: вход -> checkout -> webhook -> premium.status -> DELETE /me', async () => {
      const email = `e2e-${runId}@shelter.test`;
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', payload: { email } });
      expect(login.statusCode).toBe(200);
      const cookieRes = login.cookies.find((c) => c.name === env.COOKIE_NAME);
      expect(cookieRes).toBeTruthy();
      const cookie = `${cookieRes!.name}=${cookieRes!.value}`;
      const userId = (login.json() as { user: { id: string } }).user.id;

      // до оплаты — доступ не подтверждён
      const before = await app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
      expect(before.json().active).toBe(false);

      // checkout: сумма из серверного каталога
      const checkout = await app.inject({
        method: 'POST',
        url: '/api/v1/checkout',
        headers: { cookie },
        payload: { planId: 'monthly' },
      });
      expect(checkout.statusCode).toBe(201);
      const order = checkout.json();
      expect(order.amountMinor).toBe(PLANS.monthly.amountMinor);

      // webhook без подписи — отказ, доступ не выдаётся
      const body = JSON.stringify({ id: `evt_${runId}`, type: 'payment.succeeded', orderId: order.orderId });
      const unsigned = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/payment',
        headers: { 'content-type': 'application/json' },
        payload: body,
      });
      expect(unsigned.statusCode).toBe(401);
      const stillDenied = await app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
      expect(stillDenied.json().active).toBe(false);

      // webhook с корректной подписью — оплата засчитана
      const signed = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/payment',
        headers: {
          'content-type': 'application/json',
          'x-shelter-signature': hmacSha256Hex(TEST_SECRETS.PAYMENT_WEBHOOK_SECRET, body),
        },
        payload: body,
      });
      expect(signed.statusCode).toBe(200);
      expect(signed.json().applied).toBe(true);

      const after = await app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
      expect(after.json()).toMatchObject({ active: true, status: 'active', planId: 'monthly', reason: 'paid' });

      // повторная доставка того же события не продлевает срок
      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/v1/webhooks/payment',
        headers: {
          'content-type': 'application/json',
          'x-shelter-signature': hmacSha256Hex(TEST_SECRETS.PAYMENT_WEBHOOK_SECRET, body),
        },
        payload: body,
      });
      expect(duplicate.statusCode).toBe(200);
      expect(duplicate.json().duplicate).toBe(true);

      // метрики админки видят оплату
      await store.userSetRole(userId, 'admin');
      const overview = await app.inject({ method: 'GET', url: '/manage/api/overview', headers: { cookie } });
      expect(overview.statusCode).toBe(200);
      expect(overview.json().metrics.paidOrderCount).toBeGreaterThanOrEqual(1);

      // удаление аккаунта: данные анонимизированы, сессия отозвана
      const del = await app.inject({ method: 'DELETE', url: '/api/v1/me', headers: { cookie }, payload: {} });
      expect(del.statusCode).toBe(200);
      const gone = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
      expect(gone.statusCode).toBe(401);

      const row = await store.userById(userId);
      expect(row?.email).toBeNull();
      expect(row?.deletedAt).not.toBeNull();
    }, 60_000);
  });
});
