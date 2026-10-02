import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Account, Monitor, MonitorStatus } from './db/schema.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import { offersFor, PaymentRequiredError } from './billing.js';
import { chargeCredits } from './credits.js';
import { MONITOR_BILLING_PERIOD_MS, PRICES, TIERS, tierFor, usd } from './plans.js';
import type { TargetPolicy } from './ssrf.js';
import { assertWebhookUrl, type Resolve } from './targets.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export const ALERT_MAX_ATTEMPTS = 6;

export interface MonitorsDeps {
  db: Db;
  policy: TargetPolicy;
  resolve?: Resolve;
  /** Whether the server can send email alerts (RESEND_API_KEY set). Gates `alertEmail` at creation. */
  emailConfigured?: boolean;
}

export interface MonitorInput {
  name: string;
  ttlSeconds: number;
  graceSeconds: number;
  alertWebhookUrl: string | null;
  alertWebhookUrl2: string | null;
  alertTelegram: boolean;
  alertEmail: string | null;
  /** 'heartbeat' (agent pushes pings, default) or 'active' (we probe `checkUrl`). */
  mode?: 'heartbeat' | 'active';
  /** Active mode: the agent URL we probe from the outside (public HTTPS). */
  checkUrl?: string | null;
  /** Active mode: probe interval in seconds; must be ≥ 30 and < ttlSeconds. */
  checkIntervalSeconds?: number | null;
  /** Active mode: required exact HTTP status (null/absent = any 2xx). */
  checkExpectStatus?: number | null;
  /** Active mode: the response body must contain this substring (defeats a hollow 200). */
  checkBodyContains?: string | null;
  /** Active mode: dotted JSON path to a timestamp field; with checkMaxAgeSeconds, defeats a stale 200. */
  checkJsonPath?: string | null;
  /** Active mode: max age (seconds) for the checkJsonPath timestamp relative to the probe. */
  checkMaxAgeSeconds?: number | null;
}

export type MonitorEventName = 'monitor.down' | 'monitor.up' | 'monitor.unpaid';

const expiry = (m: Pick<Monitor, 'ttlSeconds' | 'graceSeconds'>, from: Date) =>
  new Date(from.getTime() + (m.ttlSeconds + m.graceSeconds) * 1000);

export function alertPayload(event: MonitorEventName, m: Monitor, at: Date) {
  return {
    event,
    occurredAt: at.toISOString(),
    monitor: {
      id: m.id,
      name: m.name,
      status: m.status,
      ttlSeconds: m.ttlSeconds,
      graceSeconds: m.graceSeconds,
      lastPingAt: m.lastPingAt?.toISOString() ?? null,
      expiresAt: m.expiresAt?.toISOString() ?? null,
      deadSince: m.deadSince?.toISOString() ?? null,
    },
  };
}

export type AlertPayload = ReturnType<typeof alertPayload>;

/** Human-readable alert text (Telegram). Plain text; names are user-supplied. */
/** One-line summary for an email subject. */
export function alertSubject(p: AlertPayload): string {
  const name = p.monitor.name;
  if (p.event === 'monitor.down') return `monitor "${name}" is DOWN`;
  if (p.event === 'monitor.unpaid') return `monitor "${name}" was PAUSED (unpaid)`;
  return `monitor "${name}" is back UP`;
}

export function alertText(p: AlertPayload): string {
  const m = p.monitor;
  if (p.event === 'monitor.down') {
    return (
      `🔴 Monitor "${m.name}" is DOWN\n` +
      `No ping within ${m.ttlSeconds + m.graceSeconds}s (TTL ${m.ttlSeconds}s + grace ${m.graceSeconds}s).\n` +
      `Last ping: ${m.lastPingAt ?? 'never'}\nID: ${m.id}`
    );
  }
  if (p.event === 'monitor.unpaid') {
    return (
      `⏸ Monitor "${m.name}" was PAUSED: its 30-day period ended and the credit balance is too low.\n` +
      `It is no longer watched. Buy credits (POST /v1/billing/credits) and resume it.\nID: ${m.id}`
    );
  }
  return `🟢 Monitor "${m.name}" is back UP\nDown since: ${m.deadSince ?? 'unknown'}\nID: ${m.id}`;
}

