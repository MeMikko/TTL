#!/usr/bin/env bash
# Restore the database from a restic snapshot. Run on the server as root (reads backup.env).
#
#   restore.sh --list                         show snapshots
#   restore.sh [SNAPSHOT]                     restore into a NEW database time2live_restore_<ts>
#                                             for inspection (default snapshot: latest). Safe.
#   restore.sh [SNAPSHOT] --in-place --yes    replace the live database: stops api+worker,
#                                             drops and recreates it, restores, starts them again.
#   restore.sh --file DUMP [...]              use a local dump file instead of restic.
#   restore.sh --config > .env                print the backed-up app config (.env) to stdout.
set -Eeuo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/time2live}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/time2live/backup.env}"
WORK_DIR="${WORK_DIR:-/var/backups/time2live}"

snapshot=latest in_place=0 yes=0 list=0 config=0 file=""
while (($#)); do
  case "$1" in
    --in-place) in_place=1 ;;
    --yes) yes=1 ;;
    --list) list=1 ;;
    --config) config=1 ;;
    --file) file="${2:?--file needs a path}"; shift ;;
    -h | --help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "unknown option $1" >&2; exit 2 ;;
    *) snapshot="$1" ;;
  esac
  shift
done

log() { printf '[restore %s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

if [[ -f "$BACKUP_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$BACKUP_ENV_FILE"
  set +a
fi

if ((list)); then
  restic snapshots
  exit 0
fi
if ((config)); then
  restic dump --tag config "$snapshot" /env
  exit 0
fi

cd "$APP_DIR"
env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
PG_USER="$(env_get POSTGRES_USER)"
PG_DB="$(env_get POSTGRES_DB)"
psql_admin() { docker compose exec -T postgres psql -U "$PG_USER" -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

mkdir -p "$WORK_DIR"
if [[ -z "$file" ]]; then
  file="$WORK_DIR/restore-$$.dump"
  trap 'rm -f "$file"' EXIT
  log "fetching $snapshot from $RESTIC_REPOSITORY"
  restic dump --tag db "$snapshot" /time2live.dump >"$file"
fi
docker compose exec -T postgres pg_restore --list <"$file" >/dev/null
log "dump verified ($(du -h "$file" | cut -f1))"

if ((in_place)); then
  target="$PG_DB"
  if ((!yes)); then
    read -r -p "Replace the LIVE database '$target'? Type the database name to confirm: " answer
    [[ "$answer" == "$target" ]] || { echo "aborted" >&2; exit 1; }
  fi
  log "stopping api and worker"
  docker compose stop api worker
  psql_admin -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '$target' and pid <> pg_backend_pid()" >/dev/null
  psql_admin -c "drop database if exists \"$target\"" -c "create database \"$target\" owner \"$PG_USER\""
else
  target="${PG_DB}_restore_$(date -u +%Y%m%d%H%M%S)"
  psql_admin -c "create database \"$target\" owner \"$PG_USER\""
fi

log "restoring into $target"
docker compose exec -T postgres pg_restore -U "$PG_USER" -d "$target" --no-owner --exit-on-error <"$file"
tables="$(docker compose exec -T postgres psql -U "$PG_USER" -d "$target" -qAt -c \
  "select count(*) from information_schema.tables where table_schema = 'public'")"
log "restored $tables tables into $target"

if ((in_place)); then
  log "starting api and worker"
  docker compose up -d --wait api worker
  log "done. Check: curl -fsS https://\$DOMAIN/healthz?deep=1"
else
  log "inspect with: docker compose exec postgres psql -U $PG_USER -d $target"
  log "drop when done: docker compose exec postgres dropdb -U $PG_USER $target"
fi
