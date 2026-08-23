import { fetchText } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, clamp01 } from "./types.ts";

/**
 * Google News RSS. Free, no key.
 *
 * Complements Google Trends rather than duplicating it: Trends reports what is
 * being *searched*, this reports what is being *published*. A story appears
 * here first and in Trends only once enough people react to it, so together
 * they bracket a story's life without being redundant.
 */

const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}(?:[^>]*)>([\\s\\S]*?)</${name}>`));
  return m?.[1]?.trim();
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Google appends " - Publisher" to every headline; it is not part of the story. */
function stripPublisher(title: string): string {
  const idx = title.lastIndexOf(" - ");
  return idx > 20 ? title.slice(0, idx).trim() : title;
}

export const googleNewsFeed: FeedAdapter = {
  id: "googleNews",
  weight: 0.9,
  pollSeconds: 420,

  readiness() {
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.googleNews;
    const base = c.topic
      ? `https://news.google.com/rss/headlines/section/topic/${encodeURIComponent(c.topic)}`
      : "https://news.google.com/rss";
    const xml = await fetchText(`${base}?hl=en-US&gl=US&ceid=US:en`, { timeoutMs: 15_000 });

    const now = Date.now();
    const out: RawSignal[] = [];
    let rank = 0;

    for (const m of xml.matchAll(ITEM_RE)) {
      const block = m[1]!;
      const raw = decode(tag(block, "title") ?? "");
      if (!raw) continue;

      const title = stripPublisher(raw);
      const pub = tag(block, "pubDate");
      const publishedMs = pub && !Number.isNaN(Date.parse(pub)) ? Date.parse(pub) : now;

      // RSS carries no engagement numbers, so position in the feed is the only
      // prominence signal available, decayed by how old the story is.
      const positional = clamp01(1 - rank / 40);
      const ageHours = Math.max(0, (now - publishedMs) / 3600_000);
      const freshness = clamp01(1 - ageHours / 24);
      rank++;

      out.push({
        feed: "googleNews",
        term: title.slice(0, 200),
        rawScore: clamp01(0.55 * positional + 0.45 * freshness),
        observedAt: new Date(publishedMs),
        url: decode(tag(block, "link") ?? "") || undefined,
        meta: { rank, source: decode(tag(block, "source") ?? ""), ageHours: Math.round(ageHours) },
      });
    }
    return out;
  },
};
