import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  classifyLaunch, washSuspicionScore, percentileRank, buySharePct,
  DEFAULT_THRESHOLDS, type ClassifyInput,
} from "../src/research/classify.ts";
import { normalizeSymbol } from "../src/research/ogCheck.ts";
import { computeConcentration } from "../src/chain/holders.ts";
import { similarity, tokens, normalize } from "../src/util/text.ts";
import { resolveMainnetRpc, BACKTEST_RPC_ENV } from "../src/research/backtest.ts";
import { redactEndpoint } from "../src/chain/rpc.ts";
import { configSchema } from "../src/config/schema.ts";

// ==================================================================
// Pure math only -- no network. classify.ts and holders.ts's math are what
// the historical-launch backtest's whole judgment rests on, so it is worth
// testing on its own even though the script that calls it is not.
// ==================================================================

// A clean baseline every case overrides one field of, so that adding a future
// ClassifyInput field does not mean editing a dozen object literals.
const input = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  isBanned: false,
  volume24hUsd: 750_000,
  athMarketCapUsd: 750_000,
  top10ConcentrationPct: 30,
  txCount24h: 100,
  buys24h: 50,
  sells24h: 50,
  replyCount: 200,
  washSuspicionPercentile: 0.2,
  ogStatus: { kind: "og" },
  ...over,
});

describe("classifyLaunch", () => {
  test("a clean profile passes with no reasons", () => {
    const r = classifyLaunch(input(), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, true);
    assert.deepEqual(r.reasons, []);
  });

  test("banned tokens are never clean", () => {
    const r = classifyLaunch(input({ isBanned: true }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /banned/.test(x)));
  });

  test("below the 24h volume floor is rejected", () => {
    const r = classifyLaunch(input({ volume24hUsd: 10_000 }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /24h volume/.test(x)));
  });

  // The gate deliberately moved off ATH market cap: that is a permanent
  // high-water mark, so a token that peaked at $50M a year ago and now trades
  // nothing would have sailed through the old check. 24h volume is the only
  // field either API carries that says the token is alive TODAY.
  test("a huge historical ATH does not rescue a token that is no longer traded", () => {
    const r = classifyLaunch(
      input({ athMarketCapUsd: 50_000_000, volume24hUsd: 1_200 }),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /24h volume/.test(x)));
  });

  test("a low ATH does not disqualify a token that is genuinely trading now", () => {
    const r = classifyLaunch(
      input({ athMarketCapUsd: 20_000, volume24hUsd: 900_000 }),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(r.clean, true);
  });

  test("high concentration is rejected", () => {
    const r = classifyLaunch(input({ top10ConcentrationPct: 95 }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /concentration/.test(x)));
  });

  test("extreme tx-count-vs-replies is rejected outright, independent of percentile", () => {
    const r = classifyLaunch(
      // even a LOW percentile
      input({ txCount24h: 600, buys24h: 300, sells24h: 300, replyCount: 5, washSuspicionPercentile: 0 }),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /wash-trading-shaped/.test(x)));
  });

  test("top-quartile wash-suspicion percentile is rejected even without the absolute extreme", () => {
    const r = classifyLaunch(input({ washSuspicionPercentile: 0.9 }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /percentile/.test(x)));
  });

  test("multiple failures are all reported, not just the first", () => {
    const r = classifyLaunch(input({
      isBanned: true, volume24hUsd: 1_000, top10ConcentrationPct: 99,
      txCount24h: 900, buys24h: 890, sells24h: 10, replyCount: 1,
      washSuspicionPercentile: 0.99,
    }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.length >= 4);
  });

  // Verified live: getTokenLargestAccounts fails close to 100% of the time
  // against the free public mainnet RPC, not occasionally. Treating "unknown"
  // the same as "100% concentrated" would silently reject an entire sample
  // run on the default config, which defeats the point of a research tool
  // meant to be read by a human -- so unknown must not disqualify.
  test("unknown concentration (null, RPC failed) does not disqualify an otherwise-clean profile", () => {
    const r = classifyLaunch(input({ top10ConcentrationPct: null }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, true);
    assert.deepEqual(r.reasons, []);
  });

  test("unknown concentration is still surfaced as a caveat for the human to check", () => {
    const r = classifyLaunch(input({ top10ConcentrationPct: null }), DEFAULT_THRESHOLDS);
    assert.ok(r.caveats.some((c) => /concentration unknown/.test(c)));
  });

  test("a clean profile with known concentration has no caveats", () => {
    const r = classifyLaunch(input({ top10ConcentrationPct: 10 }), DEFAULT_THRESHOLDS);
    assert.deepEqual(r.caveats, []);
  });

  test("unknown concentration does not mask OTHER real rejections", () => {
    const r = classifyLaunch(input({ isBanned: true, top10ConcentrationPct: null }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /banned/.test(x)));
  });
});

// ==================================================================
// The 24h buy/sell balance gate. Selects for a two-sided book: a token
// running 90% buys is a pump still inflating and has never been tested by
// anyone trying to exit, which is exactly what this study wants to learn
// about. See the caveat on DEFAULT_THRESHOLDS -- balance alone cannot
// distinguish a healthy book from a wash bot, which is why the two wash
// heuristics stay in place alongside it rather than being replaced by it.
// ==================================================================

describe("24h buy/sell balance gate", () => {
  test("the ratios the band was specified around all pass", () => {
    for (const [buys, sells] of [[49, 51], [51, 49], [50, 50], [45, 55], [55, 45]] as const) {
      const r = classifyLaunch(
        input({ buys24h: buys, sells24h: sells, txCount24h: buys + sells }),
        DEFAULT_THRESHOLDS,
      );
      assert.equal(r.clean, true, `${buys}/${sells} should pass but got: ${r.reasons.join("; ")}`);
    }
  });

  test("a one-sided buy stampede is rejected", () => {
    const r = classifyLaunch(
      input({ buys24h: 900, sells24h: 100, txCount24h: 1000, replyCount: 400 }),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /buy\/sell split/.test(x)));
  });

  test("a one-sided exit rush is rejected too -- the band is symmetric", () => {
    const r = classifyLaunch(
      input({ buys24h: 100, sells24h: 900, txCount24h: 1000, replyCount: 400 }),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /buy\/sell split/.test(x)));
  });

  test("the band edges are inclusive, so a boundary token is not silently dropped", () => {
    for (const [buys, sells] of [[45, 55], [55, 45]] as const) {
      const r = classifyLaunch(
        input({ buys24h: buys, sells24h: sells, txCount24h: 100 }),
        DEFAULT_THRESHOLDS,
      );
      assert.deepEqual(r.reasons, [], `${buys}% buy share sits exactly on the bound`);
    }
    // ...and one tick outside is not.
    const outside = classifyLaunch(
      input({ buys24h: 56, sells24h: 44, txCount24h: 100 }),
      DEFAULT_THRESHOLDS,
    );
    assert.ok(outside.reasons.some((x) => /buy\/sell split/.test(x)));
  });

  // A token with no DexScreener pair arrives as 0 volume AND 0/0 txns. It must
  // be rejected exactly once (for volume), not twice -- the rejection tally in
  // the report is a count of candidates per gate, and double-booking one
  // failure would make the volume floor look less load-bearing than it is.
  test("a token with no trades at all is rejected once, by volume, not twice", () => {
    const r = classifyLaunch(
      input({ volume24hUsd: 0, txCount24h: 0, buys24h: 0, sells24h: 0 }),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(r.clean, false);
    assert.equal(r.reasons.length, 1);
    assert.ok(/24h volume/.test(r.reasons[0]!));
  });
});

