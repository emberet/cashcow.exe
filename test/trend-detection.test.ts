import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { openMemoryDb, type Db } from "../src/util/db.ts";
import { configSchema } from "../src/config/schema.ts";
import { buildCandidates } from "../src/scoring/score.ts";
import {
  reliabilityFromCounts, reliabilityMultiplier, computeFeedReliability,
} from "../src/learning/feedReliability.ts";
import { checkAll, compileFilters, looksLikePersonName } from "../src/scoring/filters.ts";
import { FEED_FAMILY } from "../src/scoring/independence.ts";
import { watchlistFeed } from "../src/feeds/watchlist.ts";
import { BudgetGuard } from "../src/risk/budget.ts";

// ==================================================================
// Day-2 trend work: acceleration (the second derivative), the
// feed-reliability prior (9-of-9 fourchan duds), and the watchlist feed's
// guardrails. The evidence behind each is in DECISIONS #44.
// ==================================================================

let db: Db;
beforeEach(() => { db = openMemoryDb(); });

const scoringCfg = (over: Record<string, unknown> = {}) =>
  configSchema.parse({
    scoring: {
      minObservations: 1, minCorroboratingFeeds: 1, minIndependentFamilies: 1,
      weights: { velocity: 0.2, acceleration: 0.3, corroboration: 0.2,
                 cryptoAffinity: 0.1, tickerability: 0.1, reach: 0.1 },
      ...over,
    },
  }).scoring;

