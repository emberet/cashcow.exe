# CLAUDE.md — working in this repo

cashcow.exe detects breaking trends across ten sources, mints the best ones as
tokens on pump.fun, takes a small rule-bounded dev position, and earns primarily
through creator fees. TypeScript on Node 26 (native type stripping — there is no
build step), `node:sqlite`, official `@pump-fun/pump-sdk`.

**This bot spends real money autonomously.** Read the invariants before changing
anything.

---

## Invariants

These are load-bearing. Several were added *because* something went wrong in
testing — the reasons are in `docs/DECISIONS.md`. Do not relax one without
understanding what it was protecting against.

1. **`BudgetGuard` is the only path to spending SOL.** Every chain call routes
   through `canSpend`/`assertCanSpend` before building a transaction and
   `record()` after it settles. A code path that spends without touching it is a
   bug, not a shortcut.

2. **The kill switch stops new launches and never blocks an exit.**
   `allowsPositionExits()` returns a constant `true` on purpose. If halting also
   froze exits, hitting the brake would strand every open position and the safety
   feature would become the thing that loses the money.

3. **The tuner allowlist in `src/learning/guardrails.ts` is a security boundary.**
   It can change how *picky* the bot is; it can never change how much money the
   bot may lose. Adding a config key does not make it tunable — the list is
   default-deny. Never add anything under `risk.*`, `devPosition.*`, `filters.*`,
   `launch.*`, `wallet.*`, or `rpc.*`.

4. **The web process never holds the wallet key.** Admin actions that cost money
   are enqueued to the `commands` table and executed by the bot. Do not "simplify"
   this by importing the wallet into a request handler.

5. **Timing logic uses `ingested_at`, never `observed_at`.** Source timestamps
   are untrustworthy — a /biz/ sticky reports a creation time 16 months old, which
   once made a two-minute-old bot report 484 days of history and silently satisfy
   the cold-start warmup gate. `observed_at` is display metadata only.

6. **Saturation fails closed.** If the market lookup errors, the trend counts as
   saturated and the launch is skipped. Not launching is free; launching blind
   into a crowded trend is not.

7. **Safe by default.** `dryRun: true`, `network: devnet`, loopback-only
   dashboard, admin portal disabled without a password, learning off. A
   misconfiguration must fail into *less* activity, never more.

8. **Live mainnet requires `ANTHROPIC_API_KEY`** for the brand/likeness screen.
   Startup refuses otherwise. The static blocklist demonstrably leaks (see
   findings). Override exists (`filters.allowUnscreenedLive`) but is off.

9. **The wallet address and balance are published; the SECRET never is.** Both
   are already public on-chain, so the dashboard shows them (`web.showWallet`
   opts out of the public page only). The private key is a different matter
   entirely — see below.

10. **Anything security-relevant keys on the socket address, never a header.**
    `X-Forwarded-For` is attacker-supplied; trusting it for login throttling
    allowed 30 of 30 password guesses. It is display-only, gated behind
    `web.trustProxyHeader`.

11. **Never put a third-party URL in an `href` without `safeHttpUrl()`.**
    HTML-escaping does not touch the scheme, so `javascript:` survives it. Feed
    URLs are whatever a stranger typed.

12. **Secrets never reach logs, the database, or the dashboard.** The logger
   redacts on key name; `redactedConfig()` omits the RPC endpoint entirely because
   API keys live in those URLs.

---

## Commands

```bash
npm test                       # 279 tests — run before every commit
npx tsc --noEmit               # typecheck (no build step; Node strips types)

npm run preflight              # verify every credential BY USING IT; nothing is signed
npm run preflight -- --for-mainnet   # judge mainnet readiness while still on devnet
npm run preflight -- --links   # signup links for everything that is missing

npm run dry-run                # full pipeline, zero transactions, no keys needed
node src/cli.ts run --once     # single pass (useful under cron)
node src/cli.ts run --web      # bot + dashboard together

npm run feeds                  # poll every feed once, report what each returned
npm run score                  # ranked candidates with score components
node src/cli.ts capacity       # launches/day the wallet sustains, and why
node src/cli.ts outcomes       # what happened to launched tokens
node src/cli.ts learn --mandate  # exactly what the tuner may touch
node src/cli.ts tuning --clear # discard everything learned
node src/cli.ts halt "reason"  # stop launches (exits continue)
node src/cli.ts boost-window --hours 24  # temporarily widen risk caps + the
                                #   scoring gate, self-reverting; see Gotchas
node src/cli.ts boost-window --status   # is a window active, and until when
node src/cli.ts boost-window --clear    # cancel a window early
node src/cli.ts profit [--record]  # net profit to date; --record snapshots the
                                #   calculated 40/50/10 split (needs distribution.enabled)
node src/cli.ts backtest-launches  # one-time historical research pass; proposes
                                #   scoring changes, never edits config itself
```

