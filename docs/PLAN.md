# time2live.xyz — Implementation Plan

Scheduling and liveness ("TTL") service for autonomous AI agents. Customers are both
agent builders and the agents themselves: an agent must be able to discover the service,
register and pay without a human in the loop.

Status: **approved** (with amendments, see §11). Progress: phase 0 ✅, phase 1 ✅, phase 2 ✅, phase 3 ✅, phase 6 (infra) ✅ (live at time2live.xyz), phase 4 (billing) ✅ — x402 enabled per environment via `X402_*`, phase 5 (discovery + MCP) ✅. This document is the source of truth for
scope; update it when decisions change.

---

## 1. Architecture

```
Internet ──443──> Caddy (TLS) ──> api (Hono)  ──┐
                                                ├──> Postgres (internal network only)
                    worker (scheduler + pg-boss)┘
                       └──> outbound webhooks (SSRF-guarded HTTP client)
```

- **api** — REST, MCP (Streamable HTTP at `/mcp`), x402 payments, discovery files.
  Never performs outbound webhook calls.
- **worker** —
  - scheduler loop: claims due jobs (`SELECT … FOR UPDATE SKIP LOCKED`), computes `next_run_at`;
  - delivery: webhook calls queued in the `job_runs` table itself (claimed with
    `FOR UPDATE SKIP LOCKED` + a lease; retry with exponential backoff). Decision (phase 2):
    no pg-boss — run history and queue are the same rows, so they can never disagree, and
    scheduling (quota + run insert + next_run_at) is a single transaction;
  - monitor sweeper: finds expired heartbeats via indexed `expires_at`, alive → dead, sends alerts;
  - retention cleanup (30 days, see §11);
  - keeper (phase 7).
- Same codebase and Docker image, different entrypoint (`node dist/bin/api.js` / `node dist/bin/worker.js`).

**Self-monitoring pitfall:** dead-heartbeat detection runs inside the worker, so if the worker dies
our own heartbeat feature cannot notice. Therefore the worker writes a `worker_ticks` row every
~15 s, and `GET /healthz?deep=1` returns 503 when the latest tick is older than 2 minutes. An
external uptime checker polls that URL. Our own heartbeat monitor ("dogfooding") additionally
catches partial failures (e.g. a stuck delivery queue).

## 2. Data model (Postgres)

