import { createRoute, z } from '@hono/zod-openapi';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { targetPolicyFromConfig } from '../../core/config.js';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import {
  createMonitor,
  deleteMonitor,
  getMonitor,
  pauseMonitor,
  recordPing,
  resumeMonitor,
  updateMonitor,
  type MonitorsDeps,
} from '../../core/monitors.js';
import { networkInfo } from '../../core/network.js';
import { RateLimiter } from '../../core/rate-limit.js';
import { buildMonitorReceipt, createReceiptSigner } from '../../core/receipts.js';
import type { AppDeps } from '../context.js';
import { applyRateLimit } from '../middleware/rate-limit.js';
import { createRouter } from '../router.js';
import {
  CreateMonitorSchema,
  MonitorEventSchema,
  MonitorSchema,
  PageQuerySchema,
  UpdateMonitorSchema,
  errorResponses,
  idParam,
} from '../schemas.js';
import {
  decodeCursor,
  encodeCursor,
  serializeMonitor,
  serializeMonitorEvent,
} from '../serializers.js';

const security = [{ bearerAuth: [] }];
const jsonContent = <T extends z.ZodType>(s: T) => ({ 'application/json': { schema: s } });
const monIdParam = idParam('mon');
const page = <T extends z.ZodType>(item: T) =>
  z.object({ data: z.array(item), nextCursor: z.string().nullable() });

