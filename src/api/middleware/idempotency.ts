import { createHash } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import type { AppDeps, AppEnv } from '../context.js';

const KEY_FORMAT = /^[\x21-\x7e]{1,255}$/; // printable ASCII, no spaces
/** An in-progress record older than this is assumed abandoned (crashed request) and replaced. */
const STALE_IN_PROGRESS_MS = 5 * 60_000;

/**
 * Optional `Idempotency-Key` support for create endpoints (must run after requireAuth).
 * - First request: recorded as in-progress, executed, response stored (5xx responses are not
 *   stored so the client can retry).
 * - Same key + same request: stored response replayed with `Idempotent-Replayed: true`.
 * - Same key + different request: 422. Same key while the first is still running: 409.
 */
export function idempotency(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const t = schema.idempotencyKeys;

  return createMiddleware<AppEnv>(async (c, next) => {
    const key = c.req.header('idempotency-key');
    if (key === undefined) return next();
    if (!KEY_FORMAT.test(key)) {
      throw new ApiError(
        400,
        'invalid_idempotency_key',
        'Idempotency-Key must be 1-255 printable ASCII characters',
      );
    }

    const accountId = c.get('account').id;
    const body = await c.req.text();
    const requestHash = createHash('sha256')
      .update(`${c.req.method}\n${c.req.path}\n${body}`)
      .digest('hex');
    const where = and(eq(t.accountId, accountId), eq(t.key, key));

    const claim = () =>
      db
        .insert(t)
        .values({ accountId, key, requestHash, createdAt: now() })
        .onConflictDoNothing()
        .returning({ key: t.key });

    let [claimed] = await claim();
    if (!claimed) {
      const [existing] = await db.select().from(t).where(where);
      if (!existing) {
        [claimed] = await claim(); // deleted concurrently (5xx cleanup); try once more
      } else if (existing.requestHash !== requestHash) {
        throw new ApiError(
          422,
          'idempotency_key_reused',
          'Idempotency-Key was already used with a different request',
        );
      } else if (existing.statusCode !== null) {
        return new Response(existing.responseBody, {
          status: existing.statusCode,
          headers: { 'content-type': 'application/json', 'idempotent-replayed': 'true' },
        });
      } else if (now().getTime() - existing.createdAt.getTime() > STALE_IN_PROGRESS_MS) {
        await db
          .delete(t)
          .where(
            and(
              where,
              isNull(t.statusCode),
              lt(t.createdAt, new Date(now().getTime() - STALE_IN_PROGRESS_MS)),
            ),
          );
        [claimed] = await claim();
      }
      if (!claimed) {
        throw new ApiError(
          409,
          'idempotency_in_progress',
          'A request with this Idempotency-Key is still in progress',
        );
      }
    }

    try {
      await next();
    } catch (err) {
      await db.delete(t).where(where);
      throw err;
    }

    // Handler errors have already been rendered by onError at this point, so c.res is final.
    const res = c.res;
    if (res.status >= 500) {
      await db.delete(t).where(where);
      return;
    }
    const text = await res.clone().text();
    await db.update(t).set({ statusCode: res.status, responseBody: text }).where(where);
  });
}
