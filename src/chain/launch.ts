import {
  Keypair, PublicKey, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  PumpSdk, OnlinePumpSdk, newBondingCurve, getBuyTokenAmountFromSolAmount,
} from "@pump-fun/pump-sdk";
import BN from "bn.js";
import type { Config } from "../config/schema.ts";
import { getConnection, computeBudgetIxs, solToLamports, maxPriorityFeeCostSol } from "./rpc.ts";
import { loadWallet } from "./wallet.ts";
import { log } from "../util/log.ts";

/** Wrapped SOL mint: the default quote asset on the bonding curve. */
export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/**
 * Token creation, with the dev buy bundled into the same transaction.
 *
 * The bundling is not an optimisation -- it is the point. A create followed by
 * a separate buy leaves a window in which snipers front-run the creator into
 * their own token, so the dev buy lands at a materially worse price than
 * intended. One atomic transaction closes that window.
 */

export type LaunchRequest = {
  name: string;
  symbol: string;
  uri: string;
  /** Dev buy size in SOL. Zero launches with no dev position at all. */
  devBuySol: number;
  slippagePct: number;
};

export type LaunchResult = {
  mint: string;
  signature?: string;
  devBuySol: number;
  /** Base units of the token received by the dev buy. */
  tokensReceived: string;
  dryRun: boolean;
};

/** Everything a create can cost, estimated high for the budget guard. */
export function estimateLaunchCostSol(cfg: Config, devBuySol: number): number {
  return cfg.launch.estimatedCreateCostSol + devBuySol + maxPriorityFeeCostSol(cfg) + 0.001;
}

export async function launchToken(cfg: Config, req: LaunchRequest): Promise<LaunchResult> {
  // Short-circuit before any RPC call. pump.fun is not deployed on devnet, so
  // on the default config a dry run cannot read real bonding-curve state --
  // and pretending otherwise would make the dry run look like it validated the
  // chain path when it did not. What a dry run proves is the signal pipeline:
  // feeds, scoring, filters, saturation, naming and metadata. The chain path is
  // proven separately against a local validator running the cloned program.
  if (cfg.dryRun) {
    const mintKp = Keypair.generate();
    log.info("DRY RUN launch (no transaction, no chain state read)", {
      mint: mintKp.publicKey.toBase58(),
      name: req.name, symbol: req.symbol, uri: req.uri,
      devBuySol: req.devBuySol, cashback: cfg.launch.cashback,
    });
    return {
      mint: mintKp.publicKey.toBase58(),
      devBuySol: req.devBuySol,
      tokensReceived: "0",
      dryRun: true,
    };
  }

  const conn = getConnection(cfg);
  const wallet = loadWallet(cfg);
  const sdk = new PumpSdk();
  const online = new OnlinePumpSdk(conn);

  const mintKp = Keypair.generate();
  const mint = mintKp.publicKey;

  // Price the dev buy against a fresh curve: the token does not exist yet, so
  // there is no on-chain bonding curve to read.
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig().catch(() => null);
  if (!global.createV2Enabled) {
    throw new Error(
      "pump.fun global config reports createV2Enabled=false; the v2 create path is " +
      "disabled on-chain right now. Refusing to launch rather than burning fees on a " +
      "transaction that will fail.",
    );
  }
  if (cfg.launch.cashback && !global.isCashbackEnabled) {
    throw new Error("launch.cashback is set but cashback coins are disabled on-chain");
  }

  const quoteLamports = new BN(solToLamports(req.devBuySol));

  const expectedTokens = req.devBuySol > 0
    ? getBuyTokenAmountFromSolAmount({
        global,
        feeConfig,
        mintSupply: null,
        bondingCurve: newBondingCurve(global),
        amount: quoteLamports,
        quoteMint: NATIVE_MINT,
      })
    : new BN(0);

  const ixs = [
    ...(await computeBudgetIxs(cfg)),
    ...(await sdk.createV2AndBuyV2Instructions({
      global,
      mint,
      name: req.name,
      symbol: req.symbol,
      uri: req.uri,
      creator: wallet.publicKey,
      user: wallet.publicKey,
      amount: expectedTokens,
      quoteAmount: quoteLamports,
      mayhemMode: cfg.launch.mayhemMode,
      // Permanent per-token decision; false keeps fees with the creator.
      cashback: cfg.launch.cashback,
    })),
  ];

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(cfg.rpc.commitment);
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(),
  );

  // Both signatures are required: the mint account is being created.
  tx.sign([wallet, mintKp]);

  const signature = await conn.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  await conn.confirmTransaction(
    { signature, blockhash, lastValidBlockHeight },
    cfg.rpc.commitment,
  );

  log.info("token launched", {
    mint: mint.toBase58(), symbol: req.symbol, signature, devBuySol: req.devBuySol,
  });

  return {
    mint: mint.toBase58(),
    signature,
    devBuySol: req.devBuySol,
    tokensReceived: expectedTokens.toString(),
    dryRun: false,
  };
}

