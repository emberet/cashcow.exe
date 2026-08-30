import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { openMemoryDb, type Db } from "../src/util/db.ts";
import {
  openPosition, recordZeroBalanceStrike, clearZeroBalanceStrikes,
} from "../src/positions/store.ts";
import { BalanceUnavailableError } from "../src/chain/trade.ts";

// ==================================================================
// Zero is a fact about the account; a failed read is a fact about the
// network. The old tokenBalance() collapsed both into BN(0), and during a
// 30-second RPC blip three positions were written off as no_balance while
// the wallet held 1,763,352 tokens of each -- verified on-chain afterwards.
// -0.15 SOL of loss was booked on positions that were never lost.
//
// Two rails now stand between an outage and a write-off:
//   1. tokenBalance() throws BalanceUnavailableError unless the RPC
//      AFFIRMATIVELY reports the account absent; the exit path skips the
//      tick without consuming a sell attempt.
//   2. Even an affirmative zero needs two consecutive ticks to agree
//      (zero_balance_strikes, persisted across restarts) before the books
//      close. See DECISIONS #43.
// ==================================================================

let db: Db;
beforeEach(() => { db = openMemoryDb(); });

const open = () => openPosition(db, {
  mint: "A34dLfAKti9KRqATvXb4DkmNUtfVCNM9DqYsFMW7pBpE", symbol: "SMG",
  entrySol: 0.05, entryTokens: "1763352468753", entryFeeSol: 0, dryRun: false,
});

const strikes = (id: number) =>
  (db.prepare("SELECT zero_balance_strikes s FROM positions WHERE id = ?")
    .get(id) as { s: number }).s;

describe("zero-balance strikes", () => {
  test("a single zero read is not enough to close", () => {
    const id = open();
    assert.equal(recordZeroBalanceStrike(db, id), 1, "first strike returns 1");
    // manager.ts closes only at >= 2, so after one strike the position lives.
    assert.equal(strikes(id), 1);
  });

  test("two consecutive zero reads reach the closing threshold", () => {
    const id = open();
    recordZeroBalanceStrike(db, id);
    assert.equal(recordZeroBalanceStrike(db, id), 2);
  });

  test("a nonzero read in between resets the count -- strikes must be consecutive", () => {
    const id = open();
    recordZeroBalanceStrike(db, id);
    clearZeroBalanceStrikes(db, id);   // healthy balance seen
    assert.equal(strikes(id), 0);
    assert.equal(recordZeroBalanceStrike(db, id), 1,
      "after a reset the next zero starts over at 1");
  });

  test("strikes are per-position", () => {
    const a = open();
    const b = openPosition(db, {
      mint: "9peztVGeqdCFYbvbmJ9NxKWzBW2RKU7j8n2dz2DS9zSv", symbol: "OTH",
      entrySol: 0.05, entryTokens: "1000", entryFeeSol: 0, dryRun: false,
    });
    recordZeroBalanceStrike(db, a);
    assert.equal(strikes(b), 0, "another position's outage is not mine");
  });

  test("the column survives in the schema with a zero default", () => {
    const id = open();
    assert.equal(strikes(id), 0);
  });
});

describe("BalanceUnavailableError", () => {
  test("is a distinct, identifiable error type", () => {
    const e = new BalanceUnavailableError("somemint", new Error("fetch failed"));
    assert.equal(e.name, "BalanceUnavailableError");
    assert.ok(e.message.includes("somemint"));
    assert.ok(e.message.includes("fetch failed"));
    assert.ok(e instanceof BalanceUnavailableError);
  });
});
