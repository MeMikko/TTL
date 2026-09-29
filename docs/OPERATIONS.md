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
   tick) and the second into `/etc/time2live/backup.env` as `BACKUP_HEARTBEAT_URL`. Sign in
   with the same wallet (README) and call `POST /v1/account/telegram/link` to receive the alerts
   in Telegram (or set `alerts.webhookUrl` on the monitors). This catches a stuck delivery
   queue, broken outbound networking or a failed nightly backup.

3. **Logs:** `docker compose logs` (JSON, rotated 10 MB × 5 per container). Caddy access logs
   are JSON on stdout as well.

## 8. Telegram bot (optional)

Create a bot with @BotFather, then set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` and
`TELEGRAM_WEBHOOK_SECRET` (`openssl rand -hex 32`) in `.env`, run
`docker compose up -d api worker` and register the webhook once:
`docker compose exec api node dist/bin/admin.js telegram-webhook`.

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
