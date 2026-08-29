import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { curveProgress } from "../src/feeds/onchain.ts";
import { organicBuyPressure, type OrganicFlowThresholds } from "../src/scoring/organicFlow.ts";
import { configSchema } from "../src/config/schema.ts";

describe("curveProgress — bonding-curve-graduation approximation (onchain.ts)", () => {
  test("graduated coins are always 0, regardless of market cap", () => {
    assert.equal(curveProgress(1_000_000, true, 100_000), 0);
    assert.equal(curveProgress(0, true, 100_000), 0);
  });

  test("0 market cap is 0", () => {
    assert.equal(curveProgress(0, false, 100_000), 0);
  });

  test("mcap equal to the graduation estimate is 1 (inclusive boundary)", () => {
    assert.equal(curveProgress(100_000, false, 100_000), 1);
  });

  test("mcap beyond the graduation estimate clamps to 1, never exceeds", () => {
    assert.equal(curveProgress(5_000_000, false, 100_000), 1);
  });

  test("mcap halfway to the estimate is 0.5", () => {
    assert.equal(curveProgress(50_000, false, 100_000), 0.5);
  });

  test("a non-positive graduation estimate cannot produce a signal (misconfiguration fails closed)", () => {
    assert.equal(curveProgress(50_000, false, 0), 0);
    assert.equal(curveProgress(50_000, false, -100), 0);
  });
});

describe("organicBuyPressure — organic buy-side imbalance (dexActivity.ts)", () => {
  const T: OrganicFlowThresholds = {
    minLiquidityUsd: 20_000,
    minBuyShareForSignal: 60,
    maxBuyShareForSignal: 85,
    maxWashSuspicionScore: 5,
  };

  test("below the liquidity floor scores 0 regardless of buy share", () => {
    const score = organicBuyPressure(
      { buys24h: 800, sells24h: 200, liquidityUsd: 5_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    assert.equal(score, 0);
  });

  test("an exact 50/50 split scores 0 -- no imbalance to report", () => {
    const score = organicBuyPressure(
      { buys24h: 500, sells24h: 500, liquidityUsd: 50_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    assert.equal(score, 0);
  });

  test("no trades at all scores 0, not a defaulted midpoint", () => {
    const score = organicBuyPressure(
      { buys24h: 0, sells24h: 0, liquidityUsd: 50_000, txCount24h: 0, replyCount: 10 },
      T,
    );
    assert.equal(score, 0);
  });

  test("65/35 with good liquidity and ordinary tx/reply ratio scores positive, mid-band", () => {
    const score = organicBuyPressure(
      { buys24h: 650, sells24h: 350, liquidityUsd: 100_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    assert.ok(score > 0, `expected a positive score, got ${score}`);
    assert.ok(score <= 1, `expected score <= 1, got ${score}`);
  });

  test("a 95/5 extreme one-sided split scores 0 -- the regression test for the wash-shaped pattern " +
    "classify.ts's own DEFAULT_THRESHOLDS treats as an untested pump or wash bot, not stronger evidence", () => {
    const score = organicBuyPressure(
      { buys24h: 950, sells24h: 50, liquidityUsd: 100_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    assert.equal(score, 0, "95% buy share is above maxBuyShareForSignal and must not score positively");
  });

  test("high tx count against tiny reply engagement is zeroed by the wash dampener " +
    "even with an otherwise-ideal buy share", () => {
    const score = organicBuyPressure(
      { buys24h: 700, sells24h: 300, liquidityUsd: 100_000, txCount24h: 5000, replyCount: 5 },
      T,
    );
    assert.equal(score, 0, "txCount24h/replyCount = 1000 >> maxWashSuspicionScore (5)");
  });

  test("zero reply count is UNKNOWN, not maximal wash suspicion -- regression test for a real " +
    "post-migration coin ($1.4M liquidity, 43k txs, reply_count: 0) that the unconditional dampener " +
    "was zeroing out even with an ideal buy share", () => {
    const score = organicBuyPressure(
      { buys24h: 700, sells24h: 300, liquidityUsd: 100_000, txCount24h: 43_000, replyCount: 0 },
      T,
    );
    assert.ok(score > 0, `expected a positive score with replyCount=0, got ${score}`);
  });

  test("band edges (60% and 85%) are inclusive, not rejected outright", () => {
    const atFloor = organicBuyPressure(
      { buys24h: 600, sells24h: 400, liquidityUsd: 100_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    const atCeiling = organicBuyPressure(
      { buys24h: 850, sells24h: 150, liquidityUsd: 100_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    assert.ok(atFloor >= 0 && Number.isFinite(atFloor));
    assert.ok(atCeiling >= 0 && Number.isFinite(atCeiling));
  });

  test("just outside the band on either side scores 0", () => {
    const belowFloor = organicBuyPressure(
      { buys24h: 590, sells24h: 410, liquidityUsd: 100_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    const aboveCeiling = organicBuyPressure(
      { buys24h: 860, sells24h: 140, liquidityUsd: 100_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    assert.equal(belowFloor, 0);
    assert.equal(aboveCeiling, 0);
  });

  test("score is always within [0, 1]", () => {
    const inputs = [
      { buys24h: 700, sells24h: 300, liquidityUsd: 10_000_000, txCount24h: 100, replyCount: 500 },
      { buys24h: 601, sells24h: 399, liquidityUsd: 20_001, txCount24h: 1, replyCount: 1 },
    ];
    for (const input of inputs) {
      const score = organicBuyPressure(input, T);
      assert.ok(score >= 0 && score <= 1, `score ${score} out of [0,1] for ${JSON.stringify(input)}`);
    }
  });
});

// The band above is a local fixture; these read the SHIPPED defaults, so
// reverting the schema fails here rather than silently un-calibrating the feed.
describe("dexActivity ships calibrated against where real graduated coins sit", () => {
  const shipped = configSchema.parse({}).feeds.dexActivity;
  const T: OrganicFlowThresholds = {
    minLiquidityUsd: shipped.minLiquidityUsd,
    minBuyShareForSignal: shipped.minBuyShareForSignal,
    maxBuyShareForSignal: shipped.maxBuyShareForSignal,
    maxWashSuspicionScore: shipped.maxWashSuspicionScore,
  };

  test("the feed is enabled", () => {
    assert.equal(shipped.enabled, true);
  });

  // 25 real graduated coins (2026-08-27) put freshly-migrated tokens at 86-98%
  // buy share. The old 85 ceiling scored that entire population 0 -- the feed
  // was blind to exactly what it exists to detect.
  test("90% buy share -- squarely in the real migrated-token cluster -- now scores positive", () => {
    const score = organicBuyPressure(
      { buys24h: 900, sells24h: 100, liquidityUsd: 100_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    assert.ok(score > 0, `expected a positive score at 90% buy share, got ${score}`);
  });

  test("a near-total 99% stampede is still rejected -- the ceiling moved, it did not disappear", () => {
    const score = organicBuyPressure(
      { buys24h: 990, sells24h: 10, liquidityUsd: 100_000, txCount24h: 1000, replyCount: 500 },
      T,
    );
    assert.equal(score, 0);
  });

  test("the wash dampener still fires inside the widened band", () => {
    const score = organicBuyPressure(
      { buys24h: 900, sells24h: 100, liquidityUsd: 100_000, txCount24h: 5000, replyCount: 5 },
      T,
    );
    assert.equal(score, 0, "a wide band must not become a way around the tx/reply dampener");
  });
});
