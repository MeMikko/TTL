import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { schema } from './db/index.js';
import type { Account, Monitor, MonitorStatus } from './db/schema.js';
import { ApiError } from './errors.js';
import { newId } from './ids.js';
import { TIERS, tierFor } from './plans.js';
import type { TargetPolicy } from './ssrf.js';
import { assertWebhookUrl, type Resolve } from './targets.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Executor = Db | Tx;

export const ALERT_MAX_ATTEMPTS = 6;

export interface MonitorsDeps {
  db: Db;
  policy: TargetPolicy;
  resolve?: Resolve;
}

export interface MonitorInput {
  name: string;
  ttlSeconds: number;
  graceSeconds: number;
  alertWebhookUrl: string | null;
  alertTelegram: boolean;
}

export type MonitorEventName = 'monitor.down' | 'monitor.up';

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
export function alertText(p: AlertPayload): string {
  const m = p.monitor;
  if (p.event === 'monitor.down') {
    return (
      `🔴 Monitor "${m.name}" is DOWN\n` +
      `No ping within ${m.ttlSeconds + m.graceSeconds}s (TTL ${m.ttlSeconds}s + grace ${m.graceSeconds}s).\n` +
      `Last ping: ${m.lastPingAt ?? 'never'}\nID: ${m.id}`
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
  const channels: Array<'webhook' | 'telegram'> = [];
  if (monitor.alertWebhookUrl) channels.push('webhook');
  if (monitor.alertTelegram && account.telegramChatId) channels.push('telegram');
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

export async function createMonitor(
  deps: MonitorsDeps,
  account: Account,
  input: MonitorInput,
  now: Date,
): Promise<Monitor> {
  const limit = TIERS[tierFor(account)].monitors;
  const [{ n } = { n: 0 }] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.monitors)
    .where(eq(schema.monitors.accountId, account.id));
  if (n >= limit) {
    throw new ApiError(402, 'quota_exceeded', `Your tier allows ${limit} monitor(s)`);
  }
  const alertWebhookUrl = input.alertWebhookUrl
    ? await assertWebhookUrl(deps.policy, input.alertWebhookUrl, deps.resolve)
    : null;
  const [row] = await deps.db
    .insert(schema.monitors)
    .values({
      id: newId('mon'),
      accountId: account.id,
      name: input.name,
      ttlSeconds: input.ttlSeconds,
      graceSeconds: input.graceSeconds,
      status: 'new',
      alertWebhookUrl,
      alertTelegram: input.alertTelegram,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return row!;
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
  if (patch.ttlSeconds !== undefined || patch.graceSeconds !== undefined) {
    const timing = {
      ttlSeconds: patch.ttlSeconds ?? m.ttlSeconds,
      graceSeconds: patch.graceSeconds ?? m.graceSeconds,
    };
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

/** Resuming starts a fresh TTL window from now (the agent may have kept pinging while paused). */
export async function resumeMonitor(db: Db, accountId: string, id: string, now: Date) {
  const m = await getMonitor(db, accountId, id);
  if (m.status !== 'paused') return m;
  return db.transaction(async (tx) => {
    await recordEvent(tx, m.id, 'paused', 'alive', 'resume', now);
    const [row] = await tx
      .update(schema.monitors)
      .set({ status: 'alive', expiresAt: expiry(m, now), deadSince: null, updatedAt: now })
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
