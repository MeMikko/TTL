import { z } from '@hono/zod-openapi';

export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: 'validation_error' }),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('Error');

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Invalid request (`validation_error` lists the failing fields)',
  401: 'Missing or invalid API key',
  402:
    'Payment required. With x402 enabled the `PAYMENT-REQUIRED` header (base64 JSON, x402 v2) ' +
    'lists the accepted payments and the body carries the same object plus `error`; retry the ' +
    'same request with `PAYMENT-SIGNATURE`. Without x402: `quota_exceeded`.',
  403: 'Account frozen, or not allowed',
  404: 'Not found',
  409: 'Conflict with the current state',
  413: 'Request body too large',
  422: 'Target URL rejected (blocked address or unresolvable host)',
  429: 'Rate limited; see `Retry-After`',
  501: 'Not enabled on this server',
};

export const errorResponses = (...codes: number[]) =>
  Object.fromEntries(
    codes.map((code) => [
      code,
      {
        description: ERROR_DESCRIPTIONS[code] ?? `Error ${code}`,
        content: { 'application/json': { schema: ErrorSchema } },
        ...(code === 402
          ? {
              headers: {
                'PAYMENT-REQUIRED': {
                  description: 'x402 v2 PaymentRequired, base64-encoded JSON',
                  schema: { type: 'string' as const },
                },
              },
            }
          : {}),
      },
    ]),
  );

export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed 20-byte hex address')
  .openapi({ example: '0x9fB29AAc15b9A4B7F17c3385939b007540f4d791' });

export const HexSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]*$/, 'must be 0x-prefixed hex')
  .max(20_000);

export const KeyNameSchema = z.string().trim().min(1).max(64);

export const ApiKeyInfoSchema = z
  .object({
    id: z.string().openapi({ example: 'key_4Wq…' }),
    prefix: z.string().openapi({ example: 't2l_AbCd1234' }),
    name: z.string(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
  })
  .openapi('ApiKeyInfo');

export const NewApiKeySchema = ApiKeyInfoSchema.extend({
  key: z.string().openapi({ description: 'The secret key. Shown only once; store it securely.' }),
}).openapi('NewApiKey');

export const idParam = (prefix: string) =>
  z.object({
    id: z
      .string()
      .regex(new RegExp(`^${prefix}_[0-9A-Za-z]{22}$`))
      .openapi({ param: { name: 'id', in: 'path' } }),
  });

// ---- Jobs -----------------------------------------------------------------------------------

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection',
  'expect',
  'user-agent',
]);

export const HeadersSchema = z
  .record(z.string(), z.string().max(2048))
  .superRefine((headers, ctx) => {
    const names = Object.keys(headers);
    if (names.length > 20) ctx.addIssue({ code: 'custom', message: 'at most 20 headers' });
    const seen = new Set<string>();
    for (const name of names) {
      const lower = name.toLowerCase();
      if (!HEADER_NAME.test(name))
        ctx.addIssue({ code: 'custom', message: `invalid header name: ${name}` });
      else if (RESERVED_HEADERS.has(lower) || lower.startsWith('t2l-')) {
        ctx.addIssue({ code: 'custom', message: `header not allowed: ${name}` });
      }
      if (seen.has(lower)) ctx.addIssue({ code: 'custom', message: `duplicate header: ${name}` });
      seen.add(lower);
      if (/[\r\n\0]/.test(headers[name]!)) {
        ctx.addIssue({ code: 'custom', message: `invalid characters in header value: ${name}` });
      }
    }
  })
  .openapi({
    description: 'Custom request headers (stored encrypted; values are never returned).',
    example: { authorization: 'Bearer my-agent-token' },
  });

const MAX_BODY_CHARS = 32 * 1024;

/** A string is sent as-is; any other JSON value is serialised with JSON.stringify. */
export const BodySchema = z
  .union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown()), z.null()])
  .transform((b) => (b === null || typeof b === 'string' ? b : JSON.stringify(b)))
  .refine(
    (b) => b === null || b.length <= MAX_BODY_CHARS,
    `body must be at most ${MAX_BODY_CHARS} characters`,
  )
  .openapi({
    description: 'Request body: a string, or JSON (serialised).',
    example: { task: 'wake-up' },
  });

export const MethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export const ScheduleSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('cron'),
      expression: z.string().min(1).max(100).openapi({ example: '*/15 * * * *' }),
      timezone: z.string().min(1).max(64).default('UTC').openapi({ example: 'Europe/Helsinki' }),
    }),
    z.object({
      type: z.literal('once'),
      at: z.iso.datetime({ offset: true }).openapi({ example: '2026-10-01T09:00:00Z' }),
    }),
  ])
  .openapi('Schedule');

export const TargetSchema = z
  .object({
    url: z.string().max(2048).openapi({ example: 'https://agent.example.com/wake' }),
    method: MethodSchema.default('POST'),
    headers: HeadersSchema.default({}),
    body: BodySchema.default(null),
  })
  .openapi('Target');

export const CreateJobSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    schedule: ScheduleSchema,
    target: TargetSchema,
    timeoutMs: z.number().int().min(1000).max(30_000).default(10_000),
    maxAttempts: z.number().int().min(1).max(10).default(5),
  })
  .openapi('CreateJob');

