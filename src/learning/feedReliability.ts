import type { Db } from "../util/db.ts";
import { familyOf, type Family } from "../scoring/independence.ts";

/**
 * A bounded score dampener for source families with a long, unbroken record
 * of producing duds.
 *
 * The evidence that forced this: 9 of 9 settled fourchan-sourced launches
 * were duds, while the only winner came from press. 25 outcomes is far too
 * thin for anything clever -- a smoothed hit-rate model at this sample size
 * mostly amplifies noise -- so the rule is deliberately blunt and one-sided:
 *
 *   - Only families with a LOT of settled evidence and ZERO non-duds are
 *     dampened, and never below 0.7. A family can always redeem itself: one
 *     non-dud resets it to neutral instantly.
 *   - Nothing is ever BOOSTED. Rewarding a family for one winner in five
 *     launches is overfitting; punishing nine failures out of nine is not.
 *
 * This deliberately reads launch_outcomes -- the same evidence base the
 * tuner uses -- but is not part of the tuner: no config is written, the
 * multiplier is recomputed from raw outcomes on every scoring pass, and it
 * changes only how picky scoring is, never how much money can move
 * (invariant 3's boundary).
 */

export type ReliabilityPrior = Partial<Record<Family, number>>;

/** Dampen at >=8 all-dud outcomes, harder at >=12. Neutral otherwise. */
export function reliabilityFromCounts(
  counts: Iterable<[string, { settled: number; nonDud: number }]>,
): ReliabilityPrior {
  const out: ReliabilityPrior = {};
  for (const [family, c] of counts) {
    if (c.nonDud > 0) continue;          // any success = neutral, immediately
    if (c.settled >= 12) out[family as Family] = 0.7;
    else if (c.settled >= 8) out[family as Family] = 0.85;
  }
  return out;
}

export function computeFeedReliability(db: Db): ReliabilityPrior {
  const rows = db.prepare(
    `SELECT feeds, verdict FROM launch_outcomes
      WHERE dry_run = 0 AND settled_at IS NOT NULL`,
  ).all() as Array<{ feeds: string | null; verdict: string | null }>;

  const counts = new Map<string, { settled: number; nonDud: number }>();
  for (const r of rows) {
    let feeds: string[] = [];
    try { feeds = JSON.parse(r.feeds ?? "[]"); } catch { /* legacy rows */ }
    // Tally per FAMILY, deduplicated per launch -- a launch corroborated by
    // two crypto feeds is one piece of evidence about the crypto family.
    for (const fam of new Set(feeds.map(familyOf))) {
      const c = counts.get(fam) ?? { settled: 0, nonDud: 0 };
      c.settled++;
      if (r.verdict && r.verdict !== "dud") c.nonDud++;
      counts.set(fam, c);
    }
  }
  return reliabilityFromCounts(counts.entries());
}

/**
 * The multiplier for one candidate: the BEST factor across its families.
 * A candidate corroborated by a dampened family AND a neutral one keeps its
 * full score -- only "every source is known-bad" is punished.
 */
export function reliabilityMultiplier(prior: ReliabilityPrior, families: Iterable<string>): number {
  let best = 0;
  let any = false;
  for (const f of families) {
    any = true;
    best = Math.max(best, prior[f as Family] ?? 1);
  }
  return any ? best : 1;
}
