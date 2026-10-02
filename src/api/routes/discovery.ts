import { Hono, type Context } from 'hono';
import { networkInfo, type NetworkInfo } from '../../core/network.js';
import { PRICES, TIERS, usd } from '../../core/plans.js';
import { createReceiptSigner } from '../../core/receipts.js';
import { VERSION } from '../../core/version.js';
import type { AppDeps, AppEnv } from '../context.js';
import { MCP_INSTRUCTIONS } from '../mcp.js';

type ToolList = Array<{
  name: string;
  title?: string;
  description?: string;
  annotations?: unknown;
}>;

/** Hostname of a base URL, for building e.g. a security.txt contact address. */
function host(base: string): string {
  try {
    return new URL(base).hostname;
  } catch {
    return 'time2live.xyz';
  }
}

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
  const net = networkInfo(deps.config);
  const sandbox = deps.config.SANDBOX;
  const sandboxTtlDays = Math.round(deps.config.SANDBOX_DATA_TTL_HOURS / 24);
  const sandboxNote = `Sandbox: a public testnet instance for development only — no uptime guarantee, and all data is wiped on a rolling ${sandboxTtlDays}-day TTL. Do not use for production workloads.`;
  const sandboxArg: SandboxInfo = sandbox ? { note: sandboxNote, ttlDays: sandboxTtlDays } : null;
  const receiptSigner = createReceiptSigner(deps.config.ENCRYPTION_KEY);
  const app = new Hono<AppEnv>();
  const cache = 'public, max-age=300';
  // Shorter cache for the human/agent entry points, so a testnet→mainnet flip is visible quickly.
  const shortCache = 'public, max-age=60';

  const summary = {
    name: 'time2live',
    description:
      'Scheduling and liveness (TTL) service for autonomous AI agents: cron/one-off webhook ' +
      "jobs and heartbeat monitors (dead man's switch). Register with an EVM wallet, pay with x402.",
    version: VERSION,
    // Prominent trust signal: is this a live (real-money) or a testnet deployment?
    network: { mode: net.mode, label: net.label, chain: net.chain },
    // A sandbox is a public testnet instance with a rolling data wipe — never production.
    sandbox: sandbox ? { enabled: true, dataTtlDays: sandboxTtlDays, note: sandboxNote } : false,
    links: {
      openapi: `${base}/openapi.json`,
      llms: `${base}/llms.txt`,
      mcp: `${base}/mcp`,
      mcpServerCard: `${base}/.well-known/mcp/server-card.json`,
      health: `${base}/healthz`,
      dashboard: `${base}/dashboard`,
      terms: `${base}/terms`,
      privacy: `${base}/privacy`,
      status: `${base}/status`,
      security: `${base}/.well-known/security.txt`,
      x402: `${base}/.well-known/x402`,
      receiptKey: `${base}/.well-known/time2live-receipts.json`,
      source: 'https://github.com/MeMikko/TTL',
      x: 'https://x.com/t2lxyz',
    },
    x402,
    deadMansSwitchContract: onChain,
  };

  // Content negotiation: browsers get the landing page, agents and curl keep the JSON summary.
  // The JSON at `/` is the discovery contract, so it must stay byte-for-byte for non-HTML clients.
  app.get('/', (c) => {
    c.header('cache-control', shortCache);
    if ((c.req.header('accept') ?? '').includes('text/html')) {
      c.header('content-type', 'text/html; charset=utf-8');
      return c.body(landingHtml(base, net, onChain, sandboxArg));
    }
    return c.json(summary);
  });

  app.get('/llms.txt', (c) => {
    c.header('cache-control', shortCache);
    c.header('content-type', 'text/markdown; charset=utf-8');
    return c.body(llmsTxt(base, net, onChain, sandboxArg));
  });

  // Trust & discoverability surfaces (reviewers and crawlers expect these).
  app.get('/terms', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(legalHtml(base, net, 'terms'));
  });

  app.get('/privacy', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(legalHtml(base, net, 'privacy'));
  });

  app.get('/status', (c) => {
    c.header('cache-control', shortCache);
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(statusHtml(base, net));
  });

  app.get('/robots.txt', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/plain; charset=utf-8');
    return c.body(
      [
        'User-agent: *',
        'Allow: /',
        'Disallow: /dashboard',
        'Disallow: /analytics',
        `Sitemap: ${base}/sitemap.xml`,
        '',
      ].join('\n'),
    );
  });

  app.get('/sitemap.xml', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'application/xml; charset=utf-8');
    const urls = ['/', '/llms.txt', '/openapi.json', '/terms', '/privacy', '/status'];
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      urls.map((u) => `  <url><loc>${base}${u === '/' ? '/' : u}</loc></url>`).join('\n') +
      '\n</urlset>\n';
    return c.body(body);
  });

  app.get('/.well-known/security.txt', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/plain; charset=utf-8');
    // Expires: RFC 9116 requires a future expiry; one year out, refreshed on each request.
    const expires = new Date(Date.now() + 365 * 86_400_000).toISOString();
    return c.body(
      [
        `Contact: mailto:security@${host(base)}`,
        `Expires: ${expires}`,
        'Preferred-Languages: en, fi',
        `Canonical: ${base}/.well-known/security.txt`,
        `Policy: ${base}/terms`,
        '',
      ].join('\n'),
    );
  });

  app.get('/.well-known/time2live-receipts.json', (c) => {
    c.header('cache-control', cache);
    c.header('access-control-allow-origin', '*');
    return c.json({
      alg: 'Ed25519',
      keyId: receiptSigner.keyId,
      publicKey: receiptSigner.publicKeyB64, // base64, raw 32-byte Ed25519 public key
      canonicalization: 'JSON with object keys sorted recursively and no insignificant whitespace',
      verify:
        'ed25519_verify(publicKey, utf8(canonical(receipt)), base64_decode(signature.value)); receipt is signed at GET /v1/monitors/{id}/receipt',
      docs: `${base}/llms.txt`,
    });
  });

  app.get('/.well-known/x402', (c) => {
    c.header('cache-control', shortCache);
    c.header('access-control-allow-origin', '*');
    return c.json({
      x402Version: 2,
      ...x402,
      payTo: deps.config.X402_PAY_TO ?? null,
      facilitator: deps.config.X402_FACILITATOR_URL,
      pricing: {
        activation: usd(PRICES.activationMicro),
        perRun: usd(PRICES.runMicro),
        perMonitorMonth: usd(PRICES.monitorMonthMicro),
        packs: PRICES.packs.map((p) => `$${p}`),
      },
      docs: `${base}/llms.txt`,
    });
  });

  // Human operator dashboard: sign in with the wallet, view the fleet read-only, emergency stop.
  app.get('/dashboard', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(dashboardHtml(base, net));
  });

  // Real-time analytics (operator-gated at the data endpoint): fleet-wide, live service stats.
  app.get('/analytics', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(analyticsHtml(base, net));
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

type SandboxInfo = { note: string; ttlDays: number } | null;

function llmsTxt(
  base: string,
  net: NetworkInfo,
  onChain: { chainId: number; factory: string; keeper: boolean } | null,
  sandbox: SandboxInfo,
): string {
  const network = net.x402Network;
  const contract = onChain
    ? `
## On-chain dead man's switch (Base, chain ${onChain.chainId})

For funds, not just alerts: \`DeadMansSwitchFactory\` at \`${onChain.factory}\`. \`createSwitch(agent, beneficiary, ttl, tokens[], salt)\` (payable) deploys your own switch holding ETH and up to 20 ERC-20s. The agent or owner calls \`ping()\` at least every \`ttl\` seconds (1 h – 365 d); after the deadline anyone can call \`trigger()\` and everything goes to the beneficiary.${onChain.keeper ? ' Our keeper calls `trigger()` automatically.' : ''} Before the deadline only the owner can withdraw; after it, nobody can stop the transfer. The owner can change the beneficiary while the switch is live; once the deadline passes it is locked. **The contract is unaudited** — read the verified source on the block explorer before depositing.
`
    : '';
  const free = TIERS.free;
  const unactivated = TIERS.unactivated;
  return `# time2live

> Scheduling and liveness (TTL) service for autonomous AI agents. Cron or one-off HTTP webhook jobs (signed, retried) and heartbeat monitors — a dead man's switch that alerts by webhook or Telegram when an agent stops pinging. Agents register with an EVM wallet and pay with x402 (USDC on Base); no human account needed.

**Network: ${net.label}.**
${sandbox ? `\n**⚠ Sandbox.** ${sandbox.note} Payments use testnet USDC, so the x402 path works end to end but costs nothing real.\n` : ''}
**Open source (AGPL-3.0):** the full codebase — API, worker/keeper and the on-chain contracts — is public at https://github.com/MeMikko/TTL. The deployed contract is verifiable against the tagged source (\`audit-v1\`); the contract is unaudited (packet at \`contracts/audit/SCOPE.md\`, auditor being engaged). Self-host or run a Base Sepolia testnet instance from \`docs/OPERATIONS.md\` (§8d). Follow updates at https://x.com/t2lxyz.

Base URL: ${base}. JSON over HTTPS; errors are \`{"error":{"code","message"}}\`. Auth: \`Authorization: Bearer t2l_…\`. Every create call accepts \`Idempotency-Key\`.

**Rate limits:** requests are limited per client IP and per API key; the limit, remaining and reset are returned in the response headers, and an over-limit call returns \`429\` with \`Retry-After\`. Auth endpoints have a tighter per-IP limit.

**Sign-in chain:** \`chainId\` in the challenge is the EIP-4361 chain that binds the signature. It is **independent of the x402 payment network** — sign in with any accepted Base chain (8453 mainnet or 84532 Sepolia); payment always settles on this instance's configured network (see **Network** above).

## Quickstart (curl)

1. \`POST /v1/auth/challenge\` \`{"address":"0x…","chainId":8453}\` → \`message\` (chainId: 8453 or 84532)
2. Sign \`message\` verbatim with the wallet (EIP-191 personal_sign; smart wallets via ERC-1271/6492 work).
3. \`POST /v1/auth/verify\` \`{"message","signature"}\` → \`apiKey.key\` (shown once).
4. Heartbeat: \`POST /v1/monitors\` \`{"name":"agent-1","ttlSeconds":300}\` → \`pingUrl\`; then \`curl -fsS -X POST <pingUrl>\` more often than every 300 s. Missing pings → \`monitor.down\` alert.
5. Job: \`POST /v1/jobs\` \`{"name":"wake","schedule":{"type":"cron","expression":"*/15 * * * *"},"target":{"url":"https://agent.example.com/wake"}}\`. Deliveries carry \`T2L-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">\`; the secret comes from \`GET /v1/account/webhook-secret\`.

## Webhooks & signatures

- Every delivery is signed: \`T2L-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "\${t}.\${rawBody}")>\`. Verify against the raw body, and **reject timestamps older than 5 minutes** to stop replays.
- Get the secret with \`GET /v1/account/webhook-secret\`; rotate it with \`POST /v1/account/webhook-secret/rotate\` (effective immediately — the old secret stops validating).
- Delivery is **at-least-once**: retried with exponential backoff on failure, so make your handler idempotent (each run has a stable id). Every delivery carries \`T2L-Delivery-Id\` (stable across retries — dedupe on it), \`T2L-Attempt\`, and \`T2L-Scheduled-For\` (the slot's ISO time). Targets must be public HTTPS; redirects are not followed and private/loopback/metadata addresses are blocked, also after DNS resolution.
- **Missed slots after downtime are collapsed, not replayed:** at most one catch-up run per job fires, then the schedule jumps to the next future slot — never a backlog burst. Set \`freshnessSeconds\` on a job to drop even that one catch-up when its slot is older than the cutoff (recorded \`skipped\`, not delivered); omit it to deliver regardless of lateness. You can also gate client-side on \`T2L-Scheduled-For\`.
- Lost or leaked an API key? \`POST /v1/account/keys/revoke-all\` cuts every key at once (the wallet operator session keeps working).

## Liveness receipts

- \`GET /v1/monitors/{id}/receipt\` returns a **server-signed (Ed25519) liveness receipt**: a portable attestation an agent can hand to a third party to *prove* its state rather than pointing at a dashboard. It records the schedule id, last heartbeat + success hash, the missed-window rule, the stop/alert action, and — crucially — distinguishes \`halted_by_operator\` (paused on purpose) from \`missed_window\` (went silent).
- It also carries **custody, not just decay**: \`nextAllowedAction\` lists, for the current liveness, who may restart/pause/escalate and the proof they need. A \`halted_by_operator\` monitor is the operator's to resume (a ping records the time but does not un-halt it); a \`missed_window\` one re-arms on the next heartbeat (the secret ping URL, or a passing active probe); escalation is always automatic on a miss to the stopAction channels.
- Verify offline: Ed25519 over the canonical JSON of \`receipt\` (object keys sorted recursively, no whitespace), against the public key at [\`/.well-known/time2live-receipts.json\`](${base}/.well-known/time2live-receipts.json).

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
- Monitor modes: \`heartbeat\` (default — your agent pushes pings) or \`active\` — we probe your own URL from the outside every \`check.intervalSeconds\`, and a 2xx counts as the ping. Active checks travel the same path a real request does, so a process can't report healthy from inside while its front door is closed. Create with \`{"mode":"active","check":{"url":"https://you/health","intervalSeconds":60},"ttlSeconds":300}\`.
- Job targets must be public HTTPS (private, loopback and metadata addresses are blocked, also after DNS resolution); redirects are not followed. Retries with exponential backoff; history kept 30 days.
`;
}

function landingHtml(
  base: string,
  net: NetworkInfo,
  onChain: { chainId: number; factory: string; keeper: boolean } | null,
  sandbox: SandboxInfo,
): string {
  const activation = usd(PRICES.activationMicro);
  const run = usd(PRICES.runMicro);
  const monitor = usd(PRICES.monitorMonthMicro);
  const packs = PRICES.packs.map((p) => `$${p}`).join(' · ');
  const free = TIERS.free;
  const unactivated = TIERS.unactivated;
  const x402Line = net.x402Network
    ? `${net.mode === 'live' ? 'Live on' : 'Testnet —'} <code>${net.x402Network}</code>`
    : 'Payments disabled on this instance';
  const badge =
    net.mode === 'live'
      ? '<span class="badge live">● Live · Base mainnet</span>'
      : net.mode === 'test'
        ? `<span class="badge test">● Testnet · ${net.chain}</span>`
        : '<span class="badge test">● Free / evaluation</span>';
  const contractCard = onChain
    ? `<div class="card">
        <h3><span class="dot"></span>On-chain switch</h3>
        <p>For funds, not just alerts. A Solidity dead man's switch on Base holds ETH and up to 20
        ERC-20s; after the deadline <strong>anyone</strong> can trigger it and everything goes to the
        beneficiary.</p>
        <p class="mono small">factory ${onChain.factory}<br>chain ${onChain.chainId}${onChain.keeper ? ' · keeper on' : ''}</p>
        <p class="small dim">⚠ Unaudited — verified source on the explorer; review it before depositing.</p>
      </div>`
    : '';

  // All interpolated values come from our own config, so no user input reaches this template.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>time2live — TTL &amp; scheduling for AI agents</title>
<meta name="description" content="Scheduling and liveness (TTL) service for autonomous AI agents: cron/one-off webhook jobs and heartbeat monitors (dead man's switch). Wallet sign-in, x402 payments, remote MCP server.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230a0e14'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%2335d07f'/%3E%3C/svg%3E">
<meta property="og:type" content="website">
<meta property="og:site_name" content="time2live">
<meta property="og:title" content="time2live — TTL &amp; scheduling for AI agents">
<meta property="og:description" content="Cron and one-off webhook jobs, heartbeat monitors (dead man's switch), and an on-chain switch. Wallet sign-in, x402 payments, MCP.">
<meta property="og:url" content="${base}/">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="time2live — TTL &amp; scheduling for AI agents">
<meta name="twitter:description" content="Scheduling and liveness for autonomous AI agents. Wallet sign-in, x402 payments, remote MCP server.">
<style>
  :root {
    --bg: #0a0e14; --panel: #111823; --line: #1e2a3a; --fg: #d7e0ea; --dim: #7d8ea3;
    --accent: #35d07f; --amber: #f0b429; --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.65 var(--mono);
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code { color: var(--amber); overflow-wrap: anywhere; }
  .wrap { max-width: 820px; margin: 0 auto; padding: 0 clamp(16px, 4vw, 24px); }
  header { padding: clamp(40px, 9vw, 72px) 0 clamp(30px, 6vw, 48px); border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; font-size: clamp(23px, 6.5vw, 30px); font-weight: 600; letter-spacing: -0.5px; }
  .pulse {
    width: 12px; height: 12px; border-radius: 50%; background: var(--accent);
    box-shadow: 0 0 0 0 rgba(53,208,127,.6); animation: pulse 2.4s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(53,208,127,.5); }
    70% { box-shadow: 0 0 0 12px rgba(53,208,127,0); }
    100% { box-shadow: 0 0 0 0 rgba(53,208,127,0); }
  }
  @media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
  .tag { margin: 20px 0 0; font-size: clamp(15px, 3.4vw, 17px); color: var(--fg); max-width: 60ch; }
  .sub { margin: 10px 0 0; color: var(--dim); }
  .badge { display: inline-block; margin-left: 0; padding: 2px 10px; border-radius: 20px; font-size: 12px; border: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
  .badge.live { color: var(--accent); border-color: var(--accent); }
  .badge.test { color: var(--amber); border-color: var(--amber); }
  .topbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 12px; }
  .eye { margin-left: auto; color: var(--dim); border: 1px solid var(--line); padding: 6px 12px; border-radius: 8px; font-size: 13px; white-space: nowrap; }
  .eye:hover { border-color: var(--accent); color: var(--accent); text-decoration: none; }
  .cta { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 10px; }
  .btn {
    border: 1px solid var(--line); background: var(--panel); color: var(--fg);
    padding: 9px 16px; border-radius: 8px; font-size: 14px;
  }
  .btn:hover { border-color: var(--accent); text-decoration: none; }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  section { padding: clamp(32px, 7vw, 48px) 0; border-bottom: 1px solid var(--line); }
  h2 { font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--dim); margin: 0 0 22px; }
  h3 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); display: inline-block; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
  .card p { margin: 0 0 8px; color: var(--fg); }
  .small { font-size: 12.5px; }
  .mono { overflow-wrap: anywhere; }
  .dim { color: var(--dim); }
  pre {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: clamp(13px, 3vw, 16px) clamp(14px, 3.5vw, 18px); overflow-x: auto;
    font-size: clamp(12px, 2.7vw, 13px); line-height: 1.7; margin: 0 0 14px;
  }
  pre .c { color: var(--dim); }
  .tablewrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  td, th { text-align: left; padding: 9px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--dim); font-weight: 500; }
  td.price { color: var(--amber); white-space: nowrap; }
  footer { padding: 40px 0 64px; color: var(--dim); font-size: 13px; display: flex; flex-wrap: wrap; gap: 6px 18px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="topbar">
      <div class="brand"><span class="pulse" aria-hidden="true"></span>time2live${badge}</div>
      <a class="eye" href="${base}/dashboard" title="Operator dashboard">👁 for human eyes</a>
    </div>
    <p class="tag">Scheduling and liveness for autonomous AI agents. Cron and one-off webhook jobs,
    and heartbeat monitors — a <strong>dead man's switch</strong> that alerts when an agent goes
    silent.</p>
    <p class="sub">Agents register with an EVM wallet and pay with x402. No human account, no
    dashboard, no card. <strong>Fully open source</strong> (AGPL-3.0) — read exactly what runs and
    verify the contract against the source.</p>
    ${sandbox ? `<p class="sub"><strong>⚠ Sandbox (testnet).</strong> ${sandbox.note}</p>` : ''}
    <div class="cta">
      <a class="btn primary" href="${base}/llms.txt">Agent guide → /llms.txt</a>
      <a class="btn" href="${base}/openapi.json">OpenAPI</a>
      <a class="btn" href="${base}/mcp">MCP endpoint</a>
      <a class="btn" href="https://github.com/MeMikko/TTL">Source ↗</a>
    </div>
  </header>

  <section>
    <h2>What it does</h2>
    <div class="grid">
      <div class="card">
        <h3><span class="dot"></span>Scheduled jobs</h3>
        <p>Cron or one-off HTTP calls to your agent, HMAC-signed and retried with backoff. Full
        run history, SSRF-guarded targets.</p>
      </div>
      <div class="card">
        <h3><span class="dot"></span>Heartbeat monitors</h3>
        <p>Your agent pings a URL on a schedule. Miss the window and time2live fires a
        <code>monitor.down</code> alert by webhook or Telegram.</p>
      </div>
      <div class="card">
        <h3><span class="dot"></span>Built for agents</h3>
        <p>Remote MCP server and a compact <a href="${base}/llms.txt">/llms.txt</a>. Wallet
        sign-in (SIWE), idempotency keys, rate limits.</p>
      </div>
      ${contractCard || `<div class="card"><h3><span class="dot"></span>Open &amp; discoverable</h3><p>OpenAPI 3.1, an MCP Server Card at <code>/.well-known/mcp.json</code>, and a JSON summary at this same URL for machines.</p></div>`}
    </div>
  </section>

  <section>
    <h2>For agents</h2>
    <pre><span class="c"># 1. get a challenge, sign it with your wallet, exchange for an API key</span>
curl -sX POST ${base}/v1/auth/challenge -d '{"address":"0x…","chainId":8453}'
curl -sX POST ${base}/v1/auth/verify   -d '{"message":"…","signature":"0x…"}'

<span class="c"># 2. create a dead man's switch and keep it alive</span>
curl -sX POST ${base}/v1/monitors -H "Authorization: Bearer t2l_…" \\
  -d '{"name":"agent-1","ttlSeconds":300}'          <span class="c"># → returns pingUrl</span>
curl -fsS -X POST ${base}/v1/heartbeat/mon_…         <span class="c"># ping before it expires</span></pre>
    <p class="small dim">Prefer tools? Point any MCP client at <code>${base}/mcp</code>
    (Streamable HTTP): <code>{"mcpServers":{"time2live":{"type":"http","url":"${base}/mcp"}}}</code>.
    An agent with no key can call <code>register_challenge</code> → <code>register</code> itself.</p>
  </section>

  <section>
    <h2>Pricing · ${x402Line}</h2>
    <div class="tablewrap">
    <table>
      <tr><th>Tier / action</th><th>What you get</th><th>Price</th></tr>
      <tr><td>Free (unactivated)</td><td>${unactivated.monitors} monitor · ${unactivated.runsPerMonth} runs/month</td><td class="price">$0</td></tr>
      <tr><td>Activation (one-off)</td><td>${free.monitors} monitors · ${free.runsPerMonth} runs/month</td><td class="price">${activation}</td></tr>
      <tr><td>Extra run</td><td>beyond the monthly free allowance</td><td class="price">${run}</td></tr>
      <tr><td>Extra monitor</td><td>per 30 days, from credits</td><td class="price">${monitor}</td></tr>
      <tr><td>Credit packs</td><td>prepaid, USDC on Base</td><td class="price">${packs}</td></tr>
    </table>
    </div>
    <p class="small dim">Over-quota calls answer <code>402</code> with an x402 <code>PAYMENT-REQUIRED</code>
    challenge; pay and retry the same request. One round trip, no human.</p>
  </section>

  <footer>
    <span>time2live</span>
    <a href="${base}/healthz">status</a>
    <a href="${base}/openapi.json">api</a>
    <a href="${base}/llms.txt">llms.txt</a>
    <a href="${base}/mcp">mcp</a>
    <a href="${base}/dashboard">operator</a>
    <a href="${base}/analytics">analytics</a>
    <a href="https://github.com/MeMikko/TTL">source</a>
    <a href="https://x.com/t2lxyz">x</a>
    <a href="https://x402.org">x402</a>
  </footer>
</div>
</body>
</html>
`;
}

function dashboardHtml(base: string, net: NetworkInfo): string {
  const badge =
    net.mode === 'live'
      ? '<span class="netbadge live">● Live · Base mainnet</span>'
      : net.mode === 'test'
        ? `<span class="netbadge test">● Testnet · ${net.chain}</span>`
        : '<span class="netbadge test">● Free / eval</span>';
  // Only `base` is interpolated (our own config). All account data is rendered client-side with
  // textContent, so monitor/job names cannot inject markup.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>time2live — operator</title>
<meta name="robots" content="noindex">
<style>
  :root {
    --bg:#0a0e14; --panel:#111823; --line:#1e2a3a; --fg:#d7e0ea; --dim:#7d8ea3;
    --accent:#35d07f; --red:#ff5c5c; --amber:#f0b429;
    --mono: ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 var(--mono);-webkit-font-smoothing:antialiased}
  .wrap{max-width:900px;margin:0 auto;padding:0 clamp(14px,4vw,24px)}
  header{padding:clamp(24px,6vw,36px) 0 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px 12px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;font-size:clamp(17px,4.6vw,20px);font-weight:600}
  .pulse{width:10px;height:10px;border-radius:50%;background:var(--accent);animation:pulse 2.4s infinite}
  .netbadge{margin-left:10px;padding:2px 10px;border-radius:20px;font-size:12px;border:1px solid var(--line);font-weight:400}
  .netbadge.live{color:var(--accent);border-color:var(--accent)}
  .netbadge.test{color:var(--amber);border-color:var(--amber)}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(53,208,127,.5)}70%{box-shadow:0 0 0 10px rgba(53,208,127,0)}100%{box-shadow:0 0 0 0 rgba(53,208,127,0)}}
  @media (prefers-reduced-motion:reduce){.pulse{animation:none}}
  .grow{flex:1}
  a{color:var(--accent);text-decoration:none}
  button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--fg);padding:8px 14px;border-radius:8px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button.danger:hover{border-color:var(--red);color:var(--red)}
  button:disabled{opacity:.5;cursor:default}
  section{padding:22px 0;border-bottom:1px solid var(--line)}
  h2{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim);margin:0 0 14px}
  .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px}
  .stat .k{color:var(--dim);font-size:12px}
  .stat .v{font-size:18px;margin-top:2px}
  .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
  th{color:var(--dim);font-weight:500}
  .pill{padding:1px 8px;border-radius:20px;font-size:12px;border:1px solid var(--line)}
  .s-alive,.s-active{color:var(--accent);border-color:var(--accent)}
  .s-dead{color:var(--red);border-color:var(--red)}
  .s-paused,.s-new,.s-completed{color:var(--dim)}
  .muted{color:var(--dim)}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
  .actions button{flex:1 1 auto}
  #err{color:var(--red);min-height:18px;margin:10px 0;overflow-wrap:anywhere}
  .hide{display:none}
  input{font:inherit;background:var(--panel);border:1px solid var(--line);color:var(--fg);padding:8px 12px;border-radius:8px;width:100%;max-width:320px}
  @media(min-width:560px){.actions button{flex:0 0 auto}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="pulse"></span>
    <div class="brand">time2live<span class="muted" style="font-weight:400">/ operator</span>${badge}</div>
    <div class="grow"></div>
    <a href="${base}/analytics" class="muted" style="font-size:13px">analytics →</a>
    <span id="who" class="muted"></span>
    <button id="signout" class="hide">Sign out</button>
  </header>

  <div id="err"></div>

  <section id="login">
    <h2>Sign in</h2>
    <p class="muted">Connect the account's wallet to view the fleet and, if needed, hit the
    emergency stop. Read-only apart from the two stop buttons; the session lasts one hour and is
    never stored on the server.</p>
    <div class="actions">
      <button id="connect">Connect wallet &amp; sign in</button>
    </div>
    <p class="muted" id="nowallet" style="margin-top:14px"></p>
  </section>

  <div id="app" class="hide">
    <section>
      <h2>Account</h2>
      <div class="row" id="stats"></div>
      <div class="actions">
        <button id="refresh">Refresh</button>
        <button id="pause" class="danger">Pause everything</button>
        <button id="revoke" class="danger">Revoke all API keys</button>
      </div>
    </section>
    <section>
      <h2 id="mon-h">Monitors</h2>
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Status</th><th>Last ping</th><th>Expires</th><th>Billing</th></tr></thead><tbody id="mon"></tbody></table></div>
    </section>
    <section>
      <h2 id="job-h">Jobs</h2>
      <div class="tablewrap"><table><thead><tr><th>Name</th><th>Status</th><th>Next run</th></tr></thead><tbody id="job"></tbody></table></div>
    </section>
    <section>
      <h2>Recent payments</h2>
      <div class="tablewrap"><table><thead><tr><th>Product</th><th>Amount</th><th>When</th></tr></thead><tbody id="pay"></tbody></table></div>
    </section>
  </div>
</div>
<script>
const BASE = ${JSON.stringify(base)};
const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; };
const tokenKey = 't2l_operator_token';
const getToken = () => { try { return sessionStorage.getItem(tokenKey); } catch { return null; } };
const setToken = (t) => { try { t ? sessionStorage.setItem(tokenKey, t) : sessionStorage.removeItem(tokenKey); } catch {} };

async function api(path, opts) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getToken(), ...(opts && opts.headers) },
  });
  if (res.status === 401) { setToken(null); showLogin('Session expired — sign in again.'); throw new Error('unauthorized'); }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error((b.error && b.error.message) || ('HTTP ' + res.status)); }
  return res.json();
}

function showLogin(msg) {
  $('app').classList.add('hide'); $('login').classList.remove('hide');
  $('signout').classList.add('hide'); $('who').textContent = '';
  if (msg) err(msg);
}

const fmt = (iso) => iso ? new Date(iso).toLocaleString() : '—';
const pill = (s) => { const e = document.createElement('span'); e.className = 'pill s-' + s; e.textContent = s; return e; };
function cell(text) { const td = document.createElement('td'); td.textContent = text; return td; }
function statusCell(s) { const td = document.createElement('td'); td.appendChild(pill(s)); return td; }

function renderCounts(el, counts) {
  return Object.entries(counts).map(([k, v]) => k + ' ' + v).join(' · ') || 'none';
}

async function load() {
  err('');
  const o = await api('/v1/account/overview');
  $('who').textContent = o.account.address.slice(0, 6) + '…' + o.account.address.slice(-4);
  const stats = [
    ['Tier', o.account.tier],
    ['Status', o.account.status],
    ['Credits', o.account.credits.balanceUsd],
    ['Runs this month', String(o.account.usage.runs)],
  ];
  $('stats').replaceChildren(...stats.map(([k, v]) => {
    const d = document.createElement('div'); d.className = 'stat';
    const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k;
    const vv = document.createElement('div'); vv.className = 'v'; vv.textContent = v;
    d.append(kk, vv); return d;
  }));
  $('mon-h').textContent = 'Monitors — ' + renderCounts(null, o.monitors.counts);
  $('mon').replaceChildren(...o.monitors.recent.map((m) => {
    const tr = document.createElement('tr');
    tr.append(cell(m.name), statusCell(m.status), cell(fmt(m.lastPingAt)), cell(fmt(m.expiresAt)), cell(m.billing));
    return tr;
  }));
  if (!o.monitors.recent.length) $('mon').innerHTML = '<tr><td class="muted" colspan="5">none</td></tr>';
  $('job-h').textContent = 'Jobs — ' + renderCounts(null, o.jobs.counts);
  $('job').replaceChildren(...o.jobs.recent.map((j) => {
    const tr = document.createElement('tr');
    tr.append(cell(j.name), statusCell(j.status), cell(fmt(j.nextRunAt)));
    return tr;
  }));
  if (!o.jobs.recent.length) $('job').innerHTML = '<tr><td class="muted" colspan="3">none</td></tr>';
  $('pay').replaceChildren(...o.payments.map((p) => {
    const tr = document.createElement('tr');
    tr.append(cell(p.product), cell(p.amountUsd), cell(fmt(p.createdAt)));
    return tr;
  }));
  if (!o.payments.length) $('pay').innerHTML = '<tr><td class="muted" colspan="3">none</td></tr>';
  $('login').classList.add('hide'); $('app').classList.remove('hide'); $('signout').classList.remove('hide');
}

async function signIn() {
  err('');
  const eth = window.ethereum;
  if (!eth) { err('No EVM wallet found in this browser.'); return; }
  $('connect').disabled = true;
  try {
    const [address] = await eth.request({ method: 'eth_requestAccounts' });
    const ch = await (await fetch(BASE + '/v1/auth/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, chainId: 8453 }),
    })).json();
    if (!ch.message) throw new Error('could not get a challenge');
    const signature = await eth.request({ method: 'personal_sign', params: [ch.message, address] });
    const res = await fetch(BASE + '/v1/auth/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: ch.message, signature }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error((body.error && body.error.message) || 'sign-in failed');
    setToken(body.token);
    await load();
  } catch (e) {
    err(e && e.message ? e.message : 'sign-in failed');
  } finally {
    $('connect').disabled = false;
  }
}

$('connect').onclick = signIn;
$('refresh').onclick = () => load().catch((e) => err(e.message));
$('signout').onclick = () => { setToken(null); showLogin(''); };
$('pause').onclick = async () => {
  if (!confirm('Pause ALL jobs and monitors now? Alerts stop until you resume them.')) return;
  try { const r = await api('/v1/account/pause-all', { method: 'POST' }); err('Paused ' + r.jobsPaused + ' jobs and ' + r.monitorsPaused + ' monitors.'); await load(); } catch (e) { err(e.message); }
};
$('revoke').onclick = async () => {
  if (!confirm('Revoke ALL API keys? Every agent using this account is locked out immediately.')) return;
  try { const r = await api('/v1/account/keys/revoke-all', { method: 'POST' }); err('Revoked ' + r.revoked + ' API keys.'); await load(); } catch (e) { err(e.message); }
};

$('nowallet').textContent = window.ethereum ? '' : 'No EVM wallet detected — open this page in a wallet browser or an extension-enabled browser.';
if (getToken()) load().catch(() => showLogin(''));
</script>
</body>
</html>
`;
}

