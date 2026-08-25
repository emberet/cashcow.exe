import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Connection } from "@solana/web3.js";
import type { Config } from "../config/schema.ts";
import { PROJECT_ROOT } from "../config/load.ts";
import { validate, type Change, type Verdict } from "../learning/guardrails.ts";
import { samplePumpLaunches } from "./pumpSample.ts";
import { fetchDexActivity } from "./volume.ts";
import { fetchHolderConcentration } from "../chain/holders.ts";
import { log } from "../util/log.ts";
import { sleep } from "../util/http.ts";
import { findHnPrecursors, findWikipediaPrecursors, type TrendMatch } from "./trendReconstruct.ts";
import {
  classifyLaunch, washSuspicionScore, percentileRank,
  DEFAULT_THRESHOLDS, type ClassifyThresholds,
} from "./classify.ts";

/**
 * One-time historical-launch research pass. Not a live feature: nothing here
 * runs on a schedule, nothing here is imported by `runner/loop.ts`, and it
 * never writes `config/default.config.json` itself -- it prints a proposed
 * diff, already clamped through the tuner's own guardrails, for a human to
 * read and hand-apply.
 *
 * The point is honesty about a small, proxy-based, best-effort study, not a
 * polished model. Every stage prints its own funnel so nothing is hidden.
 */

export type BacktestOpts = {
  daysAgoStart: number;
  daysAgoEnd: number;
  maxPages: number;
  /** DexScreener + HN + Wikipedia are separate services with their own limits. */
  concurrency: number;
  /**
   * Holder-concentration reads go through Solana RPC, one request per mint.
   * Sequential and rate-limited by design: verified live that the public
   * mainnet endpoint (used automatically when `cfg.network` is not
   * mainnet-beta -- see `mainnetConnectionFor`) starts returning HTTP 429
   * within seconds at concurrency 5, and web3.js's own internal retry loop
   * then churns for a very long time. A dedicated RPC could go faster; this
   * stays conservative since the default is the free public endpoint.
   */
  rpcConcurrency: number;
  rpcDelayMs: number;
  thresholds: ClassifyThresholds;
};

export const DEFAULT_BACKTEST_OPTS: BacktestOpts = {
  daysAgoStart: 180,
  daysAgoEnd: 30,
  maxPages: 60,
  concurrency: 5,
  rpcConcurrency: 1,
  rpcDelayMs: 300,
  thresholds: DEFAULT_THRESHOLDS,
};

type Enriched = {
  mint: string; name: string; symbol: string; createdTimestamp: number;
  athMarketCapUsd: number; replyCount: number; isBanned: boolean; graduated: boolean;
  top10ConcentrationPct: number | null;
  txCount24h: number; volumeH24: number; pairUrl?: string;
};

