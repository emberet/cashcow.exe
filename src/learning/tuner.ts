import type { Db } from "../util/db.ts";
import type { Config } from "../config/schema.ts";
import { httpFetch } from "../util/http.ts";
import { log, errFields } from "../util/log.ts";
import { settledOutcomes, outcomeSummary, type OutcomeRow } from "./outcomes.ts";
import {
  applyChanges, describeMandate, type Change, type ApplyResult,
} from "./guardrails.ts";
import { redactedConfig } from "../web/queries.ts";
import { appendSelfImprovementEntry } from "./selfImprovementLog.ts";

/**
 * The learning loop.
 *
 * Periodically: aggregate what happened to past launches, hand the model
 * evidence rather than raw rows, and ask for a small number of bounded
 * adjustments to how picky the bot is. Every proposal goes through
 * `guardrails.applyChanges`, which is the actual enforcement — the prompt
 * describes the mandate, the code imposes it.
 *
 * Two deliberate constraints on when this is even allowed to run:
 *
 *   - **`minSampleSize`.** Tuning on eight launches fits noise and calls it
 *     learning. The default of 20 is already generous for a power-law outcome
 *     distribution; more is better.
 *   - **Only settled outcomes count.** A launch that is two hours old has not
 *     succeeded or failed yet, and counting it as a dud would teach the bot to
 *     avoid exactly the trends that take time to catch.
 */

export type Evidence = ReturnType<typeof gatherEvidence>;

export type TuningRun = {
  ran: boolean;
  reason?: string;
  sampleSize: number;
  rationale?: string;
  result?: ApplyResult;
  applied: boolean;
};

/** Aggregate outcomes into the comparisons that actually inform a decision. */
export function gatherEvidence(db: Db, cfg: Config) {
  const outcomes = settledOutcomes(db, cfg, 200);
  const summary = outcomeSummary(db, cfg);

  const scoreOf = (o: OutcomeRow) => (o.verdict === "hit" ? 1 : o.verdict === "modest" ? 0.4 : 0);

  const bucket = <K extends string>(
    keyFn: (o: OutcomeRow) => K[] | K,
  ): Record<string, { n: number; hitRate: number; avgPeakMcap: number; fees: number }> => {
    const acc = new Map<string, { n: number; score: number; mcap: number; fees: number }>();
    for (const o of outcomes) {
      const keys = keyFn(o);
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        const cur = acc.get(k) ?? { n: 0, score: 0, mcap: 0, fees: 0 };
        cur.n++;
        cur.score += scoreOf(o);
        cur.mcap += o.peakMcapUsd;
        cur.fees += o.estimatedFeeSol;
        acc.set(k, cur);
      }
    }
    const out: Record<string, { n: number; hitRate: number; avgPeakMcap: number; fees: number }> = {};
    for (const [k, v] of acc) {
      out[k] = {
        n: v.n,
        hitRate: Number((v.score / v.n).toFixed(3)),
        avgPeakMcap: Math.round(v.mcap / v.n),
        fees: Number(v.fees.toFixed(5)),
      };
    }
    return out;
  };

  const scoreBand = (s: number) =>
    s >= 85 ? "85+" : s >= 75 ? "75-85" : s >= 70 ? "70-75" : s >= 65 ? "65-70" : "<65";

  /** Does a component actually separate hits from duds? */
  const componentSplit = (name: string) => {
    const withVal = outcomes
      .map((o) => ({ v: o.components[name] ?? 0, s: scoreOf(o) }))
      .filter((x) => Number.isFinite(x.v));
    if (withVal.length < 4) return null;

    const sorted = [...withVal].sort((a, b) => a.v - b.v);
    const half = Math.floor(sorted.length / 2);
    const low = sorted.slice(0, half);
    const high = sorted.slice(-half);
    const mean = (arr: typeof withVal) => arr.reduce((s, x) => s + x.s, 0) / (arr.length || 1);

    return {
      lowHalfHitRate: Number(mean(low).toFixed(3)),
      highHalfHitRate: Number(mean(high).toFixed(3)),
      // Positive means the component is doing its job.
      separation: Number((mean(high) - mean(low)).toFixed(3)),
    };
  };

  const priorRuns = db.prepare(
    `SELECT ts, sample_size, accepted, rationale FROM tuning_runs
      WHERE applied = 1 ORDER BY ts DESC LIMIT 3`,
  ).all() as Array<Record<string, unknown>>;

  return {
    summary,
    sampleSize: outcomes.length,
    byScoreBand: bucket((o) => scoreBand(o.score)),
    byFeed: bucket((o) => o.feeds),
    byFamilyCount: bucket((o) => `${o.families.length} family/families`),
    byNamingSource: bucket((o) => o.namingSource || "unknown"),
    componentSeparation: {
      velocity: componentSplit("velocity"),
      corroboration: componentSplit("corroboration"),
      cryptoAffinity: componentSplit("cryptoAffinity"),
      tickerability: componentSplit("tickerability"),
      reach: componentSplit("reach"),
    },
    bestLaunches: outcomes
      .slice()
      .sort((a, b) => b.peakMcapUsd - a.peakMcapUsd)
      .slice(0, 5)
      .map((o) => ({
        term: o.term, score: Number(o.score.toFixed(1)), feeds: o.feeds,
        peakMcapUsd: Math.round(o.peakMcapUsd), verdict: o.verdict,
      })),
    worstLaunches: outcomes
      .slice()
      .filter((o) => o.verdict === "dud")
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((o) => ({
        term: o.term, score: Number(o.score.toFixed(1)), feeds: o.feeds,
        peakMcapUsd: Math.round(o.peakMcapUsd),
      })),
    priorRuns: priorRuns.map((r) => ({
      when: new Date(Number(r.ts)).toISOString(),
      sampleSize: Number(r.sample_size),
      changes: r.accepted,
      rationale: String(r.rationale ?? "").slice(0, 300),
    })),
  };
}