function insertSignal(a: { term: string; feed?: string; minutesAgo: number; score?: number }) {
  const t = Date.now() - a.minutesAgo * 60_000;
  db.prepare(
    `INSERT INTO signals (feed, term, norm, raw_score, observed_at, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(a.feed ?? "googleNews", a.term, a.term.toLowerCase(), a.score ?? 0.5, t, t);
}

describe("acceleration component", () => {
  test("a term whose rate doubles in the last half hour outruns a steady one", () => {
    // steady: one signal every ~20min across 3h
    for (let m = 170; m >= 10; m -= 20) insertSignal({ term: "steady eddy", minutesAgo: m });
    // popping: same total history, but five extra sightings inside 25 min
    for (let m = 170; m >= 40; m -= 20) insertSignal({ term: "pop rocket", minutesAgo: m });
    for (let m = 25; m >= 5; m -= 5) insertSignal({ term: "pop rocket", minutesAgo: m });

    const byTerm = Object.fromEntries(buildCandidates(db, scoringCfg()).map((c) => [c.term, c]));
    const steady = byTerm["steady eddy"]!, pop = byTerm["pop rocket"]!;
    assert.ok(pop.components.acceleration > steady.components.acceleration + 0.15,
      `pop ${pop.components.acceleration.toFixed(2)} should clearly beat steady ${steady.components.acceleration.toFixed(2)}`);
  });

  test("a term that died off scores near zero acceleration", () => {
    for (let m = 170; m >= 100; m -= 10) insertSignal({ term: "old news", minutesAgo: m });
    const c = buildCandidates(db, scoringCfg())[0]!;
    assert.ok(c.components.acceleration < 0.1, `died-off term scored ${c.components.acceleration}`);
  });

  test("weight 0 keeps the component visible but uninfluential", () => {
    for (let m = 25; m >= 5; m -= 5) insertSignal({ term: "burst", minutesAgo: m });
    const zero = buildCandidates(db, scoringCfg({
      weights: { velocity: 0.35, acceleration: 0, corroboration: 0.25,
                 cryptoAffinity: 0.2, tickerability: 0.1, reach: 0.1 } }))[0]!;
    assert.ok(zero.components.acceleration > 0.9, "component still computed");
  });
});

describe("feed-reliability prior", () => {
  test("a long unbroken dud streak dampens, bounded at 0.7", () => {
    const p1 = reliabilityFromCounts([["crypto", { settled: 9, nonDud: 0 }]]);
    assert.equal(p1.crypto, 0.85);
    const p2 = reliabilityFromCounts([["crypto", { settled: 12, nonDud: 0 }]]);
    assert.equal(p2.crypto, 0.7, "never below 0.7 -- a feed can redeem itself");
  });

  test("one success resets a family to neutral instantly", () => {
    const p = reliabilityFromCounts([["crypto", { settled: 20, nonDud: 1 }]]);
    assert.equal(p.crypto, undefined);
  });

  test("thin evidence is neutral -- no dampening below 8 settled", () => {
    const p = reliabilityFromCounts([["press", { settled: 7, nonDud: 0 }]]);
    assert.equal(p.press, undefined);
  });

  test("nothing is ever boosted above 1", () => {
    const p = reliabilityFromCounts([["press", { settled: 10, nonDud: 9 }]]);
    assert.equal(reliabilityMultiplier(p, ["press"]), 1);
  });

  test("one healthy family rescues a candidate from a dampened one", () => {
    const p = reliabilityFromCounts([["crypto", { settled: 12, nonDud: 0 }]]);
    assert.equal(reliabilityMultiplier(p, ["crypto"]), 0.7);
    assert.equal(reliabilityMultiplier(p, ["crypto", "press"]), 1,
      "only 'every source is known-bad' is punished");
  });

  test("computeFeedReliability reproduces the live fourchan finding", () => {
    // Nine settled fourchan launches, all duds -- the real day-1 record.
    for (let i = 0; i < 9; i++) {
      db.prepare(
        `INSERT INTO launch_outcomes (mint, launched_at, term, symbol, feeds, verdict, settled_at, dry_run)
         VALUES (?, ?, ?, ?, ?, 'dud', ?, 0)`,
      ).run(`mint${i}`, Date.now(), `t${i}`, `S${i}`, JSON.stringify(["fourchan"]), Date.now());
    }
    const prior = computeFeedReliability(db);
    assert.equal(prior.crypto, 0.85, "9 settled duds -> first dampening tier");
  });
});

describe("watchlist guardrails", () => {
  test("is in the social family -- a tweet corroborated by a tweet is one crowd", () => {
    assert.equal(FEED_FAMILY.watchlist, "social");
    assert.equal(FEED_FAMILY.xApi, "social");
  });

  test("not ready without a bearer token or without handles", () => {
    delete process.env.X_BEARER_TOKEN;
    const cfg = configSchema.parse({ feeds: { watchlist: { enabled: true, handles: ["elonmusk"] } } });
    const budget = new BudgetGuard(db, cfg);
    const r1 = watchlistFeed.readiness({ cfg, budget, db });
    assert.equal(r1.ready, false);

    process.env.X_BEARER_TOKEN = "test-token";
    const cfg2 = configSchema.parse({ feeds: { watchlist: { enabled: true } } });
    const r2 = watchlistFeed.readiness({ cfg: cfg2, budget: new BudgetGuard(db, cfg2), db });
    assert.equal(r2.ready, false);
    assert.ok(!r2.ready && r2.reason.includes("handles"));
    delete process.env.X_BEARER_TOKEN;
  });

  test("respects the shared read cap in readiness", () => {
    process.env.X_BEARER_TOKEN = "test-token";
    const cfg = configSchema.parse({
      feeds: { watchlist: { enabled: true, handles: ["elonmusk"] }, xApi: { monthlyUsdCap: 1 } },
    });
    const budget = new BudgetGuard(db, cfg);
    budget.meterCharge("x-api-usd", 1, 1); // cap consumed by the OTHER spender
    const r = watchlistFeed.readiness({ cfg, budget, db });
    assert.equal(r.ready, false, "one read budget, two spenders -- both must stop together");
    delete process.env.X_BEARER_TOKEN;
  });

  test("the likeness screen still rejects the person even when the phrase is theirs", () => {
    // The operator's recorded decision: phrases travel, names do not.
    const f = compileFilters(configSchema.parse({}).filters);
    assert.equal(looksLikePersonName("Elon Musk"), true);
    const res = checkAll(["Elon Musk"], f);
    assert.equal(res.allowed, false, "a watchlist source must never launch the person");
    // ...while a non-name phrase from the same tweet is allowed through the
    // person screen ("Now You"-class fragments were fixed in DECISIONS #40).
    assert.equal(looksLikePersonName("legalize comedy"), false,
      "lowercase phrase text is never a person");
    assert.equal(checkAll(["dogecoin to the moon"], f).allowed, true,
      "an ordinary meme phrase must survive the full filter set");
  });
});
