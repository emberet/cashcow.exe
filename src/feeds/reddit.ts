import { fetchJson, httpFetch } from "../util/http.ts";
import { type FeedAdapter, type FeedContext, type RawSignal, logNorm } from "./types.ts";
import { log } from "../util/log.ts";

/**
 * Reddit rising posts via app-only OAuth.
 *
 * The unauthenticated .json endpoints now return 403, so a script app
 * (client id + secret) is required even though the data is public. Free tier is
 * roughly 100 requests/minute, far more than this bot needs.
 *
 * Env: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
 */

type Listing = {
  data?: {
    children?: Array<{
      data?: {
        title?: string; permalink?: string; score?: number;
        num_comments?: number; created_utc?: number; subreddit?: string;
        stickied?: boolean; over_18?: boolean;
      };
    }>;
  };
};

let token: { value: string; expiresAt: number } | undefined;

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error("REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set");

  const res = await httpFetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    timeoutMs: 12_000,
  });

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error("reddit token response had no access_token");
  token = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return token.value;
}

export const redditFeed: FeedAdapter = {
  id: "reddit",
  weight: 1,
  pollSeconds: 180,

  readiness() {
    if (!process.env.REDDIT_CLIENT_ID || !process.env.REDDIT_CLIENT_SECRET) {
      return { ready: false, reason: "REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set" };
    }
    return { ready: true };
  },

  async poll(ctx: FeedContext): Promise<RawSignal[]> {
    const c = ctx.cfg.feeds.reddit;
    const bearer = await getToken();
    const out: RawSignal[] = [];

    for (const sub of c.subreddits) {
      try {
        const url = `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/${c.listing}` +
          `?limit=${c.limit}&raw_json=1`;
        const json = await fetchJson<Listing>(url, {
          headers: { authorization: `Bearer ${bearer}` },
          timeoutMs: 12_000,
        });

        for (const child of json.data?.children ?? []) {
          const d = child.data;
          if (!d?.title || d.stickied || d.over_18) continue;

          const score = d.score ?? 0;
          const comments = d.num_comments ?? 0;
          const createdMs = (d.created_utc ?? Date.now() / 1000) * 1000;

          // Rising posts are interesting because of their *rate*, so favour
          // engagement accumulated in a short window over raw totals.
          const ageMin = Math.max(1, (Date.now() - createdMs) / 60_000);
          const perMinute = (score + comments * 3) / ageMin;

          out.push({
            feed: "reddit",
            term: d.title,
            rawScore: logNorm(perMinute, 60),
            observedAt: new Date(createdMs),
            url: d.permalink ? `https://reddit.com${d.permalink}` : undefined,
            meta: { subreddit: d.subreddit ?? sub, score, comments, perMinute },
          });
        }
      } catch (e) {
        // One bad subreddit must not take the whole feed down.
        log.warn("reddit subreddit poll failed", { sub, err: String(e).slice(0, 160) });
      }
    }
    return out;
  },
};
