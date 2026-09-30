import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateAccount, freezeAccount } from '../../src/core/accounts.js';
import { schema } from '../../src/core/db/index.js';
import type { Account } from '../../src/core/db/schema.js';
import { verifySignature } from '../../src/core/hmac.js';
import {
  createMonitor,
  pauseMonitor,
  recordPing,
  sweepExpiredMonitors,
  type MonitorInput,
  type MonitorsDeps,
} from '../../src/core/monitors.js';
import { RateLimiter } from '../../src/core/rate-limit.js';
import type { TargetPolicy } from '../../src/core/ssrf.js';
import { getOrCreateWebhookSecret } from '../../src/core/webhook-secret.js';
import { claimAlerts, processAlert, type AlertDeps } from '../../src/worker/alerts.js';
import { cleanupExpired } from '../../src/worker/cleanup.js';
import { createHttpClient } from '../../src/worker/http-client.js';
import { createWorker } from '../../src/worker/index.js';
import { TEST_ENCRYPTION_KEY, silentLogger, testConfig, testDatabase } from '../helpers/app.js';
import { newWallet, resetDb } from '../helpers/auth.js';
import { fakeEmail } from '../helpers/fake-email.js';
import { fakeTelegram } from '../helpers/fake-telegram.js';
import { startTargetServer } from '../helpers/target-server.js';

const database = testDatabase();
const db = database.db;
const key = Buffer.from(TEST_ENCRYPTION_KEY, 'base64');
let target: Awaited<ReturnType<typeof startTargetServer>>;
beforeAll(async () => {
  target = await startTargetServer();
});
afterAll(async () => {
  await target.close();
  await database.close();
});

const devPolicy: TargetPolicy = {
  allowHttp: true,
  allowedPorts: null,
  allowPrivate: true,
  blockedCidrs: [],
};
const monitorsDeps: MonitorsDeps = { db, policy: devPolicy, emailConfigured: true };
const client = createHttpClient(devPolicy);
afterAll(() => client.close());
const tg = fakeTelegram();
const em = fakeEmail();

let account: Account;
beforeEach(async () => {
  await resetDb(database);
  account = (await findOrCreateAccount(db, newWallet().address)).account;
  await database.pool.query(
    `update accounts set telegram_chat_id = '4242', activated_at = now() where id = $1`,
    [account.id],
  );
  account = { ...account, telegramChatId: '4242', activatedAt: new Date() };
  target.setHandler((_r, res) => res.end('ok'));
  tg.sent.length = 0;
  tg.respondWith(() => ({ ok: true, status: 200 }));
  em.sent.length = 0;
  em.respondWith(() => ({ ok: true, status: 200 }));
});

const T0 = new Date('2026-09-29T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const input = (over: Partial<MonitorInput> = {}): MonitorInput => ({
  name: 'agent-7',
  ttlSeconds: 60,
  graceSeconds: 30,
  alertWebhookUrl: target.url('/alerts'),
  alertWebhookUrl2: null,
  alertTelegram: true,
  alertEmail: null,
  ...over,
});

function alertDeps(now: Date, over: Partial<AlertDeps> = {}): AlertDeps {
  return {
    db,
    client,
    telegram: tg.client,
    email: em.client,
    encryptionKey: key,
    hostLimiter: RateLimiter.perMinute(1000),
    logger: silentLogger,
    now: () => now,
    random: () => 0.5,
    ...over,
  };
}

async function deliverAlerts(now: Date, over: Partial<AlertDeps> = {}) {
  const alerts = await claimAlerts(db, 50, now);
  return Promise.all(alerts.map((a) => processAlert(alertDeps(now, over), a)));
}

const alertsOf = (monitorId: string) =>
  db.select().from(schema.alertDeliveries).where(eq(schema.alertDeliveries.monitorId, monitorId));
const monitorById = async (id: string) =>
  (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0]!;

