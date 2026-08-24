import type { Db } from "../util/db.ts";
import { isPretend, type Config } from "../config/schema.ts";
import { fetchJson } from "../util/http.ts";
import { log, errFields } from "../util/log.ts";

/**
 * What actually happened to the tokens we launched.
 *
 * This is the substrate the tuner learns from, and its honesty matters more
 * than its precision. Two things are measured directly and one is estimated:
 *
 *   - **Token performance** is measured. pump.fun reports peak market cap,
 *     reply count and graduation per mint.
 *   - **Our own P&L** is measured, from the positions ledger.
 *   - **Per-token creator fees are ESTIMATED.** pump.fun claims fees in bulk
 *     across every token a wallet created, so there is no per-token figure to
 *     read. Fees are apportioned by each token's share of observed performance
 *     within the claim period. Every surface that shows this labels it an
 *     estimate; the *total* claimed is exact and comes from `fee_claims`.
 *
 * A launch is not judged immediately. Most pump.fun tokens do nothing for
 * hours and then either catch or die, so an outcome stays `pending` until it
 * has been observed for `settleAfterHours`.
 */

const BROWSERISH =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type Verdict = "pending" | "dud" | "modest" | "hit";

type PumpCoin = {
  mint?: string;
  usd_market_cap?: number;
  market_cap?: number;
  ath_market_cap?: number;
  reply_count?: number;
  complete?: boolean;
  is_banned?: boolean;
};