| Table              | Key fields                                                                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accounts`         | id, wallet_address (unique, lowercase), webhook_secret (encrypted), status (`active`/`frozen`), frozen_reason, activated_at (free tier activation, see §11), created_at                                           |
| `auth_nonces`      | nonce (PK), address, expires_at, used_at — single use, 5 min TTL                                                                                                                                                  |
| `api_keys`         | id, account_id, prefix (visible, e.g. `t2l_ab12`), key_hash (SHA-256), name, last_used_at, revoked_at                                                                                                             |
| `jobs`             | id, account_id, name, schedule_kind (`cron`/`once`), cron_expr, timezone, run_at, next_run_at, target: url, method, headers_enc (AES-GCM), body, timeout_ms, max_attempts, status (`active`/`paused`/`completed`) |
| `job_runs`         | id, job_id, scheduled_for, attempt, status, http_status, duration_ms, response_snippet (≤4 kB), error, started_at, finished_at                                                                                    |
| `monitors`         | id (random 128-bit, doubles as ping capability), account_id, name, ttl_s, grace_s, status (`new`/`alive`/`dead`/`paused`), last_ping_at, expires_at, alert_webhook_url, telegram_chat_id                          |
| `monitor_events`   | monitor_id, from_status, to_status, at                                                                                                                                                                            |
| `alert_deliveries` | channel (webhook/telegram), status, attempts, error                                                                                                                                                               |
| `usage_counters`   | account_id, period (YYYY-MM), runs, active_monitors                                                                                                                                                               |
| `credits_ledger`   | account_id, delta (micro-USDC), reason (`topup`/`activation`/`run`/`monitor_month`), ref — balance = sum                                                                                                          |
| `payments`         | id, account_id, payer, network, asset, amount, tx_hash (unique), resource, raw_payload, settled_at                                                                                                                |
| `idempotency_keys` | (account_id, key) PK, request_hash, status_code, response_body, created_at — kept 24 h                                                                                                                            |
| `worker_ticks`     | worker_id, last_tick_at                                                                                                                                                                                           |

ORM: Drizzle. Migrations are generated as SQL files and applied by a separate `migrate`
command before a new version starts.

## 3. API routes

- Public: `GET /healthz`, `GET /openapi.json` (generated from zod schemas), `GET /llms.txt`,
  `GET /.well-known/…` (service description + MCP descriptor; exact names verified against
  current conventions at implementation time).
- Auth: `POST /v1/auth/challenge` `{address, chainId}` → SIWE (EIP-4361) message + nonce;
  `POST /v1/auth/verify` `{message, signature}` → `{apiKey, accountId}` (key shown once;
  verification via viem `verifySiweMessage`, supporting ERC-1271/6492 smart wallets via Base RPC).
- `GET|POST /v1/keys`, `DELETE /v1/keys/:id`
- `GET /v1/account` (usage, credits), `POST /v1/account/webhook-secret/rotate`
- Jobs: `POST|GET /v1/jobs`, `GET|PATCH|DELETE /v1/jobs/:id`, `POST /v1/jobs/:id/{pause|resume|trigger}`,
  `GET /v1/jobs/:id/runs`, `GET /v1/runs/:id`
- Monitors: `POST|GET /v1/monitors`, `GET|PATCH|DELETE /v1/monitors/:id`, `GET /v1/monitors/:id/events`
- Ping: `POST /v1/heartbeat/:id` — works with plain curl, no API key (unguessable id, healthchecks.io model).
- Billing: `POST /v1/billing/activate` (x402, $0.10), `POST /v1/billing/credits?pack=…` (x402), `GET /v1/billing/payments`
- MCP: `POST /mcp` — tools `register_challenge` + `register` (two-step; the agent signs itself),
  `create_job`, `list_jobs`, `delete_job`, `create_heartbeat`, `ping`, `get_status`.

All create calls accept `Idempotency-Key`. Rate limits per key and per IP (token bucket;
in-memory with a single api process), plus a **global per-target-host limit** (see §11).

## 4. Billing (x402)

The worker triggers runs itself, so per-run x402 does not fit directly. **Credit model:**

1. Free tier (3 monitors + 100 runs/month) is **activated by a one-off $0.10 x402 payment**
   (anti-abuse). Until billing ships (phase 4), un-activated accounts get **1 monitor + 50 runs/month**.
2. Over quota, a create call answers `402` with `PAYMENT-REQUIRED`; the agent pays with its x402
   client and retries → credit pack credited + resource created in the same call.
3. Every run and every active monitor per month is charged from credits; at zero balance jobs are
   `paused` and a notification is sent.
4. Base Sepolia + public facilitator first; mainnet behind config. `tx_hash` unique → no double credit.
5. Re-verify the x402 docs (headers, payload schemas, CAIP-2 network ids, `@x402/hono`) right before implementing.

Default prices: $1 = 2,000 runs, $0.25 per monitor/month, packs $1 / $5 / $20.

**As built (phase 4):** free runs are used first, then $0.0005/run from credits. Beyond the tier,
a monitor is charged $0.25 up front per 30-day period (`billing = 'paid'`); an unpayable renewal
pauses the monitor and sends a `monitor.unpaid` alert. Instead of pausing jobs at zero balance,
unpayable scheduled runs are recorded as `skipped` (the job resumes by itself once allowance or
credit exists). Payments are verified and settled _before_ the handler runs, on the same request
that was answered 402. Implemented with `@x402/core` + `@x402/evm` (`x402ResourceServer`), headers
`PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, checked against the live
x402.org facilitator on Base Sepolia.

## 5. Security

- **SSRF:** custom undici `connect.lookup` validates every resolved IP _after_ DNS resolution
  (defeats DNS rebinding). Blocks RFC1918, loopback, link-local (incl. 169.254.169.254),
  CGNAT 100.64/10, 0.0.0.0/8, multicast/reserved, IPv6 ::1, fc00::/7, fe80::/10, IPv4-mapped,
  NAT64, the server's own public IP and Docker networks. No automatic redirects — each hop
  re-validated (max 3). Response size cap, hard timeout. URL validated at creation too.
  Targets: `https` only, ports 443 and 8443.
- **Webhook HMAC** (Stripe style): `T2L-Signature: t=<unix>,v1=<hex hmac_sha256(secret, t + "." + body)>`,
  plus `T2L-Delivery-Id`, `T2L-Event`. README includes a verification example (timestamp window, timing-safe compare).
