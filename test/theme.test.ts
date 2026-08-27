import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { themeOf } from "../src/assets/theme.ts";
import { banner, glyph, GLYPH_H, GLYPH_W } from "../src/assets/font5x7.ts";
import { renderTokenImage } from "../src/assets/image.ts";
import type { TokenIdentity } from "../src/assets/naming.ts";

const identity = (over: Partial<TokenIdentity> = {}): TokenIdentity => ({
  name: "Test Coin",
  symbol: "TEST",
  description: "a coin for testing",
  source: "fallback",
  ...over,
});

describe("themeOf", () => {
  test("routes AI and compute trends to the terminal template", () => {
    assert.equal(themeOf("openai releases new model"), "ascii");
    assert.equal(themeOf("nvidia gpu shortage"), "ascii");
    assert.equal(themeOf("humanoid robot factory"), "ascii");
  });

  test("routes politics and officialdom to the meme-poster template", () => {
    assert.equal(themeOf("white house tariff announcement"), "slop");
    assert.equal(themeOf("senate passes bill"), "slop");
    assert.equal(themeOf("governor signs executive order"), "slop");
  });

  test("falls back to the monogram when nothing fits", () => {
    assert.equal(themeOf("cancer drug approval"), "monogram");
    assert.equal(themeOf("taylor swift tour"), "monogram");
    assert.equal(themeOf(""), "monogram");
  });

  // "ai" is a substring of an enormous number of ordinary English words. A
  // substring match here would have sent "chair", "said" and "captain" to the
  // terminal template, which is why matching is tokenised.
  test("does not fire on words that merely contain a keyword", () => {
    assert.equal(themeOf("said the chair to the captain"), "monogram");
    assert.equal(themeOf("air quality"), "monogram");
    assert.equal(themeOf("press the grape"), "slop"); // "press" is a real hit
  });

  test("punctuation and case do not change the verdict", () => {
    assert.equal(themeOf("White House's Tariff!"), "slop");
    assert.equal(themeOf("white-house tariff"), "slop");
  });

  // Model prose reaches for technology framing on any subject, so it must not
  // be able to outvote the trend phrase itself.
  test("the trend term outweighs the generated description", () => {
    assert.equal(
      themeOf("senate hearing", "an ai model for the ai age of ai"),
      "slop",
    );
  });

  test("a genuine tie resolves to slop, which degrades more gracefully", () => {
    assert.equal(themeOf("senate ai hearing"), "slop");
  });
});

describe("5x7 bitmap font", () => {
  test("every glyph is exactly the declared size", () => {
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") {
      const g = glyph(ch);
      assert.equal(g.length, GLYPH_H, `${ch} row count`);
      for (const row of g) assert.equal(row.length, GLYPH_W, `${ch} row width`);
    }
  });

  test("unknown characters render a placeholder instead of throwing", () => {
    const g = glyph("!");
    assert.equal(g.length, GLYPH_H);
  });

  test("a banner is one blank column between glyphs", () => {
    const rows = banner("AB");
    assert.equal(rows.length, GLYPH_H);
    // 2 glyphs * 5 columns + 1 separator
    for (const row of rows) assert.equal(row.length, GLYPH_W * 2 + 1);
  });

  test("an empty ticker produces no rows rather than a broken grid", () => {
    assert.deepEqual(banner(""), []);
  });
});

describe("renderTokenImage", () => {
  const themed = configSchema.parse({ assets: { image: { themed: true } } });

  test("themed rendering is off by default, so existing launches are unchanged", () => {
    const dflt = configSchema.parse({});
    assert.equal(dflt.assets.image.themed, false);
  });

  test("with themed off, every trend still renders the monogram", async () => {
    const off = configSchema.parse({});
    const img = await renderTokenImage(off, identity(), "openai model release");
    assert.equal(img.theme, "monogram");
  });

  test("with themed on, the trend picks the template", async () => {
    const ai = await renderTokenImage(themed, identity({ symbol: "AGENT" }), "openai model");
    assert.equal(ai.theme, "ascii");

    const pol = await renderTokenImage(themed, identity({ symbol: "TARIFF" }), "white house tariff");
    assert.equal(pol.theme, "slop");
  });

  test("every template emits a real PNG", async () => {
    for (const term of ["openai model", "white house tariff", "cancer drug"]) {
      const img = await renderTokenImage(themed, identity(), term);
      assert.equal(img.contentType, "image/png");
      assert.ok(img.buffer.length > 1000, `${term} produced a suspiciously small file`);
      // PNG magic number: artwork must never be silently empty or an SVG blob.
      assert.deepEqual([...img.buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    }
  });

  // Artwork is cosmetic; it must never be the reason a launch aborts.
  test("awkward tickers still render", async () => {
    for (const symbol of ["A", "ZZZZZZZZ", "X1Y2Z3"]) {
      const img = await renderTokenImage(themed, identity({ symbol }), "openai model");
      assert.ok(img.buffer.length > 1000, `${symbol} failed to render`);
    }
  });

  test("the same ticker renders identically twice", async () => {
    const a = await renderTokenImage(themed, identity({ symbol: "SAME" }), "openai model");
    const b = await renderTokenImage(themed, identity({ symbol: "SAME" }), "openai model");
    assert.deepEqual(a.buffer, b.buffer);
  });
});
