import type { Db } from "../util/db.ts";
import type { Config } from "../config/schema.ts";
import type { BudgetGuard } from "../risk/budget.ts";
import { sellAll } from "../chain/trade.ts";
import { claimCreatorFees } from "../chain/fees.ts";
import { closePosition, recordSellFailure } from "../positions/store.ts";
import { log, errFields } from "../util/log.ts";

/**
 * Admin actions that cost money.
 *
 * The web process enqueues; the bot process executes. That separation is the
 * whole point: the dev wallet key is loaded in exactly one process, so no
 * request handler -- and no bug in one -- can ever sign a transaction. The
 * worst a compromised web layer can do is queue work that the bot then runs
 * under its own budget guard and kill switch.
 *
 * The trade-off is latency: a queued action waits for the next bot tick rather
 * than firing instantly. For force-sell that is bounded by
 * `devPosition.exit.pollSeconds`, which defaults to 15 seconds.
 */

export type CommandKind = "sell_position" | "sell_all_positions" | "claim_fees";

export const COMMAND_KINDS: CommandKind[] = [
  "sell_position",
  "sell_all_positions",
  "claim_fees",
];

export function enqueue(
  db: Db, kind: CommandKind, payload: Record<string, unknown>, requestedBy: string,
): number {
  const res = db.prepare(
    `INSERT INTO commands (kind, payload, requested_at, requested_by, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(kind, JSON.stringify(payload), Date.now(), requestedBy);

  log.info("admin command queued", { kind, payload, requestedBy });
  return Number(res.lastInsertRowid);
}

export function pendingCount(db: Db): number {
  return (db.prepare(
    `SELECT COUNT(*) n FROM commands WHERE status = 'pending'`,
  ).get() as { n: number }).n;
}

type CommandRow = { id: number; kind: string; payload: string | null };

/**
 * Drain the queue. Called by the bot on each position tick.
 *
 * Every command runs through the same budget guard as autonomous activity --
 * an admin can force an exit, but cannot spend past the configured ceilings.
 */
export async function consumeCommands(
  db: Db, cfg: Config, budget: BudgetGuard,
): Promise<number> {
  const rows = db.prepare(
    `SELECT id, kind, payload FROM commands WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 20`,
  ).all() as CommandRow[];

  if (!rows.length) return 0;

  for (const row of rows) {
    db.prepare(`UPDATE commands SET status = 'running', started_at = ? WHERE id = ?`)
      .run(Date.now(), row.id);

    try {
      const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : {};
      const result = await execute(db, cfg, budget, row.kind as CommandKind, payload);
      db.prepare(
        `UPDATE commands SET status = 'done', finished_at = ?, result = ? WHERE id = ?`,
      ).run(Date.now(), result.slice(0, 500), row.id);
      log.info("admin command completed", { id: row.id, kind: row.kind, result });
    } catch (e) {
      const msg = String(errFields(e).err).slice(0, 500);
      db.prepare(
        `UPDATE commands SET status = 'failed', finished_at = ?, error = ? WHERE id = ?`,
      ).run(Date.now(), msg, row.id);
      log.error("admin command failed", { id: row.id, kind: row.kind, ...errFields(e) });
    }
  }

  return rows.length;
}

async function execute(
  db: Db, cfg: Config, budget: BudgetGuard, kind: CommandKind, payload: Record<string, unknown>,
): Promise<string> {
  switch (kind) {
    case "sell_position": {
      const id = Number(payload.positionId);
      if (!Number.isInteger(id)) throw new Error("sell_position requires a numeric positionId");
      return sellOne(db, cfg, budget, id);
    }

    case "sell_all_positions": {
      const open = db.prepare(
        `SELECT id FROM positions WHERE status = 'open' AND dry_run = ?`,
      ).all(cfg.dryRun ? 1 : 0) as Array<{ id: number }>;

      const outcomes: string[] = [];
      for (const p of open) {
        try {
          outcomes.push(await sellOne(db, cfg, budget, p.id));
        } catch (e) {
          outcomes.push(`#${p.id} failed: ${String(errFields(e).err).slice(0, 80)}`);
        }
      }
      return outcomes.length ? outcomes.join("; ") : "no open positions";
    }

    case "claim_fees": {
      const res = await claimCreatorFees(cfg);
      if (res.skipped) return `skipped: ${res.skipped}`;

      if (res.claimedSol > 0) {
        db.prepare(
          `INSERT INTO fee_claims (ts, sol_amount, signature, dry_run) VALUES (?, ?, ?, ?)`,
        ).run(Date.now(), res.claimedSol, res.signature ?? null, cfg.dryRun ? 1 : 0);
        budget.record({
          kind: "fee_claim", solDelta: res.claimedSol,
          signature: res.signature, note: "manual claim",
        });
      }
      return `claimed ${res.claimedSol.toFixed(6)} SOL`;
    }

    default:
      throw new Error(`unknown command kind: ${kind}`);
  }
}

async function sellOne(
  db: Db, cfg: Config, budget: BudgetGuard, id: number,
): Promise<string> {
  const pos = db.prepare(
    `SELECT id, mint, symbol, entry_sol, status, dry_run FROM positions WHERE id = ?`,
  ).get(id) as
    | { id: number; mint: string; symbol: string | null; entry_sol: number; status: string; dry_run: number }
    | undefined;

  if (!pos) throw new Error(`position ${id} not found`);
  if (pos.status === "closed") return `#${id} already closed`;

  try {
    const sold = await sellAll(cfg, pos.mint, cfg.devPosition.exit.sellSlippagePct);

    closePosition(db, pos.id, {
      reason: "manual",
      exitSol: sold.solReceived,
      exitTokens: sold.tokensSold,
      signature: sold.signature,
      entrySol: pos.entry_sol,
    });

    budget.record({
      kind: "dev_sell", solDelta: sold.solReceived,
      mint: pos.mint, signature: sold.signature, note: "manual sell",
      // Same reasoning as the autonomous exit path: track the position's own
      // dry_run, not whatever config this admin command happens to run under.
      dryRun: !!pos.dry_run,
    });

    return `#${id} ${pos.symbol ?? pos.mint.slice(0, 8)} sold for ${sold.solReceived.toFixed(6)} SOL`;
  } catch (e) {
    recordSellFailure(db, pos.id, String(errFields(e).err), cfg.devPosition.exit.maxSellAttempts);
    throw e;
  }
}
