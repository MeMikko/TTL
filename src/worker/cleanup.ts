import { lt, sql } from 'drizzle-orm';
import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';

export const IDEMPOTENCY_TTL_MS = 24 * 3600_000;
/** Used/expired challenges are kept briefly for debugging, then removed. */
export const NONCE_GRACE_MS = 3600_000;

export interface CleanupResult {
  nonces: number;
  idempotencyKeys: number;
}

/** Deletes expired short-lived rows. Longer retention (30-day run history) is added in phase 2/3. */
export async function cleanupExpired(db: Db, now = new Date()): Promise<CleanupResult> {
  const nonces = await db
    .delete(schema.authNonces)
    .where(lt(schema.authNonces.expiresAt, new Date(now.getTime() - NONCE_GRACE_MS)))
    .returning({ n: sql`1` });
  const idem = await db
    .delete(schema.idempotencyKeys)
    .where(lt(schema.idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)))
    .returning({ n: sql`1` });
  return { nonces: nonces.length, idempotencyKeys: idem.length };
}