/** Called at launch time: records the features that caused this decision. */
export function recordLaunch(
  db: Db,
  a: {
    mint: string; term: string; symbol: string; score: number;
    components: Record<string, number>; feeds: string[]; families: string[];
    namingSource: string; entrySol: number; dryRun: boolean;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO launch_outcomes
       (mint, launched_at, term, symbol, score, components, feeds, families,
        naming_source, launch_hour_utc, entry_sol, verdict, dry_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    a.mint, Date.now(), a.term, a.symbol, a.score,
    JSON.stringify(a.components), JSON.stringify(a.feeds), JSON.stringify(a.families),
    a.namingSource, new Date().getUTCHours(), a.entrySol, a.dryRun ? 1 : 0,
  );
}

/**
 * Poll pump.fun for every launch that has not settled yet, and update it.
 * Cheap and read-only; safe to run on a slow timer.
 */
export async function refreshOutcomes(db: Db, cfg: Config): Promise<number> {
  const settleMs = cfg.learning.settleAfterHours * 3600_000;
  const rows = db.prepare(
    `SELECT mint, launched_at, entry_sol, first_mcap_usd, peak_mcap_usd
       FROM launch_outcomes
      WHERE verdict = 'pending' AND dry_run = ?
      ORDER BY launched_at ASC LIMIT 40`,
  ).all(isPretend(cfg) ? 1 : 0) as Array<{
    mint: string; launched_at: number; entry_sol: number | null;
    first_mcap_usd: number | null; peak_mcap_usd: number | null;
  }>;

  if (!rows.length) return 0;

  let updated = 0;
  for (const row of rows) {
    try {
      const coin = await fetchCoin(row.mint);
      const now = Date.now();

      // In dry run there is no real mint to look up; settle on our own P&L only.
      const mcap = coin?.usd_market_cap ?? 0;
      const peak = Math.max(coin?.ath_market_cap ?? 0, mcap, row.peak_mcap_usd ?? 0);
      const first = row.first_mcap_usd ?? mcap;
      const age = now - row.launched_at;
      const settled = age >= settleMs;

      const pos = db.prepare(
        `SELECT exit_sol, realized_pnl_sol FROM positions WHERE mint = ? AND status = 'closed'`,
      ).get(row.mint) as { exit_sol: number | null; realized_pnl_sol: number | null } | undefined;

      db.prepare(
        `UPDATE launch_outcomes
            SET first_mcap_usd = ?, peak_mcap_usd = ?, last_mcap_usd = ?,
                replies = ?, graduated = ?, is_banned = ?,
                exit_sol = ?, realized_pnl_sol = ?,
                observations = observations + 1,
                first_checked_at = COALESCE(first_checked_at, ?),
                last_checked_at = ?,
                verdict = ?, settled_at = ?
          WHERE mint = ?`,
      ).run(
        first, peak, mcap,
        coin?.reply_count ?? 0,
        coin?.complete ? 1 : 0,
        coin?.is_banned ? 1 : 0,
        pos?.exit_sol ?? null, pos?.realized_pnl_sol ?? null,
        now, now,
        settled ? classify(peak, coin?.complete === true, cfg) : "pending",
        settled ? now : null,
        row.mint,
      );
      updated++;
    } catch (e) {
      log.debug("outcome refresh failed for one mint", { mint: row.mint, ...errFields(e) });
    }
  }

  if (updated) log.debug("outcomes refreshed", { updated });
  return updated;
}

async function fetchCoin(mint: string): Promise<PumpCoin | undefined> {
  try {
    return await fetchJson<PumpCoin>(
      `https://frontend-api-v3.pump.fun/coins/${encodeURIComponent(mint)}`,
      { headers: { "user-agent": BROWSERISH }, timeoutMs: 10_000, retries: 1 },
    );
  } catch {
    return undefined;
  }
}

/**
 * Bands are anchored to the fee schedule, not to round numbers: the top
 * creator-fee tier (0.95%) sits around $88k-$300k market cap, so clearing that
 * floor is what separates a token that earns from one that merely exists.
 */
function classify(peakMcapUsd: number, graduated: boolean, cfg: Config): Verdict {
  if (graduated || peakMcapUsd >= cfg.learning.hitMcapUsd) return "hit";
  if (peakMcapUsd >= cfg.learning.modestMcapUsd) return "modest";
  return "dud";
}

/**
 * Apportion a bulk fee claim across the tokens that plausibly generated it.
 *
 * Fees are proportional to trade volume, and peak market cap is the best
 * volume proxy available from the public API. This is an estimate and is
 * labelled as one everywhere it surfaces -- the exact total lives in
 * `fee_claims`.
 */
export function attributeFees(db: Db, cfg: Config, claimedSol: number, sinceMs: number): void {
  if (claimedSol <= 0) return;

  const rows = db.prepare(
    `SELECT mint, peak_mcap_usd FROM launch_outcomes
      WHERE dry_run = ? AND launched_at > ? AND COALESCE(peak_mcap_usd, 0) > 0`,
  ).all(isPretend(cfg) ? 1 : 0, sinceMs) as Array<{ mint: string; peak_mcap_usd: number }>;

  const total = rows.reduce((s, r) => s + r.peak_mcap_usd, 0);
  if (total <= 0) return;

  const stmt = db.prepare(
    `UPDATE launch_outcomes SET estimated_fee_sol = COALESCE(estimated_fee_sol, 0) + ? WHERE mint = ?`,
  );
  for (const r of rows) stmt.run(claimedSol * (r.peak_mcap_usd / total), r.mint);

  log.debug("fees attributed across launches", { claimedSol, tokens: rows.length });
}

export type OutcomeRow = {
  mint: string; term: string; symbol: string; score: number;
  components: Record<string, number>; feeds: string[]; families: string[];
  namingSource: string; launchHourUtc: number;
  peakMcapUsd: number; replies: number; graduated: boolean;
  realizedPnlSol: number | null; estimatedFeeSol: number;
  verdict: Verdict; launchedAt: number;
};

export function settledOutcomes(db: Db, cfg: Config, limit = 200): OutcomeRow[] {
  const rows = db.prepare(
    `SELECT * FROM launch_outcomes
      WHERE dry_run = ? AND verdict != 'pending'
      ORDER BY launched_at DESC LIMIT ?`,
  ).all(isPretend(cfg) ? 1 : 0, limit) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    mint: String(r.mint),
    term: String(r.term ?? ""),
    symbol: String(r.symbol ?? ""),
    score: Number(r.score ?? 0),
    components: safeJson<Record<string, number>>(r.components, {}),
    feeds: safeJson<string[]>(r.feeds, []),
    families: safeJson<string[]>(r.families, []),
    namingSource: String(r.naming_source ?? ""),
    launchHourUtc: Number(r.launch_hour_utc ?? 0),
    peakMcapUsd: Number(r.peak_mcap_usd ?? 0),
    replies: Number(r.replies ?? 0),
    graduated: Number(r.graduated ?? 0) === 1,
    realizedPnlSol: r.realized_pnl_sol == null ? null : Number(r.realized_pnl_sol),
    estimatedFeeSol: Number(r.estimated_fee_sol ?? 0),
    verdict: String(r.verdict) as Verdict,
    launchedAt: Number(r.launched_at),
  }));
}

export function outcomeSummary(db: Db, cfg: Config) {
  const m = isPretend(cfg) ? 1 : 0;
  const r = db.prepare(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN verdict = 'pending' THEN 1 ELSE 0 END) pending,
       SUM(CASE WHEN verdict = 'dud'     THEN 1 ELSE 0 END) duds,
       SUM(CASE WHEN verdict = 'modest'  THEN 1 ELSE 0 END) modest,
       SUM(CASE WHEN verdict = 'hit'     THEN 1 ELSE 0 END) hits,
       COALESCE(SUM(realized_pnl_sol), 0) pnl,
       COALESCE(SUM(estimated_fee_sol), 0) fees,
       COALESCE(MAX(peak_mcap_usd), 0) bestMcap
     FROM launch_outcomes WHERE dry_run = ?`,
  ).get(m) as Record<string, number>;

  const settled = (r.total ?? 0) - (r.pending ?? 0);
  return {
    total: r.total ?? 0,
    pending: r.pending ?? 0,
    settled,
    duds: r.duds ?? 0,
    modest: r.modest ?? 0,
    hits: r.hits ?? 0,
    hitRate: settled > 0 ? (r.hits ?? 0) / settled : null,
    realisedPnlSol: r.pnl ?? 0,
    estimatedFeeSol: r.fees ?? 0,
    bestPeakMcapUsd: r.bestMcap ?? 0,
  };
}

function safeJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}
