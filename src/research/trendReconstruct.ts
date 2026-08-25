import { fetchJson } from "../util/http.ts";
import { similarity, tokens, normalize } from "../util/text.ts";

/**
 * "What was trending right before this token was created?" -- reconstructed
 * only from feeds with a genuine historical/backdated API. Reddit, 4chan and
 * on-chain feeds have no usable archive and are deliberately excluded here,
 * same as Google Trends (no historical code exists in this repo and its
 * unofficial API is fragile) is treated as best-effort, not a dependency.
 */

export type TrendMatch = {
  source: "hackernews" | "wikipedia";
  title: string;
  /** 0-1, from the shared `similarity()` used by scoring/saturation. */
  score: number;
  hoursBefore: number;
  url?: string;
};

const HN_SEARCH = "https://hn.algolia.com/api/v1/search_by_date";

/**
 * Raised from 0.4 after reading a real run's output: the 0.42-0.49 band was
 * entirely noise. Measured examples that cleared 0.4 -- "copper inu" vs
 * "Cooper Kupp" (0.42), "XerisCoin" vs "Terri Irwin" (0.42). Attributing a
 * token to a trend on that basis would feed junk into the scoring proposal.
 */
const MIN_MATCH_SCORE = 0.6;
const MAX_MATCHES = 5;

/**
 * Namespace and portal pages are navigation, not subjects. The live feed
 * adapter (`src/feeds/wikipedia.ts`) has always skipped these; this file did
 * not, so "Main Page" was matching tokens as though it were a trend.
 */
const WIKI_SKIP = /^(Main_Page|Special:|Wikipedia:|Portal:|Category:|File:|Help:|Template:|Talk:)/i;

/**
 * A one-word generic name cannot be attributed to a specific trend by fuzzy
 * title matching. `similarity()`'s containment rule scores a short term fully
 * contained in a longer title at >=0.9, so "WAR" matched "World War II",
 * "2026 Iran war" and "War Machine (2026 film)" all at 0.90 -- three
 * "precursors" that are really just the word appearing in a title. That is
 * correct behaviour for the saturation check it was written for, and wrong
 * evidence here.
 */
function tooGenericToAttribute(term: string): boolean {
  const content = tokens(term);
  if (content.length >= 2) return false;
  return normalize(term).replace(/\s/g, "").length < 6;
}

type HnHit = { title?: string; created_at_i?: number; objectID?: string };
type HnResponse = { hits?: HnHit[] };

export async function findHnPrecursors(
  term: string,
  createdAtMs: number,
  windowHours = 72,
): Promise<TrendMatch[]> {
  if (tooGenericToAttribute(term)) return [];

  const from = Math.floor((createdAtMs - windowHours * 3600_000) / 1000);
  const to = Math.floor(createdAtMs / 1000);
  const url = `${HN_SEARCH}?tags=story&numericFilters=created_at_i>${from},created_at_i<${to}`;

  let json: HnResponse;
  try {
    json = await fetchJson<HnResponse>(url, { timeoutMs: 12_000, retries: 1 });
  } catch {
    return [];
  }

  const out: TrendMatch[] = [];
  for (const h of json.hits ?? []) {
    if (!h.title) continue;
    const score = similarity(term, h.title);
    if (score < MIN_MATCH_SCORE) continue;
    out.push({
      source: "hackernews",
      title: h.title,
      score,
      hoursBefore: (createdAtMs - (h.created_at_i ?? 0) * 1000) / 3600_000,
      url: h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : undefined,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_MATCHES);
}

function dayPath(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}/${p(date.getUTCMonth() + 1)}/${p(date.getUTCDate())}`;
}

type WpArticle = { article?: string; views?: number };
type WpResponse = { items?: Array<{ articles?: WpArticle[] }> };

export async function findWikipediaPrecursors(
  term: string,
  createdAtMs: number,
  daysBack = 3,
): Promise<TrendMatch[]> {
  if (tooGenericToAttribute(term)) return [];

  const out: TrendMatch[] = [];

  for (let d = 0; d < daysBack; d++) {
    const date = new Date(createdAtMs - d * 86_400_000);
    let json: WpResponse;
    try {
      json = await fetchJson<WpResponse>(
        `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${dayPath(date)}`,
        { timeoutMs: 15_000, retries: 1 },
      );
    } catch {
      continue;
    }

    for (const a of (json.items?.[0]?.articles ?? []).slice(0, 200)) {
      if (!a.article || WIKI_SKIP.test(a.article)) continue;
      const title = decodeURIComponent(a.article).replace(/_/g, " ");
      const score = similarity(term, title);
      if (score < MIN_MATCH_SCORE) continue;
      out.push({
        source: "wikipedia",
        title,
        score,
        hoursBefore: d * 24,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(a.article)}`,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, MAX_MATCHES);
}