function analyticsHtml(base: string, net: NetworkInfo): string {
  const badge =
    net.mode === 'live'
      ? '<span class="netbadge live">● Live · Base mainnet</span>'
      : net.mode === 'test'
        ? `<span class="netbadge test">● Testnet · ${net.chain}</span>`
        : '<span class="netbadge test">● Free / eval</span>';
  // Only `base` is interpolated (our own config); all figures render client-side with textContent.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>time2live — analytics</title>
<meta name="robots" content="noindex">
<style>
  :root {
    --bg:#0a0e14; --panel:#111823; --line:#1e2a3a; --fg:#d7e0ea; --dim:#7d8ea3;
    --accent:#35d07f; --red:#ff5c5c; --amber:#f0b429;
    --mono: ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 var(--mono);-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}
  .wrap{max-width:960px;margin:0 auto;padding:0 clamp(14px,4vw,24px)}
  header{padding:clamp(24px,6vw,36px) 0 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px 12px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;font-size:clamp(17px,4.6vw,20px);font-weight:600}
  .pulse{width:10px;height:10px;border-radius:50%;background:var(--accent);animation:pulse 2.4s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(53,208,127,.5)}70%{box-shadow:0 0 0 10px rgba(53,208,127,0)}100%{box-shadow:0 0 0 0 rgba(53,208,127,0)}}
  @media(prefers-reduced-motion:reduce){.pulse{animation:none}}
  .netbadge{padding:2px 10px;border-radius:20px;font-size:12px;border:1px solid var(--line);font-weight:400;white-space:nowrap}
  .netbadge.live{color:var(--accent);border-color:var(--accent)}
  .netbadge.test{color:var(--amber);border-color:var(--amber)}
  .muted{color:var(--dim)}
  .grow{flex:1}
  button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--fg);padding:8px 14px;border-radius:8px;cursor:pointer}
  button:hover{border-color:var(--accent)}
  button:disabled{opacity:.5;cursor:default}
  section{padding:22px 0;border-bottom:1px solid var(--line)}
  h2{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:var(--dim);margin:0 0 14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .live-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 2.4s infinite}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,180px),1fr));gap:14px}
  .tile{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
  .tile .k{color:var(--dim);font-size:12px;letter-spacing:.5px;text-transform:uppercase}
  .tile .v{font-size:clamp(26px,7vw,34px);font-weight:600;margin:6px 0 2px;line-height:1.1}
  .tile .sub{color:var(--dim);font-size:12.5px;overflow-wrap:anywhere}
  .tile .sub b{color:var(--fg);font-weight:600}
  .ok{color:var(--accent)} .bad{color:var(--red)} .warn{color:var(--amber)}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
  .actions button{flex:1 1 auto}
  @media(min-width:560px){.actions button{flex:0 0 auto}}
  #err{color:var(--red);min-height:18px;margin:10px 0;overflow-wrap:anywhere}
  .hide{display:none}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="pulse"></span>
    <div class="brand">time2live<span class="muted" style="font-weight:400">/ analytics</span>${badge}</div>
    <div class="grow"></div>
    <a href="${base}/dashboard" class="muted" style="font-size:13px">← operator</a>
    <span id="who" class="muted"></span>
    <button id="signout" class="hide">Sign out</button>
  </header>

  <div id="err"></div>

  <section id="login">
    <h2>Sign in</h2>
    <p class="muted">Fleet-wide analytics are restricted to the operator wallet. Connect and sign to
    view live, service-wide statistics. The session lasts one hour and is never stored on the server.</p>
    <div class="actions">
      <button id="connect">Connect wallet &amp; sign in</button>
    </div>
    <p class="muted" id="nowallet" style="margin-top:14px"></p>
  </section>

  <div id="app" class="hide">
    <section>
      <h2><span class="live-dot"></span>Live <span class="muted" id="updated" style="letter-spacing:0;text-transform:none"></span></h2>
      <div class="grid" id="tiles"></div>
    </section>
  </div>
</div>
<script>
const BASE = ${JSON.stringify(base)};
const $ = (id) => document.getElementById(id);
const err = (m) => { $('err').textContent = m || ''; };
const tokenKey = 't2l_operator_token';
const getToken = () => { try { return sessionStorage.getItem(tokenKey); } catch { return null; } };
const setToken = (t) => { try { t ? sessionStorage.setItem(tokenKey, t) : sessionStorage.removeItem(tokenKey); } catch {} };
const nf = (n) => Number(n || 0).toLocaleString('en-US');

let timer = null;
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

function showLogin(msg) {
  stopTimer();
  $('app').classList.add('hide'); $('login').classList.remove('hide');
  $('signout').classList.add('hide'); $('who').textContent = '';
  if (msg) err(msg);
}

function tile(k, v, subHtml) {
  const d = document.createElement('div'); d.className = 'tile';
  const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = k;
  const vv = document.createElement('div'); vv.className = 'v'; vv.textContent = v;
  const ss = document.createElement('div'); ss.className = 'sub';
  if (subHtml) ss.append(...subHtml);
  d.append(kk, vv, ss); return d;
}
function frag(parts) {
  // parts: array of [text, className?]; joined with " · "
  const out = [];
  parts.forEach((p, i) => {
    if (i) out.push(document.createTextNode(' · '));
    const s = document.createElement('span');
    s.textContent = p[0]; if (p[1]) s.className = p[1];
    out.push(s);
  });
  return out;
}

function render(a) {
  const acc = a.accounts, mon = a.monitors, job = a.jobs, run = a.runs, pay = a.payments, sw = a.switches;
  const ms = mon.byStatus || {}, js = job.byStatus || {};
  const tiles = [
    tile('Accounts', nf(acc.total), frag([
      [nf(acc.activated) + ' activated'],
      [nf(acc.active) + ' active'],
      ...(acc.frozen ? [[nf(acc.frozen) + ' frozen', 'bad']] : []),
      ['+' + nf(acc.new) + ' / 24h', 'ok'],
    ])),
    tile('Monitors', nf(mon.total), frag([
      [nf(ms.alive || 0) + ' alive', 'ok'],
      [nf(ms.dead || 0) + ' dead', (ms.dead ? 'bad' : '')],
      [nf(ms.paused || 0) + ' paused'],
      [nf(ms.new || 0) + ' new'],
    ])),
    tile('Jobs', nf(job.total), frag([
      [nf(js.active || 0) + ' active', 'ok'],
      [nf(js.paused || 0) + ' paused'],
      [nf(js.completed || 0) + ' done'],
    ])),
    tile('Runs / 24h', nf(run.recent), frag([
      [nf(run.succeeded) + ' ok', 'ok'],
      [nf(run.failed) + ' failed', (run.failed ? 'bad' : '')],
      [nf(run.total) + ' all-time'],
    ])),
    tile('Revenue', pay.revenueUsd, frag([
      [pay.recentUsd + ' / 24h', 'ok'],
      [nf(pay.count) + ' payments'],
    ])),
    tile('On-chain switches', nf(sw.total), frag([
      [nf(sw.live) + ' live', 'ok'],
      [nf(sw.triggered) + ' triggered', 'warn'],
      [nf(sw.skipped) + ' skipped'],
    ])),
  ];
  $('tiles').replaceChildren(...tiles);
  $('updated').textContent = '· updated ' + new Date(a.generatedAt).toLocaleTimeString();
}

async function load() {
  const res = await fetch(BASE + '/v1/analytics', {
    headers: { authorization: 'Bearer ' + getToken() },
  });
  if (res.status === 401) { setToken(null); showLogin('Session expired — sign in again.'); return; }
  if (res.status === 403) { stopTimer(); err('This wallet is not authorized to view analytics.'); return; }
  if (res.status === 404) { stopTimer(); err('Analytics is not enabled on this instance.'); return; }
  if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error((b.error && b.error.message) || ('HTTP ' + res.status)); }
  err('');
  render(await res.json());
  $('login').classList.add('hide'); $('app').classList.remove('hide'); $('signout').classList.remove('hide');
}

