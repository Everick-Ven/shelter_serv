import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../helpers/app.js';
import { createTestApp, loginAs, oauthLogin, TEST_SECRETS, testEnv } from '../helpers/app.js';
import { hashPassword } from '../../src/lib/passwords.js';
import { PLANS } from '../../src/domain/plans.js';

let t: TestApp;

beforeEach(async () => {
  t = await createTestApp();
});

afterEach(async () => {
  await t.close();
});

function signWebhook(body: string, secret = TEST_SECRETS.PAYMENT_WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/** Оплата заказа через подписанный webhook (как это делает платёжный провайдер). */
async function payViaWebhook(orderId: string, opts: { amountMinor?: number; eventId?: string } = {}) {
  const body = JSON.stringify({
    id: opts.eventId ?? `evt_${orderId}_${Math.random().toString(36).slice(2)}`,
    type: 'payment.succeeded',
    orderId,
    providerPaymentId: `mock_${orderId}`,
    amountMinor: opts.amountMinor ?? PLANS.monthly.amountMinor,
  });
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/webhooks/payment',
    headers: { 'content-type': 'application/json', 'x-shelter-signature': signWebhook(body) },
    payload: body,
  });
}

async function createCheckout(cookie: string, planId = 'monthly', idempotencyKey?: string) {
  return t.app.inject({
    method: 'POST',
    url: '/api/v1/checkout',
    headers: { cookie },
    payload: { planId, ...(idempotencyKey ? { idempotencyKey } : {}) },
  });
}

// ==========================================================================
describe('инфраструктура и безопасность', () => {
  it('/healthz отвечает без авторизации', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
  });

  it('/readyz проверяет доступность хранилища', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', store: 'memory' });
  });

  it('выставляет заголовки безопасности и CSP без unsafe-inline для скриптов', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const csp = String(res.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBeTruthy();
  });

  it('неизвестный API-путь отдаёт JSON 404, а не HTML', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('витрина доступна на корне, панель — на /manage', async () => {
    const site = await t.app.inject({ method: 'GET', url: '/' });
    expect(site.statusCode).toBe(200);
    expect(site.headers['content-type']).toContain('text/html');
    expect(site.body).toContain('SHELTER');

    const manage = await t.app.inject({ method: 'GET', url: '/manage' });
    expect(manage.statusCode).toBe(200);
    expect(manage.body).toContain('Панель управления');
  });

  it('личный кабинет /account и страницы оплаты отдаются как HTML', async () => {
    for (const url of ['/account', '/checkout/success', '/checkout/mock']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    }
  });

  it('страница симуляции оплаты не регистрируется в production-профиле', async () => {
    // Проверяем на dev-профиле с боевым платёжным провайдером: mock-страницы нет.
    const prod = await createTestApp({
      NODE_ENV: 'production',
      PAYMENT_PROVIDER: 'yookassa',
      YOOKASSA_SHOP_ID: 'shop-test',
      YOOKASSA_SECRET_KEY: 'secret-test',
      COOKIE_SECURE: 'true',
      PUBLIC_BASE_URL: 'https://shelter.test',
      ALLOWED_ORIGINS: 'https://shelter.test',
      DEV_LOGIN_ENABLED: 'false',
      REQUIRE_HTTPS: 'false',
      ADMIN_PASSWORD: 'production-admin-password-1',
    });
    try {
      for (const url of ['/checkout/mock', '/checkout/mock.html']) {
        const mock = await prod.app.inject({ method: 'GET', url });
        expect(mock.statusCode).toBe(404);
        expect(mock.body).not.toContain('Симуляция оплаты');
      }
      const mockPay = await prod.app.inject({
        method: 'POST',
        url: '/api/v1/mock/payments/ord_anything/succeed',
        payload: {},
      });
      // Маршрут не зарегистрирован: 404 (а не 401/200 — его просто нет).
      expect(mockPay.statusCode).toBe(404);
    } finally {
      await prod.close();
    }
  });

  it('витрина и кабинет не требуют авторизации, но и не раскрывают приватных данных', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/account' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('@shelter.test');
  });

  it('не-API GET без файла отдаёт витрину (SPA-fallback)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/pricing' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('SHELTER');
  });
});

