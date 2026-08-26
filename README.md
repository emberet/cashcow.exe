# cashcow.exe

Detects breaking trends, mints them as tokens on pump.fun, takes a small
rule-bounded dev position, and earns primarily through pump.fun **creator fees**.

---

**Project docs:** [`CLAUDE.md`](CLAUDE.md) — invariants and how to work in this
repo · [`docs/DECISIONS.md`](docs/DECISIONS.md) — why it is shaped this way, with
the evidence · [`docs/STATUS.md`](docs/STATUS.md) — what is verified, what is not,
and the path to live.

## Read this before funding anything

**Launching is trivial. Distribution is the hard part.** Creator fees are
0.05–0.95% of trade volume, tiered by market cap (the top 0.95% band sits around
$88k–$300k). Earning ~$100 at the best tier needs roughly **$10,500 of volume on
that one token**. Most pump.fun launches never clear $1k, only ~1–2% graduate,
and every launch costs rent plus priority fees whether or not anyone shows up.

A bot that sprays launches is a wallet drain. The two variables that actually
decide whether this makes money are:

1. **Being early** on a trend that has a real audience.
2. **Not launching into a crowded one.** The saturation check is the highest-
   leverage code in the repo — on a live run it found trends with *25 existing
   tokens already competing for the same volume*.

The scoring and saturation layers are the product. The deploy path is plumbing.

Run `npm run dry-run` for several days before funding anything. It costs nothing
and tells you whether your signal config is worth money.

---

## Quick start

```bash
npm install
npm test
npm run dry-run
```

Dry run needs no wallet, no RPC, and no Pinata account — it uses an ephemeral
keypair, skips all chain reads, and skips the IPFS pin. What it proves is the
signal pipeline: feeds → scoring → filters → saturation → naming → artwork.

Then `cp .env.example .env` and fill in what you need, and run
`npm run preflight` to confirm what you filled in actually authenticates — a
revoked key and a missing one look identical to `echo $VAR`, and only one of
them announces itself mid-launch. `npm run preflight -- --links` has the signup
links for whatever is missing.

## Dashboard

```bash
npm run admin-password        # generate ADMIN_PASSWORD_HASH, paste into .env
npm run web                   # dashboard only (reads the same database)
node src/cli.ts run --web     # bot + dashboard in one process

node src/cli.ts admin-password --save   # store the password directly instead;
                                        # takes effect at once, no restart, and
                                        # is the way back in after a lockout
node src/cli.ts admin-password --clear  # drop that override; .env governs again
```

Once signed in, the password can also be changed from the portal itself (Barn
log → *Change the barn key*), which requires the current password and signs out
every session including your own. Both paths write the hash to the database,
where it **overrides `ADMIN_PASSWORD_HASH`** — so after a rotation, editing
`.env` does nothing until you run `--clear`. The CLI and the portal both say
which source is in effect.

The UI is a neo-brutalist cartoon: hard ink borders, solid offset shadows, a cow
that chews. Fonts (Bagel Fat One, Baloo 2) are **self-hosted** in
`src/web/public/fonts` so the strict CSP holds and the dashboard works offline.

Two surfaces, with a hard boundary between them:

| | |
|---|---|
| `https://cashcowexe.win` | **Public.** Read-only, plain-English, safe to show anyone. |
| `http://127.0.0.1:4600/admin` | **Admin.** Password-gated controls, loopback only. |

The public site is served by a **second web process** on `127.0.0.1:4601` running
under `public.config.json` with `adminEnabled: false`, exposed through a
Cloudflare named tunnel. The bot's own instance on `:4600` serves both surfaces
and stays on loopback.

That split is the whole security story, so it is worth being precise about it:
on the public hostname `/admin`, `/api/admin/snapshot` and `/api/login` all
return **404**. The admin surface is *absent* there, not password-guarded. The
tunnel must never be pointed at `:4600` — see `docs/DECISIONS.md` §27.

Neither server binds anything but loopback, so the tunnel is the only ingress;
there is no port forwarding and no open firewall port. Three LaunchAgents keep
it up across reboot: `com.cashcow.bot`, `com.cashcow.public`, and
`com.cloudflare.cloudflared`.

What the public page shows, top to bottom: a status header, the **chomp
pipeline** (eight gates, each one clickable for its own detail), what it is
**currently reading** with every source named and linked, the money, the charts,
every coin it has created including the duds, what it turned away and why, the
**dev wallet address and balance**, and the fee claims.

Design decisions worth knowing:

