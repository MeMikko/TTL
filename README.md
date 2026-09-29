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

`GET /healthz` checks the process only; `GET /healthz?deep=1` also checks Postgres and that a
worker ticked within `HEALTH_MAX_TICK_AGE_MS` (503 otherwise) — point external uptime checks there.
