import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import { PaymentRequiredError } from '../core/billing.js';
import { ApiError } from '../core/errors.js';
import { RateLimiter } from '../core/rate-limit.js';
import { VERSION } from '../core/version.js';
import { networkInfo } from '../core/network.js';
import {
  createPaymentGateway,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from '../core/x402.js';
import { clientIp } from './client-ip.js';
import type { AppDeps } from './context.js';
import { requireAuth } from './middleware/auth.js';
import { idempotency } from './middleware/idempotency.js';
import { acceptPayment } from './middleware/payment.js';
import { rateLimitBy } from './middleware/rate-limit.js';
import { requestId } from './middleware/request-id.js';
import { handleMcpRequest } from './mcp.js';
import { createRouter } from './router.js';
import { accountRoutes } from './routes/account.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { billingRoutes } from './routes/billing.js';
import { discoveryRoutes } from './routes/discovery.js';
import { healthRoutes } from './routes/health.js';
import { jobRoutes } from './routes/jobs.js';
import { keyRoutes } from './routes/keys.js';
import { monitorRoutes } from './routes/monitors.js';
import { telegramAccountRoutes, telegramWebhookRoutes } from './routes/telegram.js';

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
  const gateway =
    deps.payments !== undefined ? (deps.payments ?? undefined) : createPaymentGateway(config);

  const app = createRouter();

  app.use('*', requestId);
  app.use(
    '*',
    secureHeaders({
      // Pages are server-rendered templates with inline <style>/<script> and no untrusted data in
      // script context, so 'unsafe-inline' is an accepted trade-off; everything else is locked down.
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
      },
      permissionsPolicy: {
        camera: [],
        microphone: [],
        geolocation: [],
        usb: [],
        payment: [],
        accelerometer: [],
        gyroscope: [],
        magnetometer: [],
      },
    }),
  );

  // CORS for browser-based agents. Bearer-auth API with no cookies, so a wildcard origin is safe;
  // runs before rate-limit and auth so OPTIONS preflight is answered without a token (it 401s
  // otherwise). Exposes the x402 and rate-limit response headers so browser clients can read them.
  const apiCors = cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', PAYMENT_SIGNATURE_HEADER],
    exposeHeaders: [
      PAYMENT_REQUIRED_HEADER,
      PAYMENT_RESPONSE_HEADER,
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'Retry-After',
    ],
    maxAge: 86_400,
  });
  app.use('/v1/*', apiCors);
  app.use('/mcp', apiCors);

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
  app.use('/mcp', bodyLimit({ maxSize: MAX_BODY_BYTES }));
  app.use(
    '/mcp',
    rateLimitBy(limiters.ip, (c) => `ip:${ipOf(c)}`),
  );
  app.use(
    '/v1/auth/*',
    rateLimitBy(limiters.authIp, (c) => `auth:${ipOf(c)}`),
  );

  const auth = requireAuth(deps, limiters.key);
  // Note: in Hono '/x/*' also matches '/x' itself, so list each prefix once.
  for (const path of [
    '/v1/keys/*',
    '/v1/account/*',
    '/v1/jobs/*',
    '/v1/runs/*',
    '/v1/monitors/*',
    '/v1/billing/*',
    '/v1/analytics',
  ]) {
    app.use(path, auth);
  }
  app.on(
    'POST',
    [
      '/v1/keys',
      '/v1/jobs',
      '/v1/jobs/:id/trigger',
      '/v1/monitors',
      '/v1/billing/activate',
      '/v1/billing/credits',
    ],
    idempotency(deps),
  );
  // After idempotency: a replayed response never settles a second payment.
  app.on(
    'POST',
    [
      '/v1/jobs/:id/trigger',
      '/v1/monitors',
      '/v1/monitors/:id/resume',
      '/v1/billing/activate',
      '/v1/billing/credits',
    ],
    acceptPayment(deps, gateway),
  );
  app.use('/telegram/*', bodyLimit({ maxSize: MAX_BODY_BYTES }));

  // MCP tools call the REST API in-process, carrying the caller's connection info so that
  // per-IP limits still apply to the real client.
  const mcpApi = (outer: Request, env: unknown) => (req: Request) => {
    const xff = outer.headers.get('x-forwarded-for');
    if (xff) req.headers.set('x-forwarded-for', xff);
    return Promise.resolve(app.fetch(req, env));
  };
  app.post('/mcp', (c) =>
    handleMcpRequest(c.req.raw, config.PUBLIC_BASE_URL, mcpApi(c.req.raw, c.env)),
  );
  app.on(['GET', 'DELETE'], '/mcp', (c) => {
    c.header('allow', 'POST');
    return c.json(
      { error: { code: 'method_not_allowed', message: 'Stateless MCP endpoint: use POST' } },
      405,
    );
  });

  app.route('/', healthRoutes(deps));
  app.route(
    '/',
    discoveryRoutes(deps, async () => {
      const res = await handleMcpRequest(
        new Request(new URL('/mcp', config.PUBLIC_BASE_URL), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        }),
        config.PUBLIC_BASE_URL,
        (req) => Promise.resolve(app.fetch(req)),
      );
      const body = (await res.json()) as { result?: { tools: [] } };
      if (!body.result) throw new Error(`tools/list failed: ${res.status}`);
      return body.result.tools;
    }),
  );
  app.route('/', authRoutes(deps));
  app.route('/', keyRoutes(deps));
  app.route('/', accountRoutes(deps));
  app.route('/', analyticsRoutes(deps));
  app.route('/', jobRoutes(deps));
  app.route('/', monitorRoutes(deps));
  app.route('/', billingRoutes(deps, gateway));
  app.route('/', telegramAccountRoutes(deps));
  app.route('/', telegramWebhookRoutes(deps));

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
      description:
        'Scheduling and liveness (TTL) service for autonomous AI agents: cron/one-off webhook ' +
        "jobs and heartbeat monitors (dead man's switch).\n\n" +
        'Register with an EVM wallet (`/v1/auth/challenge` → sign → `/v1/auth/verify`) and send ' +
        'the API key as `Authorization: Bearer t2l_…`. Create calls accept `Idempotency-Key`. ' +
        'Calls beyond the free tier answer `402` with an x402 v2 `PAYMENT-REQUIRED` challenge ' +
        '(USDC on Base); retry with `PAYMENT-SIGNATURE`. The same API is available as a remote ' +
        'MCP server at `/mcp`; see also `/llms.txt`.\n\n' +
        `**Network: ${networkInfo(config).label}.**`,
    },
    servers: [{ url: config.PUBLIC_BASE_URL }],
    externalDocs: {
      description: 'Agent guide (llms.txt)',
      url: `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/llms.txt`,
    },
    tags: [
      { name: 'auth', description: 'Wallet sign-in (SIWE / EIP-4361); returns an API key' },
      { name: 'keys', description: 'API key management' },
      { name: 'account', description: 'Account, usage, webhook signing secret, Telegram link' },
      { name: 'jobs', description: 'Scheduled (cron) and one-off webhook jobs and their runs' },
      { name: 'runs', description: 'Individual job runs and their delivery attempts' },
      { name: 'monitors', description: "Heartbeat monitors (dead man's switch)" },
      { name: 'heartbeat', description: 'Pings (no API key; the monitor id is the secret)' },
      { name: 'billing', description: 'x402 payments: activation, credits, payment history' },
    ],
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Route not found' } }, 404));

  app.onError(async (err, c) => {
    if (err instanceof PaymentRequiredError) {
      if (!gateway) {
        return c.json({ error: { code: 'quota_exceeded', message: err.message } }, 402);
      }
      try {
        const { body, header } = await gateway.paymentRequired(
          err.offers,
          { url: new URL(c.req.path, config.PUBLIC_BASE_URL).href, description: err.message },
          err.message,
        );
        c.header(PAYMENT_REQUIRED_HEADER, header);
        return c.json({ ...body, error: { code: err.reason, message: err.message } }, 402);
      } catch (e) {
        deps.logger.error({ err: e, requestId: c.get('requestId') }, 'x402 challenge failed');
        return c.json(
          {
            error: {
              code: 'payments_unavailable',
              message: `${err.message}; the payment service is temporarily unavailable`,
            },
          },
          503,
        );
      }
    }
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
