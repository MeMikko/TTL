import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true });

/** Liveness beacon written by each worker process; read by GET /healthz?deep=1. */
export const workerTicks = pgTable('worker_ticks', {
  workerId: text('worker_id').primaryKey(),
  lastTickAt: ts('last_tick_at').notNull(),
  startedAt: ts('started_at').notNull(),
  version: text('version').notNull(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    /** Lowercase 0x-prefixed EVM address; the only identity an account has. */
    walletAddress: text('wallet_address').notNull().unique(),
    status: text('status', { enum: ['active', 'frozen'] })
      .notNull()
      .default('active'),
    frozenReason: text('frozen_reason'),
    frozenAt: ts('frozen_at'),
    /** AES-GCM encrypted HMAC secret for signing webhook deliveries (created lazily). */
    webhookSecretEnc: text('webhook_secret_enc'),
    /** Telegram chat linked via the bot's /start deep link; receives monitor alerts. */
    telegramChatId: text('telegram_chat_id'),
    /** Set when the one-off free-tier activation payment settles (phase 4). */
    activatedAt: ts('activated_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [check('accounts_status_check', sql`${t.status} in ('active', 'frozen')`)],
);

/** Single-use SIWE challenges. The exact issued message is stored and must be signed verbatim. */
export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    address: text('address').notNull(),
    chainId: integer('chain_id').notNull(),
    message: text('message').notNull(),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [index('auth_nonces_expires_at_idx').on(t.expiresAt)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    /** First characters of the key, safe to display (e.g. "t2l_AbCd1234"). */
    prefix: text('prefix').notNull(),
    /** Hex SHA-256 of the full key. The key itself is never stored. */
    keyHash: text('key_hash').notNull(),
    name: text('name').notNull(),
    lastUsedAt: ts('last_used_at'),
    revokedAt: ts('revoked_at'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_keys_key_hash_idx').on(t.keyHash),
    index('api_keys_account_active_idx')
      .on(t.accountId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    /** SHA-256 over method, path and body; a reused key with a different request is rejected. */
    requestHash: text('request_hash').notNull(),
    /** Null while the original request is still being processed. */
    statusCode: integer('status_code'),
    responseBody: text('response_body'),
    createdAt: ts('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.key] }),
    index('idempotency_keys_created_at_idx').on(t.createdAt),
  ],
);

export const JOB_STATUSES = ['active', 'paused', 'completed'] as const;
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    scheduleKind: text('schedule_kind', { enum: ['cron', 'once'] }).notNull(),
    cronExpr: text('cron_expr'),
    timezone: text('timezone').notNull().default('UTC'),
    runAt: ts('run_at'),
    status: text('status', { enum: JOB_STATUSES }).notNull().default('active'),
    /** Next occurrence to materialise into a run; null when paused/completed. */
    nextRunAt: ts('next_run_at'),
    url: text('url').notNull(),
    method: text('method', { enum: HTTP_METHODS }).notNull().default('POST'),
    /** AES-GCM encrypted JSON object of custom headers (may contain credentials). */
    headersEnc: text('headers_enc'),
    body: text('body'),
    timeoutMs: integer('timeout_ms').notNull(),
    maxAttempts: integer('max_attempts').notNull(),
    lastRunAt: ts('last_run_at'),
    lastRunStatus: text('last_run_status'),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('jobs_due_idx')
      .on(t.nextRunAt)
      .where(sql`${t.status} = 'active'`),
    index('jobs_account_idx').on(t.accountId, t.createdAt),
    check('jobs_status_check', sql`${t.status} in ('active', 'paused', 'completed')`),
    check('jobs_method_check', sql`${t.method} in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')`),
    check(
      'jobs_schedule_check',
      sql`(${t.scheduleKind} = 'cron' and ${t.cronExpr} is not null) or (${t.scheduleKind} = 'once' and ${t.runAt} is not null)`,
    ),
  ],
);

export const RUN_STATUSES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * One row per occurrence of a job. Doubles as the delivery queue: pending rows are claimed with
 * FOR UPDATE SKIP LOCKED, so history and queue can never disagree.
 */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    trigger: text('trigger', { enum: ['schedule', 'manual'] }).notNull(),
    scheduledFor: ts('scheduled_for').notNull(),
    status: text('status', { enum: RUN_STATUSES }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextAttemptAt: ts('next_attempt_at'),
    /** Lease for a running delivery; an expired lease means the worker died and it is retried. */
    lockedUntil: ts('locked_until'),
    lastHttpStatus: integer('last_http_status'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('job_runs_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('job_runs_running_idx')
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'running'`),
    index('job_runs_job_idx').on(t.jobId, t.createdAt),
    index('job_runs_created_at_idx').on(t.createdAt),
    uniqueIndex('job_runs_schedule_unique_idx')
      .on(t.jobId, t.scheduledFor)
      .where(sql`${t.trigger} = 'schedule'`),
    check(
      'job_runs_status_check',
      sql`${t.status} in ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')`,
    ),
  ],
);

/** Per-attempt delivery log. */
export const jobAttempts = pgTable(
  'job_attempts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    runId: text('run_id')
      .notNull()
      .references(() => jobRuns.id, { onDelete: 'cascade' }),
    attempt: integer('attempt').notNull(),
    startedAt: ts('started_at').notNull(),
    durationMs: integer('duration_ms').notNull(),
    httpStatus: integer('http_status'),
    responseSnippet: text('response_snippet'),
    errorKind: text('error_kind'),
    error: text('error'),
    finalUrl: text('final_url'),
  },
  (t) => [uniqueIndex('job_attempts_run_attempt_idx').on(t.runId, t.attempt)],
);

/** Monthly usage per account (period = 'YYYY-MM', UTC). */
export const usageCounters = pgTable(
  'usage_counters',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    period: text('period').notNull(),
    runs: integer('runs').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.period] })],
);

