import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const devConfig = testConfig({ WEBHOOK_DEV_ALLOW_LOCAL: 'true' });
const T0 = new Date('2026-09-29T12:00:00Z');

async function setup(opts: { config?: ReturnType<typeof testConfig> } = {}) {
  let now = T0;
  const app = buildApp(database, { config: opts.config ?? devConfig, now: () => now });
  const me = await signIn(app);
  const h = bearer(me.apiKey.key);
  return {
    app,
    me,
    h,
    setNow: (d: Date) => (now = d),
    post: (path: string, body: unknown, extra: Record<string, string> = {}) =>
      app.request(path, json(body, { ...h, ...extra })),
    patch: (path: string, body: unknown) =>
      app.request(path, { ...json(body, h), method: 'PATCH' }),
    get: (path: string) => app.request(path, { headers: h }),
  };
}

const cronJob = (over: Record<string, unknown> = {}) => ({
  name: 'wake agent',
  schedule: { type: 'cron', expression: '*/15 * * * *', timezone: 'UTC' },
  target: {
    url: 'http://127.0.0.1:9/hook',
    headers: { Authorization: 'Bearer top-secret', 'X-Agent': 'a1' },
    body: { task: 'wake' },
  },
  ...over,
});

type JobBody = {
  id: string;
  status: string;
  nextRunAt: string | null;
  target: { headers: Record<string, string>; body: string | null; method: string };
  schedule: Record<string, unknown>;
};

