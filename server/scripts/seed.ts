#!/usr/bin/env tsx
/**
 * Заполнение БД демонстрационными данными (только для локальной разработки).
 *
 *   DATABASE_URL=postgres://... npm run seed
 *
 * В production скрипт отказывается работать, чтобы случайно не залить
 * демо-данные в боевую базу.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { loadEnv } from '../src/config.js';
import { createPgStore } from '../src/db/pg.js';
import { runMigrations } from '../src/db/migrate.js';
import { SubscriptionService } from '../src/services/subscriptions.js';
import { PLANS } from '../src/domain/plans.js';
import { addDays, nowUtc } from '../src/lib/time.js';
import { generateOpaqueId } from '../src/lib/tokens.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    console.error('[seed] refused to run with NODE_ENV=production');
    process.exit(1);
  }
  if (env.STORE_DRIVER !== 'pg' || !env.DATABASE_URL) {
    console.error('[seed] DATABASE_URL is required (STORE_DRIVER=pg)');
    process.exit(1);
  }

  await runMigrations({
    connectionString: env.DATABASE_URL,
    dir: path.resolve(__dirname, '..', 'migrations'),
    ssl: env.PG_SSL,
    log: (m) => console.log(m),
  });

  const store = await createPgStore({ connectionString: env.DATABASE_URL, max: 4, ssl: env.PG_SSL });
  const subscriptions = new SubscriptionService(store);
  const adminEmail = (env.ADMIN_BOOTSTRAP_EMAILS[0] ?? 'admin@shelter.local').toLowerCase();

  console.log(`[seed] admin user: ${adminEmail}`);
  const admin = await store.userCreate({ email: adminEmail, name: 'Admin', avatarUrl: null, role: 'admin' });
  await store.subscriptionUpsert(admin.id, { status: 'none' });

  // Демо-пользователи: без подписки, с активной подпиской, с истёкшей.
  const free = await store.userCreate({ email: 'free@shelter.local', name: 'Free User', avatarUrl: null });
  await store.subscriptionUpsert(free.id, { status: 'none' });

  const paid = await store.userCreate({ email: 'paid@shelter.local', name: 'Paid User', avatarUrl: null });
  const paidOrder = generateOpaqueId('ord');
  await store.orderCreate({
    id: paidOrder,
    userId: paid.id,
    planId: PLANS.yearly.id,
    amountMinor: PLANS.yearly.amountMinor,
    currency: PLANS.yearly.currency,
    days: PLANS.yearly.days,
    provider: env.PAYMENT_PROVIDER,
    idempotencyKey: `seed_${paidOrder}`,
    checkoutUrl: null,
    metadata: { seeded: true },
  });
  await subscriptions.applyPaidOrder(paidOrder, { amountMinor: PLANS.yearly.amountMinor, paidAt: nowUtc() });

  const expired = await store.userCreate({ email: 'expired@shelter.local', name: 'Expired User', avatarUrl: null });
  const expiredOrder = generateOpaqueId('ord');
  await store.orderCreate({
    id: expiredOrder,
    userId: expired.id,
    planId: PLANS.monthly.id,
    amountMinor: PLANS.monthly.amountMinor,
    currency: PLANS.monthly.currency,
    days: PLANS.monthly.days,
    provider: env.PAYMENT_PROVIDER,
    idempotencyKey: `seed_${expiredOrder}`,
  });
  await store.orderSetStatus(expiredOrder, 'paid', { paidAt: addDays(nowUtc(), -40) });
  await store.subscriptionUpsert(expired.id, {
    status: 'active',
    planId: PLANS.monthly.id,
    startedAt: addDays(nowUtc(), -40),
    expiresAt: addDays(nowUtc(), -10), // уже истекла => premium.status вернёт expired
    source: 'payment',
    lastOrderId: expiredOrder,
  });

  // Демо-релизы канала обновлений (локально GitHub может быть недоступен).
  const releases = [
    { tag: 'v1.0.0', channel: 'stable' as const, days: -60 },
    { tag: 'v1.1.0', channel: 'stable' as const, days: -30 },
    { tag: 'v1.2.0', channel: 'stable' as const, days: -3 },
    { tag: 'v1.3.0', channel: 'beta' as const, days: -1 },
  ];
  for (const r of releases) {
    const version = r.tag.replace(/^v/, '');
    await store.releaseUpsert({
      id: createHash('sha256').update(r.tag).digest('hex').slice(0, 24),
      tagName: r.tag,
      version,
      channel: r.channel,
      name: `SHELTER ${version}`,
      body: `Демо-релиз ${version} (seed).`,
      htmlUrl: `https://github.com/${env.GITHUB_REPO}/releases/tag/${r.tag}`,
      publishedAt: addDays(nowUtc(), r.days).toISOString(),
      isPrerelease: r.channel === 'beta',
      isDraft: false,
      assets: [
        {
          name: `shelter-${version}-setup.exe`,
          url: `https://github.com/${env.GITHUB_REPO}/releases/download/${r.tag}/shelter-${version}-setup.exe`,
          size: 104857600,
        },
      ],
    });
  }

  await store.eventInsert('seed.completed', admin.id, { users: 4, releases: releases.length });
  await store.close();

  console.log('[seed] done:');
  console.log(`  - admin      ${adminEmail}`);
  console.log('  - free       free@shelter.local (без подписки)');
  console.log('  - paid       paid@shelter.local (годовая подписка активна)');
  console.log('  - expired    expired@shelter.local (подписка истекла)');
  console.log(`  - releases   ${releases.map((r) => r.tag).join(', ')}`);
  console.log('\nВход в /manage: dev-login по email (DEV_LOGIN_ENABLED=true) или OAuth.');
}

main().catch((err) => {
  console.error('[seed] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
