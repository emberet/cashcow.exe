import { tokens } from "../util/text.ts";

/**
 * How much does a memecoin audience care about this?
 *
 * A trending central-bank decision and a trending cartoon hippo are both
 * "trends", but only one of them has buyers. Feed of origin is the strongest
 * prior -- something surfacing on /biz/ is crypto-native by construction --
 * and vocabulary adjusts from there.
 */

const FEED_PRIOR: Record<string, number> = {
  fourchan: 0.85,
  onchain: 0.9,
  // Real on-chain trading data, comparable footing to onchain's prior.
  dexActivity: 0.85,
  farcaster: 0.7,
  xApi: 0.55,
  polymarket: 0.55,
  reddit: 0.4,
  googleTrends: 0.35,
};

const CRYPTO = new Set([
  "crypto", "coin", "token", "memecoin", "solana", "sol", "ethereum", "eth",
  "bitcoin", "btc", "pump", "moon", "degen", "ape", "hodl", "bags", "airdrop",
  "defi", "nft", "onchain", "wallet", "dex", "liquidity", "rug", "whale",
  "bullish", "bearish", "altcoin", "shitcoin", "ath", "dip", "wagmi", "ngmi",
]);

/** Meme-culture markers: things that get launched even without crypto words. */
const MEMEABLE = new Set([
  "meme", "viral", "trend", "trending", "based", "cursed", "sigma", "rizz",
  "skibidi", "gyatt", "aura", "brainrot", "npc", "chad", "cope", "seethe",
  "goblin", "gremlin", "cat", "dog", "frog", "hippo", "capybara", "penguin",
  "duck", "monkey", "hamster", "bird", "goose", "shrimp", "axolotl",
  "mascot", "plush", "toy", "cartoon", "anime", "emoji", "tiktok", "challenge",
]);

/** Dry institutional vocabulary: real news, but nobody buys a token for it. */
const DRY = new Set([
  "earnings", "quarterly", "revenue", "forecast", "inflation", "cpi", "gdp",
  "policy", "regulation", "legislation", "senate", "congress", "parliament",
  "lawsuit", "settlement", "merger", "acquisition", "ipo", "dividend",
  "unemployment", "mortgage", "insurance", "medicare", "tariff", "budget",
  "weather", "forecast", "traffic", "recall", "advisory", "schedule",
]);

export function cryptoAffinity(term: string, feeds: Iterable<string>): number {
  // Best prior across the feeds that reported this term.
  let prior = 0.3;
  for (const f of feeds) prior = Math.max(prior, FEED_PRIOR[f] ?? 0.3);

  const toks = tokens(term);
  if (!toks.length) return prior;

  let crypto = 0, meme = 0, dry = 0;
  for (const t of toks) {
    if (CRYPTO.has(t)) crypto++;
    if (MEMEABLE.has(t)) meme++;
    if (DRY.has(t)) dry++;
  }

  let score = prior;
  if (crypto) score += 0.25 * Math.min(crypto, 2);
  if (meme) score += 0.2 * Math.min(meme, 2);
  if (dry) score -= 0.3 * Math.min(dry, 2);

  return score < 0 ? 0 : score > 1 ? 1 : score;
}

/**
 * Can this become a ticker people will type? Short, punchy, pronounceable.
 * Long multi-clause phrases score badly because they make bad symbols.
 */
export function tickerability(term: string): number {
  const toks = tokens(term);
  if (!toks.length) return 0;

  const words = toks.length;
  const chars = toks.join("").length;

  // One or two punchy words is ideal.
  let score = words === 1 ? 1 : words === 2 ? 0.9 : words === 3 ? 0.65 : 0.3;

  if (chars <= 12) score += 0.1;
  else if (chars > 24) score -= 0.25;

  // A single very long word makes an unreadable symbol.
  if (words === 1 && chars > 14) score -= 0.3;
  // Digits and mixed junk read badly as a ticker.
  if (/\d{3,}/.test(term)) score -= 0.2;

  return score < 0 ? 0 : score > 1 ? 1 : score;
}
