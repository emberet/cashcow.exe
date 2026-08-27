import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { grindMintKeypair, grindMintKeypairParallel } from "../src/chain/vanity.ts";

/**
 * Vanity mint grinding is pure, local keypair generation -- no chain calls,
 * no money. Covers the two outcomes a launch actually depends on: it finds a
 * matching address in time, or it gives up cleanly rather than hanging.
 */
describe("grindMintKeypair", () => {
  test("finds a keypair ending in a common single base58 character", () => {
    // A 1-char suffix hits on ~1/58 tries, so this resolves in a handful of
    // milliseconds -- keeps the test fast while still exercising the real
    // generate-and-check loop used for longer suffixes like "pump".
    const suffix = "a";
    const result = grindMintKeypair(suffix, 5_000);
    assert.ok(result, "expected a match well within the timeout");
    assert.ok(result!.keypair.publicKey.toBase58().endsWith(suffix));
    assert.ok(result!.attempts > 0);
    assert.ok(result!.ms >= 0);
  });

  test("returns null rather than hanging when the timeout is exhausted", () => {
    // An effectively-zero timeout with an implausible multi-char suffix
    // guarantees no match is found before time runs out.
    const result = grindMintKeypair("zzzzzzzz", 1);
    assert.equal(result, null);
  });

  test("returned keypair is a valid, usable Solana keypair", () => {
    const result = grindMintKeypair("a", 5_000);
    assert.ok(result);
    assert.equal(result!.keypair.publicKey.toBytes().length, 32);
    assert.equal(result!.keypair.secretKey.length, 64);
  });
});

/**
 * `grindMintKeypairParallel` spreads the exact same search across
 * worker_threads. Covers the same two outcomes as the single-threaded
 * version, plus the `workers <= 1` fallback path -- worker spawn/message
 * round-trips add real wall-clock overhead, so these use a longer timeout
 * than the single-threaded tests even for a fast 1-char suffix.
 */
describe("grindMintKeypairParallel", () => {
  test("finds a keypair ending in a common single base58 character, spread across workers", async () => {
    const suffix = "a";
    const result = await grindMintKeypairParallel(suffix, 15_000, 4);
    assert.ok(result, "expected a match well within the timeout");
    assert.ok(result!.keypair.publicKey.toBase58().endsWith(suffix));
    assert.ok(result!.attempts > 0);
    assert.equal(result!.keypair.publicKey.toBytes().length, 32);
    assert.equal(result!.keypair.secretKey.length, 64);
  });

  test("returns null when every worker exhausts its timeout without a match", async () => {
    const result = await grindMintKeypairParallel("zzzzzzzz", 1, 4);
    assert.equal(result, null);
  });

  test("workers <= 1 falls back to the single-threaded grind rather than spawning", async () => {
    const result = await grindMintKeypairParallel("a", 5_000, 1);
    assert.ok(result);
    assert.ok(result!.keypair.publicKey.toBase58().endsWith("a"));
  });
});
