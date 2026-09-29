import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/core/rate-limit.js';

describe('RateLimiter', () => {
  it('allows a burst up to capacity, then rejects with Retry-After', () => {
    const t = 0;
    const rl = RateLimiter.perMinute(3, () => t);
    expect(rl.consume('a').allowed).toBe(true);
    expect(rl.consume('a').allowed).toBe(true);
    const third = rl.consume('a');
    expect(third).toMatchObject({ allowed: true, remaining: 0 });
    const denied = rl.consume('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(20); // 3/min => one token every 20 s
  });

  it('refills over time and never exceeds capacity', () => {
    let t = 0;
    const rl = RateLimiter.perMinute(60, () => t);
    for (let i = 0; i < 60; i++) rl.consume('a');
    expect(rl.consume('a').allowed).toBe(false);
    t += 1000;
    expect(rl.consume('a').allowed).toBe(true);
    t += 3_600_000;
    expect(rl.consume('a').remaining).toBe(59);
  });

  it('keeps separate buckets per key', () => {
    const rl = RateLimiter.perMinute(1, () => 0);
    expect(rl.consume('a').allowed).toBe(true);
    expect(rl.consume('a').allowed).toBe(false);
    expect(rl.consume('b').allowed).toBe(true);
  });

  it('evicts idle buckets', () => {
    let t = 0;
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 1, idleTtlMs: 1000, now: () => t });
    rl.consume('a');
    rl.consume('b');
    t = 120_000;
    rl.consume('c');
    expect(rl.size).toBe(1);
  });
});
