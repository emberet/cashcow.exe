# Decisions

Why the system is shaped the way it is, and the evidence behind each choice.
Most of these exist because something measurable went wrong first. Read this
before relaxing an invariant in `CLAUDE.md`.

---

## 1. Creator fees are the revenue model; the dev position is secondary

**Context.** pump.fun pays creators a share of trade volume, tiered by market
cap — 0.05% to 0.95%, with the top band around $88k–$300k mcap.

**The arithmetic that shapes everything else.** Earning ~$100 at the *best* tier
requires roughly **$10,500 of trade volume on a single token**. Most pump.fun
launches never clear $1k in volume and only ~1–2% graduate, while every launch
costs rent plus priority fees whether or not anyone shows up.

**Consequence.** Launch throughput is not the lever people assume. A spray-and-
pray bot reliably loses money. Engineering effort went into *signal quality* and
*saturation avoidance* instead, and the deploy path is deliberately boring
plumbing.

---

## 2. Excluded from scope: bundling, wash trading, sock-puppet promotion

**Decision.** Built: trend detection, scoring, token creation, a single
transparent dev wallet with rule-based exits, creator-fee claiming. Not built,
and not to be added: multi-wallet bundling or sniper wallets to conceal dev
ownership, wash trading to fake volume, automated shilling from fake accounts.

**Reasoning.** Those convert a legal fee-harvesting bot into market manipulation
with real prosecution history. They are also self-defeating against *this*
revenue model — a token that gets rugged stops trading, and the fee stream that
is the entire point dies with it.

---

## 3. Saturation avoidance is the highest-leverage component

**Context.** Creator fees are a share of *this token's* volume. If forty tokens
already chase the same trend, volume fragments and a launch earns nothing while
still costing rent and priority fees.

**Evidence from live runs.** The check rejected trends with **17, 22, 25, and 44**
existing tokens already competing. Every one of those would have been a
guaranteed loss.

**Design.** Fuzzy name *and* ticker matching (identical symbol counts as a
collision even when names differ), our own launch history checked over all time,
and the market queried live. **The lookup fails closed** — an unverifiable market
counts as saturated, because skipping is free and launching blind is not.

---

## 4. `ingested_at` vs `observed_at` — source clocks are untrustworthy

**The bug.** Signals originally carried only the feed's own timestamp. /biz/
sticky threads report creation times over a year old, so a bot running for two
minutes computed **484 days of signal history** — which sailed straight through
the cold-start warmup gate built specifically to prevent launching on noise. It
also suppressed velocity for every 4chan term, since those signals all landed in
the "older" half of the comparison window.

**Fix.** Migration v3 added `ingested_at` (our clock). Warmup, velocity, decay,
and windowing all use it. `observed_at` is display metadata.

**Lesson worth generalising.** Any timing decision derived from data a third
party controls is a decision that third party can corrupt.

---

## 5. Corroboration is scored by source independence, not feed count

**Context.** Counting distinct feeds treats all agreement as equal. /biz/ and
on-chain momentum agreeing is close to one population talking to itself. Google
Trends and Hacker News agreeing is genuinely independent evidence.

**Design.** Feeds map to families — crypto, search, press, forum, social,
markets. One family scores 0 corroboration however many feeds are in it; three
independent families saturate. Extra feeds within a family add a token 0.05 each.

**Consequence.** This is what made it safe to lower the *hard* gate to a single
source. A lone /biz/ spike is admitted, scores 0 on corroboration, and must be
excellent elsewhere to qualify.

**Suggestive evidence.** In the outcome sample used to exercise the tuner, all
three duds came from single-source signals and all three hits came from
cross-family pairs. Sample far too small to be conclusive — noted as a hypothesis
for the tuner to confirm or kill on real data.

---

## 6. Brand and likeness screening needs the model; static lists demonstrably leak

**The evidence.** Successive live runs launched, in order: `usa network`
(TV network), `kevin keegan` (football manager), `isack hadjar` (F1 driver),
`sling tv` (TV service), `Trump`, `Liverpool`. Each fix caught that case and the
next run found a new one.

**Three layers, in increasing order of effectiveness.**
1. **Static blocklist** — catches the obvious, always incomplete.
2. **Capitalisation heuristic** — catches "Kevin Keegan". Google Trends
   lowercases its terms, so casing is first recovered from the attached news
   headline; when the headline lacks the term verbatim the heuristic stays blind.
   It is also blunt in the other direction — it blocks **"Moo Deng"**, a genuine
   trend, because a hippo is indistinguishable from a surname pair. Accepted: a
   missed launch is cheaper than a right-of-publicity claim.
3. **Model screen** — the only layer that reliably knows "Sling TV" is a brand.
   Rides free on the naming call that already happens.

**Decision.** A live mainnet run **refuses to start** without layer 3.
`filters.allowUnscreenedLive` overrides it deliberately.

