import type { Db } from "../util/db.ts";
import type { Config } from "../config/schema.ts";
import { BudgetGuard } from "../risk/budget.ts";
import { KillSwitch } from "../risk/killswitch.ts";
import { buildCandidates, checkWarmup, historySpanMinutes } from "../scoring/score.ts";
import { computeCapacity } from "../risk/capacity.ts";
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

const HOUR = 3600_000;
const DAY = 24 * HOUR;

export type StatusPill = "dry-run" | "halted" | "warming-up" | "live";

export type PublicSnapshot = ReturnType<typeof publicSnapshot>;
export type AdminSnapshot = ReturnType<typeof adminSnapshot>;

function mode(cfg: Config): 0 | 1 {
  return cfg.dryRun ? 1 : 0;
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
  };
}

export function recentLaunches(db: Db, cfg: Config, limit = 24) {
  // Outcome fields are joined in for the public page too: a token's peak
  // market cap and whether it graduated are public facts on pump.fun, so
  // showing them leaks nothing -- and honesty about duds is the point.
  const rows = db.prepare(
    `SELECT l.mint, l.name, l.symbol, l.term, l.score, l.feeds, l.created_at, l.signature,
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
    url: `https://pump.fun/coin/${String(r.mint)}`,
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
    launches: recentLaunches(db, cfg, 24),
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
      sampleUrl: c.sampleUrl ?? null,
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
