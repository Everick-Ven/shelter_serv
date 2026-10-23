/**
 * ЕДИНСТВЕННЫЙ источник правды о премиуме.
 *
 * Правила (TZ, fail-closed):
 *  - доступ подтверждён ТОЛЬКО если запись подписки найдена, она активна,
 *    не отозвана и `expires_at` в будущем относительно серверного времени;
 *  - любая ошибка (нет записи, битые данные, сбой БД, неожиданный статус)
 *    трактуется как «подписка НЕ подтверждена»;
 *  - состояние из клиентского хранилища доказательством не является и сюда
 *    никогда не передаётся;
 *  - dev-mock / beta-promo не считаются оплатой: entitlement выдаётся только
 *    по заказу со статусом `paid` либо по явному grant администратора.
 */

export type SubscriptionStatus =
  | 'active'
  | 'expired'
  | 'cancelled'
  | 'refunded'
  | 'revoked'
  | 'none';

export type EntitlementReason =
  | 'paid'
  | 'granted'
  | 'no_subscription'
  | 'expired'
  | 'cancelled'
  | 'refunded'
  | 'revoked'
  | 'invalid_data'
  | 'unauthenticated'
  | 'verification_failed';

export type EntitlementSource = 'payment' | 'admin_grant' | 'none';

export interface EntitlementInput {
  /**
   * Снимок подписки из БД. `null` = записи нет.
   * Если чтение упало — вызывающий код обязан передать `null` и reason
   * `verification_failed` через `denied()`, а НЕ бросать исключение наверх.
   */
  subscription: SubscriptionSnapshot | null;
  /** Серверное время. Всегда берётся на сервере, никогда из клиента. */
  now: Date;
}

export interface SubscriptionSnapshot {
  status: string | null;
  planId: string | null;
  /** ISO-8601 строка или Date; null = срок не задан (битые данные). */
  expiresAt: string | Date | null;
  /** Откуда взялось право: оплаченный заказ или grant администратора. */
  source: string | null;
  cancelledAt?: string | Date | null;
  /** Последний оплаченный заказ (для витрины/поддержки). */
  lastOrderId?: string | null;
}

export interface EntitlementResult {
  /** Итоговое решение. Единственное поле, на которое смотрит клиент. */
  active: boolean;
  status: SubscriptionStatus;
  reason: EntitlementReason;
  source: EntitlementSource;
  planId: string | null;
  /** ISO-8601 или null. */
  expiresAt: string | null;
  /** Сколько секунд осталось (>= 0 только при active). */
  secondsRemaining: number;
  /** Можно ли продлить/купить сейчас. */
  renewable: boolean;
  /** Серверное время проверки (ISO) — для логов и диагностики клиента. */
  checkedAt: string;
}

const RENEWABLE_STATUSES: SubscriptionStatus[] = ['active', 'expired', 'cancelled', 'none'];

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Явный отказ. Используется и при ошибках проверки — никогда не «авось активно». */
export function denied(
  reason: EntitlementReason,
  now: Date,
  extra: Omit<Partial<EntitlementResult>, 'active'> = {},
): EntitlementResult {
  const base: EntitlementResult = {
    active: false,
    status: 'none',
    reason,
    source: 'none',
    planId: null,
    expiresAt: null,
    secondsRemaining: 0,
    renewable: true,
    checkedAt: now.toISOString(),
  };
  const merged: EntitlementResult = { ...base, ...extra };
  // Инвариант: отказ всегда остаётся отказом.
  merged.active = false;
  merged.secondsRemaining = 0;
  if (!RENEWABLE_STATUSES.includes(merged.status)) merged.renewable = false;
  return merged;
}

function granted(
  now: Date,
  snapshot: SubscriptionSnapshot,
  expiresAt: Date,
  reason: EntitlementReason,
): EntitlementResult {
  const secondsRemaining = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return {
    active: true,
    status: 'active',
    reason,
    source: snapshot.source === 'admin_grant' ? 'admin_grant' : 'payment',
    planId: snapshot.planId,
    expiresAt: expiresAt.toISOString(),
    secondsRemaining,
    renewable: true,
    checkedAt: now.toISOString(),
  };
}

/**
 * Чистая функция проверки. Не бросает исключений: любой неожиданный ввод ->
 * отказ. Это и есть fail-closed.
 */
export function evaluateEntitlement(input: EntitlementInput): EntitlementResult {
  const { now } = input;
  const snapshot = input.subscription;

  if (!snapshot) return denied('no_subscription', now);

  const rawStatus = String(snapshot.status ?? '').toLowerCase();

  // Явно негативные статусы — отказ с точной причиной.
  // 'none' — подписка никогда не оформлялась: это не ошибка данных.
  if (rawStatus === 'none') return denied('no_subscription', now, { status: 'none' });

  if (rawStatus === 'revoked') return denied('revoked', now, { status: 'revoked' });
  if (rawStatus === 'refunded') return denied('refunded', now, { status: 'refunded' });
  if (rawStatus === 'cancelled') return denied('cancelled', now, { status: 'cancelled' });
  if (rawStatus === 'expired') return denied('expired', now, { status: 'expired' });

  // Только 'active' может дать доступ. Всё прочее (опечатки, новые статусы,
  // пустая строка) — битые данные => отказ.
  if (rawStatus !== 'active') return denied('invalid_data', now);

  if (!snapshot.planId) return denied('invalid_data', now);

  const expiresAt = toDate(snapshot.expiresAt);
  if (!expiresAt) return denied('invalid_data', now);

  // Просрочено — отказ (без «grace period»: TZ требует fail-closed).
  if (expiresAt.getTime() <= now.getTime()) return denied('expired', now, { status: 'expired', planId: snapshot.planId, expiresAt: expiresAt.toISOString() });

  const reason: EntitlementReason = snapshot.source === 'admin_grant' ? 'granted' : 'paid';
  return granted(now, snapshot, expiresAt, reason);
}

/** Обёртка для вызовов, где сбой чтения БД должен превратиться в отказ. */
export async function safeEvaluate(
  read: () => Promise<SubscriptionSnapshot | null>,
  now: Date = new Date(),
): Promise<EntitlementResult> {
  try {
    return evaluateEntitlement({ subscription: await read(), now });
  } catch {
    // Никаких деталей наружу: клиент получает «не подтверждено».
    return denied('verification_failed', now);
  }
}

/** Публичный контракт `premium.status` (bridge) — формат менять нельзя. */
export function toPremiumStatusPayload(e: EntitlementResult) {
  return {
    active: e.active,
    planId: e.planId,
    expiresAt: e.expiresAt,
    status: e.status,
    reason: e.reason,
    checkedAt: e.checkedAt,
  };
}
