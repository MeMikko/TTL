#!/usr/bin/env bash
# Manual deploy from a workstation (Linux, macOS, WSL or Git Bash on Windows).
#   deploy/deploy.sh deploy@time2live.xyz            # deploys the image for the current commit
#   deploy/deploy.sh deploy@time2live.xyz <tag>      # a specific image tag (e.g. a previous sha)
# The image must already exist in GHCR (built by the Deploy workflow). The server needs pull
# access: either the package is public, or run once on the server:
#   echo <PAT with read:packages> | docker login ghcr.io -u <github-user> --password-stdin
set -Eeuo pipefail

TARGET="${1:?usage: deploy.sh <user@host> [image-tag]}"
TAG="${2:-$(git rev-parse HEAD)}"

if [[ -z "${2:-}" ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "warning: uncommitted changes are NOT part of image $TAG" >&2
fi
exec "$(dirname "${BASH_SOURCE[0]}")/sync-and-deploy.sh" "$TARGET" "$TAG"
