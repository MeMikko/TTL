import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../../src/core/db/index.js';
import { renewPaidMonitors } from '../../src/core/monitors.js';
import { scheduleDueJobs } from '../../src/worker/scheduler.js';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, newWallet, resetDb, signIn } from '../helpers/auth.js';
import {
  challengeOf,
  FakeFacilitator,
  PAY_TO,
  payer,
  receiptOf,
  testGateway,
} from '../helpers/x402.js';

const database = testDatabase();
const db = database.db;
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const T0 = new Date('2026-09-29T12:00:00Z');
const DAY = 24 * 3600_000;
const at = (ms: number) => new Date(T0.getTime() + ms);
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

async function setup(opts: { payments?: 'on' | 'off'; facilitator?: FakeFacilitator } = {}) {
  let now = T0;
  const { gateway, facilitator } = testGateway(opts.facilitator);
  const app = buildApp(database, {
    config: testConfig({
      WEBHOOK_DEV_ALLOW_LOCAL: 'true',
      PUBLIC_BASE_URL: 'https://time2live.xyz',
    }),
    now: () => now,
    payments: opts.payments === 'off' ? null : gateway,
  });
  const me = await signIn(app);
  const h = bearer(me.apiKey.key);
  const wallet = payer(newWallet());
  const post = (path: string, body: unknown = {}, extra: Record<string, string> = {}) =>
    app.request(path, json(body, { ...h, ...extra }));
  return {
    app,
    me,
    facilitator,
    wallet,
    setNow: (d: Date) => (now = d),
    post,
    get: (path: string) => app.request(path, { headers: h }),
    /** Makes the request; on 402 pays the (first) offer and retries it once. */
    async paying(
      path: string,
      body: unknown = {},
      opts: { pick?: number; uncapped?: boolean } = {},
    ) {
      const first = await post(path, body);
      if (first.status !== 402) return first;
      return post(path, body, { 'payment-signature': await wallet.pay(first, opts) });
    },
  };
}

const account = async (id: string) =>
  (await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)))[0]!;
const setCredits = (id: string, micro: number) =>
  database.pool.query('update accounts set credit_micro = $2 where id = $1', [id, micro]);
const activate = (id: string) =>
  database.pool.query('update accounts set activated_at = now() where id = $1', [id]);
const useAllRuns = () => database.pool.query('update usage_counters set runs = 1000');

const cronJob = {
  name: 'wake agent',
  schedule: { type: 'cron', expression: '*/15 * * * *', timezone: 'UTC' },
  target: { url: 'http://127.0.0.1:9/hook' },
};

describe('x402 challenge', () => {
  it('answers an over-quota request with an x402 v2 PAYMENT-REQUIRED challenge', async () => {
    const { post } = await setup();
    expect((await post('/v1/monitors', { name: 'a', ttlSeconds: 60 })).status).toBe(201);
    const res = await post('/v1/monitors', { name: 'b', ttlSeconds: 60 });
    expect(res.status).toBe(402);

    const challenge = challengeOf(res);
    expect(challenge).toMatchObject({
      x402Version: 2,
      resource: { url: 'https://time2live.xyz/v1/monitors', mimeType: 'application/json' },
    });
    // Cheapest first: activation, then the $1 credit pack.
    expect(challenge.accepts).toEqual([
      expect.objectContaining({
        scheme: 'exact',
        network: 'eip155:84532',
        asset: USDC_BASE_SEPOLIA,
        amount: '100000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: expect.objectContaining({ product: 'activation', name: 'USDC', version: '2' }),
      }),
      expect.objectContaining({
        amount: '1000000',
        extra: expect.objectContaining({ product: 'credits-1' }),
      }),
    ]);
    // The JSON body mirrors the header and adds our usual error object.
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      x402Version: 2,
      accepts: challenge.accepts,
      error: { code: 'payment_required', message: expect.any(String) },
    });
  });

  it('offers only credits once the account is activated', async () => {
    const { me, post } = await setup();
    await activate(me.accountId);
    for (const name of ['a', 'b', 'c']) {
      expect((await post('/v1/monitors', { name, ttlSeconds: 60 })).status).toBe(201);
    }
    const res = await post('/v1/monitors', { name: 'd', ttlSeconds: 60 });
    expect(res.status).toBe(402);
    expect(challengeOf(res).accepts.map((a) => a.extra?.product)).toEqual(['credits-1']);
  });

  it('returns 503 when the facilitator cannot be reached', async () => {
    const facilitator = new FakeFacilitator();
    facilitator.down = true;
    const { post } = await setup({ facilitator });
    await post('/v1/monitors', { name: 'a', ttlSeconds: 60 });
    const res = await post('/v1/monitors', { name: 'b', ttlSeconds: 60 });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'payments_unavailable' } });
  });
});