`feeds` and `score` force a poll; the runner respects each feed's own cadence.

---

## Architecture

```
feeds/      ten adapters behind one interface; failures isolated per feed
scoring/    phrases → score → independence → saturation → filters
assets/     naming (Claude, doubles as risk screen) → image → IPFS pin
chain/      wallet, rpc, launch, trade, fees, market lookup
risk/       budget guard, kill switch, adaptive capacity
positions/  cost basis at open, rule-based exits
learning/   outcomes → tuner → guardrails → overlay
web/        public dashboard + admin portal, SSE push
runner/     orchestrator: two cadences (fast exits, slow launches)
```

**Gate order matters.** Everything that can reject for free runs before anything
that costs money: halt → warmup → threshold → content filters → self-dedupe →
saturation → budget → *then* the model call, image render, and IPFS pin.

Self-dedupe and market saturation answer different questions and are separate
knobs on purpose — see `docs/DECISIONS.md` §26. `maxSimilar` is a crowding
*tally* (one other token is normal); `selfDedupeHours`/`selfDedupeSimilarity`
are a *boolean* on our own recent launches, where one hit is already too many.
Do not merge them back together. The dedupe check runs a second time on the
generated identity, because the ticker does not exist until the model has run.

---

## Gotchas

- **An empty `ANTHROPIC_API_KEY` in the shell beats the real one in `.env`.**
  `process.loadEnvFile()` never overwrites a variable that already exists, and
  some terminals export the key as `""`. Invariant 8 then refuses to start on
  mainnet with *"Live mainnet run without ANTHROPIC_API_KEY"* even though the
  key is sitting in `.env`, correct. Present-but-empty is worse than absent. Run
  `env -u ANTHROPIC_API_KEY node src/cli.ts <cmd>` to see what the bot sees. Do
  not "fix" this by setting `filters.allowUnscreenedLive` — that disarms the
  brand/likeness screen to paper over a shell quirk. The LaunchAgents are clean.
- **`config.json` is in the *public* dashboard's config chain too.** Layering is
  `default.config.json` → `config.json` → `TRENDBOT_CONFIG`. So the public page
  inherits `network`/`dryRun`/RPC from `config.json` and always reports the chain
  the bot really signs against. Do not re-declare those in `public.config.json`,
  and never put the RPC URL there — it holds an API key and that file is tracked.
- **`node:sqlite` returns null-prototype objects.** Fine to read, surprising to
  spread.
- **Migrations are append-only** in `src/util/db.ts`. Never edit an existing one;
  add the next. Currently at v10.
- **`launch.simulate` builds the real transaction and simulates it.** Stronger
  evidence than `dryRun`, which never touches the chain. Both book against the
  pretend ledger via `isPretend()` — a simulation must never consume the real
  daily allowance.
- **pump.fun's frontend endpoints are not a documented API.** `frontend-api-v3`
  works and `frontend-api` returns 530. They can change without notice —
  DexScreener is wired as a structurally different fallback.
- **pump.fun IS on devnet, and it works.** An earlier version of this file said
  otherwise; that was wrong and cost a lot of assumed effort. Verified 2026-08-24:
  the program, its global config and the fee program are all live on devnet, and
  a full create+buy simulates cleanly. **testnet** carries a stale deployment the
  SDK cannot even decode — use devnet, never testnet. No local validator needed.
- **The launch transaction is within ~17 bytes of the packet limit.** Measured
  worst case (32-char name, 8-char symbol, Pinata CIDv1 URI) is 1215 of 1232
  bytes. `createV2AndBuyV2` (33 accounts) does not fit at all and
  `createV2AndBuy` (25) overflows with a real URI, so the v1 `createAndBuy`
  (23 accounts) is the only workable path until an address lookup table exists.
  Anything that adds an account or lengthens the URI will break launches.
- **pump.fun's `searchTerm` is fuzzy across name AND symbol.** Searching
  `CYBERLEEK` returns a 2025 coin called "Retarded CyberLeak Uri" whose ticker
  is `P1SS`. So "an older coin came back from the search" does NOT mean "an
  older coin has this ticker" — `ogCheck.ts` compares `normalizeSymbol()` on
  each row, and without that it would brand the genuine OG a copycat. The same
  endpoint also caps results, so "no earlier match found" only means something
  once the page reaches past the candidate's own creation time; otherwise the
  answer is `unknown`, not `og`.