const SYSTEM = `You tune the selection criteria of an autonomous memecoin launcher.

The bot scores trending topics and launches the best ones on pump.fun, earning
creator fees proportional to each token's trade volume. Most launches earn
nothing; a small number earn most of the money. Your job is to adjust the
selection criteria so the bot spends its limited daily launches on candidates
that resemble past winners.

YOU MAY ONLY CHANGE HOW SELECTIVE THE BOT IS. You cannot change spend limits,
position sizes, exit rules, or content filters. Those are enforced outside your
control; proposing them wastes a change slot.

{MANDATE}

Guidance:
- Prefer few, well-argued changes over many speculative ones.
- A component with LOW separation between its high and low halves is not
  earning its weight; a component with HIGH separation deserves more.
- If the hit rate rises with score band, the threshold is working. If it is flat,
  the threshold is not selecting anything useful and the weights are the problem.
- A feed whose launches consistently dud deserves less weight. Be careful with
  small n -- five launches is not evidence.
- If nearly everything is a dud, the bot is probably not selective ENOUGH:
  raise the threshold rather than lowering it to get more launches.
- Changes are clamped to the per-run limits, so proposing a huge jump just
  produces a small step. Propose the value you actually want.

Respond with only a JSON object:
{"rationale": "2-4 sentences on what the evidence shows and why these changes follow",
 "changes": [{"path": "scoring.threshold", "value": 68, "why": "one line"}]}

Return an empty changes array if the evidence does not justify any change.`;

type ClaudeResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

