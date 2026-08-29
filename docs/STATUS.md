# Status

Honest state of play. Updated 2026-08-27.

**This bot is live on mainnet and has been spending real SOL since
2026-08-24.** Anything below that still says "mainnet untested" is stale —
kept only where it describes what devnet proved before that date. See
`docs/DECISIONS.md` for the mainnet go-live entry and `node src/cli.ts
profit`/`outcomes` for the current, real P&L.

---

## Verified

| Area | How |
|---|---|
| Safety rails, exit rules, filters, saturation, tuner guardrails, adaptive capacity | **279 tests**, `npm test` |
| Types | `npx tsc --noEmit` clean, no build step |
| Feed adapters | Live polls. 6 of 9 enabled feeds producing; 300 signals/poll |
| Full signal pipeline | End-to-end dry run: feeds → phrases → score → filters → saturation → naming → artwork → recorded launch |
| Budget enforcement | Dry run hit the daily launch cap and stopped correctly |
| Dashboard, both surfaces | Rendered and screenshotted at 800px and 1440px; no console errors; no horizontal overflow |
| Gate funnel + declines | Recorded per tick and rendered; counts reconcile against the launch log |
| Admin security boundary | curl: unauth → 401, wrong password → 401, missing/bad CSRF → 403, path traversal → 404 |
| Gate detail panels | open/close/toggle, Escape, deep links, zero scroll movement, correct row placement at 4/2/1 columns |
| Reading list | 24 items, every link `noopener noreferrer nofollow`, sources named, no overflow at 375px |
| Wallet display | address + balance on both surfaces; `web.showWallet:false` hides it from public but not admin |
| Secret containment | Admin payload scanned — no wallet secret, no password hash, no RPC URL |

---

## Not verified

**~~The chain path has never executed.~~ It has now.** On 2026-08-24 two real
tokens were created on **devnet** with a real dev buy, and one was sold, with a
funded wallet:

| step | result |
|---|---|
| create + dev buy | `F6WLRW36…` sig `2W8Geaji…`, confirmed, no error |
| mint / supply | exists, 1,000,000,000 supply |
| dev buy landed | 50,494,116 tokens held |
| bonding curve | created, creator = our wallet |
| sell | sig `K3bFJ7EW…`, 0.048740429 SOL returned |
| position closed | reason `max_hold`, P&L −0.00126 SOL (round-trip fee drag) |
| ledger reconciliation | measured launch: **zero drift to 9 decimals** |
| creator fee claim | correctly skipped — vault holds exactly its rent, nothing claimable |

**A successful fee *collection* has never happened.** The claim path reads the
vault correctly and correctly declines to claim dust, but no claim has returned
SOL — that needs real trading volume on a launched token, which devnet does not
naturally provide. Manufacturing that volume by trading against our own token
would be wash trading in shape, so it was not done even with play money.

**Correction: mainnet is no longer untested.** Devnet proved the mechanics
first, as intended, but the bot has been live on mainnet since 2026-08-24 —
see the "Path to live" steps below, all of which are now behind it. Priority-fee
competition, whether tokens actually get traded, and real fee income are now
things `node src/cli.ts outcomes`/`profit`/`budget` report on directly, not
open questions.

**Polymarket is unconfirmed.** The Gamma API was unreachable from the build
machine while every other host resolved normally — likely an egress restriction
or datacenter-IP block, not a code fault. The adapter is written to spec and
needs one live confirmation from your network.

**The tuner has never learned from real data.** It refuses to run below 20
settled launches and there are none. Its guardrails are tested exhaustively; its
*judgement* is untested.

**Mainnet economics are now observed, not projected** for launches that have
happened — `node src/cli.ts outcomes` and `profit` report real, settled
figures. Fee income is still an estimate rather than a measurement per-token
(see "Known limitations" below on why), and the sample size is still small
enough that a trend line is not yet meaningful.

---

## Path to live

1. ~~Local validator with the cloned program~~ — **not needed.** pump.fun runs on
   devnet. This step existed because of a wrong assumption.