- **Some hosts are blocked from some networks.** Polymarket's Gamma API was
  unreachable from the build machine while every other host resolved. If a feed
  returns nothing, check reachability before assuming a parsing bug.
- **The dashboard runs under CSP with `script-src 'self'`.** No inline scripts or
  event handlers. `style-src` allows inline (Chrome counts CSSOM writes as inline
  styles, so there is no way around it) — keep `script-src` strict.
- **`[hidden]` needs `!important`** in `styles.css`; any class setting an explicit
  `display` beats the UA rule and the element stays visible.
- **Cloudflare caches `styles.css`/`app.js` for 4h but not the HTML.** The origin
  says `no-cache` on everything; the edge overrides it for static extensions
  only. So markup and stylesheet can disagree in a visitor's browser for hours.
  `serveStatic` appends `?v=<content hash>` to asset URLs to close this — any
  new asset a page references must be added to `VERSIONED_ASSETS`.
- **Give every inline `<svg>` `width`/`height` attributes.** With a `viewBox` and
  no intrinsic size it fills its container: one icon rendered at 1228px when a
  cached stylesheet lacked its rule. CSS sets the real size; the attributes are
  the floor. See `docs/DECISIONS.md` §32.
- **`signals.term` is the extracted PHRASE; `signals.source_text` is the
  source's own words.** Scoring compares phrases; anything shown to a reader
  should use `source_text`, or it renders fragments like "Former Illinois".
- **Display filtering is deliberately weaker than launch filtering.** The launch
  filters reject brands/people/tragedies because minting those is a legal
  hazard. Reading a headline about them is not. The reading list filters on
  slurs only — do not "fix" this by applying the full filter set.
- **Do not name a CSS class `panel` for anything but a tab panel.** `.panel` sets
  `display: none`, and reusing it for card headings silently hid every heading on
  both pages. Card headings are `h4.cardtitle`.
- **Fonts are self-hosted** in `public/fonts` (Bagel Fat One, Baloo 2, latin
  subset, ~55KB). Do not swap them for a Google Fonts link — `font-src 'self'`
  would block it, and the dashboard should work with no network.
- **`boost-window` is the sanctioned way to temporarily widen launch activity
  — never hand-edit `config.json`'s `risk.*`/`scoring.threshold` for
  "testing".** That was tried once: a comment promised to revert 10/0.85/0.5/5
  back to the deliberate 1/0.1/0.06/1 baseline "when testing is done," and the
  revert never happened because nothing forced it to. `src/risk/
  experimentalWindow.ts` fixes that structurally: `node src/cli.ts
  boost-window --hours 24` writes a bounded, timestamped record to `kv` that
  `BudgetGuard` (via `effectiveRisk()`) and `launchTick`/`score` (via
  `effectiveScoring()`) read live on every decision — no restart to apply it,
  no restart or external cron to revert it. Every field is clamped to
  `EXPERIMENTAL_CEILINGS` (hardcoded, separate from the request) and the
  scoring floors reuse the tuner's own vetted `TUNABLE` bounds, so a human
  override can never be more permissive than what the tuner is already
  allowed to reach. This is **not** the tuner: separate storage (`kv`, not
  `data/tuning.json`), separate trigger (a human on the CLI, not the learning
  loop), and it cannot touch `filters.*`/`wallet.*`/`rpc.*`/`launch.*`/
  `devPosition.*` at all — only four `risk.*` numbers and
  `scoring.threshold`/`minObservations`. Fails closed: a missing, malformed,
  or expired `kv` row is treated as no window, never as a wider one. Note
  `computeCapacity()` (`src/risk/capacity.ts`) also had to route through
  `effectiveRisk()` — `BudgetGuard.setCapacity()` always re-clamps to
  `min(capacity, effectiveRisk)`, so leaving capacity on the un-windowed
  static value would have silently defeated the window whenever adaptive
  capacity is off (the default).
- **`withBalanceLock()` (`src/chain/rpc.ts`) is a process-local, in-memory
  lock — it does nothing across two processes sharing the same wallet.** It
  serializes launch/fee-claim/sell balance-delta measurements *within one
  Node process* (see the comment at its definition: a fee claim once landed
  inside a launch's snapshot window and made a real ~0.025 SOL cost measure
  as 0). Running a second bot process against the same `wallet-keypair.json`
  — two LaunchAgents, a stray `run --once` left running, a manual CLI
  invocation racing the live loop — reintroduces exactly that class of bug
  with no lock protecting against it, because the two processes don't share
  the `Promise` this closes over. There is currently no code-level guard
  against this; it is an operational invariant (one writer process per
  wallet) enforced by convention only. Check `ps`/`lsof` for stray processes
  before starting another one against a live wallet.
