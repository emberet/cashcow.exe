import { readFileSync, existsSync } from "node:fs";
import { normalize, tokens } from "../util/text.ts";
import { checkAll, type CompiledFilters } from "../scoring/filters.ts";
import { log, errFields } from "../util/log.ts";

/**
 * Lore: verifiable trivia that gives a launched token something true to say.
 *
 * 34 of the first 35 launches were duds, and the pattern in every one of them
 * is a term with no story -- "Rust", "Cloud", "Thunder", "War". The scoring
 * gate is not the problem there (those terms really were trending); the coin
 * simply had nothing to tell a buyer. This module is the fix: when a term has
 * ALREADY cleared every gate on its own merits, look it up in a corpus of
 * official catalogues and attach a real, citable fact.
 *
 * The operator's example was asteroid 18932 Robinhood -- a genuine minor
 * planet whose name collides with a household brand. The bot has already
 * launched $LINUX as a contentless dud, and 9885 Linux exists.
 *
 * WHY THIS IS NOT A FEED (the important part). A static catalogue of 26,455
 * names has no velocity and no acceleration. Wired in as a feed it would
 * either never clear the threshold -- correct, and useless -- or it would
 * need velocity faked for it, which is precisely the mistake that produced
 * $LETS (DECISIONS #48). Lore changes what a launch SAYS. It never changes
 * what qualifies as a launch. No gate reads it; it is consulted after the
 * decision to launch is already made.
 */

export type LoreSource = "minorPlanet";

export type LoreEntry = {
  source: LoreSource;
  /** Lowercase lookup key -- the catalogue name, normalised. */
  key: string;
  /** Human title, e.g. "18932 Robinhood". */
  title: string;
  /**
   * The bare catalogue name as written, e.g. "Robinhood" -- WITHOUT the
   * number. Screened separately from `title` because looksLikePersonName()
   * bails out on any string containing a digit, so "249541 Steinem" sails
   * through a check that "Steinem" alone would face. A catalogue number must
   * never be what launders a name past the likeness rail.
   */
  name: string;
  /** One sentence of citable fact. */
  fact: string;
  /** Official source URL for the entry. */
  url: string;
  /**
   * Sort rank for tie-breaking; lower is more notable. For minor planets
   * this is the catalogue number -- earlier discovery, better known.
   */
  rank: number;
};

export type LoreCorpus = {
  version: number;
  fetchedAt: string;
  byKey: Map<string, LoreEntry[]>;
  size: number;
};

export const EMPTY_CORPUS: LoreCorpus = {
  version: 0, fetchedAt: "", byKey: new Map(), size: 0,
};

type CorpusFile = {
  version?: number;
  fetchedAt?: string;
  entries?: Array<Partial<LoreEntry>>;
};

/**
 * Load a corpus written by scripts/fetch-lore-corpus.ts.
 *
 * Never throws: a missing or malformed corpus degrades to no lore at all,
 * which costs a launch its trivia line and nothing else. A money path must
 * not be able to fail on a decorative file being absent.
 */
export function loadLoreCorpus(path: string): LoreCorpus {
  if (!existsSync(path)) {
    log.debug("lore: no corpus file, lore disabled for this run", { path });
    return EMPTY_CORPUS;
  }
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as CorpusFile;
    const byKey = new Map<string, LoreEntry[]>();
    let size = 0;
    for (const e of raw.entries ?? []) {
      if (!e.key || !e.title || !e.fact || !e.url || !e.source) continue;
      const entry: LoreEntry = {
        source: e.source, key: e.key, title: e.title,
        // Older corpora predate the `name` field; recover it from the title
        // by dropping the leading catalogue number rather than skipping the
        // screen entirely.
        name: e.name ?? e.title.replace(/^\s*\d+\s+/, ""),
        fact: e.fact, url: e.url, rank: e.rank ?? Number.MAX_SAFE_INTEGER,
      };
      const list = byKey.get(entry.key);
      if (list) list.push(entry);
      else byKey.set(entry.key, [entry]);
      size++;
    }
    log.info("lore corpus loaded", { path, entries: size, fetchedAt: raw.fetchedAt });
    return {
      version: raw.version ?? 1,
      fetchedAt: raw.fetchedAt ?? "",
      byKey,
      size,
    };
  } catch (e) {
    log.warn("lore: corpus failed to load, continuing without it", { path, ...errFields(e) });
    return EMPTY_CORPUS;
  }
}