- API keys: only SHA-256 hash stored (256-bit random keys, no salt needed).
- Headers and webhook secrets AES-GCM encrypted with a key from the server `.env`; `.env.example` in repo.
- All input validated with zod (cron syntax, min interval 1 min, min TTL 60 s).
- Account freeze via admin CLI (see §11).

## 6. Repository layout

```
/
├─ src/
│  ├─ api/          app.ts, routes/, middleware/ (auth, ratelimit, idempotency, x402)
│  ├─ worker/       index.ts, scheduler.ts, delivery.ts, monitors.ts, alerts/, cleanup.ts, keeper.ts
│  ├─ mcp/          server.ts, tools.ts
│  ├─ core/         config.ts (zod env), db/, siwe.ts, crypto.ts, ssrf.ts, hmac.ts, billing.ts, schemas.ts
│  └─ bin/          api.ts, worker.ts, migrate.ts, admin.ts
├─ drizzle/         SQL migrations
├─ public/          llms.txt, .well-known/
├─ test/            unit/ + integration/ (real Postgres)
├─ contracts/       Foundry: src/, test/ (unit, fuzz, invariant), script/
├─ deploy/          docker-compose.prod.yml, Caddyfile, provision.sh, create-server.ps1,
│                   update.sh, remote-deploy.sh, deploy.sh/.ps1, backup.sh, restore.sh, systemd/
├─ docker-compose.yml   local development
├─ Dockerfile           multi-stage, non-root
├─ .github/workflows/   ci.yml (checks only)
└─ .gitattributes       *.sh eol=lf  (CRLF breaks bash scripts on Windows checkouts)
```

Dev commands are npm scripts (PowerShell, WSL and Git Bash). Server scripts are bash, run from WSL/Git Bash.

## 7. Infrastructure (Hetzner)

- Compose: api, worker, postgres, caddy — all `restart: unless-stopped`. Only Caddy publishes
  80/443 (Docker-published ports bypass ufw!). Postgres has no `ports:` at all. json-file logs with rotation.
- Provisioning: `cloud-init` + idempotent `provision.sh` (deploy user, key-only SSH, no root login,
  ufw 22/80/443, fail2ban, unattended-upgrades, Docker). Server, SSH key and Cloud Firewall are
  created via the Hetzner API: `create-server.ps1` (Windows, no extra tools) or `hcloud-setup.sh`.
- Backups: systemd timer → daily `pg_dump -Fc` | restic → Storage Box via SFTP (port 23), encrypted;
  retention 7 daily / 4 weekly / 6 monthly; the backup script pings its own heartbeat monitor.
  `restore.sh` + a restore procedure tested end-to-end from a restic repo into an empty Postgres.
- Deploy (decision 2026-09-29, same model as the other MeMikko projects): the server holds a git
  checkout (read-only GitHub deploy key) and builds images itself. `deploy.sh` (local) → SSH →
  `update.sh` (fetch + checkout) → that commit's `remote-deploy.sh`: build → one-off `migrate` →
  `up -d` → deep health check (roll back to the previous image on failure). GitHub Actions runs
  checks only (CI) and holds no server credentials; no container registry.

## 8. Phase 2 product: dead man's switch contract (Base)

- `DeadMansSwitchFactory` → one EIP-1167 clone per switch (isolated funds, creatable directly on-chain).
- State: `owner`, `agent`, `beneficiary` (safe address), `ttl` (min/max bounds), `lastPing`, `triggered`.
- `deposit` (ETH + ERC-20 via SafeERC20); `ping()` — **agent or owner**;
  `trigger()` — anyone once `block.timestamp > lastPing + ttl`: moves ETH + registered tokens,
  terminal state; `sweep(token)` — anyone after trigger, for leftovers;
  `withdraw`, `setAgent`, `setTtl`, `setBeneficiary`, `addToken`/`removeToken` — owner only, pre-trigger.
- Registered token list capped at **20** (bounded loop in `trigger()`).
- **Fee-on-transfer / rebasing tokens:** contract never trusts stored balances — it always transfers
  `balanceOf(this)`; behaviour documented in NatSpec + README and covered by tests with a mock FoT token.
