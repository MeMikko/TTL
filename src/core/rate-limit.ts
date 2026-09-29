export interface RateLimitResult {
  allowed: boolean;
  /** Whole tokens left after this request. */
  remaining: number;
  /** Seconds until one token is available again (0 when allowed). */
  retryAfterSeconds: number;
  limit: number;
}

export interface RateLimiterOptions {
  /** Bucket size, i.e. the burst allowed. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
  /** Buckets idle for longer than this are dropped to bound memory. */
  idleTtlMs?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-memory token bucket keyed by an arbitrary string. Suitable for a single api process;
 * swap for a shared store if the api is ever scaled horizontally.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly idleTtlMs: number;
  private lastSweep: number;

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.idleTtlMs = opts.idleTtlMs ?? 10 * 60_000;
    this.lastSweep = this.now();
  }

  /** Convenience: N requests per minute with a burst of N. */
  static perMinute(n: number, now?: () => number): RateLimiter {
    return new RateLimiter({ capacity: n, refillPerSecond: n / 60, now });
  }

  consume(key: string, cost = 1): RateLimitResult {
    const t = this.now();
    this.maybeSweep(t);
    const { capacity, refillPerSecond } = this.opts;
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: t };
    bucket.tokens = Math.min(
      capacity,
      bucket.tokens + ((t - bucket.updatedAt) / 1000) * refillPerSecond,
    );
    bucket.updatedAt = t;
    this.buckets.set(key, bucket);

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterSeconds: 0,
        limit: capacity,
      };
    }
    const deficit = cost - bucket.tokens;
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(deficit / refillPerSecond)),
      limit: capacity,
    };
  }

  get size(): number {
    return this.buckets.size;
  }

  private maybeSweep(t: number) {
    if (t - this.lastSweep < 60_000) return;
    this.lastSweep = t;
    for (const [key, b] of this.buckets) {
      if (t - b.updatedAt > this.idleTtlMs) this.buckets.delete(key);
    }
  }
}