describe('paying with x402', () => {
  it('pays the activation and retries the same request successfully', async () => {
    const { me, post, get, wallet, facilitator } = await setup();
    await post('/v1/monitors', { name: 'a', ttlSeconds: 60 });
    const denied = await post('/v1/monitors', { name: 'b', ttlSeconds: 60 });
    const signature = await wallet.pay(denied);

    const res = await post(
      '/v1/monitors',
      { name: 'b', ttlSeconds: 60 },
      { 'payment-signature': signature },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ billing: { plan: 'free', paidUntil: null } });
    const receipt = receiptOf(res);
    expect(receipt).toMatchObject({
      success: true,
      network: 'eip155:84532',
      transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
    expect(facilitator.settleCalls).toBe(1);

    expect((await account(me.accountId)).activatedAt).not.toBeNull();
    const billing = (await (await get('/v1/billing')).json()) as Record<string, unknown>;
    expect(billing).toMatchObject({
      x402: { enabled: true, network: 'eip155:84532', asset: 'USDC', payTo: PAY_TO },
      activated: true,
      tier: { name: 'free', limits: { monitors: 3, runsPerMonth: 100 } },
      credits: { balanceMicro: 0, balanceUsd: '$0.00' },
    });
    const payments = (await (await get('/v1/billing/payments')).json()) as {
      data: Array<Record<string, unknown>>;
    };
    expect(payments.data).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^pay_/),
        product: 'activation',
        amountUsd: '$0.10',
        transaction: receipt.transaction,
      }),
    ]);
  });

  it('activates explicitly via POST /v1/billing/activate', async () => {
    const { me, post, paying } = await setup();
    const res = await paying('/v1/billing/activate');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ purchased: 'activation', activated: true });
    expect((await account(me.accountId)).activatedAt).not.toBeNull();
    // Already activated: a no-op, no payment asked.
    const again = await post('/v1/billing/activate');
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ purchased: null, activated: true });
  });

  it('buys credit packs; bigger packs need a raised client spend cap', async () => {
    const { me, post, paying, wallet } = await setup();
    const res = await paying('/v1/billing/credits', { pack: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      purchased: 'credits-1',
      activated: true, // any payment activates the free tier
      credits: { balanceMicro: 1_000_000, balanceUsd: '$1.00' },
    });

    const five = await post('/v1/billing/credits', { pack: 5 });
    expect(five.status).toBe(402);
    expect(challengeOf(five).accepts[0]!.amount).toBe('5000000');
    await expect(wallet.pay(five)).rejects.toThrow(); // SDK default cap is $1
    const paid = await post(
      '/v1/billing/credits',
      { pack: 5 },
      { 'payment-signature': await wallet.pay(five, { uncapped: true }) },
    );
    expect(paid.status).toBe(200);
    expect((await account(me.accountId)).creditMicro).toBe(6_000_000);
  });

  it('never credits the same settlement twice', async () => {
    const { me, post, wallet } = await setup();
    const denied = await post('/v1/billing/credits', { pack: 1 });
    const signature = await wallet.pay(denied);
    const first = await post(
      '/v1/billing/credits',
      { pack: 1 },
      { 'payment-signature': signature },
    );
    const replay = await post(
      '/v1/billing/credits',
      { pack: 1 },
      { 'payment-signature': signature },
    );
    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    const [a, b] = [
      (await first.json()) as { paymentId: string },
      (await replay.json()) as { paymentId: string },
    ];
    expect(b.paymentId).toBe(a.paymentId);
    expect((await account(me.accountId)).creditMicro).toBe(1_000_000);
    const { rows } = await database.pool.query('select count(*)::int as n from payments');
    expect(rows[0].n).toBe(1);
  });

  it('rejects a payment for a product that is not on offer, before settling', async () => {
    const { me, post, wallet, facilitator } = await setup();
    const denied = await post('/v1/billing/activate');
    const signature = await wallet.pay(denied); // signed for activation
    await activate(me.accountId);
    const res = await post('/v1/billing/credits', { pack: 1 }, { 'payment-signature': signature });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'payment_mismatch' } });
    expect(facilitator.settleCalls).toBe(0);
  });

  it('rejects a payment signed for another recipient', async () => {
    const { post, wallet, facilitator } = await setup();
    const denied = await post('/v1/billing/activate');
    const header = denied.headers.get('payment-required')!;
    const forged = JSON.parse(Buffer.from(header, 'base64').toString());
    forged.accepts[0].payTo = '0x1111111111111111111111111111111111111111';
    const fake = new Response(null, {
      status: 402,
      headers: { 'payment-required': Buffer.from(JSON.stringify(forged)).toString('base64') },
    });
    const res = await post(
      '/v1/billing/activate',
      {},
      {
        'payment-signature': await wallet.pay(fake),
      },
    );
    expect(res.status).toBe(402);
    expect(facilitator.settleCalls).toBe(0);
  });

  it('reports a failed settlement and records nothing', async () => {
    const facilitator = new FakeFacilitator();
    facilitator.failSettle = true;
    const { me, post, wallet } = await setup({ facilitator });
    const denied = await post('/v1/billing/credits');
    const res = await post(
      '/v1/billing/credits',
      {},
      {
        'payment-signature': await wallet.pay(denied),
      },
    );
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: { code: 'invalid_exact_evm_insufficient_balance' },
    });
    expect(res.headers.get('payment-required')).toBeTruthy();
    expect((await account(me.accountId)).creditMicro).toBe(0);
    expect((await account(me.accountId)).activatedAt).toBeNull();
  });

  it('rejects a garbage PAYMENT-SIGNATURE header', async () => {
    const { post } = await setup();
    const res = await post('/v1/billing/credits', {}, { 'payment-signature': 'not-base64-json' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_payment_header' } });
  });

  it('does not store 402 responses under an idempotency key', async () => {
    const { post, wallet } = await setup();
    await post('/v1/monitors', { name: 'a', ttlSeconds: 60 });
    const body = { name: 'b', ttlSeconds: 60 };
    const key = { 'idempotency-key': 'create-b' };
    const denied = await post('/v1/monitors', body, key);
    expect(denied.status).toBe(402);
    const signature = await wallet.pay(denied);
    const created = await post('/v1/monitors', body, { ...key, 'payment-signature': signature });
    expect(created.status).toBe(201);
    const replayed = await post('/v1/monitors', body, key);
    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toEqual(await created.json());
  });
});

