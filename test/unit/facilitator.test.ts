import { generateKeyPairSync, verify } from 'node:crypto';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { createFacilitatorClient } from '../../src/core/x402.js';

const CDP_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

/** A CDP-style Ed25519 secret: base64 of the 32-byte seed followed by the 32-byte public key. */
function cdpEd25519Key() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const secret = Buffer.concat([
    Buffer.from(jwk.d!, 'base64url'),
    Buffer.from(jwk.x!, 'base64url'),
  ]).toString('base64');
  return { secret, publicKey };
}

function config(overrides: Record<string, string>) {
  return loadConfig({
    DATABASE_URL: 'postgres://u:p@localhost:5432/db',
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    X402_ENABLED: 'true',
    X402_PAY_TO: '0x4b19ee2a3de2521a3adc901989944c209c0a60ea',
    ...overrides,
  });
}

interface Captured {
  method: string;
  url: string;
  authorization: string | null;
}

/** Records every facilitator request and answers with minimal valid bodies. */
function stubFetch() {
  const calls: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? 'GET',
        url,
        authorization: headers.get('authorization'),
      });
      const body = url.endsWith('/supported')
        ? { kinds: [], extensions: [], signers: {} }
        : url.endsWith('/verify')
          ? { isValid: true, payer: '0x0000000000000000000000000000000000000001' }
          : {
              success: true,
              transaction: '0x' + '1'.repeat(64),
              network: 'eip155:8453',
              payer: '0x0000000000000000000000000000000000000001',
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

const requirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  amount: '100000',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  payTo: '0x4b19ee2a3de2521a3adc901989944c209c0a60ea',
  maxTimeoutSeconds: 300,
  extra: {},
} as unknown as PaymentRequirements;
const payload = {
  x402Version: 2,
  accepted: requirements,
  payload: {},
} as unknown as PaymentPayload;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('facilitator client', () => {
  it('signs every CDP call with a fresh JWT bound to its method and path', async () => {
    const { secret, publicKey } = cdpEd25519Key();
    const client = createFacilitatorClient(
      config({
        X402_NETWORK: 'eip155:8453',
        X402_FACILITATOR_URL: CDP_URL,
        CDP_API_KEY_ID: 'test-key-id',
        CDP_API_KEY_SECRET: secret,
      }),
    );
    const calls = stubFetch();

    await client.getSupported();
    await client.verify(payload, requirements);
    await client.settle(payload, requirements);
    await client.verify(payload, requirements);

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${CDP_URL}/supported`,
      `POST ${CDP_URL}/verify`,
      `POST ${CDP_URL}/settle`,
      `POST ${CDP_URL}/verify`,
    ]);
    const tokens = calls.map((c) => {
      expect(c.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      return c.authorization!.slice('Bearer '.length);
    });
    // Never reused: each call gets its own token.
    expect(new Set(tokens).size).toBe(tokens.length);

    for (const [i, token] of tokens.entries()) {
      const [h, p, sig] = token.split('.') as [string, string, string];
      const header = decode(h);
      const claims = decode(p);
      expect(header).toMatchObject({ alg: 'EdDSA', kid: 'test-key-id', typ: 'JWT' });
      expect(claims).toMatchObject({ sub: 'test-key-id', iss: 'cdp' });
      const { method, url } = calls[i]!;
      const { host, pathname } = new URL(url);
      expect(claims.uris).toEqual([`${method} ${host}${pathname}`]);
      expect((claims.exp as number) - (claims.nbf as number)).toBeLessThanOrEqual(120);
      expect(verify(null, Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(
        true,
      );
    }
  });

  it('sends a static Authorization header to other facilitators', async () => {
    const client = createFacilitatorClient(
      config({
        X402_FACILITATOR_URL: 'https://facilitator.example.com/x402',
        X402_FACILITATOR_AUTHORIZATION: 'Bearer static-token',
      }),
    );
    const calls = stubFetch();
    await client.getSupported();
    await client.verify(payload, requirements);
    expect(calls.map((c) => c.authorization)).toEqual([
      'Bearer static-token',
      'Bearer static-token',
    ]);
  });

  it('sends no Authorization header when none is configured', async () => {
    const client = createFacilitatorClient(config({}));
    const calls = stubFetch();
    await client.getSupported();
    expect(calls).toEqual([
      { method: 'GET', url: 'https://x402.org/facilitator/supported', authorization: null },
    ]);
  });
});
