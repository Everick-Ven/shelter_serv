import { hashToken } from '../lib/tokens.js';
import type {
  AdminOrderRow,
  AdminUserRow,
  EventRow,
  MetricsRow,
  OAuthProvider,
  OrderRow,
  OrderStatus,
  PaymentEventRow,
  ReleaseChannel,
  ReleaseRow,
  SessionRow,
  Store,
  SubscriptionRow,
  UserIdentityRow,
  UserRole,
  UserRow,
} from './types.js';

/**
 * In-memory реализация Store — для unit-тестов и локальной отладки без БД.
 * Поведение намеренно повторяет SQL-семантику (включая вычисление
 * paid_order_count / first_payment_at из orders).
 */

const iso = (d: Date | string | null | undefined): string | null =>
  !d ? null : d instanceof Date ? d.toISOString() : new Date(d).toISOString();

interface MemUser extends UserRow {}

export class MemoryStore implements Store {
  readonly kind = 'memory' as const;

  private users = new Map<string, MemUser>();
  private identities = new Map<string, UserIdentityRow>(); // `${provider}:${providerUserId}`
  private sessions = new Map<string, SessionRow>();
  private subscriptions = new Map<string, SubscriptionRow>();
  private orders = new Map<string, OrderRow>();
  private idempotency = new Map<string, string>();
  private paymentEvents = new Map<string, PaymentEventRow>(); // `${provider}:${eventId}`
  private releases = new Map<string, ReleaseRow>(); // tagName
  private events: EventRow[] = [];
  private settings = new Map<string, string>();

  async close(): Promise<void> {
    /* no-op */
  }

  async settingsGet(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async settingsSet(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }

  async userCreate(input: {
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    role?: UserRole;
  }): Promise<UserRow> {
    const now = new Date().toISOString();
    const user: MemUser = {
      id: `usr_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
      email: input.email,
      name: input.name,
      avatarUrl: input.avatarUrl,
      role: input.role ?? 'user',
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
    };
    this.users.set(user.id, user);
    return { ...user };
  }

  async userById(id: string): Promise<UserRow | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  async userByEmail(email: string): Promise<UserRow | null> {
    const needle = email.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.email && u.email.toLowerCase() === needle) return { ...u };
    }
    return null;
  }

  async userUpdateProfile(
    id: string,
    patch: { email?: string | null; name?: string | null; avatarUrl?: string | null },
  ): Promise<UserRow | null> {
    const u = this.users.get(id);
    if (!u) return null;
    if (patch.email !== undefined) u.email = patch.email;
    if (patch.name !== undefined) u.name = patch.name;
    if (patch.avatarUrl !== undefined) u.avatarUrl = patch.avatarUrl;
    u.updatedAt = new Date().toISOString();
    return { ...u };
  }

  async userTouchLogin(id: string, at: Date = new Date()): Promise<void> {
    const u = this.users.get(id);
    if (u) u.lastLoginAt = at.toISOString();
  }

  async userAnonymize(id: string, at: Date = new Date()): Promise<void> {
    const u = this.users.get(id);
    if (!u) return;
    u.email = null;
    u.name = null;
    u.avatarUrl = null;
    u.deletedAt = at.toISOString();
    u.updatedAt = at.toISOString();
    for (const [key, identity] of [...this.identities.entries()]) {
      if (identity.userId === id) {
        this.identities.delete(key);
      }
    }
  }

  private async toAdminUser(u: MemUser): Promise<AdminUserRow> {
    const identities = [...this.identities.values()]
      .filter((i) => i.userId === u.id)
      .map((i) => ({ provider: i.provider, email: i.email }));
    const stats = await this.orderPaidStatsForUser(u.id);
    return {
      ...u,
      identities,
      subscription: this.subscriptions.get(u.id) ? { ...(this.subscriptions.get(u.id) as SubscriptionRow) } : null,
      paidOrderCount: stats.count,
      firstPaymentAt: stats.firstPaymentAt,
      lifetimeMinor: stats.lifetimeMinor,
    };
  }

  async usersList(opts: { q?: string; limit?: number; offset?: number }): Promise<{ items: AdminUserRow[]; total: number }> {
    const q = opts.q?.trim().toLowerCase();
    let all = [...this.users.values()];
    if (q) {
      all = all.filter(
        (u) =>
          (u.email && u.email.toLowerCase().includes(q)) ||
          (u.name && u.name.toLowerCase().includes(q)) ||
          u.id.toLowerCase().includes(q),
      );
    }
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = all.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const items = await Promise.all(all.slice(offset, offset + limit).map((u) => this.toAdminUser(u)));
    return { items, total };
  }

  async userSetRole(id: string, role: UserRole): Promise<UserRow | null> {
    const u = this.users.get(id);
    if (!u) return null;
    u.role = role;
    u.updatedAt = new Date().toISOString();
    return { ...u };
  }

  async adminUserView(id: string): Promise<AdminUserRow | null> {
    const u = this.users.get(id);
    return u ? this.toAdminUser(u) : null;
  }

  async identityUpsert(input: {
    userId: string;
    provider: OAuthProvider;
    providerUserId: string;
    email: string | null;
  }): Promise<void> {
    const key = `${input.provider}:${input.providerUserId}`;
    const existing = this.identities.get(key);
    this.identities.set(key, {
      userId: existing?.userId ?? input.userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
      email: input.email,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    });
  }

  async identityFind(provider: OAuthProvider, providerUserId: string): Promise<UserIdentityRow | null> {
    return this.identities.get(`${provider}:${providerUserId}`) ?? null;
  }

  async identitiesByUser(userId: string): Promise<UserIdentityRow[]> {
    return [...this.identities.values()].filter((i) => i.userId === userId);
  }

  async sessionCreate(input: {
    userId: string;
    tokenHash: string;
    userAgent?: string | null;
    ipHash?: string | null;
    expiresAt: Date;
  }): Promise<SessionRow> {
    const now = new Date().toISOString();
    const row: SessionRow = {
      id: `ses_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
      userId: input.userId,
      tokenHash: input.tokenHash,
      userAgent: input.userAgent ?? null,
      ipHash: input.ipHash ?? null,
      createdAt: now,
      expiresAt: input.expiresAt.toISOString(),
      revokedAt: null,
      lastSeenAt: now,
    };
    this.sessions.set(row.tokenHash, row);
    return { ...row };
  }

  async sessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const s = this.sessions.get(tokenHash);
    return s ? { ...s } : null;
  }

