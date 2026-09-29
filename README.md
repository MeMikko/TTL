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

## Admin

```sh
npm run admin -- show <accountId|address>
npm run admin -- freeze <accountId|address> --reason "abuse report"
npm run admin -- unfreeze <accountId|address>
# production: docker compose exec api node dist/bin/admin.js …
```

A frozen account gets `403 account_frozen` on every API call and cannot obtain new keys.

`GET /healthz` checks the process only; `GET /healthz?deep=1` also checks Postgres and that a
worker ticked within `HEALTH_MAX_TICK_AGE_MS` (503 otherwise) — point external uptime checks there.
