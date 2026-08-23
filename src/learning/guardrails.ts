/**
 * What the tuner is allowed to change, enforced in code.
 *
 * This is the load-bearing safety boundary of the whole learning system. An
 * LLM that can rewrite its own configuration is only acceptable if the set of
 * writable keys is small, explicit, and does not include anything that governs
 * spend.
 *
 * The rule, stated plainly: **the tuner can change how PICKY the bot is. It can
 * never change how much money the bot may lose.**
 *
 * So `scoring.threshold` is tunable and `risk.maxSolPerDay` is not — and the
 * distinction is enforced by this allowlist, not by asking the model nicely in
 * a prompt. A prompt is a request; this is a gate. Anything not listed here is
 * rejected, so adding a config key never silently widens what the tuner can
 * reach.
 */

export type Bound = {
  /** Dotted config path. `*` matches exactly one path segment. */
  path: string;
  min: number;
  max: number;
  /** Largest change permitted in a single tuning run. */
  maxDelta: number;
  integer?: boolean;
  why: string;
};

export const TUNABLE: Bound[] = [
  {
    path: "scoring.threshold",
    min: 30, max: 95, maxDelta: 5,
    why: "how good a candidate must be to launch",
  },
  {
    path: "scoring.weights.*",
    min: 0, max: 0.6, maxDelta: 0.05,
    why: "relative importance of each score component",
  },
  {
    path: "scoring.decayHalfLifeMinutes",
    min: 10, max: 240, maxDelta: 15,
    why: "how fast a trend goes stale",
  },
  {
    path: "scoring.minObservations",
    min: 1, max: 10, maxDelta: 1, integer: true,
    why: "how many sightings before a term is trusted",
  },
  {
    path: "scoring.minCorroboratingFeeds",
    min: 1, max: 4, maxDelta: 1, integer: true,
    why: "hard gate on distinct sources",
  },
  {
    path: "scoring.minIndependentFamilies",
    min: 1, max: 3, maxDelta: 1, integer: true,
    why: "hard gate on independent source families",
  },
  {
    path: "saturation.similarityThreshold",
    min: 0.5, max: 0.95, maxDelta: 0.05,
    why: "how alike two tokens must be to count as the same trend",
  },
  {
    path: "saturation.maxSimilar",
    min: 1, max: 8, maxDelta: 1, integer: true,
    why: "how crowded a trend may be before we skip it",
  },
  {
    path: "feeds.*.weight",
    min: 0, max: 2, maxDelta: 0.25,
    why: "how much each source counts toward a score",
  },
];

/**
 * Never tunable, at any bound. Listed explicitly so the reason is on the record
 * rather than implied by absence from the allowlist above.
 */
export const FORBIDDEN_PREFIXES: Array<{ prefix: string; why: string }> = [
  { prefix: "risk.", why: "spend ceilings, launch caps and the loss breaker" },
  { prefix: "devPosition.", why: "position size and exit rules — real money" },
  { prefix: "launch.", why: "includes the permanent cashback decision" },
  { prefix: "filters.", why: "trademark, likeness and tragedy screening" },
  { prefix: "wallet.", why: "key material location" },
  { prefix: "rpc.", why: "endpoints and priority-fee ceilings" },
  { prefix: "web.", why: "network exposure and auth" },
  { prefix: "fees.", why: "creator fee claiming" },
  { prefix: "storage.", why: "database and halt-file paths" },
  { prefix: "learning.", why: "the tuner must not widen its own mandate" },
  { prefix: "dryRun", why: "the practice-mode switch" },
  { prefix: "network", why: "mainnet vs devnet" },
];

export type Change = { path: string; value: number };

export type Verdict =
  | { ok: true; path: string; from: number; to: number; clamped: boolean }
  | { ok: false; path: string; reason: string };

function matches(pattern: string, path: string): boolean {
  const p = pattern.split(".");
  const q = path.split(".");
  if (p.length !== q.length) return false;
  return p.every((seg, i) => seg === "*" || seg === q[i]);
}

export function boundFor(path: string): Bound | undefined {
  return TUNABLE.find((b) => matches(b.path, path));
}

export function getAt(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, key) =>
      acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
    obj,
  );
}

