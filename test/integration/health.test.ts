import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../../src/core/db/index.js';
import { recordTick } from '../../src/worker/ticker.js';
import { buildApp, testDatabase } from '../helpers/app.js';

const database = testDatabase();

afterAll(() => database.close());
beforeEach(async () => {
  await database.db.delete(schema.workerTicks);
});

describe('GET /healthz', () => {
  it('returns ok without touching dependencies', async () => {
    const res = await buildApp(database).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok' });
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('deep check fails when no worker has ticked', async () => {
    const res = await buildApp(database).request('/healthz?deep=1');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { checks: Record<string, { ok: boolean }> };
    expect(body.checks.database?.ok).toBe(true);
    expect(body.checks.worker?.ok).toBe(false);
  });

  it('deep check passes with a fresh tick', async () => {
    await recordTick(database.db, 'w1', new Date());
    const res = await buildApp(database).request('/healthz?deep=1');
    expect(res.status).toBe(200);
  });

  it('deep check fails when the latest tick is stale', async () => {
    const t = new Date('2026-01-01T00:00:00Z');
    await recordTick(database.db, 'w1', t, t);
    const now = () => new Date(t.getTime() + 121_000);
    const res = await buildApp(database, { now }).request('/healthz?deep=1');
    expect(res.status).toBe(503);
  });

  it('uses the most recent tick across workers', async () => {
    const t = new Date();
    await recordTick(database.db, 'old', t, new Date(t.getTime() - 3_600_000));
    await recordTick(database.db, 'new', t, t);
    const res = await buildApp(database).request('/healthz?deep=1');
    expect(res.status).toBe(200);
  });

  it('echoes a valid X-Request-Id and replaces an invalid one', async () => {
    const app = buildApp(database);
    const ok = await app.request('/healthz', { headers: { 'x-request-id': 'abc-123' } });
    expect(ok.headers.get('x-request-id')).toBe('abc-123');
    const bad = await app.request('/healthz', {
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    expect(bad.headers.get('x-request-id')).not.toBe('bad id with spaces');
  });

  it('returns JSON 404 for unknown routes', async () => {
    const res = await buildApp(database).request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
