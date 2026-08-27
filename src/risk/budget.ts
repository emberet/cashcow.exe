import type { Db } from "../util/db.ts";
import type { Config } from "../config/schema.ts";
import { log } from "../util/log.ts";
import type { Capacity } from "./capacity.ts";
import { isPretend } from "../config/schema.ts";

/**
 * The single choke point for anything that costs SOL.
 *
 * Every chain call routes through `assertCanSpend` before it builds a
 * transaction, and records the actual outcome afterwards. If a code path can
 * spend SOL without touching this module, that is a bug -- it is the only thing
 * standing between a bug in the trend loop and an empty wallet.
 *
 * Windows are rolling 24h, not calendar days, so a bot restarted at 23:59
 * cannot double its budget by crossing midnight.
 */

export type SpendKind =
  | "launch"      // token creation: rent + protocol fee
  | "dev_buy"
  | "dev_sell"    // inflow, positive delta
  | "fee_claim"   // inflow, positive delta
  | "tx_fee";     // base + priority fees

export type SpendRecord = {
  kind: SpendKind;
  solDelta: number;
  mint?: string;
  signature?: string;
  note?: string;
  /**
   * Which ledger this settles against. Defaults to the guard's own mode
   * (the config this process started with), which is correct for spend that
   * originates and settles within one tick -- a launch and its dev_buy.
   *
   * A position's exit can land in a different process run than its open, so
   * it must carry the position's OWN dry_run forward rather than inherit
   * whatever config happens to be active when the sell settles. Passing it
   * explicitly here is what keeps the two in sync.
   */
  dryRun?: boolean;
};

export type Decision =
  | { ok: true }
  | { ok: false; reason: string; code: DenyCode };

export type DenyCode =
  | "HALTED"
  | "DAILY_LAUNCH_CAP"
  | "DAILY_SOL_CAP"
  | "CONCURRENT_POSITIONS"
  | "WALLET_FLOOR"
  | "DAILY_LOSS_CAP";

const DAY_MS = 24 * 60 * 60 * 1000;

export class BudgetGuard {
  readonly #db: Db;
  readonly #cfg: Config;
  /** Dry-run and live rows are counted separately so a simulation exercises the
   *  caps realistically without contaminating live accounting. */
  readonly #mode: 0 | 1;
  /** Adaptive limits, when enabled. Never permitted to exceed the static ones. */
  #capacity: Capacity | undefined;

  constructor(db: Db, cfg: Config) {
    this.#db = db;
    this.#cfg = cfg;
    this.#mode = isPretend(cfg) ? 1 : 0;
  }

  /**
   * Install wallet-derived limits for this tick.
   *
   * Defensive by construction: whatever is passed in, the effective limit is
   * the MINIMUM of it and the configured static ceiling. Adaptive capacity can
   * only ever tighten, never loosen, so a bug in the capacity maths cannot
   * authorise spending past `risk.maxSolPerDay`.
   */
  setCapacity(cap: Capacity | undefined): void {
    this.#capacity = cap;
  }

  get effectiveMaxLaunchesPerDay(): number {
    // computeCapacity() already returns the static value when adaptive is off,
    // and has already clamped against every ceiling when it is on.
    return this.#capacity?.launchesPerDay ?? this.#cfg.risk.maxLaunchesPerDay;
  }

  get effectiveMaxSolPerDay(): number {
    // Belt and braces: re-clamp against the static ceiling here too, so a bug
    // in the capacity maths still cannot authorise spending past it.
    const configured = this.#cfg.risk.maxSolPerDay;
    return this.#capacity ? Math.min(this.#capacity.solPerDay, configured) : configured;
  }

