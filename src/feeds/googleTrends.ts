import { fetchText } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";

/**
 * Google daily trending searches, via the public RSS feed. Free, no key.
 *
 * Mainstream coverage with roughly 15-30 minutes of latency, so on its own it
 * is usually late to a meme. Its value is corroboration: a term that shows up
 * here *and* on a fast crypto-native feed is a real trend rather than noise.
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

/** "2,000+" / "20K+" -> 2000 / 20000 */
function parseTraffic(raw: string | undefined): number {
  if (!raw) return 0;
  const m = raw.replace(/[,+\s]/g, "").match(/^([\d.]+)([KMB])?$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return n * mult;
}

/**
 * Google Trends lowercases its terms ("isack hadjar", "man city"), which
 * destroys the one signal the person-name filter downstream depends on. The
 * attached news headline keeps proper casing, so the term's real capitalisation
 * is recovered from it where possible.
 *
 * Without this the filter is blind on precisely the feed most likely to surface
 * real people -- live testing launched "isack hadjar", an F1 driver, straight
 * through.
 */
export function recoverCasing(term: string, headline: string): string {
  if (!headline || !term) return term;

  const idx = headline.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return term;

  const slice = headline.slice(idx, idx + term.length);
  // Only trust the headline if it actually adds capitalisation; headlines that
  // are themselves title-case or all-caps would manufacture a false signal.
  return /[A-Z]/.test(slice) && slice !== slice.toUpperCase() ? slice : term;
}

export const googleTrendsFeed: FeedAdapter = {
  id: "googleTrends",
  weight: 1,
  pollSeconds: 600,

  readiness() {
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const { geo } = ctx.cfg.feeds.googleTrends;
    const xml = await fetchText(
      `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`,
      { timeoutMs: 15_000 },
    );

    const out: RawSignal[] = [];
    for (const m of xml.matchAll(ITEM_RE)) {
      const block = m[1]!;
      const title = decode(tag(block, "title") ?? "");
      if (!title) continue;

      const traffic = parseTraffic(tag(block, "ht:approx_traffic"));
      const pub = tag(block, "pubDate");
      const observedAt = pub && !Number.isNaN(Date.parse(pub)) ? new Date(pub) : new Date();
      const headline = decode(tag(block, "ht:news_item_title") ?? "");
      const term = recoverCasing(title, headline);

      out.push({
        feed: "googleTrends",
        term,
        // 200k+ searches is an exceptional day; saturate the scale there.
        rawScore: logNorm(traffic, 200_000),
        observedAt,
        url: decode(tag(block, "ht:news_item_url") ?? "") || undefined,
        meta: { approxTraffic: traffic, headline, geo, rawTitle: title },
      });
    }
    return out;
  },
};
