import { fetchJson } from "../util/http.ts";

/**
 * "Is this coin the OG for its ticker, or a copycat riding one?"
 *
 * A successful pump.fun ticker is immediately cloned. Verified live on
 * CYBERLEEK: the original minted 2026-08-15 and reached ~$7M, then three
 * `cyberleek` clones appeared on 08-18, and a further swarm ("RIP Cyberleek",
 * "Justice for CyberLeek" x3) on 08-27. A study asking "what did successful
 * launches have in common?" must not count those clones as successes -- they
 * inherit their volume from the original's attention, so including them would
 * teach the scorer to chase tickers that are already spent.
 *
 * This is I/O, deliberately kept OUT of `classify.ts`: that file is pure math
 * over numbers already fetched, which is what makes it unit-testable without a
 * network. The pure gate there consumes an `OgStatus` produced here.
 */

const PUMP_SEARCH = "https://frontend-api-v3.pump.fun/coins";

// pump.fun's frontend rejects non-browser agents on some edges.
const BROWSERISH =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** How many of the OLDEST fuzzy matches to pull. See `PAGE_LIMIT` note below. */
const PAGE_LIMIT = 50;

type RawCoin = {
  mint?: string;
  symbol?: string;
  name?: string;
  created_timestamp?: number;
  usd_market_cap?: number;
  is_banned?: boolean;
};

export type OgStatus =
  | { kind: "og" }
  | {
      kind: "copycat";
      firstMint: string;
      firstSymbol: string;
      firstName: string;
      firstSeenMs: number;
      /** How long AFTER the original this candidate was minted. */
      laterByMs: number;
    }
  /** Lookup failed, or the search page could not prove completeness. */
  | { kind: "unknown"; why: string }
  /** Not looked up at all -- the candidate was already rejected on cheaper gates. */
  | { kind: "skipped" };

/**
 * Tickers are compared case- and punctuation-insensitively: `CYBERLEEK`,
 * `cyberleek` and `Cyberleek` are the same ticker to a trader, and pump.fun's
 * search returns all three spellings for one trend.
 */
export function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Find the earliest mint sharing this candidate's ticker.
 *
 * `sort=created_timestamp&order=ASC` returns the OLDEST matches first, which is
 * what makes "was there an earlier one?" answerable in a single request.
 *
 * Two correctness details that a naive version gets wrong:
 *
 *  1. **Match on the SYMBOL, not on the search hit.** The search is fuzzy over
 *     name AND symbol. Searching `CYBERLEEK` returns a 2025 coin called
 *     "Retarded CyberLeak Uri" with the ticker `P1SS` -- older than the real
 *     CYBERLEEK, and completely unrelated to it. Counting any older hit as the
 *     original would mark the genuine OG a copycat.
 *
 *  2. **Prove the page is complete before concluding "OG".** Only `PAGE_LIMIT`
 *     of the oldest matches come back. Finding no earlier same-symbol coin in
 *     that page only means something if the page actually reaches forward past
 *     the candidate's own creation time; if every row is still older than the
 *     candidate, there may be more rows we did not see. That case returns
 *     `unknown` rather than a false `og`.
 */
export async function fetchOgStatus(
  symbol: string,
  mint: string,
  createdTimestamp: number,
): Promise<OgStatus> {
  const wanted = normalizeSymbol(symbol);
  if (!wanted) return { kind: "unknown", why: "candidate has no usable ticker" };

  const url =
    `${PUMP_SEARCH}?searchTerm=${encodeURIComponent(symbol)}` +
    `&limit=${PAGE_LIMIT}&sort=created_timestamp&order=ASC&includeNsfw=true`;

  let coins: RawCoin[];
  try {
    coins = await fetchJson<RawCoin[]>(url, {
      headers: { "user-agent": BROWSERISH },
      timeoutMs: 12_000,
      retries: 1,
    });
  } catch (err) {
    return { kind: "unknown", why: `pump.fun search failed: ${String(err).slice(0, 120)}` };
  }

  let earliest: RawCoin | null = null;
  let newestSeen = 0;

  for (const c of coins) {
    const created = c.created_timestamp ?? 0;
    newestSeen = Math.max(newestSeen, created);

    if (!c.mint || c.mint === mint) continue; // never compare a coin to itself
    if (c.is_banned) continue;                // a banned clone is not "the original"
    if (normalizeSymbol(c.symbol ?? "") !== wanted) continue; // detail 1
    if (created <= 0 || created >= createdTimestamp) continue; // strictly earlier only

    if (!earliest || created < (earliest.created_timestamp ?? 0)) earliest = c;
  }

  if (earliest) {
    const firstSeenMs = earliest.created_timestamp ?? 0;
    return {
      kind: "copycat",
      firstMint: earliest.mint!,
      firstSymbol: earliest.symbol ?? "",
      firstName: earliest.name ?? earliest.symbol ?? "",
      firstSeenMs,
      laterByMs: createdTimestamp - firstSeenMs,
    };
  }

  // detail 2: did the page reach past this candidate's own era?
  if (coins.length >= PAGE_LIMIT && newestSeen < createdTimestamp) {
    return {
      kind: "unknown",
      why: `the ${PAGE_LIMIT} oldest matches are all older than this coin, so an ` +
        `earlier same-ticker mint may exist beyond the page`,
    };
  }

  return { kind: "og" };
}
