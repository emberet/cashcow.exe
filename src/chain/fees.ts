import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import { isPretend, type Config } from "../config/schema.ts";
import { getConnection, computeBudgetIxs, lamportsToSol, withBalanceLock } from "./rpc.ts";
import { loadWallet } from "./wallet.ts";
import { log } from "../util/log.ts";

/**
 * Creator fee collection -- the actual revenue model.
 *
 * pump.fun accrues creator fees into a vault and claims them in bulk across
 * every token the wallet has created, so this is one scheduled job rather than
 * a per-token operation. The balance is checked first: a claim below the cost
 * of its own transaction is a net loss, which is what `minClaimSol` prevents.
 */

export type ClaimResult = {
  claimedSol: number;
  signature?: string;
  skipped?: string;
  dryRun: boolean;
};

/** Unclaimed creator fees across both the bonding-curve and AMM programs. */
export async function creatorVaultBalanceSol(cfg: Config): Promise<number> {
  const online = new OnlinePumpSdk(getConnection(cfg));
  const wallet = loadWallet(cfg);
  const balance = await online.getCreatorVaultBalanceBothPrograms(wallet.publicKey);
  return lamportsToSol(balance.toNumber());
}

/**
 * Whether a claim actually hits the chain.
 *
 * MUST stay the exact inverse of the predicate `runner/loop.ts` uses to book
 * the `fee_claims` row (`isPretend()`). Gating the transaction on
 * `cfg.dryRun` alone -- as this did originally -- meant that with
 * `launch.simulate: true` and `dryRun: false` a REAL claim was sent and then
 * recorded against the PRETEND ledger: real SOL landed in the wallet but was
 * invisible to `profit`/`headlineStats`, which filter on `mode(cfg)`.
 *
 * That is not hypothetical. It happened once: 0.642662095 SOL claimed for
 * real on 2026-08-27 00:17:00 UTC (signature 5MbmC35h..., verified on-chain)
 * and booked as `dry_run = 1`, which understated net profit by that amount.
 *
 * Exported so a test can assert the two predicates still agree.
 */
export function claimSendsRealTransaction(cfg: Config): boolean {
  return !isPretend(cfg);
}

export async function claimCreatorFees(cfg: Config): Promise<ClaimResult> {
  const conn = getConnection(cfg);
  const wallet = loadWallet(cfg);
  const online = new OnlinePumpSdk(conn);

  const available = await creatorVaultBalanceSol(cfg);

  if (available < cfg.fees.minClaimSol) {
    const skipped =
      `vault holds ${available.toFixed(6)} SOL, below the ${cfg.fees.minClaimSol} SOL ` +
      `minimum; claiming now would cost more in fees than it collects`;
    log.info("creator fee claim skipped", { available, min: cfg.fees.minClaimSol });
    return { claimedSol: 0, skipped, dryRun: isPretend(cfg) };
  }

  if (!claimSendsRealTransaction(cfg)) {
    log.info("PRETEND creator fee claim (no transaction sent)", {
      available, dryRun: cfg.dryRun, simulate: cfg.launch.simulate,
    });
    return { claimedSol: available, dryRun: true };
  }

  const ixs = [
    ...(await computeBudgetIxs(cfg)),
    ...(await online.collectCoinCreatorFeeInstructions(wallet.publicKey)),
  ];

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(cfg.rpc.commitment);
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(),
  );
  tx.sign([wallet]);

  // See chain/rpc.ts withBalanceLock: this window must not overlap a launch's
  // or a sell's own before/after snapshots, or the claim gets folded into
  // whichever one is mid-flight.
  const { before, signature, after } = await withBalanceLock(async () => {
    const b = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, cfg.rpc.commitment);
    const a = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);
    return { before: b, signature: sig, after: a };
  });

  const claimedSol = lamportsToSol(after - before);
  log.info("creator fees claimed", { claimedSol, signature });

  return { claimedSol, signature, dryRun: false };
}
