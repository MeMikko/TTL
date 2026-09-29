import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { freezeAccount } from '../../src/core/accounts.js';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { json, newWallet, requestChallenge, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

describe('wallet sign-in (SIWE)', () => {
  it('registers a new account and issues an API key', async () => {
    const app = buildApp(database);
    const wallet = newWallet();
    const res = await signIn(app, wallet, 'my-agent');
    expect(res.accountId).toMatch(/^acc_/);
    expect(res.address).toBe(wallet.address.toLowerCase());
    expect(res.created).toBe(true);
    expect(res.apiKey.key).toMatch(/^t2l_/);
    expect(res.apiKey.name).toBe('my-agent');

    const stored = await database.pool.query('select key_hash, prefix from api_keys');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].key_hash).not.toContain(res.apiKey.key);
    expect(JSON.stringify(stored.rows)).not.toContain(res.apiKey.key);
  });

  it('signs an existing wallet back into the same account', async () => {
    const app = buildApp(database);
    const wallet = newWallet();
    const first = await signIn(app, wallet);
    const second = await signIn(app, wallet);
    expect(second.accountId).toBe(first.accountId);
    expect(second.created).toBe(false);
    expect(second.apiKey.key).not.toBe(first.apiKey.key);
  });

  it('accepts a checksummed or lowercase address as the same identity', async () => {
    const app = buildApp(database);
    const wallet = newWallet();
    const { message } = await requestChallenge(app, wallet.address.toLowerCase());
    const signature = await wallet.signMessage({ message });
    const res = await app.request('/v1/auth/verify', json({ message, signature }));
    expect(res.status).toBe(201);
    const again = await signIn(app, wallet);
    expect(again.created).toBe(false);
  });

  it('rejects a replayed challenge', async () => {
    const app = buildApp(database);
    const wallet = newWallet();
    const { message } = await requestChallenge(app, wallet.address);
    const signature = await wallet.signMessage({ message });
    expect((await app.request('/v1/auth/verify', json({ message, signature }))).status).toBe(201);
    const replay = await app.request('/v1/auth/verify', json({ message, signature }));
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: 'invalid_nonce' } });
  });

  it('rejects an expired challenge', async () => {
    let t = new Date('2026-09-29T12:00:00Z');
    const app = buildApp(database, { now: () => t });
    const wallet = newWallet();
    const { message } = await requestChallenge(app, wallet.address);
    const signature = await wallet.signMessage({ message });
    t = new Date(t.getTime() + 301_000);
    const res = await app.request('/v1/auth/verify', json({ message, signature }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_nonce' } });
  });

  it('rejects a signature by a different wallet', async () => {
    const app = buildApp(database);
    const victim = newWallet();
    const attacker = newWallet();
    const { message } = await requestChallenge(app, victim.address);
    const signature = await attacker.signMessage({ message });
    const res = await app.request('/v1/auth/verify', json({ message, signature }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_signature' } });
  });

  it('rejects a tampered message even when validly signed', async () => {
    const app = buildApp(database);
    const wallet = newWallet();
    const { message } = await requestChallenge(app, wallet.address);
    const tampered = message.replace('time2live.xyz.', 'evil.example.');
    expect(tampered).not.toBe(message);
    const signature = await wallet.signMessage({ message: tampered });
    const res = await app.request('/v1/auth/verify', json({ message: tampered, signature }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_message' } });
  });

  it('burns the challenge after a failed attempt', async () => {
    const app = buildApp(database);
    const wallet = newWallet();
    const { message } = await requestChallenge(app, wallet.address);
    const bad = await newWallet().signMessage({ message });
    expect((await app.request('/v1/auth/verify', json({ message, signature: bad }))).status).toBe(
      401,
    );
    const good = await wallet.signMessage({ message });
    const res = await app.request('/v1/auth/verify', json({ message, signature: good }));
    expect(res.status).toBe(401);
  });

  it('rejects non-SIWE messages', async () => {
    const res = await buildApp(database).request(
      '/v1/auth/verify',
      json({ message: 'hello', signature: '0x00' }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'invalid_message' } });
  });

  it('validates the challenge request', async () => {
    const app = buildApp(database);
    const bad = await app.request('/v1/auth/challenge', json({ address: '0x123' }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: { code: 'validation_error' } });

    const chain = await app.request(
      '/v1/auth/challenge',
      json({ address: newWallet().address, chainId: 1 }),
    );
    expect(chain.status).toBe(400);
    expect(await chain.json()).toMatchObject({ error: { code: 'unsupported_chain' } });
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await buildApp(database).request('/v1/auth/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('rejects oversized bodies', async () => {
    const res = await buildApp(database).request(
      '/v1/auth/verify',
      json({ message: 'x'.repeat(70_000), signature: '0x' }),
    );
    expect(res.status).toBe(413);
  });

  it('refuses to issue keys to a frozen account', async () => {
    const app = buildApp(database);
    const wallet = newWallet();
    const { accountId } = await signIn(app, wallet);
    await freezeAccount(database.db, accountId, 'test');
    await expect(signIn(app, wallet)).rejects.toThrow(/403/);
  });

  it('uses the smart wallet verifier for contract signatures', async () => {
    const wallet = newWallet();
    const app = buildApp(database, {
      smartWalletVerifier: async ({ address }) => address === wallet.address.toLowerCase(),
    });
    const { message } = await requestChallenge(app, wallet.address);
    const res = await app.request(
      '/v1/auth/verify',
      json({ message, signature: '0x' + 'ab'.repeat(200) }),
    );
    expect(res.status).toBe(201);
  });

  it('rate limits auth endpoints per IP', async () => {
    const app = buildApp(database, { config: testConfig({ RATE_LIMIT_AUTH_IP_PER_MIN: '3' }) });
    const address = newWallet().address;
    const statuses = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await app.request('/v1/auth/challenge', json({ address }))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('keys IP rate limits on X-Forwarded-For only when TRUST_PROXY is set', async () => {
    const address = newWallet().address;
    const send = (app: ReturnType<typeof buildApp>, ip: string) =>
      app.request('/v1/auth/challenge', json({ address }, { 'x-forwarded-for': ip }));

    const trusted = buildApp(database, {
      config: testConfig({ RATE_LIMIT_AUTH_IP_PER_MIN: '1', TRUST_PROXY: 'true' }),
    });
    expect((await send(trusted, '1.1.1.1')).status).toBe(200);
    expect((await send(trusted, '2.2.2.2')).status).toBe(200);
    expect((await send(trusted, '1.1.1.1')).status).toBe(429);

    const untrusted = buildApp(database, {
      config: testConfig({ RATE_LIMIT_AUTH_IP_PER_MIN: '1' }),
    });
    expect((await send(untrusted, '1.1.1.1')).status).toBe(200);
    expect((await send(untrusted, '2.2.2.2')).status).toBe(429);
  });
});
