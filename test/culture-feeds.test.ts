import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseTrending, parsePopular } from "../src/feeds/knowYourMeme.ts";
import { urbanDictionaryFeed } from "../src/feeds/urbanDictionary.ts";
import { watchlistFeed } from "../src/feeds/watchlist.ts";
import { FEED_FAMILY } from "../src/scoring/independence.ts";
import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { BudgetGuard } from "../src/risk/budget.ts";
import { kvGet } from "../src/util/db.ts";

// ==================================================================
// The fringe-culture expansion (operator directive 2026-08-31): KYM +
// Urban Dictionary as a new `culture` family, multi-board 4chan, and the
// watchlist's high-alert tier. Fixtures are slices of the LIVE pages from
// the day the parsers were written, so a markup change fails a test here
// before it silently zeroes a feed in production.
// ==================================================================

const fixture = (f: string) => readFileSync(`test/fixtures/${f}`, "utf8");

describe("Know Your Meme parsers", () => {
  test("trending page yields decoded, deduplicated titles", () => {
    const titles = parseTrending(fixture("kym-trending.html"));
    assert.ok(titles.length >= 2, `got ${titles.length} titles`);
    assert.ok(titles.some((t) => t.includes("'")),
      "entities like &#x27; must decode to apostrophes");
    assert.equal(new Set(titles).size, titles.length, "no duplicates");
  });

  test("popular page yields multi-word phrases, never nav slugs", () => {
    const phrases = parsePopular(fixture("kym-popular.html"));
    assert.ok(phrases.length >= 3, `got ${phrases.length}`);
    assert.ok(!phrases.includes("memes"), "nav slugs are not memes");
    for (const p of phrases) {
      assert.ok(p.includes(" "), `single-word slug leaked: "${p}"`);
      assert.ok(!p.includes("-"), "hyphens become spaces");
    }
  });

  test("a redesigned page degrades to zero entries, not garbage", () => {
    assert.deepEqual(parseTrending("<html><body>new spa shell</body></html>"), []);
    assert.deepEqual(parsePopular("<html>nothing here</html>"), []);
  });
});

describe("Urban Dictionary feed", () => {
  test("maps the real API shape to signals", async () => {
    const data = JSON.parse(fixture("ud-words.json"));
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(data), {
      status: 200, headers: { "content-type": "application/json" },
    })) as typeof fetch;
    try {
      const cfg = configSchema.parse({});
      const db = openMemoryDb();
      const signals = await urbanDictionaryFeed.poll({ cfg, budget: new BudgetGuard(db, cfg), db });
      assert.ok(signals.length >= 1);
      for (const s of signals) {
        assert.equal(s.feed, "urbanDictionary");
        assert.ok(s.term.length >= 2 && s.term.length <= 60);
        assert.ok(s.rawScore >= 0 && s.rawScore <= 1);
      }
    } finally { globalThis.fetch = orig; }
  });
});

describe("culture family", () => {
  test("both culture feeds share ONE family -- within-family corroboration only", () => {
    assert.equal(FEED_FAMILY.knowYourMeme, "culture");
    assert.equal(FEED_FAMILY.urbanDictionary, "culture");
  });
});

describe("watchlist high-alert tier", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); process.env.X_BEARER_TOKEN = "t"; });

  const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({
    feeds: { watchlist: {
      enabled: true,
      priorityHandles: ["elonmusk"], handles: ["blknoiz06"],
      normalTierSeconds: 900, ...over,
    } },
  });

  /** Serves a canned timeline and records which user ids were fetched. */
  function mockTimelines(tweets: Array<{ id: string; text: string }>) {
    const fetched: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes("/users/by")) {
        return new Response(JSON.stringify({ data: [
          { id: "1", username: "elonmusk" }, { id: "2", username: "blknoiz06" },
        ] }), { status: 200 });
      }
      const m = u.match(/users\/(\d+)\/tweets/);
      if (m) fetched.push(m[1]!);
      return new Response(JSON.stringify({
        data: tweets, meta: { result_count: tweets.length, newest_id: tweets[0]?.id },
      }), { status: 200 });
    }) as typeof fetch;
    return { fetched, restore: () => { globalThis.fetch = orig; } };
  }

  test("priority handles poll every pass; normal handles wait out their cadence", async () => {
    const c = cfg();
    const budget = new BudgetGuard(db, c);
    const m1 = mockTimelines([{ id: "10", text: "colonize the sun" }]);
    await watchlistFeed.poll({ cfg: c, budget, db });
    m1.restore();
    assert.deepEqual([...new Set(m1.fetched)].sort(), ["1", "2"],
      "first pass fetches both tiers");

    const m2 = mockTimelines([]);
    await watchlistFeed.poll({ cfg: c, budget, db });
    m2.restore();
    assert.deepEqual(m2.fetched, ["1"],
      "second pass inside normalTierSeconds fetches ONLY the priority handle");
    assert.ok(Number(kvGet(db, "watchlistLastNormalPoll") ?? 0) > 0);
  });

  test("priority signals carry the reach floor; normal signals do not", async () => {
    const c = cfg();
    const budget = new BudgetGuard(db, c);
    // Zero engagement: base rawScore would be 0.
    const m = mockTimelines([{ id: "11", text: "the machines are winning" }]);
    const signals = await watchlistFeed.poll({ cfg: c, budget, db });
    m.restore();
    const pri = signals.filter((s) => (s.meta as { priority?: boolean }).priority);
    const norm = signals.filter((s) => !(s.meta as { priority?: boolean }).priority);
    assert.ok(pri.length >= 1 && norm.length >= 1);
    for (const s of pri) assert.ok(s.rawScore >= 0.35, "megaphone floor applies");
    for (const s of norm) assert.ok(s.rawScore < 0.35, "no floor for the normal tier");
  });

  test("an empty since_id response still bills the per-request floor", async () => {
    const c = cfg();
    const budget = new BudgetGuard(db, c);
    const m = mockTimelines([]); // result_count 0
    await watchlistFeed.poll({ cfg: c, budget, db });
    m.restore();
    const perRequest = c.feeds.xApi.estimatedCostPerRequest;
    // Two handles fetched on the first pass -> at least two request floors.
    assert.ok(budget.meterUsed("x-api-usd") >= 2 * perRequest - 1e-9,
      `metered ${budget.meterUsed("x-api-usd")}, expected >= ${2 * perRequest}`);
  });
});
