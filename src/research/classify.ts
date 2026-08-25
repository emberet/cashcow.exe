/**
 * Pure classification math for the historical-launch research pass. No I/O --
 * everything here takes numbers already fetched by `pumpSample.ts`,
 * `volume.ts` and `holders.ts`, so it is unit-testable without a network.
 *
 * These thresholds are the most arguable numbers in the whole design. The
 * caller is expected to re-derive `maxWashSuspicionPercentile`'s effect from
 * the ACTUAL collected sample (via `percentileRank`) rather than trust a
 * fixed cutoff for the ratio itself, which is why that's a percentile-based
 * bound and not a magic number.
 */

export type ClassifyInput = {
  isBanned: boolean;
  athMarketCapUsd: number;
  /**
   * null when the RPC read failed. Verified live against the free public
   * mainnet RPC: `getTokenLargestAccounts` fails consistently there, not
   * intermittently -- treating "unknown" the same as "100% concentrated"
   * would silently reject an entire sample run on the default config. So
   * unknown does NOT reject; it is surfaced as a caveat instead, and it is
   * the caller's job to get a dedicated RPC (`--rpc`) if this matters.
   */
  top10ConcentrationPct: number | null;
  txCount24h: number;
  replyCount: number;
  /** This candidate's wash-suspicion percentile (0-1) within the collected sample. */
  washSuspicionPercentile: number;
};

export type ClassifyThresholds = {
  minAthMarketCapUsd: number;
  maxConcentrationPct: number;
  maxWashSuspicionPercentile: number;
  washAbsoluteTxCount: number;
  washAbsoluteMinReplies: number;
};

export const DEFAULT_THRESHOLDS: ClassifyThresholds = {
  minAthMarketCapUsd: 500_000,
  maxConcentrationPct: 60,
  maxWashSuspicionPercentile: 0.75, // exclude the top quartile of the sample
  washAbsoluteTxCount: 500,
  washAbsoluteMinReplies: 20,
};

export type ClassifyResult = {
  clean: boolean;
  /** Empty when clean; otherwise every reason it was rejected, not just the first. */
  reasons: string[];
  /** Non-disqualifying notices -- things the human should double check themselves. */
  caveats: string[];
};

export function classifyLaunch(input: ClassifyInput, t: ClassifyThresholds): ClassifyResult {
  const reasons: string[] = [];
  const caveats: string[] = [];

  if (input.isBanned) reasons.push("banned by pump.fun");

  if (input.athMarketCapUsd < t.minAthMarketCapUsd) {
    reasons.push(
      `ATH market cap $${Math.round(input.athMarketCapUsd).toLocaleString()} below the ` +
      `$${t.minAthMarketCapUsd.toLocaleString()} activity floor`,
    );
  }

  if (input.top10ConcentrationPct === null) {
    caveats.push("holder concentration unknown -- verify manually before trusting this one");
  } else if (input.top10ConcentrationPct >= t.maxConcentrationPct) {
    reasons.push(
      `top-10 holder concentration ${input.top10ConcentrationPct.toFixed(1)}% >= ` +
      `${t.maxConcentrationPct}%`,
    );
  }

  const washExtreme =
    input.txCount24h > t.washAbsoluteTxCount && input.replyCount < t.washAbsoluteMinReplies;
  if (washExtreme) {
    reasons.push(
      `wash-trading-shaped: ${input.txCount24h} txns/24h against only ${input.replyCount} replies`,
    );
  }

  if (input.washSuspicionPercentile >= t.maxWashSuspicionPercentile) {
    reasons.push(
      `wash-suspicion percentile ${(input.washSuspicionPercentile * 100).toFixed(0)} is in the ` +
      `top quartile of this sample`,
    );
  }

  return { clean: reasons.length === 0, reasons, caveats };
}

/** Higher = more wash-trading-shaped: lots of trades relative to organic reply engagement. */
export function washSuspicionScore(txCount24h: number, replyCount: number): number {
  return txCount24h / Math.max(1, replyCount);
}

/**
 * Fraction of `sample` strictly below `value`, i.e. this value's percentile
 * rank (0-1) within the sample it actually came from -- not against a fixed
 * assumption about what a "normal" ratio looks like.
 */
export function percentileRank(value: number, sample: number[]): number {
  if (sample.length === 0) return 0;
  const below = sample.filter((v) => v < value).length;
  return below / sample.length;
}
