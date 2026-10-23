import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, notFound } from '../http/errors.js';
import { requireAdmin } from '../plugins/auth.js';
import { PLAN_IDS, formatAmount, getPlan } from '../domain/plans.js';
import { nowUtc } from '../lib/time.js';

const uuid = z.string().min(1).max(64);
const pageQuery = z.object({
  q: z.string().max(200).optional(),
  status: z.string().max(32).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * API панели управления (домен/manage). Доступ только для роли `admin`
 * (роль хранится в БД и не может быть установлена клиентом).
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { store, env, subscriptions } = app.deps;

  app.get('/manage/api/overview', { preHandler: [requireAdmin] }, async () => {
    const metrics = await store.metrics();
    return {
      metrics: {
        ...metrics,
        revenue: formatAmount(metrics.revenueMinor),
        revenueLast30d: formatAmount(metrics.revenueLast30dMinor),
        revenueByPlanFormatted: Object.fromEntries(
          Object.entries(metrics.revenueByPlan).map(([plan, v]) => [
            plan,
            { ...v, revenue: formatAmount(v.revenueMinor) },
          ]),
        ),
      },
      plans: PLAN_IDS.map((id) => ({ id, title: getPlan(id)!.title, amount: formatAmount(getPlan(id)!.amountMinor) })),
      payments: { provider: env.PAYMENT_PROVIDER, mock: env.PAYMENT_PROVIDER === 'mock' },
      updates: { enabled: env.UPDATES_ENABLED, repo: env.GITHUB_REPO },
      supportEmail: env.SUPPORT_EMAIL,
    };
  });

  app.get('/manage/api/users', { preHandler: [requireAdmin] }, async (request) => {
    const q = pageQuery.safeParse(request.query ?? {});
    if (!q.success) throw badRequest('invalid_query', 'Invalid query');
    const { items, total } = await store.usersList({
      q: q.data.q,
      limit: q.data.limit ?? 50,
      offset: q.data.offset ?? 0,
    });
    return {
      total,
      items: items.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        createdAt: u.createdAt,
        lastLoginAt: u.lastLoginAt,
        deletedAt: u.deletedAt,
        providers: u.identities.map((i) => i.provider),
        subscription: u.subscription
          ? {
              status: u.subscription.status,
              planId: u.subscription.planId,
              expiresAt: u.subscription.expiresAt,
              source: u.subscription.source,
            }
          : null,
        paidOrderCount: u.paidOrderCount,
        firstPaymentAt: u.firstPaymentAt,
        lifetime: formatAmount(u.lifetimeMinor),
      })),
    };
  });

  app.get<{ Params: { userId: string } }>(
    '/manage/api/users/:userId',
    { preHandler: [requireAdmin] },
    async (request) => {
      const p = uuid.safeParse(request.params.userId);
      if (!p.success) throw badRequest('invalid_user', 'Invalid user id');
      const user = await store.adminUserView(p.data);
      if (!user) throw notFound('user_not_found', 'User not found');
      const orders = await store.ordersForUser(user.id, 100);
      const sessions = await store.sessionsListForUser(user.id);
      return {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatarUrl,
          role: user.role,
          createdAt: user.createdAt,
          updatedAt: user.updatedAt,
          lastLoginAt: user.lastLoginAt,
          deletedAt: user.deletedAt,
          identities: user.identities,
        },
        subscription: user.subscription,
        billing: {
          // только из orders: COUNT / MIN / SUM при status='paid'
          paidOrderCount: user.paidOrderCount,
          firstPaymentAt: user.firstPaymentAt,
          lifetimeMinor: user.lifetimeMinor,
          lifetime: formatAmount(user.lifetimeMinor),
        },
        orders: orders.map((o) => ({
          id: o.id,
          planId: o.planId,
          amountMinor: o.amountMinor,
          amount: formatAmount(o.amountMinor, o.currency),
          currency: o.currency,
          days: o.days,
          status: o.status,
          provider: o.provider,
          providerPaymentId: o.providerPaymentId,
          createdAt: o.createdAt,
          paidAt: o.paidAt,
          refundedAt: o.refundedAt,
        })),
        sessions: sessions.map((s) => ({
          id: s.id,
          userAgent: s.userAgent,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          expiresAt: s.expiresAt,
          revokedAt: s.revokedAt,
        })),
      };
    },
  );

  app.patch<{ Params: { userId: string }; Body: unknown }>(
    '/manage/api/users/:userId',
    { preHandler: [requireAdmin] },
    async (request) => {
      const p = uuid.safeParse(request.params.userId);
      if (!p.success) throw badRequest('invalid_user', 'Invalid user id');
      const body = z.object({ role: z.enum(['user', 'admin']) }).safeParse(request.body ?? {});
      if (!body.success) throw badRequest('invalid_body', 'Invalid payload');
      const user = await store.userSetRole(p.data, body.data.role);
      if (!user) throw notFound('user_not_found', 'User not found');
      await store.eventInsert('admin.role_changed', request.currentUser!.id, {
        targetUserId: user.id,
        role: body.data.role,
      });
      return { ok: true, user: { id: user.id, role: user.role } };
    },
  );

  /** Ручной grant подписки (источник — admin_grant, оплатой не считается). */
  app.post<{ Params: { userId: string }; Body: unknown }>(
    '/manage/api/users/:userId/subscription/grant',
    { preHandler: [requireAdmin] },
    async (request) => {
      const p = uuid.safeParse(request.params.userId);
      if (!p.success) throw badRequest('invalid_user', 'Invalid user id');
      const body = z
        .object({ planId: z.string().min(1), days: z.coerce.number().int().min(1).max(3650).optional(), note: z.string().max(500).optional() })
        .safeParse(request.body ?? {});
      if (!body.success) throw badRequest('invalid_body', 'Invalid payload');
      const plan = getPlan(body.data.planId);
      if (!plan) throw badRequest('invalid_plan', `Unknown planId: ${body.data.planId}`);
      const existing = await store.userById(p.data);
      if (!existing) throw notFound('user_not_found', 'User not found');

      const sub = await subscriptions.adminGrant(p.data, plan.id, body.data.days ?? plan.days, body.data.note);
      await store.eventInsert('admin.subscription_granted', request.currentUser!.id, {
        targetUserId: p.data,
        planId: plan.id,
        note: body.data.note ?? null,
      });
      return { ok: true, subscription: sub };
    },
  );

  app.post<{ Params: { userId: string }; Body: unknown }>(
    '/manage/api/users/:userId/subscription/revoke',
    { preHandler: [requireAdmin] },
    async (request) => {
      const p = uuid.safeParse(request.params.userId);
      if (!p.success) throw badRequest('invalid_user', 'Invalid user id');
      const body = z.object({ note: z.string().max(500).optional() }).safeParse(request.body ?? {});
      if (!body.success) throw badRequest('invalid_body', 'Invalid payload');
      const existing = await store.userById(p.data);
      if (!existing) throw notFound('user_not_found', 'User not found');
      const sub = await subscriptions.adminRevoke(p.data, body.data.note);
      await store.eventInsert('admin.subscription_revoked', request.currentUser!.id, {
        targetUserId: p.data,
        note: body.data.note ?? null,
      });
      return { ok: true, subscription: sub };
    },
  );

  app.get('/manage/api/orders', { preHandler: [requireAdmin] }, async (request) => {
    const q = pageQuery.safeParse(request.query ?? {});
    if (!q.success) throw badRequest('invalid_query', 'Invalid query');
    const { items, total } = await store.ordersList({
      status: q.data.status,
      limit: q.data.limit ?? 50,
      offset: q.data.offset ?? 0,
    });
    return {
      total,
      items: items.map((o) => ({
        id: o.id,
        userId: o.userId,
        userEmail: o.userEmail,
        userName: o.userName,
        planId: o.planId,
        amountMinor: o.amountMinor,
        amount: formatAmount(o.amountMinor, o.currency),
        currency: o.currency,
        days: o.days,
        status: o.status,
        provider: o.provider,
        providerPaymentId: o.providerPaymentId,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        refundedAt: o.refundedAt,
      })),
    };
  });

  /** Ручной возврат: подписка переходит в refunded, доступ закрывается. */
  app.post<{ Params: { orderId: string }; Body: unknown }>(
    '/manage/api/orders/:orderId/refund',
    { preHandler: [requireAdmin] },
    async (request) => {
      const id = z.string().min(1).max(128).safeParse(request.params.orderId);
      if (!id.success) throw badRequest('invalid_order', 'Invalid order id');
      const order = await store.orderById(id.data);
      if (!order) throw notFound('order_not_found', 'Order not found');
      const result = await subscriptions.applyRefund(order.id, nowUtc());
      await store.eventInsert('admin.refund', request.currentUser!.id, { orderId: order.id });
      return { ok: result.ok, subscription: result.subscription };
    },
  );

  app.get('/manage/api/payments/events', { preHandler: [requireAdmin] }, async () => {
    const events = await store.paymentEventsList(100);
    return { items: events };
  });

  app.get('/manage/api/events', { preHandler: [requireAdmin] }, async () => {
    const metrics = await store.metrics();
    return { eventsByType7d: metrics.eventsByType7d };
  });

  app.get('/manage/api/health', { preHandler: [requireAdmin] }, async () => ({
    ok: true,
    store: store.kind,
    node: process.version,
    uptime: process.uptime(),
    time: new Date().toISOString(),
  }));
}