describe('off-the-shelf agent client', () => {
  it('works with @x402/fetch wrapFetchWithPayment unmodified', async () => {
    const { app, me } = await setup();
    const fetchApp = (input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(app.request(input instanceof Request ? input : String(input), init));
    const client = new x402Client().register('eip155:84532', new ExactEvmScheme(newWallet()));
    const pay = wrapFetchWithPayment(fetchApp as typeof fetch, client);
    const res = await pay('http://localhost/v1/billing/credits', {
      method: 'POST',
      headers: { authorization: `Bearer ${me.apiKey.key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ pack: 1 }),
    });
    expect(res.status).toBe(200);
    expect(receiptOf(res).success).toBe(true);
    expect((await account(me.accountId)).creditMicro).toBe(1_000_000);
  });
});

describe('credits', () => {
  it('charges manual runs beyond the free allowance to credits', async () => {
    const { me, post } = await setup();
    await activate(me.accountId);
    const job = (await (await post('/v1/jobs', cronJob)).json()) as { id: string };
    expect((await post(`/v1/jobs/${job.id}/trigger`)).status).toBe(202);
    await useAllRuns();

    await setCredits(me.accountId, 1_000);
    expect((await post(`/v1/jobs/${job.id}/trigger`)).status).toBe(202);
    expect((await account(me.accountId)).creditMicro).toBe(500);
    const { rows } = await database.pool.query(
      `select delta_micro, reason from credits_ledger where account_id = $1`,
      [me.accountId],
    );
    expect(rows).toEqual([{ delta_micro: '-500', reason: 'run' }]);
    expect((await post(`/v1/jobs/${job.id}/trigger`)).status).toBe(202);
    const broke = await post(`/v1/jobs/${job.id}/trigger`);
    expect(broke.status).toBe(402);
    expect(challengeOf(broke).accepts.map((a) => a.extra?.product)).toEqual(['credits-1']);
  });

  it('lets an agent pay its way past the run quota in one retry', async () => {
    const { me, post, paying } = await setup();
    await activate(me.accountId);
    const job = (await (await post('/v1/jobs', cronJob)).json()) as { id: string };
    await post(`/v1/jobs/${job.id}/trigger`); // creates this month's counter
    await useAllRuns();
    const res = await paying(`/v1/jobs/${job.id}/trigger`);
    expect(res.status).toBe(202);
    expect((await account(me.accountId)).creditMicro).toBe(1_000_000 - 500);
  });

  it('pays scheduled runs from credits, and skips them when the balance is too low', async () => {
    const { me, post } = await setup();
    await activate(me.accountId);
    const job = (await (await post('/v1/jobs', cronJob)).json()) as { id: string };
    await post(`/v1/jobs/${job.id}/trigger`);
    await useAllRuns();
    await setCredits(me.accountId, 500);

    expect(await scheduleDueJobs(db, at(15 * 60_000))).toEqual({ queued: 1, skipped: 0 });
    expect((await account(me.accountId)).creditMicro).toBe(0);
    expect(await scheduleDueJobs(db, at(30 * 60_000))).toEqual({ queued: 0, skipped: 1 });
    const { rows } = await database.pool.query(
      `select status, last_error from job_runs where job_id = $1 and trigger = 'schedule'
       order by scheduled_for`,
      [job.id],
    );
    expect(rows).toEqual([
      { status: 'pending', last_error: null },
      { status: 'skipped', last_error: 'monthly run quota exhausted and credit balance too low' },
    ]);
  });
});

describe('paid monitors', () => {
  async function withPaidMonitor() {
    const s = await setup();
    await activate(s.me.accountId);
    for (const name of ['a', 'b', 'c']) await s.post('/v1/monitors', { name, ttlSeconds: 60 });
    await setCredits(s.me.accountId, 600_000);
    const res = await s.post('/v1/monitors', {
      name: 'paid',
      ttlSeconds: 60,
      alerts: { webhookUrl: 'http://127.0.0.1:9/alerts' },
    });
    expect(res.status).toBe(201);
    const monitor = (await res.json()) as {
      id: string;
      billing: { plan: string; paidUntil: string };
    };
    return { ...s, monitor };
  }

  it('charges a monitor beyond the tier allowance for 30 days', async () => {
    const { me, monitor } = await withPaidMonitor();
    expect(monitor.billing).toEqual({ plan: 'paid', paidUntil: at(30 * DAY).toISOString() });
    expect((await account(me.accountId)).creditMicro).toBe(350_000);
  });

  it('renews from credits, then pauses with an alert when the balance runs out', async () => {
    const { me, monitor, get } = await withPaidMonitor();
    expect(await renewPaidMonitors(db, at(29 * DAY))).toEqual({ renewed: 0, paused: 0 });
    expect(await renewPaidMonitors(db, at(30 * DAY))).toEqual({ renewed: 1, paused: 0 });
    expect((await account(me.accountId)).creditMicro).toBe(100_000);

    expect(await renewPaidMonitors(db, at(60 * DAY))).toEqual({ renewed: 0, paused: 1 });
    const m = (await (await get(`/v1/monitors/${monitor.id}`)).json()) as Record<string, unknown>;
    expect(m).toMatchObject({
      status: 'paused',
      billing: { paidUntil: at(60 * DAY).toISOString() },
    });
    const events = (await (await get(`/v1/monitors/${monitor.id}/events`)).json()) as {
      data: Array<{ reason: string }>;
    };
    expect(events.data[0]).toMatchObject({ to: 'paused', reason: 'unpaid' });
    const { rows } = await database.pool.query(
      'select event, channel from alert_deliveries where monitor_id = $1',
      [monitor.id],
    );
    expect(rows).toEqual([{ event: 'monitor.unpaid', channel: 'webhook' }]);
  });

  it('charges again on resume after the period ended, paying via x402 if needed', async () => {
    const { me, monitor, post, setNow, wallet } = await withPaidMonitor();
    await setCredits(me.accountId, 0);
    await renewPaidMonitors(db, at(30 * DAY));
    setNow(at(31 * DAY));

    const denied = await post(`/v1/monitors/${monitor.id}/resume`);
    expect(denied.status).toBe(402);
    const res = await post(
      `/v1/monitors/${monitor.id}/resume`,
      {},
      {
        'payment-signature': await wallet.pay(denied),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'alive',
      billing: { plan: 'paid', paidUntil: at(61 * DAY).toISOString() },
    });
    expect((await account(me.accountId)).creditMicro).toBe(750_000);
  });
});

describe('with x402 disabled', () => {
  it('keeps the plain quota error and refuses payment endpoints', async () => {
    const { post, get } = await setup({ payments: 'off' });
    await post('/v1/monitors', { name: 'a', ttlSeconds: 60 });
    const over = await post('/v1/monitors', { name: 'b', ttlSeconds: 60 });
    expect(over.status).toBe(402);
    expect(over.headers.get('payment-required')).toBeNull();
    expect(await over.json()).toMatchObject({ error: { code: 'quota_exceeded' } });

    expect(await (await get('/v1/billing')).json()).toMatchObject({
      x402: { enabled: false, network: null, payTo: null },
    });
    expect((await post('/v1/billing/credits')).status).toBe(501);
    const signed = await post('/v1/billing/credits', {}, { 'payment-signature': 'x' });
    expect(signed.status).toBe(400);
    expect(await signed.json()).toMatchObject({ error: { code: 'payments_disabled' } });
  });
});
