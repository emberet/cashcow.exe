import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PumpSdk, OnlinePumpSdk, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import type { Config } from "../config/schema.ts";
import { getConnection, computeBudgetIxs, lamportsToSol } from "./rpc.ts";
import { loadWallet } from "./wallet.ts";
import { log } from "../util/log.ts";

/**
 * Selling a dev position, and valuing one that is still open.
 *
 * Valuation deliberately asks "what would this fetch if sold right now",
 * priced through the bonding curve including fees and slippage, rather than
 * reading a quoted market cap. Exit rules that trigger on a headline price the
 * position cannot actually realise are worse than no exit rules.
 */

export type Valuation = {
  tokens: string;
  solIfSoldNow: number;
  /** Ratio against entry cost: 1.0 is break-even before fees. */
  multiple: number;
};

/** Base units of `mint` currently held by the dev wallet. */
export async function tokenBalance(cfg: Config, mint: string): Promise<BN> {
  const conn = getConnection(cfg);
  const wallet = loadWallet(cfg);
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey, true);
  try {
    const res = await conn.getTokenAccountBalance(ata, cfg.rpc.commitment);
    return new BN(res.value.amount);
  } catch {
    return new BN(0); // no account yet, or already emptied
  }
}

/** What the position would realise if sold at this instant. */
export async function valuePosition(
  cfg: Config, mint: string, entrySol: number, tokensOverride?: BN,
): Promise<Valuation> {
  const conn = getConnection(cfg);
  const online = new OnlinePumpSdk(conn);

  const tokens = tokensOverride ?? await tokenBalance(cfg, mint);
  if (tokens.isZero()) return { tokens: "0", solIfSoldNow: 0, multiple: 0 };

  const [global, bondingCurve, feeConfig] = await Promise.all([
    online.fetchGlobal(),
    online.fetchBondingCurve(mint),
    online.fetchFeeConfig().catch(() => null),
  ]);

  const mintSupply = bondingCurve.tokenTotalSupply ?? global.tokenTotalSupply;
  const lamports = getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply, bondingCurve, amount: tokens,
  });

  const sol = lamportsToSol(lamports.toNumber());
  return {
    tokens: tokens.toString(),
    solIfSoldNow: sol,
    multiple: entrySol > 0 ? sol / entrySol : 0,
  };
}

export type SellResult = {
  signature?: string;
  tokensSold: string;
  solReceived: number;
  dryRun: boolean;
};

/** Sell the entire dev position in `mint`. */
export async function sellAll(cfg: Config, mint: string, slippagePct: number): Promise<SellResult> {
  const conn = getConnection(cfg);
  const wallet = loadWallet(cfg);
  const sdk = new PumpSdk();
  const online = new OnlinePumpSdk(conn);

  const tokens = await tokenBalance(cfg, mint);
  if (tokens.isZero()) {
    return { tokensSold: "0", solReceived: 0, dryRun: cfg.dryRun };
  }

  const mintPk = new PublicKey(mint);
  const [global, feeConfig, sellState] = await Promise.all([
    online.fetchGlobal(),
    online.fetchFeeConfig().catch(() => null),
    online.fetchSellState(mintPk, wallet.publicKey),
  ]);

  const mintSupply = sellState.bondingCurve.tokenTotalSupply ?? global.tokenTotalSupply;
  const expectedLamports = getSellSolAmountFromTokenAmount({
    global, feeConfig, mintSupply,
    bondingCurve: sellState.bondingCurve,
    amount: tokens,
  });

  if (cfg.dryRun) {
    log.info("DRY RUN sell (no transaction sent)", {
      mint, tokens: tokens.toString(), expectedSol: lamportsToSol(expectedLamports.toNumber()),
    });
    return {
      tokensSold: tokens.toString(),
      solReceived: lamportsToSol(expectedLamports.toNumber()),
      dryRun: true,
    };
  }

  // MUST match the create path. The token is created with the v1 `createAndBuy`
  // (see chain/launch.ts on why v2 cannot fit in a packet), and `sellV2` expects
  // an `associated_base_bonding_curve` account that the v1 create never
  // initialises. Mixing them fails on-chain with AnchorError 3012
  // (AccountNotInitialized) -- caught on a real devnet sell, not in any test.
  const ixs = [
    ...(await computeBudgetIxs(cfg)),
    ...(await sdk.sellInstructions({
      global,
      bondingCurveAccountInfo: sellState.bondingCurveAccountInfo,
      bondingCurve: sellState.bondingCurve,
      mint: mintPk,
      user: wallet.publicKey,
      amount: tokens,
      solAmount: expectedLamports,
      slippage: slippagePct,
      tokenProgram: TOKEN_PROGRAM_ID,
      mayhemMode: cfg.launch.mayhemMode,
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
  tx.sign([wallet]);

  const before = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);
  const signature = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, cfg.rpc.commitment);
  const after = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);

  // Measured, not estimated: this figure feeds the P&L ledger, and the ledger
  // is reconciled against the real wallet balance during live verification.
  const solReceived = lamportsToSol(after - before);

  log.info("dev position sold", {
    mint, signature, tokens: tokens.toString(), solReceived,
  });

  return { signature, tokensSold: tokens.toString(), solReceived, dryRun: false };
}
