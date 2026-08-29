import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { decideExit } from "../src/positions/manager.ts";
import { openPosition, listOpen, closePosition, recordSellFailure, listStuck } from "../src/positions/store.ts";
import { BudgetGuard } from "../src/risk/budget.ts";
import { ingestSignals, buildCandidates, qualifying, checkWarmup } from "../src/scoring/score.ts";
import { extractPhrases } from "../src/scoring/phrases.ts";
import { cryptoAffinity, tickerability } from "../src/scoring/affinity.ts";
import type { RawSignal } from "../src/feeds/types.ts";

const rules = configSchema.parse({}).devPosition.exit;

// ------------------------------------------------------------- exit rules

describe("exit rules", () => {
  test("takes profit at the configured multiple", () => {
    const d = decideExit(3.0, 5, rules);
    assert.equal(d.exit, true);
    assert.equal(d.exit === true && d.reason, "take_profit");
  });

  test("holds below the target and above the stop", () => {
    assert.equal(decideExit(1.5, 5, rules).exit, false);
    assert.equal(decideExit(0.8, 5, rules).exit, false);
  });

  test("stops out at the configured drawdown", () => {
    // Default stopLossPct is 50, so 0.5x is the boundary.
    const d = decideExit(0.5, 5, rules);
    assert.equal(d.exit, true);
    assert.equal(d.exit === true && d.reason, "stop_loss");
  });

  test("time limit forces an exit even while flat", () => {
    const d = decideExit(1.2, 31, rules);
    assert.equal(d.exit, true);
    assert.equal(d.exit === true && d.reason, "max_hold");
  });

  test("profit target wins when it and the time limit fire together", () => {
    // Realising a gain beats a mechanical timeout exit at the same instant.
    const d = decideExit(5.0, 999, rules);
    assert.equal(d.exit === true && d.reason, "take_profit");
  });

  test("stop-loss wins over the time limit when both fire", () => {
    const d = decideExit(0.2, 999, rules);
    assert.equal(d.exit === true && d.reason, "stop_loss");
  });

  test("thresholds come from config, not from constants", () => {
    const custom = configSchema.parse({
      devPosition: { exit: { takeProfitMultiple: 10, stopLossPct: 20, maxHoldMinutes: 120 } },
    }).devPosition.exit;
    assert.equal(decideExit(3, 5, custom).exit, false, "3x is no longer a target");
    assert.equal(decideExit(10, 5, custom).exit, true);
    assert.equal(decideExit(0.8, 5, custom).exit === true, true, "0.8x breaches a 20% stop");
    assert.equal(decideExit(1.1, 100, custom).exit, false, "120min limit not yet reached");
  });
});

// ------------------------------------------------------- position lifecycle

describe("position store", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  test("records cost basis at open", () => {
    const id = openPosition(db, {
      mint: "MintA", symbol: "AAA", entrySol: 0.05,
      entryTokens: "1000000", dryRun: false,
    });
    const [pos] = listOpen(db, false);
    assert.equal(pos?.id, id);
    assert.equal(pos?.entry_sol, 0.05);
    // Basis per token is captured now, not reconstructed at disposal time.
    assert.ok(Math.abs((pos?.entry_price ?? 0) - 0.05 / 1_000_000) < 1e-15);
  });

  test("closing computes realised P&L", () => {
    const id = openPosition(db, {
      mint: "MintB", symbol: "BBB", entrySol: 0.05, entryTokens: "1000", dryRun: false,
    });
    closePosition(db, id, {
      reason: "take_profit", exitSol: 0.15, exitTokens: "1000", entrySol: 0.05,
    });
    const row = db.prepare(`SELECT * FROM positions WHERE id = ?`).get(id) as Record<string, number | string>;
    assert.equal(row.status, "closed");
    assert.ok(Math.abs(Number(row.realized_pnl_sol) - 0.1) < 1e-9);
    assert.equal(listOpen(db, false).length, 0);
  });

  test("repeated sell failures mark a position stuck for a human", () => {
    const id = openPosition(db, {
      mint: "MintC", symbol: "CCC", entrySol: 0.05, entryTokens: "1000", dryRun: false,
    });
    assert.equal(recordSellFailure(db, id, "blockhash expired", 3), "retry");
    assert.equal(recordSellFailure(db, id, "blockhash expired", 3), "retry");
    assert.equal(recordSellFailure(db, id, "blockhash expired", 3), "stuck");
    assert.equal(listStuck(db).length, 1);
    assert.equal(listOpen(db, false).length, 0, "a stuck position is no longer actively managed");
  });

  test("dry-run positions are isolated from live ones", () => {
    openPosition(db, { mint: "M1", symbol: "X", entrySol: 1, entryTokens: "1", dryRun: true });
    openPosition(db, { mint: "M2", symbol: "Y", entrySol: 1, entryTokens: "1", dryRun: false });
    assert.equal(listOpen(db, true).length, 1);
    assert.equal(listOpen(db, false).length, 1);
  });
});

