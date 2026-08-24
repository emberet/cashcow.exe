# Status

Honest state of play. Updated 2026-08-24.

---

## Verified

| Area | How |
|---|---|
| Safety rails, exit rules, filters, saturation, tuner guardrails, adaptive capacity | **92 tests**, `npm test` |
| Types | `npx tsc --noEmit` clean, no build step |
| Feed adapters | Live polls. 6 of 9 enabled feeds producing; 300 signals/poll |
| Full signal pipeline | End-to-end dry run: feeds → phrases → score → filters → saturation → naming → artwork → recorded launch |
| Budget enforcement | Dry run hit the daily launch cap and stopped correctly |
| Dashboard, both surfaces | Rendered and screenshotted at 800px and 1440px; no console errors; no horizontal overflow |
| Gate funnel + declines | Recorded per tick and rendered; counts reconcile against the launch log |
| Admin security boundary | curl: unauth → 401, wrong password → 401, missing/bad CSRF → 403, path traversal → 404 |
| Secret containment | Admin payload scanned — no wallet secret, no password hash, no RPC URL |

---

## Not verified

**A launch has never been *sent*, but it now simulates cleanly.** On 2026-08-24
the full create + dev-buy transaction was built and simulated against the real
pump.fun program on **devnet**: `err: NONE`, 173k compute units, with
`Instruction: Create`, `Instruction: Buy` and `GetFees` all succeeding. That
closes the biggest gap. What remains untested is an actual signed send, a real
sell, and a real fee claim — all blocked only on funding a devnet wallet.

**Nothing has been sent to any chain.** Simulation proves the instructions are
valid; it does not prove send/confirm/retry, nor that a position can be exited.

**Polymarket is unconfirmed.** The Gamma API was unreachable from the build
machine while every other host resolved normally — likely an egress restriction
or datacenter-IP block, not a code fault. The adapter is written to spec and
needs one live confirmation from your network.

**The tuner has never learned from real data.** It refuses to run below 20
settled launches and there are none. Its guardrails are tested exhaustively; its
*judgement* is untested.

**No mainnet economics.** Every number about fees earned is projection from the
published fee schedule, not observation.

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

3. **Mainnet, one manual launch at the smallest dev buy.** Verify on Solscan:
   mint created, metadata resolves from IPFS, dev buy landed, position recorded.
   Wait for trades, then confirm `node src/cli.ts fees` reports a non-zero vault
   and a claim lands SOL back in the wallet. **This is the only test that proves
   the revenue model works end to end. Do not enable full auto before it passes.**

4. **Full auto, conservative caps, watched for 24h.** Reconcile the spend ledger
   against the real wallet delta. If they disagree, the budget rail has a hole and
   everything stops until it is fixed.

5. **Accumulate 20+ settled launches, then enable learning** in propose-only mode.
   Read what it proposes before ever setting `autoApply`.

---

## Prerequisites to gather

- Solana CLI — `sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"`
- Dedicated RPC (Helius/Triton) — public endpoints will rate-limit you out of
  contention on exactly the launches worth winning
- Pinata JWT (free tier) — pump.fun's own IPFS endpoint is deprecated
- `ANTHROPIC_API_KEY` — **required** for live mainnet; powers naming, the
  brand/likeness screen, and the tuner
- `ADMIN_PASSWORD_HASH` via `npm run admin-password` — the portal is disabled
  without it
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
