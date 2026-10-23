import { describe, expect, it } from 'vitest';
import { denied, evaluateEntitlement, safeEvaluate, toPremiumStatusPayload } from '../../src/domain/entitlement.js';

const now = new Date('2026-01-15T12:00:00.000Z');
const future = new Date('2026-02-15T12:00:00.000Z');
const past = new Date('2025-12-15T12:00:00.000Z');

describe('evaluateEntitlement — единственный источник правды о премиуме', () => {
  it('выдаёт доступ по активной подписке с будущим expires_at', () => {
    const r = evaluateEntitlement({
      subscription: { status: 'active', planId: 'monthly', expiresAt: future, source: 'payment' },
      now,
    });
    expect(r.active).toBe(true);
    expect(r.reason).toBe('paid');
    expect(r.source).toBe('payment');
    expect(r.planId).toBe('monthly');
    expect(r.expiresAt).toBe(future.toISOString());
    expect(r.secondsRemaining).toBe(31 * 24 * 3600);
    expect(r.renewable).toBe(true);
  });

  it('grant администратора помечается отдельным источником и причиной', () => {
    const r = evaluateEntitlement({
      subscription: { status: 'active', planId: 'yearly', expiresAt: future, source: 'admin_grant' },
      now,
    });
    expect(r.active).toBe(true);
    expect(r.reason).toBe('granted');
    expect(r.source).toBe('admin_grant');
  });

  it('отсутствующая запись = отказ (no_subscription)', () => {
    const r = evaluateEntitlement({ subscription: null, now });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('no_subscription');
    expect(r.status).toBe('none');
  });

  it('истёкшая подписка = отказ, без grace period', () => {
    const r = evaluateEntitlement({
      subscription: { status: 'active', planId: 'monthly', expiresAt: past, source: 'payment' },
      now,
    });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('expired');
    expect(r.secondsRemaining).toBe(0);
  });

  it('expires_at ровно в текущий момент = отказ', () => {
    const r = evaluateEntitlement({
      subscription: { status: 'active', planId: 'monthly', expiresAt: now, source: 'payment' },
      now,
    });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('expired');
  });

  it.each(['cancelled', 'revoked', 'refunded', 'expired'] as const)(
    'статус %s = отказ',
    (status) => {
      const r = evaluateEntitlement({
        subscription: { status, planId: 'monthly', expiresAt: future, source: 'payment' },
        now,
      });
      expect(r.active).toBe(false);
      expect(r.reason).toBe(status);
    },
  );

  it('неизвестный статус трактуется как битые данные => отказ (fail-closed)', () => {
    const r = evaluateEntitlement({
      subscription: { status: 'ACTIVE_FOREVER', planId: 'monthly', expiresAt: future, source: 'payment' },
      now,
    });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('invalid_data');
  });

  it('пустой статус и пустой planId = отказ', () => {
    expect(
      evaluateEntitlement({ subscription: { status: '', planId: 'monthly', expiresAt: future, source: 'payment' }, now }).active,
    ).toBe(false);
    expect(
      evaluateEntitlement({ subscription: { status: 'active', planId: null, expiresAt: future, source: 'payment' }, now }).reason,
    ).toBe('invalid_data');
  });

  it('нечитаемый expires_at = отказ', () => {
    const r = evaluateEntitlement({
      subscription: { status: 'active', planId: 'monthly', expiresAt: 'not-a-date', source: 'payment' },
      now,
    });
    expect(r.active).toBe(false);
    expect(r.reason).toBe('invalid_data');
  });

  it('отказ никогда не уносит active=true даже при переопределении через extra', () => {
    const r = denied('expired', now, { status: 'expired' });
    expect(r.active).toBe(false);
    expect(r.secondsRemaining).toBe(0);
  });

  it('revoked/refunded не предлагают продление', () => {
    expect(denied('revoked', now, { status: 'revoked' }).renewable).toBe(false);
    expect(denied('refunded', now, { status: 'refunded' }).renewable).toBe(false);
    expect(denied('expired', now, { status: 'expired' }).renewable).toBe(true);
  });
});

describe('safeEvaluate — сбой проверки = отказ', () => {
  it('исключение при чтении БД приводит к verification_failed и active=false', async () => {
    const r = await safeEvaluate(async () => {
      throw new Error('db connection lost');
    }, now);
    expect(r.active).toBe(false);
    expect(r.reason).toBe('verification_failed');
    expect(r.status).toBe('none');
  });

  it('таймаут/зависание тоже трактуется как отказ', async () => {
    const r = await safeEvaluate(
      () =>
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5),
        ),
      now,
    );
    expect(r.active).toBe(false);
    expect(r.reason).toBe('verification_failed');
  });
});

describe('premium.status — замороженный формат ответа', () => {
  it('содержит ровно оговорённые поля', () => {
    const r = evaluateEntitlement({
      subscription: { status: 'active', planId: 'yearly', expiresAt: future, source: 'payment' },
      now,
    });
    expect(Object.keys(toPremiumStatusPayload(r)).sort()).toEqual(
      ['active', 'checkedAt', 'expiresAt', 'planId', 'reason', 'status'].sort(),
    );
  });

  it('при отказе planId и expiresAt = null', () => {
    const payload = toPremiumStatusPayload(evaluateEntitlement({ subscription: null, now }));
    expect(payload).toMatchObject({ active: false, planId: null, expiresAt: null, status: 'none' });
  });
});
