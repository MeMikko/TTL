import { Hono, type Context } from 'hono';
import { networkInfo, type NetworkInfo } from '../../core/network.js';
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
  const net = networkInfo(deps.config);
  const app = new Hono<AppEnv>();
  const cache = 'public, max-age=300';

  const summary = {
    name: 'time2live',
    description:
      'Scheduling and liveness (TTL) service for autonomous AI agents: cron/one-off webhook ' +
      "jobs and heartbeat monitors (dead man's switch). Register with an EVM wallet, pay with x402.",
    version: VERSION,
    // Prominent trust signal: is this a live (real-money) or a testnet deployment?
    network: { mode: net.mode, label: net.label, chain: net.chain },
    links: {
      openapi: `${base}/openapi.json`,
      llms: `${base}/llms.txt`,
      mcp: `${base}/mcp`,
      mcpServerCard: `${base}/.well-known/mcp/server-card.json`,
      health: `${base}/healthz`,
      dashboard: `${base}/dashboard`,
    },
    x402,
    deadMansSwitchContract: onChain,
  };

  // Content negotiation: browsers get the landing page, agents and curl keep the JSON summary.
  // The JSON at `/` is the discovery contract, so it must stay byte-for-byte for non-HTML clients.
  app.get('/', (c) => {
    c.header('cache-control', cache);
    if ((c.req.header('accept') ?? '').includes('text/html')) {
      c.header('content-type', 'text/html; charset=utf-8');
      return c.body(landingHtml(base, net, onChain));
    }
    return c.json(summary);
  });

  app.get('/llms.txt', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/markdown; charset=utf-8');
    return c.body(llmsTxt(base, net, onChain));
  });

  // Human operator dashboard: sign in with the wallet, view the fleet read-only, emergency stop.
  app.get('/dashboard', (c) => {
    c.header('cache-control', cache);
    c.header('content-type', 'text/html; charset=utf-8');
    return c.body(dashboardHtml(base, net));
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
  net: NetworkInfo,
  onChain: { chainId: number; factory: string; keeper: boolean } | null,
): string {
  const network = net.x402Network;
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

**Network: ${net.label}.**

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

function landingHtml(
  base: string,
  net: NetworkInfo,
  onChain: { chainId: number; factory: string; keeper: boolean } | null,
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
  code { color: var(--amber); }
  .wrap { max-width: 820px; margin: 0 auto; padding: 0 16px; }
  header { padding: 72px 0 48px; border-bottom: 1px solid var(--line); }
  .brand { display: flex; align-items: center; gap: 12px; font-size: 30px; font-weight: 600; letter-spacing: -0.5px; }
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
  .tag { margin: 20px 0 0; font-size: 17px; color: var(--fg); max-width: 60ch; }
  .sub { margin: 10px 0 0; color: var(--dim); }
  .badge { display: inline-block; margin-left: 12px; padding: 2px 10px; border-radius: 20px; font-size: 12px; border: 1px solid var(--line); vertical-align: middle; }
  .badge.live { color: var(--accent); border-color: var(--accent); }
  .badge.test { color: var(--amber); border-color: var(--amber); }
  .cta { margin-top: 28px; display: flex; flex-wrap: wrap; gap: 10px; }
  .btn {
    border: 1px solid var(--line); background: var(--panel); color: var(--fg);
    padding: 9px 16px; border-radius: 8px; font-size: 14px;
  }
  .btn:hover { border-color: var(--accent); text-decoration: none; }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  section { padding: 48px 0; border-bottom: 1px solid var(--line); }
  h2 { font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--dim); margin: 0 0 22px; }
  h3 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); display: inline-block; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
  .card p { margin: 0 0 8px; color: var(--fg); }
  .small { font-size: 12.5px; }
  .dim { color: var(--dim); }
  pre {
    background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
    padding: 16px 18px; overflow-x: auto; font-size: 13px; line-height: 1.7; margin: 0 0 14px;
  }
  pre .c { color: var(--dim); }
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
    <div class="brand"><span class="pulse" aria-hidden="true"></span>time2live${badge}</div>
    <p class="tag">Scheduling and liveness for autonomous AI agents. Cron and one-off webhook jobs,
    and heartbeat monitors — a <strong>dead man's switch</strong> that alerts when an agent goes
    silent.</p>
    <p class="sub">Agents register with an EVM wallet and pay with x402. No human account, no
    dashboard, no card.</p>
    <div class="cta">
      <a class="btn primary" href="${base}/llms.txt">Agent guide → /llms.txt</a>
      <a class="btn" href="${base}/openapi.json">OpenAPI</a>
      <a class="btn" href="${base}/mcp">MCP endpoint</a>
      <a class="btn" href="${base}/dashboard">Operator sign-in</a>
      <a class="btn" href="https://github.com/MeMikko/TTL">GitHub</a>
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
    <table>
      <tr><th>Tier / action</th><th>What you get</th><th>Price</th></tr>
      <tr><td>Free (unactivated)</td><td>${unactivated.monitors} monitor · ${unactivated.runsPerMonth} runs/month</td><td class="price">$0</td></tr>
      <tr><td>Activation (one-off)</td><td>${free.monitors} monitors · ${free.runsPerMonth} runs/month</td><td class="price">${activation}</td></tr>
      <tr><td>Extra run</td><td>beyond the monthly free allowance</td><td class="price">${run}</td></tr>
      <tr><td>Extra monitor</td><td>per 30 days, from credits</td><td class="price">${monitor}</td></tr>
      <tr><td>Credit packs</td><td>prepaid, USDC on Base</td><td class="price">${packs}</td></tr>
    </table>
    <p class="small dim">Over-quota calls answer <code>402</code> with an x402 <code>PAYMENT-REQUIRED</code>
    challenge; pay and retry the same request. One round trip, no human.</p>
  </section>

  <footer>
    <span>time2live</span>
    <a href="${base}/healthz">status</a>
    <a href="${base}/openapi.json">api</a>
    <a href="${base}/llms.txt">llms.txt</a>
    <a href="${base}/mcp">mcp</a>
    <a href="https://github.com/MeMikko/TTL">source</a>
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
  .wrap{max-width:900px;margin:0 auto;padding:0 16px}
  header{padding:36px 0 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .brand{display:flex;align-items:center;gap:10px;font-size:20px;font-weight:600}
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
  .row{display:flex;gap:20px;flex-wrap:wrap}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 16px;min-width:130px}
  .stat .k{color:var(--dim);font-size:12px}
  .stat .v{font-size:18px;margin-top:2px}
  table{width:100%;border-collapse:collapse;font-size:13px}
  td,th{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px}
  th{color:var(--dim);font-weight:500}
  .pill{padding:1px 8px;border-radius:20px;font-size:12px;border:1px solid var(--line)}
  .s-alive,.s-active{color:var(--accent);border-color:var(--accent)}
  .s-dead{color:var(--red);border-color:var(--red)}
  .s-paused,.s-new,.s-completed{color:var(--dim)}
  .muted{color:var(--dim)}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
  #err{color:var(--red);min-height:18px;margin:10px 0}
  .hide{display:none}
  input{font:inherit;background:var(--panel);border:1px solid var(--line);color:var(--fg);padding:8px 12px;border-radius:8px;min-width:280px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="pulse"></span>
    <div class="brand">time2live<span class="muted" style="font-weight:400">/ operator</span>${badge}</div>
    <div class="grow"></div>
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
      <table><thead><tr><th>Name</th><th>Status</th><th>Last ping</th><th>Expires</th><th>Billing</th></tr></thead><tbody id="mon"></tbody></table>
    </section>
    <section>
      <h2 id="job-h">Jobs</h2>
      <table><thead><tr><th>Name</th><th>Status</th><th>Next run</th></tr></thead><tbody id="job"></tbody></table>
    </section>
    <section>
      <h2>Recent payments</h2>
      <table><thead><tr><th>Product</th><th>Amount</th><th>When</th></tr></thead><tbody id="pay"></tbody></table>
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
