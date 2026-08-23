# CLAUDE.md — working in this repo

TrendBot detects breaking trends across ten sources, mints the best ones as
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

9. **Secrets never reach logs, the database, or the dashboard.** The logger
   redacts on key name; `redactedConfig()` omits the RPC endpoint entirely because
   API keys live in those URLs.

---

## Commands

```bash
npm test                       # 92 tests — run before every commit
npx tsc --noEmit               # typecheck (no build step; Node strips types)

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
that costs money: halt → warmup → threshold → content filters → saturation →
budget → *then* the model call, image render, and IPFS pin.

---

## Gotchas

- **`node:sqlite` returns null-prototype objects.** Fine to read, surprising to
  spread.
- **Migrations are append-only** in `src/util/db.ts`. Never edit an existing one;
  add the next. Currently at v4.
- **pump.fun's frontend endpoints are not a documented API.** `frontend-api-v3`
  works and `frontend-api` returns 530. They can change without notice —
  DexScreener is wired as a structurally different fallback.
- **pump.fun is not on devnet.** Devnet validates wallet/signing/persistence only.
  Real launches need a local validator with the cloned program.
- **Some hosts are blocked from some networks.** Polymarket's Gamma API was
  unreachable from the build machine while every other host resolved. If a feed
  returns nothing, check reachability before assuming a parsing bug.
- **The dashboard runs under CSP with `script-src 'self'`.** No inline scripts or
  event handlers. `style-src` allows inline (Chrome counts CSSOM writes as inline
  styles, so there is no way around it) — keep `script-src` strict.
- **`[hidden]` needs `!important`** in `styles.css`; any class setting an explicit
  `display` beats the UA rule and the element stays visible.

---

## Expectations for changes

- Add tests for anything touching money, timing, or the tuner allowlist. Those
  three are where a silent regression is expensive.
- If you fix a bug that a test would have caught, add the test in the same change
  and say in the comment what it is protecting against.
- Run `npm test` and `npx tsc --noEmit` before committing.
- Keep the safe-by-default posture: new features ship off, new limits ship tight.
