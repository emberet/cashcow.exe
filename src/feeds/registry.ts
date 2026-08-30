import type { Config } from "../config/schema.ts";
import type { FeedAdapter, FeedContext, RawSignal } from "./types.ts";
import { googleTrendsFeed } from "./googleTrends.ts";
import { redditFeed } from "./reddit.ts";
import { xApiFeed } from "./xApi.ts";
import { fourchanFeed } from "./fourchan.ts";
import { farcasterFeed } from "./farcaster.ts";
import { polymarketFeed } from "./polymarket.ts";
import { onchainFeed } from "./onchain.ts";
import { dexActivityFeed } from "./dexActivity.ts";
import { hackernewsFeed } from "./hackernews.ts";
import { googleNewsFeed } from "./googleNews.ts";
import { wikipediaFeed } from "./wikipedia.ts";
import { watchlistFeed } from "./watchlist.ts";
import { knowYourMemeFeed } from "./knowYourMeme.ts";
import { urbanDictionaryFeed } from "./urbanDictionary.ts";
import { log, errFields } from "../util/log.ts";

const ALL: Record<string, FeedAdapter> = {
  googleTrends: googleTrendsFeed,
  reddit: redditFeed,
  xApi: xApiFeed,
  fourchan: fourchanFeed,
  farcaster: farcasterFeed,
  polymarket: polymarketFeed,
  onchain: onchainFeed,
  dexActivity: dexActivityFeed,
  hackernews: hackernewsFeed,
  googleNews: googleNewsFeed,
  wikipedia: wikipediaFeed,
  watchlist: watchlistFeed,
  knowYourMeme: knowYourMemeFeed,
  urbanDictionary: urbanDictionaryFeed,
};

export type FeedKey = keyof Config["feeds"];

export type PollOutcome = {
  feed: string;
  signals: RawSignal[];
  ok: boolean;
  skipped?: string;
  error?: string;
  durationMs: number;
};

export function enabledFeeds(
  cfg: Config,
): Array<{ adapter: FeedAdapter; weight: number; pollSeconds: number }> {
  const out: Array<{ adapter: FeedAdapter; weight: number; pollSeconds: number }> = [];
  for (const [key, feedCfg] of Object.entries(cfg.feeds)) {
    if (!feedCfg.enabled) continue;
    const adapter = ALL[key];
    if (!adapter) {
      log.warn("config enables an unknown feed", { feed: key });
      continue;
    }
    // Config weight/interval override the adapter's built-in defaults.
    out.push({ adapter, weight: feedCfg.weight, pollSeconds: feedCfg.pollSeconds });
  }
  return out;
}

/**
 * When each feed last actually polled. Module-level on purpose: the runner
 * calls pollAll on the FASTEST feed's cadence, and without this every feed
 * would be hit at that cadence -- Wikipedia's daily data was being fetched
 * every 90 seconds because on-chain wanted 90 seconds.
 */
const lastPolledAt = new Map<string, number>();

export function __resetPollSchedule(): void {
  lastPolledAt.clear();
}

export function getFeed(id: string): FeedAdapter | undefined {
  return ALL[id];
}

export function allFeedIds(): string[] {
  return Object.keys(ALL);
}

/**
 * Poll every enabled feed concurrently.
 *
 * Failures are isolated per feed: one dead endpoint (a rate limit, a blocked
 * host, a missing key) degrades that source and leaves the rest of the loop
 * running. A feed that is not ready is skipped with a reason rather than
 * throwing, so a missing API key is a visible warning and not a crash.
 */
export async function pollAll(
  ctx: FeedContext,
  opts: { force?: boolean } = {},
): Promise<PollOutcome[]> {
  const feeds = enabledFeeds(ctx.cfg);
  const now = Date.now();

  return Promise.all(feeds.map(async ({ adapter, pollSeconds }): Promise<PollOutcome> => {
    const started = Date.now();

    // Respect each feed's own cadence rather than the loop's. A feed that is
    // not due yet is a silent no-op, not an error.
    const last = lastPolledAt.get(adapter.id) ?? 0;
    if (!opts.force && now - last < pollSeconds * 1000) {
      return { feed: adapter.id, signals: [], ok: true, skipped: "not due", durationMs: 0 };
    }

    const ready = adapter.readiness(ctx);
    if (!ready.ready) {
      log.warn("feed skipped", { feed: adapter.id, reason: ready.reason });
      return {
        feed: adapter.id, signals: [], ok: false,
        skipped: ready.reason, durationMs: Date.now() - started,
      };
    }

    try {
      lastPolledAt.set(adapter.id, now);
      const signals = await adapter.poll(ctx);
      log.debug("feed polled", {
        feed: adapter.id, signals: signals.length, ms: Date.now() - started,
      });
      return { feed: adapter.id, signals, ok: true, durationMs: Date.now() - started };
    } catch (e) {
      log.warn("feed poll failed", { feed: adapter.id, ...errFields(e) });
      return {
        feed: adapter.id, signals: [], ok: false,
        error: String(errFields(e).err), durationMs: Date.now() - started,
      };
    }
  }));
}
