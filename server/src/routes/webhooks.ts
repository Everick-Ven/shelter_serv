import type { FastifyInstance } from 'fastify';
import { generateOpaqueId } from '../lib/tokens.js';
import { nowUtc } from '../lib/time.js';
import { unauthorized } from '../http/errors.js';
import { rawBodyOf } from '../http/raw-body.js';

/**
 * Приём платёжных уведомлений.
 *
 * Порядок проверок (fail-closed):
 *  1. подлинность уведомления (подпись/авторизация провайдера) — иначе 401;
 *  2. идемпотентность по eventId — повторное событие не продлевает срок второй раз;
 *  3. поиск заказа в БД — неизвестный заказ игнорируется (200, но без изменений);
 *  4. сверка суммы — расхождение означает «доступ не выдаём» + событие в аудите.
 *
 * Доступ выдаёт НЕ уведомление само по себе, а переход заказа в 'paid',
 * после чего entitlement пересчитывается из БД.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  const { store, env, payments, subscriptions } = app.deps;

  app.post(
    '/api/v1/webhooks/payment',
    {
      config: {
        rateLimit: { max: 120, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const rawBody =
        rawBodyOf(request) ??
        (typeof request.body === 'string' ? request.body : JSON.stringify(request.body ?? ''));
      const outcome = await payments.verifyWebhook({ rawBody, headers: request.headers });

      if (!outcome) {
        // Невалидная подпись / нечитаемое тело: платёж НЕ засчитывается.
        request.log.warn({ ip: request.ip }, 'payment webhook rejected: verification failed');
        await store.eventInsert('webhook.rejected', null, { provider: env.PAYMENT_PROVIDER });
        throw unauthorized('webhook_verification_failed', 'Webhook verification failed');
      }

      const provider = payments.name;
      const eventRowId = generateOpaqueId('pev');
      const { inserted } = await store.paymentEventInsert({
        id: eventRowId,
        provider,
        eventId: outcome.eventId,
        orderId: 'orderId' in outcome ? outcome.orderId : null,
        type: outcome.status,
        status: 'processed',
        payload: safeJson(rawBody),
      });

      if (!inserted) {
        request.log.info({ eventId: outcome.eventId }, 'duplicate payment webhook ignored');
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      if (outcome.status === 'ignored') {
        return reply.code(200).send({ ok: true, ignored: true, reason: outcome.reason });
      }

      const order = await resolveOrder(outcome);
      if (!order) {
        request.log.warn({ outcome }, 'payment webhook for unknown order');
        await store.eventInsert('webhook.unknown_order', null, {
          providerPaymentId: 'providerPaymentId' in outcome ? outcome.providerPaymentId : null,
        });
        return reply.code(200).send({ ok: true, ignored: true, reason: 'order_not_found' });
      }

      if (outcome.status === 'paid') {
        const result = await subscriptions.applyPaidOrder(order.id, {
          amountMinor: outcome.amountMinor,
          paidAt: outcome.paidAt ?? nowUtc(),
        });
        if (!result) {
          // Расхождение суммы / неподходящий статус заказа: доступ не выдаём.
          request.log.error({ orderId: order.id, eventId: outcome.eventId }, 'payment not applied (fail-closed)');
          await store.paymentEventInsert({
            id: generateOpaqueId('pev'),
            provider,
            eventId: `${outcome.eventId}:rejected`,
            orderId: order.id,
            type: 'rejected',
            status: 'failed',
            payload: { reason: 'amount_mismatch_or_state' },
          });
          return reply.code(200).send({ ok: false, applied: false, reason: 'amount_mismatch_or_state' });
        }
        request.log.info(
          { orderId: order.id, userId: order.userId, duplicate: result.duplicate },
          'payment applied',
        );
        return reply.code(200).send({ ok: true, applied: !result.duplicate, duplicate: result.duplicate });
      }

      if (outcome.status === 'refunded') {
        await subscriptions.applyRefund(order.id, outcome.refundedAt);
        return reply.code(200).send({ ok: true, refunded: true });
      }

      // status === 'failed'
      await subscriptions.markOrderFailed(order.id, outcome.reason);
      return reply.code(200).send({ ok: true, failed: true });
    },
  );

  async function resolveOrder(outcome: { providerPaymentId?: string; orderId?: string }) {
    if (outcome.orderId) {
      const byId = await store.orderById(outcome.orderId);
      if (byId) return byId;
    }
    if (outcome.providerPaymentId) {
      const byProviderId = await store.orderByProviderPaymentId(outcome.providerPaymentId);
      if (byProviderId) return byProviderId;
    }
    return null;
  }
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