/** Queues one delivery per configured channel. No-op for frozen accounts. */
export async function enqueueAlerts(
  tx: Executor,
  monitor: Monitor,
  account: Pick<Account, 'status' | 'telegramChatId'>,
  event: MonitorEventName,
  at: Date,
): Promise<number> {
  if (account.status !== 'active') return 0;
  const channels: Array<'webhook' | 'webhook2' | 'telegram' | 'email'> = [];
  if (monitor.alertWebhookUrl) channels.push('webhook');
  if (monitor.alertWebhookUrl2) channels.push('webhook2');
  if (monitor.alertTelegram && account.telegramChatId) channels.push('telegram');
  if (monitor.alertEmail) channels.push('email');
  if (channels.length === 0) return 0;
  const payload = JSON.stringify(alertPayload(event, monitor, at));
  await tx.insert(schema.alertDeliveries).values(
    channels.map((channel) => ({
      id: newId('alr'),
      monitorId: monitor.id,
      accountId: monitor.accountId,
      event,
      channel,
      payload,
      maxAttempts: ALERT_MAX_ATTEMPTS,
      nextAttemptAt: at,
      createdAt: at,
    })),
  );
  return channels.length;
}

async function recordEvent(
  tx: Executor,
  monitorId: string,
  from: MonitorStatus,
  to: MonitorStatus,
  reason: string,
  at: Date,
) {
  await tx
    .insert(schema.monitorEvents)
    .values({ monitorId, fromStatus: from, toStatus: to, reason, at });
}

/** Rejects `alertEmail` unless the server can actually send email; keeps the switch honest. */
function requireEmailConfigured(deps: MonitorsDeps, email: string | null): string | null {
  if (email && !deps.emailConfigured) {
    throw new ApiError(
      422,
      'email_not_configured',
      'Email alerts are not enabled on this server; use a webhook or Telegram',
    );
  }
  return email;
}

export async function createMonitor(
  deps: MonitorsDeps,
  account: Account,
  input: MonitorInput,
  now: Date,
): Promise<Monitor> {
  const alertWebhookUrl = input.alertWebhookUrl
    ? await assertWebhookUrl(deps.policy, input.alertWebhookUrl, deps.resolve)
    : null;
  const alertWebhookUrl2 = input.alertWebhookUrl2
    ? await assertWebhookUrl(deps.policy, input.alertWebhookUrl2, deps.resolve)
    : null;
  const alertEmail = requireEmailConfigured(deps, input.alertEmail);
  const mode = input.mode ?? 'heartbeat';
  const {
    checkUrl,
    checkIntervalSeconds,
    checkExpectStatus,
    checkBodyContains,
    checkJsonPath,
    checkMaxAgeSeconds,
  } = await validateActiveCheck(deps, mode, input);
  const limit = TIERS[tierFor(account)].monitors;
  return deps.db.transaction(async (tx) => {
    // Serialise per account so two concurrent creates cannot both take the last free slot.
    await tx
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, account.id))
      .for('update');
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.monitors)
      .where(and(eq(schema.monitors.accountId, account.id), eq(schema.monitors.billing, 'free')));
    const id = newId('mon');
    let billing: 'free' | 'paid' = 'free';
    let paidUntil: Date | null = null;
    if (n >= limit) {
      if (!(await chargeCredits(tx, account.id, PRICES.monitorMonthMicro, 'monitor_month', id))) {
        throw new PaymentRequiredError(
          offersFor(account),
          `Your tier includes ${limit} monitor(s); each extra monitor costs ${usd(PRICES.monitorMonthMicro)} per 30 days from credits`,
        );
      }
      billing = 'paid';
      paidUntil = new Date(now.getTime() + MONITOR_BILLING_PERIOD_MS);
    }
    const [row] = await tx
      .insert(schema.monitors)
      .values({
        id,
        accountId: account.id,
        name: input.name,
        ttlSeconds: input.ttlSeconds,
        graceSeconds: input.graceSeconds,
        status: 'new',
        mode,
        checkUrl,
        checkIntervalSeconds,
        checkExpectStatus,
        checkBodyContains,
        checkJsonPath,
        checkMaxAgeSeconds,
        alertWebhookUrl,
        alertWebhookUrl2,
        alertTelegram: input.alertTelegram,
        alertEmail,
        billing,
        paidUntil,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return row!;
  });
}

/**
 * Validates active-check inputs. For `active` the agent URL is required and SSRF-checked (public
 * HTTPS, like a webhook target), and the probe interval must be ≥ 30 s and shorter than the TTL so a
 * single failed probe cannot by itself expire the monitor. For `heartbeat` both must be absent.
 */
