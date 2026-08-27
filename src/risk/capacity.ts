import type { Db } from "../util/db.ts";
import { isPretend, type Config } from "../config/schema.ts";
import { outcomeSummary } from "../learning/outcomes.ts";
import { effectiveRisk } from "./experimentalWindow.ts";

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
    newsVolume?: {
      throttled: boolean;
      scoredCount: number;
      scale: number;
      lookbackHours: number;
    };
  };
};

/**
 * Pure scaling function for the news-volume confidence throttle: a linear
 * ramp from `minScale` (at or below the low bracket) to 1.0 (at or above the
 * high bracket). Never returns more than 1.0, so it can only ever narrow the
 * day's allowance, never widen it.
 */
export function newsVolumeScale(
  scoredCount: number,
  t: { lowVolumeScoredCount: number; highVolumeScoredCount: number; minScale: number },
): number {
  const hiSafe = Math.max(t.highVolumeScoredCount, t.lowVolumeScoredCount + 1);
  if (scoredCount <= t.lowVolumeScoredCount) return t.minScale;
  if (scoredCount >= hiSafe) return 1;
  const ratio = (scoredCount - t.lowVolumeScoredCount) / (hiSafe - t.lowVolumeScoredCount);
  return t.minScale + ratio * (1 - t.minScale);
}

function qualifyingSignalCount(db: Db, cfg: Config, hours: number): number {
  const since = Date.now() - hours * 3600_000;
  const row = db.prepare(
    `SELECT COALESCE(SUM(scored), 0) AS n FROM pipeline_stats WHERE dry_run = ? AND ts > ?`,
  ).get(isPretend(cfg) ? 1 : 0, since) as { n: number };
  return row.n;
}

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
  // Reads through the 24h experimental window (src/risk/experimentalWindow.ts)
  // when one is active; identical to cfg.risk otherwise. This IS "the static
  // ceiling" everything below clamps against -- computing capacity from the
  // un-windowed cfg.risk here would silently defeat the window, because
  // BudgetGuard.setCapacity() re-clamps to min(capacity, effectiveRisk) on
  // every spend check.
  const risk = effectiveRisk(db, cfg);

  if (!a.enabled) {
    return {
      launchesPerDay: risk.maxLaunchesPerDay,
      solPerDay: risk.maxSolPerDay,
      costPerLaunchSol: perLaunch,
      binding: `static cap: ${risk.maxLaunchesPerDay} launches/day`,
      adaptive: false,
      detail: { staticCeilingSol: risk.maxSolPerDay, throttled: false },
    };
  }

  // Without a known balance, adaptive mode cannot reason about runway. Fall back
  // to the static cap rather than guessing — guessing here spends real money.
  if (walletBalanceSol === undefined) {
    return {
      launchesPerDay: risk.maxLaunchesPerDay,
      solPerDay: risk.maxSolPerDay,
      costPerLaunchSol: perLaunch,
      binding: "wallet balance unknown; falling back to the static cap",
      adaptive: true,
      detail: { staticCeilingSol: risk.maxSolPerDay, throttled: false },
    };
  }

  const spendable = Math.max(0, walletBalanceSol - a.reserveSol);
  const runwayBudget = spendable / a.minRunwayDays;
  const burnBudget = spendable * a.maxDailyBurnPct;

  // The static (possibly windowed) ceiling remains an absolute maximum.
  let solPerDay = Math.min(runwayBudget, burnBudget, risk.maxSolPerDay);

  let binding: string;
  if (solPerDay === risk.maxSolPerDay) {
    binding = `static ceiling risk.maxSolPerDay (${risk.maxSolPerDay} SOL)`;
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

  // News-volume confidence throttle. Applied after every other constraint, so
  // it only ever narrows what those already allowed -- never widens it.
  const preNewsSolPerDay = solPerDay;
  let newsVolume: Capacity["detail"]["newsVolume"];

  if (a.newsVolumeThrottle.enabled) {
    const t = a.newsVolumeThrottle;
    const scoredCount = qualifyingSignalCount(db, cfg, t.lookbackHours);
    const scale = newsVolumeScale(scoredCount, t);
    newsVolume = { throttled: scale < 1, scoredCount, scale, lookbackHours: t.lookbackHours };

    if (scale < 1) {
      solPerDay = preNewsSolPerDay * scale;
      // Deliberately does not touch the loss-throttle `throttled`/`throttleReason`
      // pair above -- the CLI reads `detail.newsVolume` for this constraint
      // specifically, so the two throttles' reasons never clobber each other.
      binding =
        `thin qualifying signal: ${scoredCount} candidate(s) cleared threshold in the last ` +
        `${t.lookbackHours}h (need ${t.highVolumeScoredCount}+ for the full allowance); ` +
        `scaled to ${(scale * 100).toFixed(0)}%`;
    }
  }

  const rawLaunches = Math.max(0, Math.floor(solPerDay / perLaunch));
  const preNewsLaunches = Math.max(0, Math.floor(preNewsSolPerDay / perLaunch));
  const launchFloor = a.newsVolumeThrottle.enabled
    ? Math.min(a.newsVolumeThrottle.floorLaunchesPerDay, preNewsLaunches)
    : 0;

  if (launchFloor > rawLaunches) {
    // Restore just enough SOL to afford the floor -- but never more than
    // runway/burn/static/loss-throttle already permitted before the news
    // scale, so this can only undo THIS feature's own reduction.
    solPerDay = Math.min(preNewsSolPerDay, launchFloor * perLaunch);
  }

  const launches = Math.min(
    a.maxLaunchesPerDayCeiling,
    Math.max(launchFloor, Math.max(0, Math.floor(solPerDay / perLaunch))),
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
      staticCeilingSol: risk.maxSolPerDay,
      throttled,
      throttleReason,
      newsVolume,
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
