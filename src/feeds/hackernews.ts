import { fetchJson } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";

/**
 * Hacker News front page via the Algolia index. Free, no key.
 *
 * Its value here is independence: HN's population overlaps neither /biz/ nor
 * mainstream search, so agreement between HN and either of those is a much
 * stronger signal than two crypto-native feeds agreeing with each other.
 * Skews tech, which is a real bias -- weighted accordingly.
 */

type Hit = {
  objectID?: string;
  title?: string;
  points?: number;
  num_comments?: number;
  created_at_i?: number;
  url?: string;
};
type Response = { hits?: Hit[] };

export const hackernewsFeed: FeedAdapter = {
  id: "hackernews",
  weight: 0.8,
  pollSeconds: 300,

  readiness() {
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.hackernews;
    const json = await fetchJson<Response>(
      `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${c.limit}`,
      { timeoutMs: 12_000 },
    );

    const now = Date.now();
    const out: RawSignal[] = [];

    for (const h of json.hits ?? []) {
      const title = h.title?.trim();
      if (!title) continue;

      const points = h.points ?? 0;
      const comments = h.num_comments ?? 0;
      const createdMs = (h.created_at_i ?? now / 1000) * 1000;

      // Rate of engagement, not the total: a story at 400 points after two
      // hours is a very different signal from 400 points after two days.
      const ageHours = Math.max(0.25, (now - createdMs) / 3600_000);
      const perHour = (points + comments * 2) / ageHours;

      out.push({
        feed: "hackernews",
        term: title.slice(0, 200),
        rawScore: logNorm(perHour, 120),
        observedAt: new Date(createdMs),
        url: h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : h.url,
        meta: { points, comments, perHour: Math.round(perHour) },
      });
    }
    return out;
  },
};
