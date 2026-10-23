import { describe, expect, it } from 'vitest';
import { CURRENCY, PLANS, formatAmount, getPlan, isPlanId } from '../../src/domain/plans.js';

describe('каталог тарифов — валюта и цены из клиентского каталога', () => {
  it('месяц: 299 ₽ / 30 дней', () => {
    expect(PLANS.monthly.amountMinor).toBe(29900);
    expect(PLANS.monthly.days).toBe(30);
    expect(PLANS.monthly.currency).toBe('RUB');
  });

  it('год: 2390 ₽ / 365 дней', () => {
    expect(PLANS.yearly.amountMinor).toBe(239000);
    expect(PLANS.yearly.days).toBe(365);
    expect(PLANS.yearly.currency).toBe('RUB');
  });

  it('валюта едина для всех тарифов', () => {
    expect(CURRENCY).toBe('RUB');
    Object.values(PLANS).forEach((p) => expect(p.currency).toBe('RUB'));
  });

  it('planId валидируется по каталогу', () => {
    expect(isPlanId('monthly')).toBe(true);
    expect(isPlanId('yearly')).toBe(true);
    expect(isPlanId('lifetime')).toBe(false);
    expect(isPlanId('__proto__')).toBe(false);
    expect(isPlanId('constructor')).toBe(false);
    expect(isPlanId('')).toBe(false);
    expect(isPlanId(null)).toBe(false);
    expect(isPlanId(42)).toBe(false);
  });

  it('getPlan возвращает null для неизвестного тарифа', () => {
    expect(getPlan('monthly')).toBeTruthy();
    expect(getPlan('hacked')).toBeNull();
    expect(getPlan('toString')).toBeNull();
  });

  it('formatAmount форматирует копейки в рубли', () => {
    expect(formatAmount(29900)).toMatch(/299/);
    expect(formatAmount(29900)).toContain('₽');
    expect(formatAmount(239000)).toContain('₽');
    expect(formatAmount(100, 'USD')).toBe('1 USD');
  });
});
