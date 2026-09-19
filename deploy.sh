#!/usr/bin/env bash
# One-command deploy: sync the project to the server and (re)build the
# container. Run this from the project root, e.g.: ./deploy.sh
#
# Requires: rsync + ssh (on Windows: run this from WSL or Git Bash).
# Configure once via a local .env.deploy file (see .env.deploy.example)
# or by exporting the variables below before running.

set -euo pipefail

REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_HOST="${REMOTE_HOST:-192.168.1.111}"   # vm-extranet
REMOTE_PATH="${REMOTE_PATH:-/opt/linktree-host}"
SSH_PORT="${SSH_PORT:-22}"

if [ -f .env.deploy ]; then
  # shellcheck disable=SC1091
  source .env.deploy
fi

echo "==> Deploying to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}"

# 1. Make sure the target directory exists on the server.
ssh -p "${SSH_PORT}" "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${REMOTE_PATH}"

# 2. Sync project files (skip local-only / generated stuff).
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude 'data' \
  --exclude '.git' \
  --exclude '.env.deploy' \
  -e "ssh -p ${SSH_PORT}" \
  ./ "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_PATH}/"

# 3. Rebuild and (re)start the container on the server.
#    Requires a .env file already present in REMOTE_PATH on the server
#    (copy .env.example there once and fill it in).
ssh -p "${SSH_PORT}" "${REMOTE_USER}@${REMOTE_HOST}" \
  "cd ${REMOTE_PATH} && docker compose up -d --build"

echo "==> Done. Check status with:"
echo "    ssh ${REMOTE_USER}@${REMOTE_HOST} 'docker logs -f linktree-host'"
