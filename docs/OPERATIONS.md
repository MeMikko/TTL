# Operations runbook — time2live.xyz on Hetzner

Everything needed to build the production server from nothing, deploy, back up, restore and
monitor. Commands marked **(local)** run on your workstation (Linux/macOS, WSL or Git Bash on
Windows; PowerShell alternatives are noted). Commands marked **(server)** run over
`ssh deploy@<server>`.

```
Internet ─┬─ Hetzner Cloud Firewall (22, 80, 443 tcp; 443 udp; icmp)
          └─ ufw (same ports) ─ Caddy :80/:443 (TLS, Let's Encrypt)
                                   └─ api :3000 ── postgres (no published port)
                                      worker ──────┘  └─ daily pg_dump → restic → Storage Box
```

Server layout: `/opt/time2live/src` is a git checkout of this repository (read-only deploy
key); images are **built on the server** from it — no registry, no GitHub secrets.
`/opt/time2live/` holds the running `docker-compose.yml`, `Caddyfile`, `.env` (secrets,
chmod 600), `backup.sh`, `restore.sh` (copied from the checkout by each deploy). Backup
configuration lives in `/etc/time2live/` (root only). Containers use `restart: unless-stopped`;
Docker starts on boot. GitHub Actions only runs checks (CI); it has no access to the server.

---

## 1. Create the server (once)

**Option A — Windows PowerShell, no extra tools (local):**

```powershell
ssh-keygen -t ed25519 -f $HOME\.ssh\time2live      # once; give it a passphrase
$env:HCLOUD_TOKEN = "<token>"                      # Hetzner Console → project → Security → API tokens (Read & Write)
.\deploy\create-server.ps1                         # defaults: cx23, hel1, ubuntu-24.04, $HOME\.ssh\time2live.pub
```

It uploads the SSH key, creates (or updates) the Cloud Firewall — inbound tcp 22/80/443,
udp 443, icmp — and creates the server with the cloud-init that runs `deploy/provision.sh`,
then prints the IPv4/IPv6 addresses, the DNS records and an `~/.ssh/config` entry. Re-running it
is safe (existing objects are reused, firewall rules re-applied). `-DryRun` only writes
`cloud-init.yaml` for pasting into the console. Parameters: `-ServerType`, `-Location`,
`-Name`, `-KeyPath`.

**Option A2 — hcloud CLI (Linux/macOS/WSL):**

```sh
export HCLOUD_TOKEN=…                       # Hetzner Console → project → Security → API tokens
hcloud server-type list                     # pick a type, e.g. 2 vCPU / 4 GB
SERVER_TYPE=<type> LOCATION=hel1 deploy/hcloud-setup.sh ~/.ssh/id_ed25519.pub
```

This creates the SSH key entry, a Cloud Firewall (22/80/443 tcp, 443 udp, icmp) and an
Ubuntu 24.04 server whose cloud-init runs `deploy/provision.sh` on first boot.

**Option B — Hetzner Console:** create an Ubuntu 24.04 server, attach a firewall with the rules
above, and paste the output of `deploy/make-cloud-init.sh ~/.ssh/id_ed25519.pub` as _Cloud config_.

**Option C — existing server:** copy `deploy/` over and run
`sudo DEPLOY_SSH_KEY="$(cat id_ed25519.pub)" bash deploy/provision.sh`. It is idempotent.

`provision.sh` sets up: user `deploy` (key-only, `docker` group and passwordless sudo),
`PermitRootLogin no`, no password/keyboard-interactive auth, `AllowUsers deploy`, ufw,
fail2ban (sshd), unattended upgrades with automatic reboot at 04:30 UTC when required, Docker
Engine + compose plugin with log rotation (10 MB × 5 per container), 2 GB swap, restic, a
read-only GitHub deploy key for the `deploy` user (GitHub's host keys pinned from
`api.github.com/meta` over HTTPS), the app and backup directories and the backup timer. It
refuses to harden SSH if the deploy user has no key, so it cannot lock you out.

