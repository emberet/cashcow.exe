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

import type { OgStatus } from "./ogCheck.ts";

export type ClassifyInput = {
  isBanned: boolean;
  /**
   * DexScreener's 24h volume for the token's highest-liquidity Solana pair.
   * This, not `athMarketCapUsd`, is now the activity gate: ATH market cap is a
   * historical high-water mark that a long-dead token keeps forever, whereas
   * 24h volume is the only field either API exposes that says the token is
   * being traded *right now*. 0 when no pair was found, which fails the gate.
   */
  volume24hUsd: number;
  /** Reported for context in the survivor listing; no longer a gate. */
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
  /** The 24h buy/sell split behind `txCount24h`. Both 0 when no pair was found. */
  buys24h: number;
  sells24h: number;
  replyCount: number;
  /** This candidate's wash-suspicion percentile (0-1) within the collected sample. */
  washSuspicionPercentile: number;
  /**
   * Whether this coin is the original for its ticker or a clone riding one,
   * as resolved by `ogCheck.ts`. Produced by I/O elsewhere and passed in as
   * data so this module stays pure.
   */
  ogStatus: OgStatus;
};

export type ClassifyThresholds = {
  minVolume24hUsd: number;
  /** Inclusive bounds on buys as a percentage of all 24h transactions. */
  minBuySharePct: number;
  maxBuySharePct: number;
  maxConcentrationPct: number;
  maxWashSuspicionPercentile: number;
  washAbsoluteTxCount: number;
  washAbsoluteMinReplies: number;
};

export const DEFAULT_THRESHOLDS: ClassifyThresholds = {
  minVolume24hUsd: 500_000,
  // A two-sided book: roughly as many sells as buys. A token running 90% buys
  // is a pump still inflating -- its "success" hasn't been tested by anyone
  // trying to get out yet, so it teaches this study nothing about what
  // survives. The window is centred on 50 with a few points of slack either
  // way (49/51, 51/49 and near neighbours all pass).
  //
  // HONEST CAVEAT, because this cuts both ways: a near-perfect 50/50 split is
  // also the canonical fingerprint of a wash-trading bot round-tripping its
  // own inventory. This gate cannot tell those apart on its own -- the two
  // wash heuristics below (absolute txns-vs-replies, and sample-relative
  // percentile) are what carry that load, and they are the reason it is safe
  // to select on balance here rather than being fooled by it.
  minBuySharePct: 45,
  maxBuySharePct: 55,
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

  if (input.volume24hUsd < t.minVolume24hUsd) {
    reasons.push(
      `24h volume $${Math.round(input.volume24hUsd).toLocaleString()} below the ` +
      `$${t.minVolume24hUsd.toLocaleString()} activity floor`,
    );
  }

  // Skipped when there were no trades at all: the volume gate above has
  // already rejected that case, and 0/0 has no meaningful ratio. Reporting it
  // twice would double-count one failure in the rejection tally.
  const buyShare = buySharePct(input.buys24h, input.sells24h);
  if (buyShare !== null && (buyShare < t.minBuySharePct || buyShare > t.maxBuySharePct)) {
    reasons.push(
      `24h buy/sell split ${buyShare.toFixed(1)}/${(100 - buyShare).toFixed(1)} is outside the ` +
      `${t.minBuySharePct}-${t.maxBuySharePct}% two-sided band ` +
      `(${input.buys24h} buys, ${input.sells24h} sells)`,
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

  // Mandatory: a clone is disqualified outright, however well it performed.
  // Its volume is borrowed from the original's attention, so treating it as a
  // success would teach the scorer to chase already-spent tickers.
  if (input.ogStatus.kind === "copycat") {
    const days = input.ogStatus.laterByMs / 86_400_000;
    reasons.push(
      `not the OG: ticker first minted ${days.toFixed(1)}d earlier by ` +
      `${input.ogStatus.firstMint} ("${input.ogStatus.firstName}")`,
    );
  } else if (input.ogStatus.kind === "unknown") {
    // Same call as the holder-concentration null above, and for the same
    // reason: this is an offline study meant to be read by a human, and
    // rejecting on an infrastructure failure would silently empty the sample
    // and look like a finding. Surfaced loudly instead of guessed.
    caveats.push(`OG status unknown (${input.ogStatus.why}) -- verify this ticker by hand`);
  }

  if (input.washSuspicionPercentile >= t.maxWashSuspicionPercentile) {
    reasons.push(
      `wash-suspicion percentile ${(input.washSuspicionPercentile * 100).toFixed(0)} is in the ` +
      `top quartile of this sample`,
    );
  }

  return { clean: reasons.length === 0, reasons, caveats };
}

/**
 * Buys as a percentage of all 24h transactions, or null when there were no
 * transactions at all. Null rather than a defaulted 50 or 0: "no trades" is
 * not the same finding as "perfectly balanced" or "all sells", and silently
 * collapsing them would let a dead token pass the balance gate.
 */
export function buySharePct(buys24h: number, sells24h: number): number | null {
  const total = buys24h + sells24h;
  if (total <= 0) return null;
  // Scale BEFORE dividing, not after. `(55 / 100) * 100` is 55.00000000000001
  // in IEEE754, which put a token sitting exactly on the 55% bound outside the
  // band. `(55 * 100) / 100` is exactly 55: the numerator stays an exact
  // integer, so whenever the true share lands on a representable value (which
  // every integer bound is) the division returns it exactly.
  return (buys24h * 100) / total;
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
