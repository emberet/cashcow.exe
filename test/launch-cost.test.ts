import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { resolveLaunchCost } from "../src/runner/loop.ts";
import type { LaunchResult } from "../src/chain/launch.ts";

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: false, ...over });

function result(over: Partial<LaunchResult> = {}): LaunchResult {
  return {
    mint: "MintAddress111111111111111111111111111111",
    devBuySol: 0,
    tokensReceived: "0",
    dryRun: false,
    ...over,
  };
}

// ==================================================================
// Regression for the 2026-08-27 incident: a creator-fee claim (+0.642662095
// SOL) landed inside a launch's balance snapshot window, so actualCostSol
// measured below the dev buy and the old `Math.max(0, ...)` floor silently
// booked the launch as free instead of falling back to the estimate.
// ==================================================================

describe("resolveLaunchCost", () => {
  test("no measurement available -- falls back to the estimate", () => {
    const c = cfg();
    const r = resolveLaunchCost(c, result({ actualCostSol: undefined }), 0);
    assert.equal(r.measured, false);
    assert.equal(r.solDelta, c.launch.estimatedCreateCostSol);
  });

  test("a clean, non-negative measurement is trusted as-is", () => {
    const c = cfg();
    // Real create cost plus a dev buy of 0.05, measured together.
    const r = resolveLaunchCost(c, result({ actualCostSol: 0.075 }), 0.05);
    assert.equal(r.measured, true);
    assert.ok(Math.abs(r.solDelta - 0.025) < 1e-9, `got ${r.solDelta}`);
  });

  test("a zero net measurement (no dev buy, exact estimate) is still trusted, not treated as corrupted", () => {
    const c = cfg();
    const r = resolveLaunchCost(c, result({ actualCostSol: 0 }), 0);
    assert.equal(r.measured, true);
    assert.equal(r.solDelta, 0);
  });

  test("CURE incident: a concurrent fee-claim inflow makes the measurement negative -- " +
    "falls back to the estimate instead of silently flooring to 0", () => {
    const c = cfg();
    // devBuySol (0.05) exceeds actualCostSol (0.025) because a 0.64 SOL fee
    // claim landed inside the balance snapshot window and inflated the
    // "after" balance the launch measured against.
    const r = resolveLaunchCost(c, result({ actualCostSol: 0.025 }), 0.05);
    assert.equal(r.measured, false, "a negative reading must not be reported as measured");
    assert.equal(r.solDelta, c.launch.estimatedCreateCostSol);
    assert.notEqual(r.solDelta, 0, "must not silently book the launch as free");
  });
});
