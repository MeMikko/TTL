#!/usr/bin/env bash
# Runs ON THE SERVER (user `deploy`). Fetches the repository and deploys one commit:
#   /opt/time2live/src/deploy/update.sh            # latest origin/main
#   /opt/time2live/src/deploy/update.sh <ref>      # branch, tag or commit SHA (e.g. a rollback)
# The checkout is then handed to that commit's own remote-deploy.sh, so deployment logic always
# matches the code being deployed. deploy/deploy.sh (on your machine) just runs this over SSH.
set -Eeuo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REF="${1:-${DEPLOY_BRANCH:-main}}"
# Must not start with '-' (would be parsed as a git option).
[[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$ ]] || { echo "invalid ref: $REF" >&2; exit 2; }

cd "$SRC_DIR"
git fetch --quiet --prune --tags origin
if sha="$(git rev-parse --verify --quiet "origin/$REF^{commit}")"; then
  :
elif sha="$(git rev-parse --verify --quiet "$REF^{commit}")"; then
  :
else
  echo "unknown ref: $REF (not a branch on origin, tag or commit)" >&2
  exit 2
fi

# The server checkout is never edited by hand; --force discards stray local changes.
git checkout --quiet --force --detach "$sha"
echo "[update] checked out $(git log -1 --format='%h %s')"
exec "$SRC_DIR/deploy/remote-deploy.sh" "$sha"
