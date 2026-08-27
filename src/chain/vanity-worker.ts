import { parentPort, workerData } from "node:worker_threads";
import { grindMintKeypair } from "./vanity.ts";

/**
 * One lane of a parallel vanity grind, spawned by `grindMintKeypairParallel`.
 * Runs the same single-threaded search as `grindMintKeypair`, independently
 * random per worker (no coordination needed -- collisions between workers'
 * random keypairs are astronomically unlikely), and posts the result back.
 */
const { suffix, timeoutMs } = workerData as { suffix: string; timeoutMs: number };

const result = grindMintKeypair(suffix, timeoutMs);

if (result) {
  parentPort?.postMessage({
    publicKey: result.keypair.publicKey.toBytes(),
    secretKey: result.keypair.secretKey,
    attempts: result.attempts,
    ms: result.ms,
  });
} else {
  parentPort?.postMessage(null);
}