async function validateActiveCheck(
  deps: MonitorsDeps,
  mode: 'heartbeat' | 'active',
  input: Pick<
    MonitorInput,
    | 'checkUrl'
    | 'checkIntervalSeconds'
    | 'ttlSeconds'
    | 'checkExpectStatus'
    | 'checkBodyContains'
    | 'checkJsonPath'
    | 'checkMaxAgeSeconds'
  >,
): Promise<{
  checkUrl: string | null;
  checkIntervalSeconds: number | null;
  checkExpectStatus: number | null;
  checkBodyContains: string | null;
  checkJsonPath: string | null;
  checkMaxAgeSeconds: number | null;
}> {
  if (mode === 'heartbeat') {
    if (
      input.checkUrl ||
      input.checkIntervalSeconds != null ||
      input.checkExpectStatus != null ||
      input.checkBodyContains ||
      input.checkJsonPath ||
      input.checkMaxAgeSeconds != null
    ) {
      throw new ApiError(400, 'invalid_request', 'check/expect fields require mode "active"');
    }
    return {
      checkUrl: null,
      checkIntervalSeconds: null,
      checkExpectStatus: null,
      checkBodyContains: null,
      checkJsonPath: null,
      checkMaxAgeSeconds: null,
    };
  }
  if (!input.checkUrl)
    throw new ApiError(400, 'invalid_request', 'mode "active" requires checkUrl');
  const interval = input.checkIntervalSeconds;
  if (interval == null || interval < 30) {
    throw new ApiError(400, 'invalid_request', 'checkIntervalSeconds must be at least 30');
  }
  if (interval >= input.ttlSeconds) {
    throw new ApiError(
      400,
      'invalid_request',
      'checkIntervalSeconds must be shorter than ttlSeconds',
    );
  }
  const status = input.checkExpectStatus;
  if (status != null && (status < 100 || status > 599)) {
    throw new ApiError(400, 'invalid_request', 'check.expect.status must be a valid HTTP status');
  }
  // Freshness assertion: jsonPath and maxAgeSeconds go together, or neither.
  const jsonPath = input.checkJsonPath?.trim() || null;
  const maxAge = input.checkMaxAgeSeconds ?? null;
  if ((jsonPath === null) !== (maxAge === null)) {
    throw new ApiError(
      400,
      'invalid_request',
      'check.expect.jsonPath and maxAgeSeconds must be set together',
    );
  }
  if (maxAge != null && maxAge < 1) {
    throw new ApiError(400, 'invalid_request', 'check.expect.maxAgeSeconds must be at least 1');
  }
  const checkUrl = await assertWebhookUrl(deps.policy, input.checkUrl, deps.resolve);
  return {
    checkUrl,
    checkIntervalSeconds: interval,
    checkExpectStatus: status ?? null,
    checkBodyContains: input.checkBodyContains || null,
    checkJsonPath: jsonPath,
    checkMaxAgeSeconds: maxAge,
  };
}

/**
 * Worker: renews paid monitors whose 30-day period ended, charging credits. Monitors that
 * cannot be renewed are paused (with an 'unpaid' event); resuming them later tries again.
 */
export async function renewPaidMonitors(
  db: Db,
  now: Date,
  batchSize = 100,
): Promise<{ renewed: number; paused: number }> {
  return db.transaction(async (tx) => {
    const due = await tx
      .select({ monitor: schema.monitors, account: schema.accounts })
      .from(schema.monitors)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.monitors.accountId))
      .where(
        and(
          eq(schema.monitors.billing, 'paid'),
          sql`${schema.monitors.paidUntil} <= ${now}`,
          sql`${schema.monitors.status} <> 'paused'`,
          eq(schema.accounts.status, 'active'),
        ),
      )
      .limit(batchSize)
      .for('update', { of: schema.monitors, skipLocked: true });
    let renewed = 0;
    let paused = 0;
    for (const { monitor, account } of due) {
      const next = new Date(monitor.paidUntil!.getTime() + MONITOR_BILLING_PERIOD_MS);
      if (
        await chargeCredits(
          tx,
          monitor.accountId,
          PRICES.monitorMonthMicro,
          'monitor_month',
          monitor.id,
        )
      ) {
        await tx
          .update(schema.monitors)
          .set({
            paidUntil: next > now ? next : new Date(now.getTime() + MONITOR_BILLING_PERIOD_MS),
          })
          .where(eq(schema.monitors.id, monitor.id));
        renewed++;
      } else {
        await recordEvent(tx, monitor.id, monitor.status, 'paused', 'unpaid', now);
        const [row] = await tx
          .update(schema.monitors)
          .set({ status: 'paused', expiresAt: null, updatedAt: now })
          .where(eq(schema.monitors.id, monitor.id))
          .returning();
        // Silence would be the worst outcome for a dead man's switch: tell the owner.
        await enqueueAlerts(tx, row!, account, 'monitor.unpaid', now);
        paused++;
      }
    }
    return { renewed, paused };
  });
}