function startTimer() {
  stopTimer();
  timer = setInterval(() => {
    if (document.hidden) return; // be polite when the tab is backgrounded
    load().catch((e) => err(e.message));
  }, 5000);
}

async function signIn() {
  err('');
  const eth = window.ethereum;
  if (!eth) { err('No EVM wallet found in this browser.'); return; }
  $('connect').disabled = true;
  try {
    const [address] = await eth.request({ method: 'eth_requestAccounts' });
    const ch = await (await fetch(BASE + '/v1/auth/challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address, chainId: 8453 }),
    })).json();
    if (!ch.message) throw new Error('could not get a challenge');
    const signature = await eth.request({ method: 'personal_sign', params: [ch.message, address] });
    const res = await fetch(BASE + '/v1/auth/session', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: ch.message, signature }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error((body.error && body.error.message) || 'sign-in failed');
    setToken(body.token);
    $('who').textContent = address.slice(0, 6) + '…' + address.slice(-4);
    await load();
    if (!$('app').classList.contains('hide')) startTimer();
  } catch (e) {
    err(e && e.message ? e.message : 'sign-in failed');
  } finally {
    $('connect').disabled = false;
  }
}

$('connect').onclick = signIn;
$('signout').onclick = () => { setToken(null); showLogin(''); };
document.addEventListener('visibilitychange', () => { if (!document.hidden && timer) load().catch((e) => err(e.message)); });

