import { fetchJson } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";

/**
 * Wikipedia top pageviews. Free, no key.
 *
 * The purest "what did people go and look up" signal available, which is a
 * different act from searching or posting: someone reading a Wikipedia article
 * has already encountered the thing elsewhere and wants to understand it.
 *
 * The data is DAILY and lags by a day, so this is never a fast trigger. Its job
 * is corroboration -- confirming that a term surfacing on a fast, noisy feed is
 * something the general public actually cared about.
 */

type Article = { article?: string; views?: number; rank?: number };
type Response = { items?: Array<{ articles?: Article[] }> };

/** Namespace and portal pages are navigation, not subjects. */
const SKIP = /^(Main_Page|Special:|Wikipedia:|Portal:|Category:|File:|Help:|Template:|Talk:)/i;

function titleOf(article: string): string {
  return decodeURIComponent(article).replace(/_/g, " ").trim();
}

function dayPath(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`;
}

export const wikipediaFeed: FeedAdapter = {
  id: "wikipedia",
  weight: 0.7,
  pollSeconds: 3600,

  readiness() {
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.wikipedia;

    // Today's aggregate is usually not published yet; fall back a day.
    let json: Response | undefined;
    for (const daysAgo of [1, 2]) {
      try {
        json = await fetchJson<Response>(
          "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/" +
          dayPath(daysAgo),
          { timeoutMs: 15_000, retries: 1 },
        );
        break;
      } catch {
        // try the previous day
      }
    }
    if (!json) throw new Error("wikipedia pageviews unavailable for the last two days");

    const articles = json.items?.[0]?.articles ?? [];
    const observedAt = new Date(Date.now() - 86400_000);
    const out: RawSignal[] = [];

    for (const a of articles.slice(0, c.limit)) {
      const raw = a.article;
      if (!raw || SKIP.test(raw)) continue;

      const title = titleOf(raw);
      if (!title || title.length < 2) continue;

      out.push({
        feed: "wikipedia",
        term: title.slice(0, 200),
        // A million views in a day is exceptional; saturate there.
        rawScore: logNorm(a.views ?? 0, 1_000_000),
        observedAt,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(raw)}`,
        meta: { views: a.views ?? 0, rank: a.rank ?? null, granularity: "daily" },
      });
    }
    return out;
  },
};
