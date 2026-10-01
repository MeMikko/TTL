import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, newWallet, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const cronJob = {
  name: 'wake',
  schedule: { type: 'cron', expression: '*/15 * * * *', timezone: 'UTC' },
  target: { url: 'http://127.0.0.1:9/hook' },
};

describe('analytics', () => {
  it('serves live fleet-wide stats to the gated wallet', async () => {
    const wallet = newWallet();
    const app = buildApp(database, {
      config: testConfig({
        PUBLIC_BASE_URL: 'https://time2live.xyz',
        WEBHOOK_DEV_ALLOW_LOCAL: 'true',
        ANALYTICS_ADDRESS: wallet.address, // gate to this wallet
      }),
    });
    const me = await signIn(app, wallet);
    const h = bearer(me.apiKey.key);
    await app.request('/v1/jobs', json(cronJob, h));
    const mon = (await (
      await app.request('/v1/monitors', json({ name: 'm1', ttlSeconds: 300 }, h))
    ).json()) as { id: string };
    await app.request(`/v1/heartbeat/${mon.id}`, { method: 'POST' }); // → alive

    const res = await app.request('/v1/analytics', { headers: h });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const a = (await res.json()) as {
      accounts: { total: number; new: number };
      monitors: { total: number; byStatus: Record<string, number> };
      jobs: { total: number; byStatus: Record<string, number> };
      runs: { total: number };
      payments: { count: number; revenueUsd: string };
      switches: { total: number; live: number };
    };
    expect(a.accounts.total).toBe(1);
    expect(a.jobs.total).toBe(1);
    expect(a.jobs.byStatus.active).toBe(1);
    expect(a.monitors.total).toBe(1);
    expect(a.monitors.byStatus.alive).toBe(1);
    expect(a.payments).toMatchObject({ count: 0, revenueUsd: '$0.00' });
    expect(typeof a.switches.total).toBe('number');
  });

  it('forbids a wallet that is not the gate', async () => {
    const gate = newWallet();
    const app = buildApp(database, {
      config: testConfig({ ANALYTICS_ADDRESS: gate.address }),
    });
    const other = await signIn(app, newWallet()); // a different wallet
    const res = await app.request('/v1/analytics', { headers: bearer(other.apiKey.key) });
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const app = buildApp(database, {
      config: testConfig({ ANALYTICS_ADDRESS: newWallet().address }),
    });
    expect((await app.request('/v1/analytics')).status).toBe(401);
  });

  it('404s when analytics is disabled', async () => {
    const wallet = newWallet();
    const app = buildApp(database, { config: testConfig({ ANALYTICS_ADDRESS: '' }) });
    const me = await signIn(app, wallet);
    const res = await app.request('/v1/analytics', { headers: bearer(me.apiKey.key) });
    expect(res.status).toBe(404);
  });

  it('serves the analytics page', async () => {
    const app = buildApp(database, {
      config: testConfig({ PUBLIC_BASE_URL: 'https://time2live.xyz' }),
    });
    const res = await app.request('/analytics');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('/v1/analytics');
    expect(html).toContain('/ analytics');
  });
});
