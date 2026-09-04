import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loadLoreCorpus, findLore, loreFor, appendLore, loreLine, clearLoreCache,
} from "../src/lore/corpus.ts";
import { compileFilters, checkTerm, FUNCTION_WORDS } from "../src/scoring/filters.ts";
import { configSchema } from "../src/config/schema.ts";

// ==================================================================
// Lore enrichment (operator directive 2026-09-04, from asteroid 18932
// Robinhood). The load-bearing property under test is NEGATIVE: lore may
// change what a launch says and must never change what launches. Every
// scoring input is untouched by this module, and the tests below pin the
// two ways it could go wrong -- matching contentless terms, and smuggling
// a person or brand past the filters that exist to stop them.
// ==================================================================

const FIXTURE = "test/fixtures/lore-corpus.json";
const filters = compileFilters(configSchema.parse({ feeds: {} }).filters);

function cfg(over: Record<string, unknown> = {}) {
  return {
    lore: {
      enabled: true, corpusPath: FIXTURE, minWordLength: 4,
      useAsThesisFallback: true, ...over,
    },
  };
}

describe("lore corpus", () => {
  beforeEach(() => clearLoreCache());

  test("loads the fixture and indexes it by key", () => {
    const c = loadLoreCorpus(FIXTURE);
    assert.equal(c.size, 9);
    assert.equal(c.byKey.get("robinhood")?.[0]?.title, "18932 Robinhood");
  });

  test("a missing corpus is not an error -- it is simply no lore", () => {
    const c = loadLoreCorpus("test/fixtures/does-not-exist.json");
    assert.equal(c.size, 0);
    assert.equal(findLore("Robinhood", c, filters), null);
  });

  test("a malformed corpus degrades instead of throwing", () => {
    const c = loadLoreCorpus("package.json"); // valid JSON, wrong shape
    assert.equal(c.size, 0);
  });

  test("the operator's example resolves", () => {
    const hit = findLore("Robinhood", loadLoreCorpus(FIXTURE), filters);
    assert.equal(hit?.title, "18932 Robinhood");
    assert.match(hit!.url, /minorplanetcenter\.net/);
  });

  test("$LINUX -- the dud that should have had a story -- now has one", () => {
    const hit = findLore("Linux", loadLoreCorpus(FIXTURE), filters);
    assert.equal(hit?.title, "9885 Linux");
    assert.equal(loreLine(hit!), "Lore: 9885 Linux is a main-belt asteroid, about 5.0 km across.");
  });

  test("matching is case- and whitespace-insensitive", () => {
    const c = loadLoreCorpus(FIXTURE);
    assert.equal(findLore("  ROBINHOOD ", c, filters)?.title, "18932 Robinhood");
  });
});

