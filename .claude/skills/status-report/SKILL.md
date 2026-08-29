---
name: status-report
description: Produce a single concise operational status report for cashcow.exe -- mode (dry-run/live), halt state, recent P&L, budget headroom, open positions, launch outcomes, and what's currently getting declined and why. Use whenever the user asks for a "status report", "status update", "how's the bot doing", a health check, or a daily/periodic summary. Read-only: runs no state-changing commands.
---

# cashcow.exe status report

Produces one readable snapshot of the bot's current state by running a fixed
set of read-only CLI commands and synthesizing their output into a short
report -- not a wall of raw command output. Read `CLAUDE.md` at the repo
root first if it isn't already in context.

## How to generate the report

Run from the repo root (`/Users/srinjoydas/Downloads/cashcow`). Use
`env -u ANTHROPIC_API_KEY` in front of each command -- see `CLAUDE.md`'s
shell-empty-var gotcha; an empty `ANTHROPIC_API_KEY` in the shell otherwise
beats a real one in `.env`.

Run these five, all read-only, none spend money or change state:

```
env -u ANTHROPIC_API_KEY node src/cli.ts budget       # halted?, launches/SOL/loss vs daily caps
env -u ANTHROPIC_API_KEY node src/cli.ts profit        # fees, realised P&L, net profit
env -u ANTHROPIC_API_KEY node src/cli.ts positions     # open + recently closed dev positions
env -u ANTHROPIC_API_KEY node src/cli.ts outcomes      # hit/modest/dud rate across settled launches
env -u ANTHROPIC_API_KEY node src/cli.ts declined      # what's being turned away right now, and why
```

Optionally, if the question is specifically about *why nothing is
launching* or feed health, also run `capacity` and `feeds` (see
`cashcow-ops`'s skill for the full read-only command list and what each
answers).

## How to write the report

Keep it terse -- a handful of lines per section, not the raw console
output pasted back. Structure:

1. **Mode & safety** -- dry-run or live; halted or not (and why, if halted);
   which network (`devnet`/`mainnet-beta`).
2. **Money** -- net profit to date, today's spend/launches against the daily
   caps from `budget`, open positions and their unrealised state.
3. **Track record** -- launches settled, hit rate, best peak market cap
   (from `outcomes`).
4. **What's happening right now** -- top 2-3 decline reasons from
   `declined` (e.g. "SOMEONE GOT THERE FIRST ×N", "ALLOWANCE GONE ×N") --
   this is usually the most informative part of a status report, since it
   says what the bot is seeing and rejecting, not just what it launched.
   Repeat entries already collapse to `term (×N)` -- do not re-count
   duplicates yourself.
5. One-line verdict: is anything actionable, or is it healthy and just
   waiting.

Do not editorialize beyond the numbers, and do not run any state-changing
command (`halt`, `resume`, `boost-window`, `learn --apply`, `fees --claim`,
etc.) as part of a status report -- if the numbers suggest one of those
would help, name it and ask, same as `cashcow-ops`'s confirm-before-running
rule.
