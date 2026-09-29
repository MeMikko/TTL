import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, testDatabase } from '../helpers/app.js';
import { bearer, json, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

async function setup(now?: () => Date) {
  const app = buildApp(database, { now });
  const me = await signIn(app);
  return { app, me, h: (key: string) => bearer(me.apiKey.key, { 'idempotency-key': key }) };
}

const activeKeys = async () =>
  (await database.pool.query('select count(*)::int as n from api_keys where revoked_at is null'))
    .rows[0].n as number;

describe('Idempotency-Key', () => {
  it('replays the original response for a retried request', async () => {
    const { app, h } = await setup();
    const first = await app.request('/v1/keys', json({ name: 'x' }, h('abc')));
    const second = await app.request('/v1/keys', json({ name: 'x' }, h('abc')));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.json()).toEqual(await first.json());
    expect(await activeKeys()).toBe(2); // sign-in key + one created key
  });

  it('rejects reuse of a key with a different body', async () => {
    const { app, h } = await setup();
    await app.request('/v1/keys', json({ name: 'x' }, h('abc')));
    const res = await app.request('/v1/keys', json({ name: 'y' }, h('abc')));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'idempotency_key_reused' } });
  });

  it('scopes keys per account', async () => {
    const { app, h } = await setup();
    const other = await signIn(app);
    await app.request('/v1/keys', json({ name: 'x' }, h('abc')));
    const res = await app.request(
      '/v1/keys',
      json({ name: 'x' }, bearer(other.apiKey.key, { 'idempotency-key': 'abc' })),
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('idempotent-replayed')).toBeNull();
  });

  it('answers 409 while the original request is in progress, and takes over stale ones', async () => {
    let t = new Date('2026-09-29T12:00:00Z');
    const { app, me, h } = await setup(() => t);
    const { createHash } = await import('node:crypto');
    const body = JSON.stringify({ name: 'x' });
    const hash = createHash('sha256').update(`POST\n/v1/keys\n${body}`).digest('hex');
    await database.pool.query(
      'insert into idempotency_keys (account_id, key, request_hash, created_at) values ($1, $2, $3, $4)',
      [me.accountId, 'busy', hash, t],
    );
    const busy = await app.request('/v1/keys', json({ name: 'x' }, h('busy')));
    expect(busy.status).toBe(409);

    t = new Date(t.getTime() + 6 * 60_000);
    const takeover = await app.request('/v1/keys', json({ name: 'x' }, h('busy')));
    expect(takeover.status).toBe(201);
  });

  it('stores 4xx outcomes and replays them', async () => {
    const { app, h } = await setup();
    const first = await app.request('/v1/keys', json({ name: '' }, h('bad')));
    expect(first.status).toBe(400);
    const again = await app.request('/v1/keys', json({ name: '' }, h('bad')));
    expect(again.status).toBe(400);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
  });

  it('rejects malformed keys', async () => {
    const { app, h } = await setup();
    const res = await app.request('/v1/keys', json({ name: 'x' }, h('has space')));
    expect(res.status).toBe(400);
  });

  it('is a no-op without the header', async () => {
    const { app, me } = await setup();
    const a = await app.request('/v1/keys', json({ name: 'x' }, bearer(me.apiKey.key)));
    const b = await app.request('/v1/keys', json({ name: 'x' }, bearer(me.apiKey.key)));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await activeKeys()).toBe(3);
  });
});
