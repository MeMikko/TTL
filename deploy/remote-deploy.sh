#!/usr/bin/env bash
# Runs ON THE SERVER in the app directory (default /opt/time2live):
#   ./remote-deploy.sh <image-tag>
# pull → start postgres → migrate → start api/worker/caddy → deep health check.
# If the new release is unhealthy, the previous image tag is started again.
# Migrations are forward-only: keep them backward compatible (expand/contract) so that a
# rollback of the code never meets a schema it cannot run against.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
cd "$APP_DIR"

NEW_TAG="${1:?usage: remote-deploy.sh <image-tag>}"
[[ "$NEW_TAG" =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || { echo "invalid tag: $NEW_TAG" >&2; exit 2; }
[[ -f .env ]] || { echo "missing $APP_DIR/.env (see .env.production.example)" >&2; exit 2; }

log() { printf '[deploy %s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
compose() { docker compose "$@"; }

# Read/replace a KEY=value line in .env without sourcing it (values are secrets, not shell).
env_get() { sed -n "s/^$1=//p" .env | tail -n1; }
env_set() {
  if grep -q "^$1=" .env; then
    sed -i "s|^$1=.*|$1=$2|" .env
  else
    printf '%s=%s\n' "$1" "$2" >>.env
  fi
}

deep_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while ((SECONDS < deadline)); do
    if compose exec -T api node -e \
      "fetch('http://127.0.0.1:3000/healthz?deep=1').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" \
      >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
  done
  return 1
}

PREV_TAG="$(env_get IMAGE_TAG)"
log "deploying $NEW_TAG (previous: ${PREV_TAG:-none})"

env_set IMAGE_TAG "$NEW_TAG"
if ! compose --profile tools pull --quiet api worker migrate; then
  log "pull failed; keeping $PREV_TAG"
  env_set IMAGE_TAG "$PREV_TAG"
  exit 1
fi

compose up -d --wait postgres
log "running migrations"
if ! compose run --rm migrate; then
  log "migration failed; the running release was not touched"
  env_set IMAGE_TAG "$PREV_TAG"
  exit 1
fi

compose up -d --remove-orphans --wait --wait-timeout 120 api worker caddy || true
if deep_health; then
  printf '%s\n' "$PREV_TAG" >.image-tag.previous
  log "healthy: $NEW_TAG is live"
  docker image prune -f >/dev/null
  exit 0
fi

log "new release is unhealthy"
compose logs --tail 50 api worker || true
if [[ -n "$PREV_TAG" ]]; then
  log "rolling back to $PREV_TAG"
  env_set IMAGE_TAG "$PREV_TAG"
  compose up -d --wait --wait-timeout 120 api worker caddy || true
  if deep_health; then log "rollback healthy"; else log "ROLLBACK ALSO UNHEALTHY - investigate now"; fi
fi
exit 1