export const MONITOR_STATUSES = ['new', 'alive', 'dead', 'paused'] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export const monitors = pgTable(
  'monitors',
  {
    /** Random 131-bit id; knowing it is what authorises a ping (like healthchecks.io). */
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    ttlSeconds: integer('ttl_seconds').notNull(),
    graceSeconds: integer('grace_seconds').notNull(),
    status: text('status', { enum: MONITOR_STATUSES }).notNull().default('new'),
    lastPingAt: ts('last_ping_at'),
    /** last ping + ttl + grace while alive; null otherwise. */
    expiresAt: ts('expires_at'),
    deadSince: ts('dead_since'),
    alertWebhookUrl: text('alert_webhook_url'),
    alertTelegram: boolean('alert_telegram').notNull().default(false),
    createdAt: ts('created_at').notNull().defaultNow(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('monitors_expiry_idx')
      .on(t.expiresAt)
      .where(sql`${t.status} = 'alive'`),
    index('monitors_account_idx').on(t.accountId, t.createdAt),
    check('monitors_status_check', sql`${t.status} in ('new', 'alive', 'dead', 'paused')`),
  ],
);

export const monitorEvents = pgTable(
  'monitor_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    monitorId: text('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    fromStatus: text('from_status').notNull(),
    toStatus: text('to_status').notNull(),
    /** ping | timeout | pause | resume */
    reason: text('reason').notNull(),
    at: ts('at').notNull(),
  },
  (t) => [
    index('monitor_events_monitor_idx').on(t.monitorId, t.at),
    index('monitor_events_at_idx').on(t.at),
  ],
);

export const ALERT_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'cancelled'] as const;

/** Outgoing alert notifications; a queue with the same lease semantics as job_runs. */
export const alertDeliveries = pgTable(
  'alert_deliveries',
  {
    id: text('id').primaryKey(),
    monitorId: text('monitor_id')
      .notNull()
      .references(() => monitors.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    event: text('event', { enum: ['monitor.down', 'monitor.up'] }).notNull(),
    channel: text('channel', { enum: ['webhook', 'telegram'] }).notNull(),
    /** Snapshot of what is being reported (JSON). */
    payload: text('payload').notNull(),
    status: text('status', { enum: ALERT_STATUSES }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    nextAttemptAt: ts('next_attempt_at'),
    lockedUntil: ts('locked_until'),
    lastHttpStatus: integer('last_http_status'),
    lastError: text('last_error'),
    createdAt: ts('created_at').notNull().defaultNow(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('alert_deliveries_pending_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('alert_deliveries_running_idx')
      .on(t.lockedUntil)
      .where(sql`${t.status} = 'running'`),
    index('alert_deliveries_monitor_idx').on(t.monitorId, t.createdAt),
    index('alert_deliveries_created_at_idx').on(t.createdAt),
  ],
);

/** One-time tokens for linking a Telegram chat to an account (bot deep link /start <token>). */
export const telegramLinkTokens = pgTable('telegram_link_tokens', {
  token: text('token').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
});

export type Account = typeof accounts.$inferSelect;
export type Monitor = typeof monitors.$inferSelect;
export type MonitorEvent = typeof monitorEvents.$inferSelect;
export type AlertDelivery = typeof alertDeliveries.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type JobRun = typeof jobRuns.$inferSelect;
export type JobAttempt = typeof jobAttempts.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
