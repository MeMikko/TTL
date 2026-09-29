import { createRoute, z } from '@hono/zod-openapi';
import { desc, eq } from 'drizzle-orm';
import { PaymentRequiredError } from '../../core/billing.js';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import { MICRO, PRICES, productLabel, tierFor, TIERS, usd, type Pack } from '../../core/plans.js';
import type { PaymentGateway } from '../../core/x402.js';
import type { AppDeps } from '../context.js';
import { createRouter } from '../router.js';
import { errorResponses } from '../schemas.js';

const security = [{ bearerAuth: [] }];
const json = <T extends z.ZodType>(s: T) => ({ 'application/json': { schema: s } });

const x402Description =
  'Paid with x402 (USDC on Base). Call without payment to receive `402` with a ' +
  '`PAYMENT-REQUIRED` header, pay with any x402 v2 client and retry the same request with ' +
  '`PAYMENT-SIGNATURE`; the settlement receipt comes back in `PAYMENT-RESPONSE`.';

const BillingSchema = z
  .object({
    x402: z.object({
      enabled: z.boolean(),
      network: z.string().nullable().openapi({ example: 'eip155:84532' }),
      asset: z.literal('USDC'),
      payTo: z.string().nullable(),
    }),
    activated: z.boolean(),
    activatedAt: z.iso.datetime().nullable(),
    tier: z.object({
      name: z.enum(['unactivated', 'free']),
      limits: z.object({ monitors: z.number().int(), runsPerMonth: z.number().int() }),
    }),
    credits: z.object({ balanceMicro: z.number().int(), balanceUsd: z.string() }),
    prices: z.object({
      activation: z.string().openapi({ example: '$0.10' }),
      extraRun: z.string().openapi({ example: '$0.0005' }),
      extraMonitorPer30Days: z.string().openapi({ example: '$0.25' }),
      creditPacks: z.array(z.string()).openapi({ example: ['$1.00', '$5.00', '$20.00'] }),
    }),
  })
  .openapi('Billing');

const PurchaseSchema = z.object({
  purchased: z.string().nullable().openapi({ example: 'credits-1' }),
  paymentId: z.string().nullable(),
  activated: z.boolean(),
  credits: z.object({ balanceMicro: z.number().int(), balanceUsd: z.string() }),
});

const routes = {
  get: createRoute({
    method: 'get',
    path: '/v1/billing',
    tags: ['billing'],
    summary: 'Balance, tier and prices',
    security,
    responses: {
      200: { description: 'Billing overview', content: json(BillingSchema) },
      ...errorResponses(401, 403, 429),
    },
  }),
  activate: createRoute({
    method: 'post',
    path: '/v1/billing/activate',
    tags: ['billing'],
    summary: `Activate the free tier (one-off ${usd(PRICES.activationMicro)})`,
    description: `Raises the free allowance to ${TIERS.free.monitors} monitors and ${TIERS.free.runsPerMonth} runs/month. ${x402Description} A no-op for activated accounts.`,
    security,
    responses: {
      200: { description: 'Activated', content: json(PurchaseSchema) },
      ...errorResponses(401, 402, 403, 429, 501),
    },
  }),
  credits: createRoute({
    method: 'post',
    path: '/v1/billing/credits',
    tags: ['billing'],
    summary: 'Buy prepaid credits',
    description:
      `Credits pay for runs beyond the free allowance (${usd(PRICES.runMicro)} each) and extra monitors ` +
      `(${usd(PRICES.monitorMonthMicro)} per 30 days). ${x402Description} x402 client SDKs cap single ` +
      'payments at $1 by default; raise `maxAmountPerPayment` to buy the $5 or $20 pack.',
    security,
    request: {
      body: {
        required: false,
        content: json(
          z.object({
            pack: z
              .union([z.literal(1), z.literal(5), z.literal(20)])
              .default(1)
              .openapi({ description: 'Pack size in USD' }),
          }),
        ),
      },
    },
    responses: {
      200: { description: 'Credits added', content: json(PurchaseSchema) },
      ...errorResponses(400, 401, 402, 403, 429, 501),
    },
  }),
  payments: createRoute({
    method: 'get',
    path: '/v1/billing/payments',
    tags: ['billing'],
    summary: 'Settled payments (newest first, max 100)',
    security,
    responses: {
      200: {
        description: 'Payments',
        content: json(
          z.object({
            data: z.array(
              z.object({
                id: z.string(),
                product: z.string(),
                amountUsd: z.string(),
                network: z.string(),
                transaction: z.string(),
                payer: z.string().nullable(),
                createdAt: z.iso.datetime(),
              }),
            ),
          }),
        ),
      },
      ...errorResponses(401, 403, 429),
    },
  }),
};

const credits = (micro: number) => ({ balanceMicro: micro, balanceUsd: usd(micro) });

export function billingRoutes(deps: AppDeps, gateway: PaymentGateway | undefined) {
  const { db } = deps.database;
  const app = createRouter();
  const requireGateway = () => {
    if (!gateway) {
      throw new ApiError(
        501,
        'billing_unavailable',
        'x402 payments are not enabled on this server',
      );
    }
  };

  app.openapi(routes.get, (c) => {
    const a = c.get('account');
    const tier = tierFor(a);
    return c.json(
      {
        x402: {
          enabled: !!gateway,
          network: gateway?.network ?? null,
          asset: 'USDC' as const,
          payTo: gateway?.payTo ?? null,
        },
        activated: a.activatedAt !== null,
        activatedAt: a.activatedAt?.toISOString() ?? null,
        tier: { name: tier, limits: { ...TIERS[tier] } },
        credits: credits(a.creditMicro),
        prices: {
          activation: usd(PRICES.activationMicro),
          extraRun: usd(PRICES.runMicro),
          extraMonitorPer30Days: usd(PRICES.monitorMonthMicro),
          creditPacks: PRICES.packs.map((p) => usd(p * MICRO)),
        },
      },
      200,
    );
  });

  app.openapi(routes.activate, (c) => {
    const a = c.get('account');
    const payment = c.get('payment');
    if (!a.activatedAt) {
      requireGateway();
      throw new PaymentRequiredError(
        [{ kind: 'activation' }],
        `Activation costs ${usd(PRICES.activationMicro)}`,
      );
    }
    return c.json(
      {
        purchased: payment ? productLabel(payment.product) : null,
        paymentId: payment?.paymentId ?? null,
        activated: true,
        credits: credits(a.creditMicro),
      },
      200,
    );
  });

  app.openapi(routes.credits, async (c) => {
    const pack = ((await c.req.json().catch(() => ({}))) as { pack?: Pack }).pack ?? 1;
    const a = c.get('account');
    const payment = c.get('payment');
    if (!payment) {
      requireGateway();
      throw new PaymentRequiredError(
        [{ kind: 'credits', pack }],
        `The ${usd(pack * MICRO)} credit pack`,
      );
    }
    return c.json(
      {
        purchased: productLabel(payment.product),
        paymentId: payment.paymentId,
        activated: a.activatedAt !== null,
        credits: credits(a.creditMicro),
      },
      200,
    );
  });

  app.openapi(routes.payments, async (c) => {
    const rows = await db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.accountId, c.get('account').id))
      .orderBy(desc(schema.payments.createdAt))
      .limit(100);
    return c.json(
      {
        data: rows.map((p) => ({
          id: p.id,
          product: p.product,
          amountUsd: usd(p.amountMicro),
          network: p.network,
          transaction: p.transaction,
          payer: p.payer,
          createdAt: p.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  return app;
}
