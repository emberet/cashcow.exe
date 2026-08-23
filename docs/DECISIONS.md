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

**Reasoning.** pump.fun is not deployed on devnet, so a dry run *cannot* read
real bonding-curve state. Pretending otherwise would make the dry run look like
it validated the chain path when it did not. What a dry run proves is the signal
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
