import type { FastifyInstance } from 'fastify';
import { baseUrl } from '../config.js';
import { CheckoutRequest } from '../contracts.js';
import { evaluateEntitlement, toPremiumStatusPayload } from '../domain/entitlement.js';
import { formatAmount, getPlan } from '../domain/plans.js';
import { badRequest, conflict, forbidden, notFound } from '../http/errors.js';
import { addSeconds, nowUtc } from '../lib/time.js';
import { generateOpaqueId } from '../lib/tokens.js';
import { authenticate } from '../plugins/auth.js';
import { PaymentError } from '../providers/payments/types.js';
import type { OrderRow } from '../db/types.js';

export async function checkoutRoutes(app: FastifyInstance): Promise<void> {
  const { store, env, payments, subscriptions } = app.deps;

  /**
   * premium.checkout — создание заказа и выдача ссылки на оплату.
   *
   * Сумма, валюта и срок берутся ТОЛЬКО из серверного каталога тарифов:
   * клиент передаёт лишь `planId`, который валидируется по каталогу.
   */
  app.post<{ Body: unknown }>(
    '/api/v1/checkout',
    {
      preHandler: [authenticate],
      config: {
        rateLimit: { max: env.RATE_LIMIT_CHECKOUT_MAX, timeWindow: env.RATE_LIMIT_CHECKOUT_WINDOW },
      },
    },
    async (request, reply) => {
      const parsed = CheckoutRequest.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw badRequest('invalid_body', 'Invalid checkout payload', parsed.error.flatten());
      }
      const plan = getPlan(parsed.data.planId);
      if (!plan) throw badRequest('invalid_plan', `Unknown planId: ${parsed.data.planId}`);

      const user = request.currentUser!;
      const clientSuccessUrl = parsed.data.successUrl ?? null;
      const clientCancelUrl = parsed.data.cancelUrl ?? null;
      const idempotencyKey = parsed.data.idempotencyKey ?? null;
      const existing = idempotencyKey ? await store.orderByIdempotencyKey(idempotencyKey) : null;

      if (existing) {
        if (existing.userId !== user.id && user.role !== 'admin') {
          throw conflict('idempotency_conflict', 'Idempotency key is already used');
        }
        if (existing.status === 'paid') {
          throw conflict('order_already_paid', 'Order is already paid');
        }
        if (existing.status === 'refunded') {
          throw conflict('order_refunded', 'Order was refunded; use a new idempotency key');
        }
        const notExpired = !existing.expiresAt || new Date(existing.expiresAt).getTime() > Date.now();
        if ((existing.status === 'created' || existing.status === 'pending') && existing.checkoutUrl && notExpired) {
          return reply.code(200).send(orderToCheckoutResponse(existing));
        }
        // Просрочен/отклонён — переиспользуем тот же заказ, чтобы не плодить дубли.
        const refreshed = await refreshCheckout(existing, plan.id);
        return reply.code(200).send(orderToCheckoutResponse(refreshed));
      }

      const created = await createOrder(user.id, plan.id, idempotencyKey);
      return reply.code(201).send(orderToCheckoutResponse(created));

      // ------------------------------------------------------------------

      async function createOrder(userId: string, planId: string, key: string | null): Promise<OrderRow> {
        const p = getPlan(planId)!;
        const orderId = generateOpaqueId('ord');
        const expiresAt = addSeconds(nowUtc(), env.ORDER_TTL_SECONDS);
        const returnUrl = `${baseUrl(env)}/checkout/success?order=${encodeURIComponent(orderId)}`;
        const cancelUrl = `${baseUrl(env)}/pricing?cancelled=1`;

        const checkout = await createProviderCheckout(orderId, p, returnUrl, cancelUrl, key, userId);

        const order = await store.orderCreate({
          id: orderId,
          userId,
          planId: p.id,
          amountMinor: p.amountMinor,
          currency: p.currency,
          days: p.days,
          provider: checkout.provider,
          idempotencyKey: key,
          checkoutUrl: checkout.checkoutUrl,
          expiresAt,
          metadata: { providerPaymentId: checkout.providerPaymentId, ...(checkout.raw ?? {}) },
        });
        await store.orderSetStatus(order.id, 'pending', { providerPaymentId: checkout.providerPaymentId });
        await store.eventInsert('checkout.created', userId, {
          orderId,
          planId: p.id,
          amountMinor: p.amountMinor,
        });
        return (await store.orderById(order.id)) ?? order;
      }

      async function refreshCheckout(order: OrderRow, planId: string): Promise<OrderRow> {
        const p = getPlan(planId)!;
        const expiresAt = addSeconds(nowUtc(), env.ORDER_TTL_SECONDS);
        const returnUrl = `${baseUrl(env)}/checkout/success?order=${encodeURIComponent(order.id)}`;
        const cancelUrl = `${baseUrl(env)}/pricing?cancelled=1`;
        const checkout = await createProviderCheckout(
          order.id,
          p,
          returnUrl,
          cancelUrl,
          order.idempotencyKey,
          order.userId,
        );
        const updated = await store.orderSetStatus(order.id, 'pending', {
          providerPaymentId: checkout.providerPaymentId,
          checkoutUrl: checkout.checkoutUrl,
          expiresAt,
          metadata: { providerPaymentId: checkout.providerPaymentId, ...(checkout.raw ?? {}) },
        });
        await store.eventInsert('checkout.refreshed', order.userId, { orderId: order.id });
        return updated ?? { ...order, expiresAt: expiresAt.toISOString(), checkoutUrl: checkout.checkoutUrl };
      }

      async function createProviderCheckout(
        orderId: string,
        p: NonNullable<ReturnType<typeof getPlan>>,
        returnUrl: string,
        cancelUrl: string,
        key: string | null,
        userId: string,
      ) {
        try {
          return await payments.createCheckout({
            orderId,
            amountMinor: p.amountMinor,
            currency: p.currency,
            description: `SHELTER Premium — ${p.title} (${p.days} дн.)`,
            idempotencyKey: key ?? orderId,
            returnUrl: clientSuccessUrl ?? returnUrl,
            cancelUrl: clientCancelUrl ?? cancelUrl,
            metadata: { userId, planId: p.id },
          });
        } catch (err) {
          if (err instanceof PaymentError) {
            request.log.error({ err, orderId }, 'checkout creation failed');
            await store.eventInsert('checkout.failed', userId, { orderId, code: err.code });
          }
          throw err;
        }
      }
    },
  );

  /** Статус заказа — для витрины и опроса после возврата со страницы оплаты. */
  app.get<{ Params: { orderId: string } }>(
    '/api/v1/checkout/:orderId',
    { preHandler: [authenticate] },
    async (request) => {
      const order = await store.orderById(request.params.orderId);
      if (!order) throw notFound('order_not_found', 'Order not found');
      if (order.userId !== request.currentUser!.id && request.currentUser!.role !== 'admin') {
        // Не раскрываем сам факт существования чужого заказа.
        throw notFound('order_not_found', 'Order not found');
      }
      const row = await store.subscriptionGet(order.userId);
      const entitlement = evaluateEntitlement({
        subscription: row
          ? { status: row.status, planId: row.planId, expiresAt: row.expiresAt, source: row.source }
          : null,
        now: nowUtc(),
      });
      return {
        order: {
          id: order.id,
          planId: order.planId,
          amountMinor: order.amountMinor,
          amount: formatAmount(order.amountMinor, order.currency),
          currency: order.currency,
          status: order.status,
          createdAt: order.createdAt,
          paidAt: order.paidAt,
        },
        subscription: toPremiumStatusPayload(entitlement),
      };
    },
  );

  /**
   * MOCK-оплата — ТОЛЬКО локальная разработка (PAYMENT_PROVIDER=mock и
   * NODE_ENV != production). В production маршрут не регистрируется, а
   * конфигурация с mock-провайдером в production вообще не стартует.
   */
  if (env.PAYMENT_PROVIDER === 'mock' && env.NODE_ENV !== 'production') {
    app.post<{ Params: { orderId: string } }>(
      '/api/v1/mock/payments/:orderId/succeed',
      { preHandler: [authenticate] },
      async (request) => {
        const order = await store.orderById(request.params.orderId);
        if (!order) throw notFound('order_not_found', 'Order not found');
        if (order.userId !== request.currentUser!.id) throw forbidden('forbidden', 'Not your order');
        const result = await subscriptions.applyPaidOrder(order.id, {
          amountMinor: order.amountMinor,
          paidAt: nowUtc(),
        });
        if (!result) throw badRequest('apply_failed', 'Unable to apply payment');
        return { ok: true, duplicate: result.duplicate, status: result.order.status };
      },
    );
  }

  function orderToCheckoutResponse(order: OrderRow) {
    return {
      orderId: order.id,
      planId: order.planId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      days: order.days,
      provider: order.provider,
      checkoutUrl: order.checkoutUrl ?? '',
      status: order.status,
      expiresAt: order.expiresAt,
    };
  }
}
