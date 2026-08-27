import type { Db } from "../util/db.ts";
import type { Config } from "../config/schema.ts";
import type { BudgetGuard } from "../risk/budget.ts";
import { listOpen, closePosition, recordSellFailure, type PositionRow } from "./store.ts";
import { valuePosition, sellAll } from "../chain/trade.ts";
import { log, errFields } from "../util/log.ts";

/**
 * Evaluates open dev positions against the configured exit rules.
 *
 * This runs regardless of the kill switch. Halting is meant to stop the bot
 * taking *new* risk; if it also froze exits, tripping the brake would strand
 * every open bag and turn the safety feature into the thing that loses the
 * money. The runner calls this on every tick, halted or not.
 */

export type ExitReason = "take_profit" | "stop_loss" | "max_hold";

export type ExitDecision =
  | { exit: false; multiple: number; ageMinutes: number }
  | { exit: true; reason: ExitReason; multiple: number; ageMinutes: number; detail: string };

/** Pure rule evaluation, so the thresholds are testable without a network. */
export function decideExit(
  multiple: number,
  ageMinutes: number,
  rules: Config["devPosition"]["exit"],
): ExitDecision {
  // Take profit first: if a position is simultaneously past its time limit and
  // in profit, realising the gain is the better read of operator intent.
  if (multiple >= rules.takeProfitMultiple) {
    return {
      exit: true, reason: "take_profit", multiple, ageMinutes,
      detail: `${multiple.toFixed(2)}x reached target ${rules.takeProfitMultiple}x`,
    };
  }

  const stopMultiple = 1 - rules.stopLossPct / 100;
  if (multiple <= stopMultiple) {
    return {
      exit: true, reason: "stop_loss", multiple, ageMinutes,
      detail: `${multiple.toFixed(2)}x breached stop at ${stopMultiple.toFixed(2)}x`,
    };
  }

  if (ageMinutes >= rules.maxHoldMinutes) {
    return {
      exit: true, reason: "max_hold", multiple, ageMinutes,
      detail: `held ${ageMinutes.toFixed(1)}min, limit ${rules.maxHoldMinutes}min`,
    };
  }

  return { exit: false, multiple, ageMinutes };
}

export type TickResult = {
  evaluated: number;
  closed: number;
  stuck: number;
  errors: number;
};

export async function evaluateOpenPositions(
  db: Db, cfg: Config, budget: BudgetGuard,
): Promise<TickResult> {
  const open = listOpen(db, cfg.dryRun);
  const result: TickResult = { evaluated: open.length, closed: 0, stuck: 0, errors: 0 };
  if (!open.length) return result;

  for (const pos of open) {
    try {
      const decision = await evaluateOne(db, cfg, pos);
      if (!decision) continue;

      const sold = await sellAll(cfg, pos.mint, cfg.devPosition.exit.sellSlippagePct);

      closePosition(db, pos.id, {
        reason: decision.reason,
        exitSol: sold.solReceived,
        exitTokens: sold.tokensSold,
        signature: sold.signature,
        entrySol: pos.entry_sol,
      });

      budget.record({
        kind: "dev_sell",
        solDelta: sold.solReceived,
        mint: pos.mint,
        signature: sold.signature,
        note: decision.reason,
        // The position's own dry_run, not the guard's mode -- an exit can
        // settle in a later process run than the open, under different config.
        dryRun: !!pos.dry_run,
      });

      result.closed++;
      log.info("position closed", {
        mint: pos.mint, symbol: pos.symbol, reason: decision.reason,
        entrySol: pos.entry_sol, exitSol: sold.solReceived,
        pnlSol: sold.solReceived - pos.entry_sol, detail: decision.detail,
      });
    } catch (e) {
      result.errors++;
      const outcome = recordSellFailure(
        db, pos.id, String(errFields(e).err), cfg.devPosition.exit.maxSellAttempts,
      );
      if (outcome === "stuck") {
        result.stuck++;
        log.error("position STUCK -- exhausted sell attempts, needs manual attention", {
          mint: pos.mint, symbol: pos.symbol, entrySol: pos.entry_sol, ...errFields(e),
        });
      } else {
        log.warn("position exit failed, will retry next tick", {
          mint: pos.mint, ...errFields(e),
        });
      }
    }
  }

  return result;
}

async function evaluateOne(
  db: Db, cfg: Config, pos: PositionRow,
): Promise<{ reason: ExitReason; detail: string } | undefined> {
  const ageMinutes = (Date.now() - pos.opened_at) / 60_000;

  // In dry run there is no on-chain position to value, so only the time-based
  // rule can be exercised. Simulating a price would just be inventing numbers.
  if (cfg.dryRun) {
    const d = decideExit(1, ageMinutes, cfg.devPosition.exit);
    return d.exit && d.reason === "max_hold" ? { reason: d.reason, detail: d.detail } : undefined;
  }

  const value = await valuePosition(cfg, pos.mint, pos.entry_sol);

  // The wallet no longer holds the token: nothing to exit, close the books.
  if (value.tokens === "0") {
    closePosition(db, pos.id, {
      reason: "no_balance", exitSol: 0, exitTokens: "0", entrySol: pos.entry_sol,
    });
    log.warn("position had no token balance, closed", { mint: pos.mint });
    return undefined;
  }

  const decision = decideExit(value.multiple, ageMinutes, cfg.devPosition.exit);
  if (!decision.exit) {
    log.debug("position held", {
      mint: pos.mint, multiple: value.multiple, ageMinutes, solIfSoldNow: value.solIfSoldNow,
    });
    return undefined;
  }
  return { reason: decision.reason, detail: decision.detail };
}