export async function runTuning(db: Db, cfg: Config): Promise<TuningRun> {
  if (!cfg.learning.enabled) {
    return { ran: false, reason: "learning.enabled is false", sampleSize: 0, applied: false };
  }

  const evidence = gatherEvidence(db, cfg);

  if (evidence.sampleSize < cfg.learning.minSampleSize) {
    const run: TuningRun = {
      ran: false,
      reason:
        `only ${evidence.sampleSize} settled launches, need ${cfg.learning.minSampleSize}. ` +
        `Tuning on fewer would fit noise and call it learning.`,
      sampleSize: evidence.sampleSize,
      applied: false,
    };
    appendSelfImprovementEntry(db, cfg, run);
    return run;
  }

  const apiKey = process.env[cfg.learning.apiKeyEnv];
  if (!apiKey) {
    const run: TuningRun = {
      ran: false,
      reason: `${cfg.learning.apiKeyEnv} is not set`,
      sampleSize: evidence.sampleSize,
      applied: false,
    };
    appendSelfImprovementEntry(db, cfg, run);
    return run;
  }

  const proposal = await askModel(cfg, evidence, apiKey);

  const result = applyChanges(proposal.changes, redactedConfig(cfg), {
    pinned: cfg.learning.pinned,
    maxChanges: cfg.learning.maxChangesPerRun,
  });

  const apply = cfg.learning.autoApply && result.accepted.length > 0;

  db.prepare(
    `INSERT INTO tuning_runs (ts, sample_size, accepted, rejected, rationale, model, applied)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(), evidence.sampleSize,
    JSON.stringify(result.accepted), JSON.stringify(result.rejected),
    proposal.rationale, cfg.learning.model, apply ? 1 : 0,
  );

  log.info("tuning run complete", {
    sampleSize: evidence.sampleSize,
    accepted: result.accepted.length,
    rejected: result.rejected.length,
    applied: apply,
  });
  if (result.rejected.length) {
    log.warn("tuning proposals rejected by guardrails", { rejected: result.rejected });
  }

  const run: TuningRun = {
    ran: true,
    sampleSize: evidence.sampleSize,
    rationale: proposal.rationale,
    result,
    applied: apply,
  };
  appendSelfImprovementEntry(db, cfg, run);
  return run;
}

async function askModel(
  cfg: Config, evidence: Evidence, apiKey: string,
): Promise<{ rationale: string; changes: Change[] }> {
  const system = SYSTEM.replace("{MANDATE}", describeMandate());

  const res = await httpFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.learning.model,
      max_tokens: 1500,
      system,
      messages: [{
        role: "user",
        content:
          `Current selection config:\n${JSON.stringify(
            { scoring: cfg.scoring, saturation: cfg.saturation,
              feedWeights: Object.fromEntries(
                Object.entries(cfg.feeds).map(([k, v]) => [k, v.weight]),
              ) },
            null, 2,
          )}\n\nOutcome evidence:\n${JSON.stringify(evidence, null, 2)}`,
      }],
    }),
    timeoutMs: 60_000,
    retries: 1,
  });

  const json = (await res.json()) as ClaudeResponse;
  if (json.error) throw new Error(json.error.message ?? "anthropic api error");

  const text = json.content?.find((c) => c.type === "text")?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("tuner response contained no JSON object");

  const parsed = JSON.parse(match[0]) as {
    rationale?: string;
    changes?: Array<{ path?: string; value?: number }>;
  };

  return {
    rationale: (parsed.rationale ?? "").slice(0, 1000),
    changes: (parsed.changes ?? [])
      .filter((c): c is { path: string; value: number } =>
        typeof c.path === "string" && typeof c.value === "number")
      .map((c) => ({ path: c.path, value: c.value })),
  };
}

export function lastTuningRun(db: Db): Record<string, unknown> | undefined {
  return db.prepare(
    `SELECT ts, sample_size, accepted, rejected, rationale, applied
       FROM tuning_runs ORDER BY ts DESC LIMIT 1`,
  ).get() as Record<string, unknown> | undefined;
}

export function tuningHistory(db: Db, limit = 20): Array<Record<string, unknown>> {
  return db.prepare(
    `SELECT id, ts, sample_size, accepted, rejected, rationale, applied, reverted_at
       FROM tuning_runs ORDER BY ts DESC LIMIT ?`,
  ).all(limit) as Array<Record<string, unknown>>;
}