describe('monitor lifecycle', () => {
  it('stays alive within TTL + grace and dies exactly after it', async () => {
    const m = await createMonitor(monitorsDeps, account, input(), T0);
    await recordPing(db, m.id, T0);
    expect(await sweepExpiredMonitors(db, at(89_999))).toEqual({ died: 0, alerts: 0 });
    expect(await sweepExpiredMonitors(db, at(90_000))).toEqual({ died: 1, alerts: 2 });
    expect(await monitorById(m.id)).toMatchObject({ status: 'dead', deadSince: at(90_000) });
    // Already dead: no second alert.
    expect(await sweepExpiredMonitors(db, at(200_000))).toEqual({ died: 0, alerts: 0 });
  });

  it('never kills a monitor that has not been pinged yet', async () => {
    await createMonitor(monitorsDeps, account, input(), T0);
    expect(await sweepExpiredMonitors(db, at(10 * 3600_000))).toEqual({ died: 0, alerts: 0 });
  });

  it('a ping keeps the monitor alive by pushing the expiry forward', async () => {
    const m = await createMonitor(monitorsDeps, account, input(), T0);
    await recordPing(db, m.id, T0);
    await recordPing(db, m.id, at(80_000));
    expect(await sweepExpiredMonitors(db, at(100_000))).toEqual({ died: 0, alerts: 0 });
    expect(await sweepExpiredMonitors(db, at(170_000))).toMatchObject({ died: 1 });
  });

  it('delivers signed down and up alerts to the webhook and Telegram', async () => {
    const m = await createMonitor(monitorsDeps, account, input(), T0);
    await recordPing(db, m.id, T0);
    await sweepExpiredMonitors(db, at(90_000));

    const before = target.received.length;
    expect((await deliverAlerts(at(90_000))).sort()).toEqual(['success', 'success']);
    const req = target.received[before]!;
    const body = JSON.parse(req.body) as { event: string; monitor: Record<string, unknown> };
    expect(body).toMatchObject({
      event: 'monitor.down',
      occurredAt: at(90_000).toISOString(),
      monitor: { id: m.id, name: 'agent-7', status: 'dead', lastPingAt: T0.toISOString() },
    });
    expect(req.headers['t2l-event']).toBe('monitor.down');
    expect(req.headers['t2l-monitor-id']).toBe(m.id);
    const secret = await getOrCreateWebhookSecret(db, key, account.id);
    const sig = req.headers['t2l-signature'] as string;
    expect(verifySignature(secret, req.body, sig, Number(/t=(\d+)/.exec(sig)![1]))).toBe(true);

    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]!.chatId).toBe('4242');
    expect(tg.sent[0]!.text).toContain('"agent-7" is DOWN');

    // Recovery.
    const ping = await recordPing(db, m.id, at(120_000));
    expect(ping).toMatchObject({ previous: 'dead', monitor: { status: 'alive', deadSince: null } });
    await deliverAlerts(at(120_000));
    const up = JSON.parse(target.received[before + 1]!.body) as {
      event: string;
      monitor: { deadSince: string };
    };
    expect(up.event).toBe('monitor.up');
    expect(up.monitor.deadSince).toBe(at(90_000).toISOString());
    expect(tg.sent[1]!.text).toContain('back UP');

    const events = await db
      .select()
      .from(schema.monitorEvents)
      .where(eq(schema.monitorEvents.monitorId, m.id))
      .orderBy(schema.monitorEvents.id);
    expect(events.map((e) => `${e.fromStatus}>${e.toStatus}:${e.reason}`)).toEqual([
      'new>alive:ping',
      'alive>dead:timeout',
      'dead>alive:ping',
    ]);
  });

  it('only queues channels that are configured', async () => {
    const m = await createMonitor(
      monitorsDeps,
      account,
      input({ alertWebhookUrl: null, alertTelegram: false }),
      T0,
    );
    await recordPing(db, m.id, T0);
    expect(await sweepExpiredMonitors(db, at(90_000))).toEqual({ died: 1, alerts: 0 });
  });

  it('marks frozen accounts dead but sends no alerts', async () => {
    const m = await createMonitor(monitorsDeps, account, input(), T0);
    await recordPing(db, m.id, T0);
    await freezeAccount(db, account.id, 'abuse');
    expect(await sweepExpiredMonitors(db, at(90_000))).toEqual({ died: 1, alerts: 0 });
  });

  it('never double-alerts with concurrent sweepers', async () => {
    // Inserted directly: the tier limit would stop us at 3 through the API.
    for (let i = 0; i < 10; i++) {
      await database.pool.query(
        `insert into monitors (id, account_id, name, ttl_seconds, grace_seconds, status,
           last_ping_at, expires_at, alert_webhook_url)
         values ($1, $2, 'm', 60, 30, 'alive', $3, $4, $5)`,
        [`mon_${String(i).padStart(22, '0')}`, account.id, T0, at(90_000), target.url('/a')],
      );
    }
    const results = await Promise.all(
      Array.from({ length: 4 }, () => sweepExpiredMonitors(db, at(90_000))),
    );
    expect(results.reduce((n, r) => n + r.died, 0)).toBe(10);
    const { rows } = await database.pool.query('select count(*)::int n from alert_deliveries');
    expect(rows[0].n).toBe(10);
  });
});

