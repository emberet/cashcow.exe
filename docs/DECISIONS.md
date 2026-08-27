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


---

## 20. The wallet address and balance are published by default

**Decision.** The public page shows the dev wallet's address and balance, with a
link to an explorer. `web.showWallet` turns it off; the admin portal ignores that
flag and always shows it.

**Reasoning.** Both facts are already public. The page lists the mint of every
token it created, and a pump.fun token names its creator on chain — so the
address is one lookup away, and the balance follows from the address. Withholding
them would not conceal anything from a determined reader; it would only make
honest verification harder, on a page whose entire credibility rests on showing
its own duds.

**The real cost, stated plainly.** Publishing does make *casual* tracking
trivial rather than merely possible, and it advertises capacity to anyone
running a competing bot. That is a genuine competitive cost, distinct from
privacy, which is why the flag exists. But the launches themselves are already
listed, so the marginal disclosure is small.

**Implementation note.** `configuredWalletAddress()` returns null when no wallet
is configured, because `loadWallet` invents an ephemeral throwaway keypair in dry
run. Publishing that would be worse than publishing nothing: it looks like a real
wallet and changes on every restart.


---

## 21. The pipeline gates are deep-linkable, and the depth respects the delay

**Decision.** Each of the eight gate cards is an `<a href="#gate-N">`, opening an
in-page detail panel. Real anchors rather than click handlers, so every gate is
shareable, the browser back button works, and it degrades to a plain link with
no routing code.

**What the depth is allowed to contain.** The same disclosure rule that governs
the decline list applies per gate, because the gates are where launch intent
lives:

| gates | depth shown | why it is safe |
|---|---|---|
| 1–3 | per-source volume, phrase ratios, sighting thresholds | pure aggregate, no candidate named |
| 4 | score histogram of decisions **already made**, last 7 days | the live queue is never shown — publishing what is near the line is a launch tip |
| 5–7 | named terms, from the **delayed** decline record only | old enough to be useless to a front-runner |
| 8 | the launches themselves | already on chain |

**An empty delayed list is a normal state, not a fault**, and says so: "nothing
has aged past the 6-hour delay yet". A blank panel would read as broken.

**The panel opens where you clicked, and never moves the page.** The first
version scrolled the panel into view, which yanked the page out from under the
reader on every click, and a second click on the same gate did nothing — an
anchor to the hash you are already on fires no `hashchange`, so the panel just
sat there looking dead.

Both were fixed by the same idea: put the panel *inside* the gates grid as a
full-width item and compute its `order` so it lands directly beneath the row
holding the clicked gate. Adjacent content needs no scrolling. On top of that:

- clicking the open gate closes it (the click handler intercepts the
  already-current hash and clears it),
- the open gate is highlighted and its hint changes to "click to close", so the
  second click is discoverable,
- Escape and a CLOSE button also close it,
- the column count is read from the computed grid and recomputed on resize, so
  the row maths holds at every breakpoint,
- the panel is a persistent node whose contents are only rebuilt when the data
  actually changes, so a background push every few seconds cannot tear it down
  mid-read.

Closing uses `replaceState`, not `pushState`: Back should leave the page, not
reopen what was just dismissed.


---

## 22. Publish what it reads, chronologically, with every source named

**Decision.** A live "what the cow is reading" list on the public page: source
name, publisher where known, the source's own headline, and a link to the
original. Also surfaced inside the gate-1 panel.

**Why this leaks nothing.** These are public feeds — Google News, Hacker News,
Wikipedia, /biz/ — that anyone can open. The edge was never in knowing which
sources exist; it is in the scoring and the saturation check. What *would* leak
is the ranking, so the list is ordered by time and never by score. Sorting it
would publish exactly which topics sit near the launch line.

**Two things this required.**

*Keeping the source's own words.* Signals stored only the extracted key phrase,
because that is what scoring compares. A reading list built from those showed
"Former Illinois" and "drummer" instead of headlines. Migration v6 adds
`source_text` so display gets the original and scoring keeps the phrase.

*A different filter for display than for launching.* The launch filters reject
brands, people and tragedies, because those are legal hazards when you MINT a
token about them. A news headline about a company or a disaster is just news.
Filtering the reading list through the launch rules would have misrepresented
what the bot actually reads, so display is filtered on slurs and the operator
blocklist only.

