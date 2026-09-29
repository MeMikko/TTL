import { and, eq, sql } from 'drizzle-orm';
import { decrypt, encrypt } from './crypto.js';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Account, Job, JobRun } from './db/schema.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import { TIERS, tierFor } from './plans.js';
import { assertCron, nextCronRun, normalizeCron, ScheduleError } from './schedule.js';
import {
  assertResolvesToPublic,
  BlockedTargetError,
  validateTargetUrl,
  type TargetPolicy,
} from './ssrf.js';
import { tryConsumeRun } from './usage.js';

export type HttpMethod = (typeof schema.HTTP_METHODS)[number];

export type ScheduleInput =
  { type: 'cron'; expression: string; timezone: string } | { type: 'once'; at: Date };

export interface TargetInput {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body: string | null;
}

export interface JobInput {
  name: string;
  schedule: ScheduleInput;
  target: TargetInput;
  timeoutMs: number;
  maxAttempts: number;
}

export interface JobPatch {
  name?: string;
  schedule?: ScheduleInput;
  target?: Partial<TargetInput>;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface JobsDeps {
  db: Db;
  encryptionKey: Buffer;
  policy: TargetPolicy;
  maxJobsPerAccount: number;
  /** DNS resolution override for tests. */
  resolve?: Parameters<typeof assertResolvesToPublic>[2];
}

const MAX_ONCE_AHEAD_MS = 366 * 24 * 3600_000;
const ONCE_PAST_TOLERANCE_MS = 5 * 60_000;

const headersAad = (jobId: string) => `job-headers:${jobId}`;

export function encryptHeaders(key: Buffer, jobId: string, headers: Record<string, string>) {
  return Object.keys(headers).length
    ? encrypt(key, JSON.stringify(headers), headersAad(jobId))
    : null;
}

export function decryptHeaders(
  key: Buffer,
  job: Pick<Job, 'id' | 'headersEnc'>,
): Record<string, string> {
  if (!job.headersEnc) return {};
  return JSON.parse(decrypt(key, job.headersEnc, headersAad(job.id))) as Record<string, string>;
}

/** Validates the schedule and returns the first occurrence. */
function firstRun(schedule: ScheduleInput, now: Date): Date {
  try {
    if (schedule.type === 'cron') {
      assertCron(schedule.expression, schedule.timezone);
      return nextCronRun(schedule.expression, schedule.timezone, now);
    }
    const at = schedule.at.getTime();
    if (at < now.getTime() - ONCE_PAST_TOLERANCE_MS) throw new ScheduleError('`at` is in the past');
    if (at > now.getTime() + MAX_ONCE_AHEAD_MS)
      throw new ScheduleError('`at` is more than a year ahead');
    return new Date(Math.max(at, now.getTime()));
  } catch (err) {
    if (err instanceof ScheduleError) throw new ApiError(400, 'invalid_schedule', err.message);
    throw err;
  }
}

async function checkTarget(deps: JobsDeps, target: TargetInput): Promise<string> {
  if (target.body !== null && target.method === 'GET') {
    throw new ApiError(400, 'invalid_target', 'GET requests cannot have a body');
  }
  try {
    const url = validateTargetUrl(target.url, deps.policy);
    // Early feedback only; the authoritative check happens at connect time on every delivery.
    await assertResolvesToPublic(url.hostname, deps.policy, deps.resolve);
    return url.toString();
  } catch (err) {
    if (err instanceof BlockedTargetError) throw new ApiError(400, 'invalid_target', err.message);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA') {
      throw new ApiError(400, 'invalid_target', `target host does not resolve (${code})`);
    }
    throw err;
  }
}

function scheduleColumns(schedule: ScheduleInput) {
  return schedule.type === 'cron'
    ? {
        scheduleKind: 'cron' as const,
        cronExpr: normalizeCron(schedule.expression),
        timezone: schedule.timezone,
        runAt: null,
      }
    : { scheduleKind: 'once' as const, cronExpr: null, timezone: 'UTC', runAt: schedule.at };
}

export async function createJob(
  deps: JobsDeps,
  account: Account,
  input: JobInput,
  now: Date,
): Promise<Job> {
  const [{ n } = { n: 0 }] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.jobs)
    .where(eq(schema.jobs.accountId, account.id));
  if (n >= deps.maxJobsPerAccount) {
    throw new ApiError(
      409,
      'too_many_jobs',
      `An account can have at most ${deps.maxJobsPerAccount} jobs`,
    );
  }
  const nextRunAt = firstRun(input.schedule, now);
  const url = await checkTarget(deps, input.target);
  const id = newId('job');
  const [job] = await deps.db
    .insert(schema.jobs)
    .values({
      id,
      accountId: account.id,
      name: input.name,
      ...scheduleColumns(input.schedule),
      status: 'active',
      nextRunAt,
      url,
      method: input.target.method,
      headersEnc: encryptHeaders(deps.encryptionKey, id, input.target.headers),
      body: input.target.body,
      timeoutMs: input.timeoutMs,
      maxAttempts: input.maxAttempts,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return job!;
}

export async function getJob(db: Db, accountId: string, jobId: string): Promise<Job> {
  const [job] = await db
    .select()
    .from(schema.jobs)
    .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.accountId, accountId)));
  if (!job) throw new ApiError(404, 'not_found', 'Job not found');
  return job;
}

