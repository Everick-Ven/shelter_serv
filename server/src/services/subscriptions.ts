import type { Store, OrderRow, SubscriptionRow } from '../db/types.js';
import { extendExpiry, iso, nowUtc } from '../lib/time.js';
import { getPlan } from '../domain/plans.js';

export interface ApplyPaidResult {
  order: OrderRow;
  subscription: SubscriptionRow;
  /** true, если подписка была продлена этим платежом впервые/повторно. */
  applied: boolean;
  /** true, если событие уже обрабатывалось (идемпотентность). */
  duplicate: boolean;
}

/**
 * Применение оплаченного заказа к подписке.
 *
 * Инварианты:
 *  - срок берётся из серверного каталога тарифов (не из webhook'а);
 *  - сумма из webhook'а сверяется с суммой заказа: расхождение => отказ;
 *  - повторная оплата того же заказа не продлевает срок дважды
 *    (order.status уже 'paid' => duplicate);
 *  - продление идёт от текущего expires_at, если подписка ещё активна
 *    (дни не сгорают).
 */
export class SubscriptionService {
  constructor(private readonly store: Store) {}

  async getForUser(userId: string): Promise<SubscriptionRow | null> {
    return this.store.subscriptionGet(userId);
  }

  async applyPaidOrder(orderId: string, opts: { amountMinor?: number; paidAt?: Date }): Promise<ApplyPaidResult | null> {
    const order = await this.store.orderById(orderId);
    if (!order) return null;

    // Идемпотентность: уже оплачен — не продлеваем повторно.
    if (order.status === 'paid') {
      const existing = await this.store.subscriptionGet(order.userId);
      return { order, subscription: existing as SubscriptionRow, applied: false, duplicate: true };
    }
    if (order.status === 'refunded' || order.status === 'expired' || order.status === 'failed') {
      return null;
    }

    // Контроль суммы: клиент/провайдер не может заплатить «меньше и получить то же».
    if (opts.amountMinor !== undefined && opts.amountMinor !== order.amountMinor) {
      await this.store.eventInsert('payment.amount_mismatch', order.userId, {
        orderId: order.id,
        expected: order.amountMinor,
        received: opts.amountMinor,
      });
      return null;
    }

    const plan = getPlan(order.planId);
    const days = plan?.days ?? order.days;
    const now = nowUtc();
    const paidAt = opts.paidAt ?? now;

    const current = await this.store.subscriptionGet(order.userId);
    // Продлеваем от окончания активной подписки, иначе — от момента оплаты.
    const base =
      current?.status === 'active' && current.expiresAt && new Date(current.expiresAt) > now
        ? new Date(current.expiresAt)
        : now;
    const expiresAt = extendExpiry(base, days, now);

    const updatedOrder = (await this.store.orderSetStatus(order.id, 'paid', {
      paidAt,
      providerPaymentId: order.providerPaymentId,
    })) as OrderRow;

    const subscription = await this.store.subscriptionUpsert(order.userId, {
      status: 'active',
      planId: order.planId,
      startedAt: current?.startedAt ? new Date(current.startedAt) : paidAt,
      expiresAt,
      cancelledAt: null,
      source: 'payment',
      lastOrderId: order.id,
    });

    await this.store.eventInsert('subscription.activated', order.userId, {
      planId: order.planId,
      expiresAt: iso(expiresAt),
      orderId: order.id,
      amountMinor: order.amountMinor,
    });

    return { order: updatedOrder, subscription, applied: true, duplicate: false };
  }

  async applyRefund(orderId: string, refundedAt?: Date): Promise<{ ok: boolean; subscription: SubscriptionRow | null }> {
    const order = await this.store.orderById(orderId);
    if (!order) return { ok: false, subscription: null };
    if (order.status === 'refunded') {
      return { ok: true, subscription: await this.store.subscriptionGet(order.userId) };
    }
    await this.store.orderSetStatus(order.id, 'refunded', { refundedAt: refundedAt ?? nowUtc() });

    // Подписка остаётся активной до уже оплаченного expires_at, но помечается
    // как refunded-source; доступ по ней закрывается немедленно (fail-closed),
    // потому что деньги возвращены.
    const subscription = await this.store.subscriptionUpsert(order.userId, {
      status: 'refunded',
      planId: order.planId,
      cancelledAt: refundedAt ?? nowUtc(),
      source: 'payment',
      lastOrderId: order.id,
    });
    await this.store.eventInsert('subscription.refunded', order.userId, { orderId: order.id });
    return { ok: true, subscription };
  }

  async markOrderFailed(orderId: string, reason?: string): Promise<OrderRow | null> {
    const order = await this.store.orderById(orderId);
    if (!order || order.status === 'paid') return order;
    const updated = await this.store.orderSetStatus(order.id, 'failed');
    await this.store.eventInsert('order.failed', order.userId, { orderId, reason: reason ?? null });
    return updated;
  }

  /** Административный grant/отзыв (не является оплатой, источник — admin_grant). */
  async adminGrant(userId: string, planId: string, days: number, note?: string): Promise<SubscriptionRow> {
    const plan = getPlan(planId);
    const now = nowUtc();
    const current = await this.store.subscriptionGet(userId);
    const expiresAt = extendExpiry(current?.status === 'active' ? current.expiresAt : null, plan?.days ?? days, now);
    const sub = await this.store.subscriptionUpsert(userId, {
      status: 'active',
      planId: plan?.id ?? planId,
      startedAt: now,
      expiresAt,
      cancelledAt: null,
      source: 'admin_grant',
    });
    await this.store.eventInsert('subscription.granted', userId, { planId, days, note: note ?? null });
    return sub;
  }

  async adminRevoke(userId: string, note?: string): Promise<SubscriptionRow> {
    const sub = await this.store.subscriptionUpsert(userId, {
      status: 'revoked',
      cancelledAt: nowUtc(),
    });
    await this.store.eventInsert('subscription.revoked', userId, { note: note ?? null });
    return sub;
  }
}
