import type { ApiKey, Job, JobAttempt, JobRun, Monitor, MonitorEvent } from '../core/db/schema.js';

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

export function serializeMonitor(m: Monitor, publicBaseUrl: string) {
  return {
    id: m.id,
    name: m.name,
    status: m.status,
    ttlSeconds: m.ttlSeconds,
    graceSeconds: m.graceSeconds,
    mode: m.mode,
    check:
      m.mode === 'active' && m.checkUrl
        ? { url: m.checkUrl, intervalSeconds: m.checkIntervalSeconds ?? 0 }
        : null,
    lastProbe:
      m.mode === 'active'
        ? { at: iso(m.lastProbeAt), ok: m.lastProbeOk, detail: m.lastProbeDetail }
        : null,
    pingUrl: `${publicBaseUrl.replace(/\/$/, '')}/v1/heartbeat/${m.id}`,
    lastPingAt: iso(m.lastPingAt),
    expiresAt: iso(m.expiresAt),
    deadSince: iso(m.deadSince),
    alerts: {
      webhookUrl: m.alertWebhookUrl,
      webhookUrl2: m.alertWebhookUrl2,
      telegram: m.alertTelegram,
      email: m.alertEmail,
    },
    billing: { plan: m.billing, paidUntil: iso(m.paidUntil) },
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

export function serializeMonitorEvent(e: MonitorEvent) {
  return {
    from: e.fromStatus,
    to: e.toStatus,
    reason: e.reason as 'ping' | 'timeout' | 'pause' | 'resume' | 'unpaid',
    at: e.at.toISOString(),
  };
}
