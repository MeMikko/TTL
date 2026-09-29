import { and, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
/** Used/expired challenges are kept briefly for debugging, then removed. */
export const NONCE_GRACE_MS = 3600_000;

/** Run history (runs + attempts) retention. */
export const HISTORY_RETENTION_MS = 30 * 24 * 3600_000;

export interface CleanupResult {
  nonces: number;
  idempotencyKeys: number;
  jobRuns: number;
}

/** Deletes expired short-lived rows and history older than the retention window. */
export async function cleanupExpired(db: Db, now = new Date()): Promise<CleanupResult> {
  const nonces = await db
    .delete(schema.authNonces)
    .where(lt(schema.authNonces.expiresAt, new Date(now.getTime() - NONCE_GRACE_MS)))
    .returning({ n: sql`1` });
  const idem = await db
    .delete(schema.idempotencyKeys)
    .where(lt(schema.idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)))
    .returning({ n: sql`1` });
  // Only finished runs; attempts are removed by cascade.
  const runs = await db
    .delete(schema.jobRuns)
    .where(
      and(
        lt(schema.jobRuns.createdAt, new Date(now.getTime() - HISTORY_RETENTION_MS)),
        inArray(schema.jobRuns.status, ['succeeded', 'failed', 'skipped', 'cancelled']),
      ),
    )
    .returning({ n: sql`1` });
  return { nonces: nonces.length, idempotencyKeys: idem.length, jobRuns: runs.length };
}