export async function updateJob(
  deps: JobsDeps,
  accountId: string,
  jobId: string,
  patch: JobPatch,
  now: Date,
): Promise<Job> {
  const job = await getJob(deps.db, accountId, jobId);
  const set: Partial<typeof schema.jobs.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.timeoutMs !== undefined) set.timeoutMs = patch.timeoutMs;
  if (patch.maxAttempts !== undefined) set.maxAttempts = patch.maxAttempts;
  if (patch.schedule) {
    const next = firstRun(patch.schedule, now);
    Object.assign(set, scheduleColumns(patch.schedule));
    if (job.status === 'active') set.nextRunAt = next;
    if (job.status === 'completed') {
      // A new schedule revives a finished one-off job.
      set.status = 'active';
      set.nextRunAt = next;
    }
  }
  if (patch.target) {
    const merged: TargetInput = {
      url: patch.target.url ?? job.url,
      method: patch.target.method ?? job.method,
      headers: patch.target.headers ?? decryptHeaders(deps.encryptionKey, job),
      body: patch.target.body !== undefined ? patch.target.body : job.body,
    };
    set.url = await checkTarget(deps, merged);
    set.method = merged.method;
    set.headersEnc = encryptHeaders(deps.encryptionKey, job.id, merged.headers);
    set.body = merged.body;
  }
  const [updated] = await deps.db
    .update(schema.jobs)
    .set(set)
    .where(eq(schema.jobs.id, job.id))
    .returning();
  return updated!;
}

export async function pauseJob(db: Db, accountId: string, jobId: string, now: Date): Promise<Job> {
  const job = await getJob(db, accountId, jobId);
  if (job.status === 'completed')
    throw new ApiError(409, 'job_completed', 'Job has already completed');
  return db.transaction(async (tx) => {
    await tx
      .update(schema.jobRuns)
      .set({ status: 'cancelled', finishedAt: now, lastError: 'job paused' })
      .where(and(eq(schema.jobRuns.jobId, job.id), eq(schema.jobRuns.status, 'pending')));
    const [row] = await tx
      .update(schema.jobs)
      .set({ status: 'paused', nextRunAt: null, updatedAt: now })
      .where(eq(schema.jobs.id, job.id))
      .returning();
    return row!;
  });
}

export async function resumeJob(db: Db, accountId: string, jobId: string, now: Date): Promise<Job> {
  const job = await getJob(db, accountId, jobId);
  if (job.status === 'completed')
    throw new ApiError(409, 'job_completed', 'Job has already completed');
  if (job.status === 'active') return job;
  const nextRunAt =
    job.scheduleKind === 'cron'
      ? nextCronRun(job.cronExpr!, job.timezone, now)
      : new Date(Math.max(job.runAt!.getTime(), now.getTime()));
  const [row] = await db
    .update(schema.jobs)
    .set({ status: 'active', nextRunAt, updatedAt: now })
    .where(eq(schema.jobs.id, job.id))
    .returning();
  return row!;
}

export async function deleteJob(db: Db, accountId: string, jobId: string): Promise<void> {
  const deleted = await db
    .delete(schema.jobs)
    .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.accountId, accountId)))
    .returning({ id: schema.jobs.id });
  if (deleted.length === 0) throw new ApiError(404, 'not_found', 'Job not found');
}

export function runLimitFor(account: Pick<Account, 'activatedAt'>): number {
  return TIERS[tierFor(account)].runsPerMonth;
}

/** Queues an immediate run outside the schedule. Counts against the monthly quota. */
export async function triggerJob(
  db: Db,
  account: Account,
  jobId: string,
  now: Date,
): Promise<JobRun> {
  const job = await getJob(db, account.id, jobId);
  return db.transaction(async (tx) => {
    if (!(await tryConsumeRun(tx, account.id, runLimitFor(account), now))) {
      throw new ApiError(402, 'quota_exceeded', 'Monthly run quota exhausted for this account');
    }
    const [run] = await tx
      .insert(schema.jobRuns)
      .values({
        id: newId('run'),
        jobId: job.id,
        accountId: account.id,
        trigger: 'manual',
        scheduledFor: now,
        status: 'pending',
        maxAttempts: job.maxAttempts,
        nextAttemptAt: now,
        createdAt: now,
      })
      .returning();
    return run!;
  });
}
