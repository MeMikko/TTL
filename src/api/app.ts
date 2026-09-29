import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppDeps, AppEnv } from './context.js';
import { requestId } from './middleware/request-id.js';
import { healthRoutes } from './routes/health.js';

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use('*', requestId);
  app.use('*', secureHeaders());

  app.route('/', healthRoutes(deps));

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    }
    deps.logger.error({ err, requestId: c.get('requestId') }, 'unhandled error');
    return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
  });

  return app;
}
