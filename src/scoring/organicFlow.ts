import { washSuspicionScore } from "../research/classify.ts";

/**
 * Organic buy-side accumulation, gmgn.ai's "smart money" concept reimplemented
 * against aggregate DEX data cashcow already trusts (no wallet-level tracking,
 * no new vendor, no ToS risk).
 *
 * Read literally, "buys significantly exceed sells" sounds like a positive
 * signal -- but `src/research/classify.ts`'s DEFAULT_THRESHOLDS already treats
 * a lopsided buy/sell split as the fingerprint of an untested pump OR a
 * wash-trading bot (see its "HONEST CAVEAT" comment). So this is deliberately
 * a BOUNDED band, not a monotonic reward: a mid-range buy-share with real
 * liquidity behind it counts as organic accumulation; a near-100% buy share
 * does not score higher for it -- it is dampened the same way classify.ts
 * already distrusts that pattern. `washSuspicionScore` (tx count vs. reply
 * engagement) is reused as a hard zero-out, not reinvented.
 */

export type OrganicFlowInput = {
  buys24h: number;
  sells24h: number;
  liquidityUsd: number;
  txCount24h: number;
  replyCount: number;
};

export type OrganicFlowThresholds = {
  minLiquidityUsd: number;
  /** Inclusive band on buys as a percentage of 24h transactions. */
  minBuyShareForSignal: number;
  maxBuyShareForSignal: number;
  /** Reused directly against washSuspicionScore()'s output. */
  maxWashSuspicionScore: number;
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Buys as a percentage of 24h transactions, or null when there were none.
 * Mirrors classify.ts's buySharePct exactly (scale-before-divide, for the
 * same exact-boundary reason) but kept local: this module must stay
 * import-light and not couple its live path to the research module's I/O
 * surface beyond the one pure helper it deliberately reuses.
 */
function buySharePct(buys24h: number, sells24h: number): number | null {
  const total = buys24h + sells24h;
  if (total <= 0) return null;
  return (buys24h * 100) / total;
}

/**
 * 0..1. Zero below the liquidity floor, outside the buy-share band, or above
 * the wash-suspicion ceiling. Peaks at the CENTRE of the band (not at either
 * edge) so a candidate deep in wash-suspicious territory near the ceiling
 * scores no better than one barely past the floor -- this is a plateau/band
 * signal, not a ramp toward "more buys is always better."
 */
export function organicBuyPressure(input: OrganicFlowInput, t: OrganicFlowThresholds): number {
  if (input.liquidityUsd < t.minLiquidityUsd) return 0;

  // Only applied when replyCount > 0. Verified live against real
  // just-migrated tokens (2026-08-27): pump.fun's reply_count is chat
  // activity on the COIN'S OWN PUMP.FUN PAGE, which routinely reads 0 once
  // trading has moved to a DEX -- a token with $1.4M in real 24h DexScreener
  // liquidity and 43k real transactions showed reply_count: 0. Treating that
  // as "infinite wash suspicion" would zero out essentially every genuine
  // post-migration candidate, not just wash-shaped ones. So replyCount === 0
  // is UNKNOWN, not evidence -- same idiom as classify.ts's
  // top10ConcentrationPct === null: absence of data does not get treated as
  // the worst-case reading.
  if (input.replyCount > 0) {
    const suspicion = washSuspicionScore(input.txCount24h, input.replyCount);
    if (suspicion >= t.maxWashSuspicionScore) return 0;
  }

  const buyShare = buySharePct(input.buys24h, input.sells24h);
  if (buyShare === null) return 0;
  if (buyShare < t.minBuyShareForSignal || buyShare > t.maxBuyShareForSignal) return 0;

  // Triangular within the band: 0 at either edge, 1 at the midpoint. Being
  // solidly in the middle of "meaningfully more buys than sells, but not a
  // one-sided stampede" is the strongest reading of organic accumulation;
  // hugging either edge is the weakest evidence within the band.
  const mid = (t.minBuyShareForSignal + t.maxBuyShareForSignal) / 2;
  const halfWidth = (t.maxBuyShareForSignal - t.minBuyShareForSignal) / 2;
  if (halfWidth <= 0) return 1;
  const distance = Math.abs(buyShare - mid) / halfWidth;
  const bandScore = clamp01(1 - distance);

  // Liquidity confidence: more liquidity behind the imbalance is stronger
  // evidence it isn't a thin pool being nudged around. Saturates at 5x the
  // configured floor so a merely-adequate pool isn't penalised hard.
  const liquidityConfidence = clamp01(
    (input.liquidityUsd - t.minLiquidityUsd) / (4 * t.minLiquidityUsd || 1),
  );

  return clamp01(0.7 * bandScore + 0.3 * liquidityConfidence);
}
