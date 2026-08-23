import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "../config/schema.ts";
import { PROJECT_ROOT } from "../config/load.ts";
import { log } from "../util/log.ts";

/**
 * Dev wallet loading.
 *
 * The secret is read from the environment (or a keypair file) and never
 * logged, never serialised into config, and never written to the database --
 * the logger redacts on key name as a second line of defence. Fund this wallet
 * with capital you would be willing to write off entirely: it is operated by an
 * autonomous loop.
 */

let cached: Keypair | undefined;

function parseSecret(raw: string): Uint8Array {
  const trimmed = raw.trim();

  // JSON byte array, as written by `solana-keygen`.
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed) as number[];
    if (!Array.isArray(arr) || (arr.length !== 64 && arr.length !== 32)) {
      throw new Error(`expected a 32- or 64-byte array, got length ${arr.length}`);
    }
    return Uint8Array.from(arr);
  }

  // Base58, as exported by Phantom and friends.
  const decoded = bs58.decode(trimmed);
  if (decoded.length !== 64 && decoded.length !== 32) {
    throw new Error(`expected a 32- or 64-byte base58 secret, got ${decoded.length} bytes`);
  }
  return decoded;
}

function fromSecret(bytes: Uint8Array): Keypair {
  return bytes.length === 64
    ? Keypair.fromSecretKey(bytes)
    : Keypair.fromSeed(bytes);
}

export function loadWallet(cfg: Config): Keypair {
  if (cached) return cached;

  const envName = cfg.wallet.secretEnv;
  const raw = process.env[envName];

  if (raw) {
    try {
      cached = fromSecret(parseSecret(raw));
    } catch (e) {
      // Deliberately does not echo the value.
      throw new Error(
        `${envName} is set but could not be parsed as a Solana secret key: ` +
        `${e instanceof Error ? e.message : String(e)}`,
      );
    }
  } else if (cfg.wallet.keypairPath) {
    const p = isAbsolute(cfg.wallet.keypairPath)
      ? cfg.wallet.keypairPath
      : resolve(PROJECT_ROOT, cfg.wallet.keypairPath);
    if (!existsSync(p)) throw new Error(`wallet.keypairPath does not exist: ${p}`);
    cached = fromSecret(parseSecret(readFileSync(p, "utf8")));
  } else if (cfg.dryRun) {
    // A dry run signs nothing, so it does not need the real key. Using a
    // throwaway keypair lets the whole pipeline be exercised before any wallet
    // exists -- which is the point of running it before funding anything.
    cached = Keypair.generate();
    log.warn("DRY RUN: no wallet configured, using an ephemeral throwaway keypair", {
      pubkey: cached.publicKey.toBase58(),
      note: `set ${envName} in .env before running live`,
    });
    return cached;
  } else {
    throw new Error(
      `No dev wallet configured. Set ${envName} in .env (base58 or JSON byte array), ` +
      `or set wallet.keypairPath in config.`,
    );
  }

  log.info("dev wallet loaded", { pubkey: cached.publicKey.toBase58() });
  return cached;
}

/** Public key without requiring the secret, when only the address is needed. */
export function walletPubkey(cfg: Config): string {
  return loadWallet(cfg).publicKey.toBase58();
}

export function __resetWalletCache(): void {
  cached = undefined;
}
