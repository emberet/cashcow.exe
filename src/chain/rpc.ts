import { Connection, ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import type { Config } from "../config/schema.ts";
import { log } from "../util/log.ts";

/**
 * RPC access and priority-fee estimation.
 *
 * Landing speed is most of the edge on a trend, so priority fees are sampled
 * from what is actually clearing recent blocks rather than guessed. The
 * configured ceiling matters as much as the floor: fast is worth paying for,
 * but not at any price, and an unbounded fee estimator is its own way to drain
 * a wallet.
 */

let conn: Connection | undefined;

export function getConnection(cfg: Config): Connection {
  if (!conn) {
    conn = new Connection(cfg.rpc.primary, {
      commitment: cfg.rpc.commitment,
      confirmTransactionInitialTimeout: 60_000,
    });
    log.debug("rpc connected", { endpoint: redactEndpoint(cfg.rpc.primary) });
  }
  return conn;
}

/** API keys frequently live in the RPC path; keep them out of logs. */
export function redactEndpoint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.length > 1 ? "/…" : ""}`;
  } catch {
    return "invalid-url";
  }
}

export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / 1_000_000_000;
}

export function solToLamports(sol: number): number {
  return Math.round(sol * 1_000_000_000);
}

export async function getBalanceSol(cfg: Config, pubkey: Parameters<Connection["getBalance"]>[0]): Promise<number> {
  return lamportsToSol(await getConnection(cfg).getBalance(pubkey));
}

/**
 * Sample recent prioritization fees and take a percentile, clamped to the
 * configured band. Falls back to the floor if the RPC has no samples.
 */
export async function estimatePriorityFee(cfg: Config): Promise<number> {
  const p = cfg.rpc.priorityFee;
  if (p.mode === "fixed") {
    return clampFee(p.fixedMicroLamports, p);
  }

  try {
    const samples = await getConnection(cfg).getRecentPrioritizationFees();
    const fees = samples
      .map((s) => s.prioritizationFee)
      .filter((f) => Number.isFinite(f) && f > 0)
      .sort((a, b) => a - b);

    if (!fees.length) return p.minMicroLamports;

    const idx = Math.min(fees.length - 1, Math.floor((p.percentile / 100) * fees.length));
    return clampFee(fees[idx]!, p);
  } catch (e) {
    log.warn("priority fee estimation failed, using floor", { err: String(e).slice(0, 120) });
    return p.minMicroLamports;
  }
}

function clampFee(fee: number, p: Config["rpc"]["priorityFee"]): number {
  return Math.max(p.minMicroLamports, Math.min(p.maxMicroLamports, Math.round(fee)));
}

/** Compute-budget instructions to prepend to every transaction we build. */
export async function computeBudgetIxs(cfg: Config): Promise<TransactionInstruction[]> {
  const microLamports = await estimatePriorityFee(cfg);
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.rpc.priorityFee.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

/**
 * Upper bound on what the priority fee alone can cost, in SOL. Used by the
 * budget guard so estimates run high rather than low.
 */
export function maxPriorityFeeCostSol(cfg: Config): number {
  const p = cfg.rpc.priorityFee;
  return (p.maxMicroLamports * p.computeUnitLimit) / 1e6 / 1e9;
}

export function __resetConnection(): void {
  conn = undefined;
}

/**
 * Serializes every operation that measures a wallet SOL delta around a
 * transaction: launch (chain/launch.ts), fee claim (chain/fees.ts) and sell
 * (chain/trade.ts) each read the balance, send+confirm a transaction, then
 * read the balance again. Those three run on two independent schedulers --
 * the slow launch loop and the fast position-exit poll -- and each spends
 * several seconds inside `confirmTransaction`. Left unserialized, one
 * operation's "before" or "after" read can land while another's transaction
 * is still in flight, folding an unrelated inflow or outflow into the
 * measured delta. A creator-fee claim landing inside a launch's snapshot
 * window once made a real ~0.025 SOL launch cost measure as 0.
 */
let balanceLock: Promise<void> = Promise.resolve();

export function withBalanceLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = balanceLock.then(fn);
  balanceLock = run.then(() => undefined, () => undefined);
  return run;
}
