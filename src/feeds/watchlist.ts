import { fetchJson } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";
import { log, errFields } from "../util/log.ts";
import { kvGet, kvSet } from "../util/db.ts";
import type { Db } from "../util/db.ts";

/**
 * Tweets from a small, named watchlist of accounts that *cause* memes rather
 * than merely reporting them -- the operator's chosen mix of mainstream and
 * crypto-native voices. The bet: a phrase in one of these accounts' posts
 * trends minutes-to-hours before it shows up in news or search feeds.
 *
 * Only the PHRASES travel. Tweet text goes through the exact same pipeline
 * as every other feed -- extractPhrases(), scoring, and critically the
 * brand/likeness filters, so a token named after the *person* is still
 * rejected (right-of-publicity, filters.ts). What launches is the meme they
 * started, never their name. That boundary is the operator's explicit,
 * recorded decision, not an accident of implementation.
 *
 * Costs: reads bill against the SAME x-api-usd meter as feeds/xApi.ts and
 * against the same cfg.feeds.xApi.monthlyUsdCap -- one read budget, two
 * spenders, deliberately: the alternative is two caps that can starve each
 * other invisibly. `since_id` is persisted per account so a poll only reads
 * (and only pays for) tweets it has not seen, and the worst-case pre-charge
 * is reconciled against result_count exactly like xApi.ts.
 *
 * Env: X_BEARER_TOKEN (the read credential; posting uses different keys).
 */

export const METER_KEY = "x-api-usd"; // shared read budget with xApi.ts

type Tweet = {
  id?: string;
  text?: string;
  created_at?: string;
  public_metrics?: {
    retweet_count?: number; reply_count?: number;
    like_count?: number; quote_count?: number;
  };
};

type TimelineResponse = { data?: Tweet[]; meta?: { result_count?: number; newest_id?: string } };
type UsersByResponse = { data?: Array<{ id: string; username: string }> };

const ID_CACHE_KEY = "watchlistUserIds";      // username(lower) -> id, JSON
const SINCE_KEY = "watchlistSinceIds";        // userId -> since_id, JSON

function readJson(db: Db | undefined, key: string): Record<string, string> {
  if (!db) return {};
  try { return JSON.parse(kvGet(db, key) ?? "{}"); } catch { return {}; }
}
function writeJson(db: Db | undefined, key: string, value: Record<string, string>): void {
  if (db) kvSet(db, key, JSON.stringify(value));
}

async function resolveUserIds(ctx: FeedContext, handles: string[]): Promise<Record<string, string>> {
  const cached = readJson(ctx.db, ID_CACHE_KEY);
  const missing = handles.filter((h) => !cached[h.toLowerCase()]);
  if (missing.length === 0) return cached;

  // One lookup for all missing handles; ids never change, so this normally
  // runs once per handle for the lifetime of the deployment.
  const url = "https://api.x.com/2/users/by?usernames=" +
    encodeURIComponent(missing.join(","));
  const res = await fetchJson<UsersByResponse>(url, {
    headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN!}` },
    timeoutMs: 12_000, retries: 1,
  });
  for (const u of res.data ?? []) cached[u.username.toLowerCase()] = u.id;
  writeJson(ctx.db, ID_CACHE_KEY, cached);
  return cached;
}

export const watchlistFeed: FeedAdapter = {
  id: "watchlist",
  weight: 1.5,
  pollSeconds: 900,

  readiness(ctx: FeedContext) {
    if (!process.env.X_BEARER_TOKEN) {
      return { ready: false, reason: "X_BEARER_TOKEN not set" };
    }
    const c = ctx.cfg.feeds.watchlist;
    if (c.handles.length === 0) {
      return { ready: false, reason: "no handles configured" };
    }
    const used = ctx.budget.meterUsed(METER_KEY);
    const cap = ctx.cfg.feeds.xApi.monthlyUsdCap; // shared read budget
    if (used >= cap) {
      return { ready: false, reason: `monthly X API cap reached ($${used.toFixed(2)} of $${cap})` };
    }
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.watchlist;
    const cap = ctx.cfg.feeds.xApi.monthlyUsdCap;
    const perRead = ctx.cfg.feeds.xApi.estimatedCostPerRead;

    const ids = await resolveUserIds(ctx, c.handles);
    const since = readJson(ctx.db, SINCE_KEY);
    const out: RawSignal[] = [];

    for (const handle of c.handles) {
      const id = ids[handle.toLowerCase()];
      if (!id) continue; // suspended/renamed; resolveUserIds will retry later

      // Worst case charged before the request, reconciled after -- the same
      // shape as xApi.poll(). since_id keeps the normal case cheap: only
      // tweets never seen before come back, so quiet accounts cost nothing.
      const estimate = c.maxResultsPerUser * perRead;
      if (!ctx.budget.meterCharge(METER_KEY, estimate, cap)) {
        log.warn("watchlist poll stopped mid-list: X read budget exhausted", {
          used: ctx.budget.meterUsed(METER_KEY), cap, remainingHandles: handle,
        });
        break;
      }

      try {
        const url = `https://api.x.com/2/users/${id}/tweets` +
          `?max_results=${c.maxResultsPerUser}` +
          `&exclude=retweets,replies` +
          `&tweet.fields=public_metrics,created_at` +
          (since[id] ? `&since_id=${since[id]}` : "");
        const json = await fetchJson<TimelineResponse>(url, {
          headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN!}` },
          timeoutMs: 12_000,
          retries: 1, // billable
        });

        const actualReads = json.meta?.result_count ?? json.data?.length ?? c.maxResultsPerUser;
        const overcharge = estimate - Math.min(actualReads, c.maxResultsPerUser) * perRead;
        if (overcharge > 0) ctx.budget.meterRefund(METER_KEY, overcharge);

        if (json.meta?.newest_id) {
          since[id] = json.meta.newest_id;
          writeJson(ctx.db, SINCE_KEY, since);
        }

        for (const t of json.data ?? []) {
          const text = t.text?.trim();
          if (!text) continue;
          const m = t.public_metrics ?? {};
          const engagement = (m.like_count ?? 0) + (m.retweet_count ?? 0) * 3 +
            (m.quote_count ?? 0) * 3 + (m.reply_count ?? 0) * 2;
          const created = t.created_at && !Number.isNaN(Date.parse(t.created_at))
            ? new Date(t.created_at) : new Date();

          out.push({
            feed: "watchlist",
            term: text.slice(0, 200),
            // These accounts saturate engagement metrics on every post, so a
            // higher knee than xApi's 5k keeps rawScore discriminating
            // between their ordinary posts and their viral ones.
            rawScore: logNorm(engagement, 50_000),
            observedAt: created,
            url: t.id ? `https://x.com/${handle}/status/${t.id}` : undefined,
            meta: { handle, engagement },
          });
        }
      } catch (e) {
        // One account failing (protected, suspended, rate-limited) must not
        // cost the rest of the list its poll.
        log.warn("watchlist: one account failed, continuing", { handle, ...errFields(e) });
      }
    }

    log.debug("watchlist poll", {
      handles: c.handles.length, signals: out.length,
      meterUsed: ctx.budget.meterUsed(METER_KEY),
    });
    return out;
  },
};
