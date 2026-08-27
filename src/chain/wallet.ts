import { readFileSync, existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "../config/schema.ts";
import type { Db } from "../util/db.ts";
import { kvGet, kvSet } from "../util/db.ts";
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

/**
 * Public key of the loaded wallet.
 *
 * NOTE: despite only returning an address, this DOES require the secret and
 * leaves the whole keypair in this module's cache -- deriving a public key
 * from a private key is not a way to avoid holding the private key. Callers
 * that only need the address and must not hold the secret (i.e. the web
 * process, invariant 4) want `publishedWalletAddress` instead.
 */
export function walletPubkey(cfg: Config): string {
  return loadWallet(cfg).publicKey.toBase58();
}

/** kv key under which the bot process publishes its address for readers. */
const WALLET_ADDRESS_KEY = "wallet_address";

/**
 * Publish the wallet address so processes that must not hold the key can still
 * display it. Called by the bot, which legitimately holds the secret already.
 *
 * Records nothing when no real wallet is configured, so a dry run's ephemeral
 * throwaway keypair never gets published as though it were real.
 */
export function publishWalletAddress(db: Db, cfg: Config): void {
  const address = configuredWalletAddress(cfg);
  if (address) kvSet(db, WALLET_ADDRESS_KEY, address);
}

/**
 * The wallet address as last published by the bot process -- read from the
 * database, never derived from the secret.
 *
 * This exists because of invariant 4: the web process must never hold the
 * wallet key. `configuredWalletAddress` looks harmless but calls `loadWallet`,
 * which parses the secret and caches the full keypair in whatever process
 * asked for it. That put a signing key inside the request-serving process for
 * the sake of printing an address that is public information anyway.
 *
 * Returns null until the bot has run at least once with a real wallet. Callers
 * must render that as "unknown" and must NOT fall back to loading the key.
 */
export function publishedWalletAddress(db: Db): string | null {
  return kvGet(db, WALLET_ADDRESS_KEY) ?? null;
}

/**
 * The address only when a real wallet is configured.
 *
 * `loadWallet` invents an ephemeral throwaway keypair in dry run so the pipeline
 * can be exercised with no setup. Publishing that address would be worse than
 * publishing nothing -- it looks like a real wallet, and it changes on every
 * restart. Returns null instead.
 */
export function configuredWalletAddress(cfg: Config): string | null {
  const hasSecret = Boolean(process.env[cfg.wallet.secretEnv]);
  const hasFile = Boolean(cfg.wallet.keypairPath);
  if (!hasSecret && !hasFile) return null;
  try {
    return loadWallet(cfg).publicKey.toBase58();
  } catch {
    return null;
  }
}

export function __resetWalletCache(): void {
  cached = undefined;
}
