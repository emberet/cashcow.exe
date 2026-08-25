import { fetchJson } from "../util/http.ts";

/**
 * DexScreener activity lookup for the historical backtest. No all-time
 * cumulative volume field exists on this API (or on pump.fun's), so
 * `ath_market_cap` from `pumpSample.ts` remains the primary activity proxy;
 * this supplies a secondary "still has real trading right now" check plus
 * the transaction-count input to the wash-trading-shaped heuristic.
 */

const DEX_TOKEN = "https://api.dexscreener.com/latest/dex/tokens";

type DexPair = {
  url?: string;
  chainId?: string;
  volume?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
  liquidity?: { usd?: number };
};
type DexResponse = { pairs?: DexPair[] | null };

export type DexActivity = {
  volumeH24: number;
  txCount24h: number;
  liquidityUsd: number;
  pairUrl?: string;
};

export async function fetchDexActivity(mint: string): Promise<DexActivity | null> {
  const json = await fetchJson<DexResponse>(`${DEX_TOKEN}/${mint}`, { timeoutMs: 12_000, retries: 1 });
  const solPairs = (json.pairs ?? []).filter((p) => p.chainId === "solana");
  if (!solPairs.length) return null;

  // Multiple pairs can exist post-graduation; the highest-liquidity one is
  // the most representative of where real trading is actually happening.
  const best = solPairs.reduce((a, b) =>
    (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a);

  return {
    volumeH24: best.volume?.h24 ?? 0,
    txCount24h: (best.txns?.h24?.buys ?? 0) + (best.txns?.h24?.sells ?? 0),
    liquidityUsd: best.liquidity?.usd ?? 0,
    pairUrl: best.url,
  };
}
