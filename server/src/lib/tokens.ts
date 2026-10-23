import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Сессионный токен: клиенту уходит случайный `token`, в БД хранится только
 * SHA-256 хэш. Утечка базы не даёт возможности войти.
 */

export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function generateOpaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('base64url')}`;
}

/** Постоянное по времени сравнение строк (для подписей и секретов). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a ?? '', 'utf8');
  const bufB = Buffer.from(b ?? '', 'utf8');
  if (bufA.length !== bufB.length) {
    // всё равно делаем сравнение, чтобы не течь длиной
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** HMAC-SHA256 в hex — подпись webhook'ов и state/cookie-подписи. */
export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function verifyHmacSha256Hex(secret: string, payload: string, signature: string): boolean {
  if (!signature) return false;
  const raw = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
  return safeEqual(hmacSha256Hex(secret, payload), raw.trim().toLowerCase());
}

/**
 * Подпись короткоживущих одноразовых значений (OAuth state, checkout token)
 * без хранения в БД: `value.expiry.signature`.
 */
export function signValue(secret: string, value: string, ttlSeconds: number): string {
  const expires = Date.now() + ttlSeconds * 1000;
  const body = `${value}.${expires}`;
  const sig = hmacSha256Hex(secret, body);
  return `${Buffer.from(body, 'utf8').toString('base64url')}.${sig}`;
}

export function unsignValue(secret: string, signed: string): string | null {
  if (typeof signed !== 'string' || !signed.includes('.')) return null;
  const lastDot = signed.lastIndexOf('.');
  const bodyB64 = signed.slice(0, lastDot);
  const sig = signed.slice(lastDot + 1);
  let body: string;
  try {
    body = Buffer.from(bodyB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!verifyHmacSha256Hex(secret, body, sig)) return null;
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const expires = Number(body.slice(dot + 1));
  if (!Number.isFinite(expires) || expires < Date.now()) return null;
  return body.slice(0, dot);
}

/** Маскирование для логов/админки: никогда не печатаем секрет целиком. */
export function redact(value: string | null | undefined, keep = 4): string {
  if (!value) return '—';
  if (value.length <= keep) return '*'.repeat(value.length);
  return `${'*'.repeat(Math.max(keep, value.length - keep))}${value.slice(-keep)}`;
}
