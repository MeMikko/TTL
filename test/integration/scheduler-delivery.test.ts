import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findOrCreateAccount, freezeAccount } from '../../src/core/accounts.js';
import { schema } from '../../src/core/db/index.js';
import type { Account } from '../../src/core/db/schema.js';
import { verifySignature } from '../../src/core/hmac.js';
import {
  createJob,
  pauseJob,
  triggerJob,
  type JobInput,
  type JobsDeps,
} from '../../src/core/jobs.js';
import { RateLimiter } from '../../src/core/rate-limit.js';
import type { TargetPolicy } from '../../src/core/ssrf.js';
import { getOrCreateWebhookSecret } from '../../src/core/webhook-secret.js';
import { cleanupExpired } from '../../src/worker/cleanup.js';
import { LEASE_MS, claimRuns, processRun, type DeliveryDeps } from '../../src/worker/delivery.js';
import { createHttpClient } from '../../src/worker/http-client.js';
import { createWorker } from '../../src/worker/index.js';
import { scheduleDueJobs } from '../../src/worker/scheduler.js';
import { TEST_ENCRYPTION_KEY, silentLogger, testConfig, testDatabase } from '../helpers/app.js';
import { newWallet, resetDb } from '../helpers/auth.js';
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
const jobsDeps: JobsDeps = { db, encryptionKey: key, policy: devPolicy, maxJobsPerAccount: 100 };
const client = createHttpClient(devPolicy);
afterAll(() => client.close());

let account: Account;
beforeEach(async () => {
  await resetDb(database);
  account = (await findOrCreateAccount(db, newWallet().address)).account;
  target.setHandler((_r, res) => res.end('ok'));
});

const T0 = new Date('2026-09-29T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function deliveryDeps(now: () => Date, over: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return {
    db,
    client,
    encryptionKey: key,
    hostLimiter: RateLimiter.perMinute(1000),
    logger: silentLogger,
    now,
    random: () => 0.5,
    ...over,
  };
}

function input(over: Partial<JobInput> = {}): JobInput {
  return {
    name: 'test',
    schedule: { type: 'cron', expression: '*/5 * * * *', timezone: 'UTC' },
    target: {
      url: target.url('/hook'),
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
      body: '{"hello":"agent"}',
    },
    timeoutMs: 2000,
    maxAttempts: 3,
    ...over,
  };
}

const runsOf = (jobId: string) =>
  db.select().from(schema.jobRuns).where(eq(schema.jobRuns.jobId, jobId));
const jobById = async (id: string) =>
  (await db.select().from(schema.jobs).where(eq(schema.jobs.id, id)))[0]!;

/** Claims everything due at `now` and processes it. */
async function deliverAll(now: Date, over: Partial<DeliveryDeps> = {}) {
  const runs = await claimRuns(db, 50, now);
  const deps = deliveryDeps(() => now, over);
  return Promise.all(runs.map((r) => processRun(deps, r)));
}