export async function getMonitor(db: Db, accountId: string, id: string): Promise<Monitor> {
  const [row] = await db
    .select()
    .from(schema.monitors)
    .where(and(eq(schema.monitors.id, id), eq(schema.monitors.accountId, accountId)));
  if (!row) throw new ApiError(404, 'not_found', 'Monitor not found');
  return row;
}

export async function updateMonitor(
  deps: MonitorsDeps,
  accountId: string,
  id: string,
  patch: Partial<MonitorInput>,
  now: Date,
): Promise<Monitor> {
  const m = await getMonitor(deps.db, accountId, id);
  const set: Partial<typeof schema.monitors.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.alertTelegram !== undefined) set.alertTelegram = patch.alertTelegram;
  if (patch.alertWebhookUrl !== undefined) {
    set.alertWebhookUrl = patch.alertWebhookUrl
      ? await assertWebhookUrl(deps.policy, patch.alertWebhookUrl, deps.resolve)
      : null;
  }
  if (patch.alertWebhookUrl2 !== undefined) {
    set.alertWebhookUrl2 = patch.alertWebhookUrl2
      ? await assertWebhookUrl(deps.policy, patch.alertWebhookUrl2, deps.resolve)
      : null;
  }
  if (patch.alertEmail !== undefined) {
    set.alertEmail = requireEmailConfigured(deps, patch.alertEmail);
  }
  if (patch.ttlSeconds !== undefined || patch.graceSeconds !== undefined) {
    const timing = {
      ttlSeconds: patch.ttlSeconds ?? m.ttlSeconds,
      graceSeconds: patch.graceSeconds ?? m.graceSeconds,
    };
    // Keep the active-check invariant: a single failed probe must not by itself expire the monitor.
    if (
      m.mode === 'active' &&
      m.checkIntervalSeconds != null &&
      timing.ttlSeconds <= m.checkIntervalSeconds
    ) {
      throw new ApiError(
        400,
        'invalid_request',
        'ttlSeconds must stay greater than the check interval',
      );
    }
    Object.assign(set, timing);
    if (m.status === 'alive' && m.lastPingAt) set.expiresAt = expiry(timing, m.lastPingAt);
  }
  const [row] = await deps.db
    .update(schema.monitors)
    .set(set)
    .where(eq(schema.monitors.id, m.id))
    .returning();
  return row!;
}

export async function deleteMonitor(db: Db, accountId: string, id: string): Promise<void> {
  const rows = await db
    .delete(schema.monitors)
    .where(and(eq(schema.monitors.id, id), eq(schema.monitors.accountId, accountId)))
    .returning({ id: schema.monitors.id });
  if (rows.length === 0) throw new ApiError(404, 'not_found', 'Monitor not found');
}

export async function pauseMonitor(db: Db, accountId: string, id: string, now: Date) {
  const m = await getMonitor(db, accountId, id);
  if (m.status === 'paused') return m;
  return db.transaction(async (tx) => {
    await recordEvent(tx, m.id, m.status, 'paused', 'pause', now);
    await tx
      .update(schema.alertDeliveries)
      .set({ status: 'cancelled', finishedAt: now, lastError: 'monitor paused' })
      .where(
        and(
          eq(schema.alertDeliveries.monitorId, m.id),
          eq(schema.alertDeliveries.status, 'pending'),
        ),
      );
    const [row] = await tx
      .update(schema.monitors)
      .set({ status: 'paused', expiresAt: null, updatedAt: now })
      .where(eq(schema.monitors.id, m.id))
      .returning();
    return row!;
  });
}

/**
 * Emergency stop: pauses every non-paused monitor for the account (recording a `pause` event and
 * cancelling pending alerts), in one transaction. Returns how many were paused. Billing is
 * untouched: a paid monitor stays paid, and resuming it later follows the normal path.
 */
