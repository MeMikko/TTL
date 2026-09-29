#!/usr/bin/env bash
# Deploy from your machine (Linux, macOS, WSL or Git Bash on Windows). The server fetches the
# commit from GitHub, builds the image itself and runs deploy/remote-deploy.sh.
#   deploy/deploy.sh time2live            # the commit you have checked out (must be pushed)
#   deploy/deploy.sh time2live main       # latest origin/main
#   deploy/deploy.sh time2live <sha>      # any pushed commit, e.g. to roll back
# `time2live` is an ~/.ssh/config host (or user@host). Extra ssh options: SSH_OPTS.
set -Eeuo pipefail

TARGET="${1:?usage: deploy.sh <ssh-host> [ref]}"
REF="${2:-}"
SRC_DIR="${SRC_DIR:-/opt/time2live/src}"

if [[ -z "$REF" ]]; then
  REF="$(git rev-parse HEAD)"
  git fetch --quiet origin
  if [[ -z "$(git branch -r --contains "$REF" 2>/dev/null)" ]]; then
    echo "commit ${REF:0:12} is not on origin — push it first (the server fetches from GitHub)" >&2
    exit 1
  fi
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "note: uncommitted local changes are NOT deployed; deploying ${REF:0:12}" >&2
  fi
fi
[[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$ ]] || { echo "invalid ref: $REF" >&2; exit 2; }

# shellcheck disable=SC2086 # intentional word splitting of user-supplied options
exec ssh ${SSH_OPTS:-} "$TARGET" "$SRC_DIR/deploy/update.sh '$REF'"