---

## 7. Warmup and minimum observations — velocity is meaningless on a cold start

**The problem.** Velocity compares the recent half of the window against the
earlier half. On first run there *is* no earlier half, so every term scored a
perfect 1.00 and read as maximally accelerating. In full-auto that means
launching on the first glimpse of noise.

**Fix.** `warmupMinutes` (history must span it) and `minObservations` (a term
must be seen N times). Both measured on our clock — see decision 4.

---

## 8. Admin money actions go through a command queue

**Decision.** The web process enqueues; the bot executes. Pause/resume works
through the filesystem kill switch and needs no key at all.

**Reasoning.** The dev wallet key is loaded in exactly one process. No request
handler — and no bug in one — can sign a transaction. The worst a compromised
web layer achieves is queuing work the bot then runs under its own budget guard
and kill switch.

**Cost.** Latency. A force-sell waits for the next exit tick, bounded by
`devPosition.exit.pollSeconds` (default 15s). Worth it.

---

## 9. The tuner's mandate is an allowlist, not a prompt instruction

**Decision.** `src/learning/guardrails.ts` enumerates every tunable path with
absolute bounds and a per-run maximum delta. Everything else is rejected.
Forbidden prefixes are listed *explicitly* so the reason is on the record rather
than implied by absence.

**Why code and not prompt.** A prompt is a request; an allowlist is a gate. The
model is told the mandate for good behaviour, but compliance is not assumed.
Proposals to change `risk.maxSolPerDay` are logged as rejected, which is also
useful signal about what the model was reaching for.

**Defence in depth.** The overlay file is re-filtered through the same allowlist
on every *read*, so hand-editing a forbidden key into `data/tuning.json` does
nothing. Tests walk the declared forbidden list rather than spot-checking, so
adding a prefix without enforcement fails CI.

**Refusal to run below `minSampleSize` (default 20).** Tuning on eight outcomes
fits noise and calls it learning.

---

## 10. Launch capacity derives from wallet runway

**Context.** A fixed `maxLaunchesPerDay` is wrong in both directions — too low
for a funded wallet, far too high for a drained one.

**Design.** spendable balance ÷ runway days, capped by a daily burn percentage,
divided by cost per launch, then throttled if recent launches are losing money.
Adaptive capacity can only ever ask for *less* than `risk.maxSolPerDay`.

**Measured on shipped defaults** (cost/launch 0.0768 SOL):

| Wallet | With dev buy | Fee-only |
|---|---|---|
| 0.5 SOL | **0/day** | 2/day |
| 2 SOL | 3/day | 10/day |
| 10 SOL | 18/day | 48/day |

**Two findings.** The **dev buy is ~65% of cost per launch** — dropping it roughly
triples throughput on the same wallet. And a 0.5 SOL wallet yields **zero**
launches, not one: it cannot afford one while preserving a week of runway, so it
refuses rather than draining itself. That refusal is the feature.

---

## 11. Dry run short-circuits before any RPC call

**Decision.** `launchToken` returns before touching the network or the wallet
when `dryRun` is set; IPFS pinning is skipped; a missing wallet generates an
ephemeral throwaway keypair.

**Reasoning.** A dry run should prove the signal pipeline without needing any
credentials. (The original reasoning here also claimed pump.fun was not deployed
on devnet — see §15. That was wrong, but the short-circuit is still right: a
dry run should not require a wallet or an RPC at all.) What a dry run proves is the signal
pipeline — feeds, scoring, filters, saturation, naming, metadata. The chain path
is proven separately against a local validator running the cloned program.

**Bonus.** Zero setup. `npm run dry-run` works with no keys, no wallet, no
accounts.

---

## 12. Public dashboard withholds the candidate queue

**Decision.** The pre-launch queue is admin-only. The public page shows launches
only after they exist on chain.

**Reasoning.** A public page streaming "about to launch X" in real time is an
invitation to be front-run by anyone watching it, which destroys the edge the
whole bot depends on. Outcome verdicts *are* public, including duds — peak market
cap is public on pump.fun anyway, and honesty about failures is the page's
credibility.


---

## 13. The public page publishes rejections, but on a delay

**Context.** The gate funnel is the most interesting thing the bot produces —
it is the whole "where did the day go" story. But a live feed of *which* terms
were just rejected still reveals what the bot is looking at right now.

**Decision.** Aggregate funnel counts publish live; the named decline list is
held back by `web.declineDelayHours` (default 6). The admin portal sees both
immediately, since there is nothing to front-run yourself.

**A bug this caused, and the rule it produced.** The "right now" banner
originally counted the *delayed* decline list, so it announced "the plate is
clear" while the crowd-gate card next to it showed four rejections. Numbers on
one page must come from one source: the banner now reads the funnel.

---

## 14. The funnel counts what was examined, not what was scored

