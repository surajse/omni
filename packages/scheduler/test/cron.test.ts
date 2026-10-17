import { describe, expect, it } from 'vitest';
import { matchesCron, validateCron } from '../src/cron.js';

// Fixed local-time dates (months are 0-based in the Date constructor).
const MON_10_30 = new Date(2026, 9, 19, 10, 30); // Mon 2026-10-19 10:30
const SUN_00_05 = new Date(2026, 9, 18, 0, 5); // Sun 2026-10-18 00:05

describe('matchesCron', () => {
  it('matches * * * * * always', () => {
    expect(matchesCron('* * * * *', MON_10_30)).toBe(true);
    expect(matchesCron('* * * * *', SUN_00_05)).toBe(true);
  });

  it('matches exact values', () => {
    expect(matchesCron('30 10 * * *', MON_10_30)).toBe(true);
    expect(matchesCron('31 10 * * *', MON_10_30)).toBe(false);
    expect(matchesCron('30 11 * * *', MON_10_30)).toBe(false);
  });

  it('supports steps (*/n)', () => {
    expect(matchesCron('*/5 * * * *', MON_10_30)).toBe(true); // 30 % 5
    expect(matchesCron('*/7 * * * *', MON_10_30)).toBe(false); // 30 % 7
    expect(matchesCron('*/15 10 * * *', MON_10_30)).toBe(true);
  });

  it('supports lists and ranges', () => {
    expect(matchesCron('15,30,45 * * * *', MON_10_30)).toBe(true);
    expect(matchesCron('0-10 * * * *', MON_10_30)).toBe(false);
    expect(matchesCron('25-35 * * * *', MON_10_30)).toBe(true);
    expect(matchesCron('0-30/10 * * * *', MON_10_30)).toBe(true); // 0,10,20,30
    expect(matchesCron('1-30/10 * * * *', MON_10_30)).toBe(false); // 1,11,21
  });

  it('matches day of month and month', () => {
    expect(matchesCron('* * 19 * *', MON_10_30)).toBe(true);
    expect(matchesCron('* * 20 * *', MON_10_30)).toBe(false);
    expect(matchesCron('* * * 10 *', MON_10_30)).toBe(true); // October
    expect(matchesCron('* * * 11 *', MON_10_30)).toBe(false);
  });

  it('matches day of week (0 and 7 are Sunday)', () => {
    expect(matchesCron('* * * * 1', MON_10_30)).toBe(true); // Monday
    expect(matchesCron('* * * * 0', MON_10_30)).toBe(false);
    expect(matchesCron('* * * * 0', SUN_00_05)).toBe(true);
    expect(matchesCron('* * * * 7', SUN_00_05)).toBe(true);
    expect(matchesCron('* * * * 6-7', SUN_00_05)).toBe(true);
  });

  it('dom/dow use OR semantics when both are restricted', () => {
    // 19th is a Monday here: dom matches, dow does not.
    expect(matchesCron('* * 19 * 0', MON_10_30)).toBe(true);
    // Neither matches.
    expect(matchesCron('* * 20 * 0', MON_10_30)).toBe(false);
  });
});

describe('validateCron', () => {
  it('accepts valid expressions', () => {
    expect(() => validateCron('*/5 * * * *')).not.toThrow();
    expect(() => validateCron('0 9 * * 1-5')).not.toThrow();
    expect(() => validateCron('0 0 1 1 *')).not.toThrow();
  });

  it('rejects malformed expressions', () => {
    expect(() => validateCron('* * * *')).toThrow(/5 fields/);
    expect(() => validateCron('* * * * * *')).toThrow(/5 fields/);
    expect(() => validateCron('60 * * * *')).toThrow(/out of range/);
    expect(() => validateCron('*/0 * * * *')).toThrow(/bad step/);
    expect(() => validateCron('10-5 * * * *')).toThrow(/reversed/);
    expect(() => validateCron('x * * * *')).toThrow(/not a number/);
    expect(() => validateCron('* * * 13 *')).toThrow(/out of range/);
    expect(() => validateCron('* * * * 8')).toThrow(/out of range/);
    expect(() => validateCron('')).toThrow();
  });
});
