# cashcow.exe — session checkpoint (2026-08-31)

Paste this into a fresh session to recall the whole project. It is the state
of the world plus the reasoning behind it. Where this disagrees with the
repo, **the repo wins** — verify before acting.

---

## 1. What this is

`cashcow.exe` — an autonomous pump.fun trend-detection and token launcher.
It reads ~11 feeds, scores phrases, mints the best as coins, takes a small
rule-bounded dev position, and earns **primarily through creator fees**.
TypeScript on Node 26 (native type stripping, **no build step**),
`node:sqlite`, official `@pump-fun/pump-sdk`. **It spends real money
autonomously.**

- Repo: `emberet/cashcow.exe` (private, `main` is PR-protected)
- Local checkout: `~/Downloads/cashcow` (Mac — deploy source only, no longer runs the bot)
- **Production: Hetzner CPX22, `root@62.238.124.113`** (Helsinki, Ubuntu 26.04)
  - Code at `/opt/cashcow`, service user `cashcow`
  - systemd: `cashcow-bot` (:4600, admin), `cashcow-web` (:4601, public), `cloudflared`
  - Public site: **cashcowexe.win** (tunnel → 4601 ONLY; 4600 serves admin, never expose it)
  - ufw = SSH only, sshd key-only
- Read `CLAUDE.md` (invariants + gotchas) and `docs/DECISIONS.md` (48 entries, the why-log) first.

**SSH from Claude:** use `/usr/bin/ssh -o ControlPath=/tmp/cc-ssh` multiplexing —
ufw `limit` throttles rapid separate connections and will lock you out mid-task.

---

## 2. Live state as of 2026-08-31 ~19:00 UTC

| | |
|---|---|
| Mode | LIVE, mainnet-beta, **HALTED** (operator, after the $LETS incident) |
| Net profit | **+5.885 SOL** (fees 6.294, realised P&L 0.388, launch costs −0.61) |
| Real launches | 35 · settled outcomes 34, of which **33 duds** |
| Open positions | 6 · migration `user_version` = **12** |
| X read meter | **99.98 / 100 — EXHAUSTED, X feeds are dark** |
| X write meter | 3.0 / 5 |

**Key config** (`/opt/cashcow/config.json`, gitignored; `data/tuning.json`
overlay OVERRIDES it — check both when a change "doesn't take"):

- `risk`: 69 launches/day, 5.5 SOL/day, 10 concurrent, **maxDailyLossSol 0.06**
- `scoring`: threshold **75** (tuner-set), minCorroboratingFeeds 2, minIndependentFamilies 2, minObservations 3, decay 90min
- weights: velocity .319 / acceleration .150 / corroboration .170 / cryptoAffinity .149 / tickerability .106 / reach .106
- `devPosition`: **enabled**, 0.05 SOL buy, 24h max hold, 3× TP, 50% SL, `liquiditySell` on, neverSell = `67iVaRRQ…pump` (the project token)
- Feeds on: googleTrends, reddit\*, xApi, watchlist, fourchan (biz/g/v/tv), farcaster\*, hackernews, googleNews, knowYourMeme, urbanDictionary, wikipedia, onchain, dexActivity. **polymarket off** (network-blocked). \*reddit/farcaster lack credentials.
- `social.xAnnounce`: on, **@cashcowEXE**, herd reports 09:00 + 21:00 UTC, $5/mo cap
- `learning`: on, autoApply, minSampleSize 20

---

## 3. The invariants (do not relax without reading the why)

1. `BudgetGuard` is the only path to spending SOL
2. The kill switch stops launches, **never** blocks exits
3. The tuner allowlist is a security boundary (default-deny; never `risk.*`/`devPosition.*`/`filters.*`/`launch.*`/`wallet.*`/`rpc.*`)
4. The web process never holds the wallet key — money actions go through the `commands` queue
5. Timing uses `ingested_at`, never `observed_at`
6. Saturation fails closed
7. Safe by default (new features ship off, new limits ship tight)
8. Live mainnet requires `ANTHROPIC_API_KEY` (brand/likeness screen)
9. Wallet address is public; the SECRET never is
10. Security throttles key on the socket address, never a header
11. Third-party URLs need `safeHttpUrl()`
12. Secrets never reach logs/DB/dashboard

**One writer per wallet.** `withBalanceLock()` is process-local. Never run a
second bot/CLI that signs while the server bot runs. Money actions from chat
go through the admin `commands` queue (`enqueue(db, "claim_fees" | "sell_position", …)`),
which the live bot executes inside its own lock.

---

## 4. The two bug families — read before debugging money

**A. The books absorbing an unverified value.** Four instances:
- §39 — a landed sale wasn't in the position row → −0.0975 SOL of invented loss
- §41 — cleanup nearly invented 0.25 SOL more
- §42 — an unreconciled X cost estimate shut off a feed (**and my diagnosis of it was wrong and is retracted in place**)
- §43 — `tokenBalance()` collapsed *every* RPC failure to zero → three positions written off while the wallet still held 1.76M tokens each

Rule: **nothing that moves the books may act on a value the chain has not
affirmatively stated.** Cross-check ledger vs chain before believing any loss.

