#!/usr/bin/env bash
# Shared by deploy.sh (manual) and the GitHub Actions deploy job:
# copies the deployment files to the server and runs remote-deploy.sh there.
#   sync-and-deploy.sh <user@host> <image-tag>
# Env: SSH_OPTS (extra ssh/scp options), APP_DIR (default /opt/time2live),
#      REGISTRY_USER + REGISTRY_TOKEN (optional: temporary GHCR login for the pull).
set -Eeuo pipefail

TARGET="${1:?usage: sync-and-deploy.sh <user@host> <image-tag>}"
TAG="${2:?usage: sync-and-deploy.sh <user@host> <image-tag>}"
APP_DIR="${APP_DIR:-/opt/time2live}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2206 # intentional word splitting of user-supplied options
SSH=(ssh ${SSH_OPTS:-} "$TARGET")
# shellcheck disable=SC2206
SCP=(scp -q ${SSH_OPTS:-})

echo "==> uploading deployment files to $TARGET:$APP_DIR"
"${SCP[@]}" "$HERE/docker-compose.prod.yml" "$TARGET:$APP_DIR/docker-compose.yml"
"${SCP[@]}" "$HERE/Caddyfile" "$HERE/remote-deploy.sh" "$HERE/backup.sh" "$HERE/restore.sh" \
  "$HERE/.env.production.example" "$TARGET:$APP_DIR/"
"${SSH[@]}" "chmod 750 $APP_DIR/*.sh"

if [[ -n "${REGISTRY_TOKEN:-}" ]]; then
  echo "==> temporary registry login"
  printf '%s' "$REGISTRY_TOKEN" |
    "${SSH[@]}" "docker login ghcr.io -u '${REGISTRY_USER:?REGISTRY_USER required}' --password-stdin >/dev/null"
fi

status=0
"${SSH[@]}" "$APP_DIR/remote-deploy.sh '$TAG'" || status=$?

if [[ -n "${REGISTRY_TOKEN:-}" ]]; then
  "${SSH[@]}" "docker logout ghcr.io >/dev/null" || true
fi
exit "$status"
