import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { BudgetGuard } from "../src/risk/budget.ts";
import { qualifying, type Candidate } from "../src/scoring/score.ts";
import { TUNABLE, FORBIDDEN_PREFIXES } from "../src/learning/guardrails.ts";
import {
  EXPERIMENTAL_CEILINGS,
  setExperimentalWindow,
  getExperimentalWindow,
  clearExperimentalWindow,
  effectiveRisk,
  effectiveScoring,
  type ExperimentalWindowInput,
} from "../src/risk/experimentalWindow.ts";

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: false, ...over });

// The tight documented baseline this window is meant to boost above.
const TIGHT_BASE = {
  maxLaunchesPerDay: 1,
  maxSolPerDay: 0.1,
  maxDailyLossSol: 0.06,
  maxConcurrentPositions: 1,
  threshold: 65,
  minObservations: 3,
};

function open(db: Db, over: Partial<ExperimentalWindowInput> = {}) {
  return setExperimentalWindow(db, {
    hours: 24,
    base: TIGHT_BASE,
    maxLaunchesPerDay: 10,
    maxSolPerDay: 0.85,
    maxDailyLossSol: 0.5,
    maxConcurrentPositions: 5,
    threshold: 40,
    minObservations: 2,
    ...over,
  });
}

function mkCandidate(score: number, observations = 5): Candidate {
  return {
    key: "test-term", term: "test term", score,
    components: { velocity: 0.5, corroboration: 0.5, cryptoAffinity: 0.5, tickerability: 0.5, reach: 0.5, decay: 1 },
    feeds: ["googleTrends"], families: ["search"], corroborationNote: "",
    firstSeen: Date.now(), lastSeen: Date.now(), observations,
  };
}

