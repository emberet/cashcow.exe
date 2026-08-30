import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { openMemoryDb } from "../src/util/db.ts";
import { BudgetGuard } from "../src/risk/budget.ts";
import { configSchema } from "../src/config/schema.ts";
import {
  signOAuth1, buildAuthHeader, announcementText, postLaunchAnnouncement, METER_KEY,
} from "../src/social/announce.ts";

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: false, ...over });

describe("signOAuth1 — HMAC-SHA1 base string + signature", () => {
  test("reproduces RFC 5849 section 3.1's worked example exactly", () => {
    // The RFC's own canonical example: a POST with a query string (b5, a3,
    // c@, a2) AND a form-encoded body (c2, a3) -- a3 is deliberately
    // repeated with two different values, which is why this function takes
    // pairs rather than a Record (a plain object would silently drop one).
    // Values here are the RFC's DECODED (raw) values; signOAuth1 does its
    // own percent-encoding, so passing already-encoded text would double-
    // encode it.
    const params: [string, string][] = [
      ["b5", "=%3D"],
      ["a3", "a"],
      ["c@", ""],
      ["a2", "r b"],
      ["c2", ""],
      ["a3", "2 q"],
      ["oauth_consumer_key", "9djdj82h48djs9d2"],
      ["oauth_nonce", "7d8f3e4a"],
      ["oauth_signature_method", "HMAC-SHA1"],
      ["oauth_timestamp", "137131201"],
      ["oauth_token", "kkk9d7dh3k39sjv7"],
    ];
    const signature = signOAuth1(
      "POST", "http://example.com/request", params, "j49sk3j29djd", "dh893hdasih9",
    );
    // NOT "bYT5CMsGcbgUdFHObYMEfcx6bsw=" -- that's the value printed in
    // RFC 5849 sections 3.1 and 3.4.1.1, but it's wrong: RFC Errata ID 2550
    // (verified) documents that the RFC's own example signed the base
    // string as if the method were GET rather than POST. This is the
    // errata-corrected value, independently confirmed here by reproducing
    // the RFC's own normalized parameter string and base string byte-for-
    // byte first (both matched exactly) before computing the signature.
    assert.equal(signature, "r6/TJjbCOr97/+UU0NsvSne7s5g=");
  });
});

describe("buildAuthHeader — this codebase's actual call shape", () => {
  const creds = {
    apiKey: "key123", apiSecret: "secret456", accessToken: "tok789", accessTokenSecret: "toksecret012",
  };

  test("carries every required oauth_* field plus a signature", () => {
    const header = buildAuthHeader(
      "POST", "https://api.x.com/2/tweets", creds, "fixed-nonce", "1700000000",
    );
    assert.match(header, /^OAuth /);
    for (const field of [
      "oauth_consumer_key", "oauth_nonce", "oauth_signature_method",
      "oauth_timestamp", "oauth_token", "oauth_version", "oauth_signature",
    ]) {
      assert.match(header, new RegExp(`${field}="[^"]+"`), `missing ${field}`);
    }
    assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
    assert.match(header, /oauth_version="1\.0"/);
  });

  test("is deterministic for the same nonce/timestamp, and changes if the secret does", () => {
    const a = buildAuthHeader("POST", "https://api.x.com/2/tweets", creds, "n", "1700000000");
    const b = buildAuthHeader("POST", "https://api.x.com/2/tweets", creds, "n", "1700000000");
    assert.equal(a, b);

    const differentSecret = { ...creds, apiSecret: "different" };
    const c = buildAuthHeader("POST", "https://api.x.com/2/tweets", differentSecret, "n", "1700000000");
    assert.notEqual(a, c);
  });
});

describe("announcementText — the fixed disclosure template", () => {
  test("always carries the automation disclosure marker", () => {
    const text = announcementText({ name: "Trips", symbol: "TRIPS" }, "9peztVGeqdCFYbvbmJ9NxKWzBW2RKU7j8n2dz2DS9zSv");
    assert.match(text, /^🐄 auto-launched/);
  });

  test("includes the mint so the coin is actually reachable", () => {
    const text = announcementText({ name: "Trips", symbol: "TRIPS" }, "9peztVGeqdCFYbvbmJ9NxKWzBW2RKU7j8n2dz2DS9zSv");
    assert.match(text, /9peztVGeqdCFYbvbmJ9NxKWzBW2RKU7j8n2dz2DS9zSv/);
  });

  test("stays under X's 280-character limit even for the longest allowed name/symbol", () => {
    // assets/naming.ts sanitizes before this is ever called, but check the
    // worst case this function itself would be handed.
    const text = announcementText(
      { name: "A".repeat(32), symbol: "B".repeat(10) },
      "9peztVGeqdCFYbvbmJ9NxKWzBW2RKU7j8n2dz2DS9zSv",
    );
    assert.ok(text.length <= 280, `${text.length} chars: ${text}`);
  });
});

