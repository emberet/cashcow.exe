import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  classifyLaunch, washSuspicionScore, percentileRank, DEFAULT_THRESHOLDS,
} from "../src/research/classify.ts";
import { computeConcentration } from "../src/chain/holders.ts";
import { resolveMainnetRpc, BACKTEST_RPC_ENV } from "../src/research/backtest.ts";
import { redactEndpoint } from "../src/chain/rpc.ts";
import { configSchema } from "../src/config/schema.ts";

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

// ==================================================================
// RPC resolution for the backtest's holder reads.
//
// A dedicated RPC URL carries its API key inline (query string for Helius,
// path for QuickNode/Alchemy), so two things matter: the right endpoint wins,
// and the key never reaches a log line.
// ==================================================================

describe("resolveMainnetRpc", () => {
  const PUBLIC = "https://api.mainnet-beta.solana.com";
  const base = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: true, ...over });

  let saved: string | undefined;
  beforeEach(() => { saved = process.env[BACKTEST_RPC_ENV]; delete process.env[BACKTEST_RPC_ENV]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[BACKTEST_RPC_ENV];
    else process.env[BACKTEST_RPC_ENV] = saved;
  });

  test("an explicit --rpc override wins over everything", () => {
    process.env[BACKTEST_RPC_ENV] = "https://from-env.example/?api-key=env";
    const r = resolveMainnetRpc(base(), "https://from-flag.example/?api-key=flag");
    assert.equal(r.url, "https://from-flag.example/?api-key=flag");
    assert.equal(r.dedicated, true);
  });

  test("SOLANA_RPC_URL is used when no flag is given", () => {
    process.env[BACKTEST_RPC_ENV] = "https://from-env.example/?api-key=env";
    const r = resolveMainnetRpc(base());
    assert.equal(r.url, "https://from-env.example/?api-key=env");
    assert.equal(r.dedicated, true);
  });

  test("a blank or whitespace env var does not count as configured", () => {
    process.env[BACKTEST_RPC_ENV] = "   ";
    const r = resolveMainnetRpc(base());
    assert.equal(r.url, PUBLIC);
    assert.equal(r.dedicated, false);
  });

  test("a devnet config never leaks into mainnet holder reads", () => {
    // The bot's own rpc.primary is devnet; these mints are mainnet, so using
    // it would fail every lookup. Must fall back to the public MAINNET url.
    const cfg = base({ network: "devnet", rpc: { primary: "https://api.devnet.solana.com" } });
    const r = resolveMainnetRpc(cfg);
    assert.equal(r.url, PUBLIC);
    assert.equal(r.dedicated, false);
  });

  test("cfg.rpc.primary is used only when the bot is already on mainnet", () => {
    const cfg = base({ network: "mainnet-beta", rpc: { primary: "https://paid.example/?api-key=k" } });
    const r = resolveMainnetRpc(cfg);
    assert.equal(r.url, "https://paid.example/?api-key=k");
    assert.equal(r.dedicated, true);
  });

  test("mainnet config still pointed at the public endpoint is not 'dedicated'", () => {
    const cfg = base({ network: "mainnet-beta", rpc: { primary: PUBLIC } });
    const r = resolveMainnetRpc(cfg);
    assert.equal(r.dedicated, false);
  });

  test("redaction strips the API key from every provider URL shape", () => {
    const cases = [
      ["https://mainnet.helius-rpc.com/?api-key=SECRET123", "SECRET123"],          // Helius: query
      ["https://x.solana-mainnet.quiknode.pro/SECRET123/", "SECRET123"],           // QuickNode: path
      ["https://solana-mainnet.g.alchemy.com/v2/SECRET123", "SECRET123"],          // Alchemy: path
    ] as const;
    for (const [url, secret] of cases) {
      const red = redactEndpoint(url);
      assert.ok(!red.includes(secret), `redactEndpoint leaked the key for ${url}: got "${red}"`);
    }
  });
});