// ---------------------------------------------------- ledger dry_run tagging

describe("dev_sell ledger row tracks the position's own dry_run", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  // Regression: a real position opened while `BudgetGuard` was in live mode
  // could later be closed by a process whose config had drifted into pretend
  // mode (dryRun or launch.simulate flipped on, e.g. after a restart). The
  // guard used to tag every record() with its OWN construction-time mode
  // instead of the position's, so a genuine mainnet sell got booked into the
  // simulated ledger and vanished from real P&L / budget accounting. See
  // spend_ledger id=13 in data/bot.db: a real (dry_run=0) BAKD position closed
  // with a dev_sell row wrongly stamped dry_run=1.
  test("a real position's exit is recorded as real, even under a pretend BudgetGuard", () => {
    const id = openPosition(db, {
      mint: "MintReal", symbol: "RRR", entrySol: 0.1, entryTokens: "1000", dryRun: false,
    });
    closePosition(db, id, {
      reason: "take_profit", exitSol: 0.2431, exitTokens: "1000", entrySol: 0.1,
    });
    const pos = db.prepare(`SELECT dry_run FROM positions WHERE id = ?`).get(id) as { dry_run: number };
    assert.equal(pos.dry_run, 0, "the position itself must still read as real");

    // Construct the guard under a config that is currently in pretend mode --
    // simulating a restart between this position's open and its close.
    const pretendCfg = configSchema.parse({ dryRun: true });
    const budget = new BudgetGuard(db, pretendCfg);

    budget.record({
      kind: "dev_sell", solDelta: 0.2431, mint: "MintReal",
      note: "take_profit", dryRun: !!pos.dry_run,
    });

    const ledger = db.prepare(
      `SELECT dry_run FROM spend_ledger WHERE mint = 'MintReal' AND kind = 'dev_sell'`,
    ).get() as { dry_run: number };
    assert.equal(ledger.dry_run, 0, "the sell must land in the REAL ledger, matching the position");
  });

  test("record() still defaults to the guard's own mode when dryRun is omitted", () => {
    const liveCfg = configSchema.parse({ dryRun: false });
    const budget = new BudgetGuard(db, liveCfg);
    budget.record({ kind: "launch", solDelta: -0.02, mint: "MintX" });

    const row = db.prepare(`SELECT dry_run FROM spend_ledger WHERE mint = 'MintX'`).get() as { dry_run: number };
    assert.equal(row.dry_run, 0);
  });
});

// ------------------------------------------------------------ warmup gate

