import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { BudgetGuard, BudgetDenied } from "../src/risk/budget.ts";
import { KillSwitch, __resetInProcessHalt } from "../src/risk/killswitch.ts";
import { compileFilters, checkTerm, checkAll } from "../src/scoring/filters.ts";
import {
  evaluateSaturation, everLaunched, findSelfDuplicate, checkSaturation, type KnownToken,
} from "../src/scoring/saturation.ts";
import { similarity, tickerize, normalize } from "../src/util/text.ts";
import { recoverCasing } from "../src/feeds/googleTrends.ts";
import { publishWalletAddress, publishedWalletAddress } from "../src/chain/wallet.ts";
import { isAdminPath } from "../src/web/server.ts";

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: false, ...over });

function seedLaunch(db: Db, mint: string, name: string, symbol: string, ageMs = 0) {
  db.prepare(
    `INSERT INTO launches (mint, term, norm, name, symbol, created_at, dry_run)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(mint, name, normalize(name), name, symbol, Date.now() - ageMs);
}

// ---------------------------------------------------------------- budget rail

describe("BudgetGuard — the rail between a loop bug and an empty wallet", () => {
  let db: Db;
  beforeEach(() => { db = openMemoryDb(); });

  test("allows spend inside the daily ceiling", () => {
    const g = new BudgetGuard(db, cfg());
    assert.equal(g.canSpend(0.05, { isLaunch: true }).ok, true);
  });

  test("denies once the rolling 24h SOL ceiling would be crossed", () => {
    const g = new BudgetGuard(db, cfg({ risk: { maxSolPerDay: 0.2 } }));
    g.record({ kind: "dev_buy", solDelta: -0.18 });
    const d = g.canSpend(0.05);
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.code, "DAILY_SOL_CAP");
  });

  test("denies once the daily launch count is used up", () => {
    const g = new BudgetGuard(db, cfg({ risk: { maxLaunchesPerDay: 2 } }));
    g.record({ kind: "launch", solDelta: -0.02 });
    g.record({ kind: "launch", solDelta: -0.02 });
    const d = g.canSpend(0.02, { isLaunch: true });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.code, "DAILY_LAUNCH_CAP");
    // ...but a non-launch spend (e.g. exiting a position) is still permitted.
    assert.equal(g.canSpend(0.001, { isLaunch: false }).ok, true);
  });

  test("spend older than 24h falls out of the rolling window", () => {
    const g = new BudgetGuard(db, cfg({ risk: { maxSolPerDay: 0.2 } }));
    db.prepare(
      `INSERT INTO spend_ledger (ts, kind, sol_delta, dry_run) VALUES (?, 'dev_buy', -0.19, 0)`,
    ).run(Date.now() - 25 * 3600_000);
    assert.equal(g.solSpentLast24h(), 0);
    assert.equal(g.canSpend(0.05).ok, true);
  });

  test("refuses to spend below the wallet floor reserved for exits", () => {
    const g = new BudgetGuard(db, cfg({ risk: { minWalletBalanceSol: 0.05 } }));
    const d = g.canSpend(0.1, { walletBalanceSol: 0.12 });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.code, "WALLET_FLOOR");
  });

  test("realised-loss circuit breaker trips and blocks further spend", () => {
    const g = new BudgetGuard(db, cfg({ risk: { maxDailyLossSol: 0.1, maxSolPerDay: 5 } }));
    g.record({ kind: "dev_buy", solDelta: -0.2 });
    g.record({ kind: "dev_sell", solDelta: +0.08 });   // net -0.12, past the 0.1 breaker
    const d = g.canSpend(0.01);
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.code, "DAILY_LOSS_CAP");
  });

  test("a profitable round trip does not trip the loss breaker", () => {
    const g = new BudgetGuard(db, cfg({ risk: { maxDailyLossSol: 0.1, maxSolPerDay: 5 } }));
    g.record({ kind: "dev_buy", solDelta: -0.2 });
    g.record({ kind: "dev_sell", solDelta: +0.35 });
    assert.equal(g.realizedLossLast24h(), 0);
    assert.equal(g.canSpend(0.01).ok, true);
  });

  test("concurrent position cap is enforced", () => {
    const g = new BudgetGuard(db, cfg({ risk: { maxConcurrentPositions: 2 } }));
    for (let i = 0; i < 2; i++) {
      db.prepare(
        `INSERT INTO positions (mint, entry_sol, entry_tokens, entry_price, opened_at, status, dry_run)
         VALUES (?, 0.05, 1000, 0.00005, ?, 'open', 0)`,
      ).run(`mint${i}`, Date.now());
    }
    const d = g.canSpend(0.05, { opensPosition: true });
    assert.equal(d.ok, false);
    assert.equal(d.ok === false && d.code, "CONCURRENT_POSITIONS");
  });

  test("dry-run and live spend are accounted separately", () => {
    const live = new BudgetGuard(db, cfg({ dryRun: false }));
    const dry = new BudgetGuard(db, configSchema.parse({ dryRun: true }));
    dry.record({ kind: "launch", solDelta: -0.4 });
    assert.equal(live.solSpentLast24h(), 0, "a simulation must not consume live budget");
    assert.equal(dry.solSpentLast24h(), 0.4);
  });

  test("assertCanSpend throws BudgetDenied rather than returning", () => {
    const g = new BudgetGuard(db, cfg({ risk: { maxSolPerDay: 0.01 } }));
    assert.throws(() => g.assertCanSpend(0.5), BudgetDenied);
  });

  test("metered USD spend stops at the period cap", () => {
    const g = new BudgetGuard(db, cfg());
    assert.equal(g.meterCharge("x-api", 20, 25), true);
    assert.equal(g.meterCharge("x-api", 4, 25), true);
    assert.equal(g.meterCharge("x-api", 4, 25), false, "would exceed the cap");
    assert.equal(g.meterUsed("x-api"), 24);
  });
});

// ------------------------------------------------------------- kill switch

describe("KillSwitch — stops new exposure, never strands an open one", () => {
  let dir: string;
  beforeEach(() => {
    __resetInProcessHalt();
    dir = mkdtempSync(join(tmpdir(), "trendbot-halt-"));
  });

  test("halting blocks launches but still permits exits", () => {
    const ks = new KillSwitch(join(dir, "HALT"));
    assert.equal(ks.allowsNewLaunches(), true);

    ks.halt("operator pulled the brake");
    assert.equal(ks.isHalted(), true);
    assert.equal(ks.allowsNewLaunches(), false);
    assert.equal(ks.allowsPositionExits(), true, "an open bag must always be closable");
    assert.match(ks.haltReason() ?? "", /operator pulled the brake/);

    ks.resume();
    assert.equal(ks.allowsNewLaunches(), true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("halt survives a restart because it lives on disk", () => {
    const path = join(dir, "HALT");
    new KillSwitch(path).halt("persisted");
    __resetInProcessHalt();               // simulate a fresh process
    assert.equal(new KillSwitch(path).isHalted(), true);
    assert.equal(existsSync(path), true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ----------------------------------------------------------------- filters

describe("filters — reject before anything costs money", () => {
  const f = compileFilters(configSchema.parse({}).filters);

  test("blocks trademarked brands", () => {
    for (const term of ["Disney magic", "pokemon go craze", "new Labubu drop", "nvidia earnings"]) {
      const r = checkTerm(term, f);
      assert.equal(r.allowed, false, `expected "${term}" to be blocked`);
      assert.equal(r.allowed === false && r.category, "trademark");
    }
  });

  test("blocks public-figure likeness", () => {
    for (const term of ["taylor swift tour", "elon musk tweet", "MrBeast video"]) {
      assert.equal(checkTerm(term, f).allowed, false, `expected "${term}" to be blocked`);
    }
  });

  test("blocks tragedy and disaster", () => {
    for (const term of ["celebrity dies at 54", "mass shooting downtown", "earthquake death toll", "plane crash survivors"]) {
      const r = checkTerm(term, f);
      assert.equal(r.allowed, false, `expected "${term}" to be blocked`);
      assert.equal(r.allowed === false && r.category, "tragedy");
    }
  });

  test("blocks slurs including obfuscated variants", () => {
    const r = checkTerm("n1gg4 coin", f);
    assert.equal(r.allowed, false);
    assert.equal(r.allowed === false && r.category, "slur");
  });

  test("lets genuinely harmless trends through", () => {
    for (const term of ["moo deng hippo", "brat summer", "demure mindful", "skibidi", "gooning era"]) {
      const r = checkTerm(term, f);
      assert.equal(r.allowed, true, `expected "${term}" to pass, got ${JSON.stringify(r)}`);
    }
  });

  test("checks generated output too, not just the source trend", () => {
    // A clean trend can still yield a dirty generated name.
    const r = checkAll(["harmless trend", "Disney Coin", "HARM"], f);
    assert.equal(r.allowed, false);
    assert.equal(r.allowed === false && r.category, "trademark");
  });

  test("operator allowlist overrides the built-in lists", () => {
    const f2 = compileFilters(configSchema.parse({ filters: { allowlist: ["labubu"] } }).filters);
    assert.equal(checkTerm("labubu drop", f2).allowed, true);
  });

  test("blocks capitalised names that no static list could enumerate", () => {
    // The case that motivated the heuristic: live testing launched these.
    for (const term of ["Kevin Keegan", "Enzo Maresca", "Ollie Watkins"]) {
      assert.equal(checkTerm(term, f).allowed, false, `expected "${term}" blocked`);
    }
  });

  test("blocks bare cabinet-official surnames", () => {
    // "Bessent" (US Treasury Secretary) launched for real on mainnet: a lone
    // surname is invisible to the two-word heuristic, and the model screen
    // missed it too. Same shape as the "Trump" leak that seeded this list.
    for (const term of ["Bessent", "Powell", "Yellen"]) {
      assert.equal(checkTerm(term, f).allowed, false, `expected "${term}" blocked`);
    }
  });

  test("person-name heuristic does not eat obvious non-people", () => {
    for (const term of ["skibidi toilet", "brat summer", "LINK", "Apollo 15", "World Water Reserve"]) {
      assert.equal(checkTerm(term, f).allowed, true, `expected "${term}" to pass`);
    }
  });

  test("person-name heuristic does not eat 'Extended Look' or 'Middle East'", () => {
    // Both blocked as false positives on 2026-08-28 -- "Extended Look" was
    // that day's only >65-scoring, 2-family-corroborated candidate, lost to
    // this heuristic (npm run score).
    for (const term of ["Extended Look", "Middle East"]) {
      assert.equal(checkTerm(term, f).allowed, true, `expected "${term}" to pass`);
    }
  });

  test("person-name heuristic has a known, documented false-positive cost", () => {
    // "Moo Deng" is a hippo, not a person, but it is indistinguishable from a
    // surname pair. Blocking it is the accepted cost of the asymmetry: a missed
    // launch is cheaper than a right-of-publicity claim. Turning the flag off
    // restores it, which is why it is configurable.
    const strict = compileFilters(configSchema.parse({}).filters);
    assert.equal(checkTerm("Moo Deng", strict).allowed, false);

    const relaxed = compileFilters(
      configSchema.parse({ filters: { blockLikelyPersonNames: false } }).filters,
    );
    assert.equal(checkTerm("Moo Deng", relaxed).allowed, true);
  });

  test("operator blocklist adds terms", () => {
    const f2 = compileFilters(configSchema.parse({ filters: { extraBlocklist: ["skibidi"] } }).filters);
    assert.equal(checkTerm("skibidi toilet", f2).allowed, false);
  });
});

// -------------------------------------------------------------- saturation

describe("saturation — the check that stops the most common way to lose money", () => {
  const scfg = configSchema.parse({}).saturation;
  const mk = (name: string, symbol: string): KnownToken =>
    ({ name, symbol, createdAt: Date.now(), source: "market" });

  test("catches near-miss names, not just exact duplicates", () => {
    const r = evaluateSaturation("moo deng", "MOODENG", [mk("moodeng", "MOODENG"), mk("Moo Deng!", "MOODENG")], scfg);
    assert.equal(r.saturated, true);
    assert.match(r.reason ?? "", /similar token/);
  });

  test("catches a ticker collision even when the names differ", () => {
    const r = evaluateSaturation("great banana shortage", "GBS",
      [mk("Global Banking System", "GBS"), mk("Green Bean Soup", "GBS")], scfg);
    assert.equal(r.saturated, true);
  });

  test("lets a genuinely fresh trend through", () => {
    const r = evaluateSaturation("quantum ferret", "QFERRET",
      [mk("doge", "DOGE"), mk("pepe", "PEPE"), mk("bonk", "BONK")], scfg);
    assert.equal(r.saturated, false);
  });

  test("one prior token is tolerated, two is saturation at default caps", () => {
    assert.equal(evaluateSaturation("tariff talk", "TARIFF", [mk("tariffs", "TARIFF")], scfg).saturated, false);
    assert.equal(
      evaluateSaturation("tariff talk", "TARIFF", [mk("tariffs", "TARIFF"), mk("tariff", "TRF")], scfg).saturated,
      true,
    );
  });

  test("neverRelaunchSameTerm blocks a repeat over all time", () => {
    const db = openMemoryDb();
    seedLaunch(db, "mintA", "moo deng", "MOODENG", 90 * 24 * 3600_000); // 90 days ago
    assert.equal(everLaunched(db, "Moo Deng"), true, "word order and case must not matter");
    assert.equal(everLaunched(db, "quantum ferret"), false);
  });
});

// ------------------------------------------------- 24h self-dedupe

describe("self-dedupe — not minting our own trend twice in a day", () => {
  const scfg = configSchema.parse({}).saturation;

  /**
   * Regression. These four all LAUNCHED before the self-dedupe gate existed,
   * verified against the live DB row for "Crypto Market". `maxSimilar` is a
   * crowding tally that needs two hits, so our own two-hour-old launch supplied
   * only one of them and the near-duplicate went out; `neverRelaunchSameTerm`
   * is an exact key match, so one extra word slips past it.
   */
  for (const term of [
    "Crypto Market Crash",     // 0.90 -- extra word
    "crypto markets",          // 0.78 -- plural
    "CryptoMarket",            // 0.85 -- spacing
    "crypto market rally today",
  ]) {
    test(`blocks "${term}" after we launched Crypto Market 2h ago`, () => {
      const db = openMemoryDb();
      seedLaunch(db, "mintA", "Crypto Market", "CRYPTOMA", 2 * 3600_000);
      const dupe = findSelfDuplicate(db, term, undefined, scfg);
      assert.ok(dupe, `${term} must be caught as a duplicate`);
      assert.equal(dupe.matchedOn, "term");
    });
  }

  test("an unrelated trend still gets through", () => {
    const db = openMemoryDb();
    seedLaunch(db, "mintA", "Crypto Market", "CRYPTOMA", 2 * 3600_000);
    assert.equal(findSelfDuplicate(db, "quantum ferret", undefined, scfg), undefined);
  });

  test("the window rolls: the same trend is allowed again after 24h", () => {
    const db = openMemoryDb();
    seedLaunch(db, "mintA", "Crypto Market", "CRYPTOMA", 25 * 3600_000);
    assert.equal(findSelfDuplicate(db, "Crypto Market Crash", undefined, scfg), undefined);
    // ...but only just outside it.
    const db2 = openMemoryDb();
    seedLaunch(db2, "mintB", "Crypto Market", "CRYPTOMA", 23 * 3600_000);
    assert.ok(findSelfDuplicate(db2, "Crypto Market Crash", undefined, scfg));
  });

  test("catches a ticker collision between unrelated topics", () => {
    const db = openMemoryDb();
    seedLaunch(db, "mintA", "Global Banking System", "GBS", 3600_000);
    const dupe = findSelfDuplicate(db, "great banana shortage", "GBS", scfg);
    assert.ok(dupe, "an identical ticker is a collision even if the topics differ");
    assert.equal(dupe.matchedOn, "symbol");
  });

  test("matches the minted NAME when the model renamed the trend", () => {
    // The term and the minted name diverge, so checking only one would miss it.
    const db = openMemoryDb();
    db.prepare(
      `INSERT INTO launches (mint, term, norm, name, symbol, created_at, dry_run)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run("mintA", "Fed Rate Decision", "decision fed rate", "MoneyPrinter", "PRINTER",
      Date.now() - 3600_000);

    const dupe = findSelfDuplicate(db, "money printer", undefined, scfg);
    assert.ok(dupe, "a later trend resembling the minted name must be caught");
    assert.equal(dupe.matchedOn, "name");
  });

  test("selfDedupeHours: 0 disables the gate entirely", () => {
    const db = openMemoryDb();
    seedLaunch(db, "mintA", "Crypto Market", "CRYPTOMA", 2 * 3600_000);
    const off = { ...scfg, selfDedupeHours: 0 };
    assert.equal(findSelfDuplicate(db, "Crypto Market Crash", undefined, off), undefined);
  });

  test("checkSaturation reports the duplicate without calling the market", async () => {
    const db = openMemoryDb();
    seedLaunch(db, "mintA", "Crypto Market", "CRYPTOMA", 2 * 3600_000);

    let called = false;
    const market = {
      async recentTokens() { called = true; return []; },
    };
    const r = await checkSaturation(db, "Crypto Market Crash", undefined, scfg, market);

    assert.equal(r.saturated, true);
    assert.match(r.reason ?? "", /we launched CRYPTOMA/);
    assert.equal(called, false, "a free rejection must not cost an HTTP call");
  });
});