describe('alert delivery', () => {
  async function deadMonitor(over: Partial<MonitorInput> = {}) {
    const m = await createMonitor(monitorsDeps, account, input(over), T0);
    await recordPing(db, m.id, T0);
    await sweepExpiredMonitors(db, at(90_000));
    return m;
  }

  it('retries failing webhooks with backoff', async () => {
    let calls = 0;
    target.setHandler((_r, res) => {
      res.statusCode = ++calls < 2 ? 502 : 200;
      res.end();
    });
    const m = await deadMonitor({ alertTelegram: false });
    expect(await deliverAlerts(at(90_000))).toEqual(['retry']);
    const [a] = await alertsOf(m.id);
    expect(a).toMatchObject({ status: 'pending', attempts: 1, lastHttpStatus: 502 });
    expect(a!.nextAttemptAt).toEqual(at(100_000));
    expect(await deliverAlerts(at(100_000))).toEqual(['success']);
    expect((await alertsOf(m.id))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('retries Telegram 429 honouring retry_after, fails on 400', async () => {
    const m = await deadMonitor({ alertWebhookUrl: null });
    tg.respondWith(() => ({
      ok: false,
      status: 429,
      retryAfterSeconds: 120,
      error: 'Too Many Requests',
    }));
    expect(await deliverAlerts(at(90_000))).toEqual(['retry']);
    expect((await alertsOf(m.id))[0]!.nextAttemptAt).toEqual(at(90_000 + 120_000));

    tg.respondWith(() => ({ ok: false, status: 400, error: 'chat not found' }));
    expect(await deliverAlerts(at(210_000))).toEqual(['fail']);
    expect((await alertsOf(m.id))[0]).toMatchObject({
      status: 'failed',
      lastError: 'chat not found',
    });
  });

  it('cancels Telegram alerts when the chat was unlinked and fails when the bot is unconfigured', async () => {
    const m = await deadMonitor({ alertWebhookUrl: null });
    await database.pool.query('update accounts set telegram_chat_id = null');
    expect(await deliverAlerts(at(90_000))).toEqual(['cancelled']);
    expect((await alertsOf(m.id))[0]!.lastError).toBe('no Telegram chat linked');

    await database.pool.query(`update accounts set telegram_chat_id = '1'`);
    const m2 = await deadMonitor({ alertWebhookUrl: null });
    expect(await deliverAlerts(at(90_000), { telegram: undefined })).toEqual(['fail']);
    expect((await alertsOf(m2.id))[0]!.lastError).toMatch(/not configured/);
  });

  it('delivers to an independent secondary webhook alongside the primary', async () => {
    const hits: string[] = [];
    target.setHandler((r, res) => {
      hits.push(r.url ?? '');
      res.end('ok');
    });
    const m = await createMonitor(
      monitorsDeps,
      account,
      input({
        alertWebhookUrl: target.url('/primary'),
        alertWebhookUrl2: target.url('/backup'),
        alertTelegram: false,
      }),
      T0,
    );
    await recordPing(db, m.id, T0);
    await sweepExpiredMonitors(db, at(90_000));
    const outcomes = await deliverAlerts(at(90_000));
    expect(outcomes.sort()).toEqual(['success', 'success']);
    expect(hits.sort()).toEqual(['/backup', '/primary']);
    expect((await alertsOf(m.id)).map((a) => a.channel).sort()).toEqual(['webhook', 'webhook2']);
  });

  it('delivers an email alert, retries 5xx and fails on a 4xx', async () => {
    const withEmail = (over: Partial<MonitorInput> = {}) =>
      deadMonitor({
        alertWebhookUrl: null,
        alertTelegram: false,
        alertEmail: 'oncall@example.com',
        ...over,
      });

    const m = await withEmail();
    expect(await deliverAlerts(at(90_000))).toEqual(['success']);
    expect(em.sent).toHaveLength(1);
    expect(em.sent[0]).toMatchObject({ to: 'oncall@example.com' });
    expect(em.sent[0]!.subject).toContain('is DOWN');
    expect((await alertsOf(m.id))[0]).toMatchObject({ status: 'succeeded', channel: 'email' });

    em.respondWith(() => ({ ok: false, status: 503, error: 'upstream' }));
    const m2 = await withEmail();
    expect(await deliverAlerts(at(90_000))).toEqual(['retry']);
    em.respondWith(() => ({ ok: false, status: 422, error: 'invalid recipient' }));
    expect(await deliverAlerts(at(200_000))).toEqual(['fail']);
    expect((await alertsOf(m2.id))[0]).toMatchObject({
      status: 'failed',
      lastError: 'invalid recipient',
    });
  });

  it('fails email delivery cleanly when the server has no email client', async () => {
    const m = await deadMonitor({
      alertWebhookUrl: null,
      alertTelegram: false,
      alertEmail: 'oncall@example.com',
    });
    expect(await deliverAlerts(at(90_000), { email: undefined })).toEqual(['fail']);
    expect((await alertsOf(m.id))[0]!.lastError).toMatch(/not configured/);
  });

  it('cancels pending alerts when the monitor is paused', async () => {
    const m = await deadMonitor();
    await pauseMonitor(db, account.id, m.id, at(91_000));
    expect(await deliverAlerts(at(92_000))).toEqual([]);
    expect((await alertsOf(m.id)).map((a) => a.status)).toEqual(['cancelled', 'cancelled']);
  });
});

describe('retention', () => {
  it('removes monitor events and finished alerts after 30 days', async () => {
    const m = await createMonitor(monitorsDeps, account, input(), T0);
    await recordPing(db, m.id, T0);
    await sweepExpiredMonitors(db, at(90_000));
    await deliverAlerts(at(90_000));
    const removed = await cleanupExpired(db, at(31 * 24 * 3600_000));
    expect(removed).toMatchObject({ monitorEvents: 2, alertDeliveries: 2 });
    expect(await alertsOf(m.id)).toHaveLength(0);
  });
});

describe('worker process', () => {
  it('sweeps and alerts end to end', async () => {
    const worker = createWorker({
      config: testConfig({ WEBHOOK_DEV_ALLOW_LOCAL: 'true' }),
      database,
      logger: silentLogger,
      workerId: 'e2e-monitors',
      telegram: tg.client,
    });
    const m = await createMonitor(
      monitorsDeps,
      account,
      input({ ttlSeconds: 60, graceSeconds: 0 }),
      T0,
    );
    await recordPing(db, m.id, new Date(Date.now() - 61_000));
    const before = target.received.length;
    await worker.runOnce();
    await worker.stop();
    expect((await monitorById(m.id)).status).toBe('dead');
    expect(target.received.length).toBe(before + 1);
    expect(tg.sent).toHaveLength(1);
  });
});