Verify after a few minutes **(local)**:

```sh
ssh deploy@<ip> 'sudo tail -n 20 /var/log/time2live-provision.log; docker version --format {{.Server.Version}}'
ssh root@<ip>          # must fail: Permission denied (publickey)
```

> The deploy user's SSH key is effectively root on the server (docker + sudo). Give it a
> passphrase (or a hardware key) on your machine. It never needs to leave your machine.

**Repository access (once).** The end of the provisioning log prints the server's public
deploy key. Add it in GitHub → MeMikko/TTL → Settings → Deploy keys → _Add deploy key_
(leave "Allow write access" **unchecked**), then **(server)**:

```sh
cat ~/.ssh/github_deploy.pub                     # if you need the key again
git clone git@github.com:MeMikko/TTL.git /opt/time2live/src
```

If the provisioning log warned that GitHub's host keys could not be fetched, add them by hand
and compare the fingerprints with the ones GitHub publishes ("GitHub's SSH key fingerprints" in
GitHub Docs) before cloning:
`ssh-keyscan github.com > ~/.ssh/known_hosts_github && ssh-keygen -lf ~/.ssh/known_hosts_github`.

## 2. DNS

At your DNS provider: `A time2live.xyz → <IPv4>`, `AAAA time2live.xyz → <IPv6>`, and the same
for `www` (Caddy redirects `www` to the apex). Caddy obtains certificates automatically once DNS
resolves and ports 80/443 are reachable.

## 3. Application configuration **(server)**

```sh
cd /opt/time2live
cp src/deploy/.env.production.example .env
chmod 600 .env
openssl rand -hex 32                   # → POSTGRES_PASSWORD (hex: it goes into a URL)
openssl rand -base64 32                # → ENCRYPTION_KEY
nano .env                              # DOMAIN, ACME_EMAIL, PUBLIC_BASE_URL, SERVER_PUBLIC_IPS, …
```

`ENCRYPTION_KEY` encrypts stored job headers and webhook signing secrets. Losing it makes them
unreadable — it is included in the encrypted backups (§5), and you should also keep a copy of
`.env` in your password manager.

## 4. Deploying

Push your commits to GitHub first (CI runs the checks there), then **(local)**:

```sh
deploy/deploy.sh time2live               # the commit you have checked out (must be pushed)
deploy/deploy.sh time2live main          # latest origin/main
deploy/deploy.sh time2live <sha>         # any pushed commit — this is also how you roll back
# Windows PowerShell:
.\deploy\deploy.ps1 -Target time2live [-Ref main|<sha>]
```

(`time2live` is a host entry in `~/.ssh/config`; `deploy@<ip>` works too.) Or directly on the
server: `/opt/time2live/src/deploy/update.sh [ref]`.

What happens: `update.sh` fetches from GitHub and checks out the commit, then hands over to
**that commit's** `remote-deploy.sh`, which: builds `time2live:<sha12>` on the server (skipped if
that commit was built before) → installs its compose file, Caddyfile and scripts into
`/opt/time2live` → starts Postgres → **runs migrations** (`docker compose run --rm migrate`) →
starts api, worker and Caddy → waits for `GET /healthz?deep=1` (database + a fresh worker tick).

- Build fails → nothing changes.
- Migration fails → the running release is left untouched.
- New release unhealthy → the previous image and deployment files are started again automatically.

The running tag is kept in `IMAGE_TAG` in `.env`, so a plain `docker compose up -d` always
starts the right version. The newest 5 images stay on the server, so rolling back to a recent
commit is instant (no rebuild); the previous tag is in `/opt/time2live/.image-tag.previous`.
Migrations are forward-only, so write them backward compatible (add columns/tables first, remove
old ones in a later release) — a rolled-back release then still runs on the newer schema.

Useful **(server)** commands:

