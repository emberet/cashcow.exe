import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { openMemoryDb, type Db } from "../src/util/db.ts";
import { openPosition, closePosition, recoveredSolFromLedger } from "../src/positions/store.ts";

// ==================================================================
// A zero token balance was being read as "we never got out" and booked as a
// TOTAL LOSS. It usually means the opposite: the sell already landed and this
// is the retry looking at the aftermath.
//
// Found live, twice, and confirmed on-chain: SMG and FTFS each had a dev_sell
// of +0.04874043 SOL with a real signature and err=null, while the positions
// table recorded exit_sol 0 / no_balance / pnl -0.05. That is 0.0975 SOL of
// loss that never happened -- and realized loss feeds maxDailyLossSol, so
// phantom losses trip the daily breaker and stop launches for real.
//
// The ledger is the authority: every real sale writes a measured dev_sell row.
// See DECISIONS #39.
// ==================================================================

let db: Db;
beforeEach(() => { db = openMemoryDb(); });

const OPENED = 1_700_000_000_000;
const MINT = "A34dLfAKti9KRqATvXb4DkmNUtfVCNM9DqYsFMW7pBpE";

function ledger(a: {
  mint?: string; sol: number; ts?: number; dryRun?: number;
  kind?: string; sig?: string;
}) {
  db.prepare(
    `INSERT INTO spend_ledger (ts, kind, mint, sol_delta, signature, dry_run, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(a.ts ?? OPENED + 60_000, a.kind ?? "dev_sell", a.mint ?? MINT,
        a.sol, a.sig ?? "sig-abc", a.dryRun ?? 0, null);
}

describe("recoveredSolFromLedger", () => {
  test("finds a sale that landed after the position opened", () => {
    ledger({ sol: 0.04874043 });
    const r = recoveredSolFromLedger(db, MINT, OPENED, 0);
    assert.equal(r.sol, 0.04874043);
    assert.equal(r.signature, "sig-abc");
  });

  test("reports nothing when the wallet genuinely never sold", () => {
    const r = recoveredSolFromLedger(db, MINT, OPENED, 0);
    assert.equal(r.sol, 0);
    assert.equal(r.signature, null);
  });

  test("ignores a sale belonging to a different mint", () => {
    ledger({ mint: "9peztVGeqdCFYbvbmJ9NxKWzBW2RKU7j8n2dz2DS9zSv", sol: 0.05 });
    assert.equal(recoveredSolFromLedger(db, MINT, OPENED, 0).sol, 0);
  });

  test("ignores a sale from BEFORE this position opened", () => {
    // The same mint can be launched, closed, and appear again; an older
    // position's proceeds must not pay off a newer one.
    ledger({ sol: 0.05, ts: OPENED - 60_000 });
    assert.equal(recoveredSolFromLedger(db, MINT, OPENED, 0).sol, 0);
  });

  test("the pretend ledger can never pay off a real position", () => {
    ledger({ sol: 0.05, dryRun: 1 });
    assert.equal(recoveredSolFromLedger(db, MINT, OPENED, 0).sol, 0,
      "a simulated sale must not credit a real position");
    assert.equal(recoveredSolFromLedger(db, MINT, OPENED, 1).sol, 0.05);
  });

  test("only counts sales, not the buy or the launch cost", () => {
    ledger({ kind: "dev_buy", sol: -0.05 });
    ledger({ kind: "launch", sol: -0.0224 });
    assert.equal(recoveredSolFromLedger(db, MINT, OPENED, 0).sol, 0);
  });
});

describe("closing a position whose sell already landed", () => {
  /** Reproduces the SMG row exactly, then closes it the way manager.ts now does. */
  function openSmg(): number {
    return openPosition(db, {
      mint: MINT, symbol: "SMG", entrySol: 0.05, entryTokens: "1763352468753",
      entryFeeSol: 0, signature: "open-sig", dryRun: false,
    });
  }

  test("books the real proceeds instead of a total write-off", () => {
    const id = openSmg();
    ledger({ sol: 0.04874043 });

    const rec = recoveredSolFromLedger(db, MINT, OPENED, 0);
    closePosition(db, id, {
      reason: rec.sol > 0 ? "sold_before_retry" : "no_balance",
      exitSol: rec.sol, exitTokens: "0",
      signature: rec.signature ?? undefined, entrySol: 0.05,
    });

    const row = db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as {
      exit_sol: number; realized_pnl_sol: number; exit_reason: string; closed_sig: string;
    };
    assert.equal(row.exit_sol, 0.04874043);
    assert.equal(row.exit_reason, "sold_before_retry");
    assert.equal(row.closed_sig, "sig-abc");
    // The number that actually matters: -0.00126, not -0.05.
    assert.ok(Math.abs(row.realized_pnl_sol - -0.00125957) < 1e-8,
      `expected ~-0.00126, got ${row.realized_pnl_sol}`);
    assert.ok(row.realized_pnl_sol > -0.01,
      "a landed sale must never be booked as a total loss");
  });

  test("a genuine total loss is still recorded as one", () => {
    const id = openSmg();
    // No ledger row: the tokens really never came back.
    const rec = recoveredSolFromLedger(db, MINT, OPENED, 0);
    closePosition(db, id, {
      reason: rec.sol > 0 ? "sold_before_retry" : "no_balance",
      exitSol: rec.sol, exitTokens: "0", entrySol: 0.05,
    });

    const row = db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as {
      exit_reason: string; realized_pnl_sol: number;
    };
    assert.equal(row.exit_reason, "no_balance");
    assert.equal(row.realized_pnl_sol, -0.05);
  });
});