async function mapWithConcurrency<T, R>(
  items: T[], limit: number, fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * pump.fun's public listing API returns MAINNET launches -- that's where real
 * $500k-$2M volume happens, devnet has nothing comparable. So holder reads
 * must hit mainnet regardless of what `cfg.network`/`cfg.rpc.primary` are set
 * to for the bot's own live/dry-run mode; reusing the bot's own (possibly
 * devnet) connection would silently fail every lookup against these mints.
 *
 * `rpcOverride` lets the operator point this script at a dedicated mainnet
 * RPC (e.g. Helius) without flipping `cfg.network` to mainnet-beta, which
 * has other implications for the live bot. Without it, this falls back to
 * the free public endpoint -- verified live to work, but heavily throttled:
 * roughly 7-8 seconds per request once web3.js's own 429 backoff kicks in.
 * A dedicated RPC is a lot faster; the public one is fine for a first run.
 */
function mainnetConnectionFor(cfg: Config, rpcOverride?: string): Connection {
  const url = rpcOverride ?? (cfg.network === "mainnet-beta" ? cfg.rpc.primary : "https://api.mainnet-beta.solana.com");
  if (!rpcOverride && cfg.network !== "mainnet-beta") {
    log.warn("backtest: using the public mainnet RPC for holder reads -- expect roughly " +
      "7-8s/request once it starts throttling. Pass --rpc <url> with a dedicated endpoint " +
      "to go much faster; this is fine as a first, slower run.");
  }
  return new Connection(url, cfg.rpc.commitment);
}

export async function runBacktest(
  cfg: Config,
  opts: BacktestOpts = DEFAULT_BACKTEST_OPTS,
  rpcOverride?: string,
): Promise<string> {
  console.log(`\n  historical-launch research pass (best-effort, offline, one-time)\n`);
  console.log(`  sampling launches ${opts.daysAgoStart}-${opts.daysAgoEnd} days old, up to ${opts.maxPages} pages...`);
  const mainnetConn = mainnetConnectionFor(cfg, rpcOverride);

  const sample = await samplePumpLaunches({
    daysAgoStart: opts.daysAgoStart,
    daysAgoEnd: opts.daysAgoEnd,
    maxPages: opts.maxPages,
  });
  console.log(`  scanned ${sample.pagesScanned} page(s), ${sample.coinsSeen} coin(s) seen, ` +
    `${sample.coins.length} survived the coarse market-cap prefilter`);

  if (sample.coins.length === 0) {
    console.log("\n  nothing survived the prefilter -- pump.fun's API may be unreachable. Stopping.\n");
    return "";
  }

  console.log(`  fetching DexScreener activity for ${sample.coins.length} coin(s)...`);
  const activityByMint = new Map<string, Awaited<ReturnType<typeof fetchDexActivity>>>();
  await mapWithConcurrency(sample.coins, opts.concurrency, async (c) => {
    activityByMint.set(c.mint, await fetchDexActivity(c.mint).catch(() => null));
  });

  console.log(`  reading holder concentration for ${sample.coins.length} coin(s) from mainnet RPC ` +
    `(sequential, ${opts.rpcDelayMs}ms apart -- this is the slow step on the public endpoint)...`);
  const concentrationByMint = new Map<string, number | null>();
  let rpcDone = 0;
  let rpcFailed = 0;
  await mapWithConcurrency(sample.coins, opts.rpcConcurrency, async (c) => {
    try {
      const excludeAddresses = c.associatedBondingCurve ? [c.associatedBondingCurve] : [];
      const conc = await fetchHolderConcentration(cfg, c.mint, excludeAddresses, mainnetConn);
      concentrationByMint.set(c.mint, conc.top10ConcentrationPct);
    } catch {
      // RPC read failed for this mint. Left unknown rather than guessed, and
      // does NOT disqualify -- see classify.ts. Verified live: on the free
      // public RPC this fails for close to 100% of reads, not occasionally,
      // so treating unknown as "concentrated" would silently reject every
      // candidate in a sample run on the default config.
      concentrationByMint.set(c.mint, null);
      rpcFailed++;
    }
    rpcDone++;
    if (rpcDone % 20 === 0) console.log(`    ${rpcDone}/${sample.coins.length}...`);
    await sleep(opts.rpcDelayMs);
  });

  if (rpcFailed > 0) {
    console.log(`  *** ${rpcFailed}/${sample.coins.length} holder-concentration reads FAILED ` +
      `(RPC rate limits) -- those candidates are judged on activity and wash-suspicion only. ` +
      `Pass --rpc <dedicated endpoint> for concentration data on all of them. ***`);
  }

  const enriched: Enriched[] = sample.coins.map((c) => {
    const activity = activityByMint.get(c.mint);
    return {
      mint: c.mint, name: c.name, symbol: c.symbol, createdTimestamp: c.createdTimestamp,
      athMarketCapUsd: c.athMarketCapUsd, replyCount: c.replyCount,
      isBanned: c.isBanned, graduated: c.graduated,
      top10ConcentrationPct: concentrationByMint.get(c.mint) ?? null,
      txCount24h: activity?.txCount24h ?? 0,
      volumeH24: activity?.volumeH24 ?? 0,
      pairUrl: activity?.pairUrl,
    };
  });

  // Wash-suspicion percentile is computed against THIS sample's own
  // distribution, not a fixed assumption about what a normal ratio looks like.
  const washScores = enriched.map((e) => washSuspicionScore(e.txCount24h, e.replyCount));

  const classified = enriched.map((e, i) => {
    const percentile = percentileRank(washScores[i]!, washScores);
    const result = classifyLaunch({
      isBanned: e.isBanned,
      athMarketCapUsd: e.athMarketCapUsd,
      top10ConcentrationPct: e.top10ConcentrationPct, // null (RPC failed) does not disqualify -- see classify.ts
      txCount24h: e.txCount24h,
      replyCount: e.replyCount,
      washSuspicionPercentile: percentile,
    }, opts.thresholds);
    return { ...e, washSuspicionPercentile: percentile, ...result };
  });

  const survivors = classified.filter((c) => c.clean);
  console.log(`  classified: ${survivors.length}/${classified.length} as "clean" by the thresholds below\n`);

  if (survivors.length < 15) {
    console.log(`  *** only ${survivors.length} survivor(s) -- any correlation below is anecdotal, not ` +
      `statistically meaningful. Treat this as a starting hypothesis, not a conclusion. ***\n`);
  }

  console.log(`  reconstructing what was trending before each survivor (Wikipedia + HN)...`);
  const precursors = await mapWithConcurrency(survivors, opts.concurrency, async (s) => {
    const [hn, wiki] = await Promise.all([
      findHnPrecursors(s.name || s.symbol, s.createdTimestamp).catch(() => [] as TrendMatch[]),
      findWikipediaPrecursors(s.name || s.symbol, s.createdTimestamp).catch(() => [] as TrendMatch[]),
    ]);
    return { mint: s.mint, matches: [...hn, ...wiki].sort((a, b) => b.score - a.score).slice(0, 5) };
  });

  const withPrecursor = precursors.filter((p) => p.matches.length > 0);
  console.log(`  ${withPrecursor.length}/${survivors.length} survivor(s) had a matching precursor ` +
    `in the reconstructable feeds (HN, Wikipedia only -- Reddit/4chan/on-chain have no usable archive)\n`);

  // A modest, clearly-labelled heuristic, not a model: if survivors that had a
  // reconstructable precursor mostly found it CLOSE to launch time, that is
  // weak evidence for reacting faster (shorter decay half-life). If most
  // matches came from multiple sources, that is weak evidence for weighting
  // corroboration higher. Both are printed as proposals, clamped through the
  // real tuner guardrail, and never applied automatically.
  const proposals: Change[] = [];
  if (withPrecursor.length >= 5) {
    const avgHoursBefore =
      withPrecursor.reduce((s, p) => s + Math.min(...p.matches.map((m) => m.hoursBefore)), 0) /
      withPrecursor.length;
    if (avgHoursBefore < 12) {
      proposals.push({ path: "scoring.decayHalfLifeMinutes", value: cfg.scoring.decayHalfLifeMinutes - 15 });
    }
    const multiSource = withPrecursor.filter((p) =>
      new Set(p.matches.map((m) => m.source)).size > 1).length;
    if (multiSource / withPrecursor.length > 0.3) {
      proposals.push({ path: "scoring.weights.corroboration", value: cfg.scoring.weights.corroboration + 0.05 });
    }
  }

  const clampedProposals = proposals
    .map((p) => ({ change: p, verdict: validate(p, cfg) }))
    .filter((r): r is { change: Change; verdict: Extract<Verdict, { ok: true }> } => r.verdict.ok);

  const report = renderReport({
    opts, sample, classified, survivors, precursors, proposals: clampedProposals, rpcFailed,
  });

  const dir = resolve(PROJECT_ROOT, "data/research");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `launch-backtest-${new Date().toISOString().slice(0, 10)}.md`);
  writeFileSync(path, report);

  console.log(`  report written to ${path}\n`);
  if (clampedProposals.length) {
    console.log(`  proposed scoring.* changes (already clamped by the tuner guardrail -- hand-apply, ` +
      `never auto-applied):`);
    for (const { verdict } of clampedProposals) {
      if (verdict.ok) console.log(`    ${verdict.path}: ${verdict.from} -> ${verdict.to}` +
        (verdict.clamped ? "  (clamped to the allowlist bound)" : ""));
    }
  } else {
    console.log(`  no scoring.* change proposed -- either the sample was too thin, or nothing in it ` +
      `pointed clearly in one direction.`);
  }
  console.log(`\n  before trusting any of this: eyeball each survivor's DexScreener URL in the report ` +
    `for a warning banner (no "flagged" field exists to check automatically), and cross-check the ` +
    `findings against \`node src/cli.ts outcomes\` -- if this study disagrees with what the bot's own ` +
    `live launches show, that's a reason to investigate, not a reason to trust the older study.\n`);

  return path;
}

