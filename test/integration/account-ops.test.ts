import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

async function setup() {
  let now = new Date('2026-09-30T12:00:00Z');
  const app = buildApp(database, {
    config: testConfig({
      WEBHOOK_DEV_ALLOW_LOCAL: 'true',
      PUBLIC_BASE_URL: 'https://time2live.xyz',
    }),
    now: () => now,
  });
  const me = await signIn(app);
  const h = bearer(me.apiKey.key);
  return {
    app,
    me,
    setNow: (d: Date) => (now = d),
    post: (path: string, body: unknown = {}, extra: Record<string, string> = {}) =>
      app.request(path, json(body, { ...h, ...extra })),
    get: (path: string, key = me.apiKey.key) =>
      app.request(path, { headers: { authorization: `Bearer ${key}` } }),
  };
}

const cronJob = {
  name: 'wake',
  schedule: { type: 'cron', expression: '*/15 * * * *', timezone: 'UTC' },
  target: { url: 'http://127.0.0.1:9/hook' },
};

describe('emergency stop', () => {
  it('pause-all pauses every job and monitor and cancels pending work', async () => {
    const { post, get } = await setup();
    const job = (await (await post('/v1/jobs', cronJob)).json()) as { id: string };
    await post(`/v1/jobs/${job.id}/trigger`); // creates a pending run
    const mon = (await (await post('/v1/monitors', { name: 'm1', ttlSeconds: 300 })).json()) as {
      id: string;
    };

    const res = await post('/v1/account/pause-all');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobsPaused: 1, monitorsPaused: 1 });

    expect(((await (await get(`/v1/jobs/${job.id}`)).json()) as { status: string }).status).toBe(
      'paused',
    );
    expect(
      ((await (await get(`/v1/monitors/${mon.id}`)).json()) as { status: string }).status,
    ).toBe('paused');
    const runs = (await (await get(`/v1/jobs/${job.id}/runs`)).json()) as {
      data: Array<{ status: string }>;
    };
    expect(runs.data.every((r) => r.status === 'cancelled')).toBe(true);

    // Idempotent: a second call pauses nothing more.
    expect(await (await post('/v1/account/pause-all')).json()).toEqual({
      jobsPaused: 0,
      monitorsPaused: 0,
    });
  });

  it('revoke-all locks out the agent immediately, including the calling key', async () => {
    const { post, get, me } = await setup();
    const res = await post('/v1/account/keys/revoke-all');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: 1 });
    // The key that made the call is now dead.
    expect((await get('/v1/account', me.apiKey.key)).status).toBe(401);
  });
});

describe('operator overview', () => {
  it('returns a one-call snapshot of the fleet', async () => {
    const { post, get } = await setup();
    await post('/v1/jobs', cronJob);
    const mon = (await (await post('/v1/monitors', { name: 'm1', ttlSeconds: 300 })).json()) as {
      id: string;
      pingUrl: string;
    };
    await post(`/v1/heartbeat/${mon.id}`); // ping → alive

    const res = await get('/v1/account/overview');
    expect(res.status).toBe(200);
    const o = (await res.json()) as {
      account: { tier: string; credits: { balanceUsd: string } };
      monitors: { counts: Record<string, number>; recent: Array<{ status: string }> };
      jobs: { counts: Record<string, number>; recent: unknown[] };
      payments: unknown[];
    };
    expect(o.account.tier).toBe('unactivated');
    expect(o.jobs.counts.active).toBe(1);
    expect(o.monitors.counts.alive).toBe(1);
    expect(o.monitors.recent[0]).toMatchObject({ name: 'm1', status: 'alive' });
    expect(o.payments).toEqual([]);
  });
});
