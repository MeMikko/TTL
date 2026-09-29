import type { ApiKey, Job, JobAttempt, JobRun } from '../core/db/schema.js';

export function serializeApiKey(k: ApiKey) {
  return {
    id: k.id,
    prefix: k.prefix,
    name: k.name,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
  };
}

export function serializeJob(j: Job, headers: Record<string, string>) {
  return {
    id: j.id,
    name: j.name,
    status: j.status,
    schedule:
      j.scheduleKind === 'cron'
        ? { type: 'cron' as const, expression: j.cronExpr!, timezone: j.timezone }
        : { type: 'once' as const, at: j.runAt!.toISOString() },
    target: {
      url: j.url,
      method: j.method,
      headers: Object.fromEntries(Object.keys(headers).map((k) => [k, '[redacted]'])),
      body: j.body,
    },
    timeoutMs: j.timeoutMs,
    maxAttempts: j.maxAttempts,
    nextRunAt: iso(j.nextRunAt),
    lastRunAt: iso(j.lastRunAt),
    lastRunStatus: j.lastRunStatus,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
  };
}

export function serializeRun(r: JobRun) {
  return {
    id: r.id,
    jobId: r.jobId,
    trigger: r.trigger,
    status: r.status,
    scheduledFor: r.scheduledFor.toISOString(),
    attempts: r.attempts,
    maxAttempts: r.maxAttempts,
    nextAttemptAt: iso(r.nextAttemptAt),
    lastHttpStatus: r.lastHttpStatus,
    lastError: r.lastError,
    createdAt: r.createdAt.toISOString(),
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
  };
}

export function serializeAttempt(a: JobAttempt) {
  return {
    attempt: a.attempt,
    startedAt: a.startedAt.toISOString(),
    durationMs: a.durationMs,
    httpStatus: a.httpStatus,
    responseSnippet: a.responseSnippet,
    errorKind: a.errorKind,
    error: a.error,
    finalUrl: a.finalUrl,
  };
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** Opaque keyset cursor over (created_at desc, id desc). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(ts ?? '');
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}
