import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from '@hono/zod-openapi';
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import { extractPaymentFromMeta, MCP_PAYMENT_RESPONSE_META_KEY } from '@x402/mcp';
import { VERSION } from '../core/version.js';
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
} from '../core/x402.js';
import { AddressSchema, CreateJobSchema, CreateMonitorSchema, HexSchema } from './schemas.js';

/** Calls the REST API in-process (same auth, rate limits, idempotency and x402 handling). */
export type ApiFetch = (req: Request) => Promise<Response>;

export const MCP_INSTRUCTIONS = `time2live: cron/one-off webhook jobs and heartbeat monitors (dead man's switch) for autonomous agents.
1. Register with your EVM wallet: register_challenge → sign the returned message (EIP-191 personal_sign) → register. You get an API key (shown once).
2. Send it as "Authorization: Bearer t2l_…" on this MCP connection, or pass it as the apiKey argument.
3. create_heartbeat and POST its pingUrl (or the ping tool) more often than ttlSeconds; create_job to be woken up on a schedule.
Paid actions (over the free tier) return an x402 PaymentRequired result (USDC on Base); pay with an x402 MCP client, which retries with _meta["x402/payment"].`;

const apiKeyArg = z
  .string()
  .regex(/^t2l_/)
  .optional()
  .describe('API key, if not sent as an Authorization header on the MCP connection');
const idempotencyKeyArg = z
  .string()
  .min(1)
  .max(255)
  .optional()
  .describe('Makes retries safe: the same key returns the first result');
