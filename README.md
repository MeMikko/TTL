# time2live.xyz

Scheduling and liveness ("TTL") service for autonomous AI agents. See [docs/PLAN.md](docs/PLAN.md)
for scope, architecture and phases. The full README (agent guide, MCP config, Hetzner deploy and
restore) arrives in the final phase.

## Local development

Requirements: Node 22+, Docker (Docker Desktop on Windows, or WSL2). All commands below work in
PowerShell, WSL and Git Bash.

```sh
cp .env.example .env            # PowerShell: Copy-Item .env.example .env
npm install
docker compose up -d postgres   # Postgres on 127.0.0.1:5432 (+ time2live_test database)
npm run migrate
npm run dev:api                 # http://localhost:3000/healthz
npm run dev:worker              # in another terminal
```

Full stack from the production image: `docker compose --profile app up -d --build`.

| Command                             | Purpose                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `npm test`                          | unit + integration tests (needs Postgres; override with `TEST_DATABASE_URL`) |
| `npm run lint` / `npm run format`   | ESLint / Prettier                                                            |
| `npm run typecheck`                 | TypeScript without emitting                                                  |
| `npm run db:generate -- --name <x>` | generate a SQL migration after editing `src/core/db/schema.ts`               |

## Authentication (wallet sign-in)

Agents authenticate with an EVM wallet — no passwords or email:

1. `POST /v1/auth/challenge` `{"address":"0x…","chainId":8453}` → an EIP-4361 (SIWE) `message`.
2. Sign `message` verbatim with the wallet (EIP-191 `personal_sign`).
3. `POST /v1/auth/verify` `{"message":"…","signature":"0x…","keyName":"my-agent"}` → `apiKey.key`
   (shown once; only its SHA-256 hash is stored). Use it as `Authorization: Bearer t2l_…`.

Challenges are single-use and expire after 5 minutes. EOA signatures are verified offline;
smart-contract wallets (ERC-1271/6492) require `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL`.
The OpenAPI document is served at `/openapi.json`.

## Scheduled jobs

```sh
curl -X POST http://localhost:3000/v1/jobs -H "Authorization: Bearer $T2L_KEY" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: wake-1' -d '{
    "name": "wake agent",
    "schedule": { "type": "cron", "expression": "*/15 * * * *", "timezone": "Europe/Helsinki" },
    "target": { "url": "https://agent.example.com/wake", "method": "POST",
                "headers": { "Authorization": "Bearer my-agent-token" }, "body": { "task": "wake" } },
    "timeoutMs": 10000, "maxAttempts": 5 }'
```

- Schedules: 5-field cron (+ `@hourly`/`@daily`/…, minimum interval 1 min) with an IANA
  timezone, or `{"type":"once","at":"<ISO time>"}`.
- Delivery: `2xx` succeeds; timeouts, network errors, `408/425/429/5xx` are retried with
  exponential backoff (10 s, 20 s, 40 s … ≤ 1 h, ±20 % jitter, `Retry-After` honoured); other
  statuses fail immediately. Every attempt is logged (`GET /v1/runs/{id}`); history is kept 30 days.
- Targets: `https` on ports 443/8443 only. Private, loopback, link-local (incl.
  `169.254.169.254`), CGNAT, ULA, NAT64 and our own IPs are refused — checked at creation and
  again at connect time after DNS resolution; every redirect hop (max 3) is re-validated and
  custom headers are dropped on cross-origin redirects.
- Header values are stored encrypted and never returned.

### Verifying deliveries

Each request carries `T2L-Signature: t=<unix>,v1=<hex>`, `T2L-Delivery-Id` (stable across
retries — use it to deduplicate), `T2L-Attempt`, `T2L-Event`, `T2L-Job-Id` and
`T2L-Scheduled-For`. Get your secret from `GET /v1/account/webhook-secret`.

```js
import crypto from 'node:crypto';

function verify(secret, rawBody, header, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(parts.v1 ?? '', 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
```

## Admin

```sh
npm run admin -- show <accountId|address>
npm run admin -- freeze <accountId|address> --reason "abuse report"
npm run admin -- unfreeze <accountId|address>
# production: docker compose exec api node dist/bin/admin.js …
```

A frozen account gets `403 account_frozen` on every API call and cannot obtain new keys; its
jobs stop producing runs and pending deliveries are cancelled.

`GET /healthz` checks the process only; `GET /healthz?deep=1` also checks Postgres and that a
worker ticked within `HEALTH_MAX_TICK_AGE_MS` (503 otherwise) — point external uptime checks there.
