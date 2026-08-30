import type { Db } from "../util/db.ts";
import type { ScoringConfig } from "../config/schema.ts";
import type { RawSignal } from "../feeds/types.ts";
import { extractPhrases } from "./phrases.ts";
import { computeFeedReliability, reliabilityMultiplier } from "../learning/feedReliability.ts";
import { cryptoAffinity, tickerability } from "./affinity.ts";
import { clamp01 } from "../feeds/types.ts";
import { safeHttpUrl } from "../util/http.ts";
import { corroborationStrength, describeCorroboration, distinctFamilies } from "./independence.ts";

/**
 * Turn a stream of per-feed observations into ranked launch candidates.
 *
 * Velocity dominates the weighting on purpose. Absolute popularity is not the
 * edge -- by the time something is unambiguously huge, fifty tokens exist for
 * it. What pays is catching the *derivative*: a term whose mentions are
 * accelerating while its absolute level is still small.
 */

export type Candidate = {
  key: string;
  term: string;
  score: number;
  components: {
    velocity: number;
    acceleration: number;
    corroboration: number;
    cryptoAffinity: number;
    tickerability: number;
    reach: number;
    decay: number;
  };
  feeds: string[];
  families: string[];
  corroborationNote: string;
  firstSeen: number;
  lastSeen: number;
  observations: number;
  sampleUrl?: string;
};

