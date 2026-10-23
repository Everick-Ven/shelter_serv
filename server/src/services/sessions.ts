import { createHash } from 'node:crypto';
import type { Env } from '../config.js';
import type { Store, UserRow } from '../db/types.js';
import { addSeconds } from '../lib/time.js';
import { generateToken, hashToken } from '../lib/tokens.js';

export interface SessionIssueResult {
  token: string;
  sessionId: string;
  expiresAt: Date;
  user: UserRow;
}

export interface SessionValidation {
  ok: boolean;
  user?: UserRow;
  sessionId?: string;
  /** Нужно ли продлить cookie (скользящая сессия). */
  renew?: boolean;
  expiresAt?: Date;
  reason?: 'missing' | 'not_found' | 'revoked' | 'expired' | 'user_missing' | 'user_deleted';
}

/**
 * Сессии: opaque-токен в HttpOnly/Secure/SameSite=Lax cookie, в БД — только
 * sha256-хэш. Любой сбой проверки = «не авторизован» (fail-closed).
 */
export class SessionService {
  constructor(private readonly store: Store, private readonly env: Env) {}

  get cookieName(): string {
    return this.env.COOKIE_NAME;
  }

  cookieOptions(expiresAt: Date) {
    return {
      path: '/',
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: 'lax' as const,
      domain: this.env.COOKIE_DOMAIN,
      expires: expiresAt,
    };
  }

  async issue(user: UserRow, meta: { userAgent?: string | null; ip?: string | null }): Promise<SessionIssueResult> {
    const token = generateToken(32);
    const expiresAt = addSeconds(new Date(), this.env.SESSION_TTL_SECONDS);
    const row = await this.store.sessionCreate({
      userId: user.id,
      tokenHash: hashToken(token),
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
      ipHash: meta.ip ? createHash('sha256').update(meta.ip).digest('hex') : null,
      expiresAt,
    });
    await this.store.userTouchLogin(user.id);
    return { token, sessionId: row.id, expiresAt, user };
  }

  async validate(token: string | undefined | null): Promise<SessionValidation> {
    if (!token) return { ok: false, reason: 'missing' };
    try {
      const row = await this.store.sessionByTokenHash(hashToken(token));
      if (!row) return { ok: false, reason: 'not_found' };
      if (row.revokedAt) return { ok: false, reason: 'revoked' };
      if (new Date(row.expiresAt).getTime() <= Date.now()) return { ok: false, reason: 'expired' };

      const user = await this.store.userById(row.userId);
      if (!user) return { ok: false, reason: 'user_missing' };
      if (user.deletedAt) return { ok: false, reason: 'user_deleted' };

      const expiresAt = new Date(row.expiresAt);
      const renewThreshold = addSeconds(new Date(), this.env.SESSION_RENEW_AFTER_SECONDS);
      const renew = expiresAt.getTime() < renewThreshold.getTime();
      if (renew) {
        const next = addSeconds(new Date(), this.env.SESSION_TTL_SECONDS);
        await this.store.sessionTouch(row.id, next);
        return { ok: true, user, sessionId: row.id, renew: true, expiresAt: next };
      }
      await this.store.sessionTouch(row.id, expiresAt);
      return { ok: true, user, sessionId: row.id, renew: false, expiresAt };
    } catch {
      // Сбой БД/логика => считаем сессию недействительной.
      return { ok: false, reason: 'not_found' };
    }
  }

  async revoke(sessionId: string): Promise<void> {
    await this.store.sessionRevoke(sessionId);
  }

  async revokeAllForUser(userId: string): Promise<number> {
    return this.store.sessionsRevokeForUser(userId);
  }
}