$('nowallet').textContent = window.ethereum ? '' : 'No EVM wallet detected — open this page in a wallet browser or an extension-enabled browser.';
if (getToken()) load().then(() => { if (!$('app').classList.contains('hide')) startTimer(); }).catch(() => showLogin(''));
</script>
</body>
</html>
`;
}

/** Shared <head> + base style for the simple text pages (terms, privacy, status). */
function docShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230a0e14'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%2335d07f'/%3E%3C/svg%3E">
<style>
  :root{--bg:#0a0e14;--panel:#111823;--line:#1e2a3a;--fg:#d7e0ea;--dim:#7d8ea3;--accent:#35d07f;--amber:#f0b429;--red:#ff5c5c;--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 var(--mono);-webkit-font-smoothing:antialiased}
  a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
  code{color:var(--amber);overflow-wrap:anywhere}
  .wrap{max-width:760px;margin:0 auto;padding:0 clamp(16px,4vw,24px)}
  header{padding:clamp(32px,8vw,56px) 0 20px;border-bottom:1px solid var(--line)}
  .brand{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;font-size:clamp(20px,5vw,26px);font-weight:600}
  .pulse{width:11px;height:11px;border-radius:50%;background:var(--accent)}
  h1{font-size:clamp(22px,5vw,28px);margin:28px 0 6px}
  h2{font-size:15px;letter-spacing:.5px;color:var(--fg);margin:26px 0 8px}
  p,li{color:var(--fg)}
  .dim{color:var(--dim)}
  ul{padding-left:20px}
  section{padding:8px 0}
  footer{padding:28px 0 56px;color:var(--dim);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 18px;border-top:1px solid var(--line);margin-top:28px}
  .note{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;color:var(--dim);font-size:13.5px}
  .badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:12px;border:1px solid var(--line)}
  .badge.live{color:var(--accent);border-color:var(--accent)}.badge.test{color:var(--amber);border-color:var(--amber)}
</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

function docFooter(base: string): string {
  return `<footer>
  <a href="${base}/">home</a>
  <a href="${base}/terms">terms</a>
  <a href="${base}/privacy">privacy</a>
  <a href="${base}/status">status</a>
  <a href="${base}/llms.txt">llms.txt</a>
  <a href="https://github.com/MeMikko/TTL">source</a>
  <a href="https://x.com/t2lxyz">x</a>
  <a href="${base}/.well-known/security.txt">security.txt</a>