**The bug.** The launch loop stops examining candidates once the daily
allowance is gone. The first funnel implementation measured each gate against
the *scored* total, so a run that scored 597 and examined 9 reported "594 were
a real brand, real person, or tragedy" — a flattering lie that made the content
filter look like it was doing enormous work.

**Fix.** `pipeline_stats.examined` records how many were actually looked at.
Gate 5 reads "2 of 9 looked at", and gate 4 says plainly "588 never got looked
at — the allowance ran out first".

**The general rule.** A funnel that attributes unexamined items to a rejection
reason is not a funnel, it is marketing.


---

## 15. Correction: pump.fun runs on devnet, and testnet is a trap

**What was believed.** From planning onward this project asserted that pump.fun
is not deployed on devnet, so real launches could only be exercised against a
local validator running a cloned program. That claim reached the README,
CLAUDE.md, STATUS.md and the verification plan.

**It was wrong.** Verified 2026-08-24 by querying each cluster directly:

| cluster | program | global config | SDK `fetchGlobal` |
|---|---|---|---|
| devnet | present, executable | 1396 b64 chars | **OK** — `initialized`, `createV2Enabled`, 95bps/5bps |
| testnet | present, executable | 684 b64 chars | **fails** — layout offset out of range |
| mainnet | present, executable | 1396 b64 chars | OK |

**devnet is fully functional. testnet carries a stale deployment the current SDK
cannot decode.** So the local-validator step was never necessary, and "test on
testnet" is actively the wrong instruction.

**Why it matters beyond the fact itself.** The belief was sourced from
third-party writing rather than from the chain, and it then shaped a whole
verification plan. A claim that determines what you build should be checked
against the system itself, not against an article about the system. Querying
three RPCs took under a minute; the assumption stood unexamined for the entire
build.

---

## 16. The launch transaction barely fits in a packet

**The bug.** `createV2AndBuyV2Instructions` — chosen because it was the newest
API with the most features — produces **33 unique accounts**, and the resulting
message cannot be serialised at all. web3.js reports this as `encoding overruns
Uint8Array` from inside buffer-layout, which names neither the cause nor the
limit. Every launch would have failed.

**Measured on devnet**, worst case (32-char name, 8-char symbol, Pinata CIDv1
URI), including compute-budget instructions, against a 1232-byte limit:

| variant | accounts | bytes | fits |
|---|---|---|---|
| `createV2AndBuyV2` | 33 | does not serialise | no |
| `createV2AndBuy` | 25 | 1283 | no |
| `createAndBuy` (v1) | 23 | **1215** | yes, by 17 bytes |

**Decision.** Use the v1 `createAndBuy`. This costs the v2-only `cashback` flag,
which is now rejected at startup with an explanation rather than silently
producing an unsendable transaction. A size check runs before every send so the
failure mode is a sentence, not a buffer-layout stack trace.

**The 17 bytes are a standing hazard.** Any extra account, or a longer metadata
URI, breaks launches. The real fix is an address lookup table, which would
compress those 23 account references from 32 bytes to 1.

---

## 17. Repeated failures are systemic; stop trying

**The bug.** With an unfunded wallet, one tick produced **249 consecutive failed
launch attempts** — each one a model call, an image render, an IPFS step and
several RPC round trips — because the loop treated every failure as specific to
that candidate and moved to the next.

**Fix.** Three consecutive failures abandon the tick with an error naming the
likely causes. A failure that repeats is almost never something the next
candidate will dodge.


---

## 18. Create and sell must use the same program generation

**The bug.** After switching creation to the v1 `createAndBuy` (§16), selling
still used `sellV2Instructions`. A real devnet sell failed with AnchorError 3012
`AccountNotInitialized` on `associated_base_bonding_curve` — an account the v2
sell expects and the v1 create never initialises.

**Nothing caught this earlier.** Unit tests exercise the exit *rules*, not the
instruction encoding. Simulation caught the create path because that is what was
simulated; the sell only fails once a position actually exists to sell. It took
a real launch followed by a real sell.

**Rule.** The create and sell paths are a matched pair. Changing one to a
different program generation requires changing the other, and the only way to
know it worked is to launch and then exit on a real cluster.

---

## 19. Book the measured cost, not the estimate

**The drift.** The ledger recorded a flat `estimatedCreateCostSol` for each
launch. The first real devnet launch recorded −0.075000 against an actual
−0.075112: the base transaction fee was never booked.

**Fix.** `launchToken` measures the wallet balance either side of the send and
returns the real delta, which the ledger books in preference to the estimate.
The next launch reconciled to **zero drift at nine decimal places**.

**Why it matters more than 0.000112 SOL.** The reconciliation check in
`CLAUDE.md` says that if the ledger and the wallet disagree, the budget rail has
a hole and everything stops. That check is only usable if the ledger is exact
when nothing is wrong; a permanent small drift would train you to ignore it.