  #since(): number {
    return Date.now() - DAY_MS;
  }

  /** Total SOL paid out in the rolling window (positive number). */
  solSpentLast24h(): number {
    const row = this.#db.prepare(
      `SELECT COALESCE(SUM(-sol_delta), 0) AS out
         FROM spend_ledger
        WHERE ts > ? AND dry_run = ? AND sol_delta < 0`,
    ).get(this.#since(), this.#mode) as { out: number };
    return row.out;
  }

  launchesLast24h(): number {
    const row = this.#db.prepare(
      `SELECT COUNT(*) AS n FROM spend_ledger
        WHERE ts > ? AND dry_run = ? AND kind = 'launch'`,
    ).get(this.#since(), this.#mode) as { n: number };
    return row.n;
  }

  /** Net realised loss on dev positions in the window (positive = down money). */
  realizedLossLast24h(): number {
    const row = this.#db.prepare(
      `SELECT COALESCE(SUM(sol_delta), 0) AS net
         FROM spend_ledger
        WHERE ts > ? AND dry_run = ?
          AND kind IN ('launch', 'dev_buy', 'dev_sell', 'tx_fee')`,
    ).get(this.#since(), this.#mode) as { net: number };
    return row.net < 0 ? -row.net : 0;
  }

  openPositionCount(): number {
    const row = this.#db.prepare(
      `SELECT COUNT(*) AS n FROM positions WHERE status = 'open' AND dry_run = ?`,
    ).get(this.#mode) as { n: number };
    return row.n;
  }

  /**
   * Ask permission before building a transaction.
   *
   * @param estimatedCostSol  Everything the action will cost: rent, dev buy,
   *                          protocol fee and priority fee. Estimate high.
   * @param opts.isLaunch     Counts against the daily launch cap.
   * @param opts.walletBalanceSol  Current on-chain balance, if known.
   */
  canSpend(
    estimatedCostSol: number,
    opts: { isLaunch?: boolean; walletBalanceSol?: number; opensPosition?: boolean } = {},
  ): Decision {
    const r = this.#cfg.risk;

    const maxLaunches = this.effectiveMaxLaunchesPerDay;
    const maxSol = this.effectiveMaxSolPerDay;

    if (opts.isLaunch) {
      const launches = this.launchesLast24h();
      if (launches >= maxLaunches) {
        return deny("DAILY_LAUNCH_CAP",
          `${launches}/${maxLaunches} launches used in the last 24h` +
          (this.#capacity?.adaptive ? ` (adaptive: ${this.#capacity.binding})` : ""));
      }
    }

    const spent = this.solSpentLast24h();
    if (spent + estimatedCostSol > maxSol) {
      return deny("DAILY_SOL_CAP",
        `${spent.toFixed(4)} SOL spent in 24h; this action costs ~${estimatedCostSol.toFixed(4)} ` +
        `and the ceiling is ${maxSol.toFixed(4)} SOL` +
        (this.#capacity?.adaptive ? ` (adaptive: ${this.#capacity.binding})` : ""));
    }

    const loss = this.realizedLossLast24h();
    if (loss >= r.maxDailyLossSol) {
      return deny("DAILY_LOSS_CAP",
        `realised loss ${loss.toFixed(4)} SOL has reached the ${r.maxDailyLossSol} SOL circuit breaker`);
    }

    if (opts.opensPosition) {
      const open = this.openPositionCount();
      if (open >= r.maxConcurrentPositions) {
        return deny("CONCURRENT_POSITIONS",
          `${open}/${r.maxConcurrentPositions} positions already open`);
      }
    }

    if (opts.walletBalanceSol !== undefined) {
      const after = opts.walletBalanceSol - estimatedCostSol;
      if (after < r.minWalletBalanceSol) {
        return deny("WALLET_FLOOR",
          `balance would fall to ${after.toFixed(4)} SOL, below the ` +
          `${r.minWalletBalanceSol} SOL floor reserved for exit transactions`);
      }
    }

    return { ok: true };
  }

  assertCanSpend(
    estimatedCostSol: number,
    opts: { isLaunch?: boolean; walletBalanceSol?: number; opensPosition?: boolean } = {},
  ): void {
    const d = this.canSpend(estimatedCostSol, opts);
    if (!d.ok) throw new BudgetDenied(d.reason, d.code);
  }

  /** Append the actual outcome. Call after the transaction settles, win or lose. */
  record(rec: SpendRecord): void {
    const mode = rec.dryRun === undefined ? this.#mode : (rec.dryRun ? 1 : 0);
    this.#db.prepare(
      `INSERT INTO spend_ledger (ts, kind, mint, sol_delta, signature, dry_run, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      Date.now(), rec.kind, rec.mint ?? null, rec.solDelta,
      rec.signature ?? null, mode, rec.note ?? null,
    );
    log.debug("ledger", { kind: rec.kind, solDelta: rec.solDelta, mint: rec.mint });
  }

  summary(): {
    windowHours: number; launches: number; maxLaunches: number;
    solSpent: number; maxSol: number; realizedLoss: number; maxLoss: number;
    openPositions: number; maxPositions: number; dryRun: boolean;
    adaptive: boolean; binding: string;
  } {
    const r = this.#cfg.risk;
    return {
      windowHours: 24,
      launches: this.launchesLast24h(), maxLaunches: this.effectiveMaxLaunchesPerDay,
      solSpent: this.solSpentLast24h(), maxSol: this.effectiveMaxSolPerDay,
      realizedLoss: this.realizedLossLast24h(), maxLoss: r.maxDailyLossSol,
      openPositions: this.openPositionCount(), maxPositions: r.maxConcurrentPositions,
      dryRun: this.#cfg.dryRun,
      adaptive: this.#capacity?.adaptive ?? false,
      binding: this.#capacity?.binding ?? `static cap: ${r.maxLaunchesPerDay} launches/day`,
    };
  }

  /**
   * Non-SOL metered spend, e.g. the X API billed per read in USD.
   * Returns false when the period cap is already reached.
   */
  meterCharge(key: string, amountUsd: number, capUsd: number): boolean {
    const period = new Date().toISOString().slice(0, 7); // YYYY-MM
    const row = this.#db.prepare(
      `SELECT amount FROM meter WHERE key = ? AND period = ?`,
    ).get(key, period) as { amount: number } | undefined;
    const used = row?.amount ?? 0;
    if (used + amountUsd > capUsd) return false;

    this.#db.prepare(
      `INSERT INTO meter (key, period, amount) VALUES (?, ?, ?)
       ON CONFLICT(key, period) DO UPDATE SET amount = amount + excluded.amount`,
    ).run(key, period, amountUsd);
    return true;
  }

  meterUsed(key: string): number {
    const period = new Date().toISOString().slice(0, 7);
    const row = this.#db.prepare(
      `SELECT amount FROM meter WHERE key = ? AND period = ?`,
    ).get(key, period) as { amount: number } | undefined;
    return row?.amount ?? 0;
  }
}

export class BudgetDenied extends Error {
  readonly code: DenyCode;
  constructor(reason: string, code: DenyCode) {
    super(`Budget denied (${code}): ${reason}`);
    this.name = "BudgetDenied";
    this.code = code;
  }
}

function deny(code: DenyCode, reason: string): Decision {
  return { ok: false, reason, code };
}
