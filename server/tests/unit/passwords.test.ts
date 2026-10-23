import { describe, expect, it } from 'vitest';
import {
  DEMO_ADMIN_PASSWORD,
  hashPassword,
  verifyPassword,
  verifyPasswordConstantTime,
} from '../../src/lib/passwords.js';

describe('passwords (scrypt)', () => {
  it('хэш проверяется своим паролем и не проверяется чужим', () => {
    const hash = hashPassword('correct horse battery staple');
    expect(verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(verifyPassword('Correct horse battery staple', hash)).toBe(false);
    expect(verifyPassword('', hash)).toBe(false);
  });

  it('соль уникальна: одинаковые пароли дают разные хэши', () => {
    const a = hashPassword('same-password');
    const b = hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(verifyPassword('same-password', a)).toBe(true);
    expect(verifyPassword('same-password', b)).toBe(true);
  });

  it('plaintext не присутствует в хэше', () => {
    const pwd = 'shelter-demo-admin';
    expect(hashPassword(pwd)).not.toContain(pwd);
    expect(hashPassword(pwd).startsWith('scrypt$16384$')).toBe(true);
  });

  it('повреждённый/чужеродный хэш отклоняется без исключений', () => {
    expect(verifyPassword('x', null)).toBe(false);
    expect(verifyPassword('x', '')).toBe(false);
    expect(verifyPassword('x', 'bcrypt$2a$10$whatever')).toBe(false);
    expect(verifyPassword('x', 'scrypt$16$aa$bb')).toBe(false);
    expect(verifyPassword('x', 'scrypt$16384$zz$bb')).toBe(false); // не-hex соль
    expect(verifyPassword('x', 'scrypt$16384$' + '00'.repeat(16) + '$ff')).toBe(false);
  });

  it('constant-time обёртка: без хэша ответ false, тайминговая ветка выполняется', () => {
    expect(verifyPasswordConstantTime('any', null)).toBe(false);
    expect(verifyPasswordConstantTime('any', undefined)).toBe(false);
    const hash = hashPassword(DEMO_ADMIN_PASSWORD);
    expect(verifyPasswordConstantTime(DEMO_ADMIN_PASSWORD, hash)).toBe(true);
    expect(verifyPasswordConstantTime('other', hash)).toBe(false);
  });
});
