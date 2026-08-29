import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { openMemoryDb, type Db } from "../src/util/db.ts";
import {
  openPosition, closePosition, abandonPosition, listOrphanedByMode, listOpen,
} from "../src/positions/store.ts";

// ==================================================================
// Pretend positions are stranded by a mode switch: everything that services
// exits reads listOpen(db, dryRun) for the CURRENT mode, so a simulate
// session's positions are never looked at again once the bot runs for real.
// Five sat open for two days with sell_attempts = 0 -- nothing had tried,
// because nothing was looking.
//
// The trap when clearing them: closePosition(..., exitSol: 0) books
// -entry_sol, which would have invented a 0.25 SOL loss across those five.
// That is the DECISIONS #39 mistake exactly. Abandoning must report NO
// outcome, not a bad one.
// ==================================================================

let db: Db;
beforeEach(() => { db = openMemoryDb(); });

const open = (o: { symbol?: string; dryRun: boolean }) =>
  openPosition(db, {
    mint: `mint-${o.symbol ?? "X"}-${Math.random()}`,
    symbol: o.symbol ?? "X", entrySol: 0.05, entryTokens: "1000",
    entryFeeSol: 0, dryRun: o.dryRun,
  });

const row = (id: number) =>
  db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as {
    status: string; exit_reason: string | null;
    realized_pnl_sol: number | null; closed_at: number | null;
  };

describe("abandonPosition", () => {
  test("retires the position without inventing a loss", () => {
    const id = open({ symbol: "TURMA", dryRun: true });
    abandonPosition(db, id, "orphaned by mode switch");

    const r = row(id);
    assert.equal(r.status, "abandoned");
    assert.equal(r.exit_reason, "abandoned");
    assert.equal(r.realized_pnl_sol, null,
      "no sale happened -- a number here would be fabricated either way");
    assert.ok(r.closed_at, "should carry a retirement timestamp");
  });

  test("does not count as an open position any more", () => {
    const id = open({ symbol: "PHASE", dryRun: true });
    assert.equal(listOpen(db, true).length, 1);
    abandonPosition(db, id, "orphaned");
    assert.equal(listOpen(db, true).length, 0);
  });

  test("stays out of realised P&L and the win rate", () => {
    // One real closed win, plus five abandoned pretend rows.
    const won = open({ symbol: "WIN", dryRun: false });
    closePosition(db, won, {
      reason: "take_profit", exitSol: 0.2, exitTokens: "1000", entrySol: 0.05,
    });
    for (let i = 0; i < 5; i++) abandonPosition(db, open({ dryRun: true }), "orphaned");

    // These are the exact aggregates web/queries.ts runs.
    const agg = (dryRun: number) => db.prepare(
      `SELECT COALESCE(SUM(realized_pnl_sol), 0) pnl, COUNT(*) n,
              COALESCE(SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END), 0) wins
         FROM positions WHERE status = 'closed' AND dry_run = ?`,
    ).get(dryRun) as { pnl: number; n: number; wins: number };

    assert.deepEqual(
      { n: agg(1).n, pnl: agg(1).pnl, wins: agg(1).wins },
      { n: 0, pnl: 0, wins: 0 },
      "abandoned rows must not appear as five pretend losses",
    );
    assert.equal(agg(0).n, 1);
    assert.ok(Math.abs(agg(0).pnl - 0.15) < 1e-9);
  });

  test("closing with exitSol 0 WOULD have invented the loss", () => {
    // Pinning the thing not to do, so nobody 'simplifies' abandon into close.
    const id = open({ dryRun: true });
    closePosition(db, id, {
      reason: "no_balance", exitSol: 0, exitTokens: "0", entrySol: 0.05,
    });
    assert.equal(row(id).realized_pnl_sol, -0.05);
  });

  test("refuses to touch a position that is already closed", () => {
    const id = open({ dryRun: false });
    closePosition(db, id, {
      reason: "take_profit", exitSol: 0.2, exitTokens: "1000", entrySol: 0.05,
    });
    abandonPosition(db, id, "should be a no-op");

    const r = row(id);
    assert.equal(r.status, "closed", "a settled position must not be reopened or relabelled");
    assert.ok(Math.abs((r.realized_pnl_sol ?? 0) - 0.15) < 1e-9);
  });
});

describe("listOrphanedByMode", () => {
  test("finds the other mode's open positions, and only those", () => {
    open({ symbol: "REAL", dryRun: false });
    open({ symbol: "SIM1", dryRun: true });
    open({ symbol: "SIM2", dryRun: true });

    // Bot running for real -> the pretend ones are the orphans.
    const orphans = listOrphanedByMode(db, false);
    assert.equal(orphans.length, 2);
    assert.deepEqual(orphans.map((o) => o.symbol).sort(), ["SIM1", "SIM2"]);

    // And symmetrically.
    assert.deepEqual(listOrphanedByMode(db, true).map((o) => o.symbol), ["REAL"]);
  });

  test("ignores positions that are not open", () => {
    const id = open({ symbol: "SIM", dryRun: true });
    abandonPosition(db, id, "orphaned");
    assert.equal(listOrphanedByMode(db, false).length, 0);
  });
});