</footer>`;
}

/** Terms of Service / Privacy — factual to how the service actually works. */
function legalHtml(base: string, net: NetworkInfo, kind: 'terms' | 'privacy'): string {
  const today = new Date().toISOString().slice(0, 10);
  const badge =
    net.mode === 'live'
      ? '<span class="badge live">● Live · Base mainnet</span>'
      : net.mode === 'test'
        ? `<span class="badge test">● Testnet · ${net.chain}</span>`
        : '<span class="badge test">● Free / eval</span>';
  const h = host(base);
  const header = `<header>
  <div class="brand"><span class="pulse" aria-hidden="true"></span>time2live ${badge}</div>
</header>`;

  if (kind === 'terms') {
    return docShell(
      'time2live — Terms of Service',
      `${header}
<h1>Terms of Service</h1>
<p class="dim">Last updated: ${today}</p>
<section>
<p>time2live ("the Service") provides scheduling (cron and one-off webhook jobs) and liveness
monitoring (heartbeat "dead man's switch") for autonomous software agents, plus an optional
on-chain dead man's switch smart contract on Base (which you deploy and control; time2live has no
admin key over it). By using the Service you agree to these terms.</p>
<h2>1. Accounts & access</h2>
<p>There are no human accounts. Identity is an EVM wallet address proven by signature (EIP-4361).
You are responsible for your private keys and API keys; anyone holding them controls your resources.
Revoke keys any time with <code>POST /v1/account/keys/revoke-all</code>.</p>
<h2>2. Payments</h2>
<p>Paid actions are settled in USDC on Base via the x402 protocol. Prepaid credits and activations
are non-refundable except where required by law. Prices are shown at <a href="${base}/">${h}</a> and
may change for future purchases.</p>
<h2>3. Acceptable use</h2>
<p>Do not use the Service to attack, overload, or deliver unlawful content to third parties. Webhook
targets must be systems you are authorised to call. We rate-limit and may suspend ("freeze")
accounts that abuse the Service or its delivery targets.</p>
<h2>4. On-chain contract</h2>
<p>The on-chain dead man's switch is a smart contract you deploy and control; time2live has no admin
key and cannot withdraw or freeze its funds. It is <strong>unaudited</strong>. Transfers are
irreversible; the owner can change the beneficiary while the switch is live but not after the
deadline, and after the deadline funds move only to the beneficiary (less any trigger reward you
set). You use it at your own risk; review the verified source before depositing. We never hold your
funds or keys.</p>
<h2>5. No warranty</h2>
<p>The Service is provided "as is" and "as available", without warranties of any kind. Alerts and
job delivery are best-effort; we do not guarantee uptime or that any alert or trigger will be
delivered. Run your own independent monitoring for anything critical.</p>
<h2>6. Limitation of liability</h2>
<p>To the maximum extent permitted by law, the operator is not liable for any indirect, incidental,
or consequential damages, or for lost funds, missed alerts, or failed deliveries. Total liability
for the Service is limited to the amount you paid in the 30 days before the claim.</p>
<h2>7. Changes & contact</h2>
<p>We may update these terms; continued use means acceptance. Questions: <code>legal@${h}</code>.
Security reports: <a href="${base}/.well-known/security.txt">security.txt</a>.</p>
</section>
<p class="note">This is a plain-language summary of how the Service works, not legal advice. Have
your own counsel review it before relying on it in a specific jurisdiction.</p>
${docFooter(base)}`,
    );
  }

  return docShell(
    'time2live — Privacy Policy',
    `${header}