// ------------------------------------------------- google trends casing

describe("Google Trends casing recovery", () => {
  test("recovers proper casing from the attached headline", () => {
    // Google Trends lowercases terms, which blinds the person-name filter.
    assert.equal(
      recoverCasing("isack hadjar", "Isack Hadjar takes shock pole at Zandvoort"),
      "Isack Hadjar",
    );
  });

  test("ignores an ALL-CAPS headline rather than manufacturing a signal", () => {
    assert.equal(recoverCasing("apple tv", "APPLE TV ANNOUNCES NEW SHOW"), "apple tv");
  });

  test("leaves the term alone when the headline does not contain it", () => {
    assert.equal(recoverCasing("skibidi", "unrelated headline"), "skibidi");
    assert.equal(recoverCasing("skibidi", ""), "skibidi");
  });

  test("recovered casing makes the person filter effective end to end", () => {
    const f = compileFilters(configSchema.parse({}).filters);
    assert.equal(checkTerm("isack hadjar", f).allowed, true, "lowercase slips past");
    const recovered = recoverCasing("isack hadjar", "Isack Hadjar takes shock pole");
    assert.equal(checkTerm(recovered, f).allowed, false, "recovered casing is caught");
  });
});

// ------------------------------------------------------------------- text

describe("text matching", () => {
  test("similarity ranks variants above unrelated terms", () => {
    assert.ok(similarity("doge", "doge coin") > 0.8);
    assert.ok(similarity("moo deng", "moodeng") > 0.8);
    assert.ok(similarity("tariff", "tariffs") > 0.7);
    assert.ok(similarity("banana", "orange") < 0.3);
  });

  test("tickerize produces a usable symbol", () => {
    assert.equal(tickerize("labubu"), "LABUBU");
    assert.equal(tickerize("the great banana shortage"), "GBS");
    assert.match(tickerize("moo deng"), /^[A-Z0-9]{3,8}$/);
  });
});

