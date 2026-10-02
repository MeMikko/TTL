import { describe, expect, it } from 'vitest';
import { checkFreshness, getJsonPath, parseTimestampMs } from '../../src/core/freshness.js';

describe('getJsonPath', () => {
  const obj = { a: { b: [{ c: 1 }, { c: 2 }] }, ts: 't' };
  it('walks dotted paths and array indices', () => {
    expect(getJsonPath(obj, 'ts')).toBe('t');
    expect(getJsonPath(obj, 'a.b[0].c')).toBe(1);
    expect(getJsonPath(obj, 'a.b[1].c')).toBe(2);
  });
  it('returns undefined for missing or mistyped segments', () => {
    expect(getJsonPath(obj, 'a.x')).toBeUndefined();
    expect(getJsonPath(obj, 'a.b[9].c')).toBeUndefined();
    expect(getJsonPath(obj, 'ts.nope')).toBeUndefined();
    expect(getJsonPath(obj, 'a[0]')).toBeUndefined(); // a is an object, not an array
  });
});

describe('parseTimestampMs', () => {
  it('parses ISO strings and unix seconds/ms', () => {
    expect(parseTimestampMs('2026-10-02T00:00:00Z')).toBe(Date.parse('2026-10-02T00:00:00Z'));
    expect(parseTimestampMs(1_700_000_000)).toBe(1_700_000_000_000); // seconds → ms
    expect(parseTimestampMs(1_700_000_000_000)).toBe(1_700_000_000_000); // already ms
    expect(parseTimestampMs('1700000000')).toBe(1_700_000_000_000);
  });
  it('rejects non-timestamps', () => {
    expect(parseTimestampMs('not a date')).toBeNull();
    expect(parseTimestampMs(null)).toBeNull();
    expect(parseTimestampMs({})).toBeNull();
    expect(parseTimestampMs('')).toBeNull();
  });
});

describe('checkFreshness', () => {
  const now = new Date('2026-10-02T12:00:00Z');
  const body = (ageSeconds: number) =>
    JSON.stringify({
      data: { updatedAt: new Date(now.getTime() - ageSeconds * 1000).toISOString() },
    });

  it('passes a fresh timestamp and fails a stale one', () => {
    expect(checkFreshness(body(30), 'data.updatedAt', 120, now).ok).toBe(true);
    const stale = checkFreshness(body(300), 'data.updatedAt', 120, now);
    expect(stale.ok).toBe(false);
    expect(stale.detail).toMatch(/^stale: data\.updatedAt \d+s old, max 120$/);
  });

  it('fails on non-JSON, a missing field, or a non-timestamp value', () => {
    expect(checkFreshness('not json', 'data.updatedAt', 120, now).ok).toBe(false);
    expect(checkFreshness('{"data":{}}', 'data.updatedAt', 120, now).detail).toMatch(/not found/);
    expect(checkFreshness('{"data":{"updatedAt":"x"}}', 'data.updatedAt', 120, now).detail).toMatch(
      /not a timestamp/,
    );
  });

  it('accepts a future timestamp (clock skew is not staleness)', () => {
    expect(checkFreshness(body(-10), 'data.updatedAt', 120, now).ok).toBe(true);
  });
});
