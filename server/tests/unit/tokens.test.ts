import { describe, expect, it, vi } from 'vitest';
import {
  generateToken,
  hashToken,
  redact,
  safeEqual,
  signValue,
  unsignValue,
  verifyHmacSha256Hex,
  hmacSha256Hex,
} from '../../src/lib/tokens.js';

const SECRET = 'unit-test-secret-value-0123456789abcdef';

describe('сессионные токены', () => {
  it('генерирует уникальные URL-safe токены достаточной длины', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(40);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('в БД хранится хэш, а не сам токен', () => {
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(hashToken(token)).toBe(hash);
  });
});

describe('постоянное по времени сравнение', () => {
  it('совпадение и несовпадение', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('abc', '')).toBe(false);
  });
});

describe('HMAC-подписи', () => {
  it('проверяет подпись, в том числе с префиксом sha256=', () => {
    const payload = '{"orderId":"ord_1"}';
    const sig = hmacSha256Hex(SECRET, payload);
    expect(verifyHmacSha256Hex(SECRET, payload, sig)).toBe(true);
    expect(verifyHmacSha256Hex(SECRET, payload, `sha256=${sig}`)).toBe(true);
    expect(verifyHmacSha256Hex(SECRET, payload, sig.replace(/.$/, '0'))).toBe(false);
    expect(verifyHmacSha256Hex('other-secret', payload, sig)).toBe(false);
    expect(verifyHmacSha256Hex(SECRET, payload, '')).toBe(false);
  });

  it('подпись зависит от тела: изменение байтов ломает проверку', () => {
    const sig = hmacSha256Hex(SECRET, '{"amount":29900}');
    expect(verifyHmacSha256Hex(SECRET, '{"amount":1}', sig)).toBe(false);
  });
});

describe('подписанные короткоживущие значения (OAuth state)', () => {
  it('цикл подпись/распаковка', () => {
    const signed = signValue(SECRET, 'google|/manage', 60);
    expect(unsignValue(SECRET, signed)).toBe('google|/manage');
  });

  it('чужой секрет не распаковывает значение', () => {
    const signed = signValue(SECRET, 'google|/manage', 60);
    expect(unsignValue('another-secret-value-0123456789abcdef', signed)).toBeNull();
  });

  it('изменение содержимого ломает подпись', () => {
    const signed = signValue(SECRET, 'google|/manage', 60);
    const tampered = signed.slice(0, -2) + 'zz';
    expect(unsignValue(SECRET, tampered)).toBeNull();
  });

  it('просроченное значение отклоняется', () => {
    vi.useFakeTimers();
    try {
      const signed = signValue(SECRET, 'google|/manage', 5);
      vi.advanceTimersByTime(6000);
      expect(unsignValue(SECRET, signed)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('мусор на входе не вызывает исключений', () => {
    expect(unsignValue(SECRET, '')).toBeNull();
    expect(unsignValue(SECRET, 'no-dots')).toBeNull();
    expect(unsignValue(SECRET, '!!!.%%%')).toBeNull();
  });
});

describe('маскирование секретов в логах', () => {
  it('не раскрывает значение', () => {
    expect(redact('sk_test_1234567890')).not.toContain('sk_test_123');
    expect(redact('sk_test_1234567890')).toMatch(/\*+7890$/);
    expect(redact(null)).toBe('—');
    expect(redact('ab')).toBe('**');
  });
});
