import type { Db } from "../util/db.ts";
import { isPretend, type Config } from "../config/schema.ts";
import { BudgetGuard } from "../risk/budget.ts";
import { KillSwitch } from "../risk/killswitch.ts";
import { buildCandidates, checkWarmup, historySpanMinutes } from "../scoring/score.ts";
import { PublicKey } from "@solana/web3.js";
import { computeCapacity } from "../risk/capacity.ts";
import { publishedWalletAddress } from "../chain/wallet.ts";
import { compileFilters, checkTerm } from "../scoring/filters.ts";
import { safeHttpUrl } from "../util/http.ts";
import { getBalanceSol } from "../chain/rpc.ts";
import { outcomeSummary, settledOutcomes } from "../learning/outcomes.ts";
import { tuningHistory } from "../learning/tuner.ts";
import { overlaySummary } from "../learning/overlay.ts";

/**
 * Read models for the dashboard.
 *
 * The public/admin split here is a security boundary, not a presentation
 * choice. `publicSnapshot` must never include anything that would let a reader
 * act against the bot -- above all the pre-launch candidate queue, which is the
 * bot's entire edge. Publishing "we are about to launch X" in real time is an
 * invitation to be front-run by anyone watching the page.
 */

const MINUTE = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export type StatusPill = "dry-run" | "halted" | "warming-up" | "live";

export type PublicSnapshot = ReturnType<typeof publicSnapshot>;
export type AdminSnapshot = ReturnType<typeof adminSnapshot>;

function mode(cfg: Config): 0 | 1 {
  return isPretend(cfg) ? 1 : 0;
}

export function statusOf(db: Db, cfg: Config, kill: KillSwitch): {
  pill: StatusPill; label: string; detail: string;
} {
  if (kill.isHalted()) {
    return {
      pill: "halted",
      label: "Paused",
      detail: kill.haltReason() ?? "New launches are stopped. Open positions can still be sold.",
    };
  }
  if (cfg.dryRun) {
    return {
      pill: "dry-run",
      label: "Practice mode",
      detail: "Running the full pipeline without spending any real money.",
    };
  }
  const warm = checkWarmup(db, cfg.scoring);
  if (!warm.warm) {
    return {
      pill: "warming-up",
      label: "Warming up",
      detail: `Watching for ${Math.round(cfg.scoring.warmupMinutes - warm.spanMinutes)} more minutes before it can launch anything.`,
    };
  }
  return { pill: "live", label: "Live", detail: "Watching trends and launching when one qualifies." };
}

/** Headline counters, in plain units. */
/**
 * Net profit to date, computed rather than approximated.
 *
 * `dev_buy`/`dev_sell` spend_ledger rows are deliberately NOT summed here --
 * they are already netted inside `positions.realized_pnl_sol` via
 * entry_sol/exit_sol, so adding them again would double-count. The only
 * spend not captured inside a position is the `'launch'` kind (creation
 * rent/protocol fee, booked net of the dev buy) and the declared-but-not-yet
 * -written `'tx_fee'` kind, kept for forward compatibility.
 *
 * This is strictly smaller than the client-side sums the dashboard has shown
 * historically (`estimatedFeeSol + realisedPnlSol`), which never subtracted
 * launch-creation spend at all.
 */
export function profitSummary(db: Db, cfg: Config) {
  const m = mode(cfg);

  const feesTotalSol = (db.prepare(
    `SELECT COALESCE(SUM(sol_amount), 0) s FROM fee_claims WHERE dry_run = ?`,
  ).get(m) as { s: number }).s;

  const realisedPnlSol = (db.prepare(
    `SELECT COALESCE(SUM(realized_pnl_sol), 0) p FROM positions WHERE status = 'closed' AND dry_run = ?`,
  ).get(m) as { p: number }).p;

  // Already negative.
  const uncapturedSpendSol = (db.prepare(
    `SELECT COALESCE(SUM(sol_delta), 0) s FROM spend_ledger WHERE dry_run = ? AND kind IN ('launch', 'tx_fee')`,
  ).get(m) as { s: number }).s;

  return {
    feesTotalSol,
    realisedPnlSol,
    uncapturedSpendSol,
    netProfitSol: feesTotalSol + realisedPnlSol + uncapturedSpendSol,
  };
}

export function headlineStats(db: Db, cfg: Config) {
  const m = mode(cfg);
  const since = Date.now() - DAY;

  const launches24h = (db.prepare(
    `SELECT COUNT(*) n FROM launches WHERE dry_run = ? AND created_at > ?`,
  ).get(m, since) as { n: number }).n;

  const launchesTotal = (db.prepare(
    `SELECT COUNT(*) n FROM launches WHERE dry_run = ?`,
  ).get(m) as { n: number }).n;

  const feesTotal = (db.prepare(
    `SELECT COALESCE(SUM(sol_amount), 0) s FROM fee_claims WHERE dry_run = ?`,
  ).get(m) as { s: number }).s;

  const openPositions = (db.prepare(
    `SELECT COUNT(*) n FROM positions WHERE status = 'open' AND dry_run = ?`,
  ).get(m) as { n: number }).n;

  const realised = db.prepare(
    `SELECT COALESCE(SUM(realized_pnl_sol), 0) pnl, COUNT(*) n,
            COALESCE(SUM(CASE WHEN realized_pnl_sol > 0 THEN 1 ELSE 0 END), 0) wins
       FROM positions WHERE status = 'closed' AND dry_run = ?`,
  ).get(m) as { pnl: number; n: number; wins: number };

  const signals24h = (db.prepare(
    `SELECT COUNT(*) n FROM signals WHERE ingested_at > ?`,
  ).get(since) as { n: number }).n;

  const termsTracked = (db.prepare(
    `SELECT COUNT(DISTINCT norm) n FROM signals WHERE ingested_at > ?`,
  ).get(since) as { n: number }).n;

  // The authoritative net figure, not fees+P&L. Both dashboards used to add
  // those two client-side, which silently omitted the rent and protocol fee
  // of every launch ever made and so overstated profit.
  const profit = profitSummary(db, cfg);

  return {
    launches24h,
    launchesTotal,
    feesTotalSol: feesTotal,
    openPositions,
    closedPositions: realised.n,
    realisedPnlSol: realised.pnl,
    winRate: realised.n > 0 ? realised.wins / realised.n : null,
    signals24h,
    termsTracked,
    launchSpendSol: profit.uncapturedSpendSol,
    netProfitSol: profit.netProfitSol,
  };
}

