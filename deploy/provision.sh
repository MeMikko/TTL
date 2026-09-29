#!/usr/bin/env bash
# Idempotent provisioning for a fresh Ubuntu 24.04 LTS server (Hetzner Cloud). Run as root:
#   DEPLOY_SSH_KEY="ssh-ed25519 AAAA… you@laptop" bash provision.sh
# Safe to re-run. Via cloud-init it runs automatically on first boot (make-cloud-init.sh).
#
# Result: user `deploy` (key-only SSH, `docker` + passwordless sudo), root login and passwords disabled,
# ufw allowing only 22/80/443, fail2ban for sshd, unattended security upgrades (with automatic
# reboot at 04:30 UTC when required), Docker Engine + compose plugin with log rotation,
# restic, a read-only GitHub deploy key, /opt/time2live for the app and the daily backup timer.
set -Eeuo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/time2live}"
SWAP_SIZE="${SWAP_SIZE:-2G}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log() { printf '\n==> %s\n' "$*"; }
[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
# shellcheck source=/dev/null
. /etc/os-release
[[ "$ID" == "ubuntu" ]] || { echo "Ubuntu required (found $ID)" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# Write a file only when its content changes; returns 0 if it changed.
put() {
  local path="$1" mode="$2" tmp
  tmp="$(mktemp)"
  cat >"$tmp"
  if [[ -f "$path" ]] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  install -D -m "$mode" "$tmp" "$path"
  rm -f "$tmp"
  return 0
}

log "base packages"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get install -y -q ca-certificates curl gnupg sudo openssh-server ufw fail2ban unattended-upgrades restic jq
timedatectl set-timezone UTC 2>/dev/null || ln -sf /usr/share/zoneinfo/UTC /etc/localtime

log "deploy user"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
passwd -l "$DEPLOY_USER" >/dev/null # no password login, ever
home="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$home/.ssh"
auth="$home/.ssh/authorized_keys"
touch "$auth"
if [[ -n "$DEPLOY_SSH_KEY" ]] && ! grep -qxF "$DEPLOY_SSH_KEY" "$auth"; then
  printf '%s\n' "$DEPLOY_SSH_KEY" >>"$auth"
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$auth"
chmod 600 "$auth"
# Never lock ourselves out: SSH hardening below requires a working key for the deploy user.
if ! grep -qE '^(ssh-|ecdsa-|sk-)' "$auth"; then
  echo "no SSH key for $DEPLOY_USER; set DEPLOY_SSH_KEY. Refusing to disable root/password login." >&2
  exit 1
fi

log "sshd hardening"
# sshd uses the first value it reads, so this file (10-) wins over 50-cloud-init.conf.
if put /etc/ssh/sshd_config.d/10-time2live.conf 644 <<CONF; then
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
AllowUsers $DEPLOY_USER
MaxAuthTries 3
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
CONF
  install -d -m 755 /run/sshd # normally created by systemd; needed for `sshd -t`
  sshd -t
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
fi

log "firewall (ufw)"
ufw --force default deny incoming >/dev/null
ufw --force default allow outgoing >/dev/null
ufw limit 22/tcp comment ssh >/dev/null
ufw allow 80/tcp comment http >/dev/null
ufw allow 443/tcp comment https >/dev/null
ufw allow 443/udp comment http3 >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed -n '1,20p'

log "fail2ban"
if put /etc/fail2ban/jail.d/time2live.local 644 <<'CONF'; then
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
CONF
  systemctl restart fail2ban 2>/dev/null || true
fi
systemctl enable --now fail2ban >/dev/null 2>&1 || true

log "unattended upgrades"
put /etc/apt/apt.conf.d/20auto-upgrades 644 <<'CONF' || true
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
put /etc/apt/apt.conf.d/52time2live-unattended 644 <<'CONF' || true
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
CONF

log "docker engine"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Default log rotation for every container; live-restore keeps containers up across dockerd upgrades.
if put /etc/docker/daemon.json 644 <<'CONF'; then
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" },
  "live-restore": true
}
CONF
  systemctl restart docker 2>/dev/null || true
fi
systemctl enable --now docker >/dev/null 2>&1 || true
# Membership of `docker` is root-equivalent anyway, so the deploy user also gets passwordless
# sudo for administration (backups, restore). Protect its SSH key accordingly.
usermod -aG docker "$DEPLOY_USER"
sudoers="$(mktemp)"
printf '%s ALL=(ALL) NOPASSWD:ALL\n' "$DEPLOY_USER" >"$sudoers"
if visudo -cf "$sudoers" >/dev/null; then
  install -m 440 "$sudoers" /etc/sudoers.d/90-time2live
fi
rm -f "$sudoers"

log "swap ($SWAP_SIZE)"
if ! swapon --show=NAME --noheadings | grep -q . && [[ ! -f /swapfile ]]; then
  fallocate -l "$SWAP_SIZE" /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null &&
    swapon /swapfile && echo '/swapfile none swap sw 0 0' >>/etc/fstab || echo "swap setup skipped"
fi

log "git access (read-only GitHub deploy key)"
# The server clones the repository and builds images itself. The key only needs read access to
# this one repository (GitHub → repo → Settings → Deploy keys, "Allow write access" unchecked).
sudo -u "$DEPLOY_USER" -H bash -eu <<'SH'
cd ~
[[ -f .ssh/github_deploy ]] || ssh-keygen -q -t ed25519 -N '' -C "time2live-server" -f .ssh/github_deploy
grep -q '^Host github.com$' .ssh/config 2>/dev/null || cat >>.ssh/config <<'CONF'
Host github.com
  User git
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
  UserKnownHostsFile ~/.ssh/known_hosts_github
CONF
chmod 600 .ssh/config
SH
# Pin GitHub's SSH host keys from its API over HTTPS instead of trusting the first scan.
if keys="$(curl -fsSL --max-time 20 https://api.github.com/meta | jq -er '.ssh_keys[] | "github.com " + .')"; then
  install -m 644 -o "$DEPLOY_USER" -g "$DEPLOY_USER" /dev/stdin "$home/.ssh/known_hosts_github" <<<"$keys"
else
  echo "warning: could not fetch GitHub host keys; add them before cloning (docs/OPERATIONS.md)" >&2
fi

log "application directories"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
install -d -m 700 -o root -g root /etc/time2live /var/backups/time2live
if [[ ! -f /etc/time2live/backup.env ]]; then
  put /etc/time2live/backup.env 600 <<'CONF' || true
# restic repository on the Hetzner Storage Box (see docs/OPERATIONS.md §4)
RESTIC_REPOSITORY=sftp:storagebox:time2live-restic
RESTIC_PASSWORD_FILE=/etc/time2live/restic-password
# BACKUP_HEARTBEAT_URL=https://time2live.xyz/v1/heartbeat/mon_…
CONF
fi

log "backup timer"
if [[ -f "$HERE/systemd/time2live-backup.service" ]]; then
  install -m 644 "$HERE/systemd/time2live-backup.service" "$HERE/systemd/time2live-backup.timer" /etc/systemd/system/
  systemctl daemon-reload 2>/dev/null || true
  # Enabled now; it only succeeds once backup.env, the restic password and the Storage Box key exist.
  systemctl enable time2live-backup.timer >/dev/null 2>&1 || true
fi

log "done"
cat <<MSG
Next steps (docs/OPERATIONS.md):
  1. From your machine, check you can log in: ssh $DEPLOY_USER@<server>
  2. Create $APP_DIR/.env from deploy/.env.production.example (chmod 600)
  3. Configure backups: /etc/time2live/restic-password, Storage Box SSH key, restic init
  4. Add this read-only deploy key to GitHub (repo → Settings → Deploy keys, no write access):
       $(cat "$home/.ssh/github_deploy.pub")
     then clone:  git clone git@github.com:MeMikko/TTL.git $APP_DIR/src
  5. First deploy from your machine: deploy/deploy.sh <ssh-host> main
MSG
