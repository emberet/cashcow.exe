import { fetchJson } from "../util/http.ts";
import { similarity } from "../util/text.ts";

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
const MIN_MATCH_SCORE = 0.4;
const MAX_MATCHES = 5;

type HnHit = { title?: string; created_at_i?: number; objectID?: string };
type HnResponse = { hits?: HnHit[] };

export async function findHnPrecursors(
  term: string,
  createdAtMs: number,
  windowHours = 72,
): Promise<TrendMatch[]> {
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
      if (!a.article) continue;
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
