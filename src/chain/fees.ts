import { TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";
import type { Config } from "../config/schema.ts";
import { getConnection, computeBudgetIxs, lamportsToSol } from "./rpc.ts";
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
    return { claimedSol: 0, skipped, dryRun: cfg.dryRun };
  }

  if (cfg.dryRun) {
    log.info("DRY RUN creator fee claim (no transaction sent)", { available });
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

  const before = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);
  const signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, cfg.rpc.commitment);
  const after = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);

  const claimedSol = lamportsToSol(after - before);
  log.info("creator fees claimed", { claimedSol, signature });

  return { claimedSol, signature, dryRun: false };
}