```sh
cd /opt/time2live
docker compose ps
docker compose logs -f --tail 100 api worker     # json logs, rotated by Docker
docker compose exec api node dist/bin/admin.js freeze <acc_…|0x…> --reason "abuse"
```

## 5. Backups

Daily at ~03:15 UTC `time2live-backup.timer` runs `backup.sh`: `pg_dump -Fc` into a temporary
file → verified with `pg_restore --list` (a truncated dump never becomes a snapshot) → `restic
backup` (encrypted, deduplicated) to the Storage Box, plus the app `.env` as a separate `config`
snapshot → retention 7 daily / 4 weekly / 6 monthly → weekly `restic check` of 10 % of the data →
POST to the backup heartbeat monitor.

One-time setup **(server)**:

```sh
sudo -i
# 1. SSH key for the Storage Box (port 23, relative paths — Hetzner docs)
ssh-keygen -t ed25519 -N '' -f /root/.ssh/storagebox_ed25519
cat /root/.ssh/storagebox_ed25519.pub | ssh -p23 uXXXXX@uXXXXX.your-storagebox.de install-ssh-key
cat >> /root/.ssh/config <<'EOF'
Host storagebox
  HostName uXXXXX.your-storagebox.de
  User uXXXXX
  Port 23
  IdentityFile /root/.ssh/storagebox_ed25519
  IdentitiesOnly yes
EOF
ssh storagebox ls            # accept and verify the host key once
# 2. repository password — ALSO store it in your password manager: without it backups are useless
openssl rand -base64 32 > /etc/time2live/restic-password && chmod 600 /etc/time2live/restic-password
# 3. check /etc/time2live/backup.env (RESTIC_REPOSITORY=sftp:storagebox:time2live-restic) and run once
systemctl start time2live-backup.service && journalctl -u time2live-backup -n 30 --no-pager
systemctl list-timers time2live-backup.timer
```

## 6. Restore (tested procedure)

`restore.sh` (server, as root via `sudo`) never touches the live database unless asked:

```sh
cd /opt/time2live
sudo ./restore.sh --list                      # snapshots (db and config)
sudo ./restore.sh                             # latest → NEW database time2live_restore_<ts>
sudo ./restore.sh <snapshot-id>               # a specific snapshot, same
sudo ./restore.sh latest --in-place           # replace the live DB (asks to type its name)
sudo ./restore.sh --config > /tmp/env         # backed-up .env (contains secrets!)
```

`--in-place` stops api and worker, terminates connections, drops and recreates the database,
restores with `pg_restore --exit-on-error`, and starts api and worker again.

**Disaster recovery on a brand-new server:**

1. Create and provision a server (§1), point DNS at it (§2).
2. Recreate `/root/.ssh/config`, the Storage Box key (§5 step 1 — install the new key) and
   `/etc/time2live/restic-password` from your password manager.
3. Add the new server's deploy key to GitHub and clone (§1), then **(server)**
   `cd /opt/time2live && sudo BACKUP_ENV_FILE=/etc/time2live/backup.env src/deploy/restore.sh --config > .env && chmod 600 .env`
   — this restores `ENCRYPTION_KEY` and the Postgres credentials.
4. Deploy the last good commit (`IMAGE_TAG` in the restored `.env` is its SHA prefix):
   `deploy/deploy.sh time2live <sha>`. This builds the image and starts an empty, migrated database.
5. `sudo ./restore.sh latest --in-place --yes`, then `curl -fsS https://time2live.xyz/healthz?deep=1`.

**Test record (2026-09-29, local replica of the production stack):** production compose with
Caddy (internal TLS), Postgres and the real image; data created through the HTTPS API (wallet
sign-in, a job with an encrypted header, a monitor); `backup.sh` to a restic repository;
`docker compose down -v` (containers **and the database volume** destroyed); fresh deploy
(empty migrated DB — the old API key was rejected with 401); `restore.sh latest --in-place
--yes`; afterwards the same API key worked, the job (headers still decryptable) and the monitor
were back, `/healthz?deep=1` was ok, and the next deploy ran its migrations as a no-op. The
restore into a separate database and the `config` snapshot round-trip were verified too.
The only difference from production is the repository backend (local path instead of
`sftp:storagebox:…`); repeat the drill on the real server after setting up §5 — it takes a
few minutes and is the only proof that counts.