export function recentLaunches(db: Db, cfg: Config, limit = 24) {
  // Outcome fields are joined in for the public page too: a token's peak
  // market cap and whether it graduated are public facts on pump.fun, so
  // showing them leaks nothing -- and honesty about duds is the point.
  const rows = db.prepare(
    `SELECT l.mint, l.name, l.symbol, l.term, l.score, l.feeds, l.created_at, l.signature,
            l.source_url,
            p.status AS pos_status, p.entry_sol, p.realized_pnl_sol, p.exit_reason,
            o.verdict AS o_verdict, o.peak_mcap_usd AS o_peak
       FROM launches l
       LEFT JOIN positions p ON p.mint = l.mint
       LEFT JOIN launch_outcomes o ON o.mint = l.mint
      WHERE l.dry_run = ?
      ORDER BY l.created_at DESC
      LIMIT ?`,
  ).all(mode(cfg), limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    mint: String(r.mint),
    name: String(r.name),
    symbol: String(r.symbol),
    term: String(r.term),
    score: Number(r.score ?? 0),
    feeds: safeParseArray(r.feeds),
    createdAt: Number(r.created_at),
    signature: r.signature ? String(r.signature) : null,
    outcome: r.o_verdict
      ? { verdict: String(r.o_verdict), peakMcapUsd: Number(r.o_peak ?? 0) }
      : null,
    position: r.pos_status
      ? {
          status: String(r.pos_status),
          entrySol: Number(r.entry_sol ?? 0),
          pnlSol: r.realized_pnl_sol == null ? null : Number(r.realized_pnl_sol),
          exitReason: r.exit_reason ? String(r.exit_reason) : null,
        }
      : null,
    // Solscan over pump.fun: the tx hash is the actual on-chain proof of the
    // launch, not just a link to pump.fun's UI for the mint. Falls back to
    // the mint's token page when there's no signature yet (pretend-mode
    // launches never get one), so "peek" never dead-ends on solscan.io.
    url: r.signature
      ? `https://solscan.io/tx/${String(r.signature)}${cfg.network !== "mainnet-beta" ? `?cluster=${cfg.network}` : ""}`
      : `https://solscan.io/token/${String(r.mint)}${cfg.network !== "mainnet-beta" ? `?cluster=${cfg.network}` : ""}`,
    // Re-validated on read, not trusted from storage -- same discipline as
    // readingList()'s r.url: rows written before a scheme check existed (or
    // by any future bug in the write path) must not become clickable now.
    sourceUrl: r.source_url ? safeHttpUrl(String(r.source_url)) : null,
  }));
}

/** Which sources are actually producing, and how recently. */
export function feedHealth(db: Db, cfg: Config) {
  const since = Date.now() - HOUR;
  const rows = db.prepare(
    `SELECT feed, COUNT(*) n, MAX(ingested_at) last
       FROM signals WHERE ingested_at > ? GROUP BY feed`,
  ).all(since) as Array<{ feed: string; n: number; last: number }>;

  const byFeed = new Map(rows.map((r) => [r.feed, r]));

  return Object.entries(cfg.feeds).map(([id, fc]) => {
    const row = byFeed.get(id);
    return {
      id,
      enabled: fc.enabled,
      weight: fc.weight,
      signalsLastHour: row?.n ?? 0,
      lastSeen: row?.last ?? null,
      healthy: fc.enabled ? (row?.n ?? 0) > 0 : null,
    };
  });
}

/** Hourly signal volume for the sparkline. */
export function signalSeries(db: Db, hours = 48) {
  const start = Date.now() - hours * HOUR;
  const rows = db.prepare(
    `SELECT CAST((ingested_at - ?) / ? AS INTEGER) bucket, COUNT(*) n
       FROM signals WHERE ingested_at > ? GROUP BY bucket ORDER BY bucket`,
  ).all(start, HOUR, start) as Array<{ bucket: number; n: number }>;

  const series = new Array<number>(hours).fill(0);
  for (const r of rows) {
    if (r.bucket >= 0 && r.bucket < hours) series[r.bucket] = r.n;
  }
  return { startMs: start, stepMs: HOUR, values: series };
}

/** Cumulative realised P&L over closed positions, oldest first. */
export function pnlSeries(db: Db, cfg: Config, limit = 60) {
  const rows = db.prepare(
    `SELECT closed_at, realized_pnl_sol FROM positions
      WHERE status = 'closed' AND dry_run = ? AND closed_at IS NOT NULL
      ORDER BY closed_at ASC LIMIT ?`,
  ).all(mode(cfg), limit) as Array<{ closed_at: number; realized_pnl_sol: number }>;

  let running = 0;
  return rows.map((r) => {
    running += r.realized_pnl_sol ?? 0;
    return { t: r.closed_at, cumulative: running, delta: r.realized_pnl_sol ?? 0 };
  });
}

