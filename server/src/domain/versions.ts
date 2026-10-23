/**
 * Версии — только числовые `X.Y.Z` / `vX.Y.Z` (TZ).
 * Всё, что не соответствует формату, считается НЕвалидной версией и в
 * сравнении не участвует (канал обновлений тогда отвечает «обновлений нет»,
 * чтобы не подталкивать клиента к установке неизвестно чего).
 */

export const VERSION_RE = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$/;

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** Нормализованный вид без префикса `v`. */
  canonical: string;
}

export function parseVersion(input: unknown): ParsedVersion | null {
  if (typeof input !== 'string') return null;
  const m = VERSION_RE.exec(input.trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch, canonical: `${major}.${minor}.${patch}` };
}

export function isValidVersion(input: unknown): boolean {
  return parseVersion(input) !== null;
}

/** -1 если a < b, 0 если равны, 1 если a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`Invalid version format: ${String(a)} / ${String(b)}`);
  if (pa.major !== pb.major) return pa.major < pb.major ? -1 : 1;
  if (pa.minor !== pb.minor) return pa.minor < pb.minor ? -1 : 1;
  if (pa.patch !== pb.patch) return pa.patch < pb.patch ? -1 : 1;
  return 0;
}

export function isNewer(candidate: string, current: string): boolean {
  try {
    return compareVersions(candidate, current) > 0;
  } catch {
    return false;
  }
}

/**
 * Принудительное обновление: текущая версия ниже минимально поддерживаемой.
 * Если minVersion не задана или невалидна — принуждения нет (false).
 */
export function isBelowMinimum(current: string, minVersion?: string | null): boolean {
  if (!minVersion) return false;
  try {
    return compareVersions(current, minVersion) < 0;
  } catch {
    return false;
  }
}
