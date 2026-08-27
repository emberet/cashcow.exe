import type { Db } from "../util/db.ts";
import { kvGet, kvSet } from "../util/db.ts";
import type { Config, RiskConfig, ScoringConfig } from "../config/schema.ts";
import { TUNABLE } from "../learning/guardrails.ts";
import { log } from "../util/log.ts";

/**
 * A human-triggered, self-expiring override for `risk.*` and
 * `scoring.threshold`/`scoring.minObservations` -- the "prove more on-chain
 * activity" escape hatch.
 *
 * This is NOT the tuner (`src/learning/guardrails.ts`). It is a separate
 * storage path (`kv`, not `data/tuning.json`), a separate trigger (a human
 * running `boost-window` on the CLI, not the learning loop), and it can never
 * reach anything the tuner can't already reach for scoring, nor anything
 * beyond `EXPERIMENTAL_CEILINGS` for risk. It can widen how many launches
 * happen. Values are capped by `EXPERIMENTAL_CEILINGS`, and
 * `setExperimentalWindow` never lowers a value below the supplied base.
 * Defense-in-depth clamping against `EXPERIMENTAL_CEILINGS` happens again at
 * read time even if the stored row were hand-edited.
 *
 * Fail-closed by construction: anything missing, malformed, expired, or
 * out-of-ceiling resolves to the ordinary static config, never to something
 * more permissive than what was configured. See CLAUDE.md invariant 7.
 */

const KV_KEY = "experimental_window";

const thresholdBound = TUNABLE.find((b) => b.path === "scoring.threshold");
const minObsBound = TUNABLE.find((b) => b.path === "scoring.minObservations");
if (!thresholdBound || !minObsBound) {
  throw new Error("experimentalWindow: expected scoring bounds missing from TUNABLE allowlist");
}

export const EXPERIMENTAL_CEILINGS = {
  maxLaunchesPerDay: 15,
  maxSolPerDay: 1.2,
  maxConcurrentPositions: 8,
  maxDailyLossSol: 0.6,
  maxHours: 48,
  // Scoring floors reuse the SAME bounds the tuner itself is allowed to
  // reach, so a human override can never be more permissive than what the
  // vetted tuner bounds already consider safe -- it can just apply the move
  // instantly instead of incrementally.
  thresholdFloor: thresholdBound.min,
  minObservationsFloor: minObsBound.min,
} as const;

export type ExperimentalWindow = {
  createdAt: number;
  expiresAt: number;
  reason: string;
  risk: {
    maxLaunchesPerDay: number;
    maxSolPerDay: number;
    maxDailyLossSol: number;
    maxConcurrentPositions: number;
  };
  scoring: {
    threshold: number;
    minObservations: number;
  };
};

