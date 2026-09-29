import { describe, expect, it, vi } from 'vitest';
import { parseSiweMessage } from 'viem/siwe';
import { buildChallenge, verifySignature } from '../../src/core/siwe.js';
import { newWallet } from '../helpers/auth.js';

const now = new Date('2026-09-29T12:00:00.500Z');

describe('buildChallenge', () => {
  it('binds domain, uri, address, chain, nonce and expiry', () => {
    const wallet = newWallet();
    const ch = buildChallenge({
      address: wallet.address.toLowerCase(),
      chainId: 84532,
      publicBaseUrl: 'https://time2live.xyz',
      now,
      ttlSeconds: 300,
    });
    const parsed = parseSiweMessage(ch.message);
    expect(parsed).toMatchObject({
      domain: 'time2live.xyz',
      uri: 'https://time2live.xyz',
      address: wallet.address, // checksummed
      chainId: 84532,
      nonce: ch.nonce,
      version: '1',
    });
    expect(ch.expiresAt.getTime() - ch.issuedAt.getTime()).toBe(300_000);
    expect(ch.issuedAt.getMilliseconds()).toBe(0);
  });

  it('rejects an invalid address', () => {
    expect(() =>
      buildChallenge({
        address: '0x123',
        chainId: 1,
        publicBaseUrl: 'https://x.y',
        now,
        ttlSeconds: 60,
      }),
    ).toThrow();
  });
});

describe('verifySignature', () => {
  const message = 'hello';

  it('accepts a valid EOA signature', async () => {
    const w = newWallet();
    const signature = await w.signMessage({ message });
    expect(await verifySignature({ address: w.address, message, signature, chainId: 8453 })).toBe(
      true,
    );
  });

  it('rejects a signature from another wallet', async () => {
    const signature = await newWallet().signMessage({ message });
    const other = newWallet();
    expect(
      await verifySignature({ address: other.address, message, signature, chainId: 8453 }),
    ).toBe(false);
  });

  it('rejects garbage without a smart wallet verifier', async () => {
    expect(
      await verifySignature({
        address: newWallet().address,
        message,
        signature: '0xdeadbeef',
        chainId: 8453,
      }),
    ).toBe(false);
  });

  it('falls back to the smart wallet verifier for non-EOA signatures', async () => {
    const verifier = vi.fn().mockResolvedValue(true);
    const address = newWallet().address;
    const ok = await verifySignature({
      address,
      message,
      signature: '0x1234',
      chainId: 8453,
      smartWalletVerifier: verifier,
    });
    expect(ok).toBe(true);
    expect(verifier).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 8453, address: address.toLowerCase(), message }),
    );
  });

  it('treats a throwing smart wallet verifier as invalid', async () => {
    const verifier = vi.fn().mockRejectedValue(new Error('rpc down'));
    expect(
      await verifySignature({
        address: newWallet().address,
        message,
        signature: '0x1234',
        chainId: 8453,
        smartWalletVerifier: verifier,
      }),
    ).toBe(false);
  });
});
