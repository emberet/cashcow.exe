import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { configSchema } from "../src/config/schema.ts";
import { sellAll, isProtectedMint, ProtectedMintError } from "../src/chain/trade.ts";

// ==================================================================
// Some tokens are held on purpose -- the project's own coin among them --
// and must never be sold by the exit rules or by an admin force-sell.
//
// The guard lives in sellAll(), the single function EVERY sale routes
// through (positions/manager.ts for automated exits, web/commands.ts for the
// admin command). Putting it at either call site instead would leave the
// other one open, which is the same reasoning as invariant 1's single path
// to spending SOL.
// ==================================================================

const PROTECTED = "67iVaRRQkNnZvN29rG75kt71nVdhkc5imwYDTivApump";
const OTHER = "9peztVGeqdCFYbvbmJ9NxKWzBW2RKU7j8n2dz2DS9zSv";

const cfg = (mints: string[] = [PROTECTED]) =>
  configSchema.parse({ dryRun: false, devPosition: { neverSellMints: mints } });

describe("never-sell list", () => {
  test("identifies a protected mint, and only that mint", () => {
    const c = cfg();
    assert.equal(isProtectedMint(c, PROTECTED), true);
    assert.equal(isProtectedMint(c, OTHER), false);
  });

  test("sellAll refuses a protected mint", async () => {
    await assert.rejects(
      () => sellAll(cfg(), PROTECTED, 20),
      (e: unknown) => e instanceof ProtectedMintError && e.mint === PROTECTED,
      "a protected mint must be refused with a distinct, identifiable error",
    );
  });

  test("refusal happens before any network or wallet access", async () => {
    // No RPC configured and no wallet loadable here: if the guard were
    // anywhere later than the first line, this would fail with a connection
    // or keypair error instead of ProtectedMintError. That distinction is
    // the whole point -- the refusal must not depend on being able to reach
    // the chain.
    const c = configSchema.parse({
      dryRun: false,
      rpc: { primary: "https://127.0.0.1:1/nope" },
      devPosition: { neverSellMints: [PROTECTED] },
    });
    await assert.rejects(
      () => sellAll(c, PROTECTED, 20),
      ProtectedMintError,
    );
  });

  test("the list is empty by default, so other deployments are unaffected", () => {
    const c = configSchema.parse({});
    assert.deepEqual(c.devPosition.neverSellMints, []);
    assert.equal(isProtectedMint(c, PROTECTED), false);
  });

  test("protecting one mint does not protect a similar-looking one", () => {
    const c = cfg([PROTECTED]);
    assert.equal(isProtectedMint(c, PROTECTED.toLowerCase()), false,
      "matching is exact -- a case-folded lookalike is a different address");
    assert.equal(isProtectedMint(c, PROTECTED.slice(0, -1)), false);
  });

  test("several mints can be protected at once", () => {
    const c = cfg([PROTECTED, OTHER]);
    assert.equal(isProtectedMint(c, PROTECTED), true);
    assert.equal(isProtectedMint(c, OTHER), true);
  });
});