/** Where launches came from, as a share of the total. */
export function feedAttribution(db: Db, cfg: Config) {
  const rows = db.prepare(
    `SELECT feeds FROM launches WHERE dry_run = ?`,
  ).all(mode(cfg)) as Array<{ feeds: string }>;

  const tally = new Map<string, number>();
  for (const r of rows) {
    for (const f of safeParseArray(r.feeds)) {
      tally.set(f, (tally.get(f) ?? 0) + 1);
    }
  }
  return [...tally.entries()]
    .map(([feed, count]) => ({ feed, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * The gate funnel over the window: how many rumours came in, and where each
 * one died. Summed across ticks, so it reads as "today's attrition".
 */
export function pipelineFunnel(db: Db, cfg: Config, hours = 24) {
  const r = db.prepare(
    `SELECT COALESCE(SUM(sniffed),0) sniffed, COALESCE(SUM(phrases),0) phrases,
            COALESCE(MAX(terms),0) terms, COALESCE(MAX(warm),0) warm,
            COALESCE(SUM(scored),0) scored, COALESCE(SUM(examined),0) examined,
            COALESCE(SUM(clean),0) clean,
            COALESCE(SUM(uncrowded),0) uncrowded, COALESCE(SUM(affordable),0) affordable,
            COALESCE(SUM(launched),0) launched, COUNT(*) ticks
       FROM pipeline_stats WHERE dry_run = ? AND ts > ?`,
  ).get(mode(cfg), Date.now() - hours * HOUR) as Record<string, number>;

  const activeFeeds = feedHealth(db, cfg).filter((f) => f.enabled && f.signalsLastHour > 0).length;
  const totalFeeds = Object.values(cfg.feeds).filter((f) => f.enabled).length;

  // Drop lines are phrased as what was LOST at each gate, which is the number
  // that actually explains where the day went.
  const unexamined = Math.max(0, (r.scored ?? 0) - (r.examined ?? 0));
  // Aggregate count only -- no terms, so this is safe to publish live even
  // though the decline LIST is held back.
  const crowdedOut = Math.max(0, (r.clean ?? 0) - (r.uncrowded ?? 0));

  return {
    ticks: r.ticks ?? 0,
    examined: r.examined ?? 0,
    unexamined,
    crowdedOut,
    gates: [
      { idx: 1, label: "Sniffed", pass: r.sniffed ?? 0, unit: "rumours",
        drop: `${activeFeeds} of ${totalFeeds} noses reporting` },
      { idx: 2, label: "Different topics", pass: r.phrases ?? 0, unit: "phrases",
        drop: "chopped into comparable key phrases" },
      { idx: 3, label: "Seen enough", pass: r.warm ?? 0, unit: "warm",
        drop: `spotted fewer than ${cfg.scoring.minObservations} times = ignored` },
      { idx: 4, label: `Score over ${Math.round(cfg.scoring.threshold)}`, pass: r.scored ?? 0, unit: "tasty",
        drop: unexamined > 0
          ? `${unexamined} never got looked at — the allowance ran out first`
          : "too slow, too crowded a source, or too quiet" },
      // Measured against `examined`, not `scored`: the loop stops looking once
      // the allowance is gone, and reporting the unexamined remainder as
      // rejections would be a flattering lie.
      { idx: 5, label: "Not naughty", pass: r.clean ?? 0, unit: "clean",
        drop: `${Math.max(0, (r.examined ?? 0) - (r.clean ?? 0))} of ${r.examined ?? 0} looked at were a real brand, person, or tragedy` },
      { idx: 6, label: "Nobody there first", pass: r.uncrowded ?? 0, unit: "uncrowded", jam: true,
        drop: `${Math.max(0, (r.clean ?? 0) - (r.uncrowded ?? 0))} already minted by someone else. This is the gate that hurts.` },
      { idx: 7, label: "Can afford it", pass: r.affordable ?? 0, unit: "in budget",
        drop: `${Math.max(0, (r.uncrowded ?? 0) - (r.affordable ?? 0))} hit the daily allowance` },
      { idx: 8, label: "Burped a coin", pass: r.launched ?? 0, unit: "coins", win: true,
        drop: `${Math.max(0, (r.affordable ?? 0) - (r.launched ?? 0))} flopped on chain` },
    ],
  };
}

const DECLINE_LABEL: Record<string, { text: string; tone: string }> = {
  crowded: { text: "SOMEONE GOT THERE FIRST", tone: "pink" },
  trademark: { text: "REAL BRAND OR PERSON", tone: "sun" },
  tragedy: { text: "TRAGEDY", tone: "sun" },
  slur: { text: "FOUL LANGUAGE", tone: "sun" },
  operator: { text: "ON YOUR BLOCKLIST", tone: "sun" },
  budget: { text: "ALLOWANCE GONE", tone: "milk" },
  brand: { text: "REAL BRAND", tone: "sun" },
  person: { text: "REAL PERSON", tone: "sun" },
};

/**
 * Collapse repeat rows so one recurring term cannot fill every slot in a
 * small display list.
 *
 * `checkSaturation`'s free self-dedupe check (src/scoring/saturation.ts)
 * correctly re-declines an already-launched term every single tick, forever
 * -- that is intentional and free, but a trending topic (or a term someone
 * keeps posting about) can dominate the raw `declined` table with dozens of
 * identical rows, crowding out everything else in an operator-facing list.
 * `rows` must already be ordered newest first, so the first occurrence seen
 * for a key is the one whose fields are kept.
 */
function collapseRepeats<T extends { ts: number }>(
  rows: T[],
  keyOf: (row: T) => string,
  limit: number,
): Array<T & { count: number }> {
  const groups = new Map<string, T & { count: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const existing = groups.get(key);
    if (existing) existing.count++;
    else groups.set(key, { ...row, count: 1 });
  }
  return [...groups.values()].slice(0, limit);
}

/** Appends a "(×N)" marker to a display note when a row stands in for more than one collapsed repeat. */
function suffixCount(note: string, count: number): string {
  return count > 1 ? `${note} (×${count})` : note;
}

/**
 * Recently declined candidates.
 *
 * `delayMinutes` exists because a live rejection feed still leaks what the bot
 * is looking at right now. Delayed, it becomes an honest record of judgement
 * rather than a tip sheet. Admin passes 0; the public page does not.
 *
 * Fetches a wider raw window than `limit` and collapses same-term-and-reason
 * repeats (keyed on `norm`, the already-normalized column, not raw `term`
 * text) before slicing, so `limit` distinct decisions are returned rather
 * than `limit` rows that might all be the same decision repeated.
 */
export function recentDeclines(db: Db, cfg: Config, delayMinutes: number, limit = 8) {
  const fetchLimit = Math.min(limit * 8, 200);
  const rows = db.prepare(
    `SELECT term, norm, reason, detail, score, ts FROM declined
      WHERE dry_run = ? AND ts < ?
      ORDER BY ts DESC LIMIT ?`,
  ).all(mode(cfg), Date.now() - delayMinutes * MINUTE, fetchLimit) as Array<Record<string, unknown>>;

  const mapped = rows.map((r) => ({
    term: String(r.term),
    norm: String(r.norm ?? r.term),
    reason: String(r.reason),
    detail: String(r.detail ?? ""),
    score: Number(r.score ?? 0),
    ts: Number(r.ts),
  }));

  return collapseRepeats(mapped, (r) => `${r.norm}\u0000${r.reason}`, limit).map((r) => {
    const meta = DECLINE_LABEL[r.reason] ?? { text: r.reason.toUpperCase(), tone: "milk" };
    return {
      term: r.term,
      reason: meta.text,
      tone: meta.tone,
      detail: r.detail,
      score: r.score,
      ts: r.ts,
      count: r.count,
    };
  });
}

/** Fee claims. Measured, not estimated -- the honest counterpart to per-token splits. */
export function feeClaims(db: Db, cfg: Config, limit = 6) {
  const rows = db.prepare(
    `SELECT ts, sol_amount, signature FROM fee_claims
      WHERE dry_run = ? ORDER BY ts DESC LIMIT ?`,
  ).all(mode(cfg), limit) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const ts = Number(r.ts);
    // How many launches existed when the claim landed: the bulk claim covered them.
    const tokens = (db.prepare(
      `SELECT COUNT(*) n FROM launches WHERE dry_run = ? AND created_at < ?`,
    ).get(mode(cfg), ts) as { n: number }).n;
    return {
      ts,
      sol: Number(r.sol_amount ?? 0),
      tokens,
      signature: r.signature ? String(r.signature) : null,
    };
  });
}

/**
 * Dev wallet address and balance.
 *
 * Balance is cached: the SSE loop pushes every few seconds and an RPC round trip
 * per push would be wasteful and rate-limited. Fifteen seconds of staleness on a
 * displayed balance costs nothing.
 */
let walletCache: { at: number; sol: number | null } = { at: 0, sol: null };
const WALLET_TTL_MS = 15_000;

export type WalletView = {
  address: string | null;
  balanceSol: number | null;
  explorerUrl: string | null;
  /** pump.fun's own creator-rewards tab for this wallet -- where claimed and
   *  claimable creator fees actually live. Null until an address is published. */
  creatorRewardsUrl: string | null;
  network: string;
};

export type ProjectTokenView = {
  mint: string;
  pumpFunUrl: string;
  solscanUrl: string;
};

/**
 * The project's own token, if configured.
 *
 * Hardcoded URL templates around an operator-supplied mint, so invariant 11
 * (safeHttpUrl on third-party URLs) does not apply -- there is no
 * stranger-supplied URL here. The mint is still validated against Solana's
 * base58 address shape so a malformed config value cannot produce a broken
 * or misleading link.
 */
export function projectTokenView(cfg: Config): ProjectTokenView | null {
  const mint = cfg.web.projectTokenMint.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return null;
  return {
    mint,
    pumpFunUrl: `https://pump.fun/coin/${mint}`,
    solscanUrl: `https://solscan.io/token/${mint}`,
  };
}

/** Human names for the sources, so the page never shows a config key. */
export const SOURCE_NAMES: Record<string, string> = {
  googleTrends: "Google Trends",
  googleNews: "Google News",
  hackernews: "Hacker News",
  wikipedia: "Wikipedia",
  reddit: "Reddit",
  fourchan: "4chan /biz/",
  polymarket: "Polymarket",
  farcaster: "Farcaster",
  onchain: "pump.fun",
  xApi: "X",
};

/**
 * What the bot is currently reading, newest first.
 *
 * **Chronological and unranked, deliberately.** These are public feeds anyone
 * can open, so showing them leaks nothing — the edge is in the scoring, not in
 * knowing that Google News exists. Ordering them by score, though, would
 * publish exactly which topics are near the launch line, so they are never
 * sorted by anything but time.
 *
 * Filtered on slurs ONLY, not on the full launch filters. Those exist to stop
 * the bot *minting* a brand or a tragedy, which is a legal question about
 * issuing a token. A news headline about a company or a disaster is just news,
 * and stripping it would misrepresent what the bot actually reads.
 */
export function readingList(db: Db, cfg: Config, limit = 40) {
  const rows = db.prepare(
    `SELECT feed, term, source_text, url, meta, ingested_at, observed_at
       FROM signals
      WHERE url IS NOT NULL AND url != '' AND ingested_at > ?
      ORDER BY ingested_at DESC, observed_at DESC
      LIMIT ?`,
  ).all(Date.now() - 6 * HOUR, limit * 6) as Array<Record<string, unknown>>;

  const displayFilters = compileFilters({
    ...cfg.filters,
    blockTrademarks: false,
    blockTragedy: false,
    blockLikelyPersonNames: false,
  });

  const seen = new Set<string>();
  const out: Array<{
    feed: string; source: string; publisher: string | null;
    text: string; url: string; at: number;
  }> = [];

  for (const r of rows) {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(String(r.meta ?? "{}")); } catch { /* ignore */ }

    // Prefer the source's own words; fall back to the extracted phrase for rows
    // written before source_text existed.
    const headline = typeof meta.headline === "string" && meta.headline.length > 12
      ? meta.headline
      : null;
    const text = String(r.source_text || headline || r.term || "").trim();
    if (!text || text.length < 4) continue;

    // Re-checked on read as well as on write: rows stored before the scheme
    // check existed must not become clickable now.
    const safeUrl = safeHttpUrl(r.url);
    if (!safeUrl) continue;

    // One entry per link: several phrases are extracted from one article.
    const key = safeUrl;
    if (seen.has(key)) continue;

    if (!checkTerm(text, displayFilters).allowed) continue;

    const feed = String(r.feed);
    seen.add(key);
    out.push({
      feed,
      source: SOURCE_NAMES[feed] ?? feed,
      publisher:
        typeof meta.source === "string" && meta.source ? meta.source :
        typeof meta.subreddit === "string" && meta.subreddit ? `r/${meta.subreddit}` :
        typeof meta.author === "string" && meta.author ? `@${meta.author}` : null,
      text: text.slice(0, 150),
      url: safeUrl,
      at: Number(r.ingested_at),
    });
    if (out.length >= limit) break;
  }

  return out;
}

/** Signals per feed over a window, for the gate-1 breakdown. */
function signalsByFeed(db: Db, hours: number) {
  const rows = db.prepare(
    `SELECT feed, COUNT(*) n, COUNT(DISTINCT norm) terms
       FROM signals WHERE ingested_at > ? GROUP BY feed ORDER BY n DESC`,
  ).all(Date.now() - hours * HOUR) as Array<{ feed: string; n: number; terms: number }>;
  return rows;
}

/** Buckets, never raw terms: a live score list would say what is about to launch. */
function scoreHistogram(db: Db, cfg: Config) {
  const m = mode(cfg);
  const since = Date.now() - 7 * 24 * HOUR;
  const decided = [
    ...(db.prepare(`SELECT score FROM declined WHERE dry_run = ? AND ts > ?`)
      .all(m, since) as Array<{ score: number }>),
    ...(db.prepare(`SELECT score FROM launches WHERE dry_run = ? AND created_at > ?`)
      .all(m, since) as Array<{ score: number }>),
  ].map((r) => Number(r.score ?? 0)).filter((n) => n > 0);

  const buckets = [
    { label: "under 50", lo: 0, hi: 50 },
    { label: "50-60", lo: 50, hi: 60 },
    { label: "60-65", lo: 60, hi: 65 },
    { label: "65-70", lo: 65, hi: 70 },
    { label: "70-80", lo: 70, hi: 80 },
    { label: "80+", lo: 80, hi: Infinity },
  ];
  return buckets.map((b) => ({
    label: b.label,
    n: decided.filter((s) => s >= b.lo && s < b.hi).length,
    aboveLine: b.lo >= cfg.scoring.threshold,
  }));
}

/** Competitor counts parsed out of the saturation reason we already stored. */
export function crowdedDetail(db: Db, cfg: Config, delayMinutes: number, limit = 10) {
  const fetchLimit = Math.min(limit * 8, 200);
  const rows = db.prepare(
    `SELECT term, norm, detail, ts FROM declined
      WHERE dry_run = ? AND reason = 'crowded' AND ts < ?
      ORDER BY ts DESC LIMIT ?`,
  ).all(mode(cfg), Date.now() - delayMinutes * MINUTE, fetchLimit) as Array<Record<string, unknown>>;

  const mapped = rows.map((r) => ({
    term: String(r.term),
    norm: String(r.norm ?? r.term),
    detail: String(r.detail ?? ""),
    ts: Number(r.ts),
  }));

  return collapseRepeats(mapped, (r) => r.norm, limit).map((r) => {
    const m = r.detail.match(/^(\d+) similar/);
    return {
      term: r.term,
      rivals: m ? Number(m[1]) : null,
      ts: r.ts,
      count: r.count,
    };
  });
}

/**
 * Per-gate depth for the pipeline.
 *
 * The disclosure rule is the same one that governs the decline list: aggregate
 * numbers publish live, but anything that NAMES a term the bot is currently
 * weighing is held back, because that is a launch tip. Gates 1-4 are therefore
 * statistical; gates 5-7 name terms only from the delayed record; gate 8 is
 * already fully public because the tokens exist on chain.
 */
export function gateDetails(db: Db, cfg: Config, delayMinutes: number) {
  const f = pipelineFunnel(db, cfg);
  const g = (i: number) => f.gates[i];
  const declines = recentDeclines(db, cfg, delayMinutes, 40);
  const byFeed = signalsByFeed(db, 24);
  const totalSignals = byFeed.reduce((n, r) => n + r.n, 0);

  const contentReasons = new Set(["REAL BRAND OR PERSON", "TRAGEDY", "FOUL LANGUAGE", "ON YOUR BLOCKLIST"]);

  return [
    {
      idx: 1,
      title: "Sniffed",
      what: "Every mention pulled from every source in the last 24 hours, before any filtering.",
      why: "Ten independent sources are polled on their own schedules. One noisy board can dominate the raw count without meaning much — which is exactly why agreement across families is scored later.",
      stats: [
        { label: "Mentions collected", value: g(0)?.pass ?? 0 },
        { label: "Distinct sources reporting", value: byFeed.length },
      ],
      bars: byFeed.map((r) => ({
        label: SOURCE_NAMES[r.feed] ?? r.feed,
        n: r.n,
        pct: totalSignals > 0 ? (r.n / totalSignals) * 100 : 0,
        note: `${r.terms} distinct topics`,
      })),
      links: readingList(db, cfg, 8),
      delayed: false,
    },
    {
      idx: 2,
      title: "Different topics",
      what: "Raw mentions chopped into comparable key phrases, so a Reddit headline and a Google search term can be recognised as the same subject.",
      why: "Sources disagree about shape. Google Trends gives a bare term, Reddit gives a whole sentence. Without reducing both to the same key, cross-source agreement could never be detected at all.",
      stats: [
        { label: "Mentions in", value: g(0)?.pass ?? 0 },
        { label: "Key phrases out", value: g(1)?.pass ?? 0 },
        {
          label: "Phrases per mention",
          value: (g(0)?.pass ?? 0) > 0 ? ((g(1)?.pass ?? 0) / (g(0)?.pass ?? 1)).toFixed(2) : "0",
        },
      ],
      delayed: false,
    },
    {
      idx: 3,
      title: "Seen enough",
      what: `A topic must be spotted at least ${cfg.scoring.minObservations} times before it is trusted.`,
      why: "Speed is measured by comparing recent activity against earlier activity. A topic seen exactly once has no earlier half to compare against, so it looks maximally fast — which is how a freshly started bot would launch on pure noise.",
      stats: [
        { label: "Topics tracked", value: g(2)?.pass ?? 0 },
        { label: "Sightings needed", value: cfg.scoring.minObservations },
        { label: "Warmup required", value: `${cfg.scoring.warmupMinutes} min` },
      ],
      delayed: false,
    },
    {
      idx: 4,
      title: `Score over ${Math.round(cfg.scoring.threshold)}`,
      what: "Each topic gets a score out of 100 from how fast it is growing, how independent its sources are, whether a memecoin crowd would care, and whether it makes a usable ticker.",
      why: "Not how big a topic is — how fast it is growing. Something already huge usually has forty coins chasing it.",
      stats: [
        { label: "Threshold", value: Math.round(cfg.scoring.threshold) },
        { label: "Speed weight", value: `${Math.round(cfg.scoring.weights.velocity * 100)}%` },
        { label: "Source independence", value: `${Math.round(cfg.scoring.weights.corroboration * 100)}%` },
        { label: "Crowd appeal", value: `${Math.round(cfg.scoring.weights.cryptoAffinity * 100)}%` },
      ],
      histogram: scoreHistogram(db, cfg),
      note: "Scores of topics already decided on, over the last 7 days. The live queue is not shown — publishing what is currently near the line would let anyone jump ahead of a launch.",
      delayed: false,
    },
    {
      idx: 5,
      title: "Not naughty",
      what: "Real brands, real people, tragedies and slurs are rejected before a single lamport is spent.",
      why: "Minting a trending brand invites a trademark claim and a takedown; minting a disaster gets the coin removed, which kills the fee stream that is the entire point. A rejected topic costs nothing. A rejected launch costs rent, fees and possibly a lawyer.",
      stats: [
        { label: "Passed clean", value: g(4)?.pass ?? 0 },
        { label: "Turned away", value: declines.filter((d) => contentReasons.has(d.reason)).length },
      ],
      rows: declines
        .filter((d) => contentReasons.has(d.reason))
        .slice(0, 10)
        .map((d) => ({ term: d.term, note: suffixCount(d.reason, d.count), tone: d.tone })),
      delayed: true,
    },
    {
      idx: 6,
      title: "Nobody there first",
      what: "If other people have already minted coins for this trend, it skips.",
      why: "Fees are a share of THIS coin's trading. When forty coins chase one trend the volume fragments and a launch earns nothing — while still paying rent and priority fees. This is the gate that turns away the most promising-looking topics, and skipping is almost always the right call.",
      stats: [
        { label: "Uncrowded", value: g(5)?.pass ?? 0 },
        { label: "Already taken", value: f.crowdedOut ?? 0 },
        { label: "Rival limit", value: cfg.saturation.maxSimilar },
      ],
      rows: crowdedDetail(db, cfg, delayMinutes).map((c) => ({
        term: c.term,
        note: suffixCount(c.rivals != null ? `${c.rivals} rival coins` : "already minted", c.count),
        tone: "pink",
      })),
      delayed: true,
    },
    {
      idx: 7,
      title: "Can afford it",
      what: "A hard daily ceiling on launches and on SOL, checked before every transaction.",
      why: "The limits are enforced in one place that every spending path must pass through. A bug in the trend loop cannot spend past them.",
      stats: [
        { label: "Launches allowed / day", value: cfg.risk.maxLaunchesPerDay },
        { label: "SOL allowed / day", value: cfg.risk.maxSolPerDay },
        { label: "Buys of each coin", value: cfg.devPosition.enabled ? `${cfg.devPosition.buySol} SOL` : "nothing" },
        { label: "Stops after losses of", value: `${cfg.risk.maxDailyLossSol} SOL` },
      ],
      rows: declines
        .filter((d) => d.reason === "ALLOWANCE GONE")
        .slice(0, 6)
        .map((d) => ({ term: d.term, note: suffixCount("allowance already spent", d.count), tone: "milk" })),
      delayed: true,
    },
    {
      idx: 8,
      title: "Burped a coin",
      what: "What survived every gate and was actually minted, duds included.",
      why: "The list below is the honest record. Most launches earn nothing — that is the base rate of this whole idea, not a malfunction.",
      stats: [
        { label: "Coins created", value: g(7)?.pass ?? 0 },
        { label: "Still held", value: headlineStats(db, cfg).openPositions },
      ],
      note: "Every coin is listed further down this page with its peak market cap and result.",
      delayed: false,
    },
  ];
}

/**
 * Refresh the cached balance. Async, so the caller decides when to pay for it;
 * the snapshot readers stay synchronous and never block the SSE push loop.
 */
export async function refreshWallet(db: Db, cfg: Config): Promise<void> {
  const address = publishedWalletAddress(db);
  if (!address) return;
  if (Date.now() - walletCache.at < WALLET_TTL_MS) return;
  try {
    walletCache = { at: Date.now(), sol: await getBalanceSol(cfg, new PublicKey(address)) };
  } catch {
    // Keep the last known figure rather than flashing a zero on an RPC blip.
    walletCache = { at: Date.now(), sol: walletCache.sol };
  }
}

/** Synchronous read of whatever `refreshWallet` last fetched. */
export function walletView(db: Db, cfg: Config): WalletView {
  const address = publishedWalletAddress(db);
  if (!address) {
    return {
      address: null, balanceSol: null, explorerUrl: null, creatorRewardsUrl: null,
      network: cfg.network,
    };
  }
  const cluster = cfg.network === "mainnet-beta" ? "" : `?cluster=${cfg.network}`;
  return {
    address,
    balanceSol: walletCache.sol,
    explorerUrl: `https://solscan.io/account/${address}${cluster}`,
    creatorRewardsUrl: `https://pump.fun/profile/${address}?tab=creator-rewards`,
    network: cfg.network,
  };
}

/** Seconds until the soonest feed is next due, for the countdown chip. */
export function nextPollSeconds(db: Db, cfg: Config): number {
  const row = db.prepare(`SELECT MAX(ingested_at) last FROM signals`).get() as { last: number | null };
  if (!row.last) return 0;
  const soonest = Math.min(
    ...Object.values(cfg.feeds).filter((f) => f.enabled).map((f) => f.pollSeconds),
  );
  const due = row.last + soonest * 1000;
  return Math.max(0, Math.round((due - Date.now()) / 1000));
}

/**
 * Everything the public page may see.
 *
 * Deliberately excludes: the candidate queue, wallet balance and address,
 * budget headroom, raw config, and the spend ledger.
 */
export function publicSnapshot(db: Db, cfg: Config, kill: KillSwitch) {
  return {
    at: Date.now(),
    status: statusOf(db, cfg, kill),
    network: cfg.network,
    dryRun: cfg.dryRun,
    stats: headlineStats(db, cfg),
    funnel: pipelineFunnel(db, cfg),
    // Public sees declines only after a delay -- see recentDeclines().
    declines: recentDeclines(db, cfg, cfg.web.declineDelayMinutes),
    declineDelayMinutes: cfg.web.declineDelayMinutes,
    gateDetails: gateDetails(db, cfg, cfg.web.declineDelayMinutes),
    reading: readingList(db, cfg, 24),
    claims: feeClaims(db, cfg),
    nextPollSeconds: nextPollSeconds(db, cfg),
    launchesToday: headlineStats(db, cfg).launches24h,
    // Address and balance are already public on-chain; `web.showWallet` exists
    // so the operator can decline to advertise capacity anyway.
    wallet: cfg.web.showWallet ? walletView(db, cfg) : null,
    // Runway is a wallet fact, so it is only known in live mode.
    capacityRunwayDays: cfg.risk.adaptive.enabled && !cfg.dryRun
      ? `${cfg.risk.adaptive.minRunwayDays}d` : null,
    launches: recentLaunches(db, cfg, 24),
    projectToken: projectTokenView(cfg),
    feeds: feedHealth(db, cfg).map(({ id, enabled, signalsLastHour, lastSeen, healthy }) => ({
      id, enabled, signalsLastHour, lastSeen, healthy,
    })),
    signalSeries: signalSeries(db, 48),
    pnlSeries: pnlSeries(db, cfg),
    attribution: feedAttribution(db, cfg),
    // Explains the machine in the reader's terms, driven by real config.
    rules: {
      maxLaunchesPerDay: computeCapacity(db, cfg).launchesPerDay,
      devBuySol: cfg.devPosition.enabled ? cfg.devPosition.buySol : 0,
      takeProfitMultiple: cfg.devPosition.exit.takeProfitMultiple,
      maxHoldMinutes: cfg.devPosition.exit.maxHoldMinutes,
      stopLossPct: cfg.devPosition.exit.stopLossPct,
    },
  };
}

/** Open positions with live-ish context. Admin only: this is money detail. */
export function openPositions(db: Db, cfg: Config) {
  const rows = db.prepare(
    `SELECT id, mint, symbol, entry_sol, entry_tokens, entry_price, opened_at,
            sell_attempts, last_error, status
       FROM positions WHERE status IN ('open','stuck') AND dry_run = ?
      ORDER BY opened_at ASC`,
  ).all(mode(cfg)) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    id: Number(r.id),
    mint: String(r.mint),
    symbol: String(r.symbol ?? ""),
    entrySol: Number(r.entry_sol),
    entryTokens: Number(r.entry_tokens),
    openedAt: Number(r.opened_at),
    ageMinutes: (Date.now() - Number(r.opened_at)) / 60_000,
    status: String(r.status),
    sellAttempts: Number(r.sell_attempts ?? 0),
    lastError: r.last_error ? String(r.last_error) : null,
    url: `https://pump.fun/coin/${String(r.mint)}`,
  }));
}