export type ExperimentalWindowInput = {
  hours: number;
  reason?: string;
  maxLaunchesPerDay?: number;
  maxSolPerDay?: number;
  maxDailyLossSol?: number;
  maxConcurrentPositions?: number;
  threshold?: number;
  minObservations?: number;
  /** Defaults the boosted values must never fall below -- the static floor
   *  the window is boosting above. */
  base: {
    maxLaunchesPerDay: number;
    maxSolPerDay: number;
    maxDailyLossSol: number;
    maxConcurrentPositions: number;
    threshold: number;
    minObservations: number;
  };
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Structural validation of a parsed kv row, independent of Zod. */
function isWellFormed(v: unknown): v is ExperimentalWindow {
  if (typeof v !== "object" || v === null) return false;
  const w = v as Record<string, unknown>;
  if (!isFiniteNumber(w.createdAt) || !isFiniteNumber(w.expiresAt)) return false;
  if (typeof w.reason !== "string") return false;
  const r = w.risk as Record<string, unknown> | undefined;
  const s = w.scoring as Record<string, unknown> | undefined;
  if (typeof r !== "object" || r === null) return false;
  if (typeof s !== "object" || s === null) return false;
  return (
    isFiniteNumber(r.maxLaunchesPerDay) &&
    isFiniteNumber(r.maxSolPerDay) &&
    isFiniteNumber(r.maxDailyLossSol) &&
    isFiniteNumber(r.maxConcurrentPositions) &&
    isFiniteNumber(s.threshold) &&
    isFiniteNumber(s.minObservations)
  );
}

/**
 * Clamp every field to `EXPERIMENTAL_CEILINGS`, enforce the same coherence
 * rule `assertCoherent()` enforces statically (maxDailyLossSol <=
 * maxSolPerDay), and write the result to `kv`. Returns the stored
 * (post-clamp) record so a caller can report what was ACTUALLY set, which
 * may differ from what was requested.
 */
export function setExperimentalWindow(db: Db, input: ExperimentalWindowInput): ExperimentalWindow {
  const c = EXPERIMENTAL_CEILINGS;
  const hours = clamp(input.hours, 0.01, c.maxHours);

  const maxLaunchesPerDay = Math.round(
    clamp(input.maxLaunchesPerDay ?? input.base.maxLaunchesPerDay, input.base.maxLaunchesPerDay, c.maxLaunchesPerDay),
  );
  const maxSolPerDay = clamp(input.maxSolPerDay ?? input.base.maxSolPerDay, input.base.maxSolPerDay, c.maxSolPerDay);
  const maxConcurrentPositions = Math.round(
    clamp(
      input.maxConcurrentPositions ?? input.base.maxConcurrentPositions,
      input.base.maxConcurrentPositions,
      c.maxConcurrentPositions,
    ),
  );
  let maxDailyLossSol = clamp(
    input.maxDailyLossSol ?? input.base.maxDailyLossSol,
    input.base.maxDailyLossSol,
    c.maxDailyLossSol,
  );
  // Mirror assertCoherent(): the loss circuit-breaker must be able to trip.
  if (maxDailyLossSol > maxSolPerDay) maxDailyLossSol = maxSolPerDay;

  const threshold = clamp(
    input.threshold ?? input.base.threshold,
    c.thresholdFloor,
    input.base.threshold,
  );
  const minObservations = Math.round(
    clamp(input.minObservations ?? input.base.minObservations, c.minObservationsFloor, input.base.minObservations),
  );

  const now = Date.now();
  const record: ExperimentalWindow = {
    createdAt: now,
    expiresAt: now + hours * 60 * 60 * 1000,
    reason: input.reason?.trim() || "unspecified",
    risk: { maxLaunchesPerDay, maxSolPerDay, maxDailyLossSol, maxConcurrentPositions },
    scoring: { threshold, minObservations },
  };

  kvSet(db, KV_KEY, JSON.stringify(record));
  log.warn("experimental window opened", { ...record, requested: input });
  return record;
}

/**
 * Active window, or `undefined` when inactive: no row, malformed JSON,
 * malformed shape, or expired. The expiry case clears the row and logs once,
 * so a stale window self-cleans without needing a restart or external job.
 */
export function getExperimentalWindow(db: Db): ExperimentalWindow | undefined {
  const raw = kvGet(db, KV_KEY);
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isWellFormed(parsed)) return undefined;

  if (Date.now() >= parsed.expiresAt) {
    kvSet(db, KV_KEY, "");
    log.info("experimental window expired, reverted to standard limits", {
      reason: parsed.reason,
      createdAt: parsed.createdAt,
      expiresAt: parsed.expiresAt,
    });
    return undefined;
  }

  return parsed;
}

export function clearExperimentalWindow(db: Db, reason: string): void {
  const active = getExperimentalWindow(db);
  kvSet(db, KV_KEY, "");
  if (active) {
    log.info("experimental window cancelled", { reason, wasActiveUntil: active.expiresAt });
  }
}

/**
 * `cfg.risk` with the active window's fields overlaid; `cfg.risk` unchanged
 * if no window is active. Re-clamped against `EXPERIMENTAL_CEILINGS` again
 * here as defense in depth against a hand-edited kv row.
 */
export function effectiveRisk(db: Db, cfg: Config): RiskConfig {
  const w = getExperimentalWindow(db);
  if (!w) return cfg.risk;

  const c = EXPERIMENTAL_CEILINGS;
  return {
    ...cfg.risk,
    maxLaunchesPerDay: Math.min(Math.round(w.risk.maxLaunchesPerDay), c.maxLaunchesPerDay),
    maxSolPerDay: Math.min(w.risk.maxSolPerDay, c.maxSolPerDay),
    maxDailyLossSol: Math.min(w.risk.maxDailyLossSol, c.maxDailyLossSol),
    maxConcurrentPositions: Math.min(Math.round(w.risk.maxConcurrentPositions), c.maxConcurrentPositions),
  };
}

/** Same pattern, `scoring.threshold`/`scoring.minObservations` only. */
export function effectiveScoring(db: Db, cfg: Config): ScoringConfig {
  const w = getExperimentalWindow(db);
  if (!w) return cfg.scoring;

  const c = EXPERIMENTAL_CEILINGS;
  return {
    ...cfg.scoring,
    threshold: Math.max(w.scoring.threshold, c.thresholdFloor),
    minObservations: Math.max(Math.round(w.scoring.minObservations), c.minObservationsFloor),
  };
}
