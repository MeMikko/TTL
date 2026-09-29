import { describe, expect, it } from 'vitest';
import { backoffMs, classifyResult } from '../../src/worker/delivery.js';
import type { OutboundResult } from '../../src/worker/http-client.js';

const r = (over: Partial<OutboundResult>): OutboundResult => ({
  durationMs: 1,
  finalUrl: 'https://x.example/',
  redirects: 0,
  ...over,
});

describe('classifyResult', () => {
  it.each([200, 201, 204, 299])('succeeds on %i', (status) => {
    expect(classifyResult(r({ status }))).toBe('success');
  });
  it.each([408, 425, 429, 500, 502, 503, 504])('retries on %i', (status) => {
    expect(classifyResult(r({ status }))).toBe('retry');
  });
  it.each([301, 400, 401, 403, 404, 410, 422])('fails fast on %i', (status) => {
    expect(classifyResult(r({ status }))).toBe('fail');
  });
  it('retries timeouts and network errors, not policy violations', () => {
    expect(classifyResult(r({ failure: { kind: 'timeout', message: '' } }))).toBe('retry');
    expect(classifyResult(r({ failure: { kind: 'network', message: '' } }))).toBe('retry');
    expect(classifyResult(r({ failure: { kind: 'blocked_target', message: '' } }))).toBe('fail');
    expect(classifyResult(r({ failure: { kind: 'too_many_redirects', message: '' } }))).toBe(
      'fail',
    );
  });
});

describe('backoffMs', () => {
  const mid = () => 0.5; // no jitter
  it('doubles from 10 s and caps at 1 h', () => {
    expect([1, 2, 3, 4].map((a) => backoffMs(a, undefined, mid))).toEqual([
      10_000, 20_000, 40_000, 80_000,
    ]);
    expect(backoffMs(20, undefined, mid)).toBe(3_600_000);
  });
  it('applies ±20 % jitter', () => {
    expect(backoffMs(1, undefined, () => 0)).toBe(8_000);
    expect(backoffMs(1, undefined, () => 1)).toBe(12_000);
  });
  it('honours a longer Retry-After, capped at 1 h', () => {
    expect(backoffMs(1, 120, mid)).toBe(120_000);
    expect(backoffMs(1, 1, mid)).toBe(10_000);
    expect(backoffMs(1, 999_999, mid)).toBe(3_600_000);
  });
});
