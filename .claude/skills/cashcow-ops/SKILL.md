---
name: cashcow-ops
description: Operate and explain cashcow.exe (the pump.fun trend-detection/launcher bot in this repo) from chat -- check whether it's healthy, run feeds/score/outcomes/capacity/profit, read what a halt or boost-window means, and point to the right CLI command instead of hand-editing config.json. Use when the user asks about the bot's current state ("is it running / healthy / safe"), wants a diagnostic run, asks why it isn't launching, wants more/fewer launches temporarily, or asks what the tuner has been doing. This skill explains and runs read-only/reversible ops commands -- it does not launch a token directly, move money, or bypass BudgetGuard/the kill switch.
---

# Operating cashcow.exe

cashcow.exe detects trends across ten feeds, scores them, and launches the
best ones on pump.fun, earning mainly via creator fees. It spends real money
autonomously when live. This skill is for *observing and operating* it from
chat -- not for changing what it's allowed to do. Read `CLAUDE.md` at the repo
root first if it's not already in context; the invariants there (BudgetGuard
is the only spend path, halt never blocks exits, the tuner allowlist is a
security boundary, safe-by-default) apply to everything below.

## Before running anything

- Run commands from the repo root (`/Users/srinjoydas/Downloads/cashcow`).
- `npm run <x>` and `node src/cli.ts <x>` are equivalent for the commands
  that have an npm alias; use whichever reads more clearly.
- **The `ANTHROPIC_API_KEY` shell-empty-var gotcha**: if a command fails
  with "Live mainnet run without ANTHROPIC_API_KEY" even though `.env` has
  one, an empty value is already exported in the shell and
  `process.loadEnvFile()` won't override it. Run `env -u ANTHROPIC_API_KEY
  node src/cli.ts <cmd>` to see what the bot actually sees. Never work
  around this by touching `filters.allowUnscreenedLive`.
- `TRENDBOT_CONFIG=<path> node src/cli.ts <cmd>` points at a config *file*
  to override `config.json` for one-off testing -- it's a path, not inline
  JSON.

## Read-only / safe to run without asking

These never spend money or change state -- run them freely to answer a
"what's going on" question:

```
node src/cli.ts feeds [--feed <id>]   # poll every feed once, what each returned
node src/cli.ts score                 # ranked candidates with score components
node src/cli.ts positions             # open + recent dev positions
node src/cli.ts budget                # rolling 24h spend/launch/loss picture
node src/cli.ts capacity [--balance N]  # launches/day the wallet sustains, and why
node src/cli.ts outcomes [--refresh]  # what happened to launched tokens
node src/cli.ts tuning                # current overlay + last 10 tuning runs
node src/cli.ts learn --mandate       # exactly what the tuner may touch, and why
node src/cli.ts boost-window --status # is a boost window active, until when
node src/cli.ts profit                # net profit to date (no --record)
node src/cli.ts preflight [--links]   # verify credentials by using them
```

Also read `docs/self-improvement.md` if it exists (gitignored, generated) --
it's a running log of every tuning cycle, including the "not enough evidence
yet" ones, in plain English. `node src/cli.ts tuning` is the authoritative
source if the two ever disagree.

## State-changing -- confirm with the user before running

These are reversible but change what the bot does live. Explain what will
happen and get a yes before running, same as any other side-effecting
action:

```
node src/cli.ts halt "reason"         # stop new launches (open positions still exit)
node src/cli.ts resume                # clear the halt
node src/cli.ts boost-window --hours N [--reason "..."] [...]
                                       # temporarily widen risk caps + scoring
                                       # gate, self-reverting, clamped to
                                       # EXPERIMENTAL_CEILINGS
node src/cli.ts boost-window --clear  # cancel a window early
node src/cli.ts learn --apply         # apply the tuner's proposed changes now
node src/cli.ts tuning --clear        # discard everything the tuner has learned
node src/cli.ts fees --claim          # claim pump.fun creator fees
node src/cli.ts profit --record       # snapshot the 40/50/10 distribution split
```

**Never hand-edit `config.json`'s `risk.*` or `scoring.threshold` for
"temporary" testing.** That was tried once, the revert never happened, and
`boost-window` exists specifically to fix that structurally (bounded,
timestamped, self-reverting). Always reach for `boost-window` instead.

## Never run from chat without explicit confirmation

`node src/cli.ts run [--web]` and `node src/cli.ts web` start the actual
long-running bot/dashboard process -- that's an operator decision (usually a
LaunchAgent/systemd unit), not something to kick off inconsequentially from
a chat session. `node src/cli.ts run --once` does a single pass under the
*same* pipeline -- if the config is live (not `dryRun`) and a candidate
clears every gate, it really launches and really spends SOL. Treat it the
same as the long-running form: explain what it will do (and whether the
config is currently `dryRun`) before running it. Same posture for
`admin-password --save/--clear` (changes login credentials) and
`backtest-launches` (a real historical-data pass that takes a while and
needs `SOLANA_RPC_URL`) -- fine to explain, confirm before actually running.

## Common questions -> what to run

- **"Is it healthy / what's it been doing?"** -> `outcomes`, `profit`,
  `capacity`, `positions`, `budget`, in that rough order.
- **"Why isn't it launching?"** -> check `boost-window --status` (is a
  window active/expired), then `score` (is anything clearing
  `scoring.threshold`), then `feeds` (are sources actually returning
  signals). Remember: halt only stops *new* launches -- `positions` still
  shows open ones exiting normally.
- **"I want more launches for a while."** -> `boost-window --hours N`, not
  a config edit. Explain the ceilings it's clamped to
  (`src/risk/experimentalWindow.ts`'s `EXPERIMENTAL_CEILINGS`) so the user
  knows the actual bound before confirming.
- **"How's the tuner doing / what has it changed?"** -> `tuning`,
  `docs/self-improvement.md`, `learn --mandate` for what it's even allowed
  to touch.
- **"Is it safe to go live on mainnet?"** -> `preflight --for-mainnet`.

## What this skill will not do

It will not launch a token, transfer funds, or touch anything under
`risk.*`/`devPosition.*`/`filters.*`/`launch.*`/`wallet.*`/`rpc.*` in
`config.json` -- those are the same invariant boundaries `CLAUDE.md` and
`src/learning/guardrails.ts` already enforce in code. This skill is a
faster way to *read* and *operate within* those boundaries from chat, not a
way around them.