## 7. Monitoring

Three independent layers:

1. **External uptime check** (catches "the whole server is down", which nothing on the server
   can report). Use a monitoring service running outside this server (e.g. UptimeRobot or Better Stack) to poll `https://time2live.xyz/healthz?deep=1` every 1–5 min and alert on non-200.
   `deep=1` returns 503 when Postgres is unreachable **or the worker has not ticked for 2
   minutes**, so a stopped worker is caught even though it cannot alert about itself.
2. **Dogfooding — the service watches itself** with its own heartbeat feature. Create operator
   monitors **(server)**:

   ```sh
   docker compose exec api node dist/bin/admin.js create-monitor 0xYOUR_WALLET \
     --name worker --ttl 120 --grace 60 --telegram
   docker compose exec api node dist/bin/admin.js create-monitor 0xYOUR_WALLET \
     --name backup --ttl 90000 --grace 3600 --telegram
   ```

   Put the first ping URL into `.env` as `SELF_HEARTBEAT_URL` (the worker pings it on every
   tick) and the second into `/etc/time2live/backup.env` as `BACKUP_HEARTBEAT_URL`. To receive the alerts in Telegram (§8), print a link with
   `docker compose exec api node dist/bin/admin.js telegram-link 0xYOUR_WALLET`, open it and press
   Start (or set `alerts.webhookUrl` on the monitors). This catches a stuck delivery
   queue, broken outbound networking or a failed nightly backup.

3. **Logs:** `docker compose logs` (JSON, rotated 10 MB × 5 per container). Caddy access logs
   are JSON on stdout as well.

**Operator dashboard:** `https://<domain>/dashboard` lets the account owner connect their wallet,
sign once (a 1 h operator session, not stored server-side) and see the fleet read-only, with
**Pause everything** and **Revoke all API keys** emergency buttons. It needs no server
configuration. The revoke button cuts every API key at once (agents are locked out); the operator
session survives it, so you don't lock yourself out. Nothing here is required for the service to
run — it is a supervisory convenience.

**Analytics:** `https://<domain>/analytics` shows live, fleet-wide statistics (accounts, monitors,
jobs, runs in the last 24 h, revenue, on-chain switches), refreshed every few seconds. It uses the
same wallet sign-in but is gated to a single operator wallet: set `ANALYTICS_ADDRESS` to that wallet
(compared lowercased). Any other wallet gets `403`, and an empty `ANALYTICS_ADDRESS` disables the
page and its `/v1/analytics` endpoint entirely (`404`).

## 8. Telegram bot (optional)

Create a bot with @BotFather, then set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and
`TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`) in `.env`, run
`docker compose up -d api worker` and register the webhook once:
`docker compose exec api node dist/bin/admin.js telegram-webhook`.

## 8a. Email alerts (optional, recommended)

An independent alert channel that does not share fate with customer webhooks or the Telegram API:
it goes out through an external transactional-email provider (Resend-compatible HTTP API). This is
the redundancy that keeps a dead man's switch honest — if a monitor's webhook endpoint is down,
the email still fires. (If the whole VPS is down, the external uptime check in §7 is the backstop.)

Set in `.env`:

```sh
RESEND_API_KEY=re_…
ALERT_EMAIL_FROM=time2live <alerts@time2live.xyz>   # a verified sender/domain at the provider
# EMAIL_API_BASE=https://api.resend.com             # override for a Resend-compatible provider
```

