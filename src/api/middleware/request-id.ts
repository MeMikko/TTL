import { randomUUID } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../context.js';

const VALID_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Propagates a caller-supplied X-Request-Id (if sane) or generates one. */
export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
});
