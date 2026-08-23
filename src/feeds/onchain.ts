import { fetchJson } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, clamp01, logNorm } from "./types.ts";

/**
 * On-chain momentum from pump.fun itself.
 *
 * The signal is not "which token is biggest" but "which *young* token is
 * already big": a coin nine hours old carrying a nine-figure market cap tells
 * you what narrative is bidding right now. DexScreener was tried first and is
 * the wrong tool here -- its search returns SOL pairs with no hourly momentum
 * data attached.
 *
 * This is fast-follow, not origination. Weighted low by default: by the time a
 * narrative shows up here, a direct copy is usually into a saturated market,
 * which the saturation check will catch anyway. Its real job is corroboration
 * and telling the scorer what kind of thing currently has buyers.
 */

type PumpCoin = {
  mint?: string;
  name?: string;
  symbol?: string;
  created_timestamp?: number;
  usd_market_cap?: number;
  reply_count?: number;
  is_banned?: boolean;
  nsfw?: boolean;
  complete?: boolean;
};

const BROWSERISH =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const onchainFeed: FeedAdapter = {
  id: "onchain",
  weight: 0.5,
  pollSeconds: 90,

  readiness() {
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.onchain;
    const coins = await fetchJson<PumpCoin[]>(
      `https://frontend-api-v3.pump.fun/coins?offset=0&limit=${c.limit}` +
      "&sort=market_cap&order=DESC&includeNsfw=false",
      { headers: { "user-agent": BROWSERISH }, timeoutMs: 15_000 },
    );

    const now = Date.now();
    const maxAgeMs = c.maxAgeHours * 3600_000;
    const out: RawSignal[] = [];

    for (const coin of coins) {
      if (coin.is_banned || coin.nsfw) continue;

      const mcap = coin.usd_market_cap ?? 0;
      if (mcap < c.minMarketCapUsd) continue;

      const created = coin.created_timestamp ?? 0;
      const ageMs = now - created;
      // Old coins are not momentum, however large they are.
      if (!created || ageMs > maxAgeMs) continue;

      const name = coin.name?.trim();
      const symbol = coin.symbol?.trim();
      const term = name && name.length >= (symbol?.length ?? 0) ? name : symbol;
      if (!term) continue;

      // $10M market cap saturates the size component.
      const size = logNorm(mcap, 10_000_000);
      // Younger is a stronger signal for the same size.
      const freshness = clamp01(1 - ageMs / maxAgeMs);

      out.push({
        feed: "onchain",
        term,
        rawScore: 0.6 * size + 0.4 * freshness,
        observedAt: new Date(created),
        url: coin.mint ? `https://pump.fun/coin/${coin.mint}` : undefined,
        meta: {
          symbol, mint: coin.mint, marketCapUsd: Math.round(mcap),
          ageHours: Math.round(ageMs / 3600_000),
          replies: coin.reply_count ?? 0,
          graduated: coin.complete === true,
          kind: "fast-follow",
        },
      });
    }
    return out;
  },
};
