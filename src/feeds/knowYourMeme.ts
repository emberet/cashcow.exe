import { httpFetch } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, clamp01 } from "./types.ts";
import { log, errFields } from "../util/log.ts";

/**
 * Know Your Meme -- the encyclopedia of internet culture. Lagging for memes
 * it has fully documented, but its trending newsfeed and popular list track
 * what people are LOOKING UP right now, which leads the mainstream press by
 * days. Family `culture` (shared with urbanDictionary): meme-documentation
 * sites are one population, distinct from forums and social platforms.
 *
 * Scraped from server-rendered HTML (no API exists). Brittle by nature:
 * parsers are pinned to the markup shapes verified live on 2026-08-31
 * (fixtures in test/culture-feeds.test.ts), and a shape change degrades to
 * zero signals plus a warning, never an exception -- feed isolation in the
 * registry contains the rest.
 */

const TRENDING_URL = "https://knowyourmeme.com/newsfeed/trending";
const POPULAR_URL = "https://knowyourmeme.com/memes/popular";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36";

/** `class="newsfeed-title" title="..."` anchors carry editorialised titles. */
export function parseTrending(html: string): string[] {
  const out: string[] = [];
  const re = /class="newsfeed-title"[^>]*title="([^"]{3,120})"/g;
  for (const m of html.matchAll(re)) {
    const title = decodeEntities(m[1]!);
    if (!out.includes(title)) out.push(title);
  }
  return out;
}

/**
 * Popular page: `/memes/<slug>` anchors in page order. Slugs become phrases
 * (hyphens to spaces); single-word slugs and site-nav slugs are skipped --
 * "memes", "popular" and friends are navigation, not culture.
 */
export function parsePopular(html: string): string[] {
  const NAV = new Set(["memes", "popular", "submissions", "templates", "trending"]);
  const out: string[] = [];
  const re = /href="\/memes\/([a-z0-9][a-z0-9-]{2,80})"/g;
  for (const m of html.matchAll(re)) {
    const slug = m[1]!;
    if (NAV.has(slug) || !slug.includes("-")) continue;
    const phrase = slug.replace(/-/g, " ");
    if (!out.includes(phrase)) out.push(phrase);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

export const knowYourMemeFeed: FeedAdapter = {
  id: "knowYourMeme",
  weight: 0.8,
  pollSeconds: 1800,

  readiness() {
    return { ready: true };
  },

  async poll(_ctx: FeedContext): Promise<RawSignal[]> {
    const now = new Date();
    const out: RawSignal[] = [];

    for (const [url, parse, kind] of [
      [TRENDING_URL, parseTrending, "trending"],
      [POPULAR_URL, parsePopular, "popular"],
    ] as const) {
      try {
        const res = await httpFetch(url, {
          headers: { "user-agent": UA }, timeoutMs: 15_000, retries: 1,
        });
        const titles = parse(await res.text());
        if (titles.length === 0) {
          log.warn("knowYourMeme: page parsed to zero entries -- markup may have changed", { url });
          continue;
        }
        titles.slice(0, 25).forEach((title, i) => {
          out.push({
            feed: "knowYourMeme",
            term: title.slice(0, 200),
            // Page position is the only magnitude the page exposes.
            rawScore: clamp01(1 - i / 25) * 0.8 + 0.2,
            observedAt: now,
            url,
            meta: { kind, position: i },
          });
        });
      } catch (e) {
        log.warn("knowYourMeme: page failed, continuing", { url, ...errFields(e) });
      }
    }
    return out;
  },
};
