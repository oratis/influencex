import { describe, it, expect } from 'vitest';
import { toLocalInputValue, localInputValueToIso, ymdLocal } from './datetime';

// These tests avoid hardcoding a timezone: they build Dates from LOCAL parts
// and assert through round-trips, so they pass in any runner TZ (UTC, UTC+8,
// DST-observing zones, ...).

describe('toLocalInputValue', () => {
  it('formats a Date using local date parts with zero-padding', () => {
    expect(toLocalInputValue(new Date(2026, 2, 15, 9, 5))).toBe('2026-03-15T09:05');
    expect(toLocalInputValue(new Date(2026, 0, 2, 3, 4))).toBe('2026-01-02T03:04');
  });

  it('accepts an ISO string and yields the same local value as the Date', () => {
    const d = new Date(2026, 7, 8, 22, 45);
    expect(toLocalInputValue(d.toISOString())).toBe(toLocalInputValue(d));
  });

  it('never shifts the wall-clock time (unlike toISOString().slice)', () => {
    // 00:30 local on Jan 1 must stay Jan 1 00:30 in the input, regardless of
    // the UTC offset (the old toISOString() seeding shifted it by the offset).
    const d = new Date(2026, 0, 1, 0, 30);
    expect(toLocalInputValue(d)).toBe('2026-01-01T00:30');
  });

  it('returns empty string for invalid input', () => {
    expect(toLocalInputValue('not-a-date')).toBe('');
    expect(toLocalInputValue(new Date(NaN))).toBe('');
  });
});

describe('localInputValueToIso', () => {
  it('round-trips a winter (standard-time) instant to the same UTC ISO', () => {
    const d = new Date(2026, 0, 15, 8, 30); // minute precision, 0s/0ms
    expect(localInputValueToIso(toLocalInputValue(d))).toBe(d.toISOString());
  });

  it('round-trips a summer (DST, where observed) instant to the same UTC ISO', () => {
    const d = new Date(2026, 6, 15, 22, 45);
    expect(localInputValueToIso(toLocalInputValue(d))).toBe(d.toISOString());
  });

  it('returns empty string for empty or invalid values', () => {
    expect(localInputValueToIso('')).toBe('');
    expect(localInputValueToIso(null)).toBe('');
    expect(localInputValueToIso('garbage')).toBe('');
  });
});

describe('ymdLocal', () => {
  it('buckets by local calendar day, not UTC day', () => {
    // 23:30 local Dec 31 must stay Dec 31; toISOString-based bucketing would
    // put it on Jan 1 for any zone west of UTC (and the mirror case east).
    expect(ymdLocal(new Date(2026, 11, 31, 23, 30))).toBe('2026-12-31');
    expect(ymdLocal(new Date(2026, 5, 1, 0, 15))).toBe('2026-06-01');
  });

  it('accepts ISO strings and matches the Date form', () => {
    const d = new Date(2026, 3, 10, 7, 59);
    expect(ymdLocal(d.toISOString())).toBe(ymdLocal(d));
  });

  it('returns empty string for invalid input', () => {
    expect(ymdLocal('nope')).toBe('');
  });
});
