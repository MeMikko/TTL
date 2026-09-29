import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { ApiError } from '../../core/errors.js';
import type { RateLimiter, RateLimitResult } from '../../core/rate-limit.js';
import type { AppEnv } from '../context.js';

export function applyRateLimit(c: Context, result: RateLimitResult) {
  c.header('RateLimit-Limit', String(result.limit));
  c.header('RateLimit-Remaining', String(result.remaining));
  if (!result.allowed) {
    throw new ApiError(429, 'rate_limited', 'Too many requests', undefined, {
      'Retry-After': String(result.retryAfterSeconds),
    });
  }
}

export function rateLimitBy(limiter: RateLimiter, keyOf: (c: Context<AppEnv>) => string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    applyRateLimit(c, limiter.consume(keyOf(c)));
    await next();
  });
}
