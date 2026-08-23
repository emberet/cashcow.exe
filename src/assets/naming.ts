import type { Config } from "../config/schema.ts";
import type { Candidate } from "../scoring/score.ts";
import { httpFetch } from "../util/http.ts";
import { tickerize } from "../util/text.ts";
import { compileFilters, checkAll, type CompiledFilters } from "../scoring/filters.ts";
import { log } from "../util/log.ts";

/**
 * Turn a scored trend into a token name, symbol and description.
 *
 * The model's output is re-checked against the same filters as the source
 * trend: a clean trend can still produce a name carrying a brand or a slur, and
 * by the time the name exists we are one step away from spending money on it.
 * If generation fails or is rejected, a deterministic local fallback keeps the
 * pipeline moving rather than blocking a launch on an API being reachable.
 */

export type TokenIdentity = {
  name: string;
  symbol: string;
  description: string;
  source: "model" | "fallback";
  /**
   * Set when the model judges the underlying trend to be a real brand, product
   * or person. A static blocklist cannot enumerate every mark on earth -- live
   * testing launched "usa network" and "kevin keegan" straight through one --
   * so the model is asked to classify what the list cannot know. Costs nothing
   * extra: it rides along on the naming call that was happening anyway.
   */
  risk?: { flagged: true; category: string; reason: string };
};

export class RiskyTrendError extends Error {
  readonly category: string;
  constructor(category: string, reason: string) {
    super(`trend rejected as ${category}: ${reason}`);
    this.name = "RiskyTrendError";
    this.category = category;
  }
}

const SYSTEM = `You screen and name memecoins for a Solana launchpad.

STEP 1 -- classify the trending topic. Set "risk" if the topic IS, or is primarily
identified by, any of:
- a real company, brand, product, team, or media property (e.g. "USA Network", "Man City")
- a specific real person, living or dead (e.g. "Kevin Keegan"), including athletes,
  politicians, musicians, executives and influencers
- a death, disaster, attack, crime, or other tragedy
- a slur or hate reference

Launching a token off these creates trademark, likeness and takedown exposure, so
they must be rejected rather than renamed around.

STEP 2 -- only if risk is null, produce a token identity:
- name: catchy, <= {MAXNAME} characters
- symbol: {MINTICK}-{MAXTICK} characters, A-Z and 0-9 only, uppercase
- description: one sentence, <= 120 characters, playful

Respond with only a JSON object, no prose:
{"risk": null | {"category":"brand|person|tragedy|slur","reason":"..."},
 "name":"...","symbol":"...","description":"..."}

When risk is set, name/symbol/description may be empty strings.`;

type ClaudeResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
};

type ModelOutput = {
  risk?: { category?: string; reason?: string } | null;
  name?: string;
  symbol?: string;
  description?: string;
};

export async function generateIdentity(
  cfg: Config,
  candidate: Candidate,
  filters?: CompiledFilters,
): Promise<TokenIdentity> {
  const f = filters ?? compileFilters(cfg.filters);
  const a = cfg.assets.naming;
  const apiKey = process.env[a.apiKeyEnv];

  if (apiKey) {
    try {
      const identity = await callClaude(cfg, candidate, apiKey);
      const check = checkAll([identity.name, identity.symbol, identity.description], f);
      if (check.allowed) return identity;
      log.warn("generated identity rejected by filters, using fallback", {
        term: candidate.term,
        reason: check.reason,
      });
    } catch (e) {
      // A risk verdict is a decision, not a failure: do not fall back around it.
      if (e instanceof RiskyTrendError) throw e;
      log.warn("naming model call failed, using fallback", { err: String(e).slice(0, 160) });
    }
  } else {
    log.debug("no naming API key set, using deterministic fallback", { env: a.apiKeyEnv });
  }

  return fallbackIdentity(cfg, candidate);
}

async function callClaude(
  cfg: Config,
  candidate: Candidate,
  apiKey: string,
): Promise<TokenIdentity> {
  const a = cfg.assets.naming;
  const system = SYSTEM
    .replace("{MAXNAME}", String(a.maxNameLength))
    .replace("{MINTICK}", String(a.minTickerLength))
    .replace("{MAXTICK}", String(a.maxTickerLength));

  const res = await httpFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: a.model,
      max_tokens: 300,
      system,
      messages: [{
        role: "user",
        content:
          `Trending topic: "${candidate.term}"\n` +
          `Seen on: ${candidate.feeds.join(", ")}\n` +
          `Trend score: ${candidate.score.toFixed(1)}/100`,
      }],
    }),
    timeoutMs: 20_000,
    // Every retry is a billable call; do not hammer.
    retries: 1,
  });

  const json = (await res.json()) as ClaudeResponse;
  if (json.error) throw new Error(json.error.message ?? "anthropic api error");

  const text = json.content?.find((c) => c.type === "text")?.text ?? "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("model response contained no JSON object");

  const parsed = JSON.parse(match[0]) as ModelOutput;

  if (parsed.risk && parsed.risk.category) {
    throw new RiskyTrendError(
      parsed.risk.category,
      parsed.risk.reason ?? "flagged by the screening model",
    );
  }

  const name = sanitizeName(parsed.name ?? "", a.maxNameLength);
  const symbol = sanitizeSymbol(parsed.symbol ?? "", a.minTickerLength, a.maxTickerLength);
  if (!name || !symbol) throw new Error("model response missing a usable name or symbol");

  return {
    name,
    symbol,
    description: (parsed.description ?? "").slice(0, 200).trim(),
    source: "model",
  };
}

/** Deterministic, offline, always available. */
export function fallbackIdentity(cfg: Config, candidate: Candidate): TokenIdentity {
  const a = cfg.assets.naming;
  const name = sanitizeName(candidate.term, a.maxNameLength) || "Trend";
  const symbol =
    sanitizeSymbol(
      tickerize(candidate.term, a.maxTickerLength),
      a.minTickerLength,
      a.maxTickerLength,
    ) || "TREND";

  return {
    name,
    symbol,
    description: `${name} trending on ${candidate.feeds.join(", ")}.`.slice(0, 200),
    source: "fallback",
  };
}

/** Drop control characters, which break metadata rendering downstream. */
function sanitizeName(raw: string, maxLen: number): string {
  return [...raw]
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp >= 0x20 && cp !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, maxLen);
}

function sanitizeSymbol(raw: string, minLen: number, maxLen: number): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, maxLen);
  return clean.length >= minLen ? clean : "";
}
