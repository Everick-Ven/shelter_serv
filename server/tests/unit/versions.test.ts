import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  isBelowMinimum,
  isNewer,
  isValidVersion,
  parseVersion,
} from '../../src/domain/versions.js';

describe('формат версий — только числовые X.Y.Z / vX.Y.Z', () => {
  it.each(['1.0.0', 'v1.0.0', '0.1.2', '12.34.5678', 'v2026.1.1'])('принимает %s', (v) => {
    expect(isValidVersion(v)).toBe(true);
  });

  it.each([
    '1.0',
    '1',
    '1.0.0-beta',
    '1.0.0+build',
    'v1.0.0-rc1',
    'latest',
    '',
    '  ',
    '1.0.0.0',
    'vv1.0.0',
    null,
    undefined,
    123,
    {},
  ])('отклоняет %s', (v) => {
    expect(isValidVersion(v)).toBe(false);
  });

  it('нормализует префикс v', () => {
    expect(parseVersion('v1.2.3')?.canonical).toBe('1.2.3');
    expect(parseVersion('1.2.3')?.canonical).toBe('1.2.3');
  });
});

describe('сравнение версий', () => {
  it('сравнивает по major/minor/patch', () => {
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1);
    expect(compareVersions('1.1.0', '1.0.9')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  it('isNewer устойчив к невалидным версиям', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0-beta', '1.0.0')).toBe(false);
    expect(isNewer('1.1.0', 'garbage')).toBe(false);
  });

  it('бросает исключение на невалидном формате в compareVersions', () => {
    expect(() => compareVersions('abc', '1.0.0')).toThrow(/Invalid version/);
  });
});

describe('принудительное обновление', () => {
  it('версия ниже минимальной => forceUpdate', () => {
    expect(isBelowMinimum('0.9.9', '1.0.0')).toBe(true);
    expect(isBelowMinimum('1.0.0', '1.0.0')).toBe(false);
    expect(isBelowMinimum('1.2.0', '1.0.0')).toBe(false);
  });

  it('без minVersion принуждения нет', () => {
    expect(isBelowMinimum('0.0.1', null)).toBe(false);
    expect(isBelowMinimum('0.0.1', undefined)).toBe(false);
    expect(isBelowMinimum('0.0.1', '')).toBe(false);
  });

  it('невалидная minVersion не включает принуждение', () => {
    expect(isBelowMinimum('1.0.0', 'not-a-version')).toBe(false);
  });
});