**Links are `noopener noreferrer nofollow` and open in a new tab**, since every
one of them is attacker-controlled text from a third-party feed.


---

## 23. Security review before mainnet: two real defects, one control that held

A review run against the live system before any real money. Each finding was
demonstrated against the running build first, then fixed, then re-attacked.

### Finding 1 — login throttling keyed on a spoofable header (High)

`clientIp()` trusted `X-Forwarded-For` unconditionally, and the per-address
login lockout keyed on it. Measured against the running server: a fixed address
locked out after 8 attempts, while **rotating the header allowed 30 of 30
guesses with zero throttling** — the lockout was decorative against anyone who
knew it was there.

Compounding it, scrypt ran at defaults, ~24ms per guess.

**Fix.** Throttling now keys on the socket peer address, which a client cannot
forge. `X-Forwarded-For` is display-only, and only when `web.trustProxyHeader`
says a proxy really is in front. scrypt raised to N=2^17, ~8x the work per
attempt. Re-attacked: 8 allowed, 22 throttled.

**Why it mattered.** Loopback-only today, but this project has repeatedly
discussed exposing the dashboard. Admin compromise reaches force-sell, fee
claims and the kill switch.

### Finding 2 — unvalidated URL scheme reaching an href (Medium, CSP-contained)

Feed URLs went into `<a href>` after HTML-escaping only. **Escaping does not
touch the scheme**, so `javascript:alert(1)` survived intact — demonstrated end
to end through `readingList`, including the `  jAvAsCrIpT:` padding-and-case
variant. A Hacker News submission URL is whatever the submitter typed, so this
was reachable by anyone.

**Severity was checked, not assumed.** The page's own CSP (`script-src 'self'`)
blocks `javascript:` execution — verified in the browser, the payload did not
fire. So this was contained, not live. It is still fixed at the source, because
a single control is a single point of failure and the URLs also enable ordinary
phishing.

**Fix.** `safeHttpUrl()` allows only `http:`/`https:`, strips leading control
characters first, and is applied both at ingestion and on read — old rows must
not become clickable retroactively.

### What held — the tuner allowlist

Feed text is attacker-controlled and flows into the tuner's evidence, so a
hostile headline is a prompt-injection vector by construction. Fed a fully
compliant model emitting `risk.maxSolPerDay: 999`, `devPosition.buySol: 10`,
`filters.blockTrademarks: 0` and `dryRun: 0`, **six of seven were rejected and
only the legitimate `scoring.threshold` was accepted.**

This is the payoff for §9: the mandate is an allowlist in code, not an
instruction in a prompt. A prompt would have been argued with.

---

## 24. The admin password lives in the database, with `.env` as the bootstrap

**Context.** The portal had exactly one password field — the login box. Rotating
the password meant running the CLI, copying a hash, and hand-editing `.env`.
Asked for a reset panel, the honest answer was that an *unauthenticated* one
hands the portal to anyone who can reach `/admin`. What was built is the version
that belongs in a portal: change password, current password required, behind an
existing session and CSRF token.

**The actual design problem was storage, not UI.** `authState`, `login` and
`validateSession` all read `process.env.ADMIN_PASSWORD_HASH` at call time. A
browser cannot durably change an environment variable, and rewriting the
operator's `.env` from a request handler is invasive and easy to corrupt.

**Decision.** Store the rotated hash in the existing `kv` table;
`ADMIN_PASSWORD_HASH` is the bootstrap credential and `kv` wins when present. No
migration — `kv` has existed since v1. A scrypt hash there is no worse than the
session-token hashes already stored alongside it, and because every reader hits
the store on each call, a rotation takes effect with no restart.

**The sharp edge, and the mitigation.** Once an override exists, editing `.env`
silently does nothing — an excellent way to lock yourself out while believing
you fixed it. So: `admin-password --save` writes straight to `kv`,
`--clear` drops the override, `authState` names the source it is complaining
about, and the CLI refuses to print a hash line that a live override would make
a no-op without saying so.

**Rotation revokes every session, including the caller's.** "Someone else has a
session I did not authorise" is a primary reason to change a password; a
rotation that left other sessions alive would miss the point.

**Two smaller things fixed on the way.** The change endpoint gets its own
throttle bucket, separate from login — the session is what authorises the call,
but `verifyPassword` at N=2¹⁷ is ~200ms of CPU, so an authenticated client could
otherwise pin a core by hammering it. And the CLI prompt now refuses a
non-TTY stdin: on EOF the prompt never resolved and the process exited 0 having
done nothing, which under `--save` was indistinguishable from success.

