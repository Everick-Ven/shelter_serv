import pg from 'pg';
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

const { Pool, types } = pg;

// BIGINT приходит как string — приводим к number (суммы в копейках < 2^53).
types.setTypeParser(20, (v: string) => Number.parseInt(v, 10));

export interface PgStoreOptions {
  connectionString: string;
  max?: number;
  ssl?: boolean;
}

const toIso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === 'number' ? v : Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
};

function mapUser(r: any): UserRow {
  return {
    id: r.id,
    email: r.email ?? null,
    name: r.name ?? null,
    avatarUrl: r.avatar_url ?? null,
    role: (r.role as UserRole) ?? 'user',
    passwordHash: r.password_hash ?? null,
    deletedAt: toIso(r.deleted_at),
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
    lastLoginAt: toIso(r.last_login_at),
  };
}

function mapSession(r: any): SessionRow {
  return {
    id: r.id,
    userId: r.user_id,
    tokenHash: r.token_hash,
    userAgent: r.user_agent ?? null,
    ipHash: r.ip_hash ?? null,
    createdAt: toIso(r.created_at)!,
    expiresAt: toIso(r.expires_at)!,
    revokedAt: toIso(r.revoked_at),
    lastSeenAt: toIso(r.last_seen_at),
  };
}

function mapSubscription(r: any): SubscriptionRow {
  return {
    userId: r.user_id,
    status: r.status,
    planId: r.plan_id ?? null,
    startedAt: toIso(r.started_at),
    expiresAt: toIso(r.expires_at),
    cancelledAt: toIso(r.cancelled_at),
    source: r.source ?? null,
    lastOrderId: r.last_order_id ?? null,
    updatedAt: toIso(r.updated_at)!,
  };
}

function mapOrder(r: any): OrderRow {
  return {
    id: r.id,
    userId: r.user_id,
    planId: r.plan_id,
    amountMinor: num(r.amount_minor),
    currency: r.currency,
    days: num(r.days),
    status: r.status as OrderStatus,
    provider: r.provider,
    providerPaymentId: r.provider_payment_id ?? null,
    idempotencyKey: r.idempotency_key ?? null,
    checkoutUrl: r.checkout_url ?? null,
    createdAt: toIso(r.created_at)!,
    updatedAt: toIso(r.updated_at)!,
    expiresAt: toIso(r.expires_at),
    paidAt: toIso(r.paid_at),
    refundedAt: toIso(r.refunded_at),
    metadata: r.metadata ?? null,
  };
}

function mapPaymentEvent(r: any): PaymentEventRow {
  return {
    id: r.id,
    provider: r.provider,
    eventId: r.event_id,
    orderId: r.order_id ?? null,
    type: r.type,
    status: r.status,
    payload: r.payload ?? null,
    createdAt: toIso(r.created_at)!,
  };
}

function mapRelease(r: any): ReleaseRow {
  return {
    id: r.id,
    tagName: r.tag_name,
    version: r.version,
    channel: (r.channel as ReleaseChannel) ?? 'stable',
    name: r.name ?? null,
    body: r.body ?? null,
    htmlUrl: r.html_url ?? null,
    publishedAt: toIso(r.published_at),
    isPrerelease: Boolean(r.is_prerelease),
    isDraft: Boolean(r.is_draft),
    assets: Array.isArray(r.assets) ? r.assets : [],
    fetchedAt: toIso(r.fetched_at)!,
  };
}

export class PgStore implements Store {
  readonly kind = 'pg' as const;
  readonly pool: pg.Pool;

