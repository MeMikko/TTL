import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { createApp } from '../../src/api/app.js';
import type { Database } from '../../src/core/db/index.js';

type App = ReturnType<typeof createApp>;

export function newWallet(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

export async function requestChallenge(app: App, address: string, chainId = 8453) {
  const res = await app.request('/v1/auth/challenge', json({ address, chainId }));
  if (res.status !== 200) throw new Error(`challenge failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { nonce: string; message: string; expiresAt: string };
}

export interface SignedIn {
  accountId: string;
  address: string;
  created: boolean;
  apiKey: { id: string; key: string; prefix: string; name: string };
}

/** Full wallet sign-in; returns the verify response body. */
export async function signIn(app: App, wallet = newWallet(), keyName?: string): Promise<SignedIn> {
  const { message } = await requestChallenge(app, wallet.address);
  const signature = await wallet.signMessage({ message });
  const res = await app.request('/v1/auth/verify', json({ message, signature, keyName }));
  if (res.status !== 201) throw new Error(`verify failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as SignedIn;
}

export const bearer = (key: string, extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${key}`,
  ...extra,
});

export async function resetDb(database: Database) {
  await database.pool.query(
    'TRUNCATE accounts, auth_nonces, api_keys, idempotency_keys, worker_ticks CASCADE',
  );
}
