import { createPublicKey, verify as edVerify } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize } from '../../src/core/receipts.js';
import { buildApp, testConfig, testDatabase } from '../helpers/app.js';
import { bearer, json, resetDb, signIn } from '../helpers/auth.js';

const database = testDatabase();
afterAll(() => database.close());
beforeEach(() => resetDb(database));

const app = buildApp(database, {
  config: testConfig({
    PUBLIC_BASE_URL: 'https://time2live.xyz',
    X402_ENABLED: 'true',
    X402_PAY_TO: '0x4b19ee2a3de2521a3adc901989944c209c0a60ea',
    X402_NETWORK: 'eip155:84532',
  }),
});

interface Signature {
  alg: string;
  keyId: string;
  publicKey: string;
  value: string;
}
function verifyReceipt(receipt: unknown, sig: Signature): boolean {
  const pub = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(sig.publicKey, 'base64').toString('base64url'),
    },
    format: 'jwk',
  });
  return edVerify(
    null,
    Buffer.from(canonicalize(receipt), 'utf8'),
    pub,
    Buffer.from(sig.value, 'base64'),
  );
}

async function newMonitor(key: string) {
  const res = await app.request(
    '/v1/monitors',
    json({ name: 'agent-1', ttlSeconds: 300 }, bearer(key)),
  );
  return (await res.json()) as { id: string };
}

describe('liveness receipts', () => {
  it('signs an alive receipt that verifies against the published key', async () => {
    const me = await signIn(app);
    const mon = await newMonitor(me.apiKey.key);
    await app.request(`/v1/heartbeat/${mon.id}`, { method: 'POST' }); // → alive

    const res = await app.request(`/v1/monitors/${mon.id}/receipt`, {
      headers: bearer(me.apiKey.key),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { receipt: Record<string, unknown>; signature: Signature };

    expect(body.receipt).toMatchObject({
      version: 1,
      type: 'monitor.liveness',
      scheduleId: mon.id,
      liveness: 'alive',
      network: 'eip155:84532',
    });
    expect((body.receipt.heartbeat as { lastSuccessHash: string }).lastSuccessHash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect((body.receipt.missedWindow as { ttlSeconds: number }).ttlSeconds).toBe(300);
    expect(body.signature.alg).toBe('Ed25519');

    // The signature verifies with the receipt's own key…
    expect(verifyReceipt(body.receipt, body.signature)).toBe(true);
    // …which matches the published key.
    const wk = (await (await app.request('/.well-known/time2live-receipts.json')).json()) as {
      keyId: string;
      publicKey: string;
    };
    expect(wk.keyId).toBe(body.signature.keyId);
    expect(wk.publicKey).toBe(body.signature.publicKey);
  });

  it('distinguishes a deliberate operator halt from a silent miss', async () => {
    const me = await signIn(app);
    const mon = await newMonitor(me.apiKey.key);
    await app.request(`/v1/heartbeat/${mon.id}`, { method: 'POST' });
    await app.request(`/v1/monitors/${mon.id}/pause`, json({}, bearer(me.apiKey.key)));

    const body = (await (
      await app.request(`/v1/monitors/${mon.id}/receipt`, { headers: bearer(me.apiKey.key) })
    ).json()) as { receipt: Record<string, unknown>; signature: Signature };

    expect(body.receipt.liveness).toBe('halted_by_operator');
    expect((body.receipt.operatorAck as { acknowledged: boolean }).acknowledged).toBe(true);
    expect(verifyReceipt(body.receipt, body.signature)).toBe(true);
  });

  it('a tampered receipt fails verification', async () => {
    const me = await signIn(app);
    const mon = await newMonitor(me.apiKey.key);
    const body = (await (
      await app.request(`/v1/monitors/${mon.id}/receipt`, { headers: bearer(me.apiKey.key) })
    ).json()) as { receipt: Record<string, unknown>; signature: Signature };

    expect(verifyReceipt(body.receipt, body.signature)).toBe(true);
    const tampered = { ...body.receipt, liveness: 'alive' }; // claim alive when it was 'new'
    expect(verifyReceipt(tampered, body.signature)).toBe(false);
  });

  it('is scoped to the owner and requires auth', async () => {
    const me = await signIn(app);
    const mon = await newMonitor(me.apiKey.key);
    expect((await app.request(`/v1/monitors/${mon.id}/receipt`)).status).toBe(401);
    const other = await signIn(app);
    expect(
      (await app.request(`/v1/monitors/${mon.id}/receipt`, { headers: bearer(other.apiKey.key) }))
        .status,
    ).toBe(404); // not the owner's monitor
  });
});