describe("warmup — stops a cold start launching on noise", () => {
  let db: Db;
  const scoring = configSchema.parse({}).scoring;

  beforeEach(() => { db = openMemoryDb(); });

  const sig = (feed: string, term: string, agoMin: number): RawSignal => ({
    feed, term, rawScore: 0.9,
    observedAt: new Date(Date.now() - agoMin * 60_000),
  });

  const weights = new Map([["googleTrends", 1], ["reddit", 1], ["fourchan", 1], ["onchain", 1]]);

  test("an empty database is not warm", () => {
    const w = checkWarmup(db, scoring);
    assert.equal(w.warm, false);
    assert.equal(w.spanMinutes, 0);
  });

  test("a single burst of signals is not warm", () => {
    // Everything observed at once: velocity has no earlier half to compare to.
    ingestSignals(db, [sig("googleTrends", "moo deng", 0), sig("reddit", "moo deng", 0)], weights, scoring);
    assert.equal(checkWarmup(db, scoring).warm, false);
  });

  test("a source reporting ancient timestamps does not fake warmup", () => {
    // Regression: /biz/ sticky threads carry creation times over a year old.
    // Dating history from the source clock made a bot running for two minutes
    // report 484 days of history, silently satisfying the warmup gate that
    // exists to stop cold-start launches. Warmup must use OUR clock.
    const ancient: RawSignal = {
      feed: "fourchan",
      term: "quantum ferret",
      rawScore: 0.9,
      observedAt: new Date(Date.now() - 500 * 24 * 3600_000), // ~16 months old
    };
    ingestSignals(db, [ancient, { ...ancient, feed: "reddit" }], weights, scoring);

    const w = checkWarmup(db, scoring);
    assert.equal(w.warm, false, "an old source timestamp must not satisfy warmup");
    assert.ok(w.spanMinutes < 1, `expected a near-zero span, got ${w.spanMinutes}`);
  });

  test("velocity is measured on our clock, not the source's", () => {
    // All ingested now, but stamped long ago by the source. Velocity should
    // read as brand new (high), not as ancient and decelerating.
    const old = (feed: string): RawSignal => ({
      feed, term: "quantum ferret", rawScore: 0.9,
      observedAt: new Date(Date.now() - 400 * 24 * 3600_000),
    });
    ingestSignals(db, [old("fourchan"), old("reddit"), old("googleTrends")], weights, scoring);

    const c = buildCandidates(db, scoring).find((x) => x.term.includes("quantum"));
    assert.ok(c, "candidate should exist");
    assert.ok(c.components.velocity > 0.9,
      `stale source stamps must not suppress velocity (got ${c.components.velocity})`);
    assert.ok(c.components.decay > 0.99,
      `decay must date from first ingest, not the source stamp (got ${c.components.decay})`);
  });

  test("history spanning the warmup window is warm", () => {
    // Warmup now measures how long WE have been collecting, so it can only be
    // satisfied by backdating ingestion -- backdating the source timestamp is
    // exactly the thing the regression above forbids.
    ingestSignals(db, [sig("googleTrends", "moo deng", 0), sig("reddit", "moo deng", 0)], weights, scoring);
    db.prepare(`UPDATE signals SET ingested_at = ? WHERE feed = 'googleTrends'`)
      .run(Date.now() - 45 * 60_000);

    const w = checkWarmup(db, scoring);
    assert.equal(w.warm, true);
    assert.ok(w.spanMinutes >= 30, `expected >=30min, got ${w.spanMinutes}`);
  });

  test("a term seen once cannot qualify regardless of score", () => {
    ingestSignals(db, [
      sig("googleTrends", "moo deng", 45),
      sig("reddit", "moo deng", 20),
    ], weights, scoring);
    const candidates = buildCandidates(db, scoring);
    const single = candidates.find((c) => c.observations < scoring.minObservations);
    if (single) {
      assert.equal(qualifying([single], scoring).length, 0,
        "minObservations must gate out thinly-observed terms");
    }
  });

  test("a single-source term is admitted but scores zero corroboration", () => {
    // The hard gate is now 1 feed; independence is SCORED rather than gated, so
    // a lone source gets in and then has to be excellent elsewhere to qualify.
    ingestSignals(db, [
      sig("fourchan", "quantum ferret", 60),
      sig("fourchan", "quantum ferret", 30),
      sig("fourchan", "quantum ferret", 0),
    ], weights, scoring);
    const found = buildCandidates(db, scoring).find((c) => c.term.includes("quantum"));
    assert.ok(found, "single-source terms are candidates now");
    assert.equal(found.components.corroboration, 0,
      "one family must score zero corroboration no matter how many hits");
    assert.deepEqual(found.families, ["crypto"]);
  });

  test("two feeds in the SAME family still score near zero", () => {
    // /biz/ and on-chain are the same population reacting to each other.
    ingestSignals(db, [
      sig("fourchan", "quantum ferret", 60),
      sig("onchain", "quantum ferret", 30),
    ], weights, scoring);
    const c = buildCandidates(db, scoring).find((x) => x.term.includes("quantum"));
    assert.ok(c);
    assert.ok(c.components.corroboration <= 0.05,
      `same-family agreement must stay weak, got ${c.components.corroboration}`);
  });

  test("two feeds in DIFFERENT families score real corroboration", () => {
    ingestSignals(db, [
      sig("fourchan", "quantum ferret", 60),
      sig("googleTrends", "quantum ferret", 30),
    ], weights, scoring);
    const c = buildCandidates(db, scoring).find((x) => x.term.includes("quantum"));
    assert.ok(c);
    assert.ok(c.components.corroboration >= 0.5,
      `cross-family agreement must score well, got ${c.components.corroboration}`);
  });
});