- OpenZeppelin v5, `ReentrancyGuard` + checks-effects-interactions, not upgradeable, events for every state change.
- Tests: unit, fuzz (ttl/time bounds), invariants ("funds only reach owner or beneficiary",
  "trigger impossible before deadline"); Slither in CI.
- Keeper: worker watches events and calls `trigger()` from a low-balance hot wallet.

## 9. Phases (amended order)

Each phase ends with passing tests, then commit + push.

| Order | #   | Phase     | Contents                                                                                                      |
| ----- | --- | --------- | ------------------------------------------------------------------------------------------------------------- |
| 1     | 0   | Skeleton  | TS, lint, vitest, dev compose, config, migrations, `/healthz`, CI                                             |
| 2     | 1   | Auth      | SIWE challenge/verify, API keys, rate limits, idempotency, account freeze admin CLI                           |
| 3     | 2   | Jobs      | CRUD, scheduler, SSRF-guarded delivery, HMAC, retry/backoff, run history, per-host global limit               |
| 4     | 3   | Heartbeat | monitors, ping, dead/alive, webhook + Telegram alerts, 30-day retention cleanup                               |
| 5     | 6   | Infra     | prod compose, Caddy, provisioning, backup/restore, deploy pipeline, monitoring — **go live on the free tier** |
| 6     | 4   | Billing   | $0.10 activation, quotas, credit ledger, x402 (docs re-checked, Sepolia first)                                |
| 7     | 5   | Discovery | OpenAPI, llms.txt, well-known, MCP server                                                                     |
| 8     | 7   | Contract  | Foundry, tests, keeper                                                                                        |
| 9     | 8   | README    | human quickstart, agent section (curl + MCP config), Hetzner deploy + restore guide                           |

## 10. Defaults

1. Prices: $1 = 2,000 runs, $0.25/monitor/month, packs $1/$5/$20; activation $0.10.
2. Webhook targets: `https` only, ports 443/8443; min cron interval 1 min; min TTL 60 s.
3. Telegram: one bot of ours; users link a chat via deep link `/start <token>`.
4. MCP: remote `/mcp` first; stdio npm package later if needed.
5. Contract: ETH + ERC-20, agent **and owner** may ping, not upgradeable.
6. Network: Base Sepolia in development, Base mainnet in production behind config.

## 11. Amendments (approved 2026-09-29)

1. **Abuse protection**
   - Global rate limit **per target host** across all accounts (protects third parties from being
     hammered through us).
   - Free tier is activated only after a one-off **$0.10 x402 payment**. Until billing ships,
     free-tier limits are **1 monitor + 50 runs/month**.
   - **Account freeze** via admin CLI (`npm run admin -- freeze <account|address> --reason …` /
     `unfreeze`). Frozen accounts: API calls rejected (403), jobs not executed, pings accepted but no alerts.
2. **Order:** 0 → 1 → 2 → 3 → 6 (infra, live on free tier) → 4 → 5 → 7 → 8.
3. **Retention:** `job_runs`, `monitor_events` and `alert_deliveries` kept **30 days**; cleanup runs in the worker.
4. **Contract:** max **20** registered tokens; fee-on-transfer tokens documented and tested;
   the **owner may also ping**.
5. Repository content (code, comments, docs) is written in **English**.

## 12. As built: discovery + MCP (phase 5)

- `/mcp`: remote MCP server (official `@modelcontextprotocol/sdk`, web-standard Streamable HTTP
  transport, **stateless** — a fresh server per request, `GET`/`DELETE` answer 405). Tools wrap
  the REST API in-process (`app.fetch`), forwarding the caller's connection so per-IP limits apply.
  Beyond the planned tools: `list_monitors`, `trigger_job`, `activate`, `buy_credits`.
- x402 over MCP uses the official x402 MCP transport (`@x402/mcp`): PaymentRequired as an
  `isError` tool result with `structuredContent`; payment in `_meta["x402/payment"]`, receipt in
  `_meta["x402/payment-response"]`. Tested with `createx402MCPClient`.
- Well-known: the MCP Server Card (SEP-1649 path `/.well-known/mcp/server-card.json`, alias
  `/.well-known/mcp.json`) — SEP-2127 (`server-cards.json`, AI Catalog) is still in review, revisit
  when it lands. x402 Bazaar listing is not a well-known file: the CDP facilitator indexes
  resources at settlement (`extensions.bazaar`), so it comes with the mainnet facilitator.
