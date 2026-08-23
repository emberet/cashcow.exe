import type { Config } from "../config/schema.ts";
import type { BudgetGuard } from "../risk/budget.ts";

/** One observation of one term from one source at one moment. */
export type RawSignal = {
  feed: string;
  term: string;
  /** Feed-native magnitude normalised to 0..1 by the adapter. */
  rawScore: number;
  observedAt: Date;
  url?: string;
  meta?: Record<string, unknown>;
};

export type FeedContext = {
  cfg: Config;
  /** Present so metered feeds (the X API) can charge against a USD cap. */
  budget: BudgetGuard;
};

export interface FeedAdapter {
  readonly id: string;
  readonly weight: number;
  readonly pollSeconds: number;
  /** Why the feed cannot run right now: missing key, spend cap reached, disabled. */
  readiness(ctx: FeedContext): { ready: true } | { ready: false; reason: string };
  poll(ctx: FeedContext): Promise<RawSignal[]>;
}

export function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** Turns an unbounded count into 0..1 without a tiny feed dominating a large one. */
export function logNorm(value: number, saturateAt: number): number {
  if (value <= 0) return 0;
  return clamp01(Math.log1p(value) / Math.log1p(saturateAt));
}
