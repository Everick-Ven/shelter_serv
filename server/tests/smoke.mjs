#!/usr/bin/env node
/**
 * Smoke-тесты поднятого сервера: проверяют «живой» HTTP-контур без тестовых
 * фреймворков. Запуск:
 *
 *   BASE_URL=http://localhost:8080 ADMIN_EMAIL=admin@shelter.local npm run smoke
 *
 * Код возврата 0 — все проверки пройдены, 1 — есть падения.
 */
import { createHmac } from 'node:crypto';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:8080').replace(/\/+$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@shelter.local';
const COOKIE_NAME = process.env.COOKIE_NAME || 'shelter_session';
const WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || 'dev-only-webhook-signing-key-change-me';
const DEV_LOGIN = String(process.env.DEV_LOGIN_ENABLED || 'true').toLowerCase() !== 'false';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, extra = '') {
  passed++;
  console.log(`  \u001b[32mPASS\u001b[0m ${name}${extra ? ` (${extra})` : ''}`);
}
function fail(name, reason) {
  failed++;
  failures.push(`${name}: ${reason}`);
  console.log(`  \u001b[31mFAIL\u001b[0m ${name} — ${reason}`);
}

async function check(name, fn) {
  try {
    const extra = await fn();
    ok(name, extra || '');
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err));
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function request(path, { method = 'GET', cookie, body, headers = {}, raw = false } = {}) {
  const init = { method, headers: { accept: 'application/json', ...headers }, redirect: 'manual' };
  if (cookie) init.headers.cookie = cookie;
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${BASE_URL}${path}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json, raw };
}

function cookieFrom(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const found = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return found || null;
}

console.log(`\n\u001b[1mSHELTER smoke tests\u001b[0m → ${BASE_URL}\n`);

// ---------------------------------------------------------------- инфраструктура
await check('GET /healthz отвечает 200', async () => {
  const res = await request('/healthz');
  assert(res.status === 200, `status ${res.status}`);
  assert(res.json?.status === 'ok', `body ${res.text.slice(0, 120)}`);
  return `version ${res.json?.version ?? '?'}`;
});

await check('GET /readyz: хранилище доступно', async () => {
  const res = await request('/readyz');
  assert(res.status === 200, `status ${res.status}, body ${res.text.slice(0, 200)}`);
  return `store=${res.json?.store}`;
});

// ---------------------------------------------------------------- витрина и панель
await check('GET / отдаёт витрину браузера', async () => {
  const res = await request('/', { headers: { accept: 'text/html' } });
  assert(res.status === 200, `status ${res.status}`);
  assert(res.text.includes('SHELTER'), 'в HTML нет SHELTER');
  assert(res.headers.get('content-type')?.includes('text/html'), 'content-type не html');
});

await check('GET /manage отдаёт панель управления', async () => {
  const res = await request('/manage', { headers: { accept: 'text/html' } });
  assert(res.status === 200, `status ${res.status}`);
  assert(res.text.includes('Панель управления') || res.text.includes('manage'), 'панель не найдена в HTML');
});

await check('CSP: script-src без unsafe-inline', async () => {
  const res = await request('/');
  const csp = res.headers.get('content-security-policy') || '';
  assert(csp.includes("script-src 'self'"), `csp: ${csp.slice(0, 120)}`);
  assert(!/script-src[^;]*unsafe-inline/.test(csp), 'в script-src есть unsafe-inline');
});

// ---------------------------------------------------------------- публичный API
await check('GET /api/v1/plans: 299 ₽/30 дней и 2390 ₽/365 дней', async () => {
  const res = await request('/api/v1/plans');
  assert(res.status === 200, `status ${res.status}`);
  const monthly = res.json?.plans?.find((p) => p.id === 'monthly');
  const yearly = res.json?.plans?.find((p) => p.id === 'yearly');
  assert(monthly?.amountMinor === 29900, `monthly=${monthly?.amountMinor}`);
  assert(monthly?.days === 30, `days=${monthly?.days}`);
  assert(yearly?.amountMinor === 239000, `yearly=${yearly?.amountMinor}`);
  assert(yearly?.days === 365, `days=${yearly?.days}`);
  assert(res.json?.currency === 'RUB', `currency=${res.json?.currency}`);
});

await check('GET /api/v1/me без сессии → 401 (fail-closed)', async () => {
  const res = await request('/api/v1/me');
  assert(res.status === 401, `status ${res.status}`);
});

