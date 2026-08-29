import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { validate, applyChanges, boundFor, FORBIDDEN_PREFIXES } from "../src/learning/guardrails.ts";
import { sanitise, writeOverlay, readOverlay, clearOverlay } from "../src/learning/overlay.ts";
import { computeCapacity, costPerLaunch, balanceNeededFor, newsVolumeScale } from "../src/risk/capacity.ts";
import { BudgetGuard } from "../src/risk/budget.ts";
import { recordLaunch, outcomeSummary, settledOutcomes } from "../src/learning/outcomes.ts";
import { corroborationStrength, distinctFamilies, familyOf } from "../src/scoring/independence.ts";

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: false, ...over });

// ==================================================================
// The tuner's mandate. This is the boundary that makes a self-modifying
// config acceptable at all, so it is tested harder than anything else.
// ==================================================================

describe("tuner guardrails — can change how picky, never how much money", () => {
  const live = cfg();

  test("every forbidden prefix is actually rejected", () => {
    // Walk the declared denials rather than spot-checking, so adding a prefix
    // without enforcement fails here.
    for (const { prefix } of FORBIDDEN_PREFIXES) {
      const path = prefix.endsWith(".") ? `${prefix}someKey` : prefix;
      const v = validate({ path, value: 999 }, live);
      assert.equal(v.ok, false, `expected "${path}" to be rejected`);
      assert.match(v.ok === false ? v.reason : "", /forbidden/);
    }
  });

  test("the money knobs specifically cannot be touched", () => {
    for (const path of [
      "risk.maxSolPerDay",
      "risk.maxLaunchesPerDay",
      "risk.maxDailyLossSol",
      "risk.minWalletBalanceSol",
      "devPosition.buySol",
      "devPosition.exit.stopLossPct",
      "launch.cashback",
      "filters.blockTrademarks",
      "dryRun",
      "network",
    ]) {
      assert.equal(validate({ path, value: 1 }, live).ok, false, `"${path}" must be unreachable`);
    }
  });

  test("an unlisted path is rejected even though it is harmless", () => {
    // Default-deny: new config keys are not tunable until explicitly allowed.
    assert.equal(validate({ path: "scoring.someNewKnob", value: 1 }, live).ok, false);
    assert.equal(validate({ path: "logging.level", value: 1 }, live).ok, false);
  });

  test("allowed paths are accepted", () => {
    const v = validate({ path: "scoring.threshold", value: 68 }, live);
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.to, 68);
  });

  test("a wild proposal becomes a small step, not a jump", () => {
    // maxDelta on threshold is 5; asking for 95 from 65 must move 5.
    const v = validate({ path: "scoring.threshold", value: 95 }, live);
    assert.equal(v.ok, true);
    assert.equal(v.ok === true && v.to, live.scoring.threshold + 5);
    assert.equal(v.ok === true && v.clamped, true);
  });

  test("absolute bounds hold even across many runs", () => {
    const bound = boundFor("scoring.threshold")!;
    let current = cfg();
    for (let i = 0; i < 40; i++) {
      const v = validate({ path: "scoring.threshold", value: 1000 }, current);
      if (!v.ok) break;
      current = cfg({ scoring: { threshold: v.to } });
    }
    assert.ok(current.scoring.threshold <= bound.max,
      `threshold escaped its ceiling: ${current.scoring.threshold}`);
  });

  test("operator-pinned keys are untouchable", () => {
    const v = validate({ path: "scoring.threshold", value: 60 }, live, ["scoring.threshold"]);
    assert.equal(v.ok, false);
    assert.match(v.ok === false ? v.reason : "", /pinned/);
  });

  test("maxChangesPerRun is enforced", () => {
    const res = applyChanges(
      [
        { path: "scoring.threshold", value: 67 },
        { path: "scoring.decayHalfLifeMinutes", value: 50 },
        { path: "scoring.minObservations", value: 4 },
        { path: "saturation.maxSimilar", value: 3 },
        { path: "feeds.fourchan.weight", value: 0.5 },
      ],
      live,
      { maxChanges: 2 },
    );
    assert.equal(res.accepted.length, 2);
    assert.ok(res.rejected.some((r) => /maxChangesPerRun/.test(r.reason)));
  });

  test("score weights are renormalised so the config stays loadable", () => {
    // The loader rejects any config whose weights do not sum to 1.
    const res = applyChanges(
      [{ path: "scoring.weights.velocity", value: 0.4 }],
      live,
      { maxChanges: 4 },
    );
    assert.equal(res.accepted.length, 1);

    const w = (res.overlay as { scoring: { weights: Record<string, number> } }).scoring.weights;
    const sum = Object.values(w).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 0.005, `weights must sum to 1, got ${sum}`);

    // And the result must actually parse.
    assert.doesNotThrow(() => configSchema.parse({ scoring: { weights: w } }));
  });

  test("a mixed batch accepts the good and rejects the bad", () => {
    const res = applyChanges(
      [
        { path: "scoring.threshold", value: 68 },
        { path: "risk.maxSolPerDay", value: 999 },
        { path: "devPosition.buySol", value: 5 },
      ],
      live,
      { maxChanges: 4 },
    );
    assert.equal(res.accepted.length, 1);
    assert.equal(res.accepted[0]?.path, "scoring.threshold");
    assert.equal(res.rejected.length, 2);
    assert.equal((res.overlay as Record<string, unknown>).risk, undefined);
    assert.equal((res.overlay as Record<string, unknown>).devPosition, undefined);
  });
});

