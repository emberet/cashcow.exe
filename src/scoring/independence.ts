/**
 * How much do several sources agreeing actually tell us?
 *
 * Counting distinct feeds treats every agreement as equal, which is wrong.
 * /biz/ and on-chain momentum agreeing is close to one source talking to
 * itself -- the same few thousand people, reacting to each other. Google
 * Trends and Hacker News agreeing is genuinely independent evidence, because
 * neither population knows the other exists.
 *
 * So corroboration is scored by how many independent FAMILIES agree, with only
 * a small bonus for extra feeds inside a family. This is what makes it safe to
 * lower the hard gate to a single source: a lone /biz/ spike is still allowed
 * through the gate, but it scores badly on this component and has to be
 * genuinely excellent elsewhere to clear the threshold.
 */

export type Family =
  | "crypto"    // crypto-native populations, heavily self-referential
  | "search"    // people looking something up
  | "press"     // what publishers are pushing
  | "forum"     // link-aggregator discussion communities
  | "social"    // broadcast social platforms
  | "markets";  // people staking money on an outcome

export const FEED_FAMILY: Record<string, Family> = {
  fourchan: "crypto",
  onchain: "crypto",
  // Same crypto-native population as onchain (both read pump.fun's own
  // /coins listing) -- deliberately NOT a new independent family. Inventing
  // one here would inflate corroboration for two feeds reading the same
  // underlying market, exactly the failure this whole model exists to avoid.
  dexActivity: "crypto",
  farcaster: "crypto",
  googleTrends: "search",
  wikipedia: "search",
  googleNews: "press",
  reddit: "forum",
  hackernews: "forum",
  xApi: "social",
  // Same platform and population as xApi -- a watchlist tweet corroborated
  // by a search-API tweet is one crowd, not two. Deliberately NOT a new
  // family, same reasoning as dexActivity above.
  watchlist: "social",
  polymarket: "markets",
};

export function familyOf(feed: string): Family {
  return FEED_FAMILY[feed] ?? "social";
}

export function distinctFamilies(feeds: Iterable<string>): Family[] {
  return [...new Set([...feeds].map(familyOf))];
}

/**
 * 0..1 corroboration strength.
 *
 * One family scores 0 no matter how many feeds are in it. Three or more
 * independent families saturate. Extra feeds within a family add a token
 * amount -- three /biz/ threads are marginally better evidence than one, but
 * nothing like a second population agreeing.
 */
export function corroborationStrength(feeds: Iterable<string>): number {
  const list = [...new Set(feeds)];
  if (list.length === 0) return 0;

  const families = distinctFamilies(list);
  const base = Math.min(1, Math.max(0, (families.length - 1) / 2));
  const extraFeeds = list.length - families.length;
  const bonus = Math.min(0.15, extraFeeds * 0.05);

  return Math.min(1, base + bonus);
}

/** Human-readable explanation, surfaced in the admin candidate queue. */
export function describeCorroboration(feeds: Iterable<string>): string {
  const list = [...new Set(feeds)];
  const families = distinctFamilies(list);

  if (!list.length) return "no sources";
  if (families.length === 1) {
    return `${list.length} source(s), all ${families[0]} — weak, one population`;
  }
  return `${families.length} independent families (${families.join(" + ")})`;
}
