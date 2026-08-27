import { normalize, tokens, contentKey } from "../util/text.ts";

/**
 * Reduce a signal's text to comparable key phrases.
 *
 * Feeds disagree about shape: Google Trends yields a bare term ("man city"),
 * 4chan yields a cashtag, while Reddit, X and Polymarket yield whole sentences.
 * Cross-feed corroboration is the strongest component of the score, and it only
 * works if a Reddit headline and a Google term can collapse to the same key.
 * So long text is mined for the phrases that carry the meaning, and short text
 * is kept whole.
 */

const MAX_WHOLE_WORDS = 4;

/**
 * Words that can never stand alone as a trend subject.
 *
 * A single common word is not a meme, and several were clearing the threshold:
 * "My", "Saturday", "Texas", "Man". A sentence-initial capital looks identical
 * to a proper noun to a regex, so single-token phrases need a vocabulary check
 * that multi-word ones do not.
 */
const NEVER_ALONE = new Set([
  // pronouns / determiners / sentence openers
  "my", "your", "his", "her", "their", "our", "its", "mine", "this", "that", "these",
  "those", "what", "when", "where", "who", "whom", "why", "how", "which",
  "there", "here", "then", "than", "some", "any", "all", "every", "each",
  "you", "we", "they", "he", "she", "it", "me", "us", "them", "i",
  // time
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "today", "tomorrow", "yesterday", "tonight", "morning", "evening", "night",
  "week", "month", "year", "day", "hour", "minute", "weekend", "summer",
  "winter", "spring", "autumn", "fall",
  // generic nouns that carry no subject on their own
  "man", "woman", "men", "women", "boy", "girl", "kid", "kids", "people",
  "person", "guy", "guys", "thing", "things", "stuff", "way", "part", "end",
  "start", "top", "bottom", "side", "place", "world", "life", "home", "work",
  "time", "times", "case", "point", "line", "back", "front", "left", "right",
  "one", "two", "three", "first", "last", "next", "new", "old", "good", "bad",
  "best", "worst", "big", "small", "long", "short", "high", "low",
  // very common verbs
  "is", "are", "was", "were", "be", "been", "have", "has", "had", "do", "does",
  "did", "will", "would", "can", "could", "should", "may", "might", "must",
  "get", "got", "go", "went", "make", "made", "take", "took", "come", "came",
  "see", "saw", "say", "said", "know", "knew", "think", "want", "need", "use",
  // places generic enough to be noise on their own
  "texas", "california", "florida", "america", "usa", "us", "uk", "europe",
  "china", "india", "russia", "york", "london", "city", "state", "country",
]);

const NOISE = new Set([
  "just", "like", "really", "very", "much", "many", "make", "makes", "made",
  "get", "gets", "got", "one", "two", "first", "last", "next", "best", "worst",
  "today", "yesterday", "tomorrow", "week", "year", "day", "time", "people",
  "says", "said", "say", "think", "know", "want", "need", "going", "guys",
  "reddit", "post", "thread", "video", "photo", "image", "news", "update",
  "why", "what", "when", "where", "who", "how", "does", "did", "can", "should",
  "would", "could", "about", "after", "before", "over", "under", "into", "out",
]);

/**
 * A phrase built entirely out of `NEVER_ALONE` words is not a subject just
 * because there happen to be two of them stuck together -- "you girl" is as
 * empty as "you" or "girl" alone. Caught two words too late once already: a
 * real mainnet launch minted "you girl" (`YOUGIRL`) before this existed.
 */
function isAllFiller(toks: string[]): boolean {
  return toks.length > 0 && toks.every((t) => NEVER_ALONE.has(t));
}

export type Phrase = {
  text: string;
  key: string;
  /** 0..1 confidence that this phrase is the subject rather than filler. */
  salience: number;
};

const CASHTAG = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;
// Hyphens and apostrophes belong INSIDE a name: splitting on them turned
// "Spider-Man" into the candidates "Spider" and "Man", both of which qualified.
const PROPER_RUN =
  /\b([A-Z][a-z0-9]+(?:[-'’][A-Za-z0-9]+)*(?:\s+[A-Z][a-z0-9]+(?:[-'’][A-Za-z0-9]+)*){0,3})\b/g;
const QUOTED = /["“”']([^"“”']{3,60})["“”']/g;

export function extractPhrases(text: string, limit = 4): Phrase[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const wordCount = normalize(trimmed).split(" ").filter(Boolean).length;

  // A cashtag is the subject regardless of how short the surrounding text is,
  // so it has to be checked before the whole-text short-circuit.
  const cashtags = [...trimmed.matchAll(CASHTAG)].map((m) => m[1]!);
  if (cashtags.length) {
    const seen = new Map<string, Phrase>();
    for (const raw of cashtags) {
      const text = raw.toUpperCase();
      const key = contentKey(text);
      if (key && !seen.has(key)) seen.set(key, { text, key, salience: 1 });
    }
    if (seen.size) return [...seen.values()].slice(0, limit);
  }

  // Short input is already a term; keep it whole.
  if (wordCount > 0 && wordCount <= MAX_WHOLE_WORDS) {
    const toks = tokens(trimmed).filter((t) => !NOISE.has(t) && t.length > 1);
    if (toks.length === 1) {
      const only = toks[0]!;
      if (only.length < 3 || NEVER_ALONE.has(only)) return [];
    } else if (isAllFiller(toks)) {
      return [];
    }
    const key = contentKey(trimmed);
    return key ? [{ text: trimmed, key, salience: 1 }] : [];
  }

  const found = new Map<string, Phrase>();
  const add = (raw: string, salience: number) => {
    const clean = raw.trim();
    if (!clean) return;
    const toks = tokens(clean).filter((t) => !NOISE.has(t) && t.length > 1);
    if (!toks.length || toks.length > 4) return;

    // A lone common word is not a subject, however capitalised it was.
    if (toks.length === 1) {
      const only = toks[0]!;
      if (only.length < 3 || NEVER_ALONE.has(only)) return;
    } else if (isAllFiller(toks)) {
      return;
    }

    const key = toks.slice().sort().join(" ");
    if (!key) return;
    const prev = found.get(key);
    if (!prev || salience > prev.salience) {
      found.set(key, { text: clean, key, salience });
    }
  };

  // Quoted spans are usually the thing being talked about.
  for (const m of trimmed.matchAll(QUOTED)) add(m[1]!, 0.85);
  // Runs of capitalised words are entity-like.
  for (const m of trimmed.matchAll(PROPER_RUN)) add(m[1]!, 0.8);

  // Bigrams are a LAST RESORT for all-lowercase text. Emitting them alongside
  // real extractions produced junk that straddled phrase boundaries -- "man
  // brand" from "Spider-Man: Brand New Day", "deng hippo" from "Moo Deng the
  // hippo". Only fall back when nothing better was found.
  if (!found.size) {
    const content = tokens(trimmed).filter((t) => !NOISE.has(t) && t.length > 2);
    for (let i = 0; i < content.length - 1 && found.size < limit; i++) {
      add(`${content[i]} ${content[i + 1]}`, 0.5);
    }
    if (!found.size && content.length) add(content.slice(0, 3).join(" "), 0.4);
  }

  return [...found.values()]
    .sort((a, b) => b.salience - a.salience)
    .slice(0, limit);
}
