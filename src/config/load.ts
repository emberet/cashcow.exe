import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema, type Config } from "./schema.ts";
import { configureLogger, log } from "../util/log.ts";
import { familyOf } from "../scoring/independence.ts";
import { readOverlay } from "../learning/overlay.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, "../..");

/** Strip // and /* *\/ comments so the default config can stay annotated. */
function stripJsonComments(src: string): string {
  return src
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function readJsonc(path: string): unknown {
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge; arrays are replaced wholesale rather than concatenated. */
function merge(base: unknown, override: unknown): unknown {
  if (!isObject(base) || !isObject(override)) return override ?? base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in base ? merge(base[k], v) : v;
  }
  return out;
}

let cached: Config | undefined;

/**
 * Layers, lowest precedence first:
 *   1. schema defaults
 *   2. src/config/default.config.json
 *   3. ./config.json (operator's, gitignored)
 *   4. $TRENDBOT_CONFIG
 *   5. data/tuning.json  -- values the tuner has learned
 *   6. explicit overrides (CLI flags)
 *
 * The tuning overlay sits ABOVE the operator's config on purpose: a learning
 * system that could never override an authored default would never learn
 * anything. It is made safe by being narrow rather than low-priority -- the
 * overlay is re-filtered through the tunable allowlist on every load, so it can
 * only ever move the knobs the tuner was already permitted to move. Pin a key
 * via `learning.pinned` to take it back.
 */
export function loadConfig(overrides: Record<string, unknown> = {}): Config {
  const layers: unknown[] = [{}];

  const defaultPath = resolve(HERE, "default.config.json");
  if (existsSync(defaultPath)) layers.push(readJsonc(defaultPath));

  const localPath = resolve(PROJECT_ROOT, "config.json");
  if (existsSync(localPath)) layers.push(readJsonc(localPath));

  const envPath = process.env.TRENDBOT_CONFIG;
  if (envPath) {
    const p = resolve(envPath);
    if (!existsSync(p)) throw new Error(`TRENDBOT_CONFIG points at a missing file: ${p}`);
    layers.push(readJsonc(p));
  }

  // Applied before CLI overrides so an explicit flag still wins for this run.
  layers.push(readOverlay());

  layers.push(overrides);

  const merged = layers.reduce((acc, layer) => merge(acc, layer));
  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }

  const cfg = parsed.data;
  configureLogger(cfg.logging.level, cfg.logging.json);
  assertCoherent(cfg);
  cached = cfg;
  return cfg;
}

export function getConfig(): Config {
  if (!cached) throw new Error("loadConfig() must be called before getConfig()");
  return cached;
}

/**
 * Cross-field checks zod cannot express. These are the combinations that would
 * quietly cost money, so they fail loudly at startup rather than mid-loop.
 */
function assertCoherent(cfg: Config): void {
  const problems: string[] = [];

  if (cfg.devPosition.enabled) {
    const perLaunch = cfg.devPosition.buySol;
    const maxSpend = perLaunch * cfg.risk.maxLaunchesPerDay;
    if (maxSpend > cfg.risk.maxSolPerDay) {
      problems.push(
        `risk.maxSolPerDay (${cfg.risk.maxSolPerDay}) is below what ` +
        `${cfg.risk.maxLaunchesPerDay} launches x ${perLaunch} SOL dev buy would cost ` +
        `(${maxSpend.toFixed(4)} SOL). The daily ceiling would halt the bot mid-day.`,
      );
    }
  }

  if (cfg.risk.maxDailyLossSol > cfg.risk.maxSolPerDay) {
    problems.push(
      `risk.maxDailyLossSol (${cfg.risk.maxDailyLossSol}) exceeds risk.maxSolPerDay ` +
      `(${cfg.risk.maxSolPerDay}); the loss circuit-breaker can never trip.`,
    );
  }

  const w = cfg.scoring.weights;
  // Sum over EVERY key, not an enumerated list: a hardcoded list silently
  // exempts any weight added later, which is how `acceleration` was briefly
  // both invisible here and double-counted at scoring time (the tuner's
  // renormaliser had the same enumerated-list bug -- guardrails.ts
  // WEIGHT_KEYS). Object.values keeps both in lockstep with the schema.
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.01) {
    problems.push(`scoring.weights must sum to 1.0 (currently ${sum.toFixed(3)}).`);
  }

  const enabledFeedIds = Object.entries(cfg.feeds).filter(([, f]) => f.enabled).map(([id]) => id);
  if (enabledFeedIds.length < cfg.scoring.minCorroboratingFeeds) {
    problems.push(
      `scoring.minCorroboratingFeeds is ${cfg.scoring.minCorroboratingFeeds} but only ` +
      `${enabledFeedIds.length} feed(s) are enabled; no candidate could ever qualify.`,
    );
  }
  const availableFamilies = new Set(enabledFeedIds.map(familyOf)).size;
  if (availableFamilies < cfg.scoring.minIndependentFamilies) {
    problems.push(
      `scoring.minIndependentFamilies is ${cfg.scoring.minIndependentFamilies} but the ` +
      `enabled feeds only span ${availableFamilies} independent family/families; ` +
      `no candidate could ever qualify.`,
    );
  }

  // The static blocklist is a floor, not a ceiling. Live testing leaked
  // "usa network", "kevin keegan", "isack hadjar" and "sling tv" past the list
  // and the capitalisation heuristic, so real money on mainnet requires the
  // model screen unless the operator explicitly accepts the exposure.
  const screened = Boolean(process.env[cfg.assets.naming.apiKeyEnv]);
  if (!cfg.dryRun && cfg.network === "mainnet-beta" && !screened && !cfg.filters.allowUnscreenedLive) {
    problems.push(
      `Live mainnet run without ${cfg.assets.naming.apiKeyEnv}. Trademark and ` +
      `likeness screening would fall back to the static blocklist plus a ` +
      `capitalisation heuristic, which are known to leak real brands and people. ` +
      `Set the key (it rides free on the naming call), or set ` +
      `filters.allowUnscreenedLive=true to accept the exposure deliberately.`,
    );
  }
  if (!cfg.dryRun && !screened && cfg.network !== "mainnet-beta") {
    log.warn("no model screen configured; brand/likeness filtering is best-effort only", {
      env: cfg.assets.naming.apiKeyEnv,
    });
  }

  if (problems.length) {
    throw new Error(`Incoherent configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }

  if (!cfg.dryRun && cfg.network === "mainnet-beta") {
    log.warn("LIVE MAINNET MODE: this session will sign and send real transactions", {
      maxSolPerDay: cfg.risk.maxSolPerDay,
      maxLaunchesPerDay: cfg.risk.maxLaunchesPerDay,
      devBuySol: cfg.devPosition.enabled ? cfg.devPosition.buySol : 0,
    });
  }
}
