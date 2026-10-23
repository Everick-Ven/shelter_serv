import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryStore, type MemoryStore } from '../../src/db/memory.js';
import { SubscriptionService } from '../../src/services/subscriptions.js';
import { generateOpaqueId } from '../../src/lib/tokens.js';
import { addDays, nowUtc } from '../../src/lib/time.js';
import { evaluateEntitlement } from '../../src/domain/entitlement.js';
import { PLANS, type PlanId } from '../../src/domain/plans.js';

let store: MemoryStore;
let service: SubscriptionService;
let userId: string;

async function createOrder(
  opts: { planId?: PlanId; amountMinor?: number; owner?: string } = {},
): Promise<string> {
  const plan = PLANS[opts.planId ?? 'monthly'];
  const id = generateOpaqueId('ord');
  await store.orderCreate({
    id,
    userId: opts.owner ?? userId,
    planId: plan.id,
    amountMinor: opts.amountMinor ?? plan.amountMinor,
    currency: plan.currency,
    days: plan.days,
    provider: 'mock',
    idempotencyKey: `key_${id}`,
    expiresAt: addDays(nowUtc(), 1),
  });
  return id;
}

beforeEach(async () => {
  store = createMemoryStore();
  service = new SubscriptionService(store);
  const user = await store.userCreate({ email: 'user@shelter.test', name: 'User', avatarUrl: null });
  userId = user.id;
  await store.subscriptionUpsert(userId, { status: 'none' });
});

