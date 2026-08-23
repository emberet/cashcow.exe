import type { Db } from "../util/db.ts";
import type { SaturationConfig } from "../config/schema.ts";
import { contentKey, normalize, similarity } from "../util/text.ts";

/**
 * The single highest-leverage check in the bot.
 *
 * Creator fees are a share of *this token's* volume. If the trend already has
 * forty tokens chasing it, the volume fragments and a launch earns nothing
 * while still costing rent and priority fees. Skipping a saturated trend is
 * almost always correct; the cost of a false positive is one missed launch,
 * the cost of a false negative is a guaranteed loss.
 */

export type KnownToken = {
  name: string;
  symbol: string;
  createdAt: number;
  source: "self" | "market";
  mint?: string;
};

export type SaturationResult = {
  saturated: boolean;
  reason?: string;
  matches: Array<{ token: KnownToken; score: number }>;
};

/** Injected so the check is testable offline and survives endpoint changes. */
export interface MarketTokenSource {
  recentTokens(term: string, sinceMs: number): Promise<KnownToken[]>;
}

export function selfLaunched(db: Db, sinceMs: number): KnownToken[] {
  const rows = db.prepare(
    `SELECT mint, term, name, symbol, created_at FROM launches WHERE created_at > ?`,
  ).all(sinceMs) as Array<{
    mint: string; term: string; name: string; symbol: string; created_at: number;
  }>;
  return rows.map((r) => ({
    name: r.name || r.term, symbol: r.symbol,
    createdAt: r.created_at, source: "self" as const, mint: r.mint,
  }));
}

/** Has this exact trend ever been launched by us? Checked over all time. */
export function everLaunched(db: Db, term: string): boolean {
  const key = contentKey(term);
  const norm = normalize(term);
  const row = db.prepare(
    `SELECT 1 AS hit FROM launches WHERE norm = ? OR norm = ? LIMIT 1`,
  ).get(key, norm) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * Pure core: given a candidate and the tokens already in the world, decide
 * whether the trend is too crowded to be worth launching into.
 */
export function evaluateSaturation(
  term: string,
  candidateSymbol: string | undefined,
  known: KnownToken[],
  cfg: SaturationConfig,
): SaturationResult {
  const matches: Array<{ token: KnownToken; score: number }> = [];
  const candSym = candidateSymbol ? normalize(candidateSymbol) : "";

  for (const token of known) {
    const byName = similarity(term, token.name);
    const bySymbol = candSym && token.symbol
      ? similarity(candSym, normalize(token.symbol))
      : 0;
    // An identical ticker is a collision even when the names read differently.
    const score = Math.max(byName, bySymbol);
    if (score >= cfg.similarityThreshold) matches.push({ token, score });
  }

  matches.sort((a, b) => b.score - a.score);

  if (matches.length >= cfg.maxSimilar) {
    const top = matches.slice(0, 3)
      .map((m) => `${m.token.symbol || m.token.name} (${m.score.toFixed(2)}, ${m.token.source})`)
      .join(", ");
    return {
      saturated: true,
      reason:
        `${matches.length} similar token(s) already exist within ${cfg.lookbackHours}h ` +
        `(cap ${cfg.maxSimilar}): ${top}`,
      matches,
    };
  }

  return { saturated: false, matches };
}

/** Full check: our own history plus the live market. */
export async function checkSaturation(
  db: Db,
  term: string,
  candidateSymbol: string | undefined,
  cfg: SaturationConfig,
  market?: MarketTokenSource,
): Promise<SaturationResult> {
  if (cfg.neverRelaunchSameTerm && everLaunched(db, term)) {
    return {
      saturated: true,
      reason: `we have already launched "${term}" before; neverRelaunchSameTerm is on`,
      matches: [],
    };
  }

  const since = Date.now() - cfg.lookbackHours * 3600_000;
  const known = selfLaunched(db, since);

  if (market) {
    try {
      known.push(...(await market.recentTokens(term, since)));
    } catch {
      // A market lookup failure must not read as "the trend is clear". Treat an
      // unverifiable market as saturated and skip: not launching is free.
      return {
        saturated: true,
        reason: "market saturation lookup failed; skipping rather than launching blind",
        matches: [],
      };
    }
  }

  return evaluateSaturation(term, candidateSymbol, known, cfg);
}
