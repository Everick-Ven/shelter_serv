import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Пароли администраторов: scrypt (N=2^14, r=8, p=1, 64 байта) с уникальной солью.
 * Формат хранения: `scrypt$<N>$<salt hex>$<hash hex>`.
 *
 * Никаких plaintext-паролей в БД, логах и ответах API. Проверка — только
 * через timingSafeEqual; при отсутствии аккаунта всё равно выполняется
 * «пустая» проверка, чтобы время ответа не раскрывало существование email.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

export const DEMO_ADMIN_EMAIL = 'admin@shelter.local';
/** Демо-вход локальной панели: логин `admin`, пароль `1234567890`. */
export const DEMO_ADMIN_LOGIN = 'admin';
export const DEMO_ADMIN_PASSWORD = '1234567890';

export function hashPassword(plain: string): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptSync(Buffer.from(plain, 'utf8'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n < 1024) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (!salt.length || !expected.length || expected.length !== KEY_LEN) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(Buffer.from(plain, 'utf8'), salt, KEY_LEN, {
      N: n,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

/**
 * Хэш-заглушка для несуществующих аккаунтов: проверка всё равно занимает
 * время scrypt, поэтому тайминг не отличает «нет email» от «неверный пароль».
 */
const DUMMY_HASH = hashPassword('shelter-dummy-password-for-timing');

export function verifyPasswordConstantTime(plain: string, stored: string | null | undefined): boolean {
  return verifyPassword(plain, stored ?? DUMMY_HASH) && Boolean(stored);
}
