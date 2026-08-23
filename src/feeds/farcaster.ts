import { fetchJson } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";

/**
 * Farcaster trending casts via Neynar. Free tier is adequate here.
 * Env: NEYNAR_API_KEY
 */

type Cast = {
  hash?: string;
  text?: string;
  timestamp?: string;
  reactions?: { likes_count?: number; recasts_count?: number };
  replies?: { count?: number };
  author?: { username?: string; follower_count?: number };
};
type TrendingResponse = { casts?: Array<{ cast?: Cast } | Cast> };

function unwrap(entry: { cast?: Cast } | Cast): Cast {
  return "cast" in entry && entry.cast ? entry.cast : (entry as Cast);
}

export const farcasterFeed: FeedAdapter = {
  id: "farcaster",
  weight: 0.9,
  pollSeconds: 240,

  readiness() {
    if (!process.env.NEYNAR_API_KEY) return { ready: false, reason: "NEYNAR_API_KEY not set" };
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.farcaster;
    const json = await fetchJson<TrendingResponse>(
      `https://api.neynar.com/v2/farcaster/feed/trending?limit=${c.limit}&time_window=6h`,
      {
        headers: { "x-api-key": process.env.NEYNAR_API_KEY!, "x-neynar-experimental": "false" },
        timeoutMs: 12_000,
      },
    );

    const out: RawSignal[] = [];
    for (const entry of json.casts ?? []) {
      const cast = unwrap(entry);
      const text = cast.text?.trim();
      if (!text) continue;

      const likes = cast.reactions?.likes_count ?? 0;
      const recasts = cast.reactions?.recasts_count ?? 0;
      const replies = cast.replies?.count ?? 0;
      const engagement = likes + recasts * 3 + replies * 2;

      const ts = cast.timestamp && !Number.isNaN(Date.parse(cast.timestamp))
        ? new Date(cast.timestamp) : new Date();

      out.push({
        feed: "farcaster",
        term: text.slice(0, 200),
        rawScore: logNorm(engagement, 800),
        observedAt: ts,
        url: cast.hash ? `https://warpcast.com/~/conversations/${cast.hash}` : undefined,
        meta: { likes, recasts, replies, author: cast.author?.username },
      });
    }
    return out;
  },
};