// ==================================================================

describe("tuning overlay — filtered on read, not just on write", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "trendbot-ov-")); });

  test("hand-editing a forbidden key into the file does nothing", () => {
    // The file is not a trusted input. Someone (or something) editing it must
    // not be able to reach the spend limits the tuner cannot reach.
    const file = join(dir, "tuning.json");
    writeFileSync(file, JSON.stringify({
      updatedAt: Date.now(),
      values: {
        scoring: { threshold: 70 },
        risk: { maxSolPerDay: 999, maxLaunchesPerDay: 500 },
        devPosition: { buySol: 10 },
      },
    }));

    const loaded = readOverlay(file) as Record<string, Record<string, unknown>>;
    assert.equal(loaded.scoring?.threshold, 70, "the legitimate key survives");
    assert.equal(loaded.risk, undefined, "risk.* must be stripped");
    assert.equal(loaded.devPosition, undefined, "devPosition.* must be stripped");
    rmSync(dir, { recursive: true, force: true });
  });

  test("sanitise reports what it dropped", () => {
    const { clean, dropped } = sanitise({
      scoring: { threshold: 70 },
      risk: { maxSolPerDay: 999 },
    });
    assert.deepEqual(Object.keys(clean), ["scoring"]);
    assert.ok(dropped.includes("risk.maxSolPerDay"));
  });

  test("write, read back, then clear", () => {
    const file = join(dir, "tuning.json");
    writeOverlay({ scoring: { threshold: 71 } }, 1, file);
    assert.equal((readOverlay(file) as { scoring: { threshold: number } }).scoring.threshold, 71);
    assert.equal(clearOverlay(file), true);
    assert.deepEqual(readOverlay(file), {});
    rmSync(dir, { recursive: true, force: true });
  });

  test("a corrupt overlay is ignored rather than crashing the bot", () => {
    const file = join(dir, "tuning.json");
    writeFileSync(file, "{ not json at all");
    assert.deepEqual(readOverlay(file), {});
    rmSync(dir, { recursive: true, force: true });
  });
});

// ==================================================================

