import { fetchJson } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";

/**
 * Urban Dictionary's words of the day -- slang that just got canonised. By
 * the time a phrase is UD's word of the day it has a real usage base but is
 * usually still days ahead of the mainstream press. Public JSON API, no
 * auth, verified live 2026-08-31.
 *
 * Family `culture`, shared with knowYourMeme: meme-documentation sites are
 * one population; two of them agreeing is corroboration WITHIN a family,
 * not across families (independence.ts's whole point).
 */

const URL = "https://api.urbandictionary.com/v0/words_of_the_day";

type UdWord = {
  word?: string;
  definition?: string;
  thumbs_up?: number;
  permalink?: string;
  written_on?: string;
};

export const urbanDictionaryFeed: FeedAdapter = {
  id: "urbanDictionary",
  weight: 0.7,
  pollSeconds: 3600,

  readiness() {
    return { ready: true };
  },

  async poll(_ctx: FeedContext): Promise<RawSignal[]> {
    const json = await fetchJson<{ list?: UdWord[] }>(URL, { timeoutMs: 15_000, retries: 1 });
    const out: RawSignal[] = [];
    const now = new Date();

    for (const w of json.list ?? []) {
      const word = w.word?.trim();
      if (!word || word.length < 2 || word.length > 60) continue;
      out.push({
        feed: "urbanDictionary",
        term: word,
        rawScore: logNorm(w.thumbs_up ?? 0, 2_000),
        // The API returns the ORIGINAL submission date, which can be years
        // old for a word resurfacing as word-of-the-day. observedAt is
        // display metadata only (invariant 5); ingestion time drives scoring
        // either way, so "now" is the honest choice here.
        observedAt: now,
        url: w.permalink,
        meta: { thumbsUp: w.thumbs_up ?? 0 },
      });
    }
    return out;
  },
};
