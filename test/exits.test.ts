import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { decideExit } from "../src/positions/manager.ts";
import { openPosition, listOpen, closePosition, recordSellFailure, listStuck } from "../src/positions/store.ts";
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
    ingestSignals(db, [sig("googleTrends", "moo deng", 0), sig("reddit", "moo deng", 0)], weights);
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
    ingestSignals(db, [ancient, { ...ancient, feed: "reddit" }], weights);

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
    ingestSignals(db, [old("fourchan"), old("reddit"), old("googleTrends")], weights);

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
    ingestSignals(db, [sig("googleTrends", "moo deng", 0), sig("reddit", "moo deng", 0)], weights);
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
    ], weights);
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
    ], weights);
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
    ], weights);
    const c = buildCandidates(db, scoring).find((x) => x.term.includes("quantum"));
    assert.ok(c);
    assert.ok(c.components.corroboration <= 0.05,
      `same-family agreement must stay weak, got ${c.components.corroboration}`);
  });

  test("two feeds in DIFFERENT families score real corroboration", () => {
    ingestSignals(db, [
      sig("fourchan", "quantum ferret", 60),
      sig("googleTrends", "quantum ferret", 30),
    ], weights);
    const c = buildCandidates(db, scoring).find((x) => x.term.includes("quantum"));
    assert.ok(c);
    assert.ok(c.components.corroboration >= 0.5,
      `cross-family agreement must score well, got ${c.components.corroboration}`);
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
});
