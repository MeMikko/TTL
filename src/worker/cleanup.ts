import { and, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
/** Used/expired challenges are kept briefly for debugging, then removed. */
export const NONCE_GRACE_MS = 3600_000;

/** History retention: job runs + attempts, monitor events, alert deliveries. */
export const HISTORY_RETENTION_MS = 30 * 24 * 3600_000;

export interface CleanupResult {
  nonces: number;
  idempotencyKeys: number;
  jobRuns: number;
  monitorEvents: number;
  alertDeliveries: number;
  telegramTokens: number;
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
  const historyCutoff = new Date(now.getTime() - HISTORY_RETENTION_MS);
  const events = await db
    .delete(schema.monitorEvents)
    .where(lt(schema.monitorEvents.at, historyCutoff))
    .returning({ n: sql`1` });
  const alerts = await db
    .delete(schema.alertDeliveries)
    .where(
      and(
        lt(schema.alertDeliveries.createdAt, historyCutoff),
        inArray(schema.alertDeliveries.status, ['succeeded', 'failed', 'cancelled']),
      ),
    )
    .returning({ n: sql`1` });
  const tokens = await db
    .delete(schema.telegramLinkTokens)
    .where(lt(schema.telegramLinkTokens.expiresAt, new Date(now.getTime() - NONCE_GRACE_MS)))
    .returning({ n: sql`1` });
  return {
    nonces: nonces.length,
    idempotencyKeys: idem.length,
    jobRuns: runs.length,
    monitorEvents: events.length,
    alertDeliveries: alerts.length,
    telegramTokens: tokens.length,
  };
}