  async sessionTouch(id: string, expiresAt: Date, at: Date = new Date()): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.id === id) {
        s.lastSeenAt = at.toISOString();
        s.expiresAt = expiresAt.toISOString();
        return;
      }
    }
  }

  async sessionRevoke(id: string, at: Date = new Date()): Promise<void> {
    for (const s of this.sessions.values()) {
      if (s.id === id) {
        s.revokedAt = at.toISOString();
        return;
      }
    }
  }

  async sessionsRevokeForUser(userId: string, at: Date = new Date()): Promise<number> {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.userId === userId && !s.revokedAt) {
        s.revokedAt = at.toISOString();
        n++;
      }
    }
    return n;
  }

  async sessionsListForUser(userId: string): Promise<SessionRow[]> {
    return [...this.sessions.values()].filter((s) => s.userId === userId).map((s) => ({ ...s }));
  }

  async subscriptionGet(userId: string): Promise<SubscriptionRow | null> {
    const s = this.subscriptions.get(userId);
    return s ? { ...s } : null;
  }

  async subscriptionUpsert(
    userId: string,
    patch: {
      status: string;
      planId?: string | null;
      startedAt?: Date | null;
      expiresAt?: Date | null;
      cancelledAt?: Date | null;
      source?: 'payment' | 'admin_grant' | null;
      lastOrderId?: string | null;
    },
  ): Promise<SubscriptionRow> {
    const existing = this.subscriptions.get(userId);
    const row: SubscriptionRow = {
      userId,
      status: patch.status,
      planId: patch.planId !== undefined ? patch.planId : (existing?.planId ?? null),
      startedAt:
        patch.startedAt !== undefined ? iso(patch.startedAt) : (existing?.startedAt ?? null),
      expiresAt: patch.expiresAt !== undefined ? iso(patch.expiresAt) : (existing?.expiresAt ?? null),
      cancelledAt:
        patch.cancelledAt !== undefined ? iso(patch.cancelledAt) : (existing?.cancelledAt ?? null),
      source: patch.source !== undefined ? patch.source : (existing?.source ?? null),
      lastOrderId:
        patch.lastOrderId !== undefined ? patch.lastOrderId : (existing?.lastOrderId ?? null),
      updatedAt: new Date().toISOString(),
    };
    this.subscriptions.set(userId, row);
    return { ...row };
  }

  async orderCreate(input: {
    id: string;
    userId: string;
    planId: string;
    amountMinor: number;
    currency: string;
    days: number;
    provider: string;
    idempotencyKey?: string | null;
    checkoutUrl?: string | null;
    expiresAt?: Date | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<OrderRow> {
    const now = new Date().toISOString();
    const row: OrderRow = {
      id: input.id,
      userId: input.userId,
      planId: input.planId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      days: input.days,
      status: 'created',
      provider: input.provider,
      providerPaymentId: null,
      idempotencyKey: input.idempotencyKey ?? null,
      checkoutUrl: input.checkoutUrl ?? null,
      createdAt: now,
      updatedAt: now,
      expiresAt: iso(input.expiresAt),
      paidAt: null,
      refundedAt: null,
      metadata: input.metadata ?? null,
    };
    this.orders.set(row.id, row);
    if (row.idempotencyKey) this.idempotency.set(row.idempotencyKey, row.id);
    return { ...row };
  }

  async orderById(id: string): Promise<OrderRow | null> {
    const o = this.orders.get(id);
    return o ? { ...o } : null;
  }

  async orderByIdempotencyKey(key: string): Promise<OrderRow | null> {
    const id = this.idempotency.get(key);
    return id ? this.orderById(id) : null;
  }

  async orderByProviderPaymentId(providerPaymentId: string): Promise<OrderRow | null> {
    for (const o of this.orders.values()) {
      if (o.providerPaymentId === providerPaymentId) return { ...o };
    }
    return null;
  }

  async orderSetStatus(
    id: string,
    status: OrderStatus,
    patch?: {
      providerPaymentId?: string | null;
      paidAt?: Date | null;
      refundedAt?: Date | null;
      checkoutUrl?: string | null;
      expiresAt?: Date | null;
      metadata?: Record<string, unknown> | null;
    },
  ): Promise<OrderRow | null> {
    const o = this.orders.get(id);
    if (!o) return null;
    o.status = status;
    o.updatedAt = new Date().toISOString();
    if (patch?.providerPaymentId !== undefined) o.providerPaymentId = patch.providerPaymentId;
    if (patch?.paidAt !== undefined) o.paidAt = iso(patch.paidAt);
    if (patch?.refundedAt !== undefined) o.refundedAt = iso(patch.refundedAt);
    if (patch?.checkoutUrl !== undefined) o.checkoutUrl = patch.checkoutUrl;
    if (patch?.expiresAt !== undefined) o.expiresAt = iso(patch.expiresAt);
    if (patch?.metadata !== undefined) o.metadata = patch.metadata;
    return { ...o };
  }

  async ordersExpire(before: Date, limit = 500): Promise<number> {
    let n = 0;
    for (const o of this.orders.values()) {
      if (n >= limit) break;
      if ((o.status === 'created' || o.status === 'pending') && o.expiresAt && new Date(o.expiresAt) < before) {
        o.status = 'expired';
        o.updatedAt = new Date().toISOString();
        n++;
      }
    }
    return n;
  }

  async ordersForUser(userId: string, limit = 50): Promise<OrderRow[]> {
    return [...this.orders.values()]
      .filter((o) => o.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((o) => ({ ...o }));
  }

  async ordersList(opts: {
    status?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: AdminOrderRow[]; total: number }> {
    let all = [...this.orders.values()];
    if (opts.status) all = all.filter((o) => o.status === opts.status);
    if (opts.userId) all = all.filter((o) => o.userId === opts.userId);
    all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const total = all.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    const items = await Promise.all(
      all.slice(offset, offset + limit).map(async (o) => {
        const u = this.users.get(o.userId);
        return { ...o, userEmail: u?.email ?? null, userName: u?.name ?? null };
      }),
    );
    return { items, total };
  }

  async orderPaidStatsForUser(userId: string): Promise<{ count: number; firstPaymentAt: string | null; lifetimeMinor: number }> {
    const paid = [...this.orders.values()].filter((o) => o.userId === userId && o.status === 'paid');
    const times = paid.map((o) => o.paidAt ?? o.updatedAt).filter(Boolean).sort();
    return {
      count: paid.length,
      firstPaymentAt: times[0] ?? null,
      lifetimeMinor: paid.reduce((sum, o) => sum + o.amountMinor, 0),
    };
  }

  async paymentEventInsert(input: {
    id: string;
    provider: string;
    eventId: string;
    orderId?: string | null;
    type: string;
    status: 'processed' | 'ignored' | 'failed';
    payload?: Record<string, unknown> | null;
  }): Promise<{ inserted: boolean }> {
    const key = `${input.provider}:${input.eventId}`;
    if (this.paymentEvents.has(key)) return { inserted: false };
    this.paymentEvents.set(key, {
      id: input.id,
      provider: input.provider,
      eventId: input.eventId,
      orderId: input.orderId ?? null,
      type: input.type,
      status: input.status,
      payload: input.payload ?? null,
      createdAt: new Date().toISOString(),
    });
    return { inserted: true };
  }

  async paymentEventsList(limit = 50): Promise<PaymentEventRow[]> {
    return [...this.paymentEvents.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async releaseUpsert(release: Omit<ReleaseRow, 'fetchedAt'> & { fetchedAt?: Date }): Promise<ReleaseRow> {
    const row: ReleaseRow = {
      ...release,
      fetchedAt: (release.fetchedAt ?? new Date()).toISOString(),
    };
    this.releases.set(row.tagName, row);
    return { ...row };
  }

  async releasesList(opts?: { channel?: ReleaseChannel; limit?: number }): Promise<ReleaseRow[]> {
    let all = [...this.releases.values()];
    if (opts?.channel) all = all.filter((r) => r.channel === opts.channel);
    all = all.filter((r) => !r.isDraft);
    all.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    return all.slice(0, opts?.limit ?? 20).map((r) => ({ ...r }));
  }

  async releasesClear(): Promise<number> {
    const n = this.releases.size;
    this.releases.clear();
    return n;
  }

  async eventInsert(type: string, userId?: string | null, payload?: Record<string, unknown> | null): Promise<void> {
    this.events.push({
      id: `evt_${this.events.length + 1}`,
      type,
      userId: userId ?? null,
      payload: payload ?? null,
      createdAt: new Date().toISOString(),
    });
  }

  async metrics(): Promise<MetricsRow> {
    const now = Date.now();
    const week = now - 7 * 86400_000;
    const month = now - 30 * 86400_000;

    const orders = [...this.orders.values()];
    const paid = orders.filter((o) => o.status === 'paid');
    const ordersByStatus: Record<string, number> = {};
    for (const o of orders) ordersByStatus[o.status] = (ordersByStatus[o.status] ?? 0) + 1;
    const revenueByPlan: Record<string, { count: number; revenueMinor: number }> = {};
    for (const o of paid) {
      const cur = revenueByPlan[o.planId] ?? { count: 0, revenueMinor: 0 };
      cur.count += 1;
      cur.revenueMinor += o.amountMinor;
      revenueByPlan[o.planId] = cur;
    }
    const paidTimes = paid.map((o) => o.paidAt ?? o.updatedAt).sort();

    const subs = [...this.subscriptions.values()];
    const eventsByType7d: Record<string, number> = {};
    for (const e of this.events) {
      if (new Date(e.createdAt).getTime() >= week) eventsByType7d[e.type] = (eventsByType7d[e.type] ?? 0) + 1;
    }

    return {
      usersTotal: this.users.size,
      usersActive7d: [...this.users.values()].filter(
        (u) => u.lastLoginAt && new Date(u.lastLoginAt).getTime() >= week,
      ).length,
      sessionsActive: [...this.sessions.values()].filter(
        (s) => !s.revokedAt && new Date(s.expiresAt).getTime() > now,
      ).length,
      ordersTotal: orders.length,
      ordersByStatus,
      paidOrderCount: paid.length,
      revenueMinor: paid.reduce((s, o) => s + o.amountMinor, 0),
      revenueByPlan,
      revenueLast30dMinor: paid
        .filter((o) => new Date(o.paidAt ?? o.updatedAt).getTime() >= month)
        .reduce((s, o) => s + o.amountMinor, 0),
      firstPaymentAt: paidTimes[0] ?? null,
      lastPaymentAt: paidTimes[paidTimes.length - 1] ?? null,
      payingUsers: new Set(paid.map((o) => o.userId)).size,
      subscriptions: {
        activeSubscriptions: subs.filter((s) => s.status === 'active' && s.expiresAt && new Date(s.expiresAt).getTime() > now).length,
        expiringWithin7Days: subs.filter(
          (s) =>
            s.status === 'active' &&
            s.expiresAt &&
            new Date(s.expiresAt).getTime() > now &&
            new Date(s.expiresAt).getTime() <= now + 7 * 86400_000,
        ).length,
        expired: subs.filter((s) => s.status === 'expired').length,
        cancelled: subs.filter((s) => s.status === 'cancelled').length,
        revoked: subs.filter((s) => s.status === 'revoked').length,
      },
      eventsByType7d,
    };
  }
}

export function createMemoryStore(): MemoryStore {
  return new MemoryStore();
}

export { hashToken };