  constructor(opts: PgStoreOptions) {
    this.pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      ssl: opts.ssl ? { rejectUnauthorized: true } : undefined,
    });
  }

  async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.pool.query(text, params as any[]);
    return res.rows as T[];
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // -- settings -------------------------------------------------------------

  async settingsGet(key: string): Promise<string | null> {
    const rows = await this.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return rows[0]?.value ?? null;
  }

  async settingsSet(key: string, value: string): Promise<void> {
    await this.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    );
  }

  // -- users ----------------------------------------------------------------

  async userCreate(input: {
    email: string | null;
    name: string | null;
    avatarUrl: string | null;
    role?: UserRole;
  }): Promise<UserRow> {
    const rows = await this.query(
      `INSERT INTO users (email, name, avatar_url, role)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.email, input.name, input.avatarUrl, input.role ?? 'user'],
    );
    return mapUser(rows[0]);
  }

  async userById(id: string): Promise<UserRow | null> {
    const rows = await this.query('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async userByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.query(
      `SELECT * FROM users WHERE lower(email) = lower($1) AND deleted_at IS NULL LIMIT 1`,
      [email],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async userUpdateProfile(
    id: string,
    patch: { email?: string | null; name?: string | null; avatarUrl?: string | null },
  ): Promise<UserRow | null> {
    const rows = await this.query(
      `UPDATE users SET
         email = COALESCE($2, email),
         name = COALESCE($3, name),
         avatar_url = COALESCE($4, avatar_url),
         updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL
       RETURNING *`,
      [id, patch.email ?? null, patch.name ?? null, patch.avatarUrl ?? null],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async userTouchLogin(id: string, at: Date = new Date()): Promise<void> {
    await this.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [id, at]);
  }

  async userAnonymize(id: string, at: Date = new Date()): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET email = NULL, name = NULL, avatar_url = NULL, password_hash = NULL,
                deleted_at = $2, updated_at = $2
         WHERE id = $1`,
        [id, at],
      );
      await client.query('DELETE FROM user_identities WHERE user_id = $1', [id]);
      await client.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [id, at]);
      await client.query('DELETE FROM events WHERE user_id = $1', [id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async usersList(opts: { q?: string; limit?: number; offset?: number }): Promise<{ items: AdminUserRow[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const q = opts.q ? `%${opts.q.trim().toLowerCase()}%` : null;

    const where = q
      ? `WHERE (lower(coalesce(email,'')) LIKE $1 OR lower(coalesce(name,'')) LIKE $1 OR id::text LIKE $1)`
      : '';
    const params: unknown[] = q ? [q] : [];

    const totalRows = await this.query(`SELECT count(*)::int AS total FROM users ${where}`, params);
    const rows = await this.query(
      `SELECT u.*,
              json_agg(DISTINCT jsonb_build_object('provider', i.provider, 'email', i.email))
                FILTER (WHERE i.provider IS NOT NULL) AS identities,
              (SELECT to_jsonb(s) FROM subscriptions s WHERE s.user_id = u.id) AS subscription,
              (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_order_count,
              (SELECT min(o.paid_at) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS first_payment_at,
              (SELECT coalesce(sum(o.amount_minor), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS lifetime_minor
         FROM users u
         LEFT JOIN user_identities i ON i.user_id = u.id
         ${where}
         GROUP BY u.id
         ORDER BY u.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    return {
      total: num(totalRows[0]?.total),
      items: rows.map((r: any) => ({
        ...mapUser(r),
        identities: (r.identities ?? []).map((i: any) => ({ provider: i.provider, email: i.email ?? null })),
        subscription: r.subscription ? mapSubscription(r.subscription) : null,
        paidOrderCount: num(r.paid_order_count),
        firstPaymentAt: toIso(r.first_payment_at),
        lifetimeMinor: num(r.lifetime_minor),
      })),
    };
  }

  async userSetRole(id: string, role: UserRole): Promise<UserRow | null> {
    const rows = await this.query(
      'UPDATE users SET role = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [id, role],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async userSetPassword(id: string, hash: string | null): Promise<UserRow | null> {
    const rows = await this.query(
      `UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, hash],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async adminUserView(id: string): Promise<AdminUserRow | null> {
    const rows = await this.query(
      `SELECT u.*,
              (SELECT json_agg(jsonb_build_object('provider', i.provider, 'email', i.email))
                 FROM user_identities i WHERE i.user_id = u.id) AS identities,
              (SELECT to_jsonb(s) FROM subscriptions s WHERE s.user_id = u.id) AS subscription,
              (SELECT count(*)::int FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS paid_order_count,
              (SELECT min(o.paid_at) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS first_payment_at,
              (SELECT coalesce(sum(o.amount_minor),0) FROM orders o WHERE o.user_id = u.id AND o.status = 'paid') AS lifetime_minor
         FROM users u WHERE u.id = $1`,
      [id],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ...mapUser(r),
      identities: (r.identities ?? []).map((i: any) => ({ provider: i.provider, email: i.email ?? null })),
      subscription: r.subscription ? mapSubscription(r.subscription) : null,
      paidOrderCount: num(r.paid_order_count),
      firstPaymentAt: toIso(r.first_payment_at),
      lifetimeMinor: num(r.lifetime_minor),
    };
  }

  // -- identities -----------------------------------------------------------

  async identityUpsert(input: {
    userId: string;
    provider: OAuthProvider;
    providerUserId: string;
    email: string | null;
  }): Promise<void> {
    await this.query(
      `INSERT INTO user_identities (provider, provider_user_id, user_id, email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (provider, provider_user_id)
       DO UPDATE SET email = EXCLUDED.email`,
      [input.provider, input.providerUserId, input.userId, input.email],
    );
  }

  async identityFind(provider: OAuthProvider, providerUserId: string): Promise<UserIdentityRow | null> {
    const rows = await this.query(
      'SELECT * FROM user_identities WHERE provider = $1 AND provider_user_id = $2',
      [provider, providerUserId],
    );
    const r = rows[0];
    return r
      ? {
          userId: r.user_id,
          provider: r.provider,
          providerUserId: r.provider_user_id,
          email: r.email ?? null,
          createdAt: toIso(r.created_at)!,
        }
      : null;
  }

  async identitiesByUser(userId: string): Promise<UserIdentityRow[]> {
    const rows = await this.query('SELECT * FROM user_identities WHERE user_id = $1', [userId]);
    return rows.map((r: any) => ({
      userId: r.user_id,
      provider: r.provider,
      providerUserId: r.provider_user_id,
      email: r.email ?? null,
      createdAt: toIso(r.created_at)!,
    }));
  }

  // -- sessions -------------------------------------------------------------

  async sessionCreate(input: {
    userId: string;
    tokenHash: string;
    userAgent?: string | null;
    ipHash?: string | null;
    expiresAt: Date;
  }): Promise<SessionRow> {
    const rows = await this.query(
      `INSERT INTO sessions (user_id, token_hash, user_agent, ip_hash, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, now())
       RETURNING *`,
      [input.userId, input.tokenHash, input.userAgent ?? null, input.ipHash ?? null, input.expiresAt],
    );
    return mapSession(rows[0]);
  }

  async sessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const rows = await this.query('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash]);
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async sessionTouch(id: string, expiresAt: Date, at: Date = new Date()): Promise<void> {
    await this.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id = $1', [
      id,
      at,
      expiresAt,
    ]);
  }

  async sessionRevoke(id: string, at: Date = new Date()): Promise<void> {
    await this.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, at]);
  }

  async sessionsRevokeForUser(userId: string, at: Date = new Date()): Promise<number> {
    const rows = await this.query(
      `UPDATE sessions SET revoked_at = $2
        WHERE user_id = $1 AND revoked_at IS NULL
        RETURNING id`,
      [userId, at],
    );
    return rows.length;
  }

  async sessionsListForUser(userId: string): Promise<SessionRow[]> {
    const rows = await this.query(
      'SELECT * FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
      [userId],
    );
    return rows.map(mapSession);
  }

  // -- subscriptions --------------------------------------------------------

  async subscriptionGet(userId: string): Promise<SubscriptionRow | null> {
    const rows = await this.query('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
    return rows[0] ? mapSubscription(rows[0]) : null;
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
    const rows = await this.query(
      `INSERT INTO subscriptions AS s (user_id, status, plan_id, started_at, expires_at, cancelled_at, source, last_order_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (user_id) DO UPDATE SET
         status = EXCLUDED.status,
         plan_id = COALESCE(EXCLUDED.plan_id, s.plan_id),
         started_at = COALESCE(EXCLUDED.started_at, s.started_at),
         expires_at = COALESCE(EXCLUDED.expires_at, s.expires_at),
         cancelled_at = COALESCE(EXCLUDED.cancelled_at, s.cancelled_at),
         source = COALESCE(EXCLUDED.source, s.source),
         last_order_id = COALESCE(EXCLUDED.last_order_id, s.last_order_id),
         updated_at = now()
       RETURNING *`,
      [
        userId,
        patch.status,
        patch.planId ?? null,
        patch.startedAt ?? null,
        patch.expiresAt ?? null,
        patch.cancelledAt ?? null,
        patch.source ?? null,
        patch.lastOrderId ?? null,
      ],
    );
    return mapSubscription(rows[0]);
  }

  // -- orders ---------------------------------------------------------------

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
    const rows = await this.query(
      `INSERT INTO orders (id, user_id, plan_id, amount_minor, currency, days, provider, idempotency_key, checkout_url, expires_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        input.id,
        input.userId,
        input.planId,
        input.amountMinor,
        input.currency,
        input.days,
        input.provider,
        input.idempotencyKey ?? null,
        input.checkoutUrl ?? null,
        input.expiresAt ?? null,
        JSON.stringify(input.metadata ?? null),
      ],
    );
    return mapOrder(rows[0]);
  }

  async orderById(id: string): Promise<OrderRow | null> {
    const rows = await this.query('SELECT * FROM orders WHERE id = $1', [id]);
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async orderByIdempotencyKey(key: string): Promise<OrderRow | null> {
    const rows = await this.query('SELECT * FROM orders WHERE idempotency_key = $1', [key]);
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async orderByProviderPaymentId(providerPaymentId: string): Promise<OrderRow | null> {
    const rows = await this.query(
      `SELECT * FROM orders WHERE provider_payment_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [providerPaymentId],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
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
    const rows = await this.query(
      `UPDATE orders SET
         status = $2,
         updated_at = now(),
         provider_payment_id = COALESCE($3, provider_payment_id),
         paid_at = COALESCE($4, paid_at),
         refunded_at = COALESCE($5, refunded_at),
         checkout_url = COALESCE($6, checkout_url),
         expires_at = COALESCE($7, expires_at),
         metadata = COALESCE($8, metadata)
       WHERE id = $1
       RETURNING *`,
      [
        id,
        status,
        patch?.providerPaymentId ?? null,
        patch?.paidAt ?? null,
        patch?.refundedAt ?? null,
        patch?.checkoutUrl ?? null,
        patch?.expiresAt ?? null,
        patch?.metadata ? JSON.stringify(patch.metadata) : null,
      ],
    );
    return rows[0] ? mapOrder(rows[0]) : null;
  }

  async ordersExpire(before: Date, limit = 500): Promise<number> {
    const rows = await this.query(
      `UPDATE orders SET status = 'expired', updated_at = now()
        WHERE id IN (
          SELECT id FROM orders
           WHERE status IN ('created','pending') AND expires_at IS NOT NULL AND expires_at < $1
           ORDER BY expires_at
           LIMIT $2
        )
        RETURNING id`,
      [before, limit],
    );
    return rows.length;
  }

  async ordersForUser(userId: string, limit = 50): Promise<OrderRow[]> {
    const rows = await this.query(
      'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2',
      [userId, limit],
    );
    return rows.map(mapOrder);
  }

  async ordersList(opts: {
    status?: string;
    userId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ items: AdminOrderRow[]; total: number }> {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    const conds: string[] = [];
    const params: unknown[] = [];
    if (opts.status) {
      params.push(opts.status);
      conds.push(`o.status = $${params.length}`);
    }
    if (opts.userId) {
      params.push(opts.userId);
      conds.push(`o.user_id = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const totalRows = await this.query(`SELECT count(*)::int AS total FROM orders o ${where}`, params);
    const rows = await this.query(
      `SELECT o.*, u.email AS user_email, u.name AS user_name
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         ${where}
         ORDER BY o.created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return {
      total: num(totalRows[0]?.total),
      items: rows.map((r: any) => ({ ...mapOrder(r), userEmail: r.user_email ?? null, userName: r.user_name ?? null })),
    };
  }

  /**
   * paid_order_count / first_payment_at / LTV — из orders, status='paid'.
   * В subscriptions эти поля не дублируются (TZ).
   */
  async orderPaidStatsForUser(userId: string): Promise<{ count: number; firstPaymentAt: string | null; lifetimeMinor: number }> {
    const rows = await this.query(
      `SELECT count(*)::int AS cnt, min(paid_at) AS first_paid_at, coalesce(sum(amount_minor), 0) AS lifetime
         FROM orders WHERE user_id = $1 AND status = 'paid'`,
      [userId],
    );
    return {
      count: num(rows[0]?.cnt),
      firstPaymentAt: toIso(rows[0]?.first_paid_at),
      lifetimeMinor: num(rows[0]?.lifetime),
    };
  }

  // -- payment events -------------------------------------------------------

  async paymentEventInsert(input: {
    id: string;
    provider: string;
    eventId: string;
    orderId?: string | null;
    type: string;
    status: 'processed' | 'ignored' | 'failed';
    payload?: Record<string, unknown> | null;
  }): Promise<{ inserted: boolean }> {
    const rows = await this.query(
      `INSERT INTO payment_events (id, provider, event_id, order_id, type, status, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [
        input.id,
        input.provider,
        input.eventId,
        input.orderId ?? null,
        input.type,
        input.status,
        JSON.stringify(input.payload ?? null),
      ],
    );
    return { inserted: rows.length > 0 };
  }

  async paymentEventsList(limit = 50): Promise<PaymentEventRow[]> {
    const rows = await this.query(
      'SELECT * FROM payment_events ORDER BY created_at DESC LIMIT $1',
      [limit],
    );
    return rows.map(mapPaymentEvent);
  }

  // -- releases -------------------------------------------------------------

  async releaseUpsert(release: Omit<ReleaseRow, 'fetchedAt'> & { fetchedAt?: Date }): Promise<ReleaseRow> {
    const rows = await this.query(
      `INSERT INTO releases (id, tag_name, version, channel, name, body, html_url, published_at, is_prerelease, is_draft, assets, fetched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (tag_name) DO UPDATE SET
         version = EXCLUDED.version,
         channel = EXCLUDED.channel,
         name = EXCLUDED.name,
         body = EXCLUDED.body,
         html_url = EXCLUDED.html_url,
         published_at = EXCLUDED.published_at,
         is_prerelease = EXCLUDED.is_prerelease,
         is_draft = EXCLUDED.is_draft,
         assets = EXCLUDED.assets,
         fetched_at = now()
       RETURNING *`,
      [
        release.id,
        release.tagName,
        release.version,
        release.channel,
        release.name,
        release.body,
        release.htmlUrl,
        release.publishedAt ? new Date(release.publishedAt) : null,
        release.isPrerelease,
        release.isDraft,
        JSON.stringify(release.assets ?? []),
      ],
    );
    return mapRelease(rows[0]);
  }

  async releasesList(opts?: { channel?: ReleaseChannel; limit?: number }): Promise<ReleaseRow[]> {
    const limit = opts?.limit ?? 20;
    if (opts?.channel) {
      const rows = await this.query(
        `SELECT * FROM releases WHERE channel = $1 AND is_draft = false
          ORDER BY published_at DESC NULLS LAST, tag_name DESC LIMIT $2`,
        [opts.channel, limit],
      );
      return rows.map(mapRelease);
    }
    const rows = await this.query(
      `SELECT * FROM releases WHERE is_draft = false
        ORDER BY published_at DESC NULLS LAST, tag_name DESC LIMIT $1`,
      [limit],
    );
    return rows.map(mapRelease);
  }

  async releasesClear(): Promise<number> {
    const rows = await this.query('DELETE FROM releases RETURNING id');
    return rows.length;
  }

  // -- events & metrics -----------------------------------------------------

  async eventInsert(type: string, userId?: string | null, payload?: Record<string, unknown> | null): Promise<void> {
    await this.query(
      'INSERT INTO events (type, user_id, payload) VALUES ($1,$2,$3)',
      [type, userId ?? null, JSON.stringify(payload ?? null)],
    );
  }

  async metrics(): Promise<MetricsRow> {
    const [users, sessions, orders, subStats, events, revenue] = await Promise.all([
      this.query(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE last_login_at > now() - interval '7 days')::int AS active7d
           FROM users WHERE deleted_at IS NULL`,
      ),
      this.query(
        `SELECT count(*)::int AS active FROM sessions WHERE revoked_at IS NULL AND expires_at > now()`,
      ),
      this.query(
        `SELECT status, count(*)::int AS cnt,
                coalesce(sum(amount_minor) FILTER (WHERE status = 'paid'), 0) AS revenue,
                coalesce(sum(amount_minor) FILTER (WHERE status = 'paid' AND paid_at > now() - interval '30 days'), 0) AS revenue30d
           FROM orders GROUP BY status`,
      ),
      this.query(
        `SELECT count(*) FILTER (WHERE status = 'active' AND expires_at > now())::int AS active,
                count(*) FILTER (WHERE status = 'active' AND expires_at > now() AND expires_at <= now() + interval '7 days')::int AS expiring,
                count(*) FILTER (WHERE status = 'expired')::int AS expired,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
                count(*) FILTER (WHERE status = 'revoked')::int AS revoked
           FROM subscriptions`,
      ),
      this.query(
        `SELECT type, count(*)::int AS cnt FROM events
          WHERE created_at > now() - interval '7 days' GROUP BY type`,
      ),
      this.query(
        `SELECT count(*)::int AS paid_orders,
                min(paid_at) AS first_payment_at,
                max(paid_at) AS last_payment_at,
                count(DISTINCT user_id)::int AS paying_users
           FROM orders WHERE status = 'paid'`,
      ),
    ]);

    const ordersByStatus: Record<string, number> = {};
    const revenueByPlan: Record<string, { count: number; revenueMinor: number }> = {};
    let revenueMinor = 0;
    let revenueLast30dMinor = 0;
    for (const r of orders as any[]) {
      ordersByStatus[r.status] = num(r.cnt);
      revenueMinor += num(r.revenue);
      revenueLast30dMinor += num(r.revenue30d);
    }
    const byPlan = await this.query(
      `SELECT plan_id, count(*)::int AS cnt, coalesce(sum(amount_minor),0) AS revenue
         FROM orders WHERE status = 'paid' GROUP BY plan_id`,
    );
    for (const r of byPlan as any[]) {
      revenueByPlan[r.plan_id] = { count: num(r.cnt), revenueMinor: num(r.revenue) };
    }
    const eventsByType7d: Record<string, number> = {};
    for (const r of events as any[]) eventsByType7d[r.type] = num(r.cnt);

    const ordersTotal = Object.values(ordersByStatus).reduce((a, b) => a + b, 0);
    const s = (subStats as any[])[0] ?? {};

    return {
      usersTotal: num((users as any[])[0]?.total),
      usersActive7d: num((users as any[])[0]?.active7d),
      sessionsActive: num((sessions as any[])[0]?.active),
      ordersTotal,
      ordersByStatus,
      paidOrderCount: num((revenue as any[])[0]?.paid_orders),
      revenueMinor,
      revenueByPlan,
      revenueLast30dMinor,
      firstPaymentAt: toIso((revenue as any[])[0]?.first_payment_at),
      lastPaymentAt: toIso((revenue as any[])[0]?.last_payment_at),
      payingUsers: num((revenue as any[])[0]?.paying_users),
      subscriptions: {
        activeSubscriptions: num(s.active),
        expiringWithin7Days: num(s.expiring),
        expired: num(s.expired),
        cancelled: num(s.cancelled),
        revoked: num(s.revoked),
      },
      eventsByType7d,
    };
  }
}

export async function createPgStore(opts: PgStoreOptions): Promise<PgStore> {
  const store = new PgStore(opts);
  // Быстрая проверка доступности БД — иначе приложение упадёт позже и непонятно.
  await store.query('SELECT 1 AS ok');
  return store;
}

export type { EventRow };