// ==========================================================================
describe('аутентификация', () => {
  it('список провайдеров содержит google и yandex', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(res.statusCode).toBe(200);
    const names = (res.json().providers as { name: string }[]).map((p) => p.name);
    expect(names).toContain('google');
    expect(names).toContain('yandex');
  });

  it('защищённые маршруты без сессии отдают 401', async () => {
    for (const url of ['/api/v1/me', '/api/v1/me/subscription', '/api/v1/me/orders']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('session_invalid');
    }
  });

  it('dev-вход создаёт сессию, но не выдаёт подписку', async () => {
    const { cookie } = await loginAs(t, 'dev@shelter.test');
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('dev@shelter.test');
    expect(me.json().subscription.status).toBe('none');

    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json().active).toBe(false);
    expect(status.json().reason).toBe('no_subscription');
  });

  it('dev-вход недоступен, когда флаг выключен', async () => {
    const strict = await createTestApp({ DEV_LOGIN_ENABLED: 'false' });
    try {
      const res = await strict.app.inject({
        method: 'POST',
        url: '/api/v1/auth/dev-login',
        payload: { email: 'dev@shelter.test' },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await strict.close();
    }
  });

  it('cookie сессии: HttpOnly + SameSite=Lax', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { email: 'cookie@shelter.test' },
    });
    const cookie = res.cookies.find((c) => c.name === t.env.COOKIE_NAME);
    expect(cookie).toBeTruthy();
    expect(cookie!.httpOnly).toBe(true);
    expect(String(cookie!.sameSite).toLowerCase()).toBe('lax');
    expect(cookie!.path).toBe('/');
    // В тестах COOKIE_SECURE=false; отдельный кейс ниже проверяет secure=true.
    expect(cookie!.secure).toBeFalsy();
  });

  it('при COOKIE_SECURE=true cookie помечается Secure (production-инвариант)', async () => {
    const secure = await createTestApp({ COOKIE_SECURE: 'true' });
    try {
      const res = await secure.app.inject({
        method: 'POST',
        url: '/api/v1/auth/dev-login',
        payload: { email: 'secure@shelter.test' },
      });
      const cookie = res.cookies.find((c) => c.name === secure.env.COOKIE_NAME);
      expect(cookie).toBeTruthy();
      expect(cookie!.secure).toBe(true);
      expect(cookie!.httpOnly).toBe(true);
    } finally {
      await secure.close();
    }
  });

  it('logout отзывает сессию: повторное использование cookie даёт 401', async () => {
    const { cookie } = await loginAs(t, 'logout@shelter.test');
    const ok = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(ok.statusCode).toBe(200);

    const out = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie }, payload: {} });
    expect(out.statusCode).toBe(200);

    const after = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('поддельная cookie не проходит', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${t.env.COOKIE_NAME}=totally-made-up-token` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('OAuth Google: start ставит state-cookie и редиректит на провайдера', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/google/start?redirect=%2Fmanage' });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('fake.test/google/authorize');
    expect(res.cookies.find((c) => c.name === 'shelter_oauth_state')).toBeTruthy();
  });

  it('OAuth Google: полный цикл создаёт пользователя и сессию', async () => {
    const result = await oauthLogin(t, 'google', {
      providerUserId: 'g-123',
      email: 'google.user@shelter.test',
      name: 'Google User',
    });
    expect(result.statusCode).toBe(302);
    expect(result.cookie).not.toBe('');

    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: result.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('google.user@shelter.test');
    // Подписка не выдаётся «за факт входа».
    expect(me.json().subscription.status).toBe('none');
  });

  it('OAuth Yandex: полный цикл работает так же', async () => {
    const result = await oauthLogin(t, 'yandex', {
      providerUserId: 'y-777',
      email: 'yandex.user@shelter.test',
      name: 'Yandex User',
    });
    expect(result.statusCode).toBe(302);
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: result.cookie } });
    expect(me.json().user.email).toBe('yandex.user@shelter.test');
  });

  it('несовпадение state отклоняется (CSRF)', async () => {
    const code = Buffer.from(
      JSON.stringify({ provider: 'google', providerUserId: 'g-999', email: 'x@shelter.test', emailVerified: true }),
    ).toString('base64url');
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=${code}&state=forged-state`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('state_mismatch');
  });

  it('callback без state-cookie отклоняется', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/google/callback?code=abc&state=xyz' });
    expect(res.statusCode).toBe(403);
  });

  it('open redirect блокируется: внешний редирект заменяется на /manage', async () => {
    const start = await t.app.inject({
      method: 'GET',
      url: '/api/v1/auth/google/start?redirect=https%3A%2F%2Fevil.example%2Fsteal',
    });
    expect(start.statusCode).toBe(302);
    const state = start.cookies.find((c) => c.name === 'shelter_oauth_state')!.value;
    const code = Buffer.from(
      JSON.stringify({ provider: 'google', providerUserId: 'g-evil', email: 'evil@shelter.test', emailVerified: true }),
    ).toString('base64url');
    const callback = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
      headers: { cookie: `shelter_oauth_state=${state}` },
    });
    expect(callback.statusCode).toBe(302);
    expect(String(callback.headers.location)).toBe('/manage');
  });

  it('protocol-relative редирект (//evil) тоже блокируется', async () => {
    const start = await t.app.inject({ method: 'GET', url: '/api/v1/auth/google/start?redirect=%2F%2Fevil.example' });
    const state = start.cookies.find((c) => c.name === 'shelter_oauth_state')!.value;
    const code = Buffer.from(
      JSON.stringify({ provider: 'google', providerUserId: 'g-evil2', email: null, emailVerified: false }),
    ).toString('base64url');
    const callback = await t.app.inject({
      method: 'GET',
      url: `/api/v1/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`,
      headers: { cookie: `shelter_oauth_state=${state}` },
    });
    expect(String(callback.headers.location)).toBe('/manage');
  });

  it('email из ADMIN_BOOTSTRAP_EMAILS получает роль admin', async () => {
    const result = await oauthLogin(t, 'google', {
      providerUserId: 'g-admin',
      email: 'admin@shelter.test',
      name: 'Admin',
    });
    const me = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: result.cookie } });
    expect(me.json().user.role).toBe('admin');
  });
});

