import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { openMemoryDb, type Db } from "../src/util/db.ts";
import { configSchema } from "../src/config/schema.ts";
import { BudgetGuard } from "../src/risk/budget.ts";
import { openPosition } from "../src/positions/store.ts";
import { sellForLiquidity } from "../src/positions/manager.ts";

// ==================================================================
// Liquidity exits: when the wallet cannot fund a launch that cleared every
// gate, the OLDEST eligible positions are sold to free capital. The rails
// hold under pressure: protected mints skipped, young positions never
// churned, at most maxPositionsPerShortfall sold, disabled by default, and
// realized losses still feed the loss breaker (proceeds recorded through
// BudgetGuard like every exit).
// ==================================================================

const PROTECTED = "67iVaRRQkNnZvN29rG75kt71nVdhkc5imwYDTivApump";

let db: Db;
beforeEach(() => { db = openMemoryDb(); });

const HOUR = 3_600_000;
function pos(a: { mint: string; symbol: string; ageMs: number }): number {
  const id = openPosition(db, {
    mint: a.mint, symbol: a.symbol, entrySol: 0.05, entryTokens: "1000",
    entryFeeSol: 0, dryRun: false,
  });
  db.prepare("UPDATE positions SET opened_at = ? WHERE id = ?")
    .run(Date.now() - a.ageMs, id);
  return id;
}

const cfg = (liq: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  configSchema.parse({
    dryRun: false,
    devPosition: {
      liquiditySell: { enabled: true, ...liq },
      neverSellMints: [PROTECTED],
    },
    // sellAll would need a real RPC; these tests exercise selection and the
    // guards that fire BEFORE any network call.
    rpc: { primary: "https://127.0.0.1:1/nope" },
    ...extra,
  });

describe("sellForLiquidity", () => {
  test("disabled by default: schema ships it off and it frees nothing", async () => {
    const c = configSchema.parse({ dryRun: false });
    assert.equal(c.devPosition.liquiditySell.enabled, false, "must ship off");
    pos({ mint: "A".repeat(43), symbol: "OLD", ageMs: 5 * HOUR });
    const freed = await sellForLiquidity(db, c, new BudgetGuard(db, c), 0.1);
    assert.equal(freed, 0);
  });

  test("zero or negative shortfall sells nothing", async () => {
    const c = cfg();
    pos({ mint: "B".repeat(43), symbol: "X", ageMs: 5 * HOUR });
    assert.equal(await sellForLiquidity(db, c, new BudgetGuard(db, c), 0), 0);
    assert.equal(await sellForLiquidity(db, c, new BudgetGuard(db, c), -1), 0);
  });

  test("protected mints and young positions are never candidates", async () => {
    const c = cfg({ minAgeMinutes: 60 });
    pos({ mint: PROTECTED, symbol: "EXE", ageMs: 48 * HOUR });     // protected
    pos({ mint: "C".repeat(43), symbol: "BABY", ageMs: 0.5 * HOUR }); // too young
    const freed = await sellForLiquidity(db, c, new BudgetGuard(db, c), 1);
    assert.equal(freed, 0, "nothing eligible -> nothing sold, no RPC reached");
    // Both positions untouched.
    const open = db.prepare("SELECT COUNT(*) n FROM positions WHERE status='open'").get() as { n: number };
    assert.equal(open.n, 2);
  });

  test("eligible positions are attempted OLDEST first and failures book sell attempts", async () => {
    const c = cfg({ minAgeMinutes: 60, maxPositionsPerShortfall: 1 });
    const oldId = pos({ mint: "D".repeat(43), symbol: "OLDEST", ageMs: 20 * HOUR });
    pos({ mint: "E".repeat(43), symbol: "NEWER", ageMs: 5 * HOUR });

    // The dead RPC makes every sale fail -- which itself proves selection
    // order (only the oldest is attempted at cap 1) and that a failed
    // liquidity sale books a sell attempt instead of vanishing.
    const freed = await sellForLiquidity(db, c, new BudgetGuard(db, c), 1);
    assert.equal(freed, 0);
    const rows = db.prepare(
      "SELECT symbol, sell_attempts FROM positions ORDER BY opened_at ASC",
    ).all() as Array<{ symbol: string; sell_attempts: number }>;
    assert.equal(rows[0]!.symbol, "OLDEST");
    assert.equal(rows[0]!.sell_attempts, 1, "the oldest was attempted");
    assert.equal(rows[1]!.sell_attempts, 0, "cap 1: the newer was not touched");
    assert.equal(oldId >= 1, true);
  });
});

describe("thesis link routing (metadata twitter field)", () => {
  // The routing lives inline in loop.ts; this pins the regex's judgment.
  const isX = (u: string) => /^https?:\/\/(x\.com|twitter\.com)\//i.test(u);

  test("X links ride the twitter slot", () => {
    assert.equal(isX("https://x.com/elonmusk/status/123"), true);
    assert.equal(isX("https://twitter.com/user/status/9"), true);
    assert.equal(isX("HTTPS://X.COM/abc"), true);
  });

  test("everything else does not", () => {
    assert.equal(isX("https://news.example.com/article"), false);
    assert.equal(isX("https://boards.4chan.org/biz/thread/1"), false);
    assert.equal(isX("https://notx.com/x.com/fake"), false);
    assert.equal(isX("https://xx.com/a"), false);
  });
});
