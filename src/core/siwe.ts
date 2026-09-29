import { createPublicClient, http, isAddress, recoverMessageAddress, type Hex } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { createSiweMessage } from 'viem/siwe';
import { randomBase62 } from './ids.js';

export const SIWE_STATEMENT =
  'Sign in to time2live.xyz. This creates an API key for this wallet. ' +
  'It does not trigger a blockchain transaction or cost any gas.';

export interface ChallengeInput {
  address: string;
  chainId: number;
  publicBaseUrl: string;
  now: Date;
  ttlSeconds: number;
}

export interface Challenge {
  nonce: string;
  message: string;
  issuedAt: Date;
  expiresAt: Date;
}

/** Builds an EIP-4361 message bound to our domain, the wallet, the chain and a fresh nonce. */
export function buildChallenge(input: ChallengeInput): Challenge {
  const url = new URL(input.publicBaseUrl);
  const nonce = randomBase62(24);
  const issuedAt = new Date(Math.floor(input.now.getTime() / 1000) * 1000);
  const expiresAt = new Date(issuedAt.getTime() + input.ttlSeconds * 1000);
  const message = createSiweMessage({
    domain: url.host,
    uri: url.origin,
    address: toChecksumInput(input.address),
    chainId: input.chainId,
    nonce,
    version: '1',
    statement: SIWE_STATEMENT,
    issuedAt,
    expirationTime: expiresAt,
  });
  return { nonce, message, issuedAt, expiresAt };
}

function toChecksumInput(address: string): Hex {
  if (!isAddress(address, { strict: false })) throw new Error('invalid address');
  // createSiweMessage checksums the address itself; it only needs a well-formed hex string.
  return address as Hex;
}

/** Verifies a signature from a smart-contract wallet (ERC-1271 / ERC-6492) on the given chain. */
export type SmartWalletVerifier = (args: {
  chainId: number;
  address: Hex;
  message: string;
  signature: Hex;
}) => Promise<boolean>;

export interface VerifyInput {
  address: string;
  message: string;
  signature: Hex;
  chainId: number;
  smartWalletVerifier?: SmartWalletVerifier;
}

/**
 * EOA signatures are checked offline via ecrecover. Anything else (smart accounts such as
 * Coinbase Smart Wallet / CDP agent wallets) falls back to on-chain verification when an RPC is
 * configured for that chain.
 */
export async function verifySignature(input: VerifyInput): Promise<boolean> {
  const expected = input.address.toLowerCase();
  try {
    const recovered = await recoverMessageAddress({
      message: input.message,
      signature: input.signature,
    });
    if (recovered.toLowerCase() === expected) return true;
  } catch {
    // Not a 65-byte ECDSA signature; may still be a smart-wallet signature.
  }
  if (!input.smartWalletVerifier) return false;
  try {
    return await input.smartWalletVerifier({
      chainId: input.chainId,
      address: expected as Hex,
      message: input.message,
      signature: input.signature,
    });
  } catch {
    return false;
  }
}

/** Builds a verifier backed by viem public clients for the chains that have an RPC configured. */
export function createRpcSmartWalletVerifier(rpcUrls: {
  [chainId: number]: string | undefined;
}): SmartWalletVerifier | undefined {
  const chains = { [base.id]: base, [baseSepolia.id]: baseSepolia } as const;
  type VerifyFn = (args: { address: Hex; message: string; signature: Hex }) => Promise<boolean>;
  const verifiers = new Map<number, VerifyFn>();
  for (const [id, url] of Object.entries(rpcUrls)) {
    const chain = chains[Number(id) as keyof typeof chains];
    if (url && chain) {
      const client = createPublicClient({ chain, transport: http(url, { timeout: 10_000 }) });
      verifiers.set(chain.id, (args) => client.verifyMessage(args));
    }
  }
  if (verifiers.size === 0) return undefined;
  return async ({ chainId, address, message, signature }) => {
    const verify = verifiers.get(chainId);
    if (!verify) return false;
    return verify({ address, message, signature });
  };
}
