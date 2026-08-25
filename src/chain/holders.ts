import { Connection, PublicKey } from "@solana/web3.js";
import { getConnection } from "./rpc.ts";
import type { Config } from "../config/schema.ts";

/**
 * Holder concentration for a mint -- new capability, nothing in the rest of
 * `chain/` reads token accounts today.
 *
 * `getTokenLargestAccounts` returns at most the top 20 TOKEN ACCOUNTS by RPC
 * spec, not owners and not an exhaustive census. That ceiling is a limitation
 * of the read, not of this code, and is reported alongside the result rather
 * than hidden.
 */

export type HolderConcentration = {
  /** Top-10 non-excluded holders' share of circulating supply, 0-100. */
  top10ConcentrationPct: number;
  totalSupply: number;
  excludedBalance: number;
  /** How many of the (up to 20) largest accounts were NOT excluded. */
  accountsConsidered: number;
};

/**
 * Pure math, no RPC: given the largest-accounts list, total supply, and
 * addresses to exclude (typically the bonding-curve or pool token account,
 * which legitimately holds most of the supply and is not a "holder"),
 * compute concentration among the top 10 remaining accounts relative to true
 * circulating supply.
 */
export function computeConcentration(
  largest: Array<{ address: string; uiAmount: number }>,
  totalSupply: number,
  excludeAddresses: string[],
): HolderConcentration {
  const excludeSet = new Set(excludeAddresses);
  let excludedBalance = 0;
  const nonExcluded: number[] = [];

  for (const a of largest) {
    if (excludeSet.has(a.address)) {
      excludedBalance += a.uiAmount;
      continue;
    }
    nonExcluded.push(a.uiAmount);
  }

  nonExcluded.sort((x, y) => y - x);
  const top10 = nonExcluded.slice(0, 10).reduce((s, n) => s + n, 0);
  const circulating = Math.max(0, totalSupply - excludedBalance);
  const pct = circulating > 0 ? (top10 / circulating) * 100 : 0;

  return {
    top10ConcentrationPct: pct,
    totalSupply,
    excludedBalance,
    accountsConsidered: nonExcluded.length,
  };
}

/** Live RPC fetch; thin wrapper around `computeConcentration`. */
export async function fetchHolderConcentration(
  cfg: Config,
  mint: string,
  excludeAddresses: string[],
  conn: Connection = getConnection(cfg),
): Promise<HolderConcentration> {
  const mintPk = new PublicKey(mint);
  const [largestRes, supplyRes] = await Promise.all([
    conn.getTokenLargestAccounts(mintPk),
    conn.getTokenSupply(mintPk),
  ]);

  const largest = largestRes.value.map((v) => ({
    address: v.address.toBase58(),
    uiAmount: v.uiAmount ?? 0,
  }));

  return computeConcentration(largest, supplyRes.value.uiAmount ?? 0, excludeAddresses);
}
