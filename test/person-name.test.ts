import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { looksLikePersonName } from "../src/scoring/filters.ts";

// ==================================================================
// The person-name screen is deliberately crude, and the asymmetry is the
// point: a false positive costs a duller token name, a false negative is a
// right-of-publicity claim. Both directions were measurably wrong.
//
// FALSE POSITIVES, from one day of real logs: "Tiger Rally", "Brazilian
// Vibes", "Now You", "Networth Until" -- 7 rejections, each forcing fallback
// naming and a worse ticker. These are title-cased sentence fragments, not
// names.
//
// FALSE NEGATIVE, found while fixing the above: the word pattern was
// /^[A-Z][a-z'-]{1,}$/, which has no uppercase inside the class. The B in
// O'Brien failed it, so "O'Brien Kelly" was declared NOT a person and skipped
// the screen entirely -- exempting every apostrophe and hyphen name. The
// comment directly above it claimed both were allowed. See DECISIONS #39.
// ==================================================================

describe("looksLikePersonName", () => {
  test("catches ordinary person names", () => {
    for (const n of ["Taylor Swift", "Elon Musk", "Lionel Messi",
                     "Serena Williams", "Mary Jane Watson"]) {
      assert.equal(looksLikePersonName(n), true, `${n} should be caught`);
    }
  });

  test("catches apostrophe and hyphen names -- the silent exemption", () => {
    for (const n of ["O'Brien Kelly", "Al-Hassan Ibrahim",
                     "Jean-Luc Picard", "D'Angelo Russell"]) {
      assert.equal(looksLikePersonName(n), true,
        `${n} was exempt from the screen entirely before this was fixed`);
    }
  });

  test("does not flag title-cased sentence fragments", () => {
    for (const n of ["Tiger Rally", "Brazilian Vibes", "Now You",
                     "Networth Until"]) {
      assert.equal(looksLikePersonName(n), false,
        `${n} is a fragment, not a name -- it appeared in real logs`);
    }
  });

  test("does not treat acronyms as people", () => {
    // The uppercase allowance is only after an apostrophe or hyphen, so
    // all-caps tokens still fail.
    for (const n of ["NFL Draft", "AI Boom", "US Open", "X Y Z", "A B"]) {
      assert.equal(looksLikePersonName(n), false, `${n} is not a person`);
    }
  });

  test("still flags names whose words are also common nouns", () => {
    // Deliberately NOT added to the exclusion list: these are real surnames
    // and given names, and a false negative is the expensive direction.
    for (const n of ["Summer Walker", "Winter Storm", "Rich Young"]) {
      assert.equal(looksLikePersonName(n), true, `${n} must stay caught`);
    }
  });

  test("ignores anything with digits, or the wrong word count", () => {
    assert.equal(looksLikePersonName("Taylor Swift 2"), false);
    assert.equal(looksLikePersonName("Cher"), false, "one word is not enough");
    assert.equal(looksLikePersonName("A Very Long Fake Name"), false);
    assert.equal(looksLikePersonName(""), false);
    assert.equal(looksLikePersonName("   "), false);
  });

  test("a lowercase word disqualifies the phrase", () => {
    assert.equal(looksLikePersonName("taylor swift"), false);
    assert.equal(looksLikePersonName("Taylor swift"), false);
  });
});