// ==========================================================================
describe('premium.status — серверная проверка подписки', () => {
  it('без подписки доступ не подтверждён', async () => {
    const { cookie } = await loginAs(t, 'free@shelter.test');
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.active).toBe(false);
    expect(body.status).toBe('none');
    expect(body.planId).toBeNull();
    expect(body.expiresAt).toBeNull();
    expect(typeof body.checkedAt).toBe('string');
  });

  it('после оплаты через webhook доступ подтверждён сервером', async () => {
    const { cookie } = await loginAs(t, 'paid@shelter.test');
    const checkout = await createCheckout(cookie, 'monthly');
    expect(checkout.statusCode).toBe(201);
    const orderId = checkout.json().orderId as string;

    const webhook = await payViaWebhook(orderId);
    expect(webhook.statusCode).toBe(200);

    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    const body = status.json();
    expect(body.active).toBe(true);
    expect(body.status).toBe('active');
    expect(body.planId).toBe('monthly');
    expect(body.reason).toBe('paid');
    expect(body.expiresAt).not.toBeNull();
    expect(body.plan.days).toBe(30);
  });

  it('просроченная подписка => active=false, reason=expired', async () => {
    const { cookie, userId } = await loginAs(t, 'expired@shelter.test');
    await t.store.subscriptionUpsert(userId, {
      status: 'active',
      planId: 'monthly',
      expiresAt: new Date(Date.now() - 60_000),
      source: 'payment',
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(res.json().active).toBe(false);
    expect(res.json().reason).toBe('expired');
  });

  it('отозванная подписка => active=false, reason=revoked', async () => {
    const { cookie, userId } = await loginAs(t, 'revoked@shelter.test');
    await t.store.subscriptionUpsert(userId, {
      status: 'revoked',
      planId: 'yearly',
      expiresAt: new Date(Date.now() + 86_400_000),
      source: 'payment',
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(res.json()).toMatchObject({ active: false, reason: 'revoked', status: 'revoked' });
  });

  it('битые данные в подписке => отказ (invalid_data)', async () => {
    const { cookie, userId } = await loginAs(t, 'broken@shelter.test');
    await t.store.subscriptionUpsert(userId, {
      status: 'active',
      planId: 'monthly',
      expiresAt: null, // срок потерян
      source: 'payment',
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(res.json().active).toBe(false);
    expect(res.json().reason).toBe('invalid_data');
  });

  it('сбой хранилища => verification_failed и active=false (fail-closed)', async () => {
    const { cookie } = await loginAs(t, 'failclosed@shelter.test');
    const original = t.store.subscriptionGet.bind(t.store);
    (t.store as unknown as { subscriptionGet: unknown }).subscriptionGet = async () => {
      throw new Error('database is down');
    };
    try {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json().active).toBe(false);
      expect(res.json().reason).toBe('verification_failed');
    } finally {
      (t.store as unknown as { subscriptionGet: unknown }).subscriptionGet = original;
    }
  });
});

// ==========================================================================
describe('checkout', () => {
  it('без авторизации заказ не создаётся', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/checkout', payload: { planId: 'monthly' } });
    expect(res.statusCode).toBe(401);
  });

  it('неизвестный planId отклоняется', async () => {
    const { cookie } = await loginAs(t, 'plan@shelter.test');
    for (const planId of ['lifetime', 'free', 'YEARLY', '__proto__', 'constructor', 'monthly ']) {
      const res = await createCheckout(cookie, planId);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_plan');
    }
    // Пустой planId отсекается ещё валидатором тела.
    const empty = await createCheckout(cookie, '');
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('invalid_body');
  });

  it('пустое/битое тело отклоняется валидатором', async () => {
    const { cookie } = await loginAs(t, 'body@shelter.test');
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/checkout', headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_body');
  });

  it('создаёт заказ с серверной ценой и ссылкой на оплату', async () => {
    const { cookie } = await loginAs(t, 'checkout@shelter.test');
    const res = await createCheckout(cookie, 'yearly');
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.planId).toBe('yearly');
    expect(body.amountMinor).toBe(PLANS.yearly.amountMinor);
    expect(body.currency).toBe('RUB');
    expect(body.days).toBe(365);
    expect(body.checkoutUrl).toMatch(/^https?:\/\//);
    expect(['created', 'pending']).toContain(body.status);
  });

  it('клиент не может подменить цену через тело запроса', async () => {
    const { cookie } = await loginAs(t, 'price@shelter.test');
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/checkout',
      headers: { cookie },
      payload: { planId: 'monthly', amountMinor: 1, days: 3650, currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().amountMinor).toBe(PLANS.monthly.amountMinor);
    expect(res.json().days).toBe(30);
    expect(res.json().currency).toBe('RUB');
  });

  it('idempotencyKey не плодит duplicate-заказы', async () => {
    const { cookie } = await loginAs(t, 'idem@shelter.test');
    const first = await createCheckout(cookie, 'monthly', 'idem-key-123456');
    const second = await createCheckout(cookie, 'monthly', 'idem-key-123456');
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().orderId).toBe(first.json().orderId);
  });

  it('чужой ключ идемпотентности не переиспользуется', async () => {
    const a = await loginAs(t, 'user-a@shelter.test');
    const b = await loginAs(t, 'user-b@shelter.test');
    await createCheckout(a.cookie, 'monthly', 'shared-key-123');
    const res = await createCheckout(b.cookie, 'monthly', 'shared-key-123');
    expect(res.statusCode).toBe(409);
  });

  it('статус заказа виден только владельцу', async () => {
    const owner = await loginAs(t, 'owner@shelter.test');
    const other = await loginAs(t, 'other@shelter.test');
    const created = await createCheckout(owner.cookie, 'monthly');
    const orderId = created.json().orderId as string;

    const own = await t.app.inject({ method: 'GET', url: `/api/v1/checkout/${orderId}`, headers: { cookie: owner.cookie } });
    expect(own.statusCode).toBe(200);

    const foreign = await t.app.inject({ method: 'GET', url: `/api/v1/checkout/${orderId}`, headers: { cookie: other.cookie } });
    expect(foreign.statusCode).toBe(404);
  });
});

// ==========================================================================
describe('платёжные webhook-и', () => {
  it('без подписи уведомление отклоняется (401) и доступ не выдаётся', async () => {
    const { cookie } = await loginAs(t, 'nosig@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', orderId });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payment',
      headers: { 'content-type': 'application/json' },
      payload: body,
    });
    expect(res.statusCode).toBe(401);

    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(status.json().active).toBe(false);
  });

  it('неверная подпись отклоняется', async () => {
    const { cookie } = await loginAs(t, 'badsig@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;
    const body = JSON.stringify({ id: 'evt_2', type: 'payment.succeeded', orderId });

    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payment',
      headers: { 'content-type': 'application/json', 'x-shelter-signature': signWebhook(body, 'wrong-secret') },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(status.json().active).toBe(false);
  });

  it('валидное уведомление оплачивает заказ и включает премиум', async () => {
    const { cookie } = await loginAs(t, 'good@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;
    const res = await payViaWebhook(orderId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, applied: true });

    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(status.json().active).toBe(true);
    const order = await t.store.orderById(orderId);
    expect(order!.status).toBe('paid');
    expect(order!.paidAt).not.toBeNull();
  });

  it('повторная доставка того же события не продлевает срок второй раз', async () => {
    const { cookie, userId } = await loginAs(t, 'dup@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;

    const first = await payViaWebhook(orderId, { eventId: 'evt_same' });
    expect(first.statusCode).toBe(200);
    expect(first.json().applied).toBe(true);
    const expiresAfterFirst = (await t.store.subscriptionGet(userId))!.expiresAt;

    const second = await payViaWebhook(orderId, { eventId: 'evt_same' });
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);

    // Срок не сдвинулся, заказ остался оплаченным ровно один раз
    expect((await t.store.subscriptionGet(userId))!.expiresAt).toBe(expiresAfterFirst);
    expect((await t.store.orderById(orderId))!.status).toBe('paid');
    expect((await t.store.orderPaidStatsForUser(userId)).count).toBe(1);
  });

  it('расхождение суммы: уведомление принято, но доступ не выдан', async () => {
    const { cookie, userId } = await loginAs(t, 'mismatch@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;
    const res = await payViaWebhook(orderId, { amountMinor: 100 });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(false);

    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(status.json().active).toBe(false);
    expect((await t.store.orderById(orderId))!.status).not.toBe('paid');
    void userId;
  });

  it('уведомление о неизвестном заказе игнорируется', async () => {
    const res = await payViaWebhook('ord_unknown');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, ignored: true });
  });

  it('неподдерживаемый тип события игнорируется', async () => {
    const { cookie } = await loginAs(t, 'ignore@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;
    const body = JSON.stringify({ id: 'evt_x', type: 'payment.weird', orderId });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payment',
      headers: { 'content-type': 'application/json', 'x-shelter-signature': signWebhook(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ignored).toBe(true);
    expect((await t.store.orderById(orderId))!.status).not.toBe('paid');
  });

  it('refund закрывает доступ', async () => {
    const { cookie } = await loginAs(t, 'refund@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;
    await payViaWebhook(orderId);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } })).json().active).toBe(true);

    const body = JSON.stringify({ id: 'evt_refund', type: 'refund.succeeded', orderId });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/payment',
      headers: { 'content-type': 'application/json', 'x-shelter-signature': signWebhook(body) },
      payload: body,
    });
    expect(res.statusCode).toBe(200);

    const after = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } });
    expect(after.json().active).toBe(false);
    expect(after.json().reason).toBe('refunded');
  });
});

