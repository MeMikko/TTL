import { createRoute, z } from '@hono/zod-openapi';
import { parseEncryptionKey } from '../../core/crypto.js';
import { SIGNATURE_HEADER } from '../../core/hmac.js';
import { TIERS, tierFor } from '../../core/plans.js';
import { periodOf, runsUsed } from '../../core/usage.js';
import { getOrCreateWebhookSecret, rotateWebhookSecret } from '../../core/webhook-secret.js';
import type { AppDeps } from '../context.js';
import { createRouter } from '../router.js';
import { errorResponses } from '../schemas.js';

const LimitsSchema = z.object({ monitors: z.number().int(), runsPerMonth: z.number().int() });

const getAccountRoute = createRoute({
  method: 'get',
  path: '/v1/account',
  tags: ['account'],
  summary: 'Get the authenticated account',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Account details and current tier limits',
      content: {
        'application/json': {
          schema: z
            .object({
              id: z.string(),
              address: z.string(),
              status: z.enum(['active', 'frozen']),
              createdAt: z.iso.datetime(),
              activatedAt: z.iso.datetime().nullable(),
              tier: z.object({ name: z.enum(['unactivated', 'free']), limits: LimitsSchema }),
              usage: z.object({ period: z.string(), runs: z.number().int() }),
            })
            .openapi('Account'),
        },
      },
    },
    ...errorResponses(401, 403, 429),
  },
});

const SecretSchema = z
  .object({
    secret: z.string().openapi({ example: 'whsec_…' }),
    header: z.literal(SIGNATURE_HEADER),
    scheme: z.string(),
  })
  .openapi('WebhookSecret');

const secretDescription =
  `Deliveries carry \`${SIGNATURE_HEADER}: t=<unix>,v1=<hex>\` where v1 = ` +
  'HMAC-SHA256(secret, `${t}.${rawBody}`). Reject timestamps older than 5 minutes.';

const getSecretRoute = createRoute({
  method: 'get',
  path: '/v1/account/webhook-secret',
  tags: ['account'],
  summary: 'Get the secret used to sign webhook deliveries',
  description: secretDescription,
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Signing secret',
      content: { 'application/json': { schema: SecretSchema } },
    },
    ...errorResponses(401, 403, 429),
  },
});

const rotateSecretRoute = createRoute({
  method: 'post',
  path: '/v1/account/webhook-secret/rotate',
  tags: ['account'],
  summary: 'Replace the webhook signing secret (effective immediately)',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'New signing secret',
      content: { 'application/json': { schema: SecretSchema } },
    },
    ...errorResponses(401, 403, 429),
  },
});

export function accountRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const key = parseEncryptionKey(deps.config.ENCRYPTION_KEY);
  const scheme = 'v1=HMAC-SHA256(secret, `${t}.${body}`)';
  const app = createRouter();

  app.openapi(getSecretRoute, async (c) => {
    const secret = await getOrCreateWebhookSecret(db, key, c.get('account').id);
    return c.json({ secret, header: SIGNATURE_HEADER, scheme }, 200);
  });

  app.openapi(rotateSecretRoute, async (c) => {
    const secret = await rotateWebhookSecret(db, key, c.get('account').id);
    return c.json({ secret, header: SIGNATURE_HEADER, scheme }, 200);
  });

  app.openapi(getAccountRoute, async (c) => {
    const a = c.get('account');
    const tier = tierFor(a);
    const t = now();
    return c.json(
      {
        id: a.id,
        address: a.walletAddress,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        activatedAt: a.activatedAt?.toISOString() ?? null,
        tier: { name: tier, limits: { ...TIERS[tier] } },
        usage: { period: periodOf(t), runs: await runsUsed(db, a.id, t) },
      },
      200,
    );
  });

  return app;
}
