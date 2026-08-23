import type { Db } from "../util/db.ts";
import type { Config } from "../config/schema.ts";
import { outcomeSummary } from "../learning/outcomes.ts";

/**
 * How many launches the wallet can actually sustain today.
 *
 * A fixed `maxLaunchesPerDay` is wrong in both directions at once: too low for
 * a funded wallet that could afford more attempts at a power-law payoff, and
 * far too high for one that has been ground down. This derives the cap from
 * three things instead:
 *
 *   1. **Runway.** Spendable balance divided by the days it must survive. This
 *      is the single constraint that makes "burning out the wallet"
 *      structurally impossible rather than merely unlikely.
 *   2. **Cost per attempt.** Creation cost plus the dev buy plus worst-case
 *      priority fee. Note the dev buy usually DOMINATES: at the defaults it is
 *      0.05 SOL against ~0.026 for everything else, so halving the dev buy buys
 *      roughly twice the attempts for the same burn.
 *   3. **Recent performance.** If settled launches are mostly duds, capacity is
 *      cut. Launching more often while losing is how a wallet dies, and no
 *      static cap notices that it is happening.
 *
 * Capacity can only ever be LOWER than the configured static ceilings. This
 * function cannot authorise spending beyond `risk.maxSolPerDay`.
 */

export type Capacity = {
  launchesPerDay: number;
  solPerDay: number;
  costPerLaunchSol: number;
  /** Which constraint is actually limiting, in plain words. */
  binding: string;
  adaptive: boolean;
  detail: {
    walletBalanceSol?: number;
    spendableSol?: number;
    runwayBudgetSol?: number;
    burnBudgetSol?: number;
    staticCeilingSol: number;
    throttled: boolean;
    throttleReason?: string;
  };
};

/** Estimated high: the budget guard should never be surprised by a cost. */
export function costPerLaunch(cfg: Config): number {
  const devBuy = cfg.devPosition.enabled ? cfg.devPosition.buySol : 0;
  const priority =
    (cfg.rpc.priorityFee.maxMicroLamports * cfg.rpc.priorityFee.computeUnitLimit) / 1e6 / 1e9;
  return cfg.launch.estimatedCreateCostSol + devBuy + priority + 0.001;
}

export function computeCapacity(
  db: Db,
  cfg: Config,
  walletBalanceSol?: number,
): Capacity {
  const perLaunch = costPerLaunch(cfg);
  const a = cfg.risk.adaptive;

  if (!a.enabled) {
    return {
      launchesPerDay: cfg.risk.maxLaunchesPerDay,
      solPerDay: cfg.risk.maxSolPerDay,
      costPerLaunchSol: perLaunch,
      binding: `static cap: ${cfg.risk.maxLaunchesPerDay} launches/day`,
      adaptive: false,
      detail: { staticCeilingSol: cfg.risk.maxSolPerDay, throttled: false },
    };
  }

  // Without a known balance, adaptive mode cannot reason about runway. Fall back
  // to the static cap rather than guessing — guessing here spends real money.
  if (walletBalanceSol === undefined) {
    return {
      launchesPerDay: cfg.risk.maxLaunchesPerDay,
      solPerDay: cfg.risk.maxSolPerDay,
      costPerLaunchSol: perLaunch,
      binding: "wallet balance unknown; falling back to the static cap",
      adaptive: true,
      detail: { staticCeilingSol: cfg.risk.maxSolPerDay, throttled: false },
    };
  }

  const spendable = Math.max(0, walletBalanceSol - a.reserveSol);
  const runwayBudget = spendable / a.minRunwayDays;
  const burnBudget = spendable * a.maxDailyBurnPct;

  // The static ceiling remains an absolute maximum.
  let solPerDay = Math.min(runwayBudget, burnBudget, cfg.risk.maxSolPerDay);

  let binding: string;
  if (solPerDay === cfg.risk.maxSolPerDay) {
    binding = `static ceiling risk.maxSolPerDay (${cfg.risk.maxSolPerDay} SOL)`;
  } else if (runwayBudget <= burnBudget) {
    binding = `${a.minRunwayDays}-day runway on ${spendable.toFixed(3)} SOL spendable`;
  } else {
    binding = `${(a.maxDailyBurnPct * 100).toFixed(0)}% daily burn cap`;
  }

  // Performance throttle.
  let throttled = false;
  let throttleReason: string | undefined;

  if (a.throttleOnLoss) {
    const o = outcomeSummary(db, cfg);
    const losing = o.realisedPnlSol < 0;
    const coldHitRate = o.settled >= 10 && (o.hitRate ?? 1) < a.minHitRateBeforeThrottle;

    if (losing || coldHitRate) {
      solPerDay *= a.lossThrottleFactor;
      throttled = true;
      throttleReason = losing
        ? `realised P&L is ${o.realisedPnlSol.toFixed(4)} SOL; capacity cut to ` +
          `${(a.lossThrottleFactor * 100).toFixed(0)}%`
        : `hit rate ${((o.hitRate ?? 0) * 100).toFixed(1)}% over ${o.settled} settled launches ` +
          `is below ${(a.minHitRateBeforeThrottle * 100).toFixed(0)}%; capacity cut`;
      binding = throttleReason;
    }
  }

  const launches = Math.min(
    a.maxLaunchesPerDayCeiling,
    Math.max(0, Math.floor(solPerDay / perLaunch)),
  );

  if (launches === a.maxLaunchesPerDayCeiling) {
    binding = `ceiling risk.adaptive.maxLaunchesPerDayCeiling (${a.maxLaunchesPerDayCeiling})`;
  }

  return {
    launchesPerDay: launches,
    solPerDay,
    costPerLaunchSol: perLaunch,
    binding,
    adaptive: true,
    detail: {
      walletBalanceSol,
      spendableSol: spendable,
      runwayBudgetSol: runwayBudget,
      burnBudgetSol: burnBudget,
      staticCeilingSol: cfg.risk.maxSolPerDay,
      throttled,
      throttleReason,
    },
  };
}

/**
 * What the wallet would need to sustain a given launch rate. Answers the
 * operator's real question -- "what does N launches a day cost me?" -- without
 * requiring them to work backwards through the arithmetic.
 */
export function balanceNeededFor(cfg: Config, launchesPerDay: number): number {
  const a = cfg.risk.adaptive;
  const dailySpend = launchesPerDay * costPerLaunch(cfg);
  // Invert whichever constraint binds first.
  const fromRunway = dailySpend * a.minRunwayDays;
  const fromBurn = dailySpend / a.maxDailyBurnPct;
  return Math.max(fromRunway, fromBurn) + a.reserveSol;
}
