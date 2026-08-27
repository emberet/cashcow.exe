import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { withBalanceLock } from "../src/chain/rpc.ts";

// ==================================================================
// Root-cause regression for the 2026-08-27 incident: a creator-fee claim
// landed between a launch's balanceBefore/balanceAfter reads and made a real
// ~0.025 SOL launch cost measure as 0. launchToken, claimCreatorFees and
// sellAll each bracket a send+confirm with a balance snapshot, and run from
// two independent schedulers (the slow launch loop, the fast position-exit
// poll) that can interleave mid-await. withBalanceLock is what stops their
// snapshot windows from ever overlapping.
// ==================================================================

describe("withBalanceLock", () => {
  test("a second balance-measuring op never starts until the first finishes", async () => {
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    function op(name: string, ms: number) {
      return withBalanceLock(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`${name}:end`);
        active--;
        return name;
      });
    }

    // "launch" starts first and is slow (like send+confirm on mainnet);
    // "claim" is queued immediately after, simulating the independent
    // position-exit poll firing while the launch is still mid-flight.
    const launch = op("launch", 30);
    const claim = op("claim", 5);

    assert.deepEqual(await Promise.all([launch, claim]), ["launch", "claim"]);
    assert.equal(maxActive, 1, "two balance-mutating ops had overlapping snapshot windows");
    assert.deepEqual(events, ["launch:start", "launch:end", "claim:start", "claim:end"]);
  });

  test("a rejected operation does not wedge the lock for later callers", async () => {
    await assert.rejects(() => withBalanceLock(async () => {
      throw new Error("simulated send/confirm failure");
    }));

    // A prior failure must not leave the queue stuck forever -- a real
    // launch failing must not silently freeze fee claims and sells too.
    const result = await withBalanceLock(async () => "ok");
    assert.equal(result, "ok");
  });

  test("independent callers each still see their own result and error", async () => {
    const [a, bErr, c] = await Promise.allSettled([
      withBalanceLock(async () => "a"),
      withBalanceLock(async () => { throw new Error("b failed"); }),
      withBalanceLock(async () => "c"),
    ]);

    assert.equal(a.status, "fulfilled");
    assert.equal(bErr.status, "rejected");
    assert.equal(c.status, "fulfilled");
    if (a.status === "fulfilled") assert.equal(a.value, "a");
    if (c.status === "fulfilled") assert.equal(c.value, "c");
  });
});