**The pre-launch candidate queue is admin-only.** A public page streaming "about
to launch X" in real time is an invitation to be front-run by anyone watching
it. The public page shows launches only after they exist on chain.

**The gate funnel is the headline.** "The chomp pipeline" shows where every
rumour died — sniffed, deduped, warmed, scored, screened, crowded out, priced
out, launched. Aggregate counts publish live; the *named* rejection list is held
back by `web.declineDelayHours` (default 6), so reading the page can never
front-run a launch. Gate counts are measured against what was actually
**examined**, not what was scored — the loop stops looking once the allowance is
gone, and reporting the remainder as rejections would flatter the filters.

**Every gate opens its own detail.** Each card is a real anchor (`#gate-3`), so
it is deep-linkable and the back button works. The panel opens *inside* the grid
directly beneath the row you clicked, which is why nothing scrolls; clicking the
same gate again closes it. Depth is tiered by disclosure risk — gates 1-4 are
statistical only, gates 5-7 name terms from the delayed record, gate 8 is
already on chain.

**It publishes what it reads, chronologically.** Source name, publisher, the
source's own headline, and a link to the original. Ordered by time and never by
score: these are public feeds anyone can open, but *ranking* them would publish
which topics sit near the launch line. Display is filtered on slurs only — the
launch filters reject brands and tragedies because minting those is a legal
hazard, while reading a headline about them is just news.

**The wallet address and balance are published** (`web.showWallet`, default on).
Both are already public: the page names every mint, and a token's creator and
that creator's balance are one lookup away. Hiding them would obscure
verification without concealing anything. The admin portal always shows them.

**The web process never holds your wallet key.** Pause/resume works through the
filesystem kill switch. Anything that spends SOL — force-sell, claim fees — is
written to a `commands` table and executed by the bot on its next tick, under
the same budget guard and caps as autonomous activity. A bug in a request
handler cannot sign a transaction.

**Admin defaults to disabled, not open.** With no `ADMIN_PASSWORD_HASH` set the
portal returns 503 and the UI says so. There is no default credential. Sessions
are opaque tokens stored hashed, cookies are HttpOnly + SameSite=Strict, every
mutation carries a CSRF token, failed logins are rate limited per IP, and every
admin action lands in an audit log.

It binds to `127.0.0.1` by default. Exposing it publicly means exposing `/admin`
on the same port — put TLS and a reverse proxy in front, set
`web.behindTlsProxy: true` so cookies get `Secure`, or run
`web.publicEnabled: false` for an admin-only instance.

## Commands

```bash
npm run preflight              # check every credential by using it; signs nothing
npm run preflight -- --for-mainnet   # judge mainnet readiness while still on devnet
npm run preflight -- --links   # signup links for whatever is missing

npm run feeds                  # poll every feed once, report what each returned
npm run score                  # ranked candidates with score components
npm run dry-run                # full loop, no transactions
node src/cli.ts run --once     # a single pass (useful under cron)
node src/cli.ts run            # the real loop
node src/cli.ts positions      # open and recent dev positions
node src/cli.ts budget         # rolling 24h spend / launches / loss
node src/cli.ts fees --claim   # collect accumulated creator fees
node src/cli.ts halt "reason"  # stop new launches; open positions still exit
node src/cli.ts resume
```

## How a launch is gated

Every gate that can reject for free runs before any gate that costs money. The
model call, image render and IPFS pin only happen once a candidate has survived
everything cheaper.

```
feeds → phrases → score → warmup → threshold → content filters
      → saturation → budget → naming + risk screen → image → IPFS → launch
```

- **warmup** — velocity compares the recent half of the signal window against
  the earlier half. On a cold start there is no earlier half, so *everything*
  looks maximally accelerating. `warmupMinutes` and `minObservations` stop a
  freshly started bot launching on its first glimpse of noise.
- **saturation** — checks pump.fun and DexScreener for tokens already chasing
  the trend. A failed lookup counts as *saturated*: skipping is free, launching
  blind is not.
- **budget** — a rolling-24h append-only ledger. Nothing spends SOL without
  passing through it.

## Launch capacity

`maxLaunchesPerDay` is a fixed number, which is wrong in both directions — too
low for a funded wallet, far too high for a drained one. Enable
`risk.adaptive` and the cap is derived from what the wallet can actually
sustain: spendable balance ÷ runway days, capped by a daily burn percentage,
divided by cost per launch, then throttled if recent launches are losing.

```bash
npm run capacity                 # what it resolves to and what is limiting
node src/cli.ts capacity --balance 10
```

