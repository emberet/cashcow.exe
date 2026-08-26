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
npm test                       # 170 tests — run before every commit
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
  add the next. Currently at v7.
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
- **Some hosts are blocked from some networks.** Polymarket's Gamma API was
  unreachable from the build machine while every other host resolved. If a feed
  returns nothing, check reachability before assuming a parsing bug.
- **The dashboard runs under CSP with `script-src 'self'`.** No inline scripts or
  event handlers. `style-src` allows inline (Chrome counts CSSOM writes as inline
  styles, so there is no way around it) — keep `script-src` strict.
- **`[hidden]` needs `!important`** in `styles.css`; any class setting an explicit
  `display` beats the UA rule and the element stays visible.
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

---

## Expectations for changes

- Add tests for anything touching money, timing, or the tuner allowlist. Those
  three are where a silent regression is expensive.
- If you fix a bug that a test would have caught, add the test in the same change
  and say in the comment what it is protecting against.
- Run `npm test` and `npx tsc --noEmit` before committing.
- Keep the safe-by-default posture: new features ship off, new limits ship tight.
