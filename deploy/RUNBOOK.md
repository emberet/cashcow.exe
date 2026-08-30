# Moving the cow to a server

The order below is not bureaucracy. Two things make it strict:

1. **One writer per wallet.** `withBalanceLock()` is process-local (CLAUDE.md
   gotcha). The Mac bot and the server bot running together against the same
   `wallet-keypair.json` — even for one overlapping tick — reintroduces the
   measured-cost-as-zero bug class with no lock protecting against it. The Mac
   stops *before* the server starts, never the other way around.
2. **The DB moves last.** Every tick writes to it. A copy taken while the Mac
   bot runs is stale the moment it lands; the only correct copy is taken
   after the Mac bot is dead.

## Custody, stated plainly

Moving `data/wallet-keypair.json` to a VPS means anyone with root on that box
— you, the provider, or an attacker who gets in — can drain the wallet. The
bootstrap locks the firewall to SSH and keeps both dashboards loopback-only,
but the honest mitigation is operational: claim fees regularly and don't let
the working balance grow past what the bot needs (capacity says ~1.7 SOL
sustains 3 launches/day). The never-sell rail protects the project token from
the BOT; it cannot protect anything from root.

## Phase 1 — prepare (Mac keeps running; zero risk)

Either order works (both scripts tolerate running first), but this one is
cleanest:

```
# from the Mac:
ssh root@SERVER_IP 'mkdir -p /opt/cashcow'
./deploy/deploy.sh root@SERVER_IP          # code only; data/.env excluded
ssh root@SERVER_IP 'bash /opt/cashcow/deploy/bootstrap.sh'
./deploy/deploy.sh root@SERVER_IP          # re-run: now chowned + units installed
```

Copy secrets (server keeps running fine without them until cutover):

```
scp .env root@SERVER_IP:/opt/cashcow/.env
scp config.json public.config.json root@SERVER_IP:/opt/cashcow/
ssh root@SERVER_IP 'chown cashcow:cashcow /opt/cashcow/.env /opt/cashcow/*.json && chmod 600 /opt/cashcow/.env'
```

Prove every credential from the server's network position (signs nothing):

```
ssh root@SERVER_IP 'cd /opt/cashcow && sudo -u cashcow npm run preflight'
```

Expect the same OKs as on the Mac (Anthropic, Pinata, Cloudflare image gen,
RPC, X read + announce). Fix anything red BEFORE cutover — this is the whole
point of preflight existing.

Tunnel credentials (so cashcowexe.win can be served from the server):

```
ssh root@SERVER_IP 'mkdir -p /etc/cloudflared'
scp ~/.cloudflared/config.yml ~/.cloudflared/*.json root@SERVER_IP:/etc/cloudflared/
# edit /etc/cloudflared/config.yml on the server: credentials-file path
# becomes /etc/cloudflared/<TUNNEL_ID>.json. The ingress port stays 4601 --
# NEVER 4600, which serves the admin portal (see the config's own comment).
```

## Phase 2 — cutover (minutes of downtime; order is everything)

```
# 1. Mac: stop BOTH agents and disable them so a reboot cannot resurrect them
launchctl bootout gui/$(id -u)/com.cashcow.bot
launchctl bootout gui/$(id -u)/com.cashcow.public
launchctl disable gui/$(id -u)/com.cashcow.bot
launchctl disable gui/$(id -u)/com.cashcow.public

# 2. Mac: confirm nothing still holds the wallet
ps aux | grep -E "cli\.ts" | grep -v grep     # must print nothing

# 3. Mac: NOW the data is quiescent -- move it
rsync -az data/ root@SERVER_IP:/opt/cashcow/data/
ssh root@SERVER_IP 'chown -R cashcow:cashcow /opt/cashcow/data && chmod 600 /opt/cashcow/data/wallet-keypair.json'

# 4. server: start, in dependency order
ssh root@SERVER_IP 'systemctl enable --now cashcow-bot cashcow-web
  sleep 5
  curl -s http://127.0.0.1:4600/api/health && echo
  curl -s -o /dev/null -w "public: HTTP %{http_code}\n" http://127.0.0.1:4601/'

# 5. server: move the tunnel
ssh root@SERVER_IP 'cloudflared service install 2>/dev/null || true
  systemctl enable --now cloudflared'
# then STOP the Mac's cloudflared (brew services stop cloudflared, or however
# it runs) -- two connectors on one tunnel is legal but confusing.
```

## Phase 3 — verify before walking away

```
ssh root@SERVER_IP 'journalctl -u cashcow-bot -n 30 --no-pager'
```

- [ ] startup line shows `mode: LIVE`, all feeds listed, no red
- [ ] cashcowexe.win loads and the wallet card matches on-chain balance
- [ ] `sqlite3 /opt/cashcow/data/bot.db "SELECT COUNT(*) FROM signals;"` grows
      across two checks a few minutes apart (feeds are ingesting)
- [ ] one full launch cycle observed (or a declined candidate logged — proof
      the scoring loop runs end to end)
- [ ] X herd report goes out at the next 09:00/21:00 UTC slot
- [ ] Mac: both LaunchAgents report `disabled`, cloudflared stopped

## Rollback

The Mac copy is intact (nothing above deletes it). Reverse the order: stop
the server units (`systemctl disable --now cashcow-bot cashcow-web`), rsync
`data/` BACK from the server (it now has the newer DB), re-enable the Mac
agents. Same one-writer rule in reverse: server dead before Mac starts.

## Afterwards

- Updates: merge to main on GitHub, then from the Mac checkout:
  `git pull && ./deploy/deploy.sh root@SERVER_IP` (it restarts the units).
- The Mac's `data/` directory is now a historical snapshot; the export corpus
  (`scripts/export-corpus.ts`) run on the SERVER is the living record.
- Backups: `sqlite3 /opt/cashcow/data/bot.db ".backup ..."` under cron, and
  keep an offline copy of wallet-keypair.json somewhere that is not the VPS.
