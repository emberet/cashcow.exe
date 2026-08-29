import { fetchJson } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";
import { log } from "../util/log.ts";

/**
 * X / Twitter recent search.
 *
 * The only feed here that costs money: X moved to pay-per-use in Feb 2026
 * (~$0.005 per post read) and retired the free tier. So this adapter charges an
 * estimated cost to a USD meter *before* it issues the request, and returns
 * empty once the monthly cap is reached. A polling bug can therefore waste a
 * poll, but it cannot run up a bill.
 *
 * Env: X_BEARER_TOKEN
 */

type Tweet = {
  id?: string;
  text?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count?: number; reply_count?: number;
    like_count?: number; quote_count?: number; impression_count?: number;
  };
};
type SearchResponse = { data?: Tweet[]; meta?: { result_count?: number } };

export const METER_KEY = "x-api-usd";

export const xApiFeed: FeedAdapter = {
  id: "xApi",
  weight: 1.2,
  pollSeconds: 300,

  readiness(ctx: FeedContext) {
    if (!process.env.X_BEARER_TOKEN) {
      return { ready: false, reason: "X_BEARER_TOKEN not set" };
    }
    const c = ctx.cfg.feeds.xApi;
    const used = ctx.budget.meterUsed(METER_KEY);
    if (used >= c.monthlyUsdCap) {
      return {
        ready: false,
        reason: `monthly X API cap reached ($${used.toFixed(2)} of $${c.monthlyUsdCap})`,
      };
    }
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.xApi;

    // Charge before spending. Estimate the worst case: a full page of results.
    const estimate = c.maxResults * c.estimatedCostPerRead;
    if (!ctx.budget.meterCharge(METER_KEY, estimate, c.monthlyUsdCap)) {
      log.warn("X API poll skipped: monthly USD cap would be exceeded", {
        used: ctx.budget.meterUsed(METER_KEY), cap: c.monthlyUsdCap, estimate,
      });
      return [];
    }

    const url =
      "https://api.x.com/2/tweets/search/recent" +
      `?query=${encodeURIComponent(c.query)}` +
      `&max_results=${c.maxResults}` +
      "&tweet.fields=public_metrics,created_at";

    const json = await fetchJson<SearchResponse>(url, {
      headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN!}` },
      timeoutMs: 12_000,
      retries: 1, // every retry is billable; do not hammer
    });

    // Reconcile: the charge above was the worst case, and this query is
    // filtered hard enough that most polls come back far short of a full page.
    // X reports what it actually returned, so bill that instead of leaving the
    // over-estimate on the meter. Without this the meter read $43.88 against
    // roughly $9 of real spend and was about to stop the feed with most of the
    // month's credit still unused. Refund is clamped at the meter, so a
    // surprising result_count can never mint headroom.
    const actualReads = json.meta?.result_count ?? json.data?.length ?? c.maxResults;
    const overcharge = estimate - Math.min(actualReads, c.maxResults) * c.estimatedCostPerRead;
    if (overcharge > 0) ctx.budget.meterRefund(METER_KEY, overcharge);

    const out: RawSignal[] = [];
    for (const t of json.data ?? []) {
      const text = t.text?.trim();
      if (!text) continue;

      const m = t.public_metrics ?? {};
      const engagement =
        (m.like_count ?? 0) +
        (m.retweet_count ?? 0) * 3 +
        (m.quote_count ?? 0) * 3 +
        (m.reply_count ?? 0) * 2;

      const created = t.created_at && !Number.isNaN(Date.parse(t.created_at))
        ? new Date(t.created_at) : new Date();

      out.push({
        feed: "xApi",
        term: text.slice(0, 200),
        rawScore: logNorm(engagement, 5_000),
        observedAt: created,
        url: t.id ? `https://x.com/i/status/${t.id}` : undefined,
        meta: { ...m, engagement },
      });
    }

    log.debug("x api poll", {
      results: out.length, estimatedUsd: estimate, meterUsed: ctx.budget.meterUsed(METER_KEY),
    });
    return out;
  },
};
