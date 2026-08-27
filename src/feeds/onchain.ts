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

/**
 * 0..1 estimate of closeness to pump.fun's bonding-curve graduation.
 *
 * APPROXIMATION: this endpoint carries `usd_market_cap` and a `complete`
 * flag, not the on-chain reserve state, so this is `mcap / graduationMarketCapUsd`
 * clamped to 0..1 -- not the true reserve fraction. A real reserve read needs a
 * per-mint RPC call via `@pump-fun/pump-sdk`; `src/chain/holders.ts`'s closest
 * analog (`getTokenLargestAccounts`) fails against the free public mainnet RPC
 * almost every time (see test/research.test.ts), and fanning that out across
 * every candidate on a 90s cadence is not viable. So this stays an estimate,
 * clearly labelled as one.
 *
 * Always 0 once graduated: being close to a threshold already crossed is
 * stale information, not momentum, and gmgn.ai's own "almost_bonded" bucket
 * stops meaning anything the moment a token migrates.
 */
export function curveProgress(
  usdMarketCap: number,
  graduated: boolean,
  graduationMarketCapUsd: number,
): number {
  if (graduated) return 0;
  if (usdMarketCap <= 0 || graduationMarketCapUsd <= 0) return 0;
  return clamp01(usdMarketCap / graduationMarketCapUsd);
}

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
      const graduated = coin.complete === true;
      // gmgn.ai-inspired addition: reward tokens visibly closing in on
      // graduation ("almost_bonded"), not just big-and-young ones. Weight is
      // configurable (curveProgressWeight) so it can be zeroed without
      // disabling the feed; the other two weights are reduced to compensate
      // so this feed's overall influence (weight 0.5, "corroboration only")
      // does not grow.
      const progress = curveProgress(mcap, graduated, c.graduationMarketCapUsd);
      const w = clamp01(c.curveProgressWeight);
      const sizeWeight = 0.6 * (1 - w);
      const freshnessWeight = 0.4 * (1 - w);

      out.push({
        feed: "onchain",
        term,
        rawScore: sizeWeight * size + freshnessWeight * freshness + w * progress,
        observedAt: new Date(created),
        url: coin.mint ? `https://pump.fun/coin/${coin.mint}` : undefined,
        meta: {
          symbol, mint: coin.mint, marketCapUsd: Math.round(mcap),
          ageHours: Math.round(ageMs / 3600_000),
          replies: coin.reply_count ?? 0,
          graduated,
          curveProgress: progress,
          kind: "fast-follow",
        },
      });
    }
    return out;
  },
};
