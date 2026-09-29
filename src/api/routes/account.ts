import { createRoute, z } from '@hono/zod-openapi';
import { TIERS, tierFor } from '../../core/plans.js';
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
            })
            .openapi('Account'),
        },
      },
    },
    ...errorResponses(401, 403, 429),
  },
});

export function accountRoutes(_deps: AppDeps) {
  const app = createRouter();

  app.openapi(getAccountRoute, (c) => {
    const a = c.get('account');
    const tier = tierFor(a);
    return c.json(
      {
        id: a.id,
        address: a.walletAddress,
        status: a.status,
        createdAt: a.createdAt.toISOString(),
        activatedAt: a.activatedAt?.toISOString() ?? null,
        tier: { name: tier, limits: { ...TIERS[tier] } },
      },
      200,
    );
  });

  return app;
}
