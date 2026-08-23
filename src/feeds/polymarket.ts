import { fetchJson } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";

/**
 * Polymarket markets ranked by 24h volume, used as an attention proxy.
 *
 * A market whose volume is spiking is a strong signal that something is about
 * to be widely discussed, and the audience placing those bets is already
 * crypto-native -- which is exactly the audience a launch needs.
 *
 * Free, no key. NOTE: this endpoint was unreachable from the machine where the
 * bot was written (connection refused, while other hosts resolved fine), so it
 * is written to spec and needs a live confirmation from your network. If it
 * cannot connect, the registry degrades this feed rather than stalling.
 */

type Market = {
  question?: string;
  slug?: string;
  volume24hr?: number | string;
  volume?: number | string;
  liquidity?: number | string;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
  startDate?: string;
};

function num(v: number | string | undefined): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export const polymarketFeed: FeedAdapter = {
  id: "polymarket",
  weight: 1,
  pollSeconds: 300,

  readiness() {
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.polymarket;
    const url =
      "https://gamma-api.polymarket.com/markets" +
      `?closed=false&active=true&limit=${c.limit}` +
      "&order=volume24hr&ascending=false";

    const markets = await fetchJson<Market[]>(url, { timeoutMs: 15_000 });

    const now = new Date();
    const out: RawSignal[] = [];

    for (const m of markets) {
      const question = m.question?.trim();
      if (!question || m.closed) continue;

      const vol24 = num(m.volume24hr);
      if (vol24 < c.minVolume24hUsd) continue;

      // Share of total volume done in the last 24h: a market doing most of its
      // lifetime volume today is spiking, not merely large.
      const total = Math.max(num(m.volume), vol24);
      const recency = total > 0 ? vol24 / total : 0;

      out.push({
        feed: "polymarket",
        term: question,
        rawScore: 0.65 * logNorm(vol24, 2_000_000) + 0.35 * recency,
        observedAt: now,
        url: m.slug ? `https://polymarket.com/event/${m.slug}` : undefined,
        meta: { volume24hUsd: vol24, totalVolumeUsd: total, recencyShare: recency },
      });
    }
    return out;
  },
};