2. **Devnet, funded.** A wallet already exists at `data/devnet-keypair.json`
   (gitignored). The public faucet is rate-limited from this machine; fund it at
   <https://faucet.solana.com> with its pubkey, then:
   ```bash
   TRENDBOT_CONFIG=devnet.json node src/cli.ts run --once   # launch.simulate: true
   ```
   Then flip `launch.simulate` to false for a real signed devnet launch, and
   exercise a sell and a fee claim. **Use devnet, not testnet** — testnet's
   deployment is stale and the SDK cannot decode it.

3. ~~Mainnet, one manual launch at the smallest dev buy.~~ **Done, 2026-08-24.**
   `config.json` has run with `dryRun: false`, `network: mainnet-beta` since.
   Verify current state with `node src/cli.ts fees`/`outcomes` rather than
   trusting this file's prose to stay current.

4. ~~Full auto, conservative caps, watched for 24h.~~ **In progress, ongoing.**
   The bot has been running full auto on mainnet since step 3. Reconcile the
   spend ledger against the real wallet delta periodically (`node src/cli.ts
   budget`); if they disagree, the budget rail has a hole and everything stops
   until it is fixed.

5. **Accumulate 20+ settled launches, then enable learning** in propose-only mode.
   Read what it proposes before ever setting `autoApply`.

---

## Prerequisites to gather

Run `npm run preflight -- --for-mainnet` to see which of these are actually
missing, and `npm run preflight -- --links` for the signup links. Each check
*uses* the credential rather than testing that it is non-empty — a revoked key
and an absent one look identical to `echo $VAR`, and only one of them is obvious.

- `ANTHROPIC_API_KEY` — <https://console.anthropic.com/settings/keys>
- Pinata JWT (free tier) — <https://app.pinata.cloud/developers/api-keys>
- Dedicated RPC — <https://dashboard.helius.dev/signup>,
  <https://www.quicknode.com/chains/sol>, <https://www.alchemy.com/solana>
- Mainnet wallet — generated locally, never a signup

- Solana CLI — `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`
- Dedicated RPC (Helius/Triton) — public endpoints will rate-limit you out of
  contention on exactly the launches worth winning
- Pinata JWT (free tier) — pump.fun's own IPFS endpoint is deprecated
- `ANTHROPIC_API_KEY` — **required** for live mainnet; powers naming, the
  brand/likeness screen, and the tuner
- `ADMIN_PASSWORD_HASH` via `npm run admin-password` — the portal requires
  either the environment hash or a saved database override. `admin-password --save`
  stores the hash in the database instead, where it takes precedence over the
  environment variable; the portal can then rotate it in-place.
- Optional feeds: Reddit OAuth app, Neynar key, X API (pay-per-use, off by
  default)
- A **fresh** dev wallet funded only with write-off capital

---

## Known limitations

- **Brand/likeness screening is imperfect without the model layer.** See
  `docs/DECISIONS.md` §6. The heuristic also blocks legitimate two-word trends
  like "Moo Deng" — accepted cost, one config flag away.
- **pump.fun's frontend endpoints are not a documented public API.** Saturation,
  on-chain momentum, and outcome tracking use them and can break without notice.
  DexScreener is wired as a structurally different fallback for saturation.
- **Per-token creator fees are estimated, not measured.** pump.fun claims fees in
  bulk across every token a wallet created, so they can only be apportioned by
  each token's share of observed performance. The exact total is in `fee_claims`.
  Every surface showing the estimate says so.
- **Pre-fix rows carry inflated history.** Signals migrated from before the
  `ingested_at` fix have it backfilled from `observed_at`, so an old database
  still reports an inflated span until those rows age out. Delete `data/bot.db`
  for a clean baseline.

---

## Open item: tax

Every dev-position sale is a taxable disposal; creator fees are income at
receipt. At volume this becomes hundreds of events per month. Cost basis is
recorded per position at open (`positions.entry_price`, `entry_sol`,
`realized_pnl_sol`) precisely because back-filling it later is painful. **This
records the data; it does not do your accounting.**