/** Persist observations, expanding long text into comparable key phrases. */
export function ingestSignals(
  db: Db,
  signals: RawSignal[],
  feedWeights: Map<string, number>,
  cfg: ScoringConfig,
): number {
  const stmt = db.prepare(
    `INSERT INTO signals (feed, term, norm, raw_score, observed_at, ingested_at, url, meta, source_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // A feed re-serving byte-identical content (a static or stickied 4chan
  // thread, polled every 120s) is not a new observation -- only its reply
  // count changed, and that is not reflected in the text. Without this check
  // the same stale content re-enters `signals` every poll, inflating both
  // `observations` (a plain row count) and `velocityOf`'s recent-half sum for
  // a term that has not actually changed, which is what made stale terms keep
  // re-qualifying as candidates tick after tick. This is checked BEFORE
  // extraction, not after: extractPhrases() is a pure function of the text,
  // so identical source_text always yields identical phrases -- deduping the
  // raw signal is equivalent to deduping every phrase it would have produced,
  // and skips the extraction work entirely.
  //
  // Deliberately does not touch neverRelaunchSameTerm, self-dedupe, or
  // saturation -- those gates keep seeing every genuinely distinct signal
  // exactly as before. This is an ingestion-time fix only.
  const dupeCheck = db.prepare(
    `SELECT 1 FROM signals WHERE feed = ? AND source_text = ? AND ingested_at > ? LIMIT 1`,
  );
  // One clock for the whole batch, so a slow insert loop cannot smear a single
  // poll across a window boundary.
  const now = Date.now();
  const windowStart = now - cfg.maxSignalAgeMinutes * 60_000;

  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const s of signals) {
      const sourceText = s.term.slice(0, 300);
      // Reads its own in-flight inserts within this transaction (SQLite
      // read-your-own-writes), so byte-identical signals within the SAME
      // batch also collapse to one row, not just across polls.
      if (dupeCheck.get(s.feed, sourceText, windowStart)) continue;

      const weight = feedWeights.get(s.feed) ?? 1;
      for (const phrase of extractPhrases(s.term)) {
        stmt.run(
          s.feed,
          phrase.text,
          phrase.key,
          clamp01(s.rawScore) * phrase.salience * weight,
          s.observedAt.getTime(),
          now,
          // Third-party feed data: only http(s) is ever stored.
          safeHttpUrl(s.url),
          s.meta ? JSON.stringify(s.meta) : null,
          // The source's own words, for display. `term` is the extracted phrase.
          sourceText,
        );
        inserted++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return inserted;
}

type Row = {
  norm: string; term: string; feed: string;
  raw_score: number; observed_at: number; ingested_at: number; url: string | null;
};

/**
 * Velocity: recent-half activity versus older-half activity for the same term.
 *
 * Measured on ingested_at, not observed_at. What matters is how fast mentions
 * are accumulating in *our* observations; source timestamps are unreliable and
 * arbitrarily old, which would push a live term into the "older" bucket and
 * read as decelerating when it is doing the opposite.
 *
 * Expressed as a 0..1 ratio where 0.5 means "steady" and values above that mean
 * accelerating. A term seen only in the recent half scores maximum -- brand new
 * is the most interesting state.
 */
function velocityOf(rows: Row[], windowMs: number, now: number): number {
  const mid = now - windowMs / 2;
  let recent = 0, older = 0;
  for (const r of rows) {
    if (r.ingested_at >= mid) recent += r.raw_score;
    else older += r.raw_score;
  }
  if (recent === 0 && older === 0) return 0;
  if (older === 0) return 1;
  const ratio = recent / older;
  // ratio 1 -> 0.5, ratio 3+ -> ~1, ratio 0 -> 0
  return clamp01(ratio / (ratio + 1));
}

/**
 * Acceleration: is the term's mention RATE itself climbing right now?
 *
 * velocityOf() compares the window's halves (90-minute buckets at the
 * default 3h window) -- it says "busier lately". This compares the last
 * SIXTH of the window (30 minutes) against the per-minute rate of everything
 * before it: the second derivative, which is what "catch it before it pops"
 * actually means. A term ticking along for two hours then doubling its rate
 * in the last half hour lights this up while velocity still reads mild.
 *
 * Same ingested_at basis as velocity, for the same reason (invariant 5).
 * 0.5 = steady, 1 = all recent, 0 = died off.
 */
function accelerationOf(rows: Row[], windowMs: number, now: number): number {
  const sliceMs = windowMs / 6;
  const cut = now - sliceMs;
  let recent = 0, baseline = 0, baselineSpanMs = 0;
  for (const r of rows) {
    if (r.ingested_at >= cut) recent += r.raw_score;
    else {
      baseline += r.raw_score;
      baselineSpanMs = Math.max(baselineSpanMs, cut - r.ingested_at);
    }
  }
  if (recent === 0 && baseline === 0) return 0;
  if (baseline === 0) return 1; // all activity inside the last slice: maximal
  const recentRate = recent / sliceMs;
  const baselineRate = baseline / Math.max(baselineSpanMs, sliceMs);
  return clamp01(recentRate / (recentRate + baselineRate));
}

export function buildCandidates(db: Db, cfg: ScoringConfig): Candidate[] {
  const now = Date.now();
  const windowMs = cfg.maxSignalAgeMinutes * 60_000;

  // Learned once per scoring pass from settled outcomes, applied per
  // candidate below. Bounded [0.7, 1] and one-sided by construction -- see
  // learning/feedReliability.ts for why nothing is ever boosted.
  const reliabilityPrior = computeFeedReliability(db);

  const rows = db.prepare(
    `SELECT norm, term, feed, raw_score, observed_at, ingested_at, url
       FROM signals
      WHERE ingested_at > ?
      ORDER BY ingested_at ASC`,
  ).all(now - windowMs) as Row[];

  const grouped = new Map<string, Row[]>();
  for (const r of rows) {
    const list = grouped.get(r.norm);
    if (list) list.push(r);
    else grouped.set(r.norm, [r]);
  }

  const out: Candidate[] = [];

  for (const [key, group] of grouped) {
    const feeds = [...new Set(group.map((r) => r.feed))];
    if (feeds.length < cfg.minCorroboratingFeeds) continue;

    const families = distinctFamilies(feeds);
    if (families.length < cfg.minIndependentFamilies) continue;

    // "First seen" means first seen by us -- this drives the decay term, and
    // dating it from a source timestamp would age a brand-new candidate out
    // before it ever qualified.
    const firstSeen = group[0]!.ingested_at;
    const lastSeen = group[group.length - 1]!.ingested_at;

    // Most frequent surface form is the most human-readable label.
    const counts = new Map<string, number>();
    for (const r of group) counts.set(r.term, (counts.get(r.term) ?? 0) + 1);
    const term = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];

    const velocity = velocityOf(group, windowMs, now);
    const acceleration = accelerationOf(group, windowMs, now);
    // Weighted by source independence, not raw feed count: two crypto-native
    // feeds agreeing is nearly one source talking to itself.
    const corroboration = corroborationStrength(feeds);
    const affinity = cryptoAffinity(term, feeds);
    const tick = tickerability(term);
    const peak = Math.max(...group.map((r) => r.raw_score));
    const reach = clamp01(peak);

    // Being early is the edge, so the score decays with age since first sight.
    const ageMin = (now - firstSeen) / 60_000;
    const decay = Math.pow(0.5, ageMin / cfg.decayHalfLifeMinutes);

    const w = cfg.weights;
    const base =
      w.velocity * velocity +
      w.acceleration * acceleration +
      w.corroboration * corroboration +
      w.cryptoAffinity * affinity +
      w.tickerability * tick +
      w.reach * reach;

    const reliability = reliabilityMultiplier(reliabilityPrior, families);

    out.push({
      key, term,
      score: clamp01(base * decay * reliability) * 100,
      components: { velocity, acceleration, corroboration, cryptoAffinity: affinity, tickerability: tick, reach, decay },
      feeds,
      families,
      corroborationNote: describeCorroboration(feeds),
      firstSeen, lastSeen,
      observations: group.length,
      sampleUrl: group.find((r) => r.url)?.url ?? undefined,
    });
  }

  return out.sort((a, b) => b.score - a.score);
}

/** Candidates clearing the configured launch threshold, best first. */
export function qualifying(candidates: Candidate[], cfg: ScoringConfig): Candidate[] {
  return candidates.filter(
    (c) => c.score >= cfg.threshold && c.observations >= cfg.minObservations,
  );
}

/**
 * How long the stored signal history spans, in minutes.
 *
 * Velocity is a comparison between the recent and earlier halves of the
 * window, so it is meaningless until there *is* an earlier half. A bot that
 * started two minutes ago sees every term as brand new and therefore maximally
 * accelerating -- which, unchecked in full-auto mode, means launching on the
 * first sighting of noise.
 */
export function historySpanMinutes(db: Db): number {
  const row = db.prepare(
    `SELECT MIN(ingested_at) AS first, MAX(ingested_at) AS last FROM signals`,
  ).get() as { first: number | null; last: number | null };
  if (!row.first || !row.last) return 0;
  return (row.last - row.first) / 60_000;
}

export type WarmupState =
  | { warm: true; spanMinutes: number }
  | { warm: false; spanMinutes: number; reason: string };

export function checkWarmup(db: Db, cfg: ScoringConfig): WarmupState {
  const span = historySpanMinutes(db);
  if (span >= cfg.warmupMinutes) return { warm: true, spanMinutes: span };
  return {
    warm: false,
    spanMinutes: span,
    reason:
      `signal history spans ${span.toFixed(1)}min of the ${cfg.warmupMinutes}min warmup; ` +
      `velocity is not yet meaningful, so launches are suppressed`,
  };
}

/** Housekeeping: signals older than the window are only dead weight. */
export function pruneSignals(db: Db, olderThanMs: number): number {
  const res = db.prepare(`DELETE FROM signals WHERE ingested_at < ?`).run(Date.now() - olderThanMs);
  return Number(res.changes ?? 0);
}