Measured on the shipped defaults:

| Wallet | With 0.05 SOL dev buy | Fee-only (no dev buy) |
|---|---|---|
| 0.5 SOL | **0/day** | 2/day |
| 2 SOL | 3/day | 10/day |
| 10 SOL | 18/day | 48/day |
| 40 SOL | 48/day (ceiling) | 48/day (ceiling) |

Two things that table makes obvious:

**The dev buy dominates.** At 0.0768 SOL per launch it is ~65% of the cost;
without it a launch costs 0.0268. If throughput is what you want, dropping the
dev buy roughly triples it for the same wallet — and it moves you to the pure
fee-harvesting model, which has no conflict with your own buyers.

**A 0.5 SOL wallet gets zero launches, not one.** That is the feature. It cannot
afford a launch while preserving a week of runway, so it refuses rather than
draining itself.

Adaptive capacity can only ever ask for *less* than `risk.maxSolPerDay`; it can
never raise your own ceiling. Raise that ceiling yourself if you want adaptive
to scale past it.

## Self-tuning

The bot can learn from what its launches actually did and adjust its own
selection criteria. Off by default, and propose-only even when on.

```bash
node src/cli.ts outcomes --refresh   # what happened to each token
node src/cli.ts learn                # run a tuning pass now
node src/cli.ts learn --mandate      # exactly what the tuner may touch
node src/cli.ts tuning               # what it has learned
node src/cli.ts tuning --clear       # throw all of it away
```

**The rule: the tuner can change how PICKY the bot is. It can never change how
much money the bot may lose.** `scoring.threshold` is tunable;
`risk.maxSolPerDay` is not. That is enforced by an allowlist in
`src/learning/guardrails.ts` — in code, not by asking the model nicely in a
prompt. Every proposal is also rate-limited (max ±5 on the threshold per run),
absolutely bounded, capped at `maxChangesPerRun`, and logged with its rationale.
Rejected proposals are logged too.

Learned values live in `data/tuning.json`, separate from your `config.json` so
your file stays yours and one command discards everything learned. That file is
re-filtered through the allowlist on every read, so hand-editing a forbidden key
into it does nothing.

It refuses to run below `minSampleSize` settled launches (default 20) because
tuning on eight outcomes fits noise and calls it learning. A launch is not
counted until it has had `settleAfterHours` to catch or die.

**Per-token fees are estimated, not measured.** pump.fun claims creator fees in
bulk across every token a wallet created, so there is no per-token figure to
read; fees are apportioned by each token's share of observed performance. The
exact total is in `fee_claims`. Every surface that shows the estimate says so.

## Configuration

Everything is in `src/config/default.config.json`; override with a gitignored
`config.json` or `TRENDBOT_CONFIG=/path/to.json`. Nothing that affects spend or
risk is hardcoded. Startup rejects incoherent combinations (e.g. a daily SOL
ceiling too low for the configured launches × dev buy).

Defaults ship conservative: **dry run, devnet, 0.05 SOL dev buy, 3 launches/day,
0.5 SOL/day ceiling, exit at 3× / 30min / −50%.**

## Safety rails

| Rail | Behaviour |
|---|---|
| Daily launch cap | Rolling 24h, not calendar day |
| Daily SOL ceiling | Checked before every transaction |
| Realised-loss breaker | Halts spend once losses cross the limit |
| Wallet floor | Reserves gas so exits always remain payable |
| Concurrent positions | Caps simultaneous exposure |
| Kill switch | `data/HALT` or SIGTERM; survives restarts |
| X API meter | USD-capped, charged *before* each billable call |

**The kill switch stops new launches but never blocks an exit.** If halting also
froze exits, tripping the brake would strand every open bag and turn the safety
feature into the thing that loses the money.

## Known limitations

- **Trademark and likeness screening needs the model screen.** This is the most
  important caveat in this file. A static blocklist cannot enumerate every brand
  and public figure on earth, and live testing proved it repeatedly — successive
  runs leaked `usa network`, `kevin keegan`, `isack hadjar` and `sling tv`.

  Three layers now exist, in increasing order of actual effectiveness:
  1. **Static blocklist** — catches the obvious, always incomplete.
  2. **Capitalisation heuristic** — catches "Kevin Keegan". Google Trends
     lowercases its terms, so casing is first recovered from the attached news
     headline; when the headline does not contain the term verbatim (`isack
     hadjar`), the heuristic stays blind. It is also blunt in the other
     direction: it blocks **"Moo Deng"**, a genuine trend, because a hippo is
     indistinguishable from a surname pair. That false positive is the accepted
     cost — a missed launch is cheaper than a right-of-publicity claim — and
     `filters.blockLikelyPersonNames` turns it off.
  3. **Model screen** (`ANTHROPIC_API_KEY`) — the only layer that reliably knows
     "Sling TV" is a brand. It rides free on the naming call that already
     happens.

  **A live mainnet run refuses to start without layer 3.** Override with
  `filters.allowUnscreenedLive=true` only if you mean it. Dry runs and devnet
  are unaffected.
