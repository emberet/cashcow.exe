import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { safeHttpUrl } from "../src/util/http.ts";
import { login } from "../src/web/auth.ts";
import { readingList } from "../src/web/queries.ts";
import { applyChanges } from "../src/learning/guardrails.ts";

/**
 * Regressions for defects found in a security review, each demonstrated
 * against the running system before it was fixed. A failure here is a
 * re-opened vulnerability, not a style nit.
 */

// ==================================================================
// Unvalidated URL scheme reaching an href (stored XSS).
// Feed URLs are third-party: a Hacker News submission URL is whatever the
// submitter typed. HTML-escaping does not touch the scheme.
// ==================================================================

describe("URL scheme allowlist", () => {
  test("rejects script-bearing schemes", () => {
    for (const hostile of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  jAvAsCrIpT:alert(1)",
      "javascript:alert(1)",
      "java\nscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      assert.equal(safeHttpUrl(hostile), null, `expected "${hostile}" to be rejected`);
    }
  });

  test("keeps ordinary article links", () => {
    for (const ok of [
      "https://example.com/story",
      "http://example.com/story?a=1&b=2",
      "https://news.ycombinator.com/item?id=123",
    ]) {
      assert.ok(safeHttpUrl(ok), `expected "${ok}" to survive`);
    }
  });

  test("rejects non-strings and junk", () => {
    for (const junk of [null, undefined, 42, {}, "", "   ", "not a url"]) {
      assert.equal(safeHttpUrl(junk), null);
    }
  });

  test("a hostile feed URL never reaches the reading list", () => {
    // The exact shape a malicious Hacker News submission would produce.
    const db = openMemoryDb();
    const cfg = configSchema.parse({ dryRun: true });
    const stmt = db.prepare(
      `INSERT INTO signals (feed, term, norm, raw_score, observed_at, ingested_at, url, meta, source_text)
       VALUES ('hackernews', ?, ?, 0.9, ?, ?, ?, '{}', ?)`,
    );
    stmt.run("Hostile submission", "n1", Date.now(), Date.now(), "javascript:alert(1)", "Hostile submission");
    stmt.run("Real article", "n2", Date.now(), Date.now(), "https://example.com/ok", "Real article");

    const rows = readingList(db, cfg, 10);
    assert.equal(rows.length, 1, "only the safe link should survive");
    assert.equal(rows[0]?.url, "https://example.com/ok");
    assert.ok(!rows.some((r) => /javascript:/i.test(r.url)));
  });
});

// ==================================================================
// Login throttling keyed on a spoofable header.
// Measured before the fix: a fixed address locked out after 8 attempts,
// while rotating X-Forwarded-For allowed 30 of 30.
// ==================================================================

describe("login throttling", () => {
  let db: Db;
  beforeEach(() => {
    db = openMemoryDb();
    process.env.ADMIN_PASSWORD_HASH =
      "scrypt$" + "aa".repeat(16) + "$" + "bb".repeat(64);
  });

  test("locks out after repeated failures from one address", () => {
    let locked = false;
    for (let i = 0; i < 12; i++) {
      const r = login(db, "wrong", "10.0.0.1");
      if (!r.ok && /Too many/.test(r.reason)) { locked = true; break; }
    }
    assert.equal(locked, true, "a fixed address must eventually be locked out");
  });

  test("the throttle key is the caller's, not something they can vary", () => {
    // Exhaust one address.
    for (let i = 0; i < 12; i++) login(db, "wrong", "10.0.0.2");
    const after = login(db, "wrong", "10.0.0.2");
    assert.equal(after.ok, false);
    assert.match(after.ok === false ? after.reason : "", /Too many/);

    // A different *label* on the same key must not reset it. The label is the
    // proxy-supplied display value and must never influence throttling.
    const relabelled = login(db, "wrong", "10.0.0.2", "203.0.113.99");
    assert.equal(relabelled.ok, false);
    assert.match(relabelled.ok === false ? relabelled.reason : "", /Too many/,
      "a spoofable label must not unlock a throttled key");
  });

  test("a genuinely different caller is unaffected", () => {
    for (let i = 0; i < 12; i++) login(db, "wrong", "10.0.0.3");
    const other = login(db, "wrong", "10.0.0.4");
    assert.equal(other.ok, false);
    assert.doesNotMatch(other.ok === false ? other.reason : "", /Too many/,
      "throttling one address must not lock everyone out");
  });
});

// ==================================================================
// Prompt injection reaching the money knobs.
// Feed text is attacker-controlled and flows into the tuner's evidence, so
// the allowlist has to hold against a fully compliant model.
// ==================================================================

describe("tuner allowlist under prompt injection", () => {
  test("a model that obeys injected instructions still cannot move money", () => {
    const live = configSchema.parse({});
    const injected = [
      { path: "risk.maxSolPerDay", value: 999 },
      { path: "risk.maxLaunchesPerDay", value: 500 },
      { path: "risk.maxDailyLossSol", value: 999 },
      { path: "devPosition.buySol", value: 10 },
      { path: "filters.blockTrademarks", value: 0 },
      { path: "filters.allowUnscreenedLive", value: 1 },
      { path: "dryRun", value: 0 },
      { path: "network", value: 1 },
      { path: "wallet.secretEnv", value: 1 },
      { path: "web.host", value: 1 },
      { path: "scoring.threshold", value: 64 },
    ];

    const res = applyChanges(injected, live, { maxChanges: 20 });

    assert.deepEqual(
      res.accepted.map((a) => a.path),
      ["scoring.threshold"],
      "only the legitimate selection knob may be accepted",
    );
    for (const prefix of ["risk", "devPosition", "filters", "wallet", "web", "dryRun", "network"]) {
      assert.ok(
        !res.accepted.some((a) => a.path.startsWith(prefix)),
        `"${prefix}" must be unreachable by the tuner`,
      );
    }
  });
});
