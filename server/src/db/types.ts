/**
 * Контракт хранилища. Один и тот же интерфейс реализуют:
 *  - `pg` (боевая БД PostgreSQL)
 *  - `memory` (unit-тесты без внешней инфраструктуры)
 *
 * Прикладная логика (routes/services) не знает, какая реализация underneath.
 */

export type OAuthProvider = 'google' | 'yandex';
export type UserRole = 'user' | 'admin';
export type OrderStatus = 'created' | 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';
export type ReleaseChannel = 'stable' | 'beta';

export interface UserRow {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  /** аккаунт удалён по запросу пользователя (DELETE /me) */
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface UserIdentityRow {
  userId: string;
  provider: OAuthProvider;
  providerUserId: string;
  email: string | null;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ipHash: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export interface SubscriptionRow {
  userId: string;
  status: string;
  planId: string | null;
  startedAt: string | null;
  expiresAt: string | null;
  cancelledAt: string | null;
  source: 'payment' | 'admin_grant' | null;
  lastOrderId: string | null;
  updatedAt: string;
}

export interface OrderRow {
  id: string;
  userId: string;
  planId: string;
  amountMinor: number;
  currency: string;
  days: number;
  status: OrderStatus;
  provider: string;
  providerPaymentId: string | null;
  idempotencyKey: string | null;
  checkoutUrl: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  paidAt: string | null;
  refundedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PaymentEventRow {
  id: string;
  provider: string;
  eventId: string;
  orderId: string | null;
  type: string;
  status: 'processed' | 'ignored' | 'failed';
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface ReleaseRow {
  id: string;
  tagName: string;
  version: string;
  channel: ReleaseChannel;
  name: string | null;
  body: string | null;
  htmlUrl: string | null;
  publishedAt: string | null;
  isPrerelease: boolean;
  isDraft: boolean;
  assets: { name: string; url: string; size: number; contentType?: string }[];
  fetchedAt: string;
}

export interface EventRow {
  id: string;
  type: string;
  userId: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
}

export interface SubscriptionStats {
  activeSubscriptions: number;
  expiringWithin7Days: number;
  expired: number;
  cancelled: number;
  revoked: number;
}

export interface MetricsRow {
  usersTotal: number;
  usersActive7d: number;
  sessionsActive: number;
  ordersTotal: number;
  ordersByStatus: Record<string, number>;
  paidOrderCount: number;
  revenueMinor: number;
  revenueByPlan: Record<string, { count: number; revenueMinor: number }>;
  revenueLast30dMinor: number;
  firstPaymentAt: string | null;
  lastPaymentAt: string | null;
  payingUsers: number;
  subscriptions: SubscriptionStats;
  eventsByType7d: Record<string, number>;
}

export interface AdminOrderRow extends OrderRow {
  userEmail: string | null;
  userName: string | null;
}

export interface AdminUserRow extends UserRow {
  identities: { provider: OAuthProvider; email: string | null }[];
  subscription: SubscriptionRow | null;
  /**
   * ВЫЧИСЛЯЕТСЯ из orders (COUNT / MIN, status='paid'), в subscriptions
   * не дублируется — требование TZ.
   */
  paidOrderCount: number;
  firstPaymentAt: string | null;
  lifetimeMinor: number;
}

export interface Tx {
  /** Проксирование к тому же хранилищу внутри транзакции. */
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface Store {
  readonly kind: 'pg' | 'memory';

  settingsGet(key: string): Promise<string | null>;
  settingsSet(key: string, value: string): Promise<void>;

  userCreate(input: {
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    role?: UserRole;
  }): Promise<UserRow>;
  userById(id: string): Promise<UserRow | null>;
  userByEmail(email: string): Promise<UserRow | null>;
  userUpdateProfile(
    id: string,
    patch: { email?: string | null; name?: string | null; avatarUrl?: string | null },
  ): Promise<UserRow | null>;
  userTouchLogin(id: string, at?: Date): Promise<void>;
  userAnonymize(id: string, at?: Date): Promise<void>;
  usersList(opts: { q?: string; limit?: number; offset?: number }): Promise<{ items: AdminUserRow[]; total: number }>;
  userSetRole(id: string, role: UserRole): Promise<UserRow | null>;
  adminUserView(id: string): Promise<AdminUserRow | null>;

  identityUpsert(input: {
    userId: string;
    provider: OAuthProvider;
    providerUserId: string;
    email: string | null;
  }): Promise<void>;
  identityFind(provider: OAuthProvider, providerUserId: string): Promise<UserIdentityRow | null>;
  identitiesByUser(userId: string): Promise<UserIdentityRow[]>;

  sessionCreate(input: {
    userId: string;
    tokenHash: string;
    userAgent?: string | null;
    ipHash?: string | null;
    expiresAt: Date;
  }): Promise<SessionRow>;
  sessionByTokenHash(tokenHash: string): Promise<SessionRow | null>;
  sessionTouch(id: string, expiresAt: Date, at?: Date): Promise<void>;
  sessionRevoke(id: string, at?: Date): Promise<void>;
  sessionsRevokeForUser(userId: string, at?: Date): Promise<number>;
  sessionsListForUser(userId: string): Promise<SessionRow[]>;

  subscriptionGet(userId: string): Promise<SubscriptionRow | null>;
  subscriptionUpsert(
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
  ): Promise<SubscriptionRow>;

  orderCreate(input: {
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
  }): Promise<OrderRow>;
  orderById(id: string): Promise<OrderRow | null>;
  orderByIdempotencyKey(key: string): Promise<OrderRow | null>;
  orderByProviderPaymentId(providerPaymentId: string): Promise<OrderRow | null>;
  orderSetStatus(
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
  ): Promise<OrderRow | null>;
  ordersExpire(before: Date, limit?: number): Promise<number>;
  ordersForUser(userId: string, limit?: number): Promise<OrderRow[]>;
  ordersList(opts: {
    status?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: AdminOrderRow[]; total: number }>;
  /**
   * paid_order_count / first_payment_at / LTV — только из orders
   * (COUNT / MIN / SUM, status='paid').
   */
  orderPaidStatsForUser(userId: string): Promise<{ count: number; firstPaymentAt: string | null; lifetimeMinor: number }>;

  paymentEventInsert(input: {
    id: string;
    provider: string;
    eventId: string;
    orderId?: string | null;
    type: string;
    status: 'processed' | 'ignored' | 'failed';
    payload?: Record<string, unknown> | null;
  }): Promise<{ inserted: boolean }>;
  paymentEventsList(limit?: number): Promise<PaymentEventRow[]>;

  releaseUpsert(release: Omit<ReleaseRow, 'fetchedAt'> & { fetchedAt?: Date }): Promise<ReleaseRow>;
  releasesList(opts?: { channel?: ReleaseChannel; limit?: number }): Promise<ReleaseRow[]>;
  releasesClear(): Promise<number>;

  eventInsert(type: string, userId?: string | null, payload?: Record<string, unknown> | null): Promise<void>;
  metrics(): Promise<MetricsRow>;

  close(): Promise<void>;
}
