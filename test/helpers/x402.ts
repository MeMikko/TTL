import { x402Client } from '@x402/core/client';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { getAddress, keccak256, verifyTypedData, type Hex } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { createPaymentGateway } from '../../src/core/x402.js';
import { testConfig } from './app.js';

export const NETWORK = 'eip155:84532';
export const PAY_TO = '0x000000000000000000000000000000000000dEaD';

interface Eip3009 {
  signature: Hex;
  authorization: {
    from: Hex;
    to: Hex;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

/**
 * In-process stand-in for an x402 facilitator. `verify` checks the EIP-3009 signature for real
 * (viem), amount, recipient and time window; `settle` returns a transaction hash derived from the
 * signature, so a replayed payload settles to the same "transaction" like it would on chain.
 */
export class FakeFacilitator implements FacilitatorClient {
  verifyCalls = 0;
  settleCalls = 0;
  failSettle = false;
  down = false;

  async getSupported() {
    if (this.down) throw new Error('facilitator unreachable');
    return {
      kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK as `${string}:${string}` }],
      extensions: [],
      signers: {},
    };
  }

  async verify(payload: PaymentPayload, req: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls++;
    const p = payload.payload as unknown as Eip3009;
    const a = p.authorization;
    const now = Math.floor(Date.now() / 1000);
    if (getAddress(a.to) !== getAddress(req.payTo)) {
      return { isValid: false, invalidReason: 'invalid_exact_evm_recipient_mismatch' };
    }
    if (BigInt(a.value) !== BigInt(req.amount)) {
      return { isValid: false, invalidReason: 'invalid_exact_evm_payload_authorization_value' };
    }
    if (Number(a.validBefore) < now || Number(a.validAfter) > now) {
      return {
        isValid: false,
        invalidReason: 'invalid_exact_evm_payload_authorization_valid_before',
      };
    }
    const extra = req.extra as { name: string; version: string };
    const ok = await verifyTypedData({
      address: a.from,
      domain: {
        name: extra.name,
        version: extra.version,
        chainId: Number(req.network.split(':')[1]),
        verifyingContract: req.asset as Hex,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from,
        to: a.to,
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
      signature: p.signature,
    });
    if (!ok) return { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' };
    return { isValid: true, payer: a.from };
  }

  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls++;
    const p = payload.payload as unknown as Eip3009;
    if (this.failSettle) {
      return {
        success: false,
        errorReason: 'invalid_exact_evm_insufficient_balance',
        transaction: '',
        network: req.network,
      };
    }
    return {
      success: true,
      payer: p.authorization.from,
      transaction: keccak256(p.signature),
      network: req.network,
    };
  }
}

export function testGateway(facilitator = new FakeFacilitator()) {
  const gateway = createPaymentGateway(
    testConfig({ X402_ENABLED: 'true', X402_PAY_TO: PAY_TO, X402_NETWORK: NETWORK }),
    facilitator,
  )!;
  return { gateway, facilitator };
}

/** An agent-side x402 client, as an agent would build it with the official SDK. */
export function payer(wallet: PrivateKeyAccount) {
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(wallet));
  const uncapped = x402Client
    .fromConfig({ schemes: [], spendControls: false })
    .register(NETWORK, new ExactEvmScheme(wallet));
  return {
    /** Signs a payment for a 402 response's PAYMENT-REQUIRED header (the first offer by default). */
    async pay(res: Response, opts: { pick?: number; uncapped?: boolean } = {}) {
      const header = res.headers.get('payment-required');
      if (!header) throw new Error(`no PAYMENT-REQUIRED header on ${res.status}`);
      const required = decodePaymentRequiredHeader(header);
      const chosen: PaymentRequired =
        opts.pick === undefined
          ? required
          : { ...required, accepts: [required.accepts[opts.pick]!] };
      const payload = await (opts.uncapped ? uncapped : client).createPaymentPayload(chosen);
      return encodePaymentSignatureHeader(payload);
    },
  };
}

export const challengeOf = (res: Response) =>
  decodePaymentRequiredHeader(res.headers.get('payment-required')!);
export const receiptOf = (res: Response) =>
  decodePaymentResponseHeader(res.headers.get('payment-response')!);