**B. Enumerated lists silently exempting new members.** §44 (two weight-sum
checks missed `acceleration`; effective sum 1.15, threshold silently deflated
~13%), §47 (ceilings below the static baseline made boost windows *throttle*).
Fixed structurally: sums derive from the schema object; `effectiveRisk()` is
now `max(static, min(window, ceiling))` — **a window widens, never narrows.**

---

## 5. Operator directives — standing

- **Never lower `scoring.threshold` to increase launch volume.** §48: I dropped
  75→36 to "boost activity" and an hour later the bot minted **$LETS** from
  `"Let's build!"` in a promo tweet, announced it from @cashcowEXE, and the
  operator was angry. The candidate pool's problem is *quality* (214/327
  declines were `crowded`; survivors were contentless words). A lower bar only
  stops hiding it. Honest levers instead: candidate supply, or
  `devPosition.enabled: false`.
- **The likeness filter is untouchable.** Watchlist mints *phrases*, never
  people. An Elon phrase can launch; a token named ELON cannot. One decision,
  not two.
- **Never rotate creator wallets** to dodge a rug flag (§2/§37 — that is the
  concealment the warning exists to catch). Behave differently or wear it.
- **Excluded forever** (§2): wash trading, multi-wallet bundling, sock-puppet
  shilling. Announcements from the *disclosed* account are fine.
- **Declined and recorded** so they aren't re-litigated: TikTok (signed-session
  wall), soyjak.wiki/party (Cloudflare 403), Tor/onion sources, pump.fun reply
  API (undiscoverable), corroboration bypass for "cult" single-source terms.
- Do not sell `67iVaRRQkNnZvN29rG75kt71nVdhkc5imwYDTivApump` (enforced in code).

---

## 6. Build history (PRs #10 → #38)

Art & identity: #10/#13/#14/#36 image gen (Cloudflare flux-1-schnell; API
rejects `seed`, returns JPEG 1024², always re-encode) · #18 per-ticker art
variety · #29/#32 the cow redrawn to match the pfp.

Money correctness: #11 fee claim booked to the pretend ledger · #17 never-sell
rail at `sellAll()` · #20 X meter reconciliation · #23 airdrop fee model ·
#25 failed-read ≠ zero balance · #37 windows widen only.

Trust & transparency: #12 provenance + Telegram · #15 CA on every coin ·
#21 "Mainnet" label · #22/#24 the airdrop sheet, published · #8 security.txt.

Capability: #26 source-URL thesis in metadata · #27 X posting (launch + herd
reports) · #28 acceleration scoring, feed reliability, watchlist · #30 corpus
export · #31 PIN OAuth for the bot account · #33 the deployment kit ·
#34 priority tier + culture feeds · #35 liquidity exits + CTO program ·
#38 the meaningless-term filter.

**The airdrop** (2026-08-29): 5.4394 SOL to 49 holders (2M+ held 6h+,
pro-rata) via tools.smithii.io (flat 0.049 SOL fee). All 49 paid to the
lamport. The AMM pool was excluded — it would have taken 38% of the pot —
and 8 wallets that held millions of tokens but zero SOL were nearly dropped
as "account does not exist"; they were real holders. Sheet published at
`cashcowexe.win/airdrop-day1.xlsx`.

---

## 7. Open items

**Needs the operator:**
1. **X read credit exhausted (99.98/100).** The meter is deliberately
   conservative (per-request floor) because per-request vs per-post billing is
   *still unresolved* — asked 3× and never answered. Read the X dashboard
   balance; that settles it and decides whether to raise the cap or let it stop.
2. Bot is **halted** — `node src/cli.ts resume` on the server when ready.
3. Reddit + Neynar credentials (2 dark feeds; source-family breadth is the
   #1 learning from day 1).
4. Cloudflare Bot Fight Mode toggle (long-pending).
5. Move `data/export/` to the external drive; keep a wallet-key backup off both machines.
6. Revoke the stray @emberetme app authorization (X → Settings → Apps and sessions).

**Known and unfixed:**
- `aeyakovenko` never resolved via the X users API (other 15 handles did).
- `x-announce` cap $5/mo ≈ 25 posts; posts silently skip past it.
- 33 of 34 settled outcomes are duds — scoring does not yet separate winners.
- Dev position has netted **+0.05 SOL across 27 buys** vs **6.29 SOL** in fees.
  Turning it off would ~3× launches per SOL, end loss-breaker pressure, and
  erase the rug signature. Repeatedly recommended, never actioned — operator's call.

---

## 8. Operating cheatsheet

```bash
# deploy after merging to main (from ~/Downloads/cashcow)
git pull && ./deploy/deploy.sh root@62.238.124.113

# on the server, everything runs as the cashcow user with .env loaded
cd /opt/cashcow && sudo -u cashcow node --env-file=.env src/cli.ts <cmd>
#   read-only: budget capacity score feeds outcomes positions profit
#              tuning learn --mandate boost-window --status preflight
#   state-changing (confirm first): halt resume boost-window fees --claim
```

Style that worked here: verify against the chain/live API rather than
trusting the DB; write the test that would have caught the bug in the same
change; record *why* in `docs/DECISIONS.md` including what was deliberately
NOT done; and when a diagnosis turns out wrong, retract it in place rather
than leaving it to be re-learned.