function renderReport(a: {
  opts: BacktestOpts;
  sample: { pagesScanned: number; coinsSeen: number; coins: unknown[] };
  classified: Array<ReturnType<typeof classifyLaunch> & Enriched & { washSuspicionPercentile: number }>;
  survivors: Array<Enriched & { washSuspicionPercentile: number; reasons: string[]; caveats: string[] }>;
  precursors: Array<{ mint: string; matches: TrendMatch[] }>;
  proposals: Array<{ change: Change; verdict: Extract<Verdict, { ok: true }> }>;
  rpcFailed: number;
}): string {
  const lines: string[] = [];
  lines.push(`# Historical launch backtest -- ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`Best-effort, proxy-based, one-time. Not a live gate. See CLAUDE.md invariant 3 -- ` +
    `nothing here can touch risk.*, and nothing here writes config automatically.`);
  lines.push("");
  lines.push(`## Funnel`);
  lines.push(`- pages scanned: ${a.sample.pagesScanned}`);
  lines.push(`- coins seen: ${a.sample.coinsSeen}`);
  lines.push(`- survived coarse prefilter: ${a.sample.coins.length}`);
  lines.push(`- holder-concentration RPC reads failed: ${a.rpcFailed} / ${a.sample.coins.length}` +
    (a.rpcFailed > 0 ? ` (use \`--rpc <url>\` with a dedicated endpoint to fix this)` : ""));
  lines.push(`- classified clean: ${a.classified.filter((c) => c.clean).length} / ${a.classified.length}`);
  lines.push(`- had a reconstructable precursor: ${a.precursors.filter((p) => p.matches.length).length}`);
  lines.push("");

  // Why things were rejected, tallied -- the thresholds are the most arguable
  // part of this design, so seeing WHICH gate is doing the rejecting is what
  // makes them re-tunable rather than a black box that just says "zero".
  const rejectionTally = new Map<string, number>();
  for (const c of a.classified) {
    for (const r of c.reasons) {
      // Reason strings carry the exact figure (a percentile, a dollar
      // amount, a tx count) inline, so two candidates rejected for the SAME
      // reason produce different text. Strip the numbers to bucket by kind.
      const bucket = r
        .replace(/\$[\d,]+(\.\d+)?/g, "$#")
        .replace(/\d+(\.\d+)?%/g, "#%")
        .replace(/\b\d+\b/g, "#");
      rejectionTally.set(bucket, (rejectionTally.get(bucket) ?? 0) + 1);
    }
  }
  if (rejectionTally.size > 0) {
    lines.push(`## Why candidates were rejected (tallied across all ${a.classified.length})`);
    for (const [reason, count] of [...rejectionTally.entries()].sort((x, y) => y[1] - x[1])) {
      lines.push(`- ${reason}: ${count}`);
    }
    lines.push("");
  }

  if (a.survivors.length < 15) {
    lines.push(`> **Sample is thin (${a.survivors.length} survivors).** Anecdotal, not statistically ` +
      `meaningful -- a starting hypothesis, nothing more.`);
    lines.push("");
  }
  lines.push(`## Classification thresholds used`);
  lines.push("```json");
  lines.push(JSON.stringify(a.opts.thresholds, null, 2));
  lines.push("```");
  lines.push("");
  lines.push(`## Survivors -- manually verify each DexScreener URL for a warning banner`);
  lines.push(`(no programmatic "flagged" field exists on DexScreener's API; this is a human step)`);
  lines.push("");
  for (const s of a.survivors) {
    const matches = a.precursors.find((p) => p.mint === s.mint)?.matches ?? [];
    lines.push(`### ${s.name} (${s.symbol}) -- \`${s.mint}\``);
    lines.push(`- ATH mcap: $${Math.round(s.athMarketCapUsd).toLocaleString()}`);
    lines.push(`- top-10 concentration: ${s.top10ConcentrationPct?.toFixed(1) ?? "unknown"}%`);
    lines.push(`- 24h txns: ${s.txCount24h}, replies: ${s.replyCount}`);
    lines.push(`- DexScreener: ${s.pairUrl ?? "(no pair found)"}`);
    for (const cav of s.caveats) lines.push(`- **caveat:** ${cav}`);
    if (matches.length) {
      lines.push(`- precursor(s):`);
      for (const m of matches) {
        lines.push(`  - [${m.source}] "${m.title}" (score ${m.score.toFixed(2)}, ` +
          `${m.hoursBefore.toFixed(1)}h before) ${m.url ?? ""}`);
      }
    } else {
      lines.push(`- precursor(s): none found in HN/Wikipedia`);
    }
    lines.push("");
  }
  lines.push(`## Proposed scoring.* changes`);
  lines.push(`Already validated/clamped through \`src/learning/guardrails.ts\`'s real allowlist. Never ` +
    `applied automatically -- edit \`src/config/default.config.json\` by hand if you agree.`);
  lines.push("");
  if (a.proposals.length === 0) {
    lines.push(`(none -- sample too thin or no clear direction)`);
  } else {
    for (const { verdict } of a.proposals) {
      lines.push(`- \`${verdict.path}\`: ${verdict.from} -> ${verdict.to}` +
        (verdict.clamped ? " (clamped to the allowlist bound -- weaker evidence than an unclamped proposal)" : ""));
    }
  }
  lines.push("");
  return lines.join("\n");
}