---

## 25. What pump.fun actually accepts for a listing, with sources

pump.fun is not a documented API, so every claim here carries a link. Checked
2026-08-26. Re-verify before trusting it — they change without notice.

| Thing | Value | Source | Confidence |
|---|---|---|---|
| Coin image min resolution | **1000×1000px**, 1:1 square, ≤15MB, `.jpg/.gif/.png` | [pump.fun help — create a coin](https://intercom.help/pumpfun-web/en/articles/11002205-create-a-coin-on-pump-fun) | verified, primary |
| Banner | 1500×500 (3:1), ≤5MB, gifs allowed, **"only settable during coin creation. Cannot be changed later."** | same | verified, primary |
| Metadata after creation | Immutable — "the contract is renounced upon creation which makes the Metadata Immutable" | same | verified, primary |
| Metadata JSON fields | `name`, `symbol`, `description`, `image`, `showName`, `createdOn`, optional `twitter`/`telegram`/`website` | [Moralis](https://docs.moralis.com/web3-data-api/solana/tutorials/get-pump-fun-token-metadata), [PumpPortal](https://pumpportal.fun/creation/) | corroborated, third-party |
| A `banner` field in that JSON | **No evidence one exists** | absent from every source searched, and from `@pump-fun/pump-sdk` 1.36.0 | unverified, leaning no |
| `pump.fun/api/ipfs` upload | **Dead.** Bring your own pinner | [pumpdotfun-sdk#70](https://github.com/rckprtr/pumpdotfun-sdk/issues/70), [PumpPortal](https://pumpportal.fun/creation/) | corroborated |
| Symbol max | 10 chars (we use 3–8, `[A-Z0-9]`) | [Moralis](https://docs.moralis.com/web3-data-api/solana/tutorials/get-pump-fun-token-metadata) | corroborated |
| Description max | **Not published by pump.fun.** Ours is a choice | — | our decision, not theirs |

**Two defects this found.**

The image was rendered at **512×512 — below pump.fun's own 1000×1000 floor.**
Raised. This is free: the image is referenced by IPFS URL, not embedded, so it
costs pin size and never the ~17 bytes of packet headroom §18 leaves us.

The description had **two disagreeing limits** — the model prompt asked for ≤120
characters while both code paths truncated at 200. A compliant model wrote 120;
a chatty one got cut mid-word. One config key now feeds the prompt and both
truncations.

**Why there is still no banner support.** A banner cannot be added after
creation, so if it is settable at all it is at mint time — and nothing in the
SDK's create instruction (`name`/`symbol`/`uri` only) nor any documented
metadata field carries one. Building a renderer against a guessed field name
would spend render time and pin cost on something silently discarded. Left
unbuilt and documented instead. If the field is ever confirmed, the banner
render is a near-copy of the logo path.

**Still unproven: the upload path has never run.** `src/assets/ipfs.ts` returns
`https://example.invalid/...` whenever `PINATA_JWT` is unset off-mainnet, which
is exactly what both devnet launches used. Mainnet refuses to launch without the
key, so this fails safe — but it means the real Pinata pin, and therefore
everything in the table above, is untested in this codebase. The first mainnet
launch would be its first real exercise.

## 26. Deduping our own trends over 24h, separately from market crowding

Raising throughput from 3 launches/day to 45 changed what the saturation check
had to survive. At 3/day the odds of two candidates in one day being the same
topic were low. At 45/day, with ten feeds all reacting to the same news cycle,
it is the expected case — "Crypto Market", "crypto markets" and "Crypto Market
Crash" are one story arriving three times.

**The gate was open, and measurably so.** Seeded with the live DB row for
`Crypto Market` (launched two hours earlier) and run through the real
`checkSaturation`:

| candidate | similarity | verdict before |
|---|---|---|
| `Crypto Market Crash` | 0.90 | launched |
| `CryptoMarket` | 0.85 | launched |
| `crypto markets` | 0.78 | launched |
| `crypto market rally today` | 0.90 | launched |

Two mechanisms existed and neither closed it:

- **`maxSimilar: 2`** is a *tally*, and self-launches and market tokens land in
  the same one. Our own two-hour-old token supplied only 1 of the 2 hits needed,
  so the near-duplicate went out. Lowering it to 1 is not the fix — it would
  mean a single unrelated token anywhere on pump.fun blocks every launch.
- **`neverRelaunchSameTerm`** is an *exact* normalised-key match. One extra word
  and it does not fire.

The two questions are genuinely different and were being answered by one knob.
*"Is this trend crowded?"* is a count, where one other token is normal.
*"Did we already mint this?"* is a boolean, where one is already one too many.

**Decision: a separate self-dedupe gate.** `findSelfDuplicate()` rejects on a
single hit among our own launches in a rolling `selfDedupeHours` (default 24)
window, with its own `selfDedupeSimilarity` floor. Market crowding keeps its
count-based logic untouched.

It runs **before** the market HTTP call, per the standing rule that free
rejections come first — repeating ourselves is now diagnosed with zero network.

**Two things it compares that the old path could not.** The model renames
trends, so the term and the minted name diverge: "Fed Rate Decision" can mint as
"MoneyPrinter". Checking only the term would miss the next candidate that is
plainly the same coin; checking only the name would miss the same topic renamed
differently. Both are compared, and the reason string names which one matched.

**A second checkpoint after naming.** The upstream gate sees only the term, and
has no symbol at all — the ticker does not exist until the model has run. So the
check runs again on the generated identity, next to the existing filter
re-check, and before the image render and IPFS pin. This is what catches two
dissimilar terms that both mint as near-identical names or an identical ticker.
It throws `DuplicateIdentityError`, handled as a decline rather than a failure
so it does not count toward the consecutive-error breaker.

**Not added to the tuner allowlist.** Both keys are pickiness, not money, so
Invariant 3 would permit it — but the 24h window was an explicit operator
instruction and the tuner should not quietly erode it. Default-deny means no
change was needed to keep it out.

**Known limitation:** the window counts dry-run and simulated launches too, the
same as `everLaunched` and `selfLaunched` before it. A long dry-run session
therefore suppresses real launches of those topics for 24h. That errs toward
fewer launches, which is the safe direction, so it is left as is.

## 27. Serving the dashboard from a domain, and keeping it up

The public dashboard ran on a Cloudflare **quick tunnel** — anonymous, random
hostname, dead the moment the process stopped or the Mac slept, and back as a
*different* random URL. Unshareable and unbookmarkable by construction.

**Named tunnel over the alternatives.** Port-forwarding plus Caddy would expose
the home IP, need router access, and break on every ISP address change. A VPS
adds cost and a second machine to maintain. The tunnel makes only *outbound*
connections, hides the origin IP, and terminates TLS at Cloudflare's edge.

**Buying at Cloudflare Registrar was load-bearing, not incidental.** The domain
lands in the account with Cloudflare nameservers already authoritative, so
`tunnel route dns` works immediately. Registering elsewhere adds a nameserver
repoint and hours of propagation before the CNAME target — which only resolves
inside a Cloudflare zone — can be created at all.

**The tunnel points at 4601 and must never point at 4600.** Two web processes
run: 4600 is the bot's own dashboard with `adminEnabled: true`, and 4601 is a
separate instance under `public.config.json` with admin off. Aiming the tunnel
at 4600 would publish the admin portal to the internet. The distinction is
verified by asserting `/admin`, `/api/admin/snapshot` and `/api/login` all
return **404** on the public hostname — proving the surface is *absent*, not
merely password-guarded. A catch-all `http_status:404` rule means any other
hostname arriving on the tunnel gets nothing.

No code changed. Every client path is already relative (including the SSE
`EventSource("/api/stream")`), the server reads `Host` only to parse the
pathname, and the CSP is origin-agnostic (`default-src 'self'`). Both servers
still bind loopback only, so the tunnel is the sole ingress.

**LaunchAgents, not a LaunchDaemon.** The bot must run as the user — it needs
the repo, `.env`, and the keypair — and a tunnel starting at *boot* while the
bot starts at *login* would serve 502s in the gap. Starting them together at
login is the coherent pairing, and avoids running a money-spending process as
root. `WorkingDirectory` must be the repo: that is what makes `src/cli.ts` find
`.env`, and therefore what makes the admin password and API keys load at all.

**`cloudflared service install` generates a broken plist.** It writes
`ProgramArguments` containing only the binary path with no subcommand, so
cloudflared prints its usage text and exits on every launch attempt — while
still reporting "installed successfully". The domain returned 530 with the
agent showing status 1 and no process. It needs the explicit `tunnel run
<name>` and an absolute `--config`, because launchd neither expands `~` nor
runs a login shell and will not otherwise find `~/.cloudflared`. `KeepAlive`
was also changed from exit-code-conditional to unconditional.

**Known exposure:** this is a laptop. `pmset -c sleep 0` only covers AC power,
and closing the lid sleeps the machine regardless, which drops the tunnel.

## 28. The safety gates read `network`; the money follows `rpc.primary`

Found by inspection, not by loss, and only because the wallet happened to be
empty on the other chain.

`config.json` had `rpc.primary` pointing at `mainnet.helius-rpc.com` while
`network` still said `devnet`, with `dryRun: false` and `launch.simulate:
false`. Those two fields are read by different things:

- Every mainnet-specific interlock keys on `cfg.network`. Invariant 8 — live
  mainnet requires `ANTHROPIC_API_KEY` for the brand/likeness screen — checks
  `network === "mainnet-beta"` and stands down otherwise.
- Transactions are built and sent against whatever `cfg.rpc.primary` resolves
  to.

So a config claiming devnet was signing against real mainnet with every
mainnet guard disarmed. Nothing was lost for exactly one reason: a Solana
keypair is the same address on both chains, and that address held 0 SOL on
mainnet, so transactions failed on insufficient funds. Funding the wallet —
which was already on the task list — would have removed the only thing standing
in the way.

**The mismatch is silent by design elsewhere in the file.** `redactedConfig()`
drops the RPC endpoint entirely (Invariant 12: API keys live in those URLs), so
the dashboard cannot show the disagreement, and the startup banner logs
`network` without the endpoint. Nothing surfaces the pair together.

Fixed by repointing to `devnet.helius-rpc.com` — Helius uses one API key across
both networks and differs only by hostname, so the credential was preserved.

**The general lesson:** `network` is a *label*; `rpc.primary` is the *fact*. Any
future guard that means "are we spending real money?" should derive that from
the endpoint, or the two should be validated against each other in
`assertCoherent()`. Until that exists, treat changing `rpc.primary` as
equivalent to changing `network`, and re-run `preflight` after either.

## 29. Resetting throughput off the devnet numbers

The caps were sized for devnet, where SOL is free and refillable: 45
launches/day x 0.2 SOL = 9 SOL/day, with `maxSolPerDay: 9` chosen to be exactly
that product. On mainnet that is ~10 SOL/day of real money, and section 1 has
the arithmetic on why a high launch rate loses: per-launch costs are fixed and
certain, the payoff is heavy-tailed and rare.

Reset to **9 launches/day at an unchanged 0.2 SOL dev buy** — 1.8 SOL/day of
buys, ~2.03 SOL/day including the ~0.025 create cost.
`maxConcurrentPositions` came down from 45 to match, having been dead slack.

**`maxSolPerDay` was then cut from 9 to 2.5, and this is the point of the
change.** Left at 9 it would no longer bind: the launch path implies 2.03, so a
bug in exits, fee claims or retries could spend 4x what the launch cap suggests
with nothing watching. `assertCoherent()` permits it (1.8 < 9) because it only
rejects a launch cap the SOL budget *cannot fund* — it has no opinion on a
ceiling that is merely far too loose. A backstop that cannot be reached is not a
backstop.

Lowering it immediately surfaced a second problem: `assertCoherent()` refused
the config because `maxDailyLossSol` was still 5, above the new 2.5 ceiling —
*"the loss circuit-breaker can never trip."* It had been coherent only by
accident of the old, larger ceiling. Set to 1.5, so the day halts after losing
60% of the allowance with room for the loss to be realised before the spend
ceiling trips first and masks it.

## 30. Going live on mainnet, and an empty env var that faked an invalid config

`network` and `rpc.primary` were switched to mainnet **together**, per §28, with
`launch.simulate: true` so the bot builds and simulates the real create+buy
against mainnet without sending it. Simulation books to the pretend ledger via
`isPretend()`, so it cannot consume the real daily allowance. `simulate` goes
false only once a simulation has passed *and* the wallet holds SOL.

Sizing was already done for a 0.2 SOL balance (§29 follow-on): dev buy 0.05,
1 launch/day, 0.1 SOL/day ceiling, 0.06 SOL loss breaker. `capacity` confirms
cost/launch 0.0768 SOL, which clears the 0.05 SOL `reserveSol` floor that is
held back for exits and never spent on launches.

**`config.json` is in the public dashboard's config chain.** The layering in
`loadConfig()` is `default.config.json` → `config.json` → `TRENDBOT_CONFIG`, so
`public.config.json` inherits `network`, `dryRun` and the RPC endpoint rather
than declaring them. That is what keeps the public page from advertising a
different chain than the bot signs against, and it is why that file — which is
tracked in git, unlike `config.json` — must never carry the RPC URL: the API
key is in it. The header comment there previously claimed it layered only on
`default.config.json`, which was wrong and would have invited a duplicate,
drifting copy of `network`.

### The failure worth remembering

Immediately after the switch, every CLI command died with *"Live mainnet run
without `ANTHROPIC_API_KEY`"* — invariant 8 refusing to start. The key was
present in `.env`, correctly spelled, 108 bytes of clean ASCII, and the loader
reads `.env` before the config. The file was not the problem.

`process.loadEnvFile()` **does not overwrite a variable that already exists in
the environment**, and the interactive shell exported `ANTHROPIC_API_KEY` as an
*empty string*. The empty value therefore won over the real one from `.env`,
`Boolean("")` is false, and the gate fired. A present-but-empty variable is
strictly worse than an absent one here: absent would have loaded correctly.

The bot itself was never affected. Its LaunchAgent environment holds only
`HOME`, `LOGNAME`, `PATH`, `SHELL`, `SSH_AUTH_SOCK`, `TMPDIR`, `USER` and the
`XPC_*` pair — no shadow — so `.env` populates cleanly. This was a diagnostic
artifact of the terminal, not a defect in the config or the deployment, and the
distinction matters: the obvious "fix" of loosening invariant 8, or setting
`filters.allowUnscreenedLive`, would have disabled a real brand/likeness
safeguard to work around a shell quirk.

To reproduce a CLI run the way the bot sees it: `env -u ANTHROPIC_API_KEY node
src/cli.ts <cmd>`.

## 31. What a hard reboot found: a startup race on the database

The reboot test was passed deliberately rather than assumed. All three
LaunchAgents came back unattended, both servers rebound to loopback only, the
tunnel reconnected, and `https://cashcowexe.win` served 200 with `/admin`,
`/api/admin/snapshot` and `/api/login` all still 404. The database survived the
unclean shutdown intact: `PRAGMA integrity_check` returned `ok`, the WAL
replayed, and all 100,273 signals were present.

One thing did not survive cleanly, and it had been happening since the two
LaunchAgents were installed.

**The bot and the public web server race for `data/bot.db` at startup, and the
loser used to die** with `database is locked`. At boot both agents start
together, and one of them lost.

The first fix was wrong, and the way it was wrong is the useful part. It
attributed the crash to `migrate()` opening a transaction, and set
`PRAGMA busy_timeout` to make contention wait instead of failing. Both halves
were mistaken:

- `migrate()` opens no transaction when there is nothing to migrate — the loop
  body never runs once `user_version` matches. Verified by holding a write lock
  from a second process and calling `openDb()`: it succeeded in 0ms.
- The stack had said so all along. It named `db.ts:298`, which was
  `PRAGMA journal_mode = WAL`, not `migrate()`. The claim was asserted from
  reading the code rather than from the evidence already in the log.

**`PRAGMA journal_mode` is the one statement `busy_timeout` cannot help.**
Changing the journal mode requires exclusive access, and SQLite returns
SQLITE_BUSY *without ever invoking the busy handler*. Measured: with
`busy_timeout` at 3000ms it still failed in 0ms. So the original fix could not
have protected the failing line — and it was placed *after* that line anyway,
where it could not have applied to it even if the pragma had honoured it.

It was invisible for three reasons, which is the interesting part:

- `KeepAlive` restarted the crashed process ~0.4s later and the retry won the
  lock, so the system self-healed.
- The only symptom was the public dashboard being unreachable for the
  `ThrottleInterval` (~10s) after each boot — easy to attribute to "still
  booting".
- `launchctl list` showed it plainly as last-exit **1** on `com.cashcow.public`,
  but a non-zero exit next to a running PID reads as historical noise.

The actual fix has two parts, for the two actual problems:

1. **Read the journal mode before writing it.** Reading is an ordinary read and
   takes no exclusive lock, and on every boot after the first the answer is
   already `wal`, so the contended statement is never issued at all. Only a
   genuine conversion contends, and that path gets a bounded retry
   (`WAL_RETRIES` x `WAL_RETRY_MS`) because no timeout can cover it.
2. **Set `busy_timeout`, and set it FIRST.** It does not help journal_mode, but
   it does cover the migrations and every ordinary write afterwards, which
   would otherwise also fail instantly under contention. Ordering is
   load-bearing rather than stylistic: the pragma only affects statements
   executed after it.

`com.cashcow.public` now reports last exit 0 after a simultaneous restart.

**On the tests.** The first version of this test suite was theatre for the part
that mattered: it asserted the timeout pragma was set, and separately
demonstrated the timeout mechanism on a connection it configured itself — so
that second test passed with or without the fix, and neither test touched
`journal_mode`, the line that actually crashed.

The replacement reproduces the crash rather than describing it: a real second
process takes a write lock on a not-yet-WAL database, and `openDb()` must
still complete. Verified in both directions — it fails against the original
code (throws in ~26ms) and passes against the fix (waits ~760ms for the holder
to release, then succeeds). A separate process is required; an in-process
connection would not reproduce the boot scenario, and node:sqlite's synchronous
API means a blocking wait in the test process would deadlock against any timer
meant to release the lock.

**Sleep.** `sudo pmset -c sleep 0` is applied — AC power shows `sleep 0`. Note
that *battery* still shows `sleep 1`, so unplugging drops the site after a
minute, and the lid caveat from §27 is unchanged.

---

## 32. Cloudflare cached the stylesheet but not the HTML, so new markup rendered against old CSS

**Symptom, as reported:** "There is a sizing issue and it's missplaced" —
minutes after the social links shipped to `cashcowexe.win`.

**What was actually happening.** The origin sends `cache-control: no-cache` on
every static file (`serveStatic`). Cloudflare's default Browser Cache TTL
overrides that for static extensions and leaves HTML alone, which the response
headers show plainly:

```
GET /            -> cache-control: no-cache      cf-cache-status: DYNAMIC
GET /styles.css  -> cache-control: max-age=14400 cf-cache-status: EXPIRED
GET /app.js      -> cache-control: max-age=14400
```

So `index.html` is always fresh and `styles.css` is up to four hours stale, at
the edge *and* in the visitor's browser. A returning visitor got the new
`nav.social` markup with a stylesheet that had never heard of `.social`.

**Why that was not merely cosmetic.** An inline `<svg>` with a `viewBox` and no
intrinsic size resolves to the width of its container. With the icon rule
missing, each logo expanded to fill the column — measured at **1228x1228px**,
turning the footer into a page-sized GitHub octocat. That is the "sizing issue"
and the "misplaced", and it is one defect, not two.

Reproduced deterministically rather than inferred: deleting every rule whose
`cssText` contains `.social` from the live stylesheet and re-measuring gives
`svgW: 1228, navH: 2541`.

**Two fixes, because either alone leaves a hole.**

1. **Content-hashed asset URLs.** `serveStatic` rewrites `/styles.css`,
   `/app.js` and `/admin.js` references in served HTML to `?v=<sha256[:10]>`.
   A stale copy is then never *requested*, and correctness stops depending on
   an edge setting that lives outside this repo. A query string rather than a
   renamed file, because the router keys on `url.pathname` — nothing has to be
   rewritten on the way back in. Hashes are memoised for the process lifetime;
   a deploy restarts it.
2. **`width`/`height` attributes on the inline icons.** The CSS still sets the
   real size, but the attributes are the floor when the stylesheet is stale or
   fails to load entirely. This is the part that would have made the bug
   invisible instead of spectacular.

**On verification.** The first attempt at these links was shipped on structural
checks alone — HTML nesting, balanced CSS braces, no `display:none` collision —
because no headless browser was to hand. Every one of those checks passed on a
page that was visibly broken, because none of them modelled a visitor whose
cache disagreed with the server. Structural checks cannot see a layout; the
defect was found by rendering the page and measuring the icons.

**Test.** `test/web-assets.test.ts` asserts the versioning rewrite, that the
version is derived from real file bytes, that no asset referenced by a page is
missing from `VERSIONED_ASSETS`, and that both social icons carry explicit
dimensions. The last one was verified to fail against the pre-fix markup.
