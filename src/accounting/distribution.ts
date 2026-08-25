import type { Db } from "../util/db.ts";
import type { Config } from "../config/schema.ts";

/**
 * A calculated-figures-only distribution ledger for a possible future
 * cashcow.exe token. Deliberately imports nothing from `risk/`, never touches
 * `BudgetGuard`, holds no wallet reference, and makes no chain call -- there
 * is no token, no recipient list, and no payout mechanism yet, so nothing
 * here can move money even by accident.
 */

export type Split = { label: string; pct: number; sol: number };

export type DistributionSnapshot = {
  id: number;
  computedAt: number;
  periodStart: number;
  periodEnd: number;
  netProfitSol: number;
  splits: Split[];
};

/** Splits netProfitSol per `cfg.distribution.splits` and records the snapshot. */
export function recordDistributionSnapshot(
  db: Db,
  cfg: Config,
  netProfitSol: number,
): DistributionSnapshot {
  const periodStart = (db.prepare(
    `SELECT MAX(period_end) t FROM profit_distributions`,
  ).get() as { t: number | null }).t ?? 0;
  const periodEnd = Date.now();

  const splits: Split[] = cfg.distribution.splits.map((s) => ({
    label: s.label,
    pct: s.pct,
    sol: netProfitSol * (s.pct / 100),
  }));

  const res = db.prepare(
    `INSERT INTO profit_distributions (computed_at, period_start, period_end, net_profit_sol, splits)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(Date.now(), periodStart, periodEnd, netProfitSol, JSON.stringify(splits));

  return {
    id: Number(res.lastInsertRowid),
    computedAt: Date.now(),
    periodStart,
    periodEnd,
    netProfitSol,
    splits,
  };
}

export function listDistributions(db: Db, limit = 50): DistributionSnapshot[] {
  const rows = db.prepare(
    `SELECT id, computed_at, period_start, period_end, net_profit_sol, splits
       FROM profit_distributions ORDER BY id DESC LIMIT ?`,
  ).all(limit) as Array<{
    id: number; computed_at: number; period_start: number; period_end: number;
    net_profit_sol: number; splits: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    computedAt: r.computed_at,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    netProfitSol: r.net_profit_sol,
    splits: JSON.parse(r.splits) as Split[],
  }));
}