describe("lore cannot become a side door", () => {
  beforeEach(() => clearLoreCache());

  test("a trademark in the corpus is rejected by the same filters as a term", () => {
    // "Windows" is blocked as a term; it must also be blocked as lore, or
    // the trivia line becomes a way to publish what the gate refused.
    assert.equal(findLore("Windows", loadLoreCorpus(FIXTURE), filters), null);
  });

  test("a catalogue number cannot launder a person name past the screen", () => {
    // THE BUG THIS TEST WAS WRITTEN FOR. looksLikePersonName() returns false
    // for any string containing a digit, so screening only the title
    // ("9007 James Bond") silently exempted every person-named entry in the
    // catalogue -- the number itself was the exemption. The bare `name` is
    // screened separately for exactly this reason.
    const c = loadLoreCorpus(FIXTURE);
    const strict = compileFilters(
      configSchema.parse({ feeds: {}, filters: { blockLikelyPersonNames: true } }).filters,
    );
    assert.equal(findLore("James Bond", c, strict), null);
  });

  test("a legacy entry with no `name` field still gets screened", () => {
    // Corpora written before the field existed must not be exempt: the name
    // is recovered from the title rather than the screen being skipped.
    const c = loadLoreCorpus(FIXTURE);
    assert.equal(c.byKey.get("legacy")?.[0]?.name, "Legacy");
  });

  test("a lone surname is allowed, and that is correct", () => {
    // 249541 Steinem is a real minor planet AND a real surname, and a
    // one-word name is indistinguishable from a common noun -- no heuristic
    // separates "Steinem" from "Silver". This is safe because lore is not a
    // gate: the term "Gloria Steinem" never reaches this code at all, having
    // been rejected upstream by checkTerm(). What lore may attach is bounded
    // by what already qualified, which is the whole design.
    const c = loadLoreCorpus(FIXTURE);
    const strict = compileFilters(
      configSchema.parse({ feeds: {}, filters: { blockLikelyPersonNames: true } }).filters,
    );
    assert.equal(checkTerm("Gloria Steinem", strict).allowed, false);
    assert.equal(findLore("Steinem", c, strict)?.title, "249541 Steinem");
  });

  test("function words are never looked up", () => {
    // "Yes" and "Now" are genuinely named minor planets. Attaching trivia to
    // them would decorate exactly the contentless terms that produced $LETS.
    for (const w of ["yes", "now", "the", "just"]) {
      assert.ok(FUNCTION_WORDS.has(w), `${w} should be a function word`);
    }
    const c = loadLoreCorpus(FIXTURE);
    assert.equal(findLore("Now", c, filters), null);
  });

  test("short words inside a longer term are not matched", () => {
    const c = loadLoreCorpus(FIXTURE);
    // minWordLength 4: "hal" inside a sentence must not match 9000 Hal...
    assert.equal(
      findLore("hal and the crew", c, filters, { minWordLength: 4 }), null,
    );
    // ...but "Hal" as the whole trend is a deliberate reference.
    assert.equal(findLore("Hal", c, filters, { minWordLength: 4 })?.title, "9000 Hal");
  });

  test("a word inside a multi-word term matches at or above the length floor", () => {
    const c = loadLoreCorpus(FIXTURE);
    assert.equal(
      findLore("the linux desktop", c, filters, { minWordLength: 4 })?.title,
      "9885 Linux",
    );
  });

  test("ties break toward the more notable entry", () => {
    const c = loadLoreCorpus(FIXTURE);
    // Two entries share the key "apollo"; the lower catalogue number wins.
    assert.equal(findLore("Apollo", c, filters)?.title, "1862 Apollo");
  });
});

describe("loreFor + appendLore", () => {
  beforeEach(() => clearLoreCache());

  test("disabled config yields nothing even with a corpus present", () => {
    assert.equal(loreFor(cfg({ enabled: false }) as never, "Robinhood", filters), null);
  });

  test("enabled config resolves through the cache", () => {
    const a = loreFor(cfg() as never, "Robinhood", filters);
    const b = loreFor(cfg() as never, "Robinhood", filters);
    assert.equal(a?.title, "18932 Robinhood");
    assert.equal(b?.title, "18932 Robinhood");
  });

  test("appendLore respects the description budget", () => {
    const hit = loreFor(cfg() as never, "Robinhood", filters)!;
    const out = appendLore("A coin.", hit, 500);
    assert.match(out, /^A coin\. Lore: 18932 Robinhood/);
    // Too tight to fit: return the description untouched rather than a
    // truncated half-fact.
    assert.equal(appendLore("A coin.", hit, 20), "A coin.");
  });
});

describe("the real corpus, if it has been fetched", () => {
  beforeEach(() => clearLoreCache());

  test("the production corpus contains the operator's asteroid", () => {
    let raw: string;
    try {
      raw = readFileSync("data/lore/minor-planets.json", "utf8");
    } catch {
      return; // Not fetched in this checkout; the fixture tests carry the logic.
    }
    const c = loadLoreCorpus("data/lore/minor-planets.json");
    assert.ok(c.size > 20_000, `expected a full catalogue, got ${c.size}`);
    assert.equal(findLore("Robinhood", c, filters)?.title, "18932 Robinhood");
    assert.equal(findLore("Linux", c, filters)?.title, "9885 Linux");
    // No entry may carry a discovery year: JPL's first_obs is the start of
    // the observation arc, not the discovery (it reports 1995 for Ceres,
    // discovered 1801). Publishing it would be an unverified value on a coin.
    assert.doesNotMatch(raw.slice(0, 200_000), /first observed in/);
  });
});
