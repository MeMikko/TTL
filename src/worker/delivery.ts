import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';
import type { JobRun } from '../core/db/schema.js';
import { SIGNATURE_HEADER, signPayload } from '../core/hmac.js';
import { decryptHeaders } from '../core/jobs.js';
import type { Logger } from '../core/logger.js';
import type { RateLimiter } from '../core/rate-limit.js';
import { getOrCreateWebhookSecret } from '../core/webhook-secret.js';
import type { HttpClient, OutboundResult } from './http-client.js';

/** Longest allowed job timeout plus margin; a run still "running" after this is reclaimed. */
export const LEASE_MS = 30_000 + 60_000;
const BACKOFF_BASE_MS = 10_000;
const BACKOFF_CAP_MS = 3600_000;

export interface DeliveryDeps {
  db: Db;
  client: HttpClient;
  encryptionKey: Buffer;
  hostLimiter: RateLimiter;
  logger: Logger;
  now?: () => Date;
  random?: () => number;
}

/** Exponential backoff with ±20 % jitter: 10 s, 20 s, 40 s … capped at 1 h. Retry-After wins if longer. */
export function backoffMs(
  attempt: number,
  retryAfterSeconds?: number,
  random = Math.random,
): number {
  const exp = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jittered = exp * (0.8 + 0.4 * random());
  const hinted =
    retryAfterSeconds !== undefined ? Math.min(BACKOFF_CAP_MS, retryAfterSeconds * 1000) : 0;
  return Math.round(Math.max(jittered, hinted));
}

export type Outcome = 'success' | 'retry' | 'fail';

/** 2xx succeeds; network errors, timeouts, 408/425/429 and 5xx are retried; the rest fail fast. */
export function classifyResult(r: OutboundResult): Outcome {
  if (r.failure)
    return r.failure.kind === 'timeout' || r.failure.kind === 'network' ? 'retry' : 'fail';
  const s = r.status ?? 0;
  if (s >= 200 && s < 300) return 'success';
  if (s === 408 || s === 425 || s === 429 || s >= 500) return 'retry';
  return 'fail';
}

/** Claims due runs (and runs whose lease expired) for this worker. */
export async function claimRuns(db: Db, limit: number, now: Date): Promise<JobRun[]> {
  if (limit <= 0) return [];
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const result = await db.execute(sql`
    with c as (
      select id from job_runs
      where (status = 'pending' and next_attempt_at <= ${now})
         or (status = 'running' and locked_until < ${now})
      order by next_attempt_at nulls first
      limit ${limit}
      for update skip locked
    )
    update job_runs r
    set status = 'running', attempts = r.attempts + 1, locked_until = ${leaseUntil},
        started_at = coalesce(r.started_at, ${now})
    from c where r.id = c.id
    returning r.id`);
  const ids = result.rows.map((r) => r.id as string);
  if (ids.length === 0) return [];
  return db.select().from(schema.jobRuns).where(inArray(schema.jobRuns.id, ids));
}

async function finish(
  db: Db,
  run: JobRun,
  status: 'succeeded' | 'failed' | 'cancelled',
  now: Date,
  fields: { lastHttpStatus?: number | null; lastError?: string | null } = {},
) {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.jobRuns)
      .set({ status, finishedAt: now, lockedUntil: null, nextAttemptAt: null, ...fields })
      .where(eq(schema.jobRuns.id, run.id));
    if (status !== 'cancelled') {
      await tx
        .update(schema.jobs)
        .set({ lastRunAt: now, lastRunStatus: status })
        .where(eq(schema.jobs.id, run.jobId));
    }
  });
}

/** Executes one claimed run: one HTTP attempt, logged, then success/retry/fail bookkeeping. */
export async function processRun(
  deps: DeliveryDeps,
  run: JobRun,
): Promise<Outcome | 'deferred' | 'cancelled'> {
  const { db, logger } = deps;
  const now = deps.now ?? (() => new Date());

  const [row] = await db
    .select({ job: schema.jobs, account: schema.accounts })
    .from(schema.jobs)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.jobs.accountId))
    .where(eq(schema.jobs.id, run.jobId));
  if (!row) return 'cancelled'; // job deleted; its runs are removed by cascade
  const { job, account } = row;

  if (account.status === 'frozen' || job.status === 'paused') {
    await finish(db, run, 'cancelled', now(), {
      lastError: account.status === 'frozen' ? 'account frozen' : 'job paused',
    });
    return 'cancelled';
  }
  if (run.attempts > run.maxAttempts) {
    // Only reachable when a worker died mid-attempt after the last allowed attempt.
    await finish(db, run, 'failed', now(), { lastError: 'delivery interrupted (lease expired)' });
    return 'fail';
  }

  // Global per-host limit across all accounts: defer without consuming an attempt.
  const host = new URL(job.url).host;
  const limit = deps.hostLimiter.consume(`host:${host}`);
  if (!limit.allowed) {
    await db
      .update(schema.jobRuns)
      .set({
        status: 'pending',
        attempts: sql`${schema.jobRuns.attempts} - 1`,
        lockedUntil: null,
        nextAttemptAt: new Date(now().getTime() + limit.retryAfterSeconds * 1000),
      })
      .where(eq(schema.jobRuns.id, run.id));
    logger.warn({ runId: run.id, host }, 'target host rate limit reached; delivery deferred');
    return 'deferred';
  }

  const secret = await getOrCreateWebhookSecret(db, deps.encryptionKey, account.id);
  const body = job.body ?? '';
  const startedAt = now();
  const timestamp = Math.floor(startedAt.getTime() / 1000);
  const result = await deps.client.send({
    url: job.url,
    method: job.method,
    userHeaders: decryptHeaders(deps.encryptionKey, job),
    systemHeaders: {
      [SIGNATURE_HEADER]: signPayload(secret, body, timestamp),
      'T2L-Delivery-Id': run.id,
      'T2L-Attempt': String(run.attempts),
      'T2L-Event': 'job.run',
      'T2L-Job-Id': job.id,
      'T2L-Scheduled-For': run.scheduledFor.toISOString(),
    },
    body: job.body,
    timeoutMs: job.timeoutMs,
  });

  const errorText = result.failure ? `${result.failure.kind}: ${result.failure.message}` : null;
  await db.insert(schema.jobAttempts).values({
    runId: run.id,
    attempt: run.attempts,
    startedAt,
    durationMs: result.durationMs,
    httpStatus: result.status ?? null,
    responseSnippet: result.responseSnippet ?? null,
    errorKind: result.failure?.kind ?? null,
    error: result.failure?.message ?? null,
    finalUrl: result.finalUrl,
  });

  const outcome = classifyResult(result);
  const lastError = errorText ?? (outcome === 'success' ? null : `HTTP ${result.status}`);
  const fields = { lastHttpStatus: result.status ?? null, lastError };
  if (outcome === 'success') {
    await finish(db, run, 'succeeded', now(), fields);
  } else if (outcome === 'retry' && run.attempts < run.maxAttempts) {
    await db
      .update(schema.jobRuns)
      .set({
        status: 'pending',
        lockedUntil: null,
        nextAttemptAt: new Date(
          now().getTime() + backoffMs(run.attempts, result.retryAfterSeconds, deps.random),
        ),
        ...fields,
      })
      .where(eq(schema.jobRuns.id, run.id));
  } else {
    await finish(db, run, 'failed', now(), fields);
  }
  logger.debug(
    { runId: run.id, attempt: run.attempts, outcome, status: result.status },
    'delivery attempt',
  );
  return outcome;
}
