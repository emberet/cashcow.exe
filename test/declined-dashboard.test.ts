import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { recentDeclines, crowdedDetail } from "../src/web/queries.ts";

// ==================================================================
// A term that keeps getting re-declined for the same reason (most often
// checkSaturation's free, correct, forever-repeating neverRelaunchSameTerm
// check -- see src/scoring/saturation.ts) must not be allowed to fill every
// slot in a small operator-facing list. This was live on the dashboard: a
// mainnet launch called "you girl" (YOUGIRL) was declined 5 times in a row
// under the reason "crowded", crowding out every other decision.
// ==================================================================

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: false, ...over });

describe("declined-list display collapses repeat entries", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  function seedDeclined(
    term: string, norm: string, reason: string, detail: string, score: number, ts: number,
  ) {
    db.prepare(
      `INSERT INTO declined (ts, term, norm, reason, detail, score, dry_run)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(ts, term, norm, reason, detail, score);
  }

  // Offset well into the past: recentDeclines/crowdedDetail filter on
  // `ts < Date.now()` at query time (delayHours=0 for admin), so a row
  // seeded at exactly "now" can lose a same-millisecond race against the
  // query's own Date.now() call and be silently excluded.
  const PAST = 60_000;

  test("recentDeclines collapses same-term-and-reason repeats into one row with a count", () => {
    const base = Date.now() - PAST;
    for (let i = 0; i < 5; i++) {
      seedDeclined(
        "you girl", "girl you", "crowded",
        `we have already launched "you girl" before; neverRelaunchSameTerm is on`,
        50, base + i,
      );
    }
    seedDeclined("Bessent", "bessent", "trademark", "real person", 60, base + 10);
    seedDeclined("Missouri", "missouri", "budget", "allowance already spent", 45, base + 11);

    const rows = recentDeclines(db, cfg(), 0, 8);
    const youGirl = rows.find((r) => r.term === "you girl");
    assert.ok(youGirl, "expected one collapsed row for the repeated term");
    assert.equal(youGirl!.count, 5);

    // The distinct terms are not crowded out by the repeat.
    assert.ok(rows.some((r) => r.term === "Bessent"));
    assert.ok(rows.some((r) => r.term === "Missouri"));
    assert.equal(rows.length, 3, "5 repeats + 2 distinct declines should collapse to 3 rows");
  });

  test("the same term declined for two DIFFERENT reasons stays as two separate rows", () => {
    const base = Date.now() - PAST;
    seedDeclined("Bomb", "bomb", "trademark", "real brand", 55, base);
    seedDeclined("Bomb", "bomb", "crowded", "3 similar tokens already exist", 55, base + 1);

    const rows = recentDeclines(db, cfg(), 0, 8);
    const bombRows = rows.filter((r) => r.term === "Bomb");
    assert.equal(bombRows.length, 2, "different reasons must not collapse together");
    assert.ok(bombRows.every((r) => r.count === 1));
  });

  test("a genuinely one-off decline reports count 1, not undefined or 0", () => {
    seedDeclined("Momentum", "momentum", "crowded", "1 similar token already exists (cap 1): MOMENT (0.90, market)", 62, Date.now() - PAST);
    const rows = recentDeclines(db, cfg(), 0, 8);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.count, 1);
  });

  test("crowdedDetail collapses the same way, keyed on the normalized term", () => {
    const base = Date.now() - PAST;
    for (let i = 0; i < 5; i++) {
      seedDeclined(
        "you girl", "girl you", "crowded",
        `we have already launched "you girl" before; neverRelaunchSameTerm is on`,
        50, base + i,
      );
    }
    seedDeclined("Bitcoin", "bitcoin", "crowded", "2 similar token(s) already exist within 24h (cap 1): BTC2 (0.95, market)", 70, base + 20);

    const rows = crowdedDetail(db, cfg(), 0, 10);
    assert.equal(rows.length, 2);
    const youGirl = rows.find((r) => r.term === "you girl");
    assert.equal(youGirl!.count, 5);
    assert.equal(youGirl!.rivals, null, "an 'already launched by us' decline has no rival count to parse");

    const btc = rows.find((r) => r.term === "Bitcoin");
    assert.equal(btc!.count, 1);
    assert.equal(btc!.rivals, 2, "rivals are still parsed out of the detail string for a market collision");
  });
});