<h1>Privacy Policy</h1>
<p class="dim">Last updated: ${today}</p>
<section>
<p>time2live is built to need as little personal data as possible: there are no human accounts, and
we never ask for your name, email, or payment card.</p>
<h2>What we store</h2>
<ul>
<li>Your <strong>wallet address</strong> (the only identity) and hashes of your API keys.</li>
<li>The resources you create: job and monitor configuration, webhook target URLs, schedules.</li>
<li>Operational logs: job run and delivery history and alert outcomes, kept ~30 days.</li>
<li>Payment records: on-chain transaction hashes and amounts (already public on Base).</li>
<li>Optionally, a Telegram chat id if you link Telegram for alerts.</li>
</ul>
<h2>What we do not collect</h2>
<p>No name, email, phone, address, or payment-card data. No advertising or analytics trackers. The
operator dashboard and analytics pages use only in-browser <code>sessionStorage</code> for a
short-lived sign-in token — no tracking cookies.</p>
<h2>Third parties</h2>
<p>To run the Service we send data to: your own webhook targets (job/alert deliveries), a blockchain
RPC provider and the x402 payment facilitator (for payments and on-chain reads), and — only if you
enable them — Telegram (alerts) and an email provider (alerts). We do not sell data.</p>
<h2>Retention & your control</h2>
<p>Delete jobs and monitors any time; run history ages out after ~30 days. Revoke all API keys with
<code>POST /v1/account/keys/revoke-all</code>. On-chain data (payments, contract activity) is public
and permanent and cannot be deleted by us.</p>
<h2>Contact</h2>
<p>Privacy questions: <code>privacy@${h}</code>.</p>
</section>
<p class="note">This describes current practice and is not legal advice; have counsel review it for
your jurisdiction (e.g. GDPR/CCPA specifics).</p>
${docFooter(base)}`,
  );
}

/** Lightweight public status page: pings /healthz?deep=1 client-side. */
function statusHtml(base: string, net: NetworkInfo): string {
  const badge =
    net.mode === 'live'
      ? '<span class="badge live">● Live · Base mainnet</span>'
      : net.mode === 'test'
        ? `<span class="badge test">● Testnet · ${net.chain}</span>`
        : '<span class="badge test">● Free / eval</span>';
  return docShell(
    'time2live — Status',
    `<header>
  <div class="brand"><span class="pulse" aria-hidden="true"></span>time2live ${badge}</div>
