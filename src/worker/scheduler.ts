import { sql } from 'drizzle-orm';
import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';
import { newId } from '../core/ids.js';
import { payForRun } from '../core/jobs.js';
import type { Logger } from '../core/logger.js';
import { nextCronRun } from '../core/schedule.js';

export interface SchedulerResult {
  queued: number;
  skipped: number;
}

interface DueJob {
  id: string;
  account_id: string;
  schedule_kind: 'cron' | 'once';
  cron_expr: string | null;
  timezone: string;
  next_run_at: Date;
  max_attempts: number;
  freshness_seconds: number | null;
  account_status: 'active' | 'frozen';
  activated_at: Date | null;
}

/**
 * Materialises due occurrences into pending runs, in one transaction per batch:
 * lock due jobs (SKIP LOCKED, so several workers can run safely), count each run against the
 * monthly quota, insert the run and advance next_run_at. Missed occurrences (e.g. after downtime)
 * are collapsed into a single run rather than replayed as a burst.
 */
export async function scheduleDueJobs(
  db: Db,
  now: Date,
  logger?: Logger,
  batchSize = 100,
): Promise<SchedulerResult> {
  return db.transaction(async (tx) => {
    const due = await tx.execute<DueJob & Record<string, unknown>>(sql`
      select j.id, j.account_id, j.schedule_kind, j.cron_expr, j.timezone, j.next_run_at,
             j.max_attempts, j.freshness_seconds, a.status as account_status, a.activated_at
      from jobs j join accounts a on a.id = j.account_id
      where j.status = 'active' and j.next_run_at <= ${now}
      order by j.next_run_at
      limit ${batchSize}
      for update of j skip locked`);

    let queued = 0;
    let skipped = 0;
    for (const job of due.rows) {
      const scheduledFor = new Date(job.next_run_at);

      // Freshness cutoff: a slot that would fire too long after its scheduled time (a catch-up
      // after downtime) is recorded as skipped rather than delivered late. Normal runs are at most
      // a poll interval behind, so only genuinely stale occurrences trip this.
      const lateBySeconds = Math.round((now.getTime() - scheduledFor.getTime()) / 1000);
      const stale = job.freshness_seconds != null && lateBySeconds > job.freshness_seconds;

      // Frozen accounts: advance the schedule silently, no runs and no quota use.
      if (job.account_status === 'active' && stale) {
        // Materialise as skipped (no delivery, no charge) so the stale slot is auditable.
        await tx
          .insert(schema.jobRuns)
          .values({
            id: newId('run'),
            jobId: job.id,
            accountId: job.account_id,
            trigger: 'schedule',
            scheduledFor,
            status: 'skipped',
            maxAttempts: job.max_attempts,
            nextAttemptAt: null,
            finishedAt: now,
            lastError: `stale: scheduled ${lateBySeconds}s ago, beyond freshnessSeconds=${job.freshness_seconds}`,
            createdAt: now,
          })
          .onConflictDoNothing();
        skipped++;
      } else if (job.account_status === 'active') {
        // Insert first, pay second: an occurrence that already exists is never charged twice.
        const runId = newId('run');
        const inserted = await tx
          .insert(schema.jobRuns)
          .values({
            id: runId,
            jobId: job.id,
            accountId: job.account_id,
            trigger: 'schedule',
            scheduledFor,
            status: 'pending',
            maxAttempts: job.max_attempts,
            nextAttemptAt: now,
            createdAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: schema.jobRuns.id });
        if (inserted.length === 0) {
          skipped++;
        } else if (
          await payForRun(tx, { id: job.account_id, activatedAt: job.activated_at }, runId, now)
        ) {
          queued++;
        } else {
          await tx
            .update(schema.jobRuns)
            .set({
              status: 'skipped',
              nextAttemptAt: null,
              finishedAt: now,
              lastError: 'monthly run quota exhausted and credit balance too low',
            })
            .where(sql`${schema.jobRuns.id} = ${runId}`);
          skipped++;
        }
      }

      let next: Date | null = null;
      if (job.schedule_kind === 'cron') {
        try {
          const from = scheduledFor.getTime() > now.getTime() ? scheduledFor : now;
          next = nextCronRun(job.cron_expr!, job.timezone, from);
        } catch (err) {
          logger?.error({ err, jobId: job.id }, 'cannot compute next run; pausing job');
        }
      }
      await tx
        .update(schema.jobs)
        .set({
          nextRunAt: next,
          status: next ? 'active' : job.schedule_kind === 'once' ? 'completed' : 'paused',
          updatedAt: now,
        })
        .where(sql`${schema.jobs.id} = ${job.id}`);
    }
    return { queued, skipped };
  });
}
