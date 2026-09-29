import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { hashApiKey, looksLikeApiKey } from '../../core/api-keys.js';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import type { RateLimiter } from '../../core/rate-limit.js';
import type { AppDeps, AppEnv } from '../context.js';
import { applyRateLimit } from './rate-limit.js';

const LAST_USED_RESOLUTION_MS = 60_000;

/** Authenticates `Authorization: Bearer t2l_…`, rejects frozen accounts, applies per-key limits. */
export function requireAuth(deps: AppDeps, keyLimiter: RateLimiter) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;

  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    const token = match?.[1];
    if (!token) {
      throw new ApiError(401, 'unauthorized', 'Missing bearer API key', undefined, {
        'WWW-Authenticate': 'Bearer',
      });
    }
    if (!looksLikeApiKey(token)) throw new ApiError(401, 'unauthorized', 'Invalid API key');

    const [row] = await db
      .select({ key: schema.apiKeys, account: schema.accounts })
      .from(schema.apiKeys)
      .innerJoin(schema.accounts, eq(schema.apiKeys.accountId, schema.accounts.id))
      .where(and(eq(schema.apiKeys.keyHash, hashApiKey(token)), isNull(schema.apiKeys.revokedAt)));
    if (!row) throw new ApiError(401, 'unauthorized', 'Invalid API key');

    applyRateLimit(c, keyLimiter.consume(`key:${row.key.id}`));

    if (row.account.status === 'frozen') {
      throw new ApiError(403, 'account_frozen', 'This account is frozen. Contact support.');
    }

    // Throttled bookkeeping: at most one write per key per minute.
    const t = now();
    if (
      !row.key.lastUsedAt ||
      t.getTime() - row.key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS
    ) {
      const cutoff = new Date(t.getTime() - LAST_USED_RESOLUTION_MS);
      await db
        .update(schema.apiKeys)
        .set({ lastUsedAt: t })
        .where(
          and(
            eq(schema.apiKeys.id, row.key.id),
            or(isNull(schema.apiKeys.lastUsedAt), lt(schema.apiKeys.lastUsedAt, cutoff)),
          ),
        );
    }

    c.set('account', row.account);
    c.set('apiKey', row.key);
    await next();
  });
}
