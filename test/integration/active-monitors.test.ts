import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepExpiredMonitors } from '../../src/core/monitors.js';
import type { TargetPolicy } from '../../src/core/ssrf.js';
import { createHttpClient } from '../../src/worker/http-client.js';
import { probeActiveMonitors } from '../../src/worker/monitor-probe.js';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, resetDb, signIn } from '../helpers/auth.js';
import { startTargetServer } from '../helpers/target-server.js';

const database = testDatabase();
const db = database.db;
const devPolicy: TargetPolicy = {
  allowHttp: true,
  allowedPorts: null,
  allowPrivate: true,
  blockedCidrs: [],
};
const client = createHttpClient(devPolicy);

let probeStatus = 200;
let probeBody = 'ok';
let target: Awaited<ReturnType<typeof startTargetServer>>;

const app = buildApp(database, {
  config: testConfig({ PUBLIC_BASE_URL: 'https://time2live.xyz', WEBHOOK_DEV_ALLOW_LOCAL: 'true' }),
});

beforeAll(async () => {
  target = await startTargetServer((_r, res) => {
    res.statusCode = probeStatus;
    res.end(probeBody);
  });
});

beforeEach(async () => {
  await resetDb(database);
  probeStatus = 200;
  probeBody = 'ok';
});

afterAll(async () => {
  await target.close();
  await client.close();
  await database.close();
});

async function createActive(key: string, overrides: Record<string, unknown> = {}) {
  return app.request(
    '/v1/monitors',
    json(
      {
        name: 'svc',
        ttlSeconds: 60,
        graceSeconds: 60,
        mode: 'active',
        check: { url: target.url('/health'), intervalSeconds: 30 },
        ...overrides,
      },
      bearer(key),
    ),
  );
}
const getMonitor = async (key: string, id: string) =>
  (await (await app.request(`/v1/monitors/${id}`, { headers: bearer(key) })).json()) as {
    status: string;
    mode: string;
    check: {
      url: string;
      intervalSeconds: number;
      expect: { status: number | null; bodyContains: string | null };
    } | null;
    lastProbe: { ok: boolean | null } | null;
  };

describe('active-check monitors', () => {
  it('a successful probe marks the monitor alive; a failing one lets it die', async () => {
    const me = await signIn(app);
    const created = (await (await createActive(me.apiKey.key)).json()) as { id: string };
    expect(created).toBeTruthy();

    const t0 = new Date();
    // Healthy probe → alive (travels the real path: an actual GET to the agent's URL).
    const r1 = await probeActiveMonitors(db, client, t0);
    expect(r1).toMatchObject({ probed: 1, up: 1, down: 0 });
    let m = await getMonitor(me.apiKey.key, created.id);
    expect(m.status).toBe('alive');
    expect(m.mode).toBe('active');
    expect(m.check?.url).toBe(target.url('/health'));
    expect(m.lastProbe?.ok).toBe(true);

    // Front door closes: probes now fail, so no ping is recorded…
    probeStatus = 503;
    const t1 = new Date(t0.getTime() + 31_000);
    const r2 = await probeActiveMonitors(db, client, t1);
    expect(r2).toMatchObject({ probed: 1, up: 0, down: 1 });
    m = await getMonitor(me.apiKey.key, created.id);
    expect(m.status).toBe('alive'); // not yet expired
    expect(m.lastProbe?.ok).toBe(false);

    // …and once the window lapses the normal sweep marks it dead.
    const t2 = new Date(t0.getTime() + 121_000);
    const swept = await sweepExpiredMonitors(db, t2);
    expect(swept.died).toBe(1);
    m = await getMonitor(me.apiKey.key, created.id);
    expect(m.status).toBe('dead');
  });

  it('does not probe before the interval elapses', async () => {
    const me = await signIn(app);
    await (await createActive(me.apiKey.key)).json();
    const t0 = new Date();
    expect((await probeActiveMonitors(db, client, t0)).probed).toBe(1);
    // Too soon (only 5s later, interval is 30s) → nothing due.
    expect((await probeActiveMonitors(db, client, new Date(t0.getTime() + 5_000))).probed).toBe(0);
  });

  it('a body assertion fails a hollow 2xx and records why', async () => {
    const me = await signIn(app);
    const created = (await (
      await createActive(me.apiKey.key, {
        check: {
          url: target.url('/health'),
          intervalSeconds: 30,
          expect: { bodyContains: '"db":"ok"' },
        },
      })
    ).json()) as { id: string };

    const t0 = new Date();
    // 200 but the body lacks the required marker → not healthy.
    probeBody = 'temporarily degraded';
    const r1 = await probeActiveMonitors(db, client, t0);
    expect(r1).toMatchObject({ probed: 1, up: 0, down: 1 });
    let m = await getMonitor(me.apiKey.key, created.id);
    expect(m.status).not.toBe('alive');
    expect(m.lastProbe?.ok).toBe(false);

    // Now the real work shows up in the body → healthy.
    probeBody = '{"db":"ok","queue":"ok"}';
    const r2 = await probeActiveMonitors(db, client, new Date(t0.getTime() + 31_000));
    expect(r2).toMatchObject({ probed: 1, up: 1 });
    m = await getMonitor(me.apiKey.key, created.id);
    expect(m.status).toBe('alive');
    expect(m.check?.expect).toMatchObject({ bodyContains: '"db":"ok"' });
  });

  it('rejects an active monitor without a check, and a check without active mode', async () => {
    const me = await signIn(app);
    expect((await createActive(me.apiKey.key, { check: null })).status).toBe(400);
    expect(
      (
        await app.request(
          '/v1/monitors',
          json(
            {
              name: 'x',
              ttlSeconds: 300,
              mode: 'heartbeat',
              check: { url: target.url('/h'), intervalSeconds: 60 },
            },
            bearer(me.apiKey.key),
          ),
        )
      ).status,
    ).toBe(400);
    // interval must be shorter than ttl
    expect(
      (
        await createActive(me.apiKey.key, {
          ttlSeconds: 60,
          check: { url: target.url('/h'), intervalSeconds: 60 },
        })
      ).status,
    ).toBe(400);
  });
});