await check('GET /manage/api/overview без сессии → 401', async () => {
  const res = await request('/manage/api/overview');
  assert(res.status === 401, `status ${res.status}`);
});

await check('POST /api/v1/webhooks/payment без подписи → 401', async () => {
  const res = await request('/api/v1/webhooks/payment', {
    method: 'POST',
    body: JSON.stringify({ id: 'evt_smoke_unsigned', type: 'payment.succeeded', orderId: 'ord_smoke' }),
  });
  assert(res.status === 401, `status ${res.status}`);
});

await check('POST /api/v1/webhooks/payment с чужой подписью → 401', async () => {
  const body = JSON.stringify({ id: 'evt_smoke_bad', type: 'payment.succeeded', orderId: 'ord_smoke' });
  const res = await request('/api/v1/webhooks/payment', {
    method: 'POST',
    body,
    headers: { 'x-shelter-signature': createHmac('sha256', 'wrong-secret').update(body).digest('hex') },
  });
  assert(res.status === 401, `status ${res.status}`);
});

await check('GET /api/v1/updates/check без версии → 400', async () => {
  const res = await request('/api/v1/updates/check');
  assert(res.status === 400, `status ${res.status}`);
});

await check('GET /api/v1/updates/check: autoInstall всегда false', async () => {
  const res = await request('/api/v1/updates/check?currentVersion=1.0.0');
  assert(res.status === 200, `status ${res.status}`);
  assert(res.json?.autoInstall === false, `autoInstall=${res.json?.autoInstall}`);
  assert(typeof res.json?.checkedAt === 'string', 'нет checkedAt');
  return `latest=${res.json?.latestVersion ?? '—'}`;
});

await check('GET /api/v1/updates/check с невалидной версией → обновлений нет', async () => {
  const res = await request('/api/v1/updates/check?currentVersion=latest');
  assert(res.status === 200, `status ${res.status}`);
  assert(res.json?.updateAvailable === false, 'невалидная версия не должна давать обновление');
  assert(res.json?.currentVersion === null, 'currentVersion должен быть null');
});

await check('GET /api/v1/config отдаёт публичную конфигурацию', async () => {
  const res = await request('/api/v1/config');
  assert(res.status === 200, `status ${res.status}`);
  assert(res.json?.name === 'SHELTER', `name=${res.json?.name}`);
});

// ------------------------------------- панель /manage: вход логином и паролем
// Работает БЕЗ OAuth: сервер сам создаёт админа при старте. Демо-пароль
// сервер отдаёт только вне production (adminLogin.demo), в бою берём env.
{
  const providers = await request('/api/v1/auth/providers');
  assert(providers.status === 200, `providers status ${providers.status}`);
  const demo = providers.json?.adminLogin?.demo ?? null;
  const adminEmail = demo?.email ?? ADMIN_EMAIL;
  const password = demo?.password ?? process.env.ADMIN_PASSWORD ?? '';

  await check('POST /manage/api/login: неверный пароль отклоняется (401)', async () => {
    const res = await request('/manage/api/login', {
      method: 'POST',
      body: { email: adminEmail, password: 'definitely-wrong-password' },
    });
    assert(res.status === 401, `status ${res.status}, body ${res.text.slice(0, 160)}`);
    assert(res.json?.error?.code === 'invalid_credentials', `code=${res.json?.error?.code}`);
  });

  if (!password) {
    await check('production: демо-подсказки нет (adminLogin.demo = null)', async () => {
      assert(demo === null, 'демо-пароль виден в production!');
    });
  } else {
    let adminCookie = null;
    await check('POST /manage/api/login: админ входит логином+паролем без OAuth', async () => {
      const res = await request('/manage/api/login', {
        method: 'POST',
        body: { email: adminEmail, password },
      });
      assert(res.status === 200, `status ${res.status}, body ${res.text.slice(0, 200)}`);
      assert(res.json?.user?.role === 'admin', `role=${res.json?.user?.role}`);
      adminCookie = cookieFrom(res);
      assert(adminCookie, 'cookie сессии не установлена');
      return `email=${res.json.user.email}`;
    });

    if (adminCookie) {
      await check('GET /manage/api/session и /manage/api/overview после парольного входа', async () => {
        const session = await request('/manage/api/session', { cookie: adminCookie });
        assert(session.status === 200 && session.json?.user?.role === 'admin', `session ${session.status}`);
        const overview = await request('/manage/api/overview', { cookie: adminCookie });
        assert(overview.status === 200, `overview ${overview.status}`);
        return `users=${overview.json?.metrics?.usersTotal}`;
      });

      await check('POST /manage/api/logout отзывает сессию панели', async () => {
        const out = await request('/manage/api/logout', { method: 'POST', cookie: adminCookie, body: {} });
        assert(out.status === 200, `logout ${out.status}`);
        const after = await request('/manage/api/session', { cookie: adminCookie });
        assert(after.status === 401, `сессия жива после logout: ${after.status}`);
      });
    }
  }
}

