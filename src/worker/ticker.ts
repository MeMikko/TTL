import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';
import { VERSION } from '../core/version.js';

/** Upserts this worker's liveness beacon. */
export async function recordTick(db: Db, workerId: string, startedAt: Date, now = new Date()) {
  await db
    .insert(schema.workerTicks)
    .values({ workerId, lastTickAt: now, startedAt, version: VERSION })
    .onConflictDoUpdate({
      target: schema.workerTicks.workerId,
      set: { lastTickAt: now, startedAt, version: VERSION },
    });
}