`docker compose up -d --force-recreate worker`. With it set, monitors may use `alerts.email`
(and the API accepts it); without it, `alerts.email` is rejected with `422 email_not_configured`
so a switch is never created believing it can email when it cannot. Agents can also register a
second independent webhook via `alerts.webhookUrl2`, delivered separately from the primary.

## 8b. Payments (x402)

Payments are off until `X402_ENABLED=true`. Start on **Base Sepolia**:

```sh
# .env
X402_ENABLED=true
X402_NETWORK=eip155:84532
X402_PAY_TO=0x…          # wallet that receives USDC; keep its key off the server
```

`docker compose up -d api worker`, then check `GET /v1/billing` (with an API key) shows
`x402.enabled: true`. Test end to end with a wallet holding Sepolia USDC (Circle faucet): a
second monitor on a fresh account must return 402 and succeed after paying $0.10.

**Mainnet:** the public `https://x402.org/facilitator` supports testnets only (a mainnet config
pointing at it is rejected at startup). Use Coinbase CDP, which serves Base and Base Sepolia:

```sh
X402_NETWORK=eip155:8453                  # eip155:84532 to try CDP on Sepolia first
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=…                          # a CDP *Secret* API key (portal → API Keys),
CDP_API_KEY_SECRET=…                      # not a Client API key
```

CDP accepts no static header: every verify/settle/supported call is sent with a fresh JWT (valid
2 minutes, bound to that method and path) signed with the key, so leave
`X402_FACILITATOR_AUTHORIZATION` unset — it is only for facilitators that take a static
`Authorization` header. An EC (PEM) secret may be written on one line with `\n` escapes. The
deployment's network mode (live / testnet / disabled) is derived from this and shown on `/`,
`/llms.txt`, the landing page, the dashboard and the OpenAPI description, so it must reflect
reality. If the keeper is also enabled it must be on the same network — a mixed testnet/mainnet
deploy is rejected at startup.
Payments are recorded in `payments`, balance movements in `credits_ledger`
(`npm run admin -- show` shows the balance).

## 8c. On-chain dead man's switch: deploy + keeper

**Deploy the factory** (once per chain, from your own machine; details in `contracts/README.md`):

```sh
cd contracts
cast wallet import deployer --interactive
forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast
```

The deployer wallet needs a little Base Sepolia ETH (faucet). Note the printed factory address
and block. The address is the same on every chain.

**Keeper hot wallet:** generate a fresh key just for the keeper (`cast wallet new`) and fund it
with a few dollars of ETH. It only ever pays gas for `trigger()`, and its key lives only in the
server's `.env`. Then add to `.env`:

```sh
KEEPER_ENABLED=true
KEEPER_CHAIN_ID=84532                     # 8453 for Base mainnet
KEEPER_RPC_URL=https://sepolia.base.org   # a provider URL (Alchemy/QuickNode) is more reliable
KEEPER_FACTORY_ADDRESS=0x…
KEEPER_FROM_BLOCK=<block printed by the deploy script>
KEEPER_PRIVATE_KEY=0x…
```

`docker compose up -d --force-recreate worker`. The worker logs `keeper started`. It refuses to
run against an RPC for the wrong chain.

**How it works:** each `KEEPER_POLL_MS` (60 s) the keeper scans new `SwitchCreated` logs, in
confirmed blocks only (`KEEPER_CONFIRMATIONS`), resuming from `keeper_cursors`. It re-reads
switches that are due, or that it hasn't checked for 30 minutes, and calls `trigger()` on
expired ones after simulating the call. A deadline can only move earlier through `setTtl`, which
also pings (≥ now + 1 h), so the 30-minute refresh never misses an expiry.

**Safety limits:**

- The keeper sends nothing when the network max fee is above `KEEPER_MAX_FEE_GWEI` (default 1;
  Base is usually ~0.01).
- It never triggers an **empty** switch (no ETH and no balance of a registered token): creating
  one costs an attacker gas, but triggering it would cost the keeper gas for nobody's benefit.
  Such switches are marked `skipped_at` and re-checked only on the 30-minute refresh, so assets
  deposited later still get delivered.
