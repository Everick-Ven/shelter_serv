import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { denied, evaluateEntitlement, toPremiumStatusPayload } from '../domain/entitlement.js';
import { CURRENCY, PLAN_IDS, PLANS, formatAmount, getPlan } from '../domain/plans.js';
import { badRequest } from '../http/errors.js';
import { authenticate } from '../plugins/auth.js';
import { publicUser } from './auth.js';

const profilePatch = z.object({
  name: z.string().min(1).max(120).nullish(),
  avatarUrl: z.string().url().max(2048).nullish(),
});

export async function meRoutes(app: FastifyInstance): Promise<void> {
  const { store, env, sessions, subscriptions } = app.deps;

  /** Публичный каталог тарифов для витрины (без авторизации). */
  app.get('/api/v1/plans', async () => ({
    currency: CURRENCY,
    plans: PLAN_IDS.map((id) => {
      const p = PLANS[id];
      return {
        id: p.id,
        title: p.title,
        amountMinor: p.amountMinor,
        amount: formatAmount(p.amountMinor, p.currency),
        currency: p.currency,
        days: p.days,
        badge: p.badge ?? null,
        compareAtMinor: p.compareAtMinor ?? null,
        compareAt: p.compareAtMinor ? formatAmount(p.compareAtMinor, p.currency) : null,
        features: p.features,
      };
    }),
  }));

  app.get('/api/v1/me', { preHandler: [authenticate] }, async (request) => {
    const user = request.currentUser!;
    const stats = await store.orderPaidStatsForUser(user.id);
    const sub = await store.subscriptionGet(user.id);
    return {
      user: publicUser(user),
      subscription: sub
        ? {
            status: sub.status,
            planId: sub.planId,
            startedAt: sub.startedAt,
            expiresAt: sub.expiresAt,
            source: sub.source,
          }
        : { status: 'none', planId: null, startedAt: null, expiresAt: null, source: null },
      // Вычисляется из orders (COUNT / MIN, status='paid'), в subscriptions не дублируется.
      billing: {
        paidOrderCount: stats.count,
        firstPaymentAt: stats.firstPaymentAt,
        lifetimeMinor: stats.lifetimeMinor,
      },
    };
  });

  /**
   * premium.status — ЕДИНСТВЕННЫЙ источник правды о премиуме.
   * Формат ответа заморожен (см. src/contracts.ts).
   */
  app.get('/api/v1/me/subscription', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.currentUser!;
    let snapshot;
    try {
      const row = await store.subscriptionGet(user.id);
      snapshot = row
        ? {
            status: row.status,
            planId: row.planId,
            expiresAt: row.expiresAt,
            source: row.source,
            cancelledAt: row.cancelledAt,
            lastOrderId: row.lastOrderId,
          }
        : null;
    } catch (err) {
      request.log.error({ err, userId: user.id }, 'entitlement read failed -> deny');
      snapshot = undefined; // маркер сбоя проверки
    }

    const now = new Date();
    const result =
      snapshot === undefined
        ? // Fail-closed: сбой проверки = подписка не подтверждена.
          denied('verification_failed', now)
        : evaluateEntitlement({ subscription: snapshot, now });

    if (!result.active) {
      await store.eventInsert('premium.denied', user.id, { reason: result.reason, status: result.status });
    }

    // План в ответе — только из серверного каталога.
    const plan = result.planId ? getPlan(result.planId) : null;
    return reply.send({
      ...toPremiumStatusPayload(result),
      plan: plan
        ? { id: plan.id, title: plan.title, days: plan.days, amountMinor: plan.amountMinor, currency: plan.currency }
        : null,
      renewable: result.renewable,
      secondsRemaining: result.secondsRemaining,
    });
  });

  app.patch('/api/v1/me', { preHandler: [authenticate] }, async (request) => {
    const parsed = profilePatch.safeParse(request.body ?? {});
    if (!parsed.success) throw badRequest('invalid_body', 'Invalid profile payload');
    const user = await store.userUpdateProfile(request.currentUser!.id, {
      name: parsed.data.name ?? undefined,
      avatarUrl: parsed.data.avatarUrl ?? undefined,
    });
    if (!user) throw badRequest('update_failed', 'Unable to update profile');
    return { user: publicUser(user) };
  });

  app.get('/api/v1/me/orders', { preHandler: [authenticate] }, async (request) => {
    const orders = await store.ordersForUser(request.currentUser!.id, 50);
    return {
      orders: orders.map((o) => ({
        id: o.id,
        planId: o.planId,
        amountMinor: o.amountMinor,
        amount: formatAmount(o.amountMinor, o.currency),
        currency: o.currency,
        days: o.days,
        status: o.status,
        provider: o.provider,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        refundedAt: o.refundedAt,
      })),
    };
  });

  app.get('/api/v1/me/sessions', { preHandler: [authenticate] }, async (request) => {
    const rows = await store.sessionsListForUser(request.currentUser!.id);
    return {
      sessions: rows.map((s) => ({
        id: s.id,
        current: s.id === request.currentSessionId,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.expiresAt,
        revokedAt: s.revokedAt,
      })),
    };
  });

  app.post<{ Body: { sessionId?: string } }>(
    '/api/v1/me/sessions/revoke',
    { preHandler: [authenticate] },
    async (request) => {
      const body = z.object({ sessionId: z.string().uuid().optional() }).safeParse(request.body ?? {});
      if (!body.success) throw badRequest('invalid_body', 'Invalid payload');
      if (body.data.sessionId) {
        const rows = await store.sessionsListForUser(request.currentUser!.id);
        const target = rows.find((r) => r.id === body.data.sessionId);
        if (!target) throw badRequest('session_not_found', 'Session not found');
        await sessions.revoke(target.id);
        return { ok: true, revoked: 1 };
      }
      const revoked = await sessions.revokeAllForUser(request.currentUser!.id);
      return { ok: true, revoked };
    },
  );

  /**
   * DELETE /me — удаление/анонимизация пользовательских данных + отзыв всех
   * сессий (TZ). Подписка при этом отзывается: анонимизированный аккаунт
   * не может сохранять платный доступ.
   */
  app.delete('/api/v1/me', { preHandler: [authenticate] }, async (request, reply) => {
    const user = request.currentUser!;
    const revokedSessions = await sessions.revokeAllForUser(user.id);
    await subscriptions.adminRevoke(user.id, 'account_deleted');
    await store.userAnonymize(user.id);
    await store.eventInsert('account.deleted', null, { userId: user.id, revokedSessions });
    reply.clearCookie(env.COOKIE_NAME, { path: '/' });
    request.log.info({ userId: user.id }, 'account anonymized and sessions revoked');
    return reply.code(200).send({ ok: true, deleted: true, revokedSessions });
  });
}