export const UpdateJobSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    schedule: ScheduleSchema,
    target: z
      .object({
        url: z.string().max(2048),
        method: MethodSchema,
        headers: HeadersSchema,
        body: BodySchema,
      })
      .partial(),
    timeoutMs: z.number().int().min(1000).max(30_000),
    maxAttempts: z.number().int().min(1).max(10),
  })
  .partial()
  .openapi('UpdateJob');

export const JobSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['active', 'paused', 'completed']),
    schedule: z.union([
      z.object({ type: z.literal('cron'), expression: z.string(), timezone: z.string() }),
      z.object({ type: z.literal('once'), at: z.iso.datetime() }),
    ]),
    target: z.object({
      url: z.string(),
      method: MethodSchema,
      headers: z.record(z.string(), z.string()).openapi({
        description: 'Header names with redacted values',
        example: { authorization: '[redacted]' },
      }),
      body: z.string().nullable(),
    }),
    timeoutMs: z.number().int(),
    maxAttempts: z.number().int(),
    nextRunAt: z.iso.datetime().nullable(),
    lastRunAt: z.iso.datetime().nullable(),
    lastRunStatus: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Job');

export const RunSchema = z
  .object({
    id: z.string(),
    jobId: z.string(),
    trigger: z.enum(['schedule', 'manual']),
    status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']),
    scheduledFor: z.iso.datetime(),
    attempts: z.number().int(),
    maxAttempts: z.number().int(),
    nextAttemptAt: z.iso.datetime().nullable(),
    lastHttpStatus: z.number().int().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
  })
  .openapi('Run');

export const AttemptSchema = z
  .object({
    attempt: z.number().int(),
    startedAt: z.iso.datetime(),
    durationMs: z.number().int(),
    httpStatus: z.number().int().nullable(),
    responseSnippet: z.string().nullable(),
    errorKind: z.string().nullable(),
    error: z.string().nullable(),
    finalUrl: z.string().nullable(),
  })
  .openapi('Attempt');

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(200).optional(),
});

// ---- Monitors -------------------------------------------------------------------------------

export const AlertsSchema = z
  .object({
    webhookUrl: z.string().max(2048).nullable().default(null).openapi({
      description: 'Signed POST on monitor.down / monitor.up (same signature scheme as jobs).',
      example: 'https://ops.example.com/t2l-alerts',
    }),
    webhookUrl2: z
      .string()
      .max(2048)
      .nullable()
      .default(null)
      .openapi({
        description:
          'Optional independent secondary webhook, delivered separately — redundancy against one ' +
          'downstream endpoint being down.',
      }),
    telegram: z.boolean().default(false).openapi({
      description: 'Send alerts to the Telegram chat linked via POST /v1/account/telegram/link.',
    }),
    email: z
      .email()
      .max(254)
      .nullable()
      .default(null)
      .openapi({
        description:
          'Send alerts by email via an independent provider (different transport/infra from ' +
          'webhooks and Telegram). Requires email to be enabled on the server.',
        example: 'oncall@example.com',
      }),
  })
  .openapi('Alerts');

export const CreateMonitorSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 3600)
      .openapi({
        description: 'Expected maximum time between pings.',
        example: 300,
      }),
    graceSeconds: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 3600)
      .default(60),
    alerts: AlertsSchema.default({
      webhookUrl: null,
      webhookUrl2: null,
      telegram: false,
      email: null,
    }),
  })
  .openapi('CreateMonitor');

export const UpdateMonitorSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * 24 * 3600),
    graceSeconds: z
      .number()
      .int()
      .min(0)
      .max(7 * 24 * 3600),
    alerts: z
      .object({
        webhookUrl: z.string().max(2048).nullable(),
        webhookUrl2: z.string().max(2048).nullable(),
        telegram: z.boolean(),
        email: z.email().max(254).nullable(),
      })
      .partial(),
  })
  .partial()
  .openapi('UpdateMonitor');

export const MonitorSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(['new', 'alive', 'dead', 'paused']).openapi({
      description: 'new = never pinged; alive; dead = TTL + grace exceeded; paused.',
    }),
    ttlSeconds: z.number().int(),
    graceSeconds: z.number().int(),
    pingUrl: z.string().openapi({ description: 'POST here to report liveness (no auth needed).' }),
    lastPingAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    deadSince: z.iso.datetime().nullable(),
    alerts: z.object({
      webhookUrl: z.string().nullable(),
      webhookUrl2: z.string().nullable(),
      telegram: z.boolean(),
      email: z.string().nullable(),
    }),
    billing: z
      .object({
        plan: z.enum(['free', 'paid']),
        paidUntil: z.iso.datetime().nullable(),
      })
      .openapi({
        description:
          'free = within the tier allowance; paid = charged from credits every 30 days ' +
          '(paused with reason `unpaid` when the balance runs out).',
      }),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .openapi('Monitor');

export const MonitorEventSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    reason: z.enum(['ping', 'timeout', 'pause', 'resume', 'unpaid']),
    at: z.iso.datetime(),
  })
  .openapi('MonitorEvent');
