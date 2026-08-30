import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configSchema, isPretend } from "../src/config/schema.ts";
import { claimSendsRealTransaction } from "../src/chain/fees.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { profitSummary } from "../src/web/queries.ts";
import { recordDistributionSnapshot, listDistributions } from "../src/accounting/distribution.ts";

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: false, ...over });

// ==================================================================
// Net profit must not double-count. dev_buy/dev_sell spend_ledger rows are
// already netted inside positions.realized_pnl_sol; summing them again on
// top would silently understate profit.
// ==================================================================

describe("profitSummary — no double-counting", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  function seedClosedPosition(entrySol: number, exitSol: number) {
    db.prepare(
      `INSERT INTO positions (mint, symbol, entry_sol, entry_tokens, entry_price, status,
                               exit_sol, realized_pnl_sol, opened_at, closed_at, dry_run)
       VALUES ('m1', 'SYM', ?, 1000, ?, 'closed', ?, ?, ?, ?, 0)`,
    ).run(entrySol, entrySol / 1000, exitSol, exitSol - entrySol, Date.now(), Date.now());
  }

  function seedLedger(kind: string, solDelta: number) {
    db.prepare(
      `INSERT INTO spend_ledger (ts, kind, sol_delta, dry_run) VALUES (?, ?, ?, 0)`,
    ).run(Date.now(), kind, solDelta);
  }

  function seedFeeClaim(sol: number) {
    db.prepare(
      `INSERT INTO fee_claims (ts, sol_amount, dry_run) VALUES (?, ?, 0)`,
    ).run(Date.now(), sol);
  }

  test("fee claim + realized P&L + launch spend, and nothing else", () => {
    seedClosedPosition(0.05, 0.15); // realized_pnl_sol = 0.10
    seedLedger("dev_buy", -0.05);
    seedLedger("dev_sell", 0.15);
    seedLedger("launch", -0.025);
    seedFeeClaim(0.02);

    const p = profitSummary(db, cfg());
    // 0.02 (fees) + 0.10 (realized pnl) - 0.025 (launch) = 0.095
    assert.ok(Math.abs(p.netProfitSol - 0.095) < 1e-9, `got ${p.netProfitSol}`);
    // Specifically: the dev_buy/dev_sell ledger rows must NOT be subtracted again.
    assert.ok(Math.abs(p.netProfitSol - (0.02 + 0.10 - 0.025)) < 1e-9);
  });

  test("an open position's dev_buy spend does not reduce net profit", () => {
    db.prepare(
      `INSERT INTO positions (mint, symbol, entry_sol, entry_tokens, entry_price, status, opened_at, dry_run)
       VALUES ('m2', 'SYM', 0.05, 1000, 0.00005, 'open', ?, 0)`,
    ).run(Date.now());
    seedLedger("dev_buy", -0.05);

    const p = profitSummary(db, cfg());
    assert.equal(p.netProfitSol, 0, "open positions' locked-up capital is not a loss");
  });

  test("dry_run and live rows never mix", () => {
    seedFeeClaim(1); // live (dry_run=0 from the helper)
    db.prepare(
      `INSERT INTO fee_claims (ts, sol_amount, dry_run) VALUES (?, ?, 1)`,
    ).run(Date.now(), 999); // dry-run, must not leak into the live figure

    const live = profitSummary(db, cfg({ dryRun: false }));
    assert.equal(live.feesTotalSol, 1);

    const pretend = profitSummary(db, cfg({ dryRun: true }));
    assert.equal(pretend.feesTotalSol, 999);
  });

  test("an empty ledger nets to exactly zero, not NaN or undefined", () => {
    const p = profitSummary(db, cfg());
    assert.equal(p.netProfitSol, 0);
  });
});

// ==================================================================
// A fee claim must hit the chain under exactly the conditions that make it
// book as LIVE, and never under the ones that book it as PRETEND.
//
// This was broken in production. claimCreatorFees() gated the real
// transaction on `cfg.dryRun` alone while runner/loop.ts booked the row with
// `isPretend()` (= dryRun || launch.simulate). With simulate=true and
// dryRun=false the bot sent a REAL claim and recorded it against the pretend
// ledger: 0.642662095 SOL genuinely landed in the wallet on 2026-08-27
// (signature 5MbmC35h..., confirmed on-chain) but `profit` reported 0 fees
// and understated net profit by that amount.
// ==================================================================