- **Polymarket could not be verified.** The Gamma API was unreachable from the
  machine this was built on while other hosts resolved fine. The adapter is
  written to spec and needs one live confirmation from your network.
- **pump.fun's frontend endpoints are not a documented public API.** Saturation
  and on-chain momentum use them and can break without notice; DexScreener is
  wired in as a structurally different fallback.
- **Use devnet, never testnet.** pump.fun runs on devnet and a full create+buy
  simulates cleanly there. testnet carries a stale deployment the SDK cannot
  decode. An earlier version of this README claimed devnet was unusable — that
  was wrong, see `docs/DECISIONS.md` §15.
- **The launch transaction has ~17 bytes of headroom** against Solana's
  1232-byte packet limit. Adding an account or lengthening the metadata URI will
  break launches until an address lookup table exists (§16).
- **Corroboration is now scored, not gated.** The hard bar is one source; a lone
  /biz/ spike is admitted but scores 0 on corroboration and must be excellent
  elsewhere to qualify. Two feeds in the same family (/biz/ + on-chain) count as
  near-zero agreement — see `src/scoring/independence.ts`. Raise
  `scoring.minIndependentFamilies` to 2 to restore a hard cross-family bar.
- **Source timestamps are not trustworthy and are not used for timing.** A /biz/
  sticky thread reports a creation time over a year old. Dating history from the
  source clock made a two-minute-old bot report 484 days of history, which
  silently satisfied the cold-start warmup gate. Signals now carry `ingested_at`
  (our clock) alongside `observed_at` (the source's), and every timing decision —
  warmup, velocity, decay, windowing — uses ours. Rows migrated from before this
  fix have `ingested_at` backfilled from `observed_at`, so a pre-existing
  database still reports an inflated span until those rows age out; delete
  `data/bot.db` if you want a clean baseline.

## Verification path

1. `npm test` — safety rails, exit rules, filters, saturation, tuner guardrails,
   adaptive capacity. **103 tests.**
2. `npm run feeds` — live, read-only, free.
3. `npm run preflight -- --for-mainnet` — every credential checked by *using*
   it, not by testing that it is non-empty. Nothing is signed.
4. **Devnet — done, and it works.** No local validator is needed; an earlier
   version of this file said otherwise and was wrong. On 2026-08-24 two tokens
   were created on devnet with a real dev buy, one was sold, and the launch
   reconciled against the real wallet delta to **zero drift at 9 decimals**.
   Signatures and the full table are in [docs/STATUS.md](docs/STATUS.md).
   What devnet does *not* prove: economics, priority-fee competition, or that
   anyone will trade the tokens.
5. **Mainnet, one manual launch at the smallest dev buy.** Verify on Solscan,
   wait for trades, then confirm `node src/cli.ts fees` reports a non-zero
   balance and a claim lands SOL back. *This is the only test that proves the
   revenue model works end to end. Do not enable full auto before it passes.*
6. Full auto with conservative caps. Watch the first 24h. **Reconcile the spend
   ledger against the real wallet delta** — if they disagree, the budget rail has
   a hole and everything stops until it is fixed.

## Tax

Every dev-position sale is a taxable disposal; creator fees are income at
receipt. At volume this becomes hundreds of events per month. Cost basis is
recorded per position at open (`positions.entry_price`, `entry_sol`,
`realized_pnl_sol`) precisely because back-filling it later is painful. This
records the data; it does not do your accounting.

## Scope

Built: trend detection, scoring, saturation avoidance, token creation, a
single-wallet dev position with rule-based exits, creator-fee claiming.

Deliberately **not** built: multi-wallet bundling or sniper wallets to conceal
dev ownership, wash trading to fake volume, automated shilling from sock-puppet
accounts. Those turn a legal fee-harvesting bot into market manipulation with
real prosecution history, and they are self-defeating here — a token that gets
rugged stops generating the fee stream that is the entire point.