describe('POST /v1/jobs', () => {
  it('creates a cron job with defaults, redacted and encrypted headers', async () => {
    const { post } = await setup();
    const res = await post('/v1/jobs', cronJob());
    expect(res.status).toBe(201);
    const job = (await res.json()) as JobBody & Record<string, unknown>;
    expect(job).toMatchObject({
      id: expect.stringMatching(/^job_/),
      status: 'active',
      schedule: { type: 'cron', expression: '*/15 * * * *', timezone: 'UTC' },
      target: {
        url: 'http://127.0.0.1:9/hook',
        method: 'POST',
        headers: { Authorization: '[redacted]', 'X-Agent': '[redacted]' },
        body: '{"task":"wake"}',
      },
      timeoutMs: 10_000,
      maxAttempts: 5,
      nextRunAt: '2026-09-29T12:15:00.000Z',
    });

    const { rows } = await database.pool.query('select headers_enc from jobs');
    expect(rows[0].headers_enc).toMatch(/^v1\./);
    expect(rows[0].headers_enc).not.toContain('top-secret');
  });

  it('creates one-off jobs (offset timestamps; slightly past means now)', async () => {
    const { post } = await setup();
    const future = await post(
      '/v1/jobs',
      cronJob({ schedule: { type: 'once', at: '2026-09-29T14:30:00+02:00' } }),
    );
    expect(future.status).toBe(201);
    expect(await future.json()).toMatchObject({
      schedule: { type: 'once', at: '2026-09-29T12:30:00.000Z' },
      nextRunAt: '2026-09-29T12:30:00.000Z',
    });
    const recent = await post(
      '/v1/jobs',
      cronJob({ schedule: { type: 'once', at: '2026-09-29T11:58:00Z' } }),
    );
    expect(await recent.json()).toMatchObject({ nextRunAt: '2026-09-29T12:00:00.000Z' });
  });

  it('validates schedules', async () => {
    const { post } = await setup();
    const cases: Array<[unknown, string]> = [
      [{ type: 'cron', expression: '* * * * * *' }, 'invalid_schedule'],
      [{ type: 'cron', expression: '* * * * *', timezone: 'Nowhere/City' }, 'invalid_schedule'],
      [{ type: 'once', at: '2026-09-29T11:00:00Z' }, 'invalid_schedule'],
      [{ type: 'once', at: '2028-01-01T00:00:00Z' }, 'invalid_schedule'],
      [{ type: 'once', at: 'tomorrow' }, 'validation_error'],
      [{ type: 'weekly' }, 'validation_error'],
    ];
    for (const [schedule, code] of cases) {
      const res = await post('/v1/jobs', cronJob({ schedule }));
      expect(res.status, JSON.stringify(schedule)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    }
  });

  it('validates headers and body', async () => {
    const { post } = await setup();
    const bad = [
      { headers: { Host: 'evil' } },
      { headers: { 'T2L-Signature': 'forged' } },
      { headers: { 'bad header': 'x' } },
      { headers: { 'X-A': 'line\r\nInjected: 1' } },
      { headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-h${i}`, 'v'])) },
      { body: 'x'.repeat(33_000) },
    ];
    for (const target of bad) {
      const res = await post(
        '/v1/jobs',
        cronJob({ target: { url: 'http://127.0.0.1:9/', ...target } }),
      );
      expect(res.status, JSON.stringify(target).slice(0, 80)).toBe(400);
    }
    const get = await post(
      '/v1/jobs',
      cronJob({ target: { url: 'http://127.0.0.1:9/', method: 'GET', body: 'x' } }),
    );
    expect(get.status).toBe(400);
    expect(await get.json()).toMatchObject({ error: { code: 'invalid_target' } });
  });

  it('enforces the SSRF policy at creation in strict mode', async () => {
    const { post } = await setup({ config: testConfig() });
    for (const url of [
      'http://example.com/',
      'https://127.0.0.1/',
      'https://169.254.169.254/latest/meta-data',
      'https://localhost/',
      'https://[::1]/',
      'https://example.com:22/',
    ]) {
      const res = await post('/v1/jobs', cronJob({ target: { url } }));
      expect(res.status, url).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_target' } });
    }
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    const app = buildApp(database, {
      config: testConfig(),
      dnsResolve: (host, _o, cb) =>
        host === 'internal.example.com'
          ? cb(null, [{ address: '10.0.0.7', family: 4 }])
          : cb(null, [{ address: '93.184.215.14', family: 4 }]),
    });
    const me = await signIn(app);
    const res = await app.request(
      '/v1/jobs',
      json(
        cronJob({ target: { url: 'https://internal.example.com/hook' } }),
        bearer(me.apiKey.key),
      ),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_target' } });
    const ok = await app.request(
      '/v1/jobs',
      json(cronJob({ target: { url: 'https://public.example.com/hook' } }), bearer(me.apiKey.key)),
    );
    expect(ok.status).toBe(201);
  });

  it('caps the number of jobs per account', async () => {
    const { post } = await setup({
      config: testConfig({ WEBHOOK_DEV_ALLOW_LOCAL: 'true', MAX_JOBS_PER_ACCOUNT: '2' }),
    });
    expect((await post('/v1/jobs', cronJob())).status).toBe(201);
    expect((await post('/v1/jobs', cronJob())).status).toBe(201);
    const third = await post('/v1/jobs', cronJob());
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: { code: 'too_many_jobs' } });
  });

  it('is idempotent with Idempotency-Key', async () => {
    const { post } = await setup();
    const a = await post('/v1/jobs', cronJob(), { 'idempotency-key': 'create-1' });
    const b = await post('/v1/jobs', cronJob(), { 'idempotency-key': 'create-1' });
    expect(((await a.json()) as JobBody).id).toBe(((await b.json()) as JobBody).id);
    const { rows } = await database.pool.query('select count(*)::int n from jobs');
    expect(rows[0].n).toBe(1);
  });
});

describe('job management', () => {
  it('gets, lists with pagination, updates and deletes', async () => {
    const { post, get, patch, app, h, setNow } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      setNow(new Date(T0.getTime() + i * 1000));
      ids.push(((await (await post('/v1/jobs', cronJob({ name: `j${i}` }))).json()) as JobBody).id);
    }
    const p1 = (await (await get('/v1/jobs?limit=2')).json()) as {
      data: JobBody[];
      nextCursor: string;
    };
    expect(p1.data.map((j) => j.id)).toEqual([ids[2], ids[1]]);
    const p2 = (await (await get(`/v1/jobs?limit=2&cursor=${p1.nextCursor}`)).json()) as {
      data: JobBody[];
      nextCursor: string | null;
    };
    expect(p2.data.map((j) => j.id)).toEqual([ids[0]]);
    expect(p2.nextCursor).toBeNull();
    expect((await get('/v1/jobs?cursor=garbage')).status).toBe(400);

    const updated = await patch(`/v1/jobs/${ids[0]}`, {
      name: 'renamed',
      schedule: { type: 'cron', expression: '@hourly' },
      target: { method: 'PUT' },
    });
    expect(updated.status).toBe(200);
    const u = (await updated.json()) as JobBody & { name: string };
    expect(u).toMatchObject({
      name: 'renamed',
      schedule: { expression: '@hourly' },
      target: { method: 'PUT', body: '{"task":"wake"}', headers: { Authorization: '[redacted]' } },
      nextRunAt: '2026-09-29T13:00:00.000Z',
    });

    const del = await app.request(`/v1/jobs/${ids[0]}`, { method: 'DELETE', headers: h });
    expect(del.status).toBe(200);
    expect((await get(`/v1/jobs/${ids[0]}`)).status).toBe(404);
  });

  it('pauses (cancelling pending runs) and resumes', async () => {
    const { post, get, setNow } = await setup();
    const job = (await (await post('/v1/jobs', cronJob())).json()) as JobBody;
    const run = (await (await post(`/v1/jobs/${job.id}/trigger`, {})).json()) as { id: string };

    const paused = (await (await post(`/v1/jobs/${job.id}/pause`, {})).json()) as JobBody;
    expect(paused).toMatchObject({ status: 'paused', nextRunAt: null });
    expect(await (await get(`/v1/runs/${run.id}`)).json()).toMatchObject({ status: 'cancelled' });

    setNow(new Date('2026-09-29T14:07:00Z'));
    const resumed = (await (await post(`/v1/jobs/${job.id}/resume`, {})).json()) as JobBody;
    expect(resumed).toMatchObject({ status: 'active', nextRunAt: '2026-09-29T14:15:00.000Z' });
  });

  it('triggers a manual run and enforces the monthly quota with 402', async () => {
    const { post, get } = await setup();
    const job = (await (await post('/v1/jobs', cronJob())).json()) as JobBody;
    const res = await post(`/v1/jobs/${job.id}/trigger`, {});
    expect(res.status).toBe(202);
    const run = (await res.json()) as { id: string };
    expect(run).toMatchObject({ trigger: 'manual', status: 'pending', attempts: 0 });

    const detail = await get(`/v1/runs/${run.id}`);
    expect(await detail.json()).toMatchObject({ id: run.id, attemptLog: [] });
    const list = (await (await get(`/v1/jobs/${job.id}/runs`)).json()) as { data: unknown[] };
    expect(list.data).toHaveLength(1);

    await database.pool.query(`update usage_counters set runs = 50`);
    const over = await post(`/v1/jobs/${job.id}/trigger`, {});
    expect(over.status).toBe(402);
    expect(await over.json()).toMatchObject({ error: { code: 'quota_exceeded' } });

    const account = (await (await get('/v1/account')).json()) as { usage: { runs: number } };
    expect(account.usage).toEqual({ period: '2026-09', runs: 50 });
  });

  it("hides other accounts' jobs and runs", async () => {
    const alice = await setup();
    const job = (await (await alice.post('/v1/jobs', cronJob())).json()) as JobBody;
    const run = (await (await alice.post(`/v1/jobs/${job.id}/trigger`, {})).json()) as {
      id: string;
    };

    const bob = await signIn(alice.app);
    const hb = bearer(bob.apiKey.key);
    for (const [method, path] of [
      ['GET', `/v1/jobs/${job.id}`],
      ['DELETE', `/v1/jobs/${job.id}`],
      ['POST', `/v1/jobs/${job.id}/trigger`],
      ['POST', `/v1/jobs/${job.id}/pause`],
      ['GET', `/v1/jobs/${job.id}/runs`],
      ['GET', `/v1/runs/${run.id}`],
    ] as const) {
      const res = await alice.app.request(path, { method, headers: hb });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const list = (await (await alice.app.request('/v1/jobs', { headers: hb })).json()) as {
      data: unknown[];
    };
    expect(list.data).toHaveLength(0);
  });
});

describe('webhook secret', () => {
  it('is created lazily, stable, encrypted at rest and rotatable', async () => {
    const { get, post } = await setup();
    const a = (await (await get('/v1/account/webhook-secret')).json()) as { secret: string };
    const b = (await (await get('/v1/account/webhook-secret')).json()) as { secret: string };
    expect(a.secret).toMatch(/^whsec_/);
    expect(b.secret).toBe(a.secret);
    const { rows } = await database.pool.query('select webhook_secret_enc from accounts');
    expect(rows[0].webhook_secret_enc).not.toContain(a.secret);

    const rotated = (await (await post('/v1/account/webhook-secret/rotate', {})).json()) as {
      secret: string;
    };
    expect(rotated.secret).not.toBe(a.secret);
    const c = (await (await get('/v1/account/webhook-secret')).json()) as { secret: string };
    expect(c.secret).toBe(rotated.secret);
  });
});