describe("fee claiming - the send gate matches the accounting gate", () => {
  const combos = [
    { dryRun: false, simulate: false, sends: true },
    { dryRun: true,  simulate: false, sends: false },
    // The case that actually broke: live wallet, simulate on.
    { dryRun: false, simulate: true,  sends: false },
    { dryRun: true,  simulate: true,  sends: false },
  ];

  for (const { dryRun, simulate, sends } of combos) {
    test(`dryRun=${dryRun} simulate=${simulate} -> ${sends ? "sends" : "does not send"}`, () => {
      const c = configSchema.parse({ dryRun, launch: { simulate } });
      assert.equal(claimSendsRealTransaction(c), sends);
      // The load-bearing assertion: a claim is sent if and only if the row
      // would be booked live. If these two ever disagree again, real money
      // goes missing from the accounts.
      assert.equal(claimSendsRealTransaction(c), !isPretend(c));
    });
  }
});

// ==================================================================
// The distribution ledger is calculated figures only, and inert by default.
// ==================================================================

describe("distribution ledger", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  test("splits sum to netProfitSol and match configured percentages", () => {
    const c = cfg({
      distribution: {
        enabled: true,
        splits: [
          { label: "token holders (future)", pct: 40 },
          { label: "operator", pct: 50 },
          { label: "weekly raffle", pct: 10 },
        ],
      },
    });
    const snap = recordDistributionSnapshot(db, c, 10);
    const total = snap.splits.reduce((s, x) => s + x.sol, 0);
    assert.ok(Math.abs(total - 10) < 1e-9, `splits summed to ${total}, expected 10`);

    const byLabel = new Map(snap.splits.map((s) => [s.label, s.sol]));
    assert.ok(Math.abs((byLabel.get("token holders (future)") ?? 0) - 4) < 1e-9);
    assert.ok(Math.abs((byLabel.get("operator") ?? 0) - 5) < 1e-9);
    assert.ok(Math.abs((byLabel.get("weekly raffle") ?? 0) - 1) < 1e-9);
  });

  test("disabled by default", () => {
    assert.equal(cfg().distribution.enabled, false);
  });

  test("consecutive snapshots chain period_start to the previous period_end", () => {
    const c = cfg({ distribution: { enabled: true } });
    const first = recordDistributionSnapshot(db, c, 5);
    const second = recordDistributionSnapshot(db, c, 3);
    assert.equal(second.periodStart, first.periodEnd);
  });

  test("listDistributions returns newest first", () => {
    const c = cfg({ distribution: { enabled: true } });
    recordDistributionSnapshot(db, c, 1);
    recordDistributionSnapshot(db, c, 2);
    const rows = listDistributions(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.netProfitSol, 2);
    assert.equal(rows[1]!.netProfitSol, 1);
  });
});

// ==================================================================
// Migration additivity: each new migration must not disturb earlier ones.
// v8 only adds an index (idx_signals_dedupe); v9, v10 and v11 each only add
// one column with a safe default (peak_volume_h24_usd, source_url,
// zero_balance_strikes), so the table list is unchanged by any of them.
// ==================================================================

describe("migrations are purely additive", () => {
  test("a fresh database lands at the current user_version with earlier tables intact", () => {
    const db = openMemoryDb();
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    assert.equal(version, 12);

    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>)
        .map((r) => r.name),
    );
    for (const t of [
      "signals", "spend_ledger", "launches", "positions", "meter", "fee_claims", "kv",
      "commands", "web_sessions", "audit_log", "launch_outcomes", "tuning_runs",
      "pipeline_stats", "declined", "profit_distributions",
    ]) {
      assert.ok(tables.has(t), `missing table ${t}`);
    }
  });

  test("launch_outcomes gained peak_volume_h24_usd, nullable, without disturbing existing columns", () => {
    const db = openMemoryDb();
    const cols = db.prepare(`PRAGMA table_info(launch_outcomes)`).all() as Array<
      { name: string; notnull: number }
    >;
    const col = cols.find((c) => c.name === "peak_volume_h24_usd");
    assert.ok(col, "expected peak_volume_h24_usd on launch_outcomes");
    assert.equal(col!.notnull, 0, "must be nullable so existing rows do not need backfilling");
    // A representative earlier column is still there, unchanged.
    assert.ok(cols.some((c) => c.name === "peak_mcap_usd"));
  });

  test("launches gained source_url, nullable, without disturbing existing columns", () => {
    const db = openMemoryDb();
    const cols = db.prepare(`PRAGMA table_info(launches)`).all() as Array<
      { name: string; notnull: number }
    >;
    const col = cols.find((c) => c.name === "source_url");
    assert.ok(col, "expected source_url on launches");
    assert.equal(col!.notnull, 0, "must be nullable -- most signals have no URL at all");
    // A representative earlier column is still there, unchanged.
    assert.ok(cols.some((c) => c.name === "mint"));
  });
});