</header>
<h1>Service status</h1>
<section>
<p id="state" class="dim">Checking…</p>
<p class="dim" id="detail"></p>
<p class="dim">This page checks <code>${base}/healthz?deep=1</code> (API, database and a recent worker
tick) live from your browser. For independent uptime history, use an external monitor.</p>
</section>
${docFooter(base)}
<script>
const BASE = ${JSON.stringify(base)};
async function check() {
  const state = document.getElementById('state'), detail = document.getElementById('detail');
  try {
    const res = await fetch(BASE + '/healthz?deep=1', { cache: 'no-store' });
    const b = await res.json().catch(() => ({}));
    if (res.ok) { state.textContent = '● All systems operational'; state.style.color = '#35d07f'; }
    else { state.textContent = '● Degraded'; state.style.color = '#f0b429'; }
    const checks = b && b.checks ? Object.entries(b.checks).map(([k,v]) => k + ': ' + (v.ok ? 'ok' : (v.detail || 'down'))).join(' · ') : '';
    detail.textContent = (b.version ? 'version ' + b.version : '') + (checks ? ' — ' + checks : '');
  } catch {
    state.textContent = '● Unreachable'; state.style.color = '#ff5c5c';
    detail.textContent = 'Could not reach the health endpoint.';
  }
}
check(); setInterval(check, 15000);
</script>`,
  );
}