// ------------------------------------------------- invariant 4: key isolation

describe("invariant 4 — the web process never holds the wallet key", () => {
  // This regressed silently once: a helper called `configuredWalletAddress`
  // looked like a pure address lookup, but it calls `loadWallet`, which parses
  // the secret and caches the entire Keypair in the calling process. The result
  // was a signing key living inside the request-serving process purely so the
  // dashboard could print an address that is public information anyway.
  //
  // The address is now published to `kv` by the bot and read back from there.
  // This test fails if anyone reintroduces a secret-loading call under src/web.
  test("no module under src/web references a secret-loading wallet helper", () => {
    const webDir = join(import.meta.dirname, "..", "src", "web");
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          // public/ is browser-side static assets, not the server process.
          if (entry.name !== "public") walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const src = readFileSync(full, "utf8");
        for (const banned of ["loadWallet", "walletPubkey", "configuredWalletAddress"]) {
          if (src.includes(banned)) offenders.push(`${entry.name} -> ${banned}`);
        }
      }
    };
    walk(webDir);

    assert.deepEqual(
      offenders,
      [],
      `web process must read publishedWalletAddress(db) instead: ${offenders.join(", ")}`,
    );
  });

  test("publishedWalletAddress returns null until the bot publishes one", () => {
    const db = openMemoryDb();
    assert.equal(publishedWalletAddress(db), null);
  });

  test("publishWalletAddress records nothing when no wallet is configured", () => {
    const db = openMemoryDb();
    // No secret env var and no keypairPath -> dry run's ephemeral throwaway
    // keypair must NOT be published as though it were a real wallet.
    const c = configSchema.parse({ dryRun: true, wallet: { secretEnv: "TEST_ABSENT_SECRET_ENV" } });
    delete process.env.TEST_ABSENT_SECRET_ENV;
    publishWalletAddress(db, c);
    assert.equal(publishedWalletAddress(db), null);
  });
});

describe("admin surface can be removed, not just password-protected", () => {
  // Why this exists: a configured password is not enough for an
  // internet-facing instance. Login throttling keys on the socket address, and
  // behind a tunnel every request arrives from 127.0.0.1 -- so the per-attacker
  // bucket becomes one global bucket shared by the whole internet and the
  // operator. Turning the surface off entirely is the honest answer.
  const adminPaths = [
    "/api/admin/snapshot", "/api/admin/halt", "/api/login",
    "/api/logout", "/api/session", "/admin", "/admin.html", "/admin.js",
  ];

  test("every admin path is gated when adminEnabled is false", () => {
    const c = configSchema.parse({ web: { adminEnabled: false } });
    assert.equal(c.web.adminEnabled, false);
    for (const p of adminPaths) {
      assert.equal(isAdminPath(p), true, `${p} must be recognised as admin surface`);
    }
  });

  test("public routes are never mistaken for admin surface", () => {
    for (const p of ["/", "/api/public", "/api/stream", "/app.js", "/styles.css"]) {
      assert.equal(isAdminPath(p), false, `${p} must stay reachable`);
    }
  });

  test("admin is on by default, so local use is unchanged", () => {
    assert.equal(configSchema.parse({}).web.adminEnabled, true);
  });
});