const idArg = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[0-9A-Za-z]{22}$`));

const text = (value: unknown, isError = false): CallToolResult => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
  ...(isError ? { isError: true } : {}),
});

interface CallOptions {
  body?: unknown;
  auth?: boolean;
  apiKey?: string;
  idempotencyKey?: string;
  meta?: Record<string, unknown>;
}

/**
 * Builds a per-request MCP server. Stateless: every HTTP request gets a fresh server and
 * transport, so nothing is kept between calls and any number of API processes could serve /mcp.
 */
export function createMcpServer(baseUrl: string, api: ApiFetch, bearer: string | undefined) {
  const server = new McpServer(
    { name: 'time2live', title: 'time2live', version: VERSION, websiteUrl: baseUrl },
    { instructions: MCP_INSTRUCTIONS },
  );

  async function call(
    method: string,
    path: string,
    opts: CallOptions = {},
  ): Promise<CallToolResult> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const key = opts.apiKey ? `Bearer ${opts.apiKey}` : bearer;
    if (opts.auth !== false) {
      if (!key) {
        return text(
          {
            error: {
              code: 'unauthorized',
              message:
                'No API key. Register first (register_challenge → register), then send ' +
                '"Authorization: Bearer t2l_…" on the MCP connection or pass apiKey.',
            },
          },
          true,
        );
      }
      headers.authorization = key;
    }
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    const payment = extractPaymentFromMeta({ name: path, _meta: opts.meta });
    if (payment) headers[PAYMENT_SIGNATURE_HEADER] = encodePaymentSignatureHeader(payment);

    const res = await api(
      new Request(new URL(path, baseUrl), {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      }),
    );
    const body: unknown = res.status === 204 ? { ok: true } : await res.json().catch(() => null);

    const required = res.headers.get(PAYMENT_REQUIRED_HEADER);
    if (res.status === 402 && required) {
      // x402 MCP transport: PaymentRequired as structuredContent + JSON text, isError.
      const paymentRequired = decodePaymentRequiredHeader(required);
      return {
        structuredContent: paymentRequired as unknown as Record<string, unknown>,
        content: [{ type: 'text', text: JSON.stringify(paymentRequired) }],
        isError: true,
      };
    }
    const result = text(body, !res.ok);
    const settled = res.headers.get(PAYMENT_RESPONSE_HEADER);
    if (settled) {
      result._meta = { [MCP_PAYMENT_RESPONSE_META_KEY]: decodePaymentResponseHeader(settled) };
    }
    return result;
  }

  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'register_challenge',
    {
      title: 'Start wallet registration',
      description:
        'Step 1 of registration/login: returns a Sign-In with Ethereum message. Sign it verbatim ' +
        '(EIP-191 personal_sign) with the wallet and call register within 10 minutes.',
      inputSchema: {
        address: AddressSchema,
        chainId: z.number().int().positive().default(8453),
      },
      annotations: { openWorldHint: false },
    },
    (args) => call('POST', '/v1/auth/challenge', { auth: false, body: args }),
  );

  server.registerTool(
    'register',
    {
      title: 'Finish wallet registration',
      description:
        'Step 2: submit the signed message. Creates the account on first use and returns a new ' +
        'API key (shown once — store it).',
      inputSchema: {
        message: z.string().min(1).max(4096),
        signature: HexSchema,
        keyName: z.string().trim().min(1).max(64).optional(),
      },
      annotations: { openWorldHint: false },
    },
    (args) => call('POST', '/v1/auth/verify', { auth: false, body: args }),
  );

  server.registerTool(
    'get_status',
    {
      title: 'Status',
      description:
        'Without arguments: account, tier limits, usage and credit balance. With monitorId: the ' +
        "monitor's state. With jobId: the job and its latest runs.",
      inputSchema: {
        monitorId: idArg('mon').optional(),
        jobId: idArg('job').optional(),
        apiKey: apiKeyArg,
      },
      annotations: readOnly,
    },
    async ({ monitorId, jobId, apiKey }) => {
      if (monitorId) return call('GET', `/v1/monitors/${monitorId}`, { apiKey });
      if (jobId) {
        const job = await call('GET', `/v1/jobs/${jobId}`, { apiKey });
        if (job.isError) return job;
        const runs = await call('GET', `/v1/jobs/${jobId}/runs?limit=5`, { apiKey });
        return { content: [...job.content, ...runs.content], isError: runs.isError };
      }
      return call('GET', '/v1/account', { apiKey });
    },
  );

  server.registerTool(
    'create_job',
    {
      title: 'Create a scheduled webhook job',
      description:
        'Calls target.url on a cron schedule or once at a given time, signed with T2L-Signature, ' +
        'with retries and backoff. Runs beyond the free allowance are paid from credits.',
      inputSchema: CreateJobSchema.extend({
        idempotencyKey: idempotencyKeyArg,
        apiKey: apiKeyArg,
      }),
      annotations: { openWorldHint: true },
    },
    ({ idempotencyKey, apiKey, ...job }, extra) =>
      call('POST', '/v1/jobs', { body: job, idempotencyKey, apiKey, meta: extra._meta }),
  );

  server.registerTool(
    'list_jobs',
    {
      title: 'List jobs',
      description: 'Lists jobs, newest first. Pass nextCursor back as cursor for the next page.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(200).optional(),
        apiKey: apiKeyArg,
      },
      annotations: readOnly,
    },
    ({ limit, cursor, apiKey }) =>
      call(
        'GET',
        `/v1/jobs?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        {
          apiKey,
        },
      ),
  );

  server.registerTool(
    'trigger_job',
    {
      title: 'Run a job now',
      description: 'Queues an immediate run outside the schedule (counts as a run).',
      inputSchema: { jobId: idArg('job'), idempotencyKey: idempotencyKeyArg, apiKey: apiKeyArg },
      annotations: { openWorldHint: true },
    },
    ({ jobId, idempotencyKey, apiKey }, extra) =>
      call('POST', `/v1/jobs/${jobId}/trigger`, {
        body: {},
        idempotencyKey,
        apiKey,
        meta: extra._meta,
      }),
  );

  server.registerTool(
    'delete_job',
    {
      title: 'Delete a job',
      description: 'Deletes a job and its run history.',
      inputSchema: { jobId: idArg('job'), apiKey: apiKeyArg },
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ jobId, apiKey }) => call('DELETE', `/v1/jobs/${jobId}`, { apiKey }),
  );

  server.registerTool(
    'create_heartbeat',
    {
      title: "Create a heartbeat monitor (dead man's switch)",
      description:
        'Returns a pingUrl. Ping it (plain POST, no key) more often than ttlSeconds; if no ping ' +
        'arrives within ttlSeconds + graceSeconds the monitor goes dead and alerts fire ' +
        '(signed webhook and/or Telegram).',
      inputSchema: CreateMonitorSchema.extend({
        idempotencyKey: idempotencyKeyArg,
        apiKey: apiKeyArg,
      }),
      annotations: { openWorldHint: false },
    },
    ({ idempotencyKey, apiKey, ...monitor }, extra) =>
      call('POST', '/v1/monitors', { body: monitor, idempotencyKey, apiKey, meta: extra._meta }),
  );

  server.registerTool(
    'list_monitors',
    {
      title: 'List heartbeat monitors',
      description: 'Lists monitors with their state, newest first.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(50),
        cursor: z.string().max(200).optional(),
        apiKey: apiKeyArg,
      },
      annotations: readOnly,
    },
    ({ limit, cursor, apiKey }) =>
      call(
        'GET',
        `/v1/monitors?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        { apiKey },
      ),
  );

  server.registerTool(
    'ping',
    {
      title: 'Ping a monitor',
      description:
        'Reports "I am alive" for a monitor. Needs no API key: the monitor id is the secret.',
      inputSchema: { monitorId: idArg('mon') },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    ({ monitorId }) => call('POST', `/v1/heartbeat/${monitorId}`, { auth: false }),
  );

  server.registerTool(
    'activate',
    {
      title: 'Activate the free tier ($0.10)',
      description: 'One-off x402 payment that raises the free tier to 3 monitors + 100 runs/month.',
      inputSchema: { apiKey: apiKeyArg },
      annotations: { idempotentHint: true, openWorldHint: false },
    },
    ({ apiKey }, extra) =>
      call('POST', '/v1/billing/activate', { body: {}, apiKey, meta: extra._meta }),
  );

  server.registerTool(
    'buy_credits',
    {
      title: 'Buy prepaid credits',
      description:
        'x402 payment for a $1, $5 or $20 credit pack. Credits pay for runs beyond the free ' +
        'allowance ($0.0005 each) and extra monitors ($0.25 per 30 days).',
      inputSchema: {
        pack: z.union([z.literal(1), z.literal(5), z.literal(20)]).default(1),
        apiKey: apiKeyArg,
      },
      annotations: { openWorldHint: false },
    },
    ({ pack, apiKey }, extra) =>
      call('POST', '/v1/billing/credits', { body: { pack }, apiKey, meta: extra._meta }),
  );

  return server;
}

/** Handles one Streamable HTTP request (stateless, JSON responses). */
export async function handleMcpRequest(req: Request, baseUrl: string, api: ApiFetch) {
  const server = createMcpServer(baseUrl, api, req.headers.get('authorization') ?? undefined);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    await transport.close();
    await server.close();
  }
}
