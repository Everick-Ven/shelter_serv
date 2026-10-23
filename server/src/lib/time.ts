/** Все операции со временем — на сервере, в UTC. */

export const DAY_SECONDS = 24 * 60 * 60;

export function nowUtc(): Date {
  return new Date();
}

export function addDays(from: Date, days: number): Date {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function addSeconds(from: Date, seconds: number): Date {
  return new Date(from.getTime() + seconds * 1000);
}

export function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Продление подписки: если текущая ещё активна — считаем от её окончания
 * (дни не сгорают), если истекла — от текущего момента.
 */
export function extendExpiry(current: Date | string | null | undefined, days: number, now: Date = nowUtc()): Date {
  const cur = current instanceof Date ? current : current ? new Date(current) : null;
  const base = cur && !Number.isNaN(cur.getTime()) && cur.getTime() > now.getTime() ? cur : now;
  return addDays(base, days);
}

export function secondsUntil(d: Date | string | null | undefined, now: Date = nowUtc()): number {
  const date = d instanceof Date ? d : d ? new Date(d) : null;
  if (!date || Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((date.getTime() - now.getTime()) / 1000));
}

export function daysUntil(d: Date | string | null | undefined, now: Date = nowUtc()): number {
  return Math.ceil(secondsUntil(d, now) / DAY_SECONDS);
}
