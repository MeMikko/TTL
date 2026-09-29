import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type FacilitatorClient,
} from '@x402/core/server';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http';
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import type { Config } from './config.js';
import { productLabel, productPriceMicro, usd, type Product } from './plans.js';

/** x402 v2 transport headers. */
export const PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
export const PAYMENT_SIGNATURE_HEADER = 'PAYMENT-SIGNATURE';
export const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

export interface SettledPayment {
  product: Product;
  requirements: PaymentRequirements;
  settlement: SettleResponse;
  payer: string | undefined;
}

export type CollectResult =
  { ok: true; payment: SettledPayment } | { ok: false; reason: string; message: string };

/**
 * Thin wrapper around the official x402 resource server: builds payment requirements for our
 * products, and verifies + settles a client's PAYMENT-SIGNATURE through the facilitator.
 */
export interface PaymentGateway {
  readonly network: string;
  readonly payTo: string;
  /** 402 challenge for the offered products (first = recommended). */
  paymentRequired(
    offers: Product[],
    resource: { url: string; description: string },
    error?: string,
  ): Promise<{ body: PaymentRequired; header: string }>;
  /** Verifies and settles a PAYMENT-SIGNATURE header against the accepted products. */
  collect(headerValue: string, accepted: Product[]): Promise<CollectResult>;
  encodeSettlement(settlement: SettleResponse): string;
}

/** First line of a facilitator message, unless it is a dangling "…reason:" fragment. */
function firstLine(message: string | undefined, fallback: string): string {
  const line = message?.split('\n')[0]?.trim();
  return line && !line.endsWith(':') ? line : fallback;
}

export function createPaymentGateway(
  config: Config,
  facilitator?: FacilitatorClient,
): PaymentGateway | undefined {
  if (!config.X402_ENABLED || !config.X402_PAY_TO) return undefined;
  const network = config.X402_NETWORK;
  const payTo = config.X402_PAY_TO;
  const client =
    facilitator ??
    new HTTPFacilitatorClient({
      url: config.X402_FACILITATOR_URL,
      timeoutMs: 20_000,
      ...(config.X402_FACILITATOR_AUTHORIZATION
        ? {
            createAuthHeaders: async () => {
              const h = { Authorization: config.X402_FACILITATOR_AUTHORIZATION! };
              return { verify: h, settle: h, supported: h };
            },
          }
        : {}),
    });
  const server = new x402ResourceServer(client).register(network, new ExactEvmScheme());

  // Fetches the facilitator's supported kinds; retried on the next payment if it failed.
  let ready: Promise<void> | undefined;
  const init = () => {
    ready ??= server.initialize().catch((err: unknown) => {
      ready = undefined;
      throw err;
    });
    return ready;
  };

  async function requirementsFor(products: Product[]) {
    await init();
    const rows = await Promise.all(
      products.map(async (product) => {
        const [req] = await server.buildPaymentRequirementsFromOptions(
          [
            {
              scheme: 'exact',
              network,
              payTo,
              price: usd(productPriceMicro(product)),
              maxTimeoutSeconds: 300,
              extra: { product: productLabel(product) },
            },
          ],
          {},
        );
        if (!req) throw new Error(`no payment requirements for ${productLabel(product)}`);
        return { product, req };
      }),
    );
    return rows;
  }

  return {
    network,
    payTo,

    async paymentRequired(offers, resource, error) {
      const rows = await requirementsFor(offers);
      const body = await server.createPaymentRequiredResponse(
        rows.map((r) => r.req),
        { url: resource.url, description: resource.description, mimeType: 'application/json' },
        error,
      );
      return { body, header: encodePaymentRequiredHeader(body) };
    },

    async collect(headerValue, accepted) {
      let payload: PaymentPayload;
      try {
        payload = decodePaymentSignatureHeader(headerValue);
      } catch {
        return {
          ok: false,
          reason: 'invalid_payment_header',
          message: 'PAYMENT-SIGNATURE is not valid base64 JSON',
        };
      }
      const rows = await requirementsFor(accepted);
      const match = server.findMatchingRequirements(
        rows.map((r) => r.req),
        payload,
      );
      const row = match && rows.find((r) => r.req === match);
      if (!match || !row) {
        return {
          ok: false,
          reason: 'payment_mismatch',
          message: 'The payment does not match any accepted price, network, asset or recipient',
        };
      }
      try {
        const verified = await server.verifyPayment(payload, match);
        if (!verified.isValid) {
          return {
            ok: false,
            reason: verified.invalidReason ?? 'invalid_payment',
            message: firstLine(
              verified.invalidMessage,
              `Payment verification failed (${verified.invalidReason ?? 'invalid'})`,
            ),
          };
        }
        const settlement = await server.settlePayment(payload, match);
        if (!settlement.success) {
          return {
            ok: false,
            reason: settlement.errorReason ?? 'settlement_failed',
            message: firstLine(
              settlement.errorMessage,
              `Payment settlement failed (${settlement.errorReason ?? 'error'})`,
            ),
          };
        }
        return {
          ok: true,
          payment: {
            product: row.product,
            requirements: match,
            settlement,
            payer: settlement.payer ?? verified.payer,
          },
        };
      } catch (err) {
        const e = err as { invalidReason?: string; errorReason?: string; message?: string };
        return {
          ok: false,
          reason: e.invalidReason ?? e.errorReason ?? 'facilitator_error',
          message: firstLine(
            e.message,
            `Payment rejected (${e.invalidReason ?? e.errorReason ?? 'facilitator error'})`,
          ),
        };
      }
    },

    encodeSettlement: (settlement) => encodePaymentResponseHeader(settlement),
  };
}
