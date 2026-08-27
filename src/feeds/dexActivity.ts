import { fetchJson } from "../util/http.ts";
import { fetchDexActivity } from "../research/volume.ts";
import { organicBuyPressure } from "../scoring/organicFlow.ts";
import { type FeedAdapter, type FeedContext, type RawSignal } from "./types.ts";

/**
 * Organic buy-side accumulation on recently-migrated pump.fun tokens --
 * gmgn.ai's "smart money"/trending-flow concept, reimplemented against
 * aggregate DexScreener data (`fetchDexActivity`, already used by the
 * historical backtest in `src/research/volume.ts`) rather than gmgn.ai's own
 * service, which has no documented free public API.
 *
 * Deliberately NOT "more buys than sells = better": see
 * `src/scoring/organicFlow.ts` for why that's bounded to a band and dampened
 * by wash-suspicion, not a monotonic reward. Same crypto-native population as
 * `onchain.ts` (registered under the same family), so this is corroboration
 * from a different angle on the same feed, not a second independent source.
 *
 * Slower cadence than every other feed on purpose: each poll can make up to
 * `maxCandidatesPerPoll` DexScreener calls, not one.
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

/** Same small worker-pool pattern as src/research/backtest.ts's local helper. */
async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const dexActivityFeed: FeedAdapter = {
  id: "dexActivity",
  weight: 0.4,
  pollSeconds: 600,

  readiness() {
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.dexActivity;

    const coins = await fetchJson<PumpCoin[]>(
      `https://frontend-api-v3.pump.fun/coins?offset=0&limit=200` +
      "&sort=market_cap&order=DESC&includeNsfw=false",
      { headers: { "user-agent": BROWSERISH }, timeoutMs: 15_000 },
    );

    const now = Date.now();
    const maxAgeMs = c.candidateMaxAgeHours * 3600_000;

    // complete === true is pump.fun's own "graduated" flag; created_timestamp
    // is a proxy for "recently" since there is no true migration timestamp on
    // this endpoint (see the config comment on candidateMaxAgeHours).
    const candidates = coins
      .filter((coin) => coin.complete === true && !coin.is_banned && !coin.nsfw)
      .filter((coin) => {
        const created = coin.created_timestamp ?? 0;
        return created > 0 && now - created <= maxAgeMs;
      })
      .filter((coin): coin is PumpCoin & { mint: string } => Boolean(coin.mint))
      .slice(0, c.maxCandidatesPerPoll);

    const thresholds = {
      minLiquidityUsd: c.minLiquidityUsd,
      minBuyShareForSignal: c.minBuyShareForSignal,
      maxBuyShareForSignal: c.maxBuyShareForSignal,
      maxWashSuspicionScore: c.maxWashSuspicionScore,
    };

    const results = await mapWithConcurrency(candidates, c.concurrency, async (coin) => {
      const activity = await fetchDexActivity(coin.mint!).catch(() => null);
      if (!activity) return null;

      const score = organicBuyPressure(
        {
          buys24h: activity.buys24h,
          sells24h: activity.sells24h,
          liquidityUsd: activity.liquidityUsd,
          txCount24h: activity.txCount24h,
          replyCount: coin.reply_count ?? 0,
        },
        thresholds,
      );
      if (score <= 0) return null;

      const name = coin.name?.trim();
      const symbol = coin.symbol?.trim();
      const term = name && name.length >= (symbol?.length ?? 0) ? name : symbol;
      if (!term) return null;

      const signal: RawSignal = {
        feed: "dexActivity",
        term,
        rawScore: score,
        observedAt: new Date(coin.created_timestamp ?? now),
        url: activity.pairUrl ?? `https://pump.fun/coin/${coin.mint}`,
        meta: {
          symbol, mint: coin.mint,
          buys24h: activity.buys24h, sells24h: activity.sells24h,
          liquidityUsd: activity.liquidityUsd, volumeH24: activity.volumeH24,
          replies: coin.reply_count ?? 0,
          kind: "organic-buy-pressure",
        },
      };
      return signal;
    });

    return results.filter((s): s is RawSignal => s !== null);
  },
};