describe("postLaunchAnnouncement — never affects the launch it announces", () => {
  test("does nothing when disabled (the default)", async () => {
    const db = openMemoryDb();
    const budget = new BudgetGuard(db, cfg());
    await postLaunchAnnouncement({ name: "Trips", symbol: "TRIPS" }, "mint111", cfg(), budget);
    assert.equal(budget.meterUsed(METER_KEY), 0, "must not charge the meter when disabled");
  });

  test("does nothing when enabled but credentials are absent", async () => {
    const db = openMemoryDb();
    const budget = new BudgetGuard(db, cfg({ social: { xAnnounce: { enabled: true } } }));
    for (const k of ["X_ANNOUNCE_API_KEY", "X_ANNOUNCE_API_SECRET", "X_ANNOUNCE_ACCESS_TOKEN", "X_ANNOUNCE_ACCESS_TOKEN_SECRET"]) {
      delete process.env[k];
    }
    await postLaunchAnnouncement({ name: "Trips", symbol: "TRIPS" }, "mint111", cfg({ social: { xAnnounce: { enabled: true } } }), budget);
    assert.equal(budget.meterUsed(METER_KEY), 0, "must not charge the meter with no credentials to post with");
  });

  test("refuses once the monthly USD cap is already used up, without attempting a request", async () => {
    const db = openMemoryDb();
    const c = cfg({ social: { xAnnounce: { enabled: true, monthlyUsdCap: 1, estimatedCostPerPost: 0.2 } } });
    const budget = new BudgetGuard(db, c);
    process.env.X_ANNOUNCE_API_KEY = "k";
    process.env.X_ANNOUNCE_API_SECRET = "s";
    process.env.X_ANNOUNCE_ACCESS_TOKEN = "t";
    process.env.X_ANNOUNCE_ACCESS_TOKEN_SECRET = "ts";
    try {
      // Exhaust the cap first, same as xApi.ts's own meter test convention.
      assert.equal(budget.meterCharge(METER_KEY, 1, 1), true);
      await postLaunchAnnouncement({ name: "Trips", symbol: "TRIPS" }, "mint111", c, budget);
      // Still exactly 1 -- the call above must not have added a second charge.
      assert.equal(budget.meterUsed(METER_KEY), 1);
    } finally {
      delete process.env.X_ANNOUNCE_API_KEY;
      delete process.env.X_ANNOUNCE_API_SECRET;
      delete process.env.X_ANNOUNCE_ACCESS_TOKEN;
      delete process.env.X_ANNOUNCE_ACCESS_TOKEN_SECRET;
    }
  });
});

describe("the thesis line", () => {
  test("carries the source link when the candidate had one", () => {
    const t = announcementText({ name: "Motor City", symbol: "MOTOR" },
      "So1111111111111111111111111111111111111111",
      "https://news.example.com/motor-city");
    assert.ok(t.includes("thesis: https://news.example.com/motor-city"));
    assert.ok(t.includes("pump.fun/coin/So1111111111111111111111111111111111111111"));
  });

  test("omits the thesis line cleanly when there is no source", () => {
    const t = announcementText({ name: "Motor City", symbol: "MOTOR" }, "m1");
    assert.ok(!t.includes("thesis"));
    assert.ok(!t.includes("undefined"));
  });

  test("the disclosure marker is unconditional either way", () => {
    // "auto-launched" is what keeps this on the right side of DECISIONS #2:
    // the account says what it is on every single post.
    for (const url of [undefined, "https://x.com/some/status/1"]) {
      assert.ok(announcementText({ name: "N", symbol: "S" }, "m", url).includes("auto-launched"));
    }
  });
});

describe("postSessionUpdate", () => {
  test("does nothing while disabled, and charges nothing", async () => {
    const { postSessionUpdate } = await import("../src/social/announce.ts");
    const db = openMemoryDb();
    const budget = new BudgetGuard(db, cfg());
    const posted = await postSessionUpdate(cfg(), budget,
      { launches24h: 5, feesClaimedSol: 1, realizedPnlSol: 0.2, openPositions: 3 });
    assert.equal(posted, false);
    assert.equal(budget.meterUsed(METER_KEY), 0);
  });

  test("without credentials it declines before touching the meter", async () => {
    const { postSessionUpdate } = await import("../src/social/announce.ts");
    for (const k of ["X_ANNOUNCE_API_KEY", "X_ANNOUNCE_API_SECRET",
                     "X_ANNOUNCE_ACCESS_TOKEN", "X_ANNOUNCE_ACCESS_TOKEN_SECRET"]) delete process.env[k];
    const db = openMemoryDb();
    const c = cfg({ social: { xAnnounce: { enabled: true } } });
    const budget = new BudgetGuard(db, c);
    const posted = await postSessionUpdate(c, budget,
      { launches24h: 0, feesClaimedSol: 0, realizedPnlSol: 0, openPositions: 0 });
    assert.equal(posted, false);
    assert.equal(budget.meterUsed(METER_KEY), 0,
      "a post that was never attempted must not be billed");
  });
});