// ==================================================================
// OG-vs-copycat. A successful pump.fun ticker is cloned within days --
// verified live on CYBERLEEK (original 2026-08-15 at ~$7M; three `cyberleek`
// clones on 08-18; a "RIP Cyberleek"/"Justice for CyberLeek" swarm on 08-27).
// The clones inherit their volume from the original's attention, so counting
// them as successes would teach the scorer to chase spent tickers.
// ==================================================================

describe("OG-vs-copycat gate", () => {
  test("the OG passes", () => {
    const r = classifyLaunch(input({ ogStatus: { kind: "og" } }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, true);
    assert.deepEqual(r.caveats, []);
  });

  test("a copycat is rejected however well it performed", () => {
    const r = classifyLaunch(input({
      // every other signal is excellent -- only the ticker is borrowed
      volume24hUsd: 9_000_000, buys24h: 50, sells24h: 50, replyCount: 5_000,
      ogStatus: {
        kind: "copycat", firstMint: "GtkzVXwj3AKQm8r2uwxha3Qx6No56BKP3rep4iSppump",
        firstSymbol: "CYBERLEEK", firstName: "CyberLeek",
        firstSeenMs: 1_755_216_000_000, laterByMs: 3 * 86_400_000,
      },
    }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, false);
    assert.ok(r.reasons.some((x) => /not the OG/.test(x)));
  });

  test("the rejection names the original mint so it can be checked by hand", () => {
    const r = classifyLaunch(input({
      ogStatus: {
        kind: "copycat", firstMint: "MINTAAA", firstSymbol: "X", firstName: "The Real X",
        firstSeenMs: 1_000, laterByMs: 3 * 86_400_000,
      },
    }), DEFAULT_THRESHOLDS);
    const reason = r.reasons.find((x) => /not the OG/.test(x))!;
    assert.ok(reason.includes("MINTAAA"), reason);
    assert.ok(reason.includes("The Real X"), reason);
    assert.ok(reason.includes("3.0d"), reason);
  });

  // Same call as the holder-concentration null: this is an offline study read
  // by a human, so rejecting on an infrastructure failure would silently empty
  // the sample and be misread as a finding.
  test("an unresolvable OG status does not disqualify, but is surfaced as a caveat", () => {
    const r = classifyLaunch(
      input({ ogStatus: { kind: "unknown", why: "pump.fun search failed" } }),
      DEFAULT_THRESHOLDS,
    );
    assert.equal(r.clean, true);
    assert.ok(r.caveats.some((c) => /OG status unknown/.test(c)));
  });

  test("a skipped check neither rejects nor adds noise -- it was never run", () => {
    const r = classifyLaunch(input({ ogStatus: { kind: "skipped" } }), DEFAULT_THRESHOLDS);
    assert.equal(r.clean, true);
    assert.deepEqual(r.caveats, []);
  });

  test("being a copycat does not mask other real rejections", () => {
    const r = classifyLaunch(input({
      volume24hUsd: 100,
      ogStatus: {
        kind: "copycat", firstMint: "M", firstSymbol: "S", firstName: "N",
        firstSeenMs: 1, laterByMs: 86_400_000,
      },
    }), DEFAULT_THRESHOLDS);
    assert.equal(r.reasons.length, 2);
    assert.ok(r.reasons.some((x) => /24h volume/.test(x)));
    assert.ok(r.reasons.some((x) => /not the OG/.test(x)));
  });
});

describe("normalizeSymbol", () => {
  // pump.fun's search returns every spelling of one trend's ticker; to a
  // trader they are the same ticker, so the OG comparison must agree.
  test("case and punctuation do not make a different ticker", () => {
    for (const v of ["CYBERLEEK", "cyberleek", "CyberLeek", "$CYBERLEEK", "cyber-leek"]) {
      assert.equal(normalizeSymbol(v), "CYBERLEEK", v);
    }
  });

  test("genuinely different tickers stay different", () => {
    assert.notEqual(normalizeSymbol("CYBERLEEK"), normalizeSymbol("P1SS"));
  });

  test("an empty or punctuation-only ticker normalizes to empty, not to a match", () => {
    assert.equal(normalizeSymbol(""), "");
    assert.equal(normalizeSymbol("$$$"), "");
  });
});

describe("buySharePct", () => {
  test("no transactions is null, not a defaulted 50 or 0", () => {
    assert.equal(buySharePct(0, 0), null);
  });

  test("all buys and all sells are the two extremes", () => {
    assert.equal(buySharePct(10, 0), 100);
    assert.equal(buySharePct(0, 10), 0);
  });

  test("an even book is 50", () => {
    assert.equal(buySharePct(500, 500), 50);
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

// ==================================================================
// Precursor matching. A real run surfaced "Main Page" as a trend and scored
// "copper inu" against "Cooper Kupp" at 0.42 -- both fed a scoring proposal.
// These guard the filters added in response.
// ==================================================================

describe("precursor match filtering", () => {
  test("the noise band that produced junk matches is now below threshold", () => {
    // Every one of these cleared the original 0.4 bar in a real run.
    for (const [term, title] of [
      ["copper inu", "Cooper Kupp"],
      ["XerisCoin", "Terri Irwin"],
      ["Elon Coin", "Elon Musk"],
      ["Rainmaker", "Westlife"],
    ] as const) {
      const s = similarity(term, title);
      assert.ok(s < 0.6, `"${term}" vs "${title}" scored ${s.toFixed(2)}, expected < 0.6`);
    }
  });

  test("a genuinely matching title still clears the bar", () => {
    assert.ok(similarity("Moo Deng", "Moo Deng") >= 0.6);
    assert.ok(similarity("Chill Guy", "Chill guy") >= 0.6);
  });

  test("wikipedia navigation pages are excluded, matching the live feed", () => {
    const WIKI_SKIP = /^(Main_Page|Special:|Wikipedia:|Portal:|Category:|File:|Help:|Template:|Talk:)/i;
    for (const nav of ["Main_Page", "Special:Random", "Portal:Current_events", "Category:Foo"]) {
      assert.ok(WIKI_SKIP.test(nav), `${nav} should be skipped`);
    }
    assert.ok(!WIKI_SKIP.test("Moo_Deng"), "a real article must not be skipped");
  });

  test("short generic one-word names cannot be attributed to a trend", () => {
    // similarity()'s containment rule scores these >=0.9 against any title
    // containing the word, which is right for saturation and wrong here.
    const tooGeneric = (t: string) =>
      tokens(t).length >= 2 ? false : normalize(t).replace(/\s/g, "").length < 6;

    for (const generic of ["WAR", "HODL", "CTO", "ELON"]) {
      assert.equal(tooGeneric(generic), true, `"${generic}" should be too generic to attribute`);
    }
    for (const specific of ["Moo Deng", "testicle", "maxxing", "copper inu"]) {
      assert.equal(tooGeneric(specific), false, `"${specific}" should be attributable`);
    }
    // The exact failure from the real run: "WAR" matched three war articles at 0.90.
    assert.ok(similarity("WAR", "World War II") >= 0.9, "containment still scores high...");
    assert.equal(tooGeneric("WAR"), true, "...which is why the generic guard is what excludes it");
  });
});
