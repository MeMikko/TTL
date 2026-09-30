import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { parseEncryptionKey } from '../../core/crypto.js';
import { schema } from '../../core/db/index.js';
import { SIGNATURE_HEADER } from '../../core/hmac.js';
import { pauseAllJobs } from '../../core/jobs.js';
import { pauseAllMonitors } from '../../core/monitors.js';
import { TIERS, tierFor, usd } from '../../core/plans.js';
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
              credits: z.object({ balanceMicro: z.number().int(), balanceUsd: z.string() }),
              telegram: z.object({ linked: z.boolean() }),
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

const pauseAllRoute = createRoute({
  method: 'post',
  path: '/v1/account/pause-all',
  tags: ['account'],
  summary: 'Emergency stop: pause every job and monitor',
  description:
    'Kill switch for the human owner. Pauses all active jobs (cancelling pending runs) and all ' +
    'monitors (no more alerts). Nothing is deleted; resume jobs and monitors individually when ready.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Paused',
      content: {
        'application/json': {
          schema: z.object({ jobsPaused: z.number().int(), monitorsPaused: z.number().int() }),
        },
      },
    },
    ...errorResponses(401, 403, 429),
  },
});

const revokeAllKeysRoute = createRoute({
  method: 'post',
  path: '/v1/account/keys/revoke-all',
  tags: ['account'],
  summary: 'Emergency stop: revoke every API key',
  description:
    'Revokes all of the account’s API keys, including the one making this call — the agent is ' +
    'locked out immediately. Sign in again with the wallet to mint a new key.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Revoked',
      content: { 'application/json': { schema: z.object({ revoked: z.number().int() }) } },
    },
    ...errorResponses(401, 403, 429),
  },
});

const OverviewItemStatus = z.string();
const overviewRoute = createRoute({
  method: 'get',
  path: '/v1/account/overview',
  tags: ['account'],
  summary: 'One-call read-only snapshot (for an operator view)',
  description:
    'Everything a human needs to see the fleet at a glance: account, usage, credits, status ' +
    'counts, and the most recent monitors, jobs and payments.',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'Overview',
      content: {
        'application/json': {
          schema: z
            .object({
              account: z.object({
                id: z.string(),
                address: z.string(),
                status: z.enum(['active', 'frozen']),
                activated: z.boolean(),
                tier: z.string(),
                credits: z.object({ balanceMicro: z.number().int(), balanceUsd: z.string() }),
                usage: z.object({ period: z.string(), runs: z.number().int() }),
              }),
              monitors: z.object({
                counts: z.record(z.string(), z.number().int()),
                recent: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    status: OverviewItemStatus,
                    lastPingAt: z.iso.datetime().nullable(),
                    expiresAt: z.iso.datetime().nullable(),
                    billing: z.string(),
                  }),
                ),
              }),
              jobs: z.object({
                counts: z.record(z.string(), z.number().int()),
                recent: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    status: OverviewItemStatus,
                    nextRunAt: z.iso.datetime().nullable(),
                  }),
                ),
              }),
              payments: z.array(
                z.object({
                  id: z.string(),
                  product: z.string(),
                  amountUsd: z.string(),
                  createdAt: z.iso.datetime(),
                }),
              ),
            })
            .openapi('AccountOverview'),
        },
      },
    },
    ...errorResponses(401, 403, 429),
  },
});

/** Groups `select status, count(*)` rows into a plain object. */
function counts(rows: Array<{ status: string; n: number }>): Record<string, number> {
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

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
        credits: { balanceMicro: a.creditMicro, balanceUsd: usd(a.creditMicro) },
        telegram: { linked: a.telegramChatId !== null },
      },
      200,
    );
  });

  app.openapi(pauseAllRoute, async (c) => {
    const accountId = c.get('account').id;
    const t = now();
    const [jobs, monitors] = await Promise.all([
      pauseAllJobs(db, accountId, t),
      pauseAllMonitors(db, accountId, t),
    ]);
    return c.json({ jobsPaused: jobs.paused, monitorsPaused: monitors.paused }, 200);
  });

  app.openapi(revokeAllKeysRoute, async (c) => {
    const revoked = await db
      .update(schema.apiKeys)
      .set({ revokedAt: now() })
      .where(
        and(eq(schema.apiKeys.accountId, c.get('account').id), isNull(schema.apiKeys.revokedAt)),
      )
      .returning({ id: schema.apiKeys.id });
    return c.json({ revoked: revoked.length }, 200);
  });

  app.openapi(overviewRoute, async (c) => {
    const a = c.get('account');
    const t = now();
    const [monitorCounts, jobCounts, recentMonitors, recentJobs, recentPayments] =
      await Promise.all([
        db
          .select({ status: schema.monitors.status, n: sql<number>`count(*)::int` })
          .from(schema.monitors)
          .where(eq(schema.monitors.accountId, a.id))
          .groupBy(schema.monitors.status),
        db
          .select({ status: schema.jobs.status, n: sql<number>`count(*)::int` })
          .from(schema.jobs)
          .where(eq(schema.jobs.accountId, a.id))
          .groupBy(schema.jobs.status),
        db
          .select()
          .from(schema.monitors)
          .where(eq(schema.monitors.accountId, a.id))
          .orderBy(desc(schema.monitors.createdAt))
          .limit(20),
        db
          .select()
          .from(schema.jobs)
          .where(eq(schema.jobs.accountId, a.id))
          .orderBy(desc(schema.jobs.createdAt))
          .limit(20),
        db
          .select()
          .from(schema.payments)
          .where(eq(schema.payments.accountId, a.id))
          .orderBy(desc(schema.payments.createdAt))
          .limit(10),
      ]);
    return c.json(
      {
        account: {
          id: a.id,
          address: a.walletAddress,
          status: a.status,
          activated: a.activatedAt !== null,
          tier: tierFor(a),
          credits: { balanceMicro: a.creditMicro, balanceUsd: usd(a.creditMicro) },
          usage: { period: periodOf(t), runs: await runsUsed(db, a.id, t) },
        },
        monitors: {
          counts: counts(monitorCounts),
          recent: recentMonitors.map((m) => ({
            id: m.id,
            name: m.name,
            status: m.status,
            lastPingAt: m.lastPingAt?.toISOString() ?? null,
            expiresAt: m.expiresAt?.toISOString() ?? null,
            billing: m.billing,
          })),
        },
        jobs: {
          counts: counts(jobCounts),
          recent: recentJobs.map((j) => ({
            id: j.id,
            name: j.name,
            status: j.status,
            nextRunAt: j.nextRunAt?.toISOString() ?? null,
          })),
        },
        payments: recentPayments.map((p) => ({
          id: p.id,
          product: p.product,
          amountUsd: usd(p.amountMicro),
          createdAt: p.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  return app;
}
