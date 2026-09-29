import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freezeAccount, unfreezeAccount } from '../../src/core/accounts.js';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

describe('API key authentication', () => {
  it('requires a bearer key', async () => {
    const app = buildApp(database);
    const res = await app.request('/v1/account');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects malformed and unknown keys', async () => {
    const app = buildApp(database);
    for (const key of ['nope', `t2l_${'A'.repeat(43)}`]) {
      const res = await app.request('/v1/account', { headers: bearer(key) });
      expect(res.status).toBe(401);
    }
  });

  it('returns the account with unactivated tier limits', async () => {
    const app = buildApp(database);
    const me = await signIn(app);
    const res = await app.request('/v1/account', { headers: bearer(me.apiKey.key) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: me.accountId,
      address: me.address,
      status: 'active',
      activatedAt: null,
      tier: { name: 'unactivated', limits: { monitors: 1, runsPerMonth: 50 } },
    });
  });

  it('records last use', async () => {
    const app = buildApp(database);
    const me = await signIn(app);
    await app.request('/v1/account', { headers: bearer(me.apiKey.key) });
    const { rows } = await database.pool.query('select last_used_at from api_keys where id = $1', [
      me.apiKey.id,
    ]);
    expect(rows[0].last_used_at).toBeInstanceOf(Date);
  });

  it('blocks frozen accounts with 403 and restores access when unfrozen', async () => {
    const app = buildApp(database);
    const me = await signIn(app);
    await freezeAccount(database.db, me.accountId, 'abuse');
    const frozen = await app.request('/v1/account', { headers: bearer(me.apiKey.key) });
    expect(frozen.status).toBe(403);
    expect(await frozen.json()).toMatchObject({ error: { code: 'account_frozen' } });
    await unfreezeAccount(database.db, me.accountId);
    expect((await app.request('/v1/account', { headers: bearer(me.apiKey.key) })).status).toBe(200);
  });

  it('rate limits per key', async () => {
    const app = buildApp(database, { config: testConfig({ RATE_LIMIT_KEY_PER_MIN: '2' }) });
    const me = await signIn(app);
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await app.request('/v1/account', { headers: bearer(me.apiKey.key) })).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
    const res = await app.request('/v1/account', { headers: bearer(me.apiKey.key) });
    expect(res.headers.get('retry-after')).toBe('30');
  });
});

describe('/v1/keys', () => {
  it('creates, lists and revokes keys', async () => {
    const app = buildApp(database);
    const me = await signIn(app);
    const h = bearer(me.apiKey.key);

    const created = await app.request('/v1/keys', json({ name: 'ci' }, h));
    expect(created.status).toBe(201);
    const newKey = (await created.json()) as { id: string; key: string };
    expect(newKey.key).toMatch(/^t2l_/);

    const list = (await (await app.request('/v1/keys', { headers: h })).json()) as {
      data: Array<{ id: string; name: string; key?: string }>;
    };
    expect(list.data.map((k) => k.name)).toEqual(['default', 'ci']);
    expect(list.data.every((k) => k.key === undefined)).toBe(true);

    const revoked = await app.request(`/v1/keys/${newKey.id}`, { method: 'DELETE', headers: h });
    expect(revoked.status).toBe(200);
    expect((await app.request('/v1/account', { headers: bearer(newKey.key) })).status).toBe(401);

    const again = await app.request(`/v1/keys/${newKey.id}`, { method: 'DELETE', headers: h });
    expect(again.status).toBe(404);
  });

  it("cannot revoke another account's key", async () => {
    const app = buildApp(database);
    const alice = await signIn(app);
    const bob = await signIn(app);
    const res = await app.request(`/v1/keys/${bob.apiKey.id}`, {
      method: 'DELETE',
      headers: bearer(alice.apiKey.key),
    });
    expect(res.status).toBe(404);
    expect((await app.request('/v1/account', { headers: bearer(bob.apiKey.key) })).status).toBe(
      200,
    );
  });

  it('enforces the per-account key cap', async () => {
    const app = buildApp(database, { config: testConfig({ MAX_API_KEYS_PER_ACCOUNT: '2' }) });
    const me = await signIn(app);
    const h = bearer(me.apiKey.key);
    expect((await app.request('/v1/keys', json({ name: 'two' }, h))).status).toBe(201);
    const third = await app.request('/v1/keys', json({ name: 'three' }, h));
    expect(third.status).toBe(409);
    expect(await third.json()).toMatchObject({ error: { code: 'too_many_keys' } });
  });

  it('validates input and ids', async () => {
    const app = buildApp(database);
    const h = bearer((await signIn(app)).apiKey.key);
    expect((await app.request('/v1/keys', json({ name: '' }, h))).status).toBe(400);
    expect((await app.request('/v1/keys/bogus', { method: 'DELETE', headers: h })).status).toBe(
      400,
    );
  });
});
