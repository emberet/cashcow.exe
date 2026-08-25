import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  classifyLaunch, washSuspicionScore, percentileRank, DEFAULT_THRESHOLDS,
} from "../src/research/classify.ts";
import { computeConcentration } from "../src/chain/holders.ts";

// ==================================================================
// Pure math only -- no network. classify.ts and holders.ts's math are what
// the historical-launch backtest's whole judgment rests on, so it is worth
// testing on its own even though the script that calls it is not.
// ==================================================================

describe("classifyLaunch", () => {
  test("a clean profile passes with no reasons", () => {
    const r = classifyLaunch({
      isBanned: false, athMarketCapUsd: 750_000, top10ConcentrationPct: 30,
      txCount24h: 100, replyCount: 200, washSuspicionPercentile: 0.2,
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, true);
    assert.deepEqual(r.reasons, []);
  });

  test("banned tokens are never clean", () => {
    const r = classifyLaunch({
      isBanned: true, athMarketCapUsd: 1_000_000, top10ConcentrationPct: 10,
      txCount24h: 10, replyCount: 200, washSuspicionPercentile: 0.1,
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /banned/.test(x)));
  });

  test("below the activity floor is rejected", () => {
    const r = classifyLaunch({
      isBanned: false, athMarketCapUsd: 10_000, top10ConcentrationPct: 10,
      txCount24h: 10, replyCount: 200, washSuspicionPercentile: 0.1,
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /ATH market cap/.test(x)));
  });

  test("high concentration is rejected", () => {
    const r = classifyLaunch({
      isBanned: false, athMarketCapUsd: 1_000_000, top10ConcentrationPct: 95,
      txCount24h: 10, replyCount: 200, washSuspicionPercentile: 0.1,
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /concentration/.test(x)));
  });

  test("extreme tx-count-vs-replies is rejected outright, independent of percentile", () => {
    const r = classifyLaunch({
      isBanned: false, athMarketCapUsd: 1_000_000, top10ConcentrationPct: 10,
      txCount24h: 600, replyCount: 5, washSuspicionPercentile: 0, // even a LOW percentile
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /wash-trading-shaped/.test(x)));
  });

  test("top-quartile wash-suspicion percentile is rejected even without the absolute extreme", () => {
    const r = classifyLaunch({
      isBanned: false, athMarketCapUsd: 1_000_000, top10ConcentrationPct: 10,
      txCount24h: 50, replyCount: 100, washSuspicionPercentile: 0.9,
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /percentile/.test(x)));
  });

  test("multiple failures are all reported, not just the first", () => {
    const r = classifyLaunch({
      isBanned: true, athMarketCapUsd: 1_000, top10ConcentrationPct: 99,
      txCount24h: 900, replyCount: 1, washSuspicionPercentile: 0.99,
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.length >= 4);
  });

  // Verified live: getTokenLargestAccounts fails close to 100% of the time
  // against the free public mainnet RPC, not occasionally. Treating "unknown"
  // the same as "100% concentrated" would silently reject an entire sample
  // run on the default config, which defeats the point of a research tool
  // meant to be read by a human -- so unknown must not disqualify.
  test("unknown concentration (null, RPC failed) does not disqualify an otherwise-clean profile", () => {
    const r = classifyLaunch({
      isBanned: false, athMarketCapUsd: 750_000, top10ConcentrationPct: null,
      txCount24h: 100, replyCount: 200, washSuspicionPercentile: 0.2,
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, true);
    assert.deepEqual(r.reasons, []);
  });

  test("unknown concentration is still surfaced as a caveat for the human to check", () => {
    const r = classifyLaunch({
      isBanned: false, athMarketCapUsd: 750_000, top10ConcentrationPct: null,
      txCount24h: 100, replyCount: 200, washSuspicionPercentile: 0.2,
    }, DEFAULT_THRESHOLDS);
    assert.ok(r.caveats.some((c) => /concentration unknown/.test(c)));
  });

  test("a clean profile with known concentration has no caveats", () => {
    const r = classifyLaunch({
      isBanned: false, athMarketCapUsd: 750_000, top10ConcentrationPct: 10,
      txCount24h: 100, replyCount: 200, washSuspicionPercentile: 0.2,
    }, DEFAULT_THRESHOLDS);
    assert.deepEqual(r.caveats, []);
  });

  test("unknown concentration does not mask OTHER real rejections", () => {
    const r = classifyLaunch({
      isBanned: true, athMarketCapUsd: 750_000, top10ConcentrationPct: null,
      txCount24h: 100, replyCount: 200, washSuspicionPercentile: 0.2,
    }, DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /banned/.test(x)));
  });
});

describe("washSuspicionScore / percentileRank", () => {
  test("more txns per reply is a higher score", () => {
    assert.ok(washSuspicionScore(100, 10) > washSuspicionScore(100, 100));
  });

  test("zero replies does not divide by zero", () => {
    assert.equal(washSuspicionScore(50, 0), 50);
  });

  test("percentileRank against an empty sample is zero, not NaN", () => {
    assert.equal(percentileRank(5, []), 0);
  });

  test("percentileRank reflects true rank within the sample", () => {
    const sample = [1, 2, 3, 4, 5];
    assert.equal(percentileRank(1, sample), 0); // nothing below the minimum
    assert.equal(percentileRank(5, sample), 0.8); // 4 of 5 are below
  });
});

describe("computeConcentration", () => {
  test("excludes the bonding-curve account from both numerator and denominator", () => {
    const largest = [
      { address: "curve", uiAmount: 700 },
      { address: "holderA", uiAmount: 100 },
      { address: "holderB", uiAmount: 50 },
    ];
    const c = computeConcentration(largest, 1000, ["curve"]);
    // circulating = 1000 - 700 = 300; top10 among non-excluded = 150
    assert.ok(Math.abs(c.top10ConcentrationPct - 50) < 1e-9, `got ${c.top10ConcentrationPct}`);
    assert.equal(c.excludedBalance, 700);
    assert.equal(c.accountsConsidered, 2);
  });

  test("only the top 10 non-excluded accounts count, even if more are given", () => {
    const largest = Array.from({ length: 15 }, (_, i) => ({ address: `h${i}`, uiAmount: 10 }));
    const c = computeConcentration(largest, 1000, []);
    // top 10 of 15 accounts at 10 each = 100; circulating = 1000
    assert.ok(Math.abs(c.top10ConcentrationPct - 10) < 1e-9, `got ${c.top10ConcentrationPct}`);
    assert.equal(c.accountsConsidered, 15);
  });

  test("zero circulating supply does not divide by zero", () => {
    const c = computeConcentration([{ address: "curve", uiAmount: 1000 }], 1000, ["curve"]);
    assert.equal(c.top10ConcentrationPct, 0);
  });

  test("no exclusions still produces a sane percentage", () => {
    const c = computeConcentration([{ address: "a", uiAmount: 1000 }], 1000, []);
    assert.equal(c.top10ConcentrationPct, 100);
  });
});