describe("adaptive capacity — as many as the wallet sustains, never more", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  const adaptive = (over: Record<string, unknown> = {}) =>
    cfg({
      risk: {
        maxSolPerDay: 100,
        adaptive: { enabled: true, minRunwayDays: 7, maxDailyBurnPct: 0.2, ...over },
      },
    });

  test("capacity scales with the wallet", () => {
    const c = adaptive();
    const small = computeCapacity(db, c, 1).launchesPerDay;
    const mid = computeCapacity(db, c, 10).launchesPerDay;
    const large = computeCapacity(db, c, 30).launchesPerDay;
    assert.ok(small < mid && mid < large, `expected growth, got ${small}/${mid}/${large}`);
  });

  test("a wallet too small for one launch gets zero, not one", () => {
    // The important direction: refusing to act beats draining the wallet.
    const c = adaptive();
    assert.equal(computeCapacity(db, c, 0.2).launchesPerDay, 0);
  });

  test("the reserve is never spent", () => {
    const c = adaptive({ reserveSol: 0.5 });
    const cap = computeCapacity(db, c, 0.5);
    assert.equal(cap.launchesPerDay, 0);
    assert.equal(cap.detail.spendableSol, 0);
  });

  test("runway is honoured: daily budget never exceeds spendable/minRunwayDays", () => {
    const c = adaptive({ minRunwayDays: 10 });
    const cap = computeCapacity(db, c, 20);
    assert.ok(cap.solPerDay <= (20 - c.risk.adaptive.reserveSol) / 10 + 1e-9,
      `budget ${cap.solPerDay} breaks a 10-day runway`);
  });

  test("adaptive can never exceed the static SOL ceiling", () => {
    const c = cfg({
      risk: { maxSolPerDay: 0.3, adaptive: { enabled: true } },
    });
    const cap = computeCapacity(db, c, 1000);
    assert.ok(cap.solPerDay <= 0.3, `adaptive escaped the static ceiling: ${cap.solPerDay}`);

    const guard = new BudgetGuard(db, c);
    guard.setCapacity(cap);
    assert.ok(guard.effectiveMaxSolPerDay <= 0.3);
  });

  test("the hard ceiling caps an arbitrarily rich wallet", () => {
    const c = adaptive({ maxLaunchesPerDayCeiling: 12 });
    assert.equal(computeCapacity(db, c, 10_000).launchesPerDay, 12);
  });

  test("losing money throttles capacity", () => {
    const c = adaptive({ throttleOnLoss: true, lossThrottleFactor: 0.5 });
    const healthy = computeCapacity(db, c, 10).launchesPerDay;

    // A settled launch that lost money.
    db.prepare(
      `INSERT INTO launch_outcomes (mint, launched_at, verdict, realized_pnl_sol, dry_run)
       VALUES ('m1', ?, 'dud', -0.4, 0)`,
    ).run(Date.now());

    const throttled = computeCapacity(db, c, 10);
    assert.ok(throttled.launchesPerDay < healthy,
      `expected a cut from ${healthy}, got ${throttled.launchesPerDay}`);
    assert.equal(throttled.detail.throttled, true);
    assert.match(throttled.binding, /P&L|hit rate/);
  });

  test("disabled adaptive returns the static cap untouched", () => {
    const c = cfg();
    const cap = computeCapacity(db, c, 999);
    assert.equal(cap.adaptive, false);
    assert.equal(cap.launchesPerDay, c.risk.maxLaunchesPerDay);
  });

  test("unknown balance falls back to the static cap rather than guessing", () => {
    const c = adaptive();
    const cap = computeCapacity(db, c, undefined);
    assert.equal(cap.launchesPerDay, c.risk.maxLaunchesPerDay);
    assert.match(cap.binding, /unknown/);
  });

  test("the budget guard actually enforces the adaptive cap", () => {
    const c = adaptive({ maxLaunchesPerDayCeiling: 2 });
    const guard = new BudgetGuard(db, c);
    guard.setCapacity(computeCapacity(db, c, 10_000));

    guard.record({ kind: "launch", solDelta: -0.03 });
    guard.record({ kind: "launch", solDelta: -0.03 });
    const d = guard.canSpend(0.03, { isLaunch: true });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.code, "DAILY_LAUNCH_CAP");
  });

  test("the dev buy dominates cost per launch", () => {
    // Documents the tradeoff the operator actually cares about.
    const withBuy = costPerLaunch(cfg());
    const without = costPerLaunch(cfg({ devPosition: { enabled: false } }));
    assert.ok(without < withBuy / 2,
      `disabling the dev buy should more than halve cost: ${withBuy} -> ${without}`);
    assert.ok(balanceNeededFor(cfg({ devPosition: { enabled: false } }), 24)
      < balanceNeededFor(cfg(), 24) / 2);
  });
});

// ==================================================================
// News-volume confidence throttle: a quiet day should never spend the full
// daily allowance on marginal signal, and a strong day must never exceed
// what every other constraint already allowed.
// ==================================================================