describe('SubscriptionService — применение оплаты', () => {
  it('оплаченный заказ активирует подписку на срок тарифа (30 дней)', async () => {
    const orderId = await createOrder();
    const result = await service.applyPaidOrder(orderId, { amountMinor: PLANS.monthly.amountMinor });

    expect(result).not.toBeNull();
    expect(result!.applied).toBe(true);
    expect(result!.duplicate).toBe(false);
    expect(result!.subscription.status).toBe('active');
    expect(result!.subscription.planId).toBe('monthly');
    expect(result!.subscription.source).toBe('payment');
    expect((await store.orderById(orderId))!.status).toBe('paid');

    const expected = addDays(nowUtc(), 30);
    expect(Math.abs(new Date(result!.subscription.expiresAt!).getTime() - expected.getTime())).toBeLessThan(5_000);

    const entitlement = evaluateEntitlement({ subscription: result!.subscription, now: nowUtc() });
    expect(entitlement.active).toBe(true);
    expect(entitlement.reason).toBe('paid');
  });

  it('годовой тариф даёт 365 дней', async () => {
    const orderId = await createOrder({ planId: 'yearly' });
    const result = await service.applyPaidOrder(orderId, { amountMinor: PLANS.yearly.amountMinor });
    const days = (new Date(result!.subscription.expiresAt!).getTime() - nowUtc().getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(365);
  });

  it('повторное уведомление по тому же заказу не продлевает срок (идемпотентность)', async () => {
    const orderId = await createOrder();
    const first = await service.applyPaidOrder(orderId, { amountMinor: PLANS.monthly.amountMinor });
    const expiresAfterFirst = first!.subscription.expiresAt;

    const second = await service.applyPaidOrder(orderId, { amountMinor: PLANS.monthly.amountMinor });
    expect(second!.duplicate).toBe(true);
    expect(second!.applied).toBe(false);
    expect(second!.subscription.expiresAt).toBe(expiresAfterFirst);
  });

  it('расхождение суммы = доступ не выдаётся (fail-closed)', async () => {
    const orderId = await createOrder();
    const result = await service.applyPaidOrder(orderId, { amountMinor: 1 });
    expect(result).toBeNull();

    const sub = await store.subscriptionGet(userId);
    expect(sub!.status).not.toBe('active');
    expect((await store.orderById(orderId))!.status).not.toBe('paid');
    expect(evaluateEntitlement({ subscription: sub!, now: nowUtc() }).active).toBe(false);
  });

  it('продление активной подписки считается от её окончания — дни не сгорают', async () => {
    await service.applyPaidOrder(await createOrder(), { amountMinor: PLANS.monthly.amountMinor });
    const afterFirst = new Date((await store.subscriptionGet(userId))!.expiresAt!);

    await service.applyPaidOrder(await createOrder(), { amountMinor: PLANS.monthly.amountMinor });
    const afterSecond = new Date((await store.subscriptionGet(userId))!.expiresAt!);

    expect(Math.round((afterSecond.getTime() - afterFirst.getTime()) / 86_400_000)).toBe(30);
  });

  it('продление после истечения считается от текущего момента', async () => {
    await store.subscriptionUpsert(userId, {
      status: 'expired',
      planId: 'monthly',
      expiresAt: addDays(nowUtc(), -5),
      source: 'payment',
    });
    const result = await service.applyPaidOrder(await createOrder(), {
      amountMinor: PLANS.monthly.amountMinor,
    });
    expect(Math.round((new Date(result!.subscription.expiresAt!).getTime() - nowUtc().getTime()) / 86_400_000)).toBe(30);
  });

  it('возврат закрывает доступ немедленно', async () => {
    const orderId = await createOrder();
    await service.applyPaidOrder(orderId, { amountMinor: PLANS.monthly.amountMinor });
    expect((await service.getForUser(userId))!.status).toBe('active');

    const refund = await service.applyRefund(orderId);
    expect(refund.ok).toBe(true);
    expect(evaluateEntitlement({ subscription: refund.subscription, now: nowUtc() }).active).toBe(false);
    expect(refund.subscription!.status).toBe('refunded');
    expect((await store.orderById(orderId))!.status).toBe('refunded');
  });

  it('повторный возврат идемпотентен', async () => {
    const orderId = await createOrder();
    await service.applyPaidOrder(orderId, { amountMinor: PLANS.monthly.amountMinor });
    await service.applyRefund(orderId);
    const second = await service.applyRefund(orderId);
    expect(second.ok).toBe(true);
    expect(second.subscription!.status).toBe('refunded');
  });

  it('неизвестный заказ игнорируется', async () => {
    expect(await service.applyPaidOrder('ord_does_not_exist', {})).toBeNull();
    expect((await service.applyRefund('ord_does_not_exist')).ok).toBe(false);
  });

  it('нельзя применить уже закрытый заказ', async () => {
    const orderId = await createOrder();
    await store.orderSetStatus(orderId, 'expired');
    expect(await service.applyPaidOrder(orderId, { amountMinor: PLANS.monthly.amountMinor })).toBeNull();
  });
});

describe('SubscriptionService — административные действия', () => {
  it('grant помечается источником admin_grant и не считается оплатой', async () => {
    const sub = await service.adminGrant(userId, 'monthly', 30, 'compensation');
    expect(sub.status).toBe('active');
    expect(sub.source).toBe('admin_grant');

    const entitlement = evaluateEntitlement({ subscription: sub, now: nowUtc() });
    expect(entitlement.active).toBe(true);
    expect(entitlement.reason).toBe('granted');

    const stats = await store.orderPaidStatsForUser(userId);
    expect(stats.count).toBe(0);
    expect(stats.firstPaymentAt).toBeNull();
    expect(stats.lifetimeMinor).toBe(0);
  });

  it('отзыв закрывает доступ', async () => {
    await service.adminGrant(userId, 'monthly', 30);
    const revoked = await service.adminRevoke(userId, 'abuse');
    expect(revoked.status).toBe('revoked');
    expect(evaluateEntitlement({ subscription: revoked, now: nowUtc() }).active).toBe(false);
  });
});

describe('paid_order_count / first_payment_at — только из orders', () => {
  it('считаются через COUNT/MIN/SUM по status=paid', async () => {
    await service.applyPaidOrder(await createOrder(), { amountMinor: PLANS.monthly.amountMinor });
    await service.applyPaidOrder(await createOrder({ planId: 'yearly' }), {
      amountMinor: PLANS.yearly.amountMinor,
    });
    await createOrder(); // не оплачен — не учитывается

    const stats = await store.orderPaidStatsForUser(userId);
    expect(stats.count).toBe(2);
    expect(stats.lifetimeMinor).toBe(PLANS.monthly.amountMinor + PLANS.yearly.amountMinor);
    expect(stats.firstPaymentAt).not.toBeNull();
  });

  it('в подписке этих полей нет', async () => {
    await service.applyPaidOrder(await createOrder(), { amountMinor: PLANS.monthly.amountMinor });
    const sub = await store.subscriptionGet(userId);
    expect(sub).not.toBeNull();
    expect(Object.keys(sub!)).not.toContain('paidOrderCount');
    expect(Object.keys(sub!)).not.toContain('paid_order_count');
    expect(Object.keys(sub!)).not.toContain('firstPaymentAt');
  });
});
