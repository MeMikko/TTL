import { createRoute, z } from '@hono/zod-openapi';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { schema } from '../../core/db/index.js';
import { ApiError } from '../../core/errors.js';
import { issueApiKey } from '../../core/keys.js';
import type { AppDeps } from '../context.js';
import { createRouter } from '../router.js';
import {
  ApiKeyInfoSchema,
  KeyNameSchema,
  NewApiKeySchema,
  errorResponses,
  idParam,
} from '../schemas.js';
import { serializeApiKey } from '../serializers.js';

const security = [{ bearerAuth: [] }];

const listRoute = createRoute({
  method: 'get',
  path: '/v1/keys',
  tags: ['keys'],
  summary: 'List active API keys',
  security,
  responses: {
    200: {
      description: 'Active keys (secrets are never returned)',
      content: { 'application/json': { schema: z.object({ data: z.array(ApiKeyInfoSchema) }) } },
    },
    ...errorResponses(401, 403, 429),
  },
});

const createKeyRoute = createRoute({
  method: 'post',
  path: '/v1/keys',
  tags: ['keys'],
  summary: 'Create an additional API key',
  description: 'Supports the Idempotency-Key header.',
  security,
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: z.object({ name: KeyNameSchema }) } },
    },
  },
  responses: {
    201: {
      description: 'Key created; the secret is shown only once',
      content: { 'application/json': { schema: NewApiKeySchema } },
    },
    ...errorResponses(400, 401, 403, 409, 422, 429),
  },
});

const revokeRoute = createRoute({
  method: 'delete',
  path: '/v1/keys/{id}',
  tags: ['keys'],
  summary: 'Revoke an API key',
  security,
  request: { params: idParam('key') },
  responses: {
    200: {
      description: 'Key revoked',
      content: {
        'application/json': {
          schema: z.object({ id: z.string(), revokedAt: z.iso.datetime() }),
        },
      },
    },
    ...errorResponses(401, 403, 404, 429),
  },
});

export function keyRoutes(deps: AppDeps) {
  const now = deps.now ?? (() => new Date());
  const { db } = deps.database;
  const t = schema.apiKeys;
  const app = createRouter();

  app.openapi(listRoute, async (c) => {
    const rows = await db
      .select()
      .from(t)
      .where(and(eq(t.accountId, c.get('account').id), isNull(t.revokedAt)))
      .orderBy(asc(t.createdAt));
    return c.json({ data: rows.map(serializeApiKey) }, 200);
  });

  app.openapi(createKeyRoute, async (c) => {
    const { name } = c.req.valid('json');
    const { record, key } = await issueApiKey(
      db,
      c.get('account').id,
      name,
      deps.config.MAX_API_KEYS_PER_ACCOUNT,
    );
    return c.json({ ...serializeApiKey(record), key }, 201);
  });

  app.openapi(revokeRoute, async (c) => {
    const { id } = c.req.valid('param');
    const [row] = await db
      .update(t)
      .set({ revokedAt: now() })
      .where(and(eq(t.id, id), eq(t.accountId, c.get('account').id), isNull(t.revokedAt)))
      .returning();
    if (!row?.revokedAt) throw new ApiError(404, 'not_found', 'API key not found');
    return c.json({ id: row.id, revokedAt: row.revokedAt.toISOString() }, 200);
  });

  return app;
}