- Every trigger is sent with an explicit gas limit (the node's estimate + 20%), and a switch whose
  `trigger()` would need more than `KEEPER_MAX_GAS` (default 1,500,000; a full 20-token switch
  needs ~0.9M) is skipped the same way. This stops a hostile token that burns all the gas its
  `transfer` is given from draining the hot wallet: one trigger never costs more than
  `KEEPER_MAX_GAS × KEEPER_MAX_FEE_GWEI` (0.0015 ETH at the defaults; ~0.000007 ETH at Base's
  usual fee).
- Expired switches that are not skipped are always checked first, so skipped switches and the
  slow refresh cannot delay a real expiry.
- Triggering stays permissionless: a skipped switch can still be triggered by its beneficiary or
  anyone else.
- It logs `keeper balance low` below `KEEPER_MIN_BALANCE_ETH`.
- State is in `keeper_switches` (`deadline`, `triggered_at`, `trigger_tx`, `skipped_at`,
  `last_error`).

If the keeper is down, nothing is lost: `trigger()` is permissionless, and the next pass catches
up.

## 8d. Testnet dry-run (Base Sepolia)

Prove the whole payment and contract flow on Base Sepolia before touching mainnet. The factory is
deployed deterministically (CREATE2), so the mainnet address is identical regardless — a testnet
run costs nothing and does not "use up" the address. Two independent tests; do either or both.

### Prerequisites (once, on your own machine)

- Foundry: `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
- Three test wallets: **deployer** (publishes the factory), **keeper** (hot wallet paying
  `trigger()` gas), **beneficiary** (any address the switch sends to). `cast wallet new` makes one.
- Fund deployer + keeper with a little Base Sepolia ETH (a Base Sepolia faucet). ~0.01 ETH each.

### A. Publish the factory to Sepolia

```sh
cd contracts
cast wallet import deployer --interactive          # paste the deployer private key, set a password
forge script script/Deploy.s.sol --rpc-url base_sepolia --account deployer --broadcast
```

Record from the output: `KEEPER_FACTORY_ADDRESS 0xFAC…` and `KEEPER_FROM_BLOCK <N>`. The script
prints the real deterministic CREATE2 address (under `--broadcast` it differs from the simulated
one, so trust this printed line). Verify it before wiring the keeper:
`cast call 0xFAC… "totalSwitches()(uint256)" --rpc-url base_sepolia` should return `0`.

Verify the source on Basescan (free; a switch holds funds, so people should be able to read it).
Add `--verify --etherscan-api-key "$ETHERSCAN_API_KEY"` to the deploy, or afterwards verify the
factory and the implementation (the clones are EIP-1167 proxies and link to the verified
implementation automatically):

```sh
export ETHERSCAN_API_KEY=…
IMPL=$(cast call 0xFAC… "implementation()(address)" --rpc-url base_sepolia)
forge verify-contract 0xFAC… src/DeadMansSwitchFactory.sol:DeadMansSwitchFactory --chain 84532 --watch
forge verify-contract "$IMPL" src/DeadMansSwitch.sol:DeadMansSwitch --chain 84532 --watch
```

A `Pending in queue` timeout is not a failure — the submission is queued; re-check with
`forge verify-check <GUID> --chain 84532` or open the address on the explorer. Mainnet: `--chain 8453`.

### B. Enable the keeper (server)

In `/opt/time2live/.env`:

```sh
KEEPER_ENABLED=true
KEEPER_CHAIN_ID=84532
KEEPER_RPC_URL=https://sepolia.base.org            # a provider URL is more reliable
KEEPER_FACTORY_ADDRESS=0xFAC…
KEEPER_FROM_BLOCK=<N>
KEEPER_PRIVATE_KEY=0x…                             # the keeper hot wallet
```

`docker compose up -d --force-recreate worker`, then confirm `keeper started` in
`docker compose logs worker`.

### C. Exercise the on-chain switch

Create a switch (agent = deployer, ttl = 1 h minimum, 0.001 ETH deposited), then find its address:

```sh
cast send 0xFAC… "createSwitch(address,address,uint64,address[],bytes32)" \
  <DEPLOYER_ADDR> <BENEFICIARY_ADDR> 3600 "[]" \
  0x0000000000000000000000000000000000000000000000000000000000000001 \
  --value 0.001ether --rpc-url base_sepolia --account deployer
cast call 0xFAC… "getSwitchesByOwner(address)(address[])" <DEPLOYER_ADDR> --rpc-url base_sepolia
```

Within ~60 s the keeper should record it:

```sh
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c "select address, deadline, triggered_at, trigger_tx from keeper_switches;"
```

`ping()` resets the deadline (`cast send 0xSWITCH… "ping()" …`). The TTL minimum is 1 h and chain
time cannot be fast-forwarded on a live chain, so the expiry test takes ~1 h of wall-clock; the
keeper then triggers on its next 60 s poll. Verify:

```sh
cast call 0xSWITCH… "status()(bool,bool,uint64,uint64,uint64)" --rpc-url base_sepolia  # triggered=true
cast balance <BENEFICIARY_ADDR> --rpc-url base_sepolia                                  # received 0.001 ETH
docker compose logs --tail 30 worker | grep -i "keeper triggered"
```

The trigger, sweep and fund-safety logic is exhaustively covered by the Foundry unit, fuzz and
invariant tests; this live run only confirms the keeper, RPC and gas against a real chain.

### D. Exercise x402 payments

x402 must be enabled (§8b). Get a little Base Sepolia USDC into a test wallet from the Circle
faucet (Base Sepolia USDC is `0x036CbD53842c5426634e7929541eC2318f3dCF7e`). Then, from the repo
root (its `@x402` dependencies are used), register an account, let the first monitor use the free
tier, and pay the `$0.10` activation to create a second one — retried in a single call by an x402
client:

```sh
PK=0xAGENT_KEY node --input-type=module <<'EOF'
import { privateKeyToAccount } from 'viem/accounts';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
const BASE = 'https://time2live.xyz';
const wallet = privateKeyToAccount(process.env.PK);
const post = (p, b, h = {}) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) });
const { message } = await (await post('/v1/auth/challenge', { address: wallet.address, chainId: 8453 })).json();
const { apiKey } = await (await post('/v1/auth/verify', { message, signature: await wallet.signMessage({ message }) })).json();
const auth = { authorization: `Bearer ${apiKey.key}` };
await post('/v1/monitors', { name: 'a', ttlSeconds: 300 }, auth);
const pay = wrapFetchWithPayment(fetch, new x402Client().register('eip155:84532', new ExactEvmScheme(wallet)));
const res = await pay(BASE + '/v1/monitors', { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ name: 'b', ttlSeconds: 300 }) });
console.log('paid create', res.status, res.headers.get('payment-response') ? '(receipt present)' : '');
console.log('billing', await (await fetch(BASE + '/v1/billing', { headers: auth })).json());
EOF
```

Expected: `paid create 201 (receipt present)` and `/v1/billing` shows `activated: true`; on-chain
a USDC transfer to `X402_PAY_TO` appears.

### Promote to mainnet

**First, undo what test USDC bought** (credits, activations and paid monitor periods are not
tied to a network, so they would carry over as real service). On the server:

```sh
docker compose exec api node dist/bin/admin.js reset-testnet-billing            # dry run
docker compose exec api node dist/bin/admin.js reset-testnet-billing --confirm
```

It zeroes every balance (logged as `testnet_reset` in `credits_ledger`), clears activations and
ends paid monitor periods now: the worker then pauses those monitors with a `monitor.unpaid`
alert, exactly as when credits run out. Accounts, keys, monitors, jobs and the payment history
stay. It refuses once any mainnet payment is recorded. Run it right before switching `.env`.

Once both pass and you trust them: rerun **A** with `--rpc-url base` (same factory address), set
`KEEPER_CHAIN_ID=8453` with a mainnet RPC, and for x402 switch `X402_NETWORK=eip155:8453` with a
mainnet facilitator (the public `x402.org` one is testnet-only; Coinbase CDP with
`CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`, see §8b). Consider a light audit before holding significant funds in the
contract.

## 9. Security checklist

- Only Caddy publishes ports; Postgres has no `ports:` (Docker-published ports would bypass ufw).
- Cloud Firewall + ufw: 22/80/443 only. SSH: keys only, no root, `AllowUsers deploy`, fail2ban.
- Secrets exist only in `/opt/time2live/.env` and `/etc/time2live/` on the server (and in your
  password manager) — never in the repository. GitHub holds no credentials for the server; the
  server's GitHub deploy key is read-only and limited to this repository.
- Containers run as non-root with a read-only filesystem, `no-new-privileges` and all
  capabilities dropped.
- Webhook targets are SSRF-filtered at creation and at connect time; set `SERVER_PUBLIC_IPS`.
- Automatic security updates with reboot at 04:30 UTC; containers come back by themselves.

## 10. Windows notes

Use WSL (recommended) or Git Bash for the `.sh` scripts; `deploy\deploy.ps1` works in plain
PowerShell with the built-in OpenSSH client. `.gitattributes` forces LF endings for `*.sh`, so
scripts stay runnable even when the repository is checked out on Windows.

## 11. Sandbox instance (full-time testnet)

A permanent public **sandbox** on `testnet.time2live.xyz` lets agent developers integrate against
the real API — including the x402 payment path — without risking real USDC. It is a **second
Compose stack on the same host** as production, pointed at Base Sepolia, with `SANDBOX=true`.

Guardrails (keep it a sandbox, not a free production backend):

- **`SANDBOX=true`** labels every surface (`/`, `/llms.txt`, landing, terms) as a sandbox and
  surfaces the rolling-wipe policy.
- **Rolling wipe:** the worker deletes whole accounts (and all their data, by cascade) older than
  `SANDBOX_DATA_TTL_HOURS` (default 168 = 7 days). Nobody can run real workloads on something that
  resets weekly. `HISTORY_RETENTION_DAYS` is shorter too (7).
- **Tighter quotas** via env (`MAX_JOBS_PER_ACCOUNT`, `RATE_LIMIT_*`).
- **x402 stays ON** with the free public facilitator and testnet USDC, so the payment path is
  exercised end to end at no real cost (no CDP key needed on testnet).

Setup:

1. **Contract:** deploy the current (`audit-v1`) factory to Base Sepolia (§8a / §8d) and note its
   address — the pre-existing Sepolia factory is older bytecode. Put the new address in
   `KEEPER_FACTORY_ADDRESS`.
2. **Env:** copy `deploy/.env.sandbox.example` to `/opt/time2live-sandbox/.env`, fill
   `POSTGRES_PASSWORD`, `ENCRYPTION_KEY` (distinct from production), `X402_PAY_TO`, and a
   faucet-funded `KEEPER_PRIVATE_KEY`.
3. **Stack:** run it as a separate Compose project with its own volume and an env-file override,
   e.g. `docker compose -p t2l-sandbox --env-file /opt/time2live-sandbox/.env --profile app up -d`.
   Keep its Postgres unpublished, same as production.
4. **DNS + TLS:** point `testnet.time2live.xyz` at the host; Caddy issues the certificate
   automatically (`DOMAIN`/`PUBLIC_BASE_URL` in the sandbox env).
5. **Keeper gas:** top up the Sepolia keeper wallet from a faucet when it runs low (free).

Because it shares the host, the sandbox shares production's single-node failure domain — acceptable
for a no-SLA testnet. The rolling wipe keeps its database small.
