#!/usr/bin/env bash
# Push the current checkout to the server and (re)start the bot.
# Run FROM THE MAC:  ./deploy/deploy.sh root@SERVER_IP
#
# Code and config only -- data/ (DB, wallet) and .env are NEVER synced by
# this script. The one-time migration of those is a manual, ordered step in
# RUNBOOK.md, and after cutover the server's DB is the live one: overwriting
# it with the Mac's stale copy would erase positions and accounting.
set -euo pipefail
DEST="${1:?usage: deploy.sh user@host}"

echo "== rsync code =="
rsync -az --delete \
  --exclude .git --exclude node_modules --exclude data \
  --exclude .env --exclude "*.log" --exclude scratch \
  ./ "$DEST":/opt/cashcow/

echo "== install deps + typecheck on the server =="
# Full npm ci (dev deps included): typescript is a devDependency and the
# server-side `tsc --noEmit` below is the last gate before a restart.
# Tolerates a pre-bootstrap push (no cashcow user yet): falls back to root,
# and bootstrap.sh chowns the tree when it runs.
ssh "$DEST" 'set -e; cd /opt/cashcow
  if id cashcow >/dev/null 2>&1; then
    chown -R cashcow:cashcow /opt/cashcow
    sudo -u cashcow npm ci --no-audit --no-fund 2>&1 | tail -2
    sudo -u cashcow npx tsc --noEmit && echo "tsc clean"
  else
    npm ci --no-audit --no-fund 2>&1 | tail -2
    npx tsc --noEmit && echo "tsc clean (pre-bootstrap: run bootstrap.sh next)"
  fi'

echo "== refresh systemd units (units ship with the code) =="
ssh "$DEST" 'if [ -d /etc/systemd/system ]; then
  cp /opt/cashcow/deploy/cashcow-bot.service /opt/cashcow/deploy/cashcow-web.service /etc/systemd/system/ 2>/dev/null || true
  systemctl daemon-reload 2>/dev/null || true
fi'

echo "== restart (only if units are enabled -- pre-cutover this is a no-op) =="
ssh "$DEST" 'systemctl is-enabled cashcow-bot >/dev/null 2>&1 \
  && systemctl restart cashcow-bot cashcow-web \
  && systemctl --no-pager -l status cashcow-bot | head -5 \
  || echo "units not enabled yet (pre-cutover); code deployed only"'
echo "deploy done"