// ------------------------------------------- signal ingestion dedupe

describe("ingestSignals — stale re-polled content does not fake fresh activity", () => {
  let db: Db;
  const scoring = configSchema.parse({}).scoring;

  beforeEach(() => { db = openMemoryDb(); });

  const weights = new Map([["googleTrends", 1], ["reddit", 1], ["fourchan", 1], ["onchain", 1]]);

  const raw = (feed: string, term: string): RawSignal => ({
    feed, term, rawScore: 0.9, observedAt: new Date(),
  });

  test("byte-identical content re-polled from the same feed collapses to one observation", () => {
    // Regression: a static/stickied 4chan thread has identical subject/body
    // text across every 120s poll -- only its reply count changes, which is
    // folded into raw_score, not the text. Before this dedupe check, each
    // poll added a fresh row, so `observations` and `velocityOf`'s recent-half
    // sum grew purely from re-polling, letting a stale term keep re-qualifying
    // as a candidate tick after tick.
    ingestSignals(db, [raw("fourchan", "eternal sticky thread")], weights, scoring);
    ingestSignals(db, [raw("fourchan", "eternal sticky thread")], weights, scoring);
    ingestSignals(db, [raw("fourchan", "eternal sticky thread")], weights, scoring);

    const c = buildCandidates(db, scoring).find((x) => x.term.includes("eternal"));
    assert.ok(c, "candidate should exist");
    assert.equal(c.observations, 1,
      `repeated identical content must collapse to one observation, got ${c.observations}`);
  });

  test("genuinely distinct content from the same feed still counts separately", () => {
    ingestSignals(db, [raw("fourchan", "quantum ferret alpha")], weights, scoring);
    ingestSignals(db, [raw("fourchan", "quantum ferret beta")], weights, scoring);

    const alpha = buildCandidates(db, scoring).find((x) => x.term.includes("alpha"));
    const beta = buildCandidates(db, scoring).find((x) => x.term.includes("beta"));
    assert.ok(alpha, "alpha candidate should exist");
    assert.ok(beta, "beta candidate should exist");
    assert.equal(alpha.observations, 1);
    assert.equal(beta.observations, 1);
  });

  test("identical text from a DIFFERENT feed still counts as a separate observation", () => {
    // Dedupe keys on (feed, source_text), not source_text alone -- two
    // different feeds independently reporting the same term is exactly the
    // cross-feed corroboration the scorer is designed to reward.
    ingestSignals(db, [raw("fourchan", "quantum ferret")], weights, scoring);
    ingestSignals(db, [raw("googleTrends", "quantum ferret")], weights, scoring);

    const c = buildCandidates(db, scoring).find((x) => x.term.includes("quantum"));
    assert.ok(c);
    assert.equal(c.observations, 2,
      "the same text from two different feeds must both count");
  });
});

// --------------------------------------------------- phrases and affinity