describe('scheduler', () => {
  it('materialises due cron occurrences and advances next_run_at', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    expect(job.nextRunAt).toEqual(at(5 * 60_000));

    expect(await scheduleDueJobs(db, at(4 * 60_000))).toEqual({ queued: 0, skipped: 0 });
    expect(await scheduleDueJobs(db, at(5 * 60_000))).toEqual({ queued: 1, skipped: 0 });
    const [run] = await runsOf(job.id);
    expect(run).toMatchObject({
      status: 'pending',
      trigger: 'schedule',
      scheduledFor: at(5 * 60_000),
    });
    expect((await jobById(job.id)).nextRunAt).toEqual(at(10 * 60_000));
  });

  it('collapses missed occurrences after downtime into one run', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    expect(await scheduleDueJobs(db, at(62 * 60_000))).toEqual({ queued: 1, skipped: 0 });
    expect((await jobById(job.id)).nextRunAt).toEqual(at(65 * 60_000));
  });

  it('completes one-off jobs after scheduling them', async () => {
    const job = await createJob(
      jobsDeps,
      account,
      input({ schedule: { type: 'once', at: at(60_000) } }),
      T0,
    );
    await scheduleDueJobs(db, at(61_000));
    expect(await jobById(job.id)).toMatchObject({ status: 'completed', nextRunAt: null });
    expect(await runsOf(job.id)).toHaveLength(1);
    expect(await scheduleDueJobs(db, at(3600_000))).toEqual({ queued: 0, skipped: 0 });
  });

  it('records skipped runs once the monthly quota is used up', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await database.pool.query(
      `insert into usage_counters (account_id, period, runs) values ($1, '2026-09', 50)`,
      [account.id],
    );
    expect(await scheduleDueJobs(db, at(5 * 60_000))).toEqual({ queued: 0, skipped: 1 });
    const [run] = await runsOf(job.id);
    expect(run).toMatchObject({
      status: 'skipped',
      lastError: 'monthly run quota exhausted and credit balance too low',
    });
  });

  it('skips a stale catch-up past the freshness cutoff, delivers a fresh slot', async () => {
    // freshnessSeconds=120: a slot more than two minutes late is dropped, not delivered.
    const job = await createJob(jobsDeps, account, input({ freshnessSeconds: 120 }), T0);
    expect(job.freshnessSeconds).toBe(120);

    // After long downtime the scheduler wakes at 62 min; the first slot (5 min) is ~57 min late,
    // beyond the cutoff → recorded skipped, nothing delivered, nothing charged.
    expect(await scheduleDueJobs(db, at(62 * 60_000))).toEqual({ queued: 0, skipped: 1 });
    const [stale] = await runsOf(job.id);
    expect(stale).toMatchObject({ status: 'skipped', scheduledFor: at(5 * 60_000) });
    expect(stale!.lastError).toMatch(/^stale: scheduled \d+s ago, beyond freshnessSeconds=120$/);
    // The schedule still advances to the next future slot.
    expect((await jobById(job.id)).nextRunAt).toEqual(at(65 * 60_000));

    // The next on-time slot delivers normally.
    expect(await scheduleDueJobs(db, at(65 * 60_000))).toEqual({ queued: 1, skipped: 0 });
    expect((await runsOf(job.id)).find((r) => r.status === 'pending')).toMatchObject({
      scheduledFor: at(65 * 60_000),
    });
  });

  it('without a cutoff a stale catch-up is still delivered (default behaviour)', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    expect(job.freshnessSeconds).toBeNull();
    expect(await scheduleDueJobs(db, at(62 * 60_000))).toEqual({ queued: 1, skipped: 0 });
    expect((await runsOf(job.id))[0]).toMatchObject({ status: 'pending' });
  });

  it('does not create runs for frozen accounts but keeps the schedule moving', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await freezeAccount(db, account.id, 'test');
    expect(await scheduleDueJobs(db, at(5 * 60_000))).toEqual({ queued: 0, skipped: 0 });
    expect(await runsOf(job.id)).toHaveLength(0);
    expect((await jobById(job.id)).nextRunAt).toEqual(at(10 * 60_000));
  });

  it('never double-schedules under concurrent schedulers', async () => {
    for (let i = 0; i < 20; i++) await createJob(jobsDeps, account, input(), T0);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => scheduleDueJobs(db, at(5 * 60_000))),
    );
    expect(results.reduce((n, r) => n + r.queued, 0)).toBe(20);
    const { rows } = await database.pool.query('select count(*)::int n from job_runs');
    expect(rows[0].n).toBe(20);
  });
});

