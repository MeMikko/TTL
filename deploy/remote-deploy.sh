#!/usr/bin/env bash
# Runs ON THE SERVER, called by update.sh with the commit that is checked out in SRC_DIR:
#   remote-deploy.sh <commit-sha>
# install deployment files → build image on this server (skipped if that commit was built
# before) → start postgres → migrate → start api/worker/caddy → deep health check.
# If the migration fails, the running release is untouched. If the new release is unhealthy,
# the previous image and deployment files are started again.
# Migrations are forward-only: keep them backward compatible (expand/contract) so a rolled-back
# release still runs on the newer schema.
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/time2live}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"
KEEP_IMAGES="${KEEP_IMAGES:-5}"
IMAGE=time2live

SHA="${1:?usage: remote-deploy.sh <commit-sha>}"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || { echo "invalid commit sha: $SHA" >&2; exit 2; }
TAG="${SHA:0:12}"
cd "$APP_DIR"
[[ -f .env ]] || { echo "missing $APP_DIR/.env (see deploy/.env.production.example)" >&2; exit 2; }

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

DEPLOY_FILES=(docker-compose.yml Caddyfile)
# `if` rather than `[[ … ]] && cp`: under `set -e` a false test as the last command would make
# the function fail and silently abort the very first deploy (no previous files yet).
save_previous() {
  for f in "${DEPLOY_FILES[@]}"; do
    if [[ -f "$f" ]]; then cp -p "$f" "$f.previous"; fi
  done
}
restore_previous() {
  for f in "${DEPLOY_FILES[@]}"; do
    if [[ -f "$f.previous" ]]; then cp -p "$f.previous" "$f"; fi
  done
}
install_files() {
  install -m 640 "$SRC_DIR/deploy/docker-compose.prod.yml" docker-compose.yml
  install -m 640 "$SRC_DIR/deploy/Caddyfile" Caddyfile
  install -m 640 "$SRC_DIR/deploy/.env.production.example" .env.production.example
  install -m 750 "$SRC_DIR/deploy/backup.sh" "$SRC_DIR/deploy/restore.sh" .
}

PREV_TAG="$(env_get IMAGE_TAG)"
log "deploying $TAG (previous: ${PREV_TAG:-none})"

if docker image inspect "$IMAGE:$TAG" >/dev/null 2>&1; then
  log "image $IMAGE:$TAG exists; skipping build"
else
  log "building $IMAGE:$TAG"
  # Optional extra flags, e.g. a build proxy: DOCKER_BUILD_FLAGS in the environment or .env.
  build_flags="${DOCKER_BUILD_FLAGS:-$(env_get DOCKER_BUILD_FLAGS)}"
  build_log="$(mktemp)"
  # shellcheck disable=SC2086 # intentional word splitting of the flags
  if ! docker build --progress=plain $build_flags --build-arg GIT_SHA="$SHA" -t "$IMAGE:$TAG" "$SRC_DIR" >"$build_log" 2>&1; then
    log "build failed; the running release was not touched. Last lines of the build log:"
    tail -n 40 "$build_log" >&2
    rm -f "$build_log"
    exit 1
  fi
  rm -f "$build_log"
  log "build complete"
fi

save_previous
install_files
env_set IMAGE "$IMAGE"
env_set IMAGE_TAG "$TAG"

rollback_files() {
  restore_previous
  env_set IMAGE_TAG "$PREV_TAG"
}

compose up -d --wait postgres
log "running migrations"
if ! compose run --rm migrate; then
  log "migration failed; the running release was not touched"
  rollback_files
  exit 1
fi

compose up -d --remove-orphans --wait --wait-timeout 120 api worker caddy || true
if deep_health; then
  printf '%s\n' "$PREV_TAG" >.image-tag.previous
  log "healthy: $TAG is live"
  # Keep the newest images for instant rollbacks; always keep the live and previous ones.
  docker images "$IMAGE" --format '{{.Tag}}' | tail -n +"$((KEEP_IMAGES + 1))" | while read -r old; do
    [[ "$old" == "$TAG" || "$old" == "$PREV_TAG" ]] && continue
    docker rmi "$IMAGE:$old" >/dev/null 2>&1 || true
  done
  docker image prune -f >/dev/null
  exit 0
fi

log "new release is unhealthy"
compose logs --tail 50 api worker || true
if [[ -n "$PREV_TAG" ]]; then
  log "rolling back to $PREV_TAG"
  rollback_files
  compose up -d --remove-orphans --wait --wait-timeout 120 api worker caddy || true
  if deep_health; then log "rollback healthy"; else log "ROLLBACK ALSO UNHEALTHY - investigate now"; fi
fi
exit 1