describe("phrase extraction — makes cross-feed corroboration possible", () => {
  test("short terms pass through whole", () => {
    const p = extractPhrases("moo deng");
    assert.equal(p.length, 1);
    assert.equal(p[0]?.salience, 1);
  });

  test("a headline and a bare term collapse to the same key", () => {
    // This is the mechanism corroboration depends on.
    const fromGoogle = extractPhrases("moo deng");
    const fromReddit = extractPhrases("Everyone is obsessed with Moo Deng the baby hippo right now");
    const keys = new Set(fromReddit.map((p) => p.key));
    assert.ok(fromGoogle[0] && keys.has(fromGoogle[0].key),
      `expected "${fromGoogle[0]?.key}" among [${[...keys].join(" | ")}]`);
  });

  test("cashtags are extracted as high-salience subjects", () => {
    const p = extractPhrases("anyone else buying $WIF here or is it over for us bros");
    assert.ok(p.some((x) => x.text.toUpperCase() === "WIF" && x.salience === 1));
  });

  test("empty and junk input yields nothing rather than throwing", () => {
    assert.equal(extractPhrases("").length, 0);
    assert.equal(extractPhrases("   ").length, 0);
  });

  // A real mainnet launch once minted "you girl" (YOUGIRL) -- both words are
  // individually listed in NEVER_ALONE as unable to stand alone, but the
  // all-filler check only ran for single-token phrases, so the pair sailed
  // through. These pin the fix: a phrase built entirely out of NEVER_ALONE
  // words is rejected regardless of how many of them there are.
  test("a phrase built entirely of filler/pronoun words is rejected, not just a lone one", () => {
    assert.equal(extractPhrases("you girl").length, 0);
  });

  test("the bigram-fallback path also rejects an all-filler pair, not just the whole-text path", () => {
    // Five words, all pronouns/determiners in NEVER_ALONE, all lowercase (so
    // PROPER_RUN never matches) -- every bigram AND the final 3-word fallback
    // the bigram-of-last-resort logic tries are pure filler.
    assert.equal(extractPhrases("you your her their its").length, 0);
  });

  test("a genuine two-word subject is unaffected by the filler check", () => {
    const p = extractPhrases("Crypto Market");
    assert.equal(p.length, 1);
    assert.equal(p[0]?.text, "Crypto Market");
  });

  test("a phrase with only ONE filler word among several still passes (needs one real subject, not zero filler)", () => {
    // "dgaf" and "anymore" are not filler, so this stays a valid whole-text
    // term -- confirms the fix doesn't over-reject a term already live.
    const p = extractPhrases("i dgaf anymore");
    assert.equal(p.length, 1);
    assert.equal(p[0]?.text, "i dgaf anymore");
  });
});

describe("affinity — separates trends with buyers from trends without", () => {
  test("crypto-native feeds carry a higher prior", () => {
    assert.ok(cryptoAffinity("some thing", ["fourchan"]) > cryptoAffinity("some thing", ["googleTrends"]));
  });

  test("institutional vocabulary is penalised", () => {
    const dry = cryptoAffinity("quarterly earnings forecast", ["googleTrends"]);
    const memey = cryptoAffinity("capybara meme", ["googleTrends"]);
    assert.ok(memey > dry, `expected meme (${memey}) to beat dry news (${dry})`);
  });

  test("tickerability favours short punchy terms", () => {
    assert.ok(tickerability("labubu") > tickerability("the great international banana shortage of 2026"));
  });

  // Each of these launched for real on mainnet and never traded past its own
  // dev buy. They read as news to a feed but carry nothing anyone would buy a
  // token for, which is exactly what the DRY penalty exists to catch.
  test("vocabulary from real zero-traction duds is penalised", () => {
    const memey = cryptoAffinity("capybara meme", ["googleNews"]);
    for (const dud of ["momentum", "cancer drug", "maryland", "spread"]) {
      const score = cryptoAffinity(dud, ["googleNews"]);
      assert.ok(score < memey, `expected "${dud}" (${score}) to score below a memeable term (${memey})`);
    }
  });
});