describe('delivery', () => {
  it('delivers a signed request and records the attempt', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await scheduleDueJobs(db, at(5 * 60_000));
    const before = target.received.length;
    expect(await deliverAll(at(5 * 60_000))).toEqual(['success']);

    const req = target.received[before]!;
    const [run] = await runsOf(job.id);
    expect(req.body).toBe('{"hello":"agent"}');
    expect(req.headers).toMatchObject({
      authorization: 'Bearer user-token',
      'content-type': 'application/json',
      't2l-delivery-id': run!.id,
      't2l-attempt': '1',
      't2l-event': 'job.run',
      't2l-job-id': job.id,
      't2l-scheduled-for': at(5 * 60_000).toISOString(),
    });
    const secret = await getOrCreateWebhookSecret(db, key, account.id);
    const sig = req.headers['t2l-signature'] as string;
    const t = Number(/t=(\d+)/.exec(sig)![1]);
    expect(verifySignature(secret, req.body, sig, t)).toBe(true);
    expect(verifySignature(secret, req.body + 'x', sig, t)).toBe(false);

    expect(run).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      lastHttpStatus: 200,
      lastError: null,
    });
    expect(await jobById(job.id)).toMatchObject({ lastRunStatus: 'succeeded' });
    const attempts = await db.select().from(schema.jobAttempts);
    expect(attempts).toMatchObject([{ attempt: 1, httpStatus: 200, responseSnippet: 'ok' }]);
  });

  it('retries 5xx with exponential backoff, then succeeds', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    const run = await triggerJob(db, account, job.id, T0);
    let calls = 0;
    target.setHandler((_r, res) => {
      calls++;
      res.statusCode = calls < 3 ? 503 : 200;
      res.end(calls < 3 ? 'busy' : 'done');
    });

    expect(await deliverAll(T0)).toEqual(['retry']);
    let [r] = await runsOf(job.id);
    expect(r).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastHttpStatus: 503,
      lastError: 'HTTP 503',
    });
    expect(r!.nextAttemptAt).toEqual(at(10_000));

    expect(await deliverAll(at(9_000))).toEqual([]); // not due yet
    expect(await deliverAll(at(10_000))).toEqual(['retry']);
    [r] = await runsOf(job.id);
    expect(r!.nextAttemptAt).toEqual(at(10_000 + 20_000));

    expect(await deliverAll(at(30_000))).toEqual(['success']);
    [r] = await runsOf(job.id);
    expect(r).toMatchObject({ id: run.id, status: 'succeeded', attempts: 3 });
    const attempts = await db.select().from(schema.jobAttempts);
    expect(attempts.map((a) => a.httpStatus)).toEqual([503, 503, 200]);
  });

  it('fails after max attempts and fails fast on 4xx', async () => {
    target.setHandler((r, res) => {
      res.statusCode = r.url === '/gone' ? 404 : 500;
      res.end();
    });
    const flaky = await createJob(jobsDeps, account, input({ maxAttempts: 2 }), T0);
    await triggerJob(db, account, flaky.id, T0);
    await deliverAll(T0);
    await deliverAll(at(3600_000));
    expect((await runsOf(flaky.id))[0]).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await jobById(flaky.id)).toMatchObject({ lastRunStatus: 'failed' });

    const gone = await createJob(
      jobsDeps,
      account,
      input({ target: { ...input().target, url: target.url('/gone') } }),
      T0,
    );
    await triggerJob(db, account, gone.id, T0);
    expect(await deliverAll(T0)).toEqual(['fail']);
    expect((await runsOf(gone.id))[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastHttpStatus: 404,
    });
  });

  it('refuses at delivery time when DNS now points somewhere private (rebinding)', async () => {
    // At creation time the name resolves to a public address…
    const creationDeps: JobsDeps = {
      ...jobsDeps,
      resolve: (_h, _o, cb) => cb(null, [{ address: '93.184.215.14', family: 4 }]),
    };
    // …and at delivery time it points at the metadata service.
    const job = await createJob(
      creationDeps,
      account,
      input({
        target: { ...input().target, url: `http://rebind.test.example:${target.port}/hook` },
      }),
      T0,
    );
    await triggerJob(db, account, job.id, T0);
    const strictClient = createHttpClient(
      { allowHttp: true, allowedPorts: null, allowPrivate: false, blockedCidrs: [] },
      { resolve: (_h, _o, cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]) },
    );
    const before = target.received.length;
    expect(await deliverAll(T0, { client: strictClient })).toEqual(['fail']);
    await strictClient.close();
    expect(target.received.length).toBe(before); // nothing was sent
    const [run] = await runsOf(job.id);
    expect(run!.status).toBe('failed');
    expect(run!.lastError).toMatch(/^blocked_target: .*169\.254\.169\.254/);
  });

  it('defers deliveries over the per-host limit without consuming attempts', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await triggerJob(db, account, job.id, T0);
    await triggerJob(db, account, job.id, T0);
    const hostLimiter = RateLimiter.perMinute(1, () => T0.getTime());
    const outcomes = await deliverAll(T0, { hostLimiter });
    expect(outcomes.sort()).toEqual(['deferred', 'success']);
    const deferred = (await runsOf(job.id)).find((r) => r.status === 'pending')!;
    expect(deferred.attempts).toBe(0);
    expect(deferred.nextAttemptAt).toEqual(at(60_000));
  });

  it('reclaims runs whose worker died (expired lease)', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await triggerJob(db, account, job.id, T0);
    expect(await claimRuns(db, 10, T0)).toHaveLength(1); // "worker" dies here
    expect(await claimRuns(db, 10, at(LEASE_MS - 1))).toHaveLength(0);
    expect(await deliverAll(at(LEASE_MS + 1))).toEqual(['success']);
    expect((await runsOf(job.id))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('never hands the same run to two concurrent claimers', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    for (let i = 0; i < 10; i++) await triggerJob(db, account, job.id, T0);
    const claims = await Promise.all(Array.from({ length: 5 }, () => claimRuns(db, 10, T0)));
    const ids = claims.flat().map((r) => r.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('cancels runs of paused jobs and frozen accounts', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await triggerJob(db, account, job.id, T0);
    const [claimed] = await claimRuns(db, 10, T0);
    await pauseJob(db, account.id, job.id, T0);
    expect(
      await processRun(
        deliveryDeps(() => T0),
        claimed!,
      ),
    ).toBe('cancelled');

    const other = await createJob(jobsDeps, account, input(), T0);
    await triggerJob(db, account, other.id, T0);
    await freezeAccount(db, account.id, 'abuse');
    expect(await deliverAll(T0)).toEqual(['cancelled']);
    expect((await runsOf(other.id))[0]).toMatchObject({
      status: 'cancelled',
      lastError: 'account frozen',
    });
  });
});

describe('retention', () => {
  it('deletes finished runs (and attempts) older than 30 days, keeps pending ones', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await triggerJob(db, account, job.id, T0);
    await deliverAll(T0);
    await triggerJob(db, account, job.id, T0); // stays pending
    const later = at(31 * 24 * 3600_000);
    const removed = await cleanupExpired(db, later);
    expect(removed.jobRuns).toBe(1);
    expect((await runsOf(job.id)).map((r) => r.status)).toEqual(['pending']);
    expect(await db.select().from(schema.jobAttempts)).toHaveLength(0);
  });

  it('a shorter configurable retention window removes finished runs sooner', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await triggerJob(db, account, job.id, T0);
    await deliverAll(T0);
    // 10 days later: default (30 d) keeps it, a 7-day window removes it.
    expect((await cleanupExpired(db, at(10 * 24 * 3600_000))).jobRuns).toBe(0);
    const removed = await cleanupExpired(db, at(10 * 24 * 3600_000), {
      historyRetentionMs: 7 * 24 * 3600_000,
    });
    expect(removed.jobRuns).toBe(1);
  });
});

