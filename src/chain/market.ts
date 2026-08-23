import { fetchJson } from "../util/http.ts";
import type { KnownToken, MarketTokenSource } from "../scoring/saturation.ts";
import { log } from "../util/log.ts";

/**
 * "What already exists for this trend?" -- the input to the saturation check.
 *
 * pump.fun's own search is primary because it sees tokens that have not
 * graduated to a DEX yet, which is exactly the crowd we compete with. These are
 * the site's frontend endpoints rather than a documented public API, so they
 * can change without notice; DexScreener is a structurally different fallback
 * so one vendor change does not blind the check.
 *
 * Both failing is handled upstream by treating the trend as saturated: skipping
 * a launch is free, launching blind into a crowded trend is not.
 */

const PUMP_SEARCH = "https://frontend-api-v3.pump.fun/coins";
const DEX_SEARCH = "https://api.dexscreener.com/latest/dex/search";

// pump.fun's frontend rejects non-browser agents on some edges.
const BROWSERISH =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type PumpCoin = {
  mint?: string;
  name?: string;
  symbol?: string;
  created_timestamp?: number;
  usd_market_cap?: number;
  is_banned?: boolean;
};

type DexPair = {
  chainId?: string;
  baseToken?: { name?: string; symbol?: string; address?: string };
  pairCreatedAt?: number;
};
type DexResponse = { pairs?: DexPair[] | null };

async function fromPumpFun(term: string, sinceMs: number): Promise<KnownToken[]> {
  const url =
    `${PUMP_SEARCH}?searchTerm=${encodeURIComponent(term)}` +
    "&limit=50&sort=created_timestamp&order=DESC&includeNsfw=true";

  const coins = await fetchJson<PumpCoin[]>(url, {
    headers: { "user-agent": BROWSERISH },
    timeoutMs: 12_000,
  });

  const out: KnownToken[] = [];
  for (const c of coins) {
    if (!c.name && !c.symbol) continue;
    if (c.is_banned) continue;
    const created = c.created_timestamp ?? 0;
    if (created < sinceMs) continue;
    out.push({
      name: c.name ?? c.symbol ?? "",
      symbol: c.symbol ?? "",
      createdAt: created,
      source: "market",
      mint: c.mint,
    });
  }
  return out;
}

async function fromDexScreener(term: string, sinceMs: number): Promise<KnownToken[]> {
  const json = await fetchJson<DexResponse>(
    `${DEX_SEARCH}?q=${encodeURIComponent(term)}`,
    { timeoutMs: 12_000 },
  );

  const out: KnownToken[] = [];
  for (const p of json.pairs ?? []) {
    if (p.chainId !== "solana") continue;
    const created = p.pairCreatedAt ?? 0;
    if (created < sinceMs) continue;
    const name = p.baseToken?.name ?? p.baseToken?.symbol;
    if (!name) continue;
    out.push({
      name,
      symbol: p.baseToken?.symbol ?? "",
      createdAt: created,
      source: "market",
      mint: p.baseToken?.address,
    });
  }
  return out;
}

/**
 * Short TTL cache. The same qualifying terms recur tick after tick, and each
 * saturation check was a fresh pump.fun round trip; two minutes of staleness
 * is nothing against a 24h saturation window and removes most of the traffic.
 */
const cache = new Map<string, { at: number; tokens: KnownToken[] }>();
const CACHE_TTL_MS = 120_000;
const CACHE_MAX = 300;

export const pumpFunMarket: MarketTokenSource = {
  async recentTokens(term: string, sinceMs: number): Promise<KnownToken[]> {
    const key = term.toLowerCase().trim();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return hit.tokens.filter((t) => t.createdAt >= sinceMs);
    }

    const store = (tokens: KnownToken[]): KnownToken[] => {
      if (cache.size >= CACHE_MAX) {
        // Drop the oldest entry; insertion order is good enough here.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, { at: Date.now(), tokens });
      return tokens;
    };

    try {
      return store(await fromPumpFun(term, sinceMs));
    } catch (primaryErr) {
      log.warn("pump.fun search failed, falling back to DexScreener", {
        err: String(primaryErr).slice(0, 160),
      });
      // Let this throw on failure: saturation treats an unverifiable market as
      // saturated, which is the safe direction. Failures are NOT cached.
      return store(await fromDexScreener(term, sinceMs));
    }
  },
};