/**
 * Memo for the candidate queue: scoring is a full signals scan and the SSE
 * push loop asks every few seconds. Ten seconds of staleness on a display
 * surface costs nothing; the launch path never reads this cache.
 */
let queueMemo: { at: number; rows: ReturnType<typeof computeQueue> } | undefined;
const QUEUE_MEMO_TTL_MS = 10_000;

/** The pre-launch queue. Admin only -- see the note at the top of this file. */
export function candidateQueue(db: Db, cfg: Config, limit = 20) {
  if (queueMemo && Date.now() - queueMemo.at < QUEUE_MEMO_TTL_MS) {
    return queueMemo.rows.slice(0, limit);
  }
  const rows = computeQueue(db, cfg, limit);
  queueMemo = { at: Date.now(), rows };
  return rows;
}

function computeQueue(db: Db, cfg: Config, limit: number) {
  return buildCandidates(db, cfg.scoring)
    .slice(0, limit)
    .map((c) => ({
      key: c.key,
      term: c.term,
      score: c.score,
      components: c.components,
      feeds: c.feeds,
      observations: c.observations,
      firstSeen: c.firstSeen,
      qualifies: c.score >= cfg.scoring.threshold && c.observations >= cfg.scoring.minObservations,
        sampleUrl: safeHttpUrl(c.sampleUrl),
    }));
}

