import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { ApiError } from '../core/errors.js';
import { RateLimiter } from '../core/rate-limit.js';
import { VERSION } from '../core/version.js';
import { clientIp } from './client-ip.js';
import type { AppDeps } from './context.js';
import { requireAuth } from './middleware/auth.js';
import { idempotency } from './middleware/idempotency.js';
import { rateLimitBy } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { createRouter } from './router.js';
import { accountRoutes } from './routes/account.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';
import { keyRoutes } from './routes/keys.js';

const MAX_BODY_BYTES = 64 * 1024;

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const clock = deps.now ? () => deps.now!().getTime() : undefined;
  const limiters = {
    ip: RateLimiter.perMinute(config.RATE_LIMIT_IP_PER_MIN, clock),
    authIp: RateLimiter.perMinute(config.RATE_LIMIT_AUTH_IP_PER_MIN, clock),
    key: RateLimiter.perMinute(config.RATE_LIMIT_KEY_PER_MIN, clock),
  };
  const ipOf = (c: Parameters<typeof clientIp>[0]) => clientIp(c, config.TRUST_PROXY);

  const app = createRouter();

  app.use('*', requestId);
  app.use('*', secureHeaders());

  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => {
        throw new ApiError(
          413,
          'payload_too_large',
          `Request body exceeds ${MAX_BODY_BYTES} bytes`,
        );
      },
    }),
  );
  app.use(
    '/v1/*',
    rateLimitBy(limiters.ip, (c) => `ip:${ipOf(c)}`),
  );
  app.use(
    '/v1/auth/*',
    rateLimitBy(limiters.authIp, (c) => `auth:${ipOf(c)}`),
  );

  const auth = requireAuth(deps, limiters.key);
  // Note: in Hono '/x/*' also matches '/x' itself, so list each prefix once.
  for (const path of ['/v1/keys/*', '/v1/account/*', '/v1/jobs/*', '/v1/runs/*']) {
    app.use(path, auth);
  }
  app.on('POST', ['/v1/keys', '/v1/jobs', '/v1/jobs/:id/trigger'], idempotency(deps));

  app.route('/', healthRoutes(deps));
  app.route('/', authRoutes(deps));
  app.route('/', keyRoutes(deps));
  app.route('/', accountRoutes(deps));
  app.route('/', jobRoutes(deps));

  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'API key obtained from POST /v1/auth/verify (format: t2l_…)',
  });
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'time2live API',
      version: VERSION,
      description: 'Scheduling and liveness (TTL) service for autonomous AI agents.',
    },
    servers: [{ url: config.PUBLIC_BASE_URL }],
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v);
      return c.json(err.toBody(), err.status);
    }
    if (err instanceof HTTPException) {
      const code = err.status === 400 ? 'bad_request' : 'http_error';
      return c.json({ error: { code, message: err.message } }, err.status);
    }
    deps.logger.error({ err, requestId: c.get('requestId') }, 'unhandled error');
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });

  return app;
}