const routes = {
  create: createRoute({
    method: 'post',
    path: '/v1/monitors',
    tags: ['monitors'],
    summary: 'Create a heartbeat monitor (dead man’s switch)',
    description:
      'The monitor stays `new` until its first ping. After that, if no ping arrives within ' +
      '`ttlSeconds + graceSeconds` it becomes `dead` and alerts fire; the next ping makes it ' +
      '`alive` again (with a recovery alert). Supports the Idempotency-Key header.',
    security,
    request: { body: { required: true, content: jsonContent(CreateMonitorSchema) } },
    responses: {
      201: { description: 'Monitor created', content: jsonContent(MonitorSchema) },
      ...errorResponses(400, 401, 402, 403, 422, 429),
    },
  }),
  list: createRoute({
    method: 'get',
    path: '/v1/monitors',
    tags: ['monitors'],
    summary: 'List monitors (newest first)',
    security,
    request: { query: PageQuerySchema },
    responses: {
      200: { description: 'Monitors', content: jsonContent(page(MonitorSchema)) },
      ...errorResponses(400, 401, 403, 429),
    },
  }),
  get: createRoute({
    method: 'get',
    path: '/v1/monitors/{id}',
    tags: ['monitors'],
    summary: 'Get a monitor’s status',
    security,
    request: { params: monIdParam },
    responses: {
      200: { description: 'Monitor', content: jsonContent(MonitorSchema) },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  update: createRoute({
    method: 'patch',
    path: '/v1/monitors/{id}',
    tags: ['monitors'],
    summary: 'Update a monitor',
    security,
    request: {
      params: monIdParam,
      body: { required: true, content: jsonContent(UpdateMonitorSchema) },
    },
    responses: {
      200: { description: 'Updated monitor', content: jsonContent(MonitorSchema) },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  remove: createRoute({
    method: 'delete',
    path: '/v1/monitors/{id}',
    tags: ['monitors'],
    summary: 'Delete a monitor',
    security,
    request: { params: monIdParam },
    responses: {
      200: {
        description: 'Deleted',
        content: jsonContent(z.object({ id: z.string(), deleted: z.literal(true) })),
      },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  pause: createRoute({
    method: 'post',
    path: '/v1/monitors/{id}/pause',
    tags: ['monitors'],
    summary: 'Pause a monitor (no alerts while paused)',
    security,
    request: { params: monIdParam },
    responses: {
      200: { description: 'Paused monitor', content: jsonContent(MonitorSchema) },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  resume: createRoute({
    method: 'post',
    path: '/v1/monitors/{id}/resume',
    tags: ['monitors'],
    summary: 'Resume a monitor; a fresh TTL window starts now',
    description:
      'A paid monitor whose 30-day period has ended is charged again from credits; without ' +
      'enough credits the answer is an x402 `402` challenge.',
    security,
    request: { params: monIdParam },
    responses: {
      200: { description: 'Monitor', content: jsonContent(MonitorSchema) },
      ...errorResponses(400, 401, 402, 403, 404, 429),
    },
  }),
  events: createRoute({
    method: 'get',
    path: '/v1/monitors/{id}/events',
    tags: ['monitors'],
    summary: 'Status transitions of a monitor (newest first, kept 30 days)',
    security,
    request: { params: monIdParam, query: PageQuerySchema },
    responses: {
      200: { description: 'Events', content: jsonContent(page(MonitorEventSchema)) },
      ...errorResponses(400, 401, 403, 404, 429),
    },
  }),
  receipt: createRoute({
    method: 'get',
    path: '/v1/monitors/{id}/receipt',
    tags: ['monitors'],
    summary: "Signed liveness receipt — a portable, verifiable attestation of the monitor's state",
    description:
      'Returns a server-signed (Ed25519) receipt an agent can hand to a third party to prove its ' +
      'liveness: in particular that it halted on purpose (`halted_by_operator`) rather than silently ' +
      'missing its window (`missed_window`). Verify offline against the public key at ' +
      '`/.well-known/time2live-receipts.json` (Ed25519 over the canonical JSON of `receipt`: object ' +
      'keys sorted recursively, no whitespace).',
    security,
    request: { params: monIdParam },
    responses: {
      200: {
        description: 'Signed receipt',
        content: jsonContent(
          z.object({
            receipt: z.record(z.string(), z.unknown()),
            signature: z.object({
              alg: z.literal('Ed25519'),
              keyId: z.string(),
              publicKey: z.string(),
              value: z.string(),
            }),
          }),
        ),
      },
      ...errorResponses(401, 403, 404, 429),
    },
  }),
  ping: createRoute({
    method: 'post',
    path: '/v1/heartbeat/{id}',
    tags: ['heartbeat'],
    summary: 'Ping a monitor ("I am alive")',
    description:
      'No API key needed: the unguessable monitor id is the credential. Keep the ping URL secret. ' +
      'Example: `curl -fsS -X POST https://time2live.xyz/v1/heartbeat/mon_…`',
    request: { params: monIdParam },
    responses: {
      200: {
        description: 'Ping recorded',
        content: jsonContent(
          z.object({
            id: z.string(),
            status: z.enum(['new', 'alive', 'dead', 'paused']),
            previousStatus: z.enum(['new', 'alive', 'dead', 'paused']),
            expiresAt: z.iso.datetime().nullable(),
          }),
        ),
      },
      ...errorResponses(404, 429),
    },
  }),
};

export function monitorRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const base = deps.config.PUBLIC_BASE_URL;
  const monitorsDeps: MonitorsDeps = {
    db,
    policy: targetPolicyFromConfig(deps.config),
    resolve: deps.dnsResolve,
    emailConfigured: Boolean(deps.config.RESEND_API_KEY && deps.config.ALERT_EMAIL_FROM),
  };
  const pingLimiter = RateLimiter.perMinute(
    deps.config.RATE_LIMIT_PING_PER_MIN,
    deps.now ? () => deps.now!().getTime() : undefined,
  );
  const render = (m: Parameters<typeof serializeMonitor>[0]) => serializeMonitor(m, base);
  const receiptSigner = createReceiptSigner(deps.config.ENCRYPTION_KEY);
  const receiptNetwork = networkInfo(deps.config).x402Network ?? 'none';
  const app = createRouter();

  app.openapi(routes.create, async (c) => {
    const body = c.req.valid('json');
    const m = await createMonitor(
      monitorsDeps,
      c.get('account'),
      {
        name: body.name,
        ttlSeconds: body.ttlSeconds,
        graceSeconds: body.graceSeconds,
        mode: body.mode,
        checkUrl: body.check?.url ?? null,
        checkIntervalSeconds: body.check?.intervalSeconds ?? null,
        checkExpectStatus: body.check?.expect?.status ?? null,
        checkBodyContains: body.check?.expect?.bodyContains ?? null,
        alertWebhookUrl: body.alerts.webhookUrl,
        alertWebhookUrl2: body.alerts.webhookUrl2,
        alertTelegram: body.alerts.telegram,
        alertEmail: body.alerts.email,
      },
      now(),
    );
    return c.json(render(m), 201);
  });

  app.openapi(routes.list, async (c) => {
    const { limit, cursor } = c.req.valid('query');
    const after = cursor === undefined ? null : decodeCursor(cursor);
    if (cursor !== undefined && !after)
      throw new ApiError(400, 'invalid_cursor', 'Invalid pagination cursor');
    const t = schema.monitors;
    const rows = await db
      .select()
      .from(t)
      .where(
        and(
          eq(t.accountId, c.get('account').id),
          after
            ? or(
                lt(t.createdAt, after.createdAt),
                and(eq(t.createdAt, after.createdAt), lt(t.id, after.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(t.createdAt), desc(t.id))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return c.json(
      {
        data: pageRows.map(render),
        nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
      },
      200,
    );
  });

  app.openapi(routes.get, async (c) =>
    c.json(render(await getMonitor(db, c.get('account').id, c.req.valid('param').id)), 200),
  );

  app.openapi(routes.update, async (c) => {
    const body = c.req.valid('json');
    const m = await updateMonitor(
      monitorsDeps,
      c.get('account').id,
      c.req.valid('param').id,
      {
        name: body.name,
        ttlSeconds: body.ttlSeconds,
        graceSeconds: body.graceSeconds,
        alertWebhookUrl: body.alerts?.webhookUrl,
        alertWebhookUrl2: body.alerts?.webhookUrl2,
        alertTelegram: body.alerts?.telegram,
        alertEmail: body.alerts?.email,
      },
      now(),
    );
    return c.json(render(m), 200);
  });

  app.openapi(routes.remove, async (c) => {
    const { id } = c.req.valid('param');
    await deleteMonitor(db, c.get('account').id, id);
    return c.json({ id, deleted: true as const }, 200);
  });

  app.openapi(routes.pause, async (c) =>
    c.json(
      render(await pauseMonitor(db, c.get('account').id, c.req.valid('param').id, now())),
      200,
    ),
  );

  app.openapi(routes.resume, async (c) =>
    c.json(render(await resumeMonitor(db, c.get('account'), c.req.valid('param').id, now())), 200),
  );

  app.openapi(routes.events, async (c) => {
    const { id } = c.req.valid('param');
    const { limit, cursor } = c.req.valid('query');
    await getMonitor(db, c.get('account').id, id);
    // Events have a numeric identity; the cursor carries the last seen id.
    const before =
      cursor === undefined ? null : Number(Buffer.from(cursor, 'base64url').toString());
    if (before !== null && !Number.isSafeInteger(before)) {
      throw new ApiError(400, 'invalid_cursor', 'Invalid pagination cursor');
    }
    const t = schema.monitorEvents;
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.monitorId, id), before !== null ? lt(t.id, before) : undefined))
      .orderBy(desc(t.id))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    return c.json(
      {
        data: pageRows.map(serializeMonitorEvent),
        nextCursor:
          rows.length > limit && last ? Buffer.from(String(last.id)).toString('base64url') : null,
      },
      200,
    );
  });

  app.openapi(routes.receipt, async (c) => {
    const m = await getMonitor(db, c.get('account').id, c.req.valid('param').id);
    const [lastEvent] = await db
      .select()
      .from(schema.monitorEvents)
      .where(eq(schema.monitorEvents.monitorId, m.id))
      .orderBy(desc(schema.monitorEvents.id))
      .limit(1);
    const receipt = buildMonitorReceipt({
      monitor: m,
      lastEvent: lastEvent
        ? { toStatus: lastEvent.toStatus, reason: lastEvent.reason, at: lastEvent.at }
        : null,
      ownerAddress: c.get('account').walletAddress,
      network: receiptNetwork,
      service: 'time2live',
      now: now(),
    });
    c.header('cache-control', 'no-store');
    return c.json({ receipt, signature: receiptSigner.sign(receipt) }, 200);
  });

  app.openapi(routes.ping, async (c) => {
    const { id } = c.req.valid('param');
    applyRateLimit(c, pingLimiter.consume(`ping:${id}`));
    const result = await recordPing(db, id, now());
    if (!result) throw new ApiError(404, 'not_found', 'Monitor not found');
    return c.json(
      {
        id,
        status: result.monitor.status,
        previousStatus: result.previous,
        expiresAt: result.monitor.expiresAt?.toISOString() ?? null,
      },
      200,
    );
  });

  return app;
}