describe("news-volume throttle — moves the allowance down, never up", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  function seedScored(n: number, ageHours = 1) {
    db.prepare(
      `INSERT INTO pipeline_stats (ts, scored, dry_run) VALUES (?, ?, 0)`,
    ).run(Date.now() - ageHours * 3600_000, n);
  }

  const adaptive = (over: Record<string, unknown> = {}) =>
    cfg({
      risk: {
        maxSolPerDay: 100,
        adaptive: { enabled: true, minRunwayDays: 7, maxDailyBurnPct: 0.2, ...over },
      },
    });

  const withThrottle = (over: Record<string, unknown> = {}) =>
    adaptive({
      newsVolumeThrottle: {
        enabled: true, lookbackHours: 24,
        lowVolumeScoredCount: 3, highVolumeScoredCount: 20,
        minScale: 0.34, floorLaunchesPerDay: 1,
        ...over,
      },
    });

  test("newsVolumeScale: at/below low -> minScale, at/above high -> 1, midpoint interpolates", () => {
    const t = { lowVolumeScoredCount: 0, highVolumeScoredCount: 10, minScale: 0.2 };
    assert.equal(newsVolumeScale(0, t), 0.2);
    assert.equal(newsVolumeScale(-5, t), 0.2);
    assert.equal(newsVolumeScale(10, t), 1);
    assert.equal(newsVolumeScale(999, t), 1);
    assert.ok(Math.abs(newsVolumeScale(5, t) - 0.6) < 1e-9, `expected ~0.6, got ${newsVolumeScale(5, t)}`);
  });

  test("newsVolumeScale: a misconfigured high<=low bracket does not throw and stays conservative", () => {
    const t = { lowVolumeScoredCount: 10, highVolumeScoredCount: 5, minScale: 0.3 };
    assert.doesNotThrow(() => newsVolumeScale(3, t));
    assert.equal(newsVolumeScale(3, t), 0.3);
  });

  test("a quiet day still gets the floor when the wallet has plenty of room", () => {
    seedScored(1); // well below lowVolumeScoredCount
    const c = withThrottle({ floorLaunchesPerDay: 1 });
    const cap = computeCapacity(db, c, 10_000);
    assert.ok(cap.launchesPerDay >= 1, `expected the floor to hold, got ${cap.launchesPerDay}`);
    assert.equal(cap.detail.newsVolume?.throttled, true);
    assert.equal(cap.detail.newsVolume?.scale, 0.34);
  });

  test("a strong day is not throttled and never exceeds the static ceiling", () => {
    seedScored(25); // well above highVolumeScoredCount
    const c = cfg({
      risk: {
        maxSolPerDay: 0.3,
        adaptive: {
          enabled: true,
          newsVolumeThrottle: { enabled: true, lowVolumeScoredCount: 3, highVolumeScoredCount: 20 },
        },
      },
    });
    const cap = computeCapacity(db, c, 1000);
    assert.equal(cap.detail.newsVolume?.throttled, false);
    assert.equal(cap.detail.newsVolume?.scale, 1);
    assert.ok(cap.solPerDay <= 0.3, `throttle-enabled capacity escaped the static ceiling: ${cap.solPerDay}`);
  });

  test("the floor never overrides a harder constraint — a wallet too small for one launch stays at zero", () => {
    seedScored(0);
    const c = withThrottle({ floorLaunchesPerDay: 1 });
    // Same wallet size the plain-adaptive test uses to prove zero, not one.
    assert.equal(computeCapacity(db, c, 0.2).launchesPerDay, 0);
  });

  test("disabled by default — zero behavior change from the plain adaptive path", () => {
    seedScored(0); // even with thin signal seeded, nothing should react to it
    const withoutThrottle = computeCapacity(db, adaptive(), 10).launchesPerDay;
    const alsoWithoutThrottle = computeCapacity(db, adaptive(), 10).launchesPerDay;
    assert.equal(withoutThrottle, alsoWithoutThrottle);
    assert.equal(computeCapacity(db, adaptive(), 10).detail.newsVolume, undefined);
  });
});

// ==================================================================

