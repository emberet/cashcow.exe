/** Text utilities shared by the scoring, saturation and filter layers. */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "is",
  "are", "was", "were", "be", "been", "it", "its", "this", "that", "with",
  "as", "by", "from", "new", "his", "her", "their", "has", "have", "will",
]);

/** Canonical key for a trend term: case, accents and punctuation folded away. */
export function normalize(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokens(input: string, dropStopwords = true): string[] {
  const t = normalize(input).split(" ").filter(Boolean);
  return dropStopwords ? t.filter((w) => !STOPWORDS.has(w)) : t;
}

/** Content-bearing key used for dedupe: stopwords dropped, tokens sorted. */
export function contentKey(input: string): string {
  const t = tokens(input);
  return (t.length ? t : normalize(input).split(" ").filter(Boolean)).sort().join(" ");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Levenshtein expressed as 0..1 where 1 is identical. */
export function editRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - levenshtein(a, b) / max;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Composite 0..1 similarity between two trend terms.
 *
 * Deliberately generous: in the saturation check a false positive costs one
 * skipped launch, while a false negative costs a launch into a saturated
 * market. Being wrong in the cautious direction is much cheaper.
 */
export function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const ka = contentKey(a);
  const kb = contentKey(b);
  if (ka && ka === kb) return 1;

  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));

  // One term fully containing the other's content words: "doge" vs "doge coin".
  if (ta.size && tb.size) {
    const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    let covered = 0;
    for (const x of small) if (big.has(x)) covered++;
    if (covered === small.size) return Math.max(0.9, jaccard(ta, tb));
  }

  const jac = jaccard(ta, tb);
  const edit = editRatio(na, nb);
  const compact = editRatio(na.replace(/\s/g, ""), nb.replace(/\s/g, ""));

  return Math.max(jac * 0.5 + edit * 0.3 + compact * 0.2, jac, compact * 0.85);
}

/** Uppercase A-Z0-9 ticker candidate derived from a term. */
export function tickerize(term: string, maxLen = 8): string {
  const t = tokens(term);
  const words = t.length ? t : normalize(term).split(" ").filter(Boolean);
  if (!words.length) return "";

  const joined = words.join("").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (joined.length <= maxLen) return joined;

  if (words.length > 1) {
    const acronym = words.map((w) => w[0]!).join("").toUpperCase();
    if (acronym.length >= 3 && acronym.length <= maxLen) return acronym;
  }
  return joined.slice(0, maxLen);
}
