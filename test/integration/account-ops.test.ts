import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, newWallet, requestChallenge, resetDb, signIn } from '../helpers/auth.js';

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

describe('operator wallet session', () => {
  it('signs in with the wallet and authorizes the operator endpoints', async () => {
    const app = buildApp(database, {
      config: testConfig({ PUBLIC_BASE_URL: 'https://time2live.xyz' }),
    });
    const wallet = newWallet();
    const { message } = await requestChallenge(app, wallet.address);
    const signature = await wallet.signMessage({ message });
    const res = await app.request('/v1/auth/session', json({ message, signature }));
    expect(res.status).toBe(200);
    const sess = (await res.json()) as { token: string; address: string; expiresAt: string };
    expect(sess.token).toMatch(/^t2ls_/);

    // The session token works on the operator endpoints, like an API key.
    const h = { authorization: `Bearer ${sess.token}` };
    const overview = await app.request('/v1/account/overview', { headers: h });
    expect(overview.status).toBe(200);
    const ov = (await overview.json()) as { account: { address: string } };
    expect(ov.account.address.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect((await app.request('/v1/account/pause-all', json({}, h))).status).toBe(200);

    // A used challenge cannot be replayed for a second session.
    expect((await app.request('/v1/auth/session', json({ message, signature }))).status).toBe(401);
    // A garbage session token is rejected.
    expect(
      (
        await app.request('/v1/account/overview', {
          headers: { authorization: 'Bearer t2ls_nope' },
        })
      ).status,
    ).toBe(401);
  });

  it('survives revoke-all, so the human keeps access while agent keys die', async () => {
    const app = buildApp(database, {
      config: testConfig({ PUBLIC_BASE_URL: 'https://time2live.xyz' }),
    });
    const wallet = newWallet();
    // Mint an API key (the "agent") and an operator session for the same wallet.
    const signed = await signIn(app, wallet);
    const { message } = await requestChallenge(app, wallet.address);
    const sess = (await (
      await app.request(
        '/v1/auth/session',
        json({ message, signature: await wallet.signMessage({ message }) }),
      )
    ).json()) as { token: string };

    const sh = { authorization: `Bearer ${sess.token}` };
    expect((await app.request('/v1/account/keys/revoke-all', json({}, sh))).status).toBe(200);
    // Agent key is dead…
    expect((await app.request('/v1/account', { headers: bearer(signed.apiKey.key) })).status).toBe(
      401,
    );
    // …but the operator session still works.
    expect((await app.request('/v1/account/overview', { headers: sh })).status).toBe(200);
  });

  it('serves the operator dashboard page', async () => {
    const app = buildApp(database, {
      config: testConfig({ PUBLIC_BASE_URL: 'https://time2live.xyz' }),
    });
    const res = await app.request('/dashboard');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('/v1/auth/session');
    expect(html).toContain('Pause everything');
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
