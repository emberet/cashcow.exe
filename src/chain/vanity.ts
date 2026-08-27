import { Keypair } from "@solana/web3.js";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

/**
 * Vanity mint addresses.
 *
 * pump.fun's own frontend grinds a mint keypair client-side so the resulting
 * address ends in "pump" before ever calling the on-chain program -- the
 * program itself accepts any keypair, so this is purely cosmetic. Kept as an
 * opt-in (see `launch.vanitySuffix`) rather than the default, since grinding
 * adds real wall-clock latency to whatever launch requests it.
 *
 * Measured on the deploy machine: ~9,400 Keypair.generate() calls/sec on one
 * core. A 4-char base58 suffix (58^4 ~= 11.3M expected attempts) is therefore
 * ~20 minutes single-threaded -- too slow to be a "quick grind" as first
 * assumed. `grindMintKeypairParallel` spreads the same search across worker
 * threads for a near-linear wall-clock speedup instead.
 */

export type VanityResult = {
  keypair: Keypair;
  attempts: number;
  ms: number;
};

/**
 * Brute-force a mint keypair whose base58 public key ends with `suffix`.
 * Case-sensitive: pump.fun's convention is lowercase "pump". Returns null on
 * timeout rather than blocking a launch indefinitely -- a launch that cannot
 * find a vanity address should fall back to a random one, not stall.
 *
 * Single-threaded building block, used directly for short/fast suffixes (and
 * by tests), and internally by each worker lane of the parallel version.
 */
export function grindMintKeypair(suffix: string, timeoutMs: number): VanityResult | null {
  const start = Date.now();
  let attempts = 0;
  while (Date.now() - start < timeoutMs) {
    attempts++;
    const kp = Keypair.generate();
    if (kp.publicKey.toBase58().endsWith(suffix)) {
      return { keypair: kp, attempts, ms: Date.now() - start };
    }
  }
  return null;
}

const WORKER_PATH = fileURLToPath(new URL("./vanity-worker.ts", import.meta.url));

type WorkerMessage = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  attempts: number;
  ms: number;
} | null;

/**
 * Same search as `grindMintKeypair`, spread across `workers` OS threads.
 * Each worker independently grinds for up to `timeoutMs`; the first match
 * wins and every other worker is terminated immediately. Resolves null only
 * if every worker exhausts its timeout without a match.
 *
 * `workers <= 1` falls back to the plain single-threaded grind rather than
 * paying worker-spawn overhead for no benefit.
 */
export function grindMintKeypairParallel(
  suffix: string,
  timeoutMs: number,
  workers: number,
): Promise<VanityResult | null> {
  if (workers <= 1) return Promise.resolve(grindMintKeypair(suffix, timeoutMs));

  return new Promise((resolve) => {
    const pool: Worker[] = [];
    let settled = false;
    let completed = 0;

    const finish = (result: VanityResult | null) => {
      if (settled) return;
      settled = true;
      for (const w of pool) void w.terminate();
      resolve(result);
    };

    for (let i = 0; i < workers; i++) {
      const w = new Worker(WORKER_PATH, { workerData: { suffix, timeoutMs } });
      pool.push(w);
      w.on("message", (msg: WorkerMessage) => {
        if (msg) {
          finish({
            keypair: Keypair.fromSecretKey(msg.secretKey),
            attempts: msg.attempts,
            ms: msg.ms,
          });
        } else {
          completed++;
          if (completed === workers) finish(null);
        }
      });
      w.on("error", () => {
        completed++;
        if (completed === workers) finish(null);
      });
    }
  });
}