export type FindLoreOptions = {
  /**
   * Minimum length for a SINGLE WORD inside a longer term to be looked up.
   * A whole-term match is allowed down to 3 characters, because "Hal" as an
   * entire trend is a deliberate reference and "hal" inside a sentence is
   * usually not. Short keys are where false positives live.
   */
  minWordLength: number;
};

/**
 * Find the best lore entry for an already-approved term, or null.
 *
 * Matching is deliberately narrow: the whole term first, then individual
 * content words. Function words are never looked up -- "Now" and "Yes" are
 * both real minor planets, and matching them would attach trivia to exactly
 * the contentless terms the meaningless-term filter exists to reject.
 *
 * `filters` is not optional by accident. The corpus is a list of proper
 * names, some of which are people and brands (249541 Steinem, 11365 NASA).
 * Lore must never become a side door around the likeness rail, so every
 * candidate fact is re-screened before it can be published.
 */
export function findLore(
  term: string,
  corpus: LoreCorpus,
  filters: CompiledFilters,
  opts: FindLoreOptions = { minWordLength: 4 },
): LoreEntry | null {
  if (corpus.size === 0) return null;

  const whole = normalize(term).trim();
  const candidates: LoreEntry[] = [];

  if (whole.length >= 3) candidates.push(...(corpus.byKey.get(whole) ?? []));

  // Individual content words, but only when the term is more than one word --
  // a single-word term was already tried above at its own length.
  const words = tokens(whole, false);
  if (words.length > 1) {
    for (const w of words) {
      if (w.length < opts.minWordLength) continue;
      candidates.push(...(corpus.byKey.get(w) ?? []));
    }
  }
  if (candidates.length === 0) return null;

  // Most specific key wins; ties go to the more notable (lower rank) entry.
  candidates.sort((a, b) => b.key.length - a.key.length || a.rank - b.rank);

  for (const c of candidates) {
    // `c.name` FIRST and on its own: see the field comment on LoreEntry.
    const check = checkAll([c.name, c.title, c.fact], filters);
    if (check.allowed) return c;
    log.debug("lore: entry rejected by filters", { title: c.title, reason: check.reason });
  }
  return null;
}

/** The sentence appended to a token description. Exported for testing. */
export function loreLine(entry: LoreEntry): string {
  return `Lore: ${entry.fact}`;
}

/**
 * Cached corpus per path. The file is a few megabytes of JSON and never
 * changes while the process runs; re-reading it per launch would be pure
 * waste. Keyed by path so a test can point at a fixture without poisoning
 * the production entry.
 */
const CACHE = new Map<string, LoreCorpus>();

/** Testing hook: forget cached corpora. */
export function clearLoreCache(): void {
  CACHE.clear();
}

/**
 * The one call the launch path makes. Returns null when lore is off, the
 * corpus is missing, nothing matches, or the match fails the filters --
 * every one of which is a normal outcome, not an error.
 */
export function loreFor(
  cfg: { lore: { enabled: boolean; corpusPath: string; minWordLength: number } },
  term: string,
  filters: CompiledFilters,
): LoreEntry | null {
  if (!cfg.lore.enabled) return null;
  let corpus = CACHE.get(cfg.lore.corpusPath);
  if (!corpus) {
    corpus = loadLoreCorpus(cfg.lore.corpusPath);
    CACHE.set(cfg.lore.corpusPath, corpus);
  }
  return findLore(term, corpus, filters, { minWordLength: cfg.lore.minWordLength });
}

/**
 * Append the lore sentence to a description, bounded by the same limit
 * provenance respects. If it does not fit, the description is returned
 * unchanged: a truncated half-fact is worse than no fact.
 */
export function appendLore(description: string, entry: LoreEntry, maxLen: number): string {
  const combined = `${description} ${loreLine(entry)}`.trim();
  return combined.length <= maxLen ? combined : description;
}
