import { fetchJson } from "../util/http.ts";

/**
 * Pulls a sample of past pump.fun launches (anyone's, not this bot's) for the
 * one-time historical backtest. This is a script's data source, not a live
 * gate -- failures here shrink the sample rather than throw, since a partial
 * historical sample is still useful and nothing downstream is time-critical.
 *
 * Sampling strategy, and why it is NOT chronological paging: pump.fun creates
 * new tokens continuously enough that the newest few pages are all seconds
 * old (verified live -- the top 5 by `created_timestamp` were all <1 minute
 * old). Paging backward by time to reach a 30-180-day-old window would need
 * many thousands of requests. `sort=market_cap&order=DESC` instead reaches
 * the $500k-$2M target band within about 10 pages (verified live: offset 500
 * already sits around $400k), because it goes straight at the population we
 * actually care about -- tokens that reached real market cap -- rather than
 * scanning the sea of tokens that died at inception, which is the vast
 * majority. The age window below is then a filter on that ranked result, not
 * a pagination bound.
 */

const PUMP_COINS = "https://frontend-api-v3.pump.fun/coins";

// pump.fun's frontend rejects non-browser agents on some edges.
const BROWSERISH =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

type RawCoin = {
  mint?: string;
  name?: string;
  symbol?: string;
  created_timestamp?: number;
  usd_market_cap?: number;
  ath_market_cap?: number;
  reply_count?: number;
  is_banned?: boolean;
  complete?: boolean;
  associated_bonding_curve?: string;
};

export type PumpCoinSample = {
  mint: string;
  name: string;
  symbol: string;
  createdTimestamp: number;
  usdMarketCap: number;
  /** Best available activity proxy -- there is no true volume field on this API. */
  athMarketCapUsd: number;
  replyCount: number;
  isBanned: boolean;
  graduated: boolean;
  /** The token account to exclude from holder-concentration math, when known. */
  associatedBondingCurve?: string;
};

export type SampleOpts = {
  /** Older bound: launches this many days ago or more are excluded. */
  daysAgoStart: number;
  /** Newer bound: launches must be at least this many days old to have had
   *  time to mature before being judged. */
  daysAgoEnd: number;
  maxPages: number;
  pageSize?: number;
  /** Also the point at which paging stops -- results are market-cap-sorted
   *  descending, so once a full page falls below this there is nothing
   *  higher left to find further out. */
  minUsdMarketCapToday?: number;
};

export type SampleResult = {
  coins: PumpCoinSample[];
  pagesScanned: number;
  coinsSeen: number;
};

/**
 * `ath_market_cap` is corrupted for some older/legacy tokens -- verified live
 * (e.g. a 623-day-old token reporting an ATH of ~2e23, several orders of
 * magnitude beyond any real token's history). Treat anything past a generous
 * real-world ceiling as unreliable and fall back to current market cap, which
 * was clean across every sample checked.
 */
const ATH_SANITY_CEILING_USD = 1_000_000_000;

export async function samplePumpLaunches(opts: SampleOpts): Promise<SampleResult> {
  const pageSize = opts.pageSize ?? 50;
  const newestAllowed = Date.now() - opts.daysAgoEnd * 86_400_000;
  const oldestAllowed = Date.now() - opts.daysAgoStart * 86_400_000;
  const minMcap = opts.minUsdMarketCapToday ?? 50_000;

  const out: PumpCoinSample[] = [];
  let offset = 0;
  let pagesScanned = 0;
  let coinsSeen = 0;

  for (; pagesScanned < opts.maxPages; pagesScanned++) {
    const url =
      `${PUMP_COINS}?offset=${offset}&limit=${pageSize}` +
      "&sort=market_cap&order=DESC&includeNsfw=true";

    let page: RawCoin[];
    try {
      page = await fetchJson<RawCoin[]>(url, {
        headers: { "user-agent": BROWSERISH },
        timeoutMs: 15_000,
        retries: 1,
      });
    } catch {
      break; // partial sample is fine; this is offline research, not a live gate
    }
    if (!page.length) break; // the API's own result ceiling, reached
    offset += page.length;
    coinsSeen += page.length;

    let pageMaxMcap = 0;
    for (const c of page) {
      const mcap = c.usd_market_cap ?? 0;
      pageMaxMcap = Math.max(pageMaxMcap, mcap);

      const created = c.created_timestamp ?? 0;
      if (created < oldestAllowed || created > newestAllowed) continue; // outside the age window
      if (!c.mint || c.is_banned) continue;
      if (mcap < minMcap) continue;

      const ath = c.ath_market_cap ?? mcap;
      const athMarketCapUsd = ath > ATH_SANITY_CEILING_USD ? mcap : ath;

      out.push({
        mint: c.mint,
        name: c.name ?? c.symbol ?? "",
        symbol: c.symbol ?? "",
        createdTimestamp: created,
        usdMarketCap: mcap,
        athMarketCapUsd,
        replyCount: c.reply_count ?? 0,
        isBanned: Boolean(c.is_banned),
        graduated: Boolean(c.complete),
        associatedBondingCurve: c.associated_bonding_curve,
      });
    }

    // Descending by market cap: once a full page falls below the floor,
    // every subsequent page will too.
    if (pageMaxMcap < minMcap) break;
  }

  return { coins: out, pagesScanned, coinsSeen };
}
