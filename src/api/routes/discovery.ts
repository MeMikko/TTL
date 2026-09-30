import { Hono, type Context } from 'hono';
import { PRICES, TIERS, usd } from '../../core/plans.js';
import { VERSION } from '../../core/version.js';
import type { AppDeps, AppEnv } from '../context.js';
import { MCP_INSTRUCTIONS } from '../mcp.js';

type ToolList = Array<{
  name: string;
  title?: string;
  description?: string;
  annotations?: unknown;
}>;

/**
 * Discovery for agents: GET / (service summary), GET /llms.txt (llmstxt.org), and an MCP Server
 * Card at /.well-known/mcp/server-card.json (SEP-1649; /.well-known/mcp.json is an alias).
 * `listTools` asks the MCP server itself, so the card always matches the real tool surface.
 */
export function discoveryRoutes(deps: AppDeps, listTools: () => Promise<ToolList>) {
  const base = deps.config.PUBLIC_BASE_URL.replace(/\/$/, '');
  const x402 = deps.config.X402_ENABLED
    ? { enabled: true, network: deps.config.X402_NETWORK, asset: 'USDC' }
    : { enabled: false };
  // The on-chain switch is advertised once the factory is deployed and configured.
  const onChain = deps.config.KEEPER_FACTORY_ADDRESS
    ? {
        chainId: deps.config.KEEPER_CHAIN_ID,
        factory: deps.config.KEEPER_FACTORY_ADDRESS,
        keeper: deps.config.KEEPER_ENABLED,
      }
    : null;
  const app = new Hono<AppEnv>();
  const cache = 'public, max-age=300';

  app.get('/', (c) => {
    c.header('cache-control', cache);
    return c.json({
      name: 'time2live',
      description:
        'Scheduling and liveness (TTL) service for autonomous AI agents: cron/one-off webhook ' +
        "jobs and heartbeat monitors (dead man's switch). Register with an EVM wallet, pay with x402.",
      version: VERSION,
      links: {
        openapi: `${base}/openapi.json`,
        llms: `${base}/llms.txt`,
        mcp: `${base}/mcp`,
        mcpServerCard: `${base}/.well-known/mcp/server-card.json`,
        health: `${base}/healthz`,
      },
      x402,
      deadMansSwitchContract: onChain,
    });
  });

  app.get('/llms.txt', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/markdown; charset=utf-8');
    return c.body(
      llmsTxt(base, deps.config.X402_ENABLED ? deps.config.X402_NETWORK : null, onChain),
    );
  });

  let tools: Promise<ToolList> | undefined;
  const card = async (c: Context<AppEnv>) => {
    tools ??= listTools().catch((err: unknown) => {
      tools = undefined;
      throw err;
    });
    c.header('cache-control', cache);
    c.header('access-control-allow-origin', '*');
    return c.json({
      name: 'xyz.time2live/time2live',
      title: 'time2live',
      description:
        "Cron/one-off webhook jobs and heartbeat monitors (dead man's switch) for autonomous " +
        'agents. Wallet sign-in, x402 payments.',
      version: VERSION,
      websiteUrl: base,
      supportedProtocolVersions: ['2025-06-18', '2025-03-26'],
      remotes: [
        {
          type: 'streamable-http',
          url: `${base}/mcp`,
          sessionMode: 'stateless',
          headers: [
            {
              name: 'Authorization',
              description:
                'Bearer t2l_… API key. Optional: register_challenge, register and ping work ' +
                'without it; other tools also accept an apiKey argument.',
              isRequired: false,
              isSecret: true,
            },
          ],
        },
      ],
      capabilities: { tools: { listChanged: false } },
      instructions: MCP_INSTRUCTIONS,
      tools: (await tools).map(({ name, title, description, annotations }) => ({
        name,
        title,
        description,
        annotations,
      })),
      _meta: { 'xyz.time2live/openapi': `${base}/openapi.json`, 'xyz.time2live/x402': x402 },
    });
  };
  app.get('/.well-known/mcp/server-card.json', card);
  app.get('/.well-known/mcp.json', card);

  return app;
}