- **"More volume" is a discovery-quality problem, not a trading problem —
  `src/feeds/onchain.ts`'s `curveProgress()` and `src/feeds/dexActivity.ts`
  are gmgn.ai-inspired, both scoring-layer only.** gmgn.ai (a multi-chain meme
  trading terminal) surfaces trending/"almost bonded" tokens and smart-money
  wallet flow; it has no documented free public API, so neither signal calls
  it — both are reimplemented against data already fetched from pump.fun's
  own frontend API and DexScreener's per-token endpoint
  (`src/research/volume.ts`'s `fetchDexActivity`, previously backtest-only).
  `curveProgress()` is an *estimate* (`usd_market_cap / graduationMarketCapUsd`)
  because true bonding-curve reserves need a per-mint RPC read, and the
  closest existing analog (`src/chain/holders.ts`) fails against the free
  public mainnet RPC almost every time — see `test/research.test.ts`.
  `dexActivity`'s `organicBuyPressure()` (`src/scoring/organicFlow.ts`) is
  **deliberately bounded, not monotonic**: a lopsided buy/sell split is the
  documented fingerprint of an untested pump *or* a wash-trading bot in
  `src/research/classify.ts`'s own `DEFAULT_THRESHOLDS`, so a near-100% buy
  share scores 0, not higher — reusing `washSuspicionScore()` as a hard
  dampener rather than rewarding the pattern the bot's own research code
  already distrusts. The dampener only applies when `replyCount > 0`:
  verified live (2026-08-27) that pump.fun's `reply_count` is chat activity
  on the coin's OWN pump.fun page, which reads 0 for essentially every
  token once trading has migrated to a DEX — a real coin with $1.4M in 24h
  DexScreener liquidity and 43k real transactions showed `reply_count: 0`.
  Treating that as infinite wash suspicion zeroed out nearly every genuine
  post-migration candidate, not just wash-shaped ones, so `replyCount === 0`
  is treated as UNKNOWN, same idiom as `classify.ts`'s
  `top10ConcentrationPct === null`. `dexActivity` ships `enabled: false` (new fan-out
  pattern — up to `maxCandidatesPerPoll` DexScreener calls per poll, not
  one) and both feeds share `onchain`'s `crypto` family
  (`src/scoring/independence.ts`) rather than inventing a new one, since both
  read the same underlying pump.fun population. Neither signal touches
  `qualifying()`, filters, self-dedupe, or saturation — see `docs/DECISIONS.md`
  §2 for why wash trading, multi-wallet bundling, and shilling are explicitly
  excluded from this codebase and always will be.

---

- **`docs/self-improvement.md` is generated and gitignored — `tuning_runs`
  (SQL) is the real audit trail.** `src/learning/selfImprovementLog.ts`'s
  `appendSelfImprovementEntry()` is called from every `runTuning()` path
  except the disabled one (`src/learning/tuner.ts`), including the "not
  enough evidence yet" cycles, so a human can watch the trend in one
  readable file instead of querying the DB. It writes nothing at all while
  `learning.enabled` is false. This is not a new tunable surface — the set
  of things the tuner can touch is still exactly `guardrails.ts`'s
  `TUNABLE` allowlist, unchanged. To opt into a faster, fully-autonomous
  cadence, set in your own `config.json` (never `default.config.json`,
  which keeps its off-by-default posture): `"learning": { "enabled": true,
  "intervalHours": 3, "autoApply": true }` — `minSampleSize`,
  `maxChangesPerRun`, and every guardrails bound stay at their existing
  values, so this only runs the same already-bounded decision more often,
  it does not make any single decision bigger. The log file is capped at
  the 500 most recent entries (oldest trimmed, header always kept) so it
  can't grow unbounded on a long-running bot.

## Expectations for changes

- Add tests for anything touching money, timing, or the tuner allowlist. Those
  three are where a silent regression is expensive.
- If you fix a bug that a test would have caught, add the test in the same change
  and say in the comment what it is protecting against.
- Run `npm test` and `npx tsc --noEmit` before committing.
- Keep the safe-by-default posture: new features ship off, new limits ship tight.