// ==========================================================================
describe('панель /manage/api', () => {
  it('анонимный запрос отклоняется (401)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/manage/api/overview' });
    expect(res.statusCode).toBe(401);
  });

  it('обычный пользователь получает 403', async () => {
    const { cookie } = await loginAs(t, 'regular@shelter.test');
    const res = await t.app.inject({ method: 'GET', url: '/manage/api/overview', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('admin_required');
  });

  it('администратор видит сводку с показателями из orders', async () => {
    const { cookie } = await loginAs(t, 'admin@shelter.test');
    const res = await t.app.inject({ method: 'GET', url: '/manage/api/overview', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // +1 к пользователям: bootstrap-админ (admin@shelter.local) создаётся при старте.
    expect(body.metrics).toMatchObject({ usersTotal: 2, paidOrderCount: 0, revenueMinor: 0 });
    expect(body.plans.length).toBe(2);
  });

  it('grant администратора включает премиум у пользователя с источником admin_grant', async () => {
    const admin = await loginAs(t, 'admin@shelter.test');
    const user = await loginAs(t, 'granted@shelter.test');

    const grant = await t.app.inject({
      method: 'POST',
      url: `/manage/api/users/${user.userId}/subscription/grant`,
      headers: { cookie: admin.cookie },
      payload: { planId: 'monthly', note: 'beta promo' },
    });
    expect(grant.statusCode).toBe(200);
    expect(grant.json().subscription.status).toBe('active');
    expect(grant.json().subscription.source).toBe('admin_grant');

    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie: user.cookie } });
    expect(status.json().active).toBe(true);
    expect(status.json().reason).toBe('granted');

    // Grant не является оплатой: paid_order_count остаётся 0.
    const detail = await t.app.inject({
      method: 'GET',
      url: `/manage/api/users/${user.userId}`,
      headers: { cookie: admin.cookie },
    });
    expect(detail.json().billing.paidOrderCount).toBe(0);
    expect(detail.json().billing.firstPaymentAt).toBeNull();
  });

  it('grant с неизвестным тарифом отклоняется', async () => {
    const admin = await loginAs(t, 'admin@shelter.test');
    const user = await loginAs(t, 'granted2@shelter.test');
    const res = await t.app.inject({
      method: 'POST',
      url: `/manage/api/users/${user.userId}/subscription/grant`,
      headers: { cookie: admin.cookie },
      payload: { planId: 'forever-free' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('отзыв доступа администратором закрывает премиум', async () => {
    const admin = await loginAs(t, 'admin@shelter.test');
    const user = await loginAs(t, 'revoke-me@shelter.test');
    await t.app.inject({
      method: 'POST',
      url: `/manage/api/users/${user.userId}/subscription/grant`,
      headers: { cookie: admin.cookie },
      payload: { planId: 'yearly' },
    });
    const revoke = await t.app.inject({
      method: 'POST',
      url: `/manage/api/users/${user.userId}/subscription/revoke`,
      headers: { cookie: admin.cookie },
      payload: { note: 'chargeback' },
    });
    expect(revoke.statusCode).toBe(200);

    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie: user.cookie } });
    expect(status.json().active).toBe(false);
    expect(status.json().reason).toBe('revoked');
  });

  it('список пользователей содержит paid_order_count и first_payment_at из orders', async () => {
    const admin = await loginAs(t, 'admin@shelter.test');
    const user = await loginAs(t, 'payer@shelter.test');
    const orderId = (await createCheckout(user.cookie, 'yearly')).json().orderId as string;
    await payViaWebhook(orderId, { amountMinor: PLANS.yearly.amountMinor });

    const list = await t.app.inject({ method: 'GET', url: '/manage/api/users?q=payer', headers: { cookie: admin.cookie } });
    expect(list.statusCode).toBe(200);
    const item = (list.json().items as any[]).find((u) => u.email === 'payer@shelter.test');
    expect(item.paidOrderCount).toBe(1);
    expect(item.firstPaymentAt).not.toBeNull();

    const orders = await t.app.inject({ method: 'GET', url: '/manage/api/orders?status=paid', headers: { cookie: admin.cookie } });
    expect(orders.json().total).toBe(1);
    expect(orders.json().items[0].planId).toBe('yearly');
  });

  it('ручной возврат закрывает доступ и меняет статус заказа', async () => {
    const admin = await loginAs(t, 'admin@shelter.test');
    const user = await loginAs(t, 'refunded@shelter.test');
    const orderId = (await createCheckout(user.cookie, 'monthly')).json().orderId as string;
    await payViaWebhook(orderId);

    const refund = await t.app.inject({
      method: 'POST',
      url: `/manage/api/orders/${orderId}/refund`,
      headers: { cookie: admin.cookie },
      payload: {},
    });
    expect(refund.statusCode).toBe(200);
    expect((await t.store.orderById(orderId))!.status).toBe('refunded');

    const status = await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie: user.cookie } });
    expect(status.json().active).toBe(false);
  });

  it('смена роли доступна только администратору и попадает в аудит', async () => {
    const admin = await loginAs(t, 'admin@shelter.test');
    const user = await loginAs(t, 'promote@shelter.test');
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/manage/api/users/${user.userId}`,
      headers: { cookie: admin.cookie },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(200);
    const after = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: user.cookie } });
    expect(after.json().user.role).toBe('admin');
  });

  it('пользователь не может повысить себе роль напрямую', async () => {
    const user = await loginAs(t, 'selfpromo@shelter.test');
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/manage/api/users/${user.userId}`,
      headers: { cookie: user.cookie },
      payload: { role: 'admin' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('настройки канала обновлений меняются только администратором', async () => {
    const admin = await loginAs(t, 'admin@shelter.test');
    const user = await loginAs(t, 'notadmin@shelter.test');

    const forbiddenRes = await t.app.inject({
      method: 'PATCH',
      url: '/manage/api/updates',
      headers: { cookie: user.cookie },
      payload: { channel: 'beta' },
    });
    expect(forbiddenRes.statusCode).toBe(403);

    const patch = await t.app.inject({
      method: 'PATCH',
      url: '/manage/api/updates',
      headers: { cookie: admin.cookie },
      payload: { channel: 'beta', minSupportedVersion: '1.0.0' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ channel: 'beta', minSupportedVersion: '1.0.0' });

    const bad = await t.app.inject({
      method: 'PATCH',
      url: '/manage/api/updates',
      headers: { cookie: admin.cookie },
      payload: { minSupportedVersion: 'latest' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

// ==========================================================================
describe('канал обновлений (публичный контракт app.checkUpdates)', () => {
  it('без currentVersion отдаёт 400', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/updates/check' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('missing_version');
  });

  it('нечитаемая версия => обновлений нет (автоустановка запрещена)', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/updates/check?currentVersion=latest' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updateAvailable: false, autoInstall: false, currentVersion: null });
  });

  it('пустой кэш релизов => updateAvailable=false, release=null', async () => {
    const offline = await createTestApp({}, { fetchImpl: (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch });
    try {
      const res = await offline.app.inject({ method: 'GET', url: '/api/v1/updates/check?currentVersion=1.0.0' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.updateAvailable).toBe(false);
      expect(body.release).toBeNull();
      expect(body.autoInstall).toBe(false);
      expect(body.channel).toBe('stable');
    } finally {
      await offline.close();
    }
  });

  it('после загрузки релизов предлагает обновление со ссылкой на релиз', async () => {
    const withReleases = await createTestApp(
      {},
      {
        fetchImpl: (async () =>
          new Response(
            JSON.stringify([
              {
                id: 1,
                tag_name: 'v2.0.0',
                name: 'SHELTER 2.0.0',
                body: 'Большой релиз',
                html_url: 'https://github.com/Everick-Ven/shelter/releases/tag/v2.0.0',
                published_at: '2026-02-01T10:00:00Z',
                prerelease: false,
                draft: false,
                assets: [{ name: 'shelter-2.0.0-setup.exe', browser_download_url: 'https://example.com/s.exe', size: 2048 }],
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as unknown as typeof fetch,
      },
    );
    try {
      const res = await withReleases.app.inject({ method: 'GET', url: '/api/v1/updates/check?currentVersion=1.0.0' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.updateAvailable).toBe(true);
      expect(body.latestVersion).toBe('2.0.0');
      expect(body.release.htmlUrl).toContain('/releases/tag/v2.0.0');
      expect(body.release.assets[0].name).toBe('shelter-2.0.0-setup.exe');
      expect(body.autoInstall).toBe(false);
    } finally {
      await withReleases.close();
    }
  });

  it('/api/v1/updates/latest отдаёт данные для витрины', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/updates/latest' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('available');
  });
});

// ==========================================================================
describe('каталог тарифов и профиль', () => {
  it('/api/v1/plans публичен и содержит цены из клиентского каталога', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/plans' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.currency).toBe('RUB');
    const monthly = body.plans.find((p: any) => p.id === 'monthly');
    const yearly = body.plans.find((p: any) => p.id === 'yearly');
    expect(monthly.amountMinor).toBe(29900);
    expect(monthly.days).toBe(30);
    expect(yearly.amountMinor).toBe(239000);
    expect(yearly.days).toBe(365);
  });

  it('PATCH /api/v1/me обновляет профиль и валидирует вход', async () => {
    const { cookie } = await loginAs(t, 'profile@shelter.test');
    const ok = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie },
      payload: { name: 'Новое имя' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().user.name).toBe('Новое имя');

    const bad = await t.app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: { cookie },
      payload: { name: '' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

// ==========================================================================
describe('DELETE /api/v1/me — удаление данных и отзыв сессий', () => {
  it('анонимизирует профиль, отзывает все сессии и закрывает доступ', async () => {
    const { cookie, userId } = await loginAs(t, 'delete-me@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;
    await payViaWebhook(orderId);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me/subscription', headers: { cookie } })).json().active).toBe(true);

    const del = await t.app.inject({ method: 'DELETE', url: '/api/v1/me', headers: { cookie }, payload: {} });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true, deleted: true });

    // Профиль анонимизирован
    const user = await t.store.userById(userId);
    expect(user!.email).toBeNull();
    expect(user!.name).toBeNull();
    expect(user!.deletedAt).not.toBeNull();

    // Доступ закрыт
    const sub = await t.store.subscriptionGet(userId);
    expect(sub!.status).toBe('revoked');

    // Сессии отозваны: старый cookie больше не работает
    const after = await t.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie } });
    expect(after.statusCode).toBe(401);

    // OAuth-идентичности удалены
    expect((await t.store.identitiesByUser(userId)).length).toBe(0);
  });

  it('без авторизации удаление невозможно', async () => {
    const res = await t.app.inject({ method: 'DELETE', url: '/api/v1/me', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('бухгалтерия заказов сохраняется (обезличенно)', async () => {
    const { cookie, userId } = await loginAs(t, 'keep-orders@shelter.test');
    const orderId = (await createCheckout(cookie, 'monthly')).json().orderId as string;
    await payViaWebhook(orderId);
    await t.app.inject({ method: 'DELETE', url: '/api/v1/me', headers: { cookie }, payload: {} });

    const stats = await t.store.orderPaidStatsForUser(userId);
    expect(stats.count).toBe(1);
    expect(stats.lifetimeMinor).toBe(PLANS.monthly.amountMinor);
  });
});

// ==========================================================================
describe('админка: демо-вход кнопкой и пароль из env', () => {
  const EMAIL = 'admin@shelter.local';

  function login(loginName: string, password: string) {
    return t.app.inject({
      method: 'POST',
      url: '/manage/api/login',
      payload: { email: loginName, password },
    });
  }
  function demoLogin(app = t.app) {
    return app.inject({ method: 'POST', url: '/manage/api/demo-login', payload: {} });
  }

  it('кнопка демо-входа пускает в панель без пароля (вне production)', async () => {
    const res = await demoLogin();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, user: { email: EMAIL, role: 'admin' } });
    const cookie = res.cookies.find((c) => c.name === t.env.COOKIE_NAME);
    expect(cookie).toBeTruthy();

    const overview = await t.app.inject({
      method: 'GET',
      url: '/manage/api/overview',
      headers: { cookie: `${cookie!.name}=${cookie!.value}` },
    });
    expect(overview.statusCode).toBe(200);
  });

  it('демо-вход не ставит аккаунту пароль: парольный вход без ADMIN_PASSWORD закрыт', async () => {
    await demoLogin();
    const user = await t.store.userByEmail(EMAIL);
    expect(user!.passwordHash).toBeNull();
    const res = await login('admin', 'whatever-password');
    expect(res.statusCode).toBe(401);
  });

  it('providers сообщает о кнопке демо-входа только вне production', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
    expect(res.json().adminLogin).toMatchObject({ enabled: true, demoLogin: true });
  });

  it('пароль из ADMIN_PASSWORD работает наряду с демо-кнопкой', async () => {
    const withPass = await createTestApp({ ADMIN_PASSWORD: 'local-admin-pass-1' });
    try {
      const providers = await withPass.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
      expect(providers.json().adminLogin.demoLogin).toBe(true); // не production

      const good = await withPass.app.inject({
        method: 'POST',
        url: '/manage/api/login',
        payload: { email: EMAIL, password: 'local-admin-pass-1' },
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().user.role).toBe('admin');

      const bad = await withPass.app.inject({
        method: 'POST',
        url: '/manage/api/login',
        payload: { email: EMAIL, password: 'nope' },
      });
      expect(bad.statusCode).toBe(401);

      const demo = await withPass.app.inject({ method: 'POST', url: '/manage/api/demo-login', payload: {} });
      expect(demo.statusCode).toBe(200);
    } finally {
      await withPass.close();
    }
  });

  it('неверный пароль и неизвестный логин дают одну и ту же ошибку 401', async () => {
    const wrong = await login('admin', 'wrong-password');
    const unknown = await login('ghost', 'wrong-password');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_credentials');
    expect(unknown.json().error.code).toBe('invalid_credentials');
  });

  it('пароль не принимается от аккаунта без роли admin (403)', async () => {
    const { userId } = await loginAs(t, 'plain-user@shelter.local');
    await t.store.userSetPassword(userId, hashPassword('plain-user-password'));
    const res = await login('plain-user@shelter.local', 'plain-user-password');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('admin_only');
  });

  it('сессия панели: /manage/api/session и выход через logout', async () => {
    const res = await demoLogin();
    const cookie = res.cookies.find((c) => c.name === t.env.COOKIE_NAME)!;
    const header = { cookie: `${cookie.name}=${cookie.value}` };

    const session = await t.app.inject({ method: 'GET', url: '/manage/api/session', headers: header });
    expect(session.statusCode).toBe(200);
    expect(session.json().user.role).toBe('admin');

    const out = await t.app.inject({ method: 'POST', url: '/manage/api/logout', headers: header, payload: {} });
    expect(out.statusCode).toBe(200);

    const after = await t.app.inject({ method: 'GET', url: '/manage/api/session', headers: header });
    expect(after.statusCode).toBe(401);
  });

  it('перебор пароля упирается в rate limit (429)', async () => {
    const limited = await createTestApp({ RATE_LIMIT_AUTH_MAX: '3' });
    try {
      for (let i = 0; i < 3; i++) {
        const r = await limited.app.inject({
          method: 'POST',
          url: '/manage/api/login',
          payload: { email: 'admin', password: 'bad' },
        });
        expect(r.statusCode).toBe(401);
      }
      const blocked = await limited.app.inject({
        method: 'POST',
        url: '/manage/api/login',
        payload: { email: 'admin', password: 'bad' },
      });
      expect(blocked.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });

  it('DELETE /me отзывает сессию демо-админа', async () => {
    const res = await demoLogin();
    const cookie = res.cookies.find((c) => c.name === t.env.COOKIE_NAME)!;
    const header = { cookie: `${cookie.name}=${cookie.value}` };
    const del = await t.app.inject({ method: 'DELETE', url: '/api/v1/me', headers: header });
    expect(del.statusCode).toBe(200);
    const after = await t.app.inject({ method: 'GET', url: '/manage/api/session', headers: header });
    expect(after.statusCode).toBe(401);
  });

  it('production: кнопки демо-входа нет, вход только паролем из env', async () => {
    const prod = await createTestApp({
      NODE_ENV: 'production',
      STORE_DRIVER: 'pg',
      PUBLIC_BASE_URL: 'https://shelter.example',
      COOKIE_SECURE: 'true',
      PAYMENT_PROVIDER: 'yookassa',
      YOOKASSA_SHOP_ID: 'shop-test',
      YOOKASSA_SECRET_KEY: 'secret-test',
      DEV_LOGIN_ENABLED: 'false',
      ADMIN_EMAIL: 'ops@shelter.example',
      ADMIN_PASSWORD: 'rotated-secret-password-42',
    });
    try {
      const providers = await prod.app.inject({ method: 'GET', url: '/api/v1/auth/providers' });
      expect(providers.json().adminLogin.demoLogin).toBe(false);

      const demo = await prod.app.inject({ method: 'POST', url: '/manage/api/demo-login', payload: {} });
      expect(demo.statusCode).toBe(403);

      const good = await prod.app.inject({
        method: 'POST',
        url: '/manage/api/login',
        payload: { email: 'ops@shelter.example', password: 'rotated-secret-password-42' },
      });
      expect(good.statusCode).toBe(200);
      expect(good.json().user.role).toBe('admin');
    } finally {
      await prod.close();
    }
  });

  it('production не стартует без ADMIN_PASSWORD (fail-closed конфигурация)', async () => {
    expect(() =>
      testEnv({
        NODE_ENV: 'production',
        STORE_DRIVER: 'pg',
        PUBLIC_BASE_URL: 'https://shelter.example',
        COOKIE_SECURE: 'true',
        PAYMENT_PROVIDER: 'yookassa',
        DEV_LOGIN_ENABLED: 'false',
      }),
    ).toThrow(/ADMIN_PASSWORD is required/);
    expect(() =>
      testEnv({
        NODE_ENV: 'production',
        STORE_DRIVER: 'pg',
        PUBLIC_BASE_URL: 'https://shelter.example',
        COOKIE_SECURE: 'true',
        PAYMENT_PROVIDER: 'yookassa',
        DEV_LOGIN_ENABLED: 'false',
        ADMIN_PASSWORD: 'short-pass',
      }),
    ).toThrow(/12 chars/);
  });
});
