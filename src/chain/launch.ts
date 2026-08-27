import {
  Keypair, PublicKey, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  PumpSdk, OnlinePumpSdk, newBondingCurve, getBuyTokenAmountFromSolAmount,
} from "@pump-fun/pump-sdk";

/**
 * Solana's hard packet limit. A transaction that exceeds this cannot be sent at
 * any price, and web3.js reports it as an opaque "encoding overruns
 * Uint8Array" from deep inside buffer-layout -- so we check it ourselves and
 * say something useful instead.
 */
const MAX_TX_BYTES = 1232;
import BN from "bn.js";
import type { Config } from "../config/schema.ts";
import {
  getConnection, computeBudgetIxs, solToLamports, maxPriorityFeeCostSol, withBalanceLock,
} from "./rpc.ts";
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
  /**
   * Pre-generated mint keypair (e.g. vanity-ground by `grindMintKeypair`).
   * Falls back to a fresh random keypair when omitted -- every existing
   * caller leaves this unset, so behaviour is unchanged for them.
   */
  mintKeypair?: Keypair;
};

export type LaunchResult = {
  mint: string;
  signature?: string;
  devBuySol: number;
  /** Base units of the token received by the dev buy. */
  tokensReceived: string;
  /**
   * Measured wallet delta for the whole launch, when known.
   *
   * The ledger otherwise books an *estimate* of the create cost, which
   * understated real spend by the base transaction fee -- a devnet launch
   * recorded -0.075000 against an actual -0.075112. Small, but a ledger that
   * drifts is a ledger you cannot reconcile.
   */
  actualCostSol?: number;
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
    const mintKp = req.mintKeypair ?? Keypair.generate();
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

  const mintKp = req.mintKeypair ?? Keypair.generate();
  const mint = mintKp.publicKey;

  // Price the dev buy against a fresh curve: the token does not exist yet, so
  // there is no on-chain bonding curve to read.
  const global = await online.fetchGlobal();
  const feeConfig = await online.fetchFeeConfig().catch(() => null);
  if (cfg.launch.cashback) {
    // Cashback is a v2-create feature, and the v2 create+buy bundle does not
    // fit in a packet (see the note on the instruction choice below).
    throw new Error(
      "launch.cashback requires the v2 create path, which cannot fit in a single " +
      "transaction alongside the dev buy. Disable cashback, or implement an " +
      "address lookup table first.",
    );
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

  // Instruction choice is forced by the packet limit, not by preference.
  // Measured on devnet against the real program, worst case (32-char name,
  // 8-char symbol, Pinata CIDv1 URI), including compute-budget instructions:
  //
  //   createV2AndBuyV2   33 accounts  -> does not serialise at all
  //   createV2AndBuy     25 accounts  -> 1283 bytes, over the 1232 limit
  //   createAndBuy (v1)  23 accounts  -> 1215 bytes, fits with ~17 to spare
  //
  // So v1 it is. The proper fix for the v2 path is an address lookup table,
  // which would compress those account references from 32 bytes to 1.
  const ixs = [
    ...(await computeBudgetIxs(cfg)),
    ...(await sdk.createAndBuyInstructions({
      global,
      mint,
      name: req.name,
      symbol: req.symbol,
      uri: req.uri,
      creator: wallet.publicKey,
      user: wallet.publicKey,
      amount: expectedTokens,
      solAmount: quoteLamports,
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

  // Fail loudly and early rather than with a buffer-layout stack trace.
  const txBytes = tx.serialize().length;
  if (txBytes > MAX_TX_BYTES) {
    throw new Error(
      `transaction is ${txBytes} bytes, over Solana's ${MAX_TX_BYTES} limit. ` +
      `Shorten the metadata URI or the token name, or add an address lookup table.`,
    );
  }
  log.debug("launch transaction built", { bytes: txBytes, headroom: MAX_TX_BYTES - txBytes });

  if (cfg.launch.simulate) {
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: cfg.rpc.commitment,
    });
    const err = sim.value.err;
    log.info("SIMULATED launch (nothing sent, no lamports moved)", {
      mint: mint.toBase58(), symbol: req.symbol,
      unitsConsumed: sim.value.unitsConsumed,
      err: err ? JSON.stringify(err) : null,
      logs: (sim.value.logs ?? []).slice(-12),
    });
    if (err) {
      throw new Error(
        `simulation failed: ${JSON.stringify(err)} :: ` +
        (sim.value.logs ?? []).slice(-4).join(" | "),
      );
    }
    return {
      mint: mint.toBase58(),
      devBuySol: req.devBuySol,
      tokensReceived: expectedTokens.toString(),
      dryRun: true,
    };
  }

  // The balance snapshots must bracket nothing but this transaction. Holding
  // the lock across send+confirm keeps a concurrent fee claim or position
  // sell -- which run on the independent position-exit poll -- from landing
  // inside this window and corrupting the measured cost.
  const { balanceBefore, signature, balanceAfter } = await withBalanceLock(async () => {
    const before = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);
    const sig = await conn.sendTransaction(tx, {
      skipPreflight: false,
      maxRetries: 3,
    });
    await conn.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      cfg.rpc.commitment,
    );
    const after = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);
    return { balanceBefore: before, signature: sig, balanceAfter: after };
  });

  const actualCostSol = (balanceBefore - balanceAfter) / 1e9;

  log.info("token launched", {
    mint: mint.toBase58(), symbol: req.symbol, signature,
    devBuySol: req.devBuySol, actualCostSol,
  });

  return {
    mint: mint.toBase58(),
    signature,
    devBuySol: req.devBuySol,
    tokensReceived: expectedTokens.toString(),
    actualCostSol,
    dryRun: false,
  };
}

