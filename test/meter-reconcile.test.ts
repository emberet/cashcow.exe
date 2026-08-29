import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { openMemoryDb, type Db } from "../src/util/db.ts";
import { BudgetGuard } from "../src/risk/budget.ts";
import { configSchema } from "../src/config/schema.ts";

// ==================================================================
// Metered feeds charge a WORST CASE before spending -- correct, since a poll
// that is never billed cannot overrun the cap. But an estimate that is never
// reconciled is a slow lie.
//
// Measured live: the X feed charged 25 reads on every poll while a heavily
// filtered query returned a handful. The meter read $43.875 against roughly
// $9 of real spend, and was ~4 hours from stopping the highest-weight feed
// with most of the month's credit unused. See DECISIONS #42.
// ==================================================================

let db: Db;
const KEY = "x-api-usd";
const cfg = () => configSchema.parse({ dryRun: false });
const guard = () => new BudgetGuard(db, cfg());

beforeEach(() => { db = openMemoryDb(); });

describe("meterRefund", () => {
  test("gives back the unused part of an over-estimate", () => {
    const g = guard();
    g.meterCharge(KEY, 0.125, 50);          // worst case: 25 reads
    g.meterRefund(KEY, 0.125 - 5 * 0.005);  // only 5 came back
    assert.ok(Math.abs(g.meterUsed(KEY) - 0.025) < 1e-9,
      `expected 5 reads' worth, got ${g.meterUsed(KEY)}`);
  });

  test("never drops the meter below zero", () => {
    const g = guard();
    g.meterCharge(KEY, 0.1, 50);
    g.meterRefund(KEY, 999);
    assert.equal(g.meterUsed(KEY), 0, "a refund must not manufacture headroom");
  });

  test("ignores zero and negative refunds", () => {
    const g = guard();
    g.meterCharge(KEY, 0.5, 50);
    g.meterRefund(KEY, 0);
    g.meterRefund(KEY, -10);
    assert.ok(Math.abs(g.meterUsed(KEY) - 0.5) < 1e-9,
      "a negative refund must never be treated as a charge");
  });

  test("does not touch a different meter key", () => {
    const g = guard();
    g.meterCharge(KEY, 0.5, 50);
    g.meterCharge("image-gen-usd", 0.5, 50);
    g.meterRefund(KEY, 0.5);
    assert.ok(Math.abs(g.meterUsed("image-gen-usd") - 0.5) < 1e-9);
  });

  test("the cap still binds after reconciliation", () => {
    const g = guard();
    // Charge to the cap, refund a little, and confirm only that much reopens.
    assert.equal(g.meterCharge(KEY, 1.0, 1.0), true);
    assert.equal(g.meterCharge(KEY, 0.01, 1.0), false, "cap must bind");
    g.meterRefund(KEY, 0.02);
    assert.equal(g.meterCharge(KEY, 0.01, 1.0), true, "refund reopens exactly what it returned");
    assert.equal(g.meterCharge(KEY, 0.02, 1.0), false, "and no more");
  });
});

describe("worst-case-then-reconcile, over a realistic month", () => {
  test("an empty page costs nothing once reconciled", () => {
    const g = guard();
    const estimate = 25 * 0.005;
    g.meterCharge(KEY, estimate, 50);
    g.meterRefund(KEY, estimate - 0 * 0.005);
    assert.equal(g.meterUsed(KEY), 0, "a poll that returned nothing must not be billed");
  });

  test("a full page is charged in full -- nothing is refunded", () => {
    const g = guard();
    const estimate = 25 * 0.005;
    g.meterCharge(KEY, estimate, 50);
    g.meterRefund(KEY, estimate - 25 * 0.005);
    assert.ok(Math.abs(g.meterUsed(KEY) - estimate) < 1e-9);
  });

  test("the over-estimate was the whole problem: 5x the runway", () => {
    // 200 polls averaging 5 results each, with and without reconciliation.
    // Separate meter keys so the two runs cannot share a row.
    const g = guard();
    const OLD = "x-api-usd-unreconciled";
    const NEW = "x-api-usd-reconciled";
    const estimate = 25 * 0.005;
    for (let i = 0; i < 200; i++) {
      g.meterCharge(OLD, estimate, 1000);
      g.meterCharge(NEW, estimate, 1000);
      g.meterRefund(NEW, estimate - 5 * 0.005);
    }
    assert.ok(Math.abs(g.meterUsed(OLD) - 25) < 1e-6,
      `over-estimate should bill $25, got ${g.meterUsed(OLD)}`);
    assert.ok(Math.abs(g.meterUsed(NEW) - 5) < 1e-6,
      `reconciled should bill $5, got ${g.meterUsed(NEW)}`);
  });
});
