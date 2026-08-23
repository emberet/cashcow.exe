import type { Db } from "../util/db.ts";

export type PositionRow = {
  id: number;
  mint: string;
  symbol: string | null;
  entry_sol: number;
  entry_tokens: number;
  entry_price: number;
  entry_fee_sol: number;
  opened_at: number;
  opened_sig: string | null;
  status: "open" | "closed" | "stuck";
  exit_reason: string | null;
  exit_sol: number | null;
  closed_at: number | null;
  closed_sig: string | null;
  sell_attempts: number;
  last_error: string | null;
  realized_pnl_sol: number | null;
  dry_run: number;
};

export type OpenArgs = {
  mint: string;
  symbol: string;
  entrySol: number;
  entryTokens: string;
  entryFeeSol?: number;
  signature?: string;
  dryRun: boolean;
};

export function openPosition(db: Db, a: OpenArgs): number {
  const tokens = Number(a.entryTokens);
  // Cost basis is captured at open, not reconstructed later: every disposal is
  // a taxable event and back-filling basis across hundreds of them is painful.
  const price = tokens > 0 ? a.entrySol / tokens : 0;

  const res = db.prepare(
    `INSERT INTO positions
       (mint, symbol, entry_sol, entry_tokens, entry_price, entry_fee_sol,
        opened_at, opened_sig, status, dry_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    a.mint, a.symbol, a.entrySol, tokens, price, a.entryFeeSol ?? 0,
    Date.now(), a.signature ?? null, a.dryRun ? 1 : 0,
  );
  return Number(res.lastInsertRowid);
}

export function listOpen(db: Db, dryRun: boolean): PositionRow[] {
  return db.prepare(
    `SELECT * FROM positions WHERE status = 'open' AND dry_run = ? ORDER BY opened_at ASC`,
  ).all(dryRun ? 1 : 0) as PositionRow[];
}

export function closePosition(
  db: Db,
  id: number,
  a: { reason: string; exitSol: number; exitTokens: string; signature?: string; entrySol: number },
): void {
  db.prepare(
    `UPDATE positions
        SET status = 'closed', exit_reason = ?, exit_sol = ?, exit_tokens = ?,
            closed_at = ?, closed_sig = ?, realized_pnl_sol = ?
      WHERE id = ?`,
  ).run(
    a.reason, a.exitSol, Number(a.exitTokens), Date.now(),
    a.signature ?? null, a.exitSol - a.entrySol, id,
  );
}

export function recordSellFailure(db: Db, id: number, err: string, maxAttempts: number): "retry" | "stuck" {
  const row = db.prepare(`SELECT sell_attempts FROM positions WHERE id = ?`).get(id) as
    | { sell_attempts: number } | undefined;
  const attempts = (row?.sell_attempts ?? 0) + 1;
  const stuck = attempts >= maxAttempts;

  db.prepare(
    `UPDATE positions SET sell_attempts = ?, last_error = ?, status = ? WHERE id = ?`,
  ).run(attempts, err.slice(0, 400), stuck ? "stuck" : "open", id);

  return stuck ? "stuck" : "retry";
}

/** Positions that exhausted their sell attempts and need a human. */
export function listStuck(db: Db): PositionRow[] {
  return db.prepare(`SELECT * FROM positions WHERE status = 'stuck'`).all() as PositionRow[];
}