function llmsTxt(
  base: string,
  network: string | null,
  onChain: { chainId: number; factory: string; keeper: boolean } | null,
): string {
  const contract = onChain
    ? `
## On-chain dead man's switch (Base, chain ${onChain.chainId})

For funds, not just alerts: \`DeadMansSwitchFactory\` at \`${onChain.factory}\`. \`createSwitch(agent, beneficiary, ttl, tokens[], salt)\` (payable) deploys your own switch holding ETH and up to 20 ERC-20s. The agent or owner calls \`ping()\` at least every \`ttl\` seconds (1 h – 365 d); after the deadline anyone can call \`trigger()\` and everything goes to the beneficiary.${onChain.keeper ? ' Our keeper calls `trigger()` automatically.' : ''} Before the deadline only the owner can withdraw; after it, nobody can stop the transfer.
`
    : '';
  const free = TIERS.free;
  const unactivated = TIERS.unactivated;
  return `# time2live

> Scheduling and liveness (TTL) service for autonomous AI agents. Cron or one-off HTTP webhook jobs (signed, retried) and heartbeat monitors — a dead man's switch that alerts by webhook or Telegram when an agent stops pinging. Agents register with an EVM wallet and pay with x402 (USDC on Base); no human account needed.

Base URL: ${base}. JSON over HTTPS; errors are \`{"error":{"code","message"}}\`. Auth: \`Authorization: Bearer t2l_…\`. Every create call accepts \`Idempotency-Key\`.

## Quickstart (curl)

1. \`POST /v1/auth/challenge\` \`{"address":"0x…","chainId":8453}\` → \`message\`
2. Sign \`message\` verbatim with the wallet (EIP-191 personal_sign; smart wallets via ERC-1271/6492 work).
3. \`POST /v1/auth/verify\` \`{"message","signature"}\` → \`apiKey.key\` (shown once).
4. Heartbeat: \`POST /v1/monitors\` \`{"name":"agent-1","ttlSeconds":300}\` → \`pingUrl\`; then \`curl -fsS -X POST <pingUrl>\` more often than every 300 s. Missing pings → \`monitor.down\` alert.
5. Job: \`POST /v1/jobs\` \`{"name":"wake","schedule":{"type":"cron","expression":"*/15 * * * *"},"target":{"url":"https://agent.example.com/wake"}}\`. Deliveries carry \`T2L-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">\`; the secret comes from \`GET /v1/account/webhook-secret\`.

## MCP

- [Remote MCP server](${base}/mcp): Streamable HTTP, stateless. Tools: register_challenge, register, get_status, create_job, list_jobs, trigger_job, delete_job, create_heartbeat, list_monitors, ping, activate, buy_credits.
- [Server card](${base}/.well-known/mcp/server-card.json)
- Client config: \`{"mcpServers":{"time2live":{"type":"http","url":"${base}/mcp","headers":{"Authorization":"Bearer t2l_…"}}}}\`

## Pricing (x402${network ? `, ${network}` : ', currently disabled'})

- Unactivated: ${unactivated.monitors} monitor + ${unactivated.runsPerMonth} runs/month. Activation ${usd(PRICES.activationMicro)} once → ${free.monitors} monitors + ${free.runsPerMonth} runs/month.
- Beyond that, from prepaid credits: ${usd(PRICES.runMicro)} per run, ${usd(PRICES.monitorMonthMicro)} per extra monitor per 30 days. Packs: ${PRICES.packs.map((p) => `$${p}`).join(', ')}.
- A call that needs payment returns \`402\` with a \`PAYMENT-REQUIRED\` header (x402 v2). Pay with an x402 client and retry the same request with \`PAYMENT-SIGNATURE\`; the receipt is in \`PAYMENT-RESPONSE\`. Over MCP the tool result carries PaymentRequired and the client retries with \`_meta["x402/payment"]\`.

${contract}
## API reference

- [OpenAPI 3.1](${base}/openapi.json): every endpoint, schema and error.
- [Health](${base}/healthz): \`?deep=1\` also checks the database and worker.

## Optional

- Monitor states: new → alive → dead (after ttlSeconds + graceSeconds without a ping) → alive; paused. Alerts: monitor.down, monitor.up, monitor.unpaid.
- Job targets must be public HTTPS (private, loopback and metadata addresses are blocked, also after DNS resolution); redirects are not followed. Retries with exponential backoff; history kept 30 days.
`;
}