export function ledger(db: Db, cfg: Config, limit = 60) {
  const rows = db.prepare(
    `SELECT ts, kind, mint, sol_delta, signature, note FROM spend_ledger
      WHERE dry_run = ? ORDER BY ts DESC LIMIT ?`,
  ).all(mode(cfg), limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    ts: Number(r.ts),
    kind: String(r.kind),
    mint: r.mint ? String(r.mint) : null,
    solDelta: Number(r.sol_delta),
    signature: r.signature ? String(r.signature) : null,
    note: r.note ? String(r.note) : null,
  }));
}

export function auditLog(db: Db, limit = 50) {
  return db.prepare(
    `SELECT ts, action, detail, ip FROM audit_log ORDER BY ts DESC LIMIT ?`,
  ).all(limit) as Array<{ ts: number; action: string; detail: string | null; ip: string | null }>;
}

export function commandQueue(db: Db, limit = 25) {
  return db.prepare(
    `SELECT id, kind, payload, requested_at, status, started_at, finished_at, result, error
       FROM commands ORDER BY requested_at DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
}

export function adminSnapshot(db: Db, cfg: Config, kill: KillSwitch, walletBalanceSol?: number) {
  const budget = new BudgetGuard(db, cfg);
  const capacity = computeCapacity(db, cfg, walletBalanceSol);
  budget.setCapacity(capacity);

  return {
    capacity,
    // Admin always sees it, regardless of the public toggle.
    wallet: walletView(db, cfg),
    outcomes: outcomeSummary(db, cfg),
    recentOutcomes: settledOutcomes(db, cfg, 15).map((o) => ({
      term: o.term, symbol: o.symbol, score: o.score, verdict: o.verdict,
      peakMcapUsd: o.peakMcapUsd, feeds: o.feeds,
      estimatedFeeSol: o.estimatedFeeSol, realizedPnlSol: o.realizedPnlSol,
      launchedAt: o.launchedAt,
    })),
    learning: {
      enabled: cfg.learning.enabled,
      autoApply: cfg.learning.autoApply,
      minSampleSize: cfg.learning.minSampleSize,
      overlay: overlaySummary(),
      history: tuningHistory(db, 10).map((h) => ({
        ts: Number(h.ts),
        sampleSize: Number(h.sample_size),
        accepted: safeParseAny(h.accepted),
        rejected: safeParseAny(h.rejected),
        rationale: String(h.rationale ?? ""),
        applied: Number(h.applied) === 1,
      })),
    },
    at: Date.now(),
    status: statusOf(db, cfg, kill),
    halted: kill.isHalted(),
    haltReason: kill.haltReason() ?? null,
    dryRun: cfg.dryRun,
    network: cfg.network,
    budget: budget.summary(),
    xApiMeterUsd: budget.meterUsed("x-api-usd"),
    warmup: {
      spanMinutes: historySpanMinutes(db),
      requiredMinutes: cfg.scoring.warmupMinutes,
    },
    stats: headlineStats(db, cfg),
    funnel: pipelineFunnel(db, cfg),
    // Admin sees declines immediately; there is nothing to front-run yourself.
    declines: recentDeclines(db, cfg, 0, 12),
    // Admin sees the same depth with no delay applied.
    gateDetails: gateDetails(db, cfg, 0),
    reading: readingList(db, cfg, 24),
    claims: feeClaims(db, cfg),
    nextPollSeconds: nextPollSeconds(db, cfg),
    positions: openPositions(db, cfg),
    candidates: candidateQueue(db, cfg),
    feeds: feedHealth(db, cfg),
    ledger: ledger(db, cfg),
    commands: commandQueue(db),
    audit: auditLog(db),
    config: redactedConfig(cfg),
  };
}

/** Config for display. Env var *names* are fine; values never come near this. */
export function redactedConfig(cfg: Config) {
  return {
    dryRun: cfg.dryRun,
    network: cfg.network,
    launch: cfg.launch,
    risk: cfg.risk,
    devPosition: cfg.devPosition,
    scoring: cfg.scoring,
    saturation: cfg.saturation,
    filters: cfg.filters,
    fees: cfg.fees,
    feeds: cfg.feeds,
    rpc: {
      commitment: cfg.rpc.commitment,
      priorityFee: cfg.rpc.priorityFee,
      // Endpoint omitted entirely: API keys are routinely embedded in the path.
    },
  };
}

function safeParseAny(v: unknown): unknown {
  if (typeof v !== "string") return [];
  try {
    return JSON.parse(v);
  } catch {
    return [];
  }
}

function safeParseArray(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
