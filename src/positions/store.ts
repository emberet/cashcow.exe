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
  status: "open" | "closed" | "stuck" | "abandoned";
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

/**
 * SOL already recovered for this mint according to the spend ledger.
 *
 * A zero token balance is ambiguous, and the difference is worth real money:
 * either the wallet never received the tokens (a genuine total loss), or the
 * sell ALREADY LANDED and this is a retry looking at the aftermath. The second
 * is the common one -- a sell whose confirmation times out with "block height
 * exceeded" has not necessarily failed, and when it did land, the next attempt
 * sees NotEnoughTokensToSell and then an empty balance.
 *
 * The ledger is the authority here, not the balance: every real sale records a
 * measured `dev_sell` row through the same single choke point that invariant 1
 * puts on spending. If a row exists for this mint after the position opened,
 * that money came back and the position must not be written off.
 *
 * Scoped by `dry_run` so the pretend ledger can never pay off a real position.
 */
export function recoveredSolFromLedger(
  db: Db, mint: string, sinceTs: number, dryRun: number,
): { sol: number; signature: string | null } {
  const row = db.prepare(
    `SELECT COALESCE(SUM(sol_delta), 0) AS sol,
            MAX(signature)              AS signature
       FROM spend_ledger
      WHERE kind = 'dev_sell' AND mint = ? AND ts >= ? AND dry_run = ?`,
  ).get(mint, sinceTs, dryRun) as { sol: number; signature: string | null };

  return { sol: row.sol ?? 0, signature: row.signature ?? null };
}

/**
 * Retire a position that has no outcome and never will.
 *
 * Pretend positions are stranded whenever the bot changes mode: everything
 * that services exits reads `listOpen(db, dryRun)` for the CURRENT mode, so a
 * simulate session's open positions are never looked at again once the bot is
 * running for real. Five sat open for two days with `sell_attempts = 0` --
 * nothing had tried, because nothing was looking.
 *
 * Deliberately NOT `closePosition(..., exitSol: 0)`. That computes a P&L of
 * `-entry_sol` and would have invented a 0.25 SOL loss across those five,
 * which is precisely the mistake DECISIONS #39 was about. There is no outcome
 * here: no sale, no measured proceeds, nothing to report. `realized_pnl_sol`
 * stays NULL and the row leaves both the open count and every P&L aggregate,
 * since those filter on `status = 'open'` and `status = 'closed'` respectively.
 */
export function abandonPosition(db: Db, id: number, note: string): void {
  db.prepare(
    `UPDATE positions
        SET status = 'abandoned', exit_reason = 'abandoned', closed_at = ?,
            last_error = ?
      WHERE id = ? AND status = 'open'`,
  ).run(Date.now(), note.slice(0, 400), id);
}

/** Open positions belonging to the mode the bot is NOT running in. */
export function listOrphanedByMode(db: Db, currentDryRun: boolean): PositionRow[] {
  return db.prepare(
    `SELECT * FROM positions WHERE status = 'open' AND dry_run = ? ORDER BY opened_at`,
  ).all(currentDryRun ? 0 : 1) as PositionRow[];
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
