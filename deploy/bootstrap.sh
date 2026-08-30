#!/usr/bin/env bash
# One-time server setup for cashcow.exe. Run as root on a fresh
# Ubuntu 24.04 (or Debian 12) box:  bash bootstrap.sh
#
# Idempotent: safe to re-run. Installs Node 26, creates the service user,
# locks the firewall to SSH only (both dashboards stay loopback; the public
# one reaches the internet exclusively through the cloudflared tunnel), and
# installs the systemd units. It does NOT copy secrets or start anything --
# the RUNBOOK's cutover section owns that, because of the one-writer-per-
# wallet invariant.
set -euo pipefail

echo "== packages =="
apt-get update -qq
apt-get install -y -qq curl git sqlite3 ufw rsync ca-certificates

echo "== node 26 =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v26* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_26.x | bash -
  apt-get install -y -qq nodejs
fi
node -v

echo "== service user + tree =="
id cashcow >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin cashcow
mkdir -p /opt/cashcow
chown cashcow:cashcow /opt/cashcow

echo "== firewall: ssh only =="
ufw default deny incoming
ufw default allow outgoing
ufw limit OpenSSH
ufw --force enable
ufw status | sed 's/^/  /'

echo "== cloudflared =="
if ! command -v cloudflared >/dev/null; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared
fi
cloudflared --version

echo "== systemd units =="
if [ -f /opt/cashcow/deploy/cashcow-bot.service ]; then
  cp /opt/cashcow/deploy/cashcow-bot.service /etc/systemd/system/
  cp /opt/cashcow/deploy/cashcow-web.service /etc/systemd/system/
  systemctl daemon-reload
  chown -R cashcow:cashcow /opt/cashcow
  echo "  installed (NOT enabled -- the runbook's cutover enables them)"
else
  echo "  code not deployed yet -- run deploy.sh from the Mac (it installs the units)"
fi

echo
echo "bootstrap done. Next: deploy code (deploy.sh from the Mac), then follow"
echo "deploy/RUNBOOK.md from 'Cutover'."