describe("source independence", () => {
  test("same-family agreement is nearly worthless", () => {
    assert.ok(corroborationStrength(["fourchan", "onchain"]) <= 0.05);
    assert.ok(corroborationStrength(["fourchan", "onchain", "farcaster"]) <= 0.15);
  });

  test("cross-family agreement scores real corroboration", () => {
    assert.ok(corroborationStrength(["fourchan", "googleTrends"]) >= 0.5);
    assert.ok(corroborationStrength(["fourchan", "googleTrends", "googleNews"]) >= 0.9);
  });

  test("a single source scores zero however many hits", () => {
    assert.equal(corroborationStrength(["fourchan"]), 0);
    assert.equal(corroborationStrength(["fourchan", "fourchan"]), 0);
  });

  test("every registered feed has a family", () => {
    for (const f of ["googleTrends", "reddit", "xApi", "fourchan", "farcaster",
                     "polymarket", "onchain", "dexActivity", "hackernews", "googleNews", "wikipedia"]) {
      assert.equal(distinctFamilies([f]).length, 1, `${f} has no family`);
    }
  });

  test("onchain and dexActivity are explicitly mapped, not defaulted", () => {
    // familyOf() silently defaults an UNMAPPED feed id to "social" -- the test
    // above would not catch a forgotten FEED_FAMILY entry, since a default
    // mapping still produces exactly one family. This asserts the actual
    // intended family so a future dropped entry fails loudly instead of
    // silently inflating a crypto-native feed into an independent population.
    assert.equal(familyOf("onchain"), "crypto");
    assert.equal(familyOf("dexActivity"), "crypto");
  });
});

describe("outcome recording", () => {
  test("a launch records the features that caused it", () => {
    const db = openMemoryDb();
    recordLaunch(db, {
      mint: "M1", term: "moo deng", symbol: "MOODENG", score: 72.5,
      components: { velocity: 0.9, corroboration: 0.5 },
      feeds: ["googleTrends", "fourchan"], families: ["search", "crypto"],
      namingSource: "model", entrySol: 0.05, dryRun: false,
    });
    const o = outcomeSummary(db, cfg());
    assert.equal(o.total, 1);
    assert.equal(o.pending, 1);
    assert.equal(o.settled, 0, "a fresh launch has not succeeded or failed yet");
    assert.equal(o.hitRate, null, "no hit rate from zero settled launches");
  });

  // peak_volume_h24_usd (v9 migration, src/util/db.ts): DexScreener-sourced,
  // tracked the same running-max way as peak_mcap_usd, but observational
  // only -- classify() still verdicts on peak mcap alone. This only checks
  // the column exists, is nullable, and round-trips through settledOutcomes()
  // correctly; refreshOutcomes() itself calls the network (fetchDexActivity)
  // and is not exercised here, consistent with the rest of this file not
  // hitting real network endpoints.
  test("peak_volume_h24_usd round-trips through settledOutcomes as peakVolumeH24Usd", () => {
    const db = openMemoryDb();
    recordLaunch(db, {
      mint: "M2", term: "vol test", symbol: "VOLT", score: 50,
      components: {}, feeds: ["onchain"], families: ["crypto"],
      namingSource: "model", entrySol: 0.05, dryRun: false,
    });
    db.prepare(
      `UPDATE launch_outcomes SET verdict = 'dud', peak_volume_h24_usd = ? WHERE mint = ?`,
    ).run(41234.5, "M2");

    const rows = settledOutcomes(db, cfg());
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.peakVolumeH24Usd, 41234.5);
  });

  test("peak_volume_h24_usd defaults to null and reads back as 0, not NaN", () => {
    const db = openMemoryDb();
    recordLaunch(db, {
      mint: "M3", term: "no volume yet", symbol: "NOVOL", score: 50,
      components: {}, feeds: ["onchain"], families: ["crypto"],
      namingSource: "model", entrySol: 0.05, dryRun: false,
    });
    db.prepare(`UPDATE launch_outcomes SET verdict = 'dud' WHERE mint = ?`).run("M3");

    const rows = settledOutcomes(db, cfg());
    assert.equal(rows[0]!.peakVolumeH24Usd, 0);
  });
});