describe("experimentalWindow — the 24h boost that self-expires", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  test("no window active: effectiveRisk/effectiveScoring pass cfg through unchanged", () => {
    const c = cfg({ risk: TIGHT_BASE, scoring: { threshold: TIGHT_BASE.threshold, minObservations: TIGHT_BASE.minObservations } });
    assert.deepEqual(effectiveRisk(db, c), c.risk);
    assert.deepEqual(effectiveScoring(db, c), c.scoring);
    assert.equal(getExperimentalWindow(db), undefined);
  });

  test("active, unexpired window: boosted values are returned", () => {
    open(db);
    const c = cfg({ risk: TIGHT_BASE, scoring: { threshold: TIGHT_BASE.threshold, minObservations: TIGHT_BASE.minObservations } });

    const r = effectiveRisk(db, c);
    assert.equal(r.maxLaunchesPerDay, 10);
    assert.equal(r.maxSolPerDay, 0.85);
    assert.equal(r.maxDailyLossSol, 0.5);
    assert.equal(r.maxConcurrentPositions, 5);

    const s = effectiveScoring(db, c);
    assert.equal(s.threshold, 40);
    assert.equal(s.minObservations, 2);
  });

  test("expired window reverts to config values and self-clears (logs once)", () => {
    open(db, { hours: 0.0001 }); // ~360ms
    const c = cfg({ risk: TIGHT_BASE, scoring: { threshold: TIGHT_BASE.threshold, minObservations: TIGHT_BASE.minObservations } });

    // Force expiry deterministically rather than sleeping in a test.
    const raw = JSON.parse((db.prepare("SELECT value FROM kv WHERE key = 'experimental_window'").get() as { value: string }).value);
    raw.expiresAt = Date.now() - 1;
    db.prepare("UPDATE kv SET value = ? WHERE key = 'experimental_window'").run(JSON.stringify(raw));

    assert.equal(getExperimentalWindow(db), undefined);
    assert.deepEqual(effectiveRisk(db, c), c.risk);

    // Second read must not re-discover a window (row was cleared) and must not throw.
    assert.equal(getExperimentalWindow(db), undefined);
    const row = db.prepare("SELECT value FROM kv WHERE key = 'experimental_window'").get() as { value: string } | undefined;
    assert.equal(row?.value ?? "", "", "expiry must clear the stored row");
  });

  test("malformed kv row (bad JSON) is treated as inactive, no throw", () => {
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('experimental_window', 'not json', ?)`,
    ).run(Date.now());
    assert.doesNotThrow(() => getExperimentalWindow(db));
    assert.equal(getExperimentalWindow(db), undefined);
  });

  test("malformed kv row (missing field) is treated as inactive, no throw", () => {
    db.prepare(
      `INSERT INTO kv (key, value, updated_at) VALUES ('experimental_window', ?, ?)`,
    ).run(JSON.stringify({ createdAt: Date.now(), expiresAt: Date.now() + 1000 }), Date.now());
    assert.doesNotThrow(() => getExperimentalWindow(db));
    assert.equal(getExperimentalWindow(db), undefined);
  });

  test("setExperimentalWindow clamps an out-of-range request to EXPERIMENTAL_CEILINGS", () => {
    const w = open(db, { maxLaunchesPerDay: 1000, maxSolPerDay: 999, maxConcurrentPositions: 999 });
    assert.equal(w.risk.maxLaunchesPerDay, EXPERIMENTAL_CEILINGS.maxLaunchesPerDay);
    assert.equal(w.risk.maxSolPerDay, EXPERIMENTAL_CEILINGS.maxSolPerDay);
    assert.equal(w.risk.maxConcurrentPositions, EXPERIMENTAL_CEILINGS.maxConcurrentPositions);
  });

  test("threshold/minObservations can never be requested more permissive than the tuner's own floor", () => {
    const w = open(db, { threshold: 0, minObservations: 0 });
    assert.equal(w.scoring.threshold, EXPERIMENTAL_CEILINGS.thresholdFloor);
    assert.equal(w.scoring.minObservations, EXPERIMENTAL_CEILINGS.minObservationsFloor);
  });

  test("--hours above the ceiling clamps to maxHours", () => {
    const w = open(db, { hours: 10_000 });
    const gotHours = (w.expiresAt - w.createdAt) / 3600_000;
    assert.ok(gotHours <= EXPERIMENTAL_CEILINGS.maxHours + 0.01, `expected <= ${EXPERIMENTAL_CEILINGS.maxHours}h, got ${gotHours}`);
  });

  test("maxDailyLossSol > maxSolPerDay is rejected, mirroring assertCoherent()", () => {
    const w = open(db, { maxSolPerDay: 0.2, maxDailyLossSol: 0.9 });
    assert.ok(w.risk.maxDailyLossSol <= w.risk.maxSolPerDay,
      `loss breaker (${w.risk.maxDailyLossSol}) must never exceed the daily cap (${w.risk.maxSolPerDay})`);
  });

  test("BudgetGuard: denies at the tight base cap, allows once a window is active", () => {
    const c = cfg({ risk: TIGHT_BASE });
    const g = new BudgetGuard(db, c);
    g.record({ kind: "launch", solDelta: -0.09 }); // uses up the 0.1 SOL/day base cap
    // isLaunch: false so this exercises the SOL cap specifically, not the
    // (also tight, base 1/day) launch-count cap -- that combination is
    // covered by the next test.
    const deniedBefore = g.canSpend(0.05, { isLaunch: false });
    assert.equal(deniedBefore.ok, false);
    assert.equal(deniedBefore.ok === false && deniedBefore.code, "DAILY_SOL_CAP");

    open(db, { base: TIGHT_BASE });
    const allowedAfter = g.canSpend(0.05, { isLaunch: false });
    assert.equal(allowedAfter.ok, true, "the same spend must clear once the window raises the ceiling");
  });

  test("BudgetGuard: the launch-count cap is also widened by an active window", () => {
    const c = cfg({ risk: TIGHT_BASE });
    const g = new BudgetGuard(db, c);
    g.record({ kind: "launch", solDelta: -0.01 }); // 1/1 launches used at the base cap

    assert.equal(g.canSpend(0.01, { isLaunch: true }).ok, false);
    open(db, { base: TIGHT_BASE });
    assert.equal(g.canSpend(0.01, { isLaunch: true }).ok, true);
  });

  test("buildCandidates/qualifying: a candidate scoring 45 fails at base threshold 65, qualifies at windowed threshold 40", () => {
    const baseScoring = configSchema.parse({ scoring: { threshold: 65, minObservations: 2 } }).scoring;
    const candidates = [mkCandidate(45, 5)];

    assert.equal(qualifying(candidates, baseScoring).length, 0);

    open(db, { base: TIGHT_BASE });
    const c = cfg({ scoring: { threshold: 65, minObservations: 2 } });
    const windowed = effectiveScoring(db, c);
    assert.equal(windowed.threshold, 40);
    assert.equal(qualifying(candidates, windowed).length, 1, "45 clears a windowed threshold of 40");
  });

  test("clearExperimentalWindow cancels early", () => {
    open(db);
    assert.ok(getExperimentalWindow(db));
    clearExperimentalWindow(db, "test cancel");
    assert.equal(getExperimentalWindow(db), undefined);
  });

  test("does not touch src/learning/guardrails.ts: the tuner allowlist is unaffected", () => {
    // This module is architecturally separate from the tuner. Confirm the
    // allowlist still forbids risk.* -- the human boost-window path and the
    // LLM tuner path must never be the same code, or one could smuggle
    // permissions the other cannot reach.
    assert.ok(FORBIDDEN_PREFIXES.some((p) => "risk.maxSolPerDay".startsWith(p.prefix)),
      "risk.* must remain forbidden to the tuner regardless of this module existing");
    assert.ok(TUNABLE.find((b) => b.path === "scoring.threshold"));
  });
});

// ==================================================================
// effectiveRisk() REPLACES the static value rather than taking the max of the
// two. That is fine while a window is more permissive than config -- which is
// the only case it was designed for -- but it means raising a static risk
// number while a window is open has no effect until the window expires, and
// if the window's number is LOWER, the "widen activity" tool quietly narrows
// it instead.
//
// This bit for real: maxHoldMinutes went to 24h with static
// maxConcurrentPositions raised 1 -> 10, while a live window pinned 3. Three
// positions would have opened and launches would have stopped for a day, with
// nothing in the logs naming the cause. See DECISIONS #37.
// ==================================================================

describe("a window can override a static value downward", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  test("replace-not-max is the actual behaviour, and is pinned here", () => {
    const c = cfg({ risk: { maxConcurrentPositions: 10 } });
    open(db, { maxConcurrentPositions: 3 });
    assert.equal(effectiveRisk(db, c).maxConcurrentPositions, 3,
      "window replaces static -- if this ever becomes max(), update DECISIONS #37");
  });

  test("the static value returns intact once the window is cleared", () => {
    const c = cfg({ risk: { maxConcurrentPositions: 10 } });
    open(db, { maxConcurrentPositions: 3 });
    clearExperimentalWindow(db, "test");
    assert.equal(effectiveRisk(db, c).maxConcurrentPositions, 10);
  });

  test("the ceiling is not below what a deployment may statically configure", () => {
    // A ceiling under the static baseline turns every window into a
    // throttle. Keeping this >= 10 is what makes the 24h-hold config
    // expressible inside a window at all.
    assert.ok(EXPERIMENTAL_CEILINGS.maxConcurrentPositions >= 10,
      "ceiling must be able to express the 24h-hold concurrency baseline");
  });
});