describe('sandbox rolling wipe', () => {
  const accountExists = async (id: string) =>
    (await db.select().from(schema.accounts).where(eq(schema.accounts.id, id))).length === 1;

  it('wipes whole accounts past the TTL (cascade), and is a no-op without the option', async () => {
    const job = await createJob(jobsDeps, account, input(), T0);
    await triggerJob(db, account, job.id, T0);
    // The account's createdAt is ~now (findOrCreateAccount), so look 8 days ahead.
    const future = new Date(Date.now() + 8 * 24 * 3600_000);

    // No sandbox option → the account survives.
    expect((await cleanupExpired(db, future)).sandboxAccounts).toBe(0);
    expect(await accountExists(account.id)).toBe(true);

    // A 7-day sandbox TTL → the ~8-day-old account and all its data cascade away.
    const res = await cleanupExpired(db, future, { sandboxDataTtlMs: 7 * 24 * 3600_000 });
    expect(res.sandboxAccounts).toBe(1);
    expect(await accountExists(account.id)).toBe(false);
    expect(await runsOf(job.id)).toHaveLength(0); // cascaded
  });
});

describe('worker process', () => {
  it('schedules and delivers end to end', async () => {
    const worker = createWorker({
      config: testConfig({ WEBHOOK_DEV_ALLOW_LOCAL: 'true' }),
      database,
      logger: silentLogger,
      workerId: 'e2e',
    });
    const now = new Date();
    const job = await createJob(
      jobsDeps,
      account,
      input({ schedule: { type: 'once', at: now } }),
      now,
    );
    const before = target.received.length;
    await worker.runOnce();
    await worker.stop();
    expect(target.received.length).toBe(before + 1);
    expect((await runsOf(job.id))[0]).toMatchObject({ status: 'succeeded' });
    expect(await jobById(job.id)).toMatchObject({
      status: 'completed',
      lastRunStatus: 'succeeded',
    });
  });
});
