import { eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../core/db/index.js';
import { schema } from '../core/db/index.js';
import type { AlertDelivery } from '../core/db/schema.js';
import { SIGNATURE_HEADER, signPayload } from '../core/hmac.js';
import type { Logger } from '../core/logger.js';
import { alertSubject, alertText, type AlertPayload } from '../core/monitors.js';
import type { EmailClient } from '../core/email.js';
import type { RateLimiter } from '../core/rate-limit.js';
import type { TelegramClient } from '../core/telegram.js';
import { getOrCreateWebhookSecret } from '../core/webhook-secret.js';
import { backoffMs, classifyResult, LEASE_MS, type Outcome } from './delivery.js';
import type { HttpClient } from './http-client.js';

export const ALERT_TIMEOUT_MS = 10_000;

export interface AlertDeps {
  db: Db;
  client: HttpClient;
  telegram?: TelegramClient;
  email?: EmailClient;
  encryptionKey: Buffer;
  hostLimiter: RateLimiter;
  logger: Logger;
  now?: () => Date;
  random?: () => number;
}

export async function claimAlerts(db: Db, limit: number, now: Date): Promise<AlertDelivery[]> {
  if (limit <= 0) return [];
  const result = await db.execute(sql`
    with c as (
      select id from alert_deliveries
      where (status = 'pending' and next_attempt_at <= ${now})
         or (status = 'running' and locked_until < ${now})
      order by next_attempt_at nulls first
      limit ${limit}
      for update skip locked
    )
    update alert_deliveries d
    set status = 'running', attempts = d.attempts + 1,
        locked_until = ${new Date(now.getTime() + LEASE_MS)}
    from c where d.id = c.id
    returning d.id`);
  const ids = result.rows.map((r) => r.id as string);
  if (ids.length === 0) return [];
  return db.select().from(schema.alertDeliveries).where(inArray(schema.alertDeliveries.id, ids));
}

interface AttemptResult {
  outcome: Outcome;
  httpStatus?: number;
  error?: string;
  retryAfterSeconds?: number;
}

export async function processAlert(
  deps: AlertDeps,
  alert: AlertDelivery,
): Promise<Outcome | 'deferred' | 'cancelled'> {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const t = schema.alertDeliveries;
  const done = (status: 'succeeded' | 'failed' | 'cancelled', r: Partial<AttemptResult> = {}) =>
    db
      .update(t)
      .set({
        status,
        finishedAt: now(),
        lockedUntil: null,
        nextAttemptAt: null,
        lastHttpStatus: r.httpStatus ?? null,
        lastError: r.error ?? null,
      })
      .where(eq(t.id, alert.id));

  const [row] = await db
    .select({ monitor: schema.monitors, account: schema.accounts })
    .from(schema.monitors)
    .innerJoin(schema.accounts, eq(schema.accounts.id, schema.monitors.accountId))
    .where(eq(schema.monitors.id, alert.monitorId));
  if (!row) return 'cancelled';
  const { monitor, account } = row;
  if (account.status === 'frozen' || monitor.status === 'paused') {
    await done('cancelled', {
      error: account.status === 'frozen' ? 'account frozen' : 'monitor paused',
    });
    return 'cancelled';
  }
  if (alert.attempts > alert.maxAttempts) {
    await done('failed', { error: 'delivery interrupted (lease expired)' });
    return 'fail';
  }

  const payload = JSON.parse(alert.payload) as AlertPayload;

  // Each channel returns an AttemptResult, or a terminal short-circuit ('cancelled' | 'deferred'
  // | 'fail') when the delivery cannot even be attempted (config/URL missing, rate-limited).
  const webhook = async (url: string | null): Promise<AttemptResult | 'cancelled' | 'deferred'> => {
    // Use the URL configured now; it may have been changed or removed since the alert was queued.
    if (!url) {
      await done('cancelled', { error: 'webhook removed' });
      return 'cancelled';
    }
    const host = new URL(url).host;
    const limit = deps.hostLimiter.consume(`host:${host}`);
    if (!limit.allowed) {
      await db
        .update(t)
        .set({
          status: 'pending',
          attempts: sql`${t.attempts} - 1`,
          lockedUntil: null,
          nextAttemptAt: new Date(now().getTime() + limit.retryAfterSeconds * 1000),
        })
        .where(eq(t.id, alert.id));
      return 'deferred';
    }
    const secret = await getOrCreateWebhookSecret(db, deps.encryptionKey, account.id);
    const body = alert.payload;
    const res = await deps.client.send({
      url,
      method: 'POST',
      userHeaders: {},
      systemHeaders: {
        [SIGNATURE_HEADER]: signPayload(secret, body, Math.floor(now().getTime() / 1000)),
        'T2L-Delivery-Id': alert.id,
        'T2L-Attempt': String(alert.attempts),
        'T2L-Event': payload.event,
        'T2L-Monitor-Id': monitor.id,
      },
      body,
      timeoutMs: ALERT_TIMEOUT_MS,
    });
    return {
      outcome: classifyResult(res),
      httpStatus: res.status,
      error: res.failure
        ? `${res.failure.kind}: ${res.failure.message}`
        : res.status && res.status >= 300
          ? `HTTP ${res.status}`
          : undefined,
      retryAfterSeconds: res.retryAfterSeconds,
    };
  };

  const telegram = async (): Promise<AttemptResult | 'cancelled' | 'fail'> => {
    if (!account.telegramChatId) {
      await done('cancelled', { error: 'no Telegram chat linked' });
      return 'cancelled';
    }
    if (!deps.telegram) {
      await done('failed', { error: 'Telegram is not configured on this server' });
      return 'fail';
    }
    const res = await deps.telegram.sendMessage(account.telegramChatId, alertText(payload));
    const status = res.status ?? 0;
    return {
      outcome: res.ok
        ? 'success'
        : !res.status || status === 429 || status >= 500
          ? 'retry'
          : 'fail',
      httpStatus: res.status,
      error: res.error,
      retryAfterSeconds: res.retryAfterSeconds,
    };
  };

  const email = async (): Promise<AttemptResult | 'cancelled' | 'fail'> => {
    if (!monitor.alertEmail) {
      await done('cancelled', { error: 'email removed' });
      return 'cancelled';
    }
    if (!deps.email) {
      await done('failed', { error: 'email is not configured on this server' });
      return 'fail';
    }
    const subject = `time2live: ${alertSubject(payload)}`;
    const res = await deps.email.send(monitor.alertEmail, subject, alertText(payload));
    const status = res.status ?? 0;
    return {
      outcome: res.ok
        ? 'success'
        : !res.status || status === 429 || status >= 500
          ? 'retry'
          : 'fail',
      httpStatus: res.status,
      error: res.error,
      retryAfterSeconds: res.retryAfterSeconds,
    };
  };

  const attempted =
    alert.channel === 'webhook'
      ? await webhook(monitor.alertWebhookUrl)
      : alert.channel === 'webhook2'
        ? await webhook(monitor.alertWebhookUrl2)
        : alert.channel === 'email'
          ? await email()
          : await telegram();
  if (attempted === 'cancelled') return 'cancelled';
  if (attempted === 'deferred') return 'deferred';
  if (attempted === 'fail') return 'fail';
  const result = attempted;

  if (result.outcome === 'success') {
    await done('succeeded', result);
  } else if (result.outcome === 'retry' && alert.attempts < alert.maxAttempts) {
    await db
      .update(t)
      .set({
        status: 'pending',
        lockedUntil: null,
        nextAttemptAt: new Date(
          now().getTime() + backoffMs(alert.attempts, result.retryAfterSeconds, deps.random),
        ),
        lastHttpStatus: result.httpStatus ?? null,
        lastError: result.error ?? null,
      })
      .where(eq(t.id, alert.id));
  } else {
    await done('failed', result);
    deps.logger.warn(
      { alertId: alert.id, error: result.error },
      'alert delivery failed permanently',
    );
  }
  return result.outcome;
}
