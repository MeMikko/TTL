import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const T0 = new Date('2026-09-29T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

async function setup(configOverrides: Record<string, string> = {}) {
  let now = T0;
  const app = buildApp(database, {
    config: testConfig({
      WEBHOOK_DEV_ALLOW_LOCAL: 'true',
      PUBLIC_BASE_URL: 'https://time2live.xyz',
      ...configOverrides,
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
    patch: (path: string, body: unknown) =>
      app.request(path, { ...json(body, h), method: 'PATCH' }),
    get: (path: string) => app.request(path, { headers: h }),
    ping: (id: string) => app.request(`/v1/heartbeat/${id}`, { method: 'POST' }),
  };
}

type MonitorBody = {
  id: string;
  status: string;
  pingUrl: string;
  expiresAt: string | null;
  lastPingAt: string | null;
};

const activate = (accountId: string) =>
  database.pool.query('update accounts set activated_at = now() where id = $1', [accountId]);

describe('monitors API', () => {
  it('creates a monitor that waits for its first ping', async () => {
    const { post } = await setup();
    const res = await post('/v1/monitors', { name: 'agent-1', ttlSeconds: 300 });
    expect(res.status).toBe(201);
    const m = (await res.json()) as MonitorBody;
    expect(m).toMatchObject({
      id: expect.stringMatching(/^mon_[0-9A-Za-z]{22}$/),
      status: 'new',
      ttlSeconds: 300,
      graceSeconds: 60,
      lastPingAt: null,
      expiresAt: null,
      alerts: { webhookUrl: null, telegram: false },
    });
    expect(m.pingUrl).toBe(`https://time2live.xyz/v1/heartbeat/${m.id}`);
  });

  it('enforces the tier monitor limit with 402', async () => {
    const { post, me } = await setup();
    expect((await post('/v1/monitors', { name: 'a', ttlSeconds: 60 })).status).toBe(201);
    const second = await post('/v1/monitors', { name: 'b', ttlSeconds: 60 });
    expect(second.status).toBe(402);
    expect(await second.json()).toMatchObject({ error: { code: 'quota_exceeded' } });
    await activate(me.accountId); // free tier: 3 monitors
    expect((await post('/v1/monitors', { name: 'b', ttlSeconds: 60 })).status).toBe(201);
  });

  it('validates input', async () => {
    const { post } = await setup();
    for (const body of [
      { name: 'x', ttlSeconds: 59 },
      { name: 'x', ttlSeconds: 31 * 24 * 3600 },
      { name: '', ttlSeconds: 60 },
      { name: 'x', ttlSeconds: 60, graceSeconds: -1 },
      { name: 'x', ttlSeconds: 60.5 },
    ]) {
      expect((await post('/v1/monitors', body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('applies the SSRF policy to both alert webhooks', async () => {
    const { post } = await setup({ WEBHOOK_DEV_ALLOW_LOCAL: 'false' });
    for (const alerts of [
      { webhookUrl: 'https://169.254.169.254/' },
      { webhookUrl2: 'https://169.254.169.254/' },
    ]) {
      const res = await post('/v1/monitors', { name: 'x', ttlSeconds: 60, alerts });
      expect(res.status, JSON.stringify(alerts)).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_target' } });
    }
  });

  it('rejects email alerts unless the server has email configured', async () => {
    const { post } = await setup();
    const res = await post('/v1/monitors', {
      name: 'x',
      ttlSeconds: 60,
      alerts: { email: 'oncall@example.com' },
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'email_not_configured' } });

    const bad = await post('/v1/monitors', {
      name: 'x',
      ttlSeconds: 60,
      alerts: { email: 'not-an-email' },
    });
    expect(bad.status).toBe(400); // schema-level validation
  });

  it('stores and returns the independent secondary webhook and email when enabled', async () => {
    const { post } = await setup({
      WEBHOOK_DEV_ALLOW_LOCAL: 'true',
      RESEND_API_KEY: 'test-key',
      ALERT_EMAIL_FROM: 'time2live <alerts@time2live.xyz>',
    });
    const res = await post('/v1/monitors', {
      name: 'agent-7',
      ttlSeconds: 300,
      alerts: {
        webhookUrl: 'http://127.0.0.1:9/primary',
        webhookUrl2: 'http://127.0.0.1:9/backup',
        email: 'oncall@example.com',
      },
    });
    expect(res.status).toBe(201);
    expect((await res.json()) as MonitorBody).toMatchObject({
      alerts: {
        webhookUrl: 'http://127.0.0.1:9/primary',
        webhookUrl2: 'http://127.0.0.1:9/backup',
        telegram: false,
        email: 'oncall@example.com',
      },
    });
  });

  it('is idempotent with Idempotency-Key', async () => {
    const { post, me } = await setup();
    await activate(me.accountId);
    const a = (await (
      await post('/v1/monitors', { name: 'x', ttlSeconds: 60 }, { 'idempotency-key': 'm1' })
    ).json()) as MonitorBody;
    const b = (await (
      await post('/v1/monitors', { name: 'x', ttlSeconds: 60 }, { 'idempotency-key': 'm1' })
    ).json()) as MonitorBody;
    expect(b.id).toBe(a.id);
  });
});

describe('POST /v1/heartbeat/:id', () => {
  it('needs no API key and turns new → alive with a fresh expiry', async () => {
    const { post, ping, get, setNow } = await setup();
    const m = (await (
      await post('/v1/monitors', { name: 'a', ttlSeconds: 300, graceSeconds: 30 })
    ).json()) as MonitorBody;
    setNow(at(1000));
    const res = await ping(m.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: m.id,
      status: 'alive',
      previousStatus: 'new',
      expiresAt: at(1000 + 330_000).toISOString(),
    });
    expect(await (await get(`/v1/monitors/${m.id}`)).json()).toMatchObject({
      status: 'alive',
      lastPingAt: at(1000).toISOString(),
    });
  });

  it('returns 404 for unknown monitors and 400 for malformed ids', async () => {
    const { ping } = await setup();
    expect((await ping('mon_0000000000000000000000')).status).toBe(404);
    expect((await ping('nope')).status).toBe(400);
  });

  it('rate limits pings per monitor', async () => {
    const { post, ping } = await setup({ RATE_LIMIT_PING_PER_MIN: '2' });
    const m = (await (
      await post('/v1/monitors', { name: 'a', ttlSeconds: 60 })
    ).json()) as MonitorBody;
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await ping(m.id)).status);
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('keeps paused monitors paused but records the ping', async () => {
    const { post, ping, get, setNow } = await setup();
    const m = (await (
      await post('/v1/monitors', { name: 'a', ttlSeconds: 60 })
    ).json()) as MonitorBody;
    await ping(m.id);
    expect(await (await post(`/v1/monitors/${m.id}/pause`)).json()).toMatchObject({
      status: 'paused',
      expiresAt: null,
    });
    setNow(at(5000));
    expect(await (await ping(m.id)).json()).toMatchObject({
      status: 'paused',
      previousStatus: 'paused',
    });
    expect(await (await get(`/v1/monitors/${m.id}`)).json()).toMatchObject({
      status: 'paused',
      lastPingAt: at(5000).toISOString(),
    });

    setNow(at(10_000));
    expect(await (await post(`/v1/monitors/${m.id}/resume`)).json()).toMatchObject({
      status: 'alive',
      expiresAt: at(10_000 + 120_000).toISOString(),
    });
  });

  it('recomputes expiry when the TTL changes', async () => {
    const { post, ping, patch } = await setup();
    const m = (await (
      await post('/v1/monitors', { name: 'a', ttlSeconds: 60, graceSeconds: 0 })
    ).json()) as MonitorBody;
    await ping(m.id);
    const res = await patch(`/v1/monitors/${m.id}`, {
      ttlSeconds: 600,
      alerts: { telegram: true },
    });
    expect(await res.json()).toMatchObject({
      ttlSeconds: 600,
      expiresAt: at(600_000).toISOString(),
      alerts: { telegram: true },
    });
  });

  it('lists status transitions', async () => {
    const { post, ping, get } = await setup();
    const m = (await (
      await post('/v1/monitors', { name: 'a', ttlSeconds: 60 })
    ).json()) as MonitorBody;
    await ping(m.id);
    await ping(m.id); // alive → alive is not an event
    await post(`/v1/monitors/${m.id}/pause`);
    const events = (await (await get(`/v1/monitors/${m.id}/events?limit=1`)).json()) as {
      data: Array<{ from: string; to: string; reason: string }>;
      nextCursor: string;
    };
    expect(events.data).toEqual([
      { from: 'alive', to: 'paused', reason: 'pause', at: T0.toISOString() },
    ]);
    const rest = (await (
      await get(`/v1/monitors/${m.id}/events?cursor=${events.nextCursor}`)
    ).json()) as {
      data: Array<{ reason: string }>;
      nextCursor: string | null;
    };
    expect(rest.data.map((e) => e.reason)).toEqual(['ping']);
    expect(rest.nextCursor).toBeNull();
  });

  it('isolates accounts and supports delete', async () => {
    const alice = await setup();
    const m = (await (
      await alice.post('/v1/monitors', { name: 'a', ttlSeconds: 60 })
    ).json()) as MonitorBody;
    const bob = await signIn(alice.app);
    const res = await alice.app.request(`/v1/monitors/${m.id}`, {
      headers: bearer(bob.apiKey.key),
    });
    expect(res.status).toBe(404);
    const del = await alice.app.request(`/v1/monitors/${m.id}`, {
      method: 'DELETE',
      headers: bearer(alice.me.apiKey.key),
    });
    expect(del.status).toBe(200);
    expect((await alice.ping(m.id)).status).toBe(404);
  });
});
