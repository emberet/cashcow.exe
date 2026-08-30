import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { launchMessage, notifyLaunch } from "../src/social/telegram.ts";
import { provenanceLine, withProvenance, type TokenIdentity } from "../src/assets/naming.ts";
import { projectTokenView } from "../src/web/queries.ts";
import type { Candidate } from "../src/scoring/score.ts";

const identity = (over: Partial<TokenIdentity> = {}): TokenIdentity => ({
  name: "Trips", symbol: "TRIPS", description: "A trippy little coin.",
  source: "model", ...over,
});

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  key: "trips", term: "Trips", score: 71.4,
  components: { velocity: 1, acceleration: 0.5, corroboration: 0.5, cryptoAffinity: 0.85,
                tickerability: 1, reach: 0.5, decay: 0.9 },
  feeds: ["fourchan", "googleNews"], families: ["crypto", "press"],
  corroborationNote: "2 independent families (crypto + press)",
  firstSeen: Date.now(), lastSeen: Date.now(), observations: 4,
  ...over,
} as Candidate);

// ==================================================================
// Every coin used to ship either a model joke or "X trending on fourchan."
// Neither told a reader what the coin was actually about, which is the
// stated reason none of them attracted a buyer.
// ==================================================================

describe("provenance in the coin description", () => {
  test("names the trend, the sources, and the score", () => {
    const line = provenanceLine(candidate());
    assert.match(line, /Trips/);
    assert.match(line, /fourchan \+ googleNews/);
    assert.match(line, /71\/100/);
    assert.match(line, /2 independent families/);
  });

  test("is appended to the model's own description, not replacing it", () => {
    const cfg = configSchema.parse({});
    const out = withProvenance(identity(), candidate(), cfg);
    assert.match(out.description, /^A trippy little coin\./, "creative half must survive");
    assert.match(out.description, /Auto-launched from the trend/);
  });

  test("respects the total length cap without truncating the creative half", () => {
    const cfg = configSchema.parse({
      assets: { naming: { maxTotalDescriptionLength: 60 } },
    });
    const out = withProvenance(identity(), candidate(), cfg);
    assert.ok(out.description.length <= 60, `got ${out.description.length}`);
    assert.match(out.description, /^A trippy little coin\./);
  });

  test("can be turned off, leaving the description untouched", () => {
    const cfg = configSchema.parse({ assets: { naming: { includeProvenance: false } } });
    const out = withProvenance(identity(), candidate(), cfg);
    assert.equal(out.description, "A trippy little coin.");
  });
});

describe("telegram launch alert", () => {
  test("carries the ticker, trend, and a working pump.fun link", () => {
    const msg = launchMessage(identity(), "MINT111", candidate());
    assert.match(msg, /TRIPS/);
    assert.match(msg, /Trips/);
    assert.match(msg, /pump\.fun\/coin\/MINT111/);
  });

  test("escapes HTML so a coin name with angle brackets cannot break the message", () => {
    // Telegram rejects the whole send on malformed HTML, so an unescaped
    // name would silently lose the alert rather than render oddly.
    const msg = launchMessage(identity({ name: "<b>evil</b>", symbol: "A&B" }), "M", candidate());
    assert.ok(!msg.includes("<b>evil</b>"), "raw markup must not survive");
    assert.match(msg, /&lt;b&gt;evil&lt;\/b&gt;/);
    assert.match(msg, /A&amp;B/);
  });

  test("does nothing when disabled, even with credentials present", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "fake";
    process.env.TELEGRAM_CHAT_ID = "fake";
    try {
      const cfg = configSchema.parse({});           // telegram.enabled defaults false
      assert.equal(cfg.social.telegram.enabled, false);
      await notifyLaunch(identity(), "M", cfg, candidate());  // must not throw or send
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
    }
  });

  test("enabled but credential-less is a no-op, never a throw", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    const cfg = configSchema.parse({ social: { telegram: { enabled: true } } });
    // A launch has already been paid for by the time this runs; throwing here
    // would turn a successful launch into a counted failure.
    await notifyLaunch(identity(), "M", cfg, candidate());
  });
});

describe("the project's own token on the dashboard", () => {
  test("exposes pump.fun and solscan links for a valid mint", () => {
    const mint = "67iVaRRQkNnZvN29rG75kt71nVdhkc5imwYDTivApump";
    const v = projectTokenView(configSchema.parse({ web: { projectTokenMint: mint } }));
    assert.ok(v);
    assert.equal(v!.mint, mint);
    assert.equal(v!.pumpFunUrl, `https://pump.fun/coin/${mint}`);
  });

  test("is absent by default, so other deployments show no card", () => {
    assert.equal(projectTokenView(configSchema.parse({})), null);
  });

  test("rejects anything that is not a base58 Solana address", () => {
    for (const bad of ["", "   ", "not-a-mint", "javascript:alert(1)", "0x1234", "short"]) {
      assert.equal(
        projectTokenView(configSchema.parse({ web: { projectTokenMint: bad } })), null,
        `expected "${bad}" rejected`,
      );
    }
  });
});