function setAt(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * Validate one proposed change against the live config.
 * Out-of-range values are clamped rather than rejected: the intended direction
 * is usually right even when the magnitude is not.
 */
export function validate(
  change: Change,
  currentConfig: unknown,
  pinned: string[] = [],
): Verdict {
  const { path } = change;

  for (const f of FORBIDDEN_PREFIXES) {
    if (path === f.prefix || path.startsWith(f.prefix)) {
      return { ok: false, path, reason: `forbidden: ${f.why}` };
    }
  }

  if (pinned.some((p) => p === path || matches(p, path))) {
    return { ok: false, path, reason: "pinned by the operator" };
  }

  const bound = boundFor(path);
  if (!bound) return { ok: false, path, reason: "not in the tunable allowlist" };

  if (typeof change.value !== "number" || !Number.isFinite(change.value)) {
    return { ok: false, path, reason: "value is not a finite number" };
  }

  const current = getAt(currentConfig, path);
  if (typeof current !== "number") {
    return { ok: false, path, reason: "no current numeric value at that path" };
  }

  let target = change.value;
  let clamped = false;

  // Rate limit first, so a wild proposal becomes a small step rather than a jump.
  const delta = target - current;
  if (Math.abs(delta) > bound.maxDelta) {
    target = current + Math.sign(delta) * bound.maxDelta;
    clamped = true;
  }
  if (target < bound.min) { target = bound.min; clamped = true; }
  if (target > bound.max) { target = bound.max; clamped = true; }
  if (bound.integer) target = Math.round(target);

  if (target === current) {
    return { ok: false, path, reason: "no change after clamping" };
  }

  return { ok: true, path, from: current, to: target, clamped };
}

export type ApplyResult = {
  overlay: Record<string, unknown>;
  accepted: Array<{ path: string; from: number; to: number; clamped: boolean }>;
  rejected: Array<{ path: string; reason: string }>;
};

/**
 * Turn a batch of proposals into a config overlay.
 * Score weights are renormalised to sum to 1 afterwards, since the loader
 * rejects any config where they do not.
 */
export function applyChanges(
  changes: Change[],
  currentConfig: unknown,
  opts: { pinned?: string[]; maxChanges: number },
): ApplyResult {
  const overlay: Record<string, unknown> = {};
  const accepted: ApplyResult["accepted"] = [];
  const rejected: ApplyResult["rejected"] = [];

  for (const change of changes) {
    if (accepted.length >= opts.maxChanges) {
      rejected.push({ path: change.path, reason: `exceeds maxChangesPerRun (${opts.maxChanges})` });
      continue;
    }
    const v = validate(change, currentConfig, opts.pinned ?? []);
    if (!v.ok) {
      rejected.push({ path: v.path, reason: v.reason });
      continue;
    }
    setAt(overlay, v.path, v.to);
    accepted.push({ path: v.path, from: v.from, to: v.to, clamped: v.clamped });
  }

  if (accepted.some((a) => a.path.startsWith("scoring.weights."))) {
    renormaliseWeights(overlay, currentConfig);
  }

  return { overlay, accepted, rejected };
}

const WEIGHT_KEYS = ["velocity", "corroboration", "cryptoAffinity", "tickerability", "reach"];

function renormaliseWeights(overlay: Record<string, unknown>, currentConfig: unknown): void {
  const merged: Record<string, number> = {};
  for (const k of WEIGHT_KEYS) {
    const fromOverlay = getAt(overlay, `scoring.weights.${k}`);
    const fromConfig = getAt(currentConfig, `scoring.weights.${k}`);
    merged[k] = typeof fromOverlay === "number"
      ? fromOverlay
      : typeof fromConfig === "number" ? fromConfig : 0;
  }

  const sum = WEIGHT_KEYS.reduce((s, k) => s + merged[k]!, 0);
  if (sum <= 0) return;

  for (const k of WEIGHT_KEYS) {
    setAt(overlay, `scoring.weights.${k}`, Number((merged[k]! / sum).toFixed(4)));
  }
}

/** Human-readable summary of the mandate, for the prompt and the docs. */
export function describeMandate(): string {
  const allow = TUNABLE.map((b) => `  ${b.path}  [${b.min}..${b.max}], max ±${b.maxDelta} per run — ${b.why}`);
  const deny = FORBIDDEN_PREFIXES.map((f) => `  ${f.prefix}* — ${f.why}`);
  return `TUNABLE:\n${allow.join("\n")}\n\nNEVER TUNABLE:\n${deny.join("\n")}`;
}
