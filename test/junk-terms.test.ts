import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { isMeaninglessTerm, checkAll, compileFilters } from "../src/scoring/filters.ts";
import { configSchema } from "../src/config/schema.ts";

// ==================================================================
// The bot minted $LETS from "Let's build!" -- a stopword scraped out of a
// promotional tweet shilling an unrelated project. It reached mainnet and
// was announced on the project's own X account before a human caught it.
//
// Nothing upstream had an opinion about whether a term MEANS anything:
// tickerability actively rewards short single words (1 word, <=12 chars ->
// 1.0), corroboration was trivially satisfied because "let's" appears
// everywhere, and the filters only knew about trademarks, tragedy, slurs
// and people. See DECISIONS #48.
// ==================================================================

const filters = compileFilters(configSchema.parse({}).filters);

describe("meaningless-term gate", () => {
  test("the exact term that shipped is now rejected", () => {
    assert.equal(isMeaninglessTerm("Let's"), true);
    const r = checkAll(["Let's"], filters);
    assert.equal(r.allowed, false);
    assert.equal(r.allowed === false && r.category, "meaningless");
  });

  test("the other fragments seen in live candidate lists are rejected", () => {
    // Every one of these was a real scored candidate on 2026-08-31.
    for (const t of ["Now", "But", "Let", "Thank", "Looking", "Thank you",
                     "we are", "it is", "going to", "you know"]) {
      assert.equal(isMeaninglessTerm(t), true, `"${t}" should be rejected`);
    }
  });

  test("real trends are untouched", () => {
    for (const t of ["Panthers", "Motor City", "Dogecoin", "Brazilia",
                     "CloudChain", "ThunderStrike", "Democratic-backed",
                     "Rust", "quantum supremacy"]) {
      assert.equal(isMeaninglessTerm(t), false, `"${t}" must survive`);
    }
  });

  test("a content word carries the phrase even beside function words", () => {
    // "the Panthers" has a stopword AND a content word -- it is a real term.
    assert.equal(isMeaninglessTerm("the Panthers"), false);
    assert.equal(isMeaninglessTerm("we love Solana"), false);
  });

  test("generic-but-real nouns are NOT killed here", () => {
    // These are content words. They die at SATURATION when everyone has
    // already minted them, which is the correct gate (DECISIONS #26 keeps
    // crowding and meaninglessness as separate questions).
    for (const t of ["House", "Earth", "Water", "Free"]) {
      assert.equal(isMeaninglessTerm(t), false, `"${t}" is a real word`);
    }
  });

  test("empty and punctuation-only input is rejected, never crashes", () => {
    for (const t of ["", "   ", "!!!", "...", "—"]) {
      assert.equal(isMeaninglessTerm(t), true);
    }
  });

  test("the gate fires before the person-name heuristic", () => {
    // Ordering matters only for the reported reason, but a wrong reason
    // sends a human debugging the wrong rail.
    const r = checkAll(["Let Us"], filters);
    assert.equal(r.allowed, false);
    assert.equal(r.allowed === false && r.category, "meaningless");
  });
});