export async function pauseAllMonitors(
  db: Db,
  accountId: string,
  now: Date,
): Promise<{ paused: number }> {
  return db.transaction(async (tx) => {
    const active = await tx
      .select({ id: schema.monitors.id, status: schema.monitors.status })
      .from(schema.monitors)
      .where(and(eq(schema.monitors.accountId, accountId), ne(schema.monitors.status, 'paused')));
    if (active.length === 0) return { paused: 0 };
    for (const m of active) await recordEvent(tx, m.id, m.status, 'paused', 'pause', now);
    await tx
      .update(schema.alertDeliveries)
      .set({ status: 'cancelled', finishedAt: now, lastError: 'account paused' })
      .where(
        and(
          eq(schema.alertDeliveries.accountId, accountId),
          eq(schema.alertDeliveries.status, 'pending'),
        ),
      );
    await tx
      .update(schema.monitors)
      .set({ status: 'paused', expiresAt: null, updatedAt: now })
      .where(and(eq(schema.monitors.accountId, accountId), ne(schema.monitors.status, 'paused')));
    return { paused: active.length };
  });
}

/** Resuming starts a fresh TTL window from now (the agent may have kept pinging while paused). */
export async function resumeMonitor(db: Db, account: Account, id: string, now: Date) {
  const m = await getMonitor(db, account.id, id);
  if (m.status !== 'paused') return m;
  return db.transaction(async (tx) => {
    let paidUntil = m.paidUntil;
    // A paid monitor whose period ended (e.g. paused for lack of credits) starts a new period.
    if (m.billing === 'paid' && (!paidUntil || paidUntil <= now)) {
      if (!(await chargeCredits(tx, account.id, PRICES.monitorMonthMicro, 'monitor_month', m.id))) {
        throw new PaymentRequiredError(
          offersFor(account),
          `Resuming this monitor costs ${usd(PRICES.monitorMonthMicro)} per 30 days from credits`,
        );
      }
      paidUntil = new Date(now.getTime() + MONITOR_BILLING_PERIOD_MS);
    }
    await recordEvent(tx, m.id, 'paused', 'alive', 'resume', now);
    const [row] = await tx
      .update(schema.monitors)
      .set({
        status: 'alive',
        expiresAt: expiry(m, now),
        deadSince: null,
        paidUntil,
        updatedAt: now,
      })
      .where(eq(schema.monitors.id, m.id))
      .returning();
    return row!;
  });
}

export interface PingResult {
  monitor: Monitor;
  previous: MonitorStatus;
}

/**
 * Records a ping. new/alive/dead → alive with a fresh expiry; dead → alive also queues a
 * "monitor.up" alert. Paused monitors only record the ping time.
 */
export async function recordPing(db: Db, id: string, now: Date): Promise<PingResult | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ monitor: schema.monitors, account: schema.accounts })
      .from(schema.monitors)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.monitors.accountId))
      .where(eq(schema.monitors.id, id))
      .for('update', { of: schema.monitors });
    if (!row) return null;
    const { monitor, account } = row;
    const previous = monitor.status;

    if (previous === 'paused') {
      const [m] = await tx
        .update(schema.monitors)
        .set({ lastPingAt: now })
        .where(eq(schema.monitors.id, id))
        .returning();
      return { monitor: m!, previous };
    }

    const [m] = await tx
      .update(schema.monitors)
      .set({ status: 'alive', lastPingAt: now, expiresAt: expiry(monitor, now), deadSince: null })
      .where(eq(schema.monitors.id, id))
      .returning();
    if (previous !== 'alive') await recordEvent(tx, id, previous, 'alive', 'ping', now);
    if (previous === 'dead') {
      // Report with the dead_since of the outage that just ended.
      await enqueueAlerts(tx, { ...m!, deadSince: monitor.deadSince }, account, 'monitor.up', now);
    }
    return { monitor: m!, previous };
  });
}

/** Marks overdue alive monitors dead and queues "monitor.down" alerts (worker). */
export async function sweepExpiredMonitors(
  db: Db,
  now: Date,
  batchSize = 100,
): Promise<{ died: number; alerts: number }> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ monitor: schema.monitors, account: schema.accounts })
      .from(schema.monitors)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.monitors.accountId))
      .where(and(eq(schema.monitors.status, 'alive'), sql`${schema.monitors.expiresAt} <= ${now}`))
      .orderBy(schema.monitors.expiresAt)
      .limit(batchSize)
      .for('update', { of: schema.monitors, skipLocked: true });
    let alerts = 0;
    for (const { monitor, account } of rows) {
      const [dead] = await tx
        .update(schema.monitors)
        .set({ status: 'dead', deadSince: now })
        .where(eq(schema.monitors.id, monitor.id))
        .returning();
      await recordEvent(tx, monitor.id, 'alive', 'dead', 'timeout', now);
      alerts += await enqueueAlerts(tx, dead!, account, 'monitor.down', now);
    }
    return { died: rows.length, alerts };
  });
}
