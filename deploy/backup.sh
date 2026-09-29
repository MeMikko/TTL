#!/usr/bin/env bash
# Daily encrypted database backup to a restic repository (Hetzner Storage Box over SFTP).
# Run by time2live-backup.timer as root. Config: /etc/time2live/backup.env
#   RESTIC_REPOSITORY=sftp:storagebox:time2live-restic
#   RESTIC_PASSWORD_FILE=/etc/time2live/restic-password
#   BACKUP_HEARTBEAT_URL=https://time2live.xyz/v1/heartbeat/mon_…   (optional, recommended)
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/time2live}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/time2live/backup.env}"
WORK_DIR="${WORK_DIR:-/var/backups/time2live}"
DUMP_NAME="time2live.dump"

log() { printf '[backup %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [[ -f "$BACKUP_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi
: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY not set (see $BACKUP_ENV_FILE)}"
[[ -n "${RESTIC_PASSWORD_FILE:-}${RESTIC_PASSWORD:-}" ]] || { echo "restic password not set" >&2; exit 2; }
export RESTIC_REPOSITORY

cd "$APP_DIR"
env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
PG_USER="$(env_get POSTGRES_USER)"
PG_DB="$(env_get POSTGRES_DB)"

mkdir -p "$WORK_DIR"
dump="$WORK_DIR/$DUMP_NAME"
trap 'rm -f "$dump"' EXIT

log "dumping $PG_DB"
docker compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom --no-owner >"$dump"
# A truncated dump must never become a "successful" snapshot.
docker compose exec -T postgres pg_restore --list <"$dump" >/dev/null
log "dump ok ($(du -h "$dump" | cut -f1))"

restic snapshots >/dev/null 2>&1 || { log "initialising repository"; restic init; }
# The dump is already verified, so --stdin is safe here; the snapshot path is always /$DUMP_NAME.
restic backup --tag db --host time2live --quiet --stdin --stdin-filename "$DUMP_NAME" <"$dump"
# The app config holds ENCRYPTION_KEY: without it, stored job headers and webhook secrets in the
# dump are unreadable. It goes into the same (encrypted) repository as its own snapshot.
restic backup --tag config --host time2live --quiet --stdin --stdin-filename env <"$APP_DIR/.env"
restic forget --host time2live --group-by host,tags \
  --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune --quiet
if [[ "$(date -u +%u)" == "7" ]]; then
  log "weekly repository check"
  restic check --read-data-subset=10% --quiet
fi
log "backup complete: $(restic snapshots --tag db --latest 1 --compact | sed -n 3p)"

if [[ -n "${BACKUP_HEARTBEAT_URL:-}" ]]; then
  curl -fsS -m 10 --retry 3 -X POST "$BACKUP_HEARTBEAT_URL" >/dev/null && log "heartbeat sent"
fi