// --------------------------------------------------- сквозной сценарий (dev-вход)
if (DEV_LOGIN) {
  let cookie = null;
  await check('POST /api/v1/auth/dev-login создаёт сессию', async () => {
    const res = await request('/api/v1/auth/dev-login', { method: 'POST', body: { email: ADMIN_EMAIL } });
    assert(res.status === 200, `status ${res.status}, body ${res.text.slice(0, 200)}`);
    cookie = cookieFrom(res);
    assert(cookie, 'cookie сессии не установлена');
  });

  if (cookie) {
    await check('GET /api/v1/me/subscription: до оплаты доступ не подтверждён', async () => {
      const res = await request('/api/v1/me/subscription', { cookie });
      assert(res.status === 200, `status ${res.status}`);
      assert(res.json?.active === false, 'доступ выдан без оплаты!');
    });

    await check('POST /api/v1/checkout: заказ с серверной ценой', async () => {
      const res = await request('/api/v1/checkout', { method: 'POST', cookie, body: { planId: 'monthly' } });
      assert(res.status === 201 || res.status === 200, `status ${res.status}`);
      assert(res.json?.amountMinor === 29900, `amountMinor=${res.json?.amountMinor}`);
      assert(res.json?.checkoutUrl, 'нет checkoutUrl');
      globalThis.__orderId = res.json.orderId;
      return res.json.orderId;
    });

    await check('POST /api/v1/checkout с неизвестным тарифом → 400', async () => {
      const res = await request('/api/v1/checkout', { method: 'POST', cookie, body: { planId: 'forever-free' } });
      assert(res.status === 400, `status ${res.status}`);
    });

    await check('webhook с корректной подписью оплачивает заказ', async () => {
      const orderId = globalThis.__orderId;
      assert(orderId, 'нет orderId от checkout');
      const body = JSON.stringify({
        id: `evt_smoke_${Date.now()}`,
        type: 'payment.succeeded',
        orderId,
        amountMinor: 29900,
      });
      const res = await request('/api/v1/webhooks/payment', {
        method: 'POST',
        body,
        headers: { 'x-shelter-signature': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex') },
      });
      assert(res.status === 200, `status ${res.status}, body ${res.text.slice(0, 200)}`);
    });

    await check('GET /api/v1/me/subscription: после оплаты доступ подтверждён сервером', async () => {
      const res = await request('/api/v1/me/subscription', { cookie });
      assert(res.json?.active === true, `active=${res.json?.active}, reason=${res.json?.reason}`);
      assert(res.json?.planId === 'monthly', `planId=${res.json?.planId}`);
      return `expiresAt=${res.json?.expiresAt}`;
    });

    await check('GET /manage/api/overview доступен администратору', async () => {
      const res = await request('/manage/api/overview', { cookie });
      if (res.status === 403) throw new Error('403: email не входит в ADMIN_BOOTSTRAP_EMAILS');
      assert(res.status === 200, `status ${res.status}`);
      assert(typeof res.json?.metrics?.usersTotal === 'number', 'нет метрик');
      return `users=${res.json.metrics.usersTotal}, paid=${res.json.metrics.paidOrderCount}`;
    });

    await check('DELETE /api/v1/me: аккаунт анонимизирован, сессия отозвана', async () => {
      const res = await request('/api/v1/me', { method: 'DELETE', cookie, body: {} });
      assert(res.status === 200, `status ${res.status}`);
      const after = await request('/api/v1/me', { cookie });
      assert(after.status === 401, `сессия жива после удаления: ${after.status}`);
    });
  }
} else {
  console.log('  \u001b[33mSKIP\u001b[0m сквозной сценарий (DEV_LOGIN_ENABLED=false)');
}

// ---------------------------------------------------------------- итог
console.log('');
if (failed) {
  console.log(`\u001b[31m${failed} из ${passed + failed} проверок упало:\u001b[0m`);
  failures.forEach((f) => console.log(`  - ${f}`));
  process.exit(1);
}
console.log(`\u001b[32mВсе ${passed} smoke-проверок пройдены.\u001b[0m\n`);
process.exit(0);
