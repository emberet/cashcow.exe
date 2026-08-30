import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { PumpSdk, OnlinePumpSdk, getSellSolAmountFromTokenAmount } from "@pump-fun/pump-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import type { Config } from "../config/schema.ts";
import { getConnection, computeBudgetIxs, lamportsToSol, withBalanceLock } from "./rpc.ts";
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

/**
 * Error for "the balance could not be READ", as distinct from "the balance is
 * zero". The catch-all that used to collapse both into BN(0) cost real money:
 * three positions were written off as no_balance during a 30-second RPC blip
 * while the wallet held 1.76M tokens of each the whole time -- verified
 * on-chain afterwards. Zero is a fact about the account; a failed read is a
 * fact about the network, and only the first may drive an exit decision.
 * See DECISIONS #43.
 */
export class BalanceUnavailableError extends Error {
  constructor(mint: string, cause: unknown) {
    super(`token balance for ${mint} could not be read: ${String(cause).slice(0, 160)}`);
    this.name = "BalanceUnavailableError";
  }
}

/** The RPC's way of saying the ATA legitimately does not exist. */
function isAccountNotFound(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e).toLowerCase();
  return msg.includes("could not find account") || msg.includes("invalid param");
}

/**
 * Base units of `mint` currently held by the dev wallet.
 *
 * Returns BN(0) ONLY when the RPC affirmatively reports the account absent --
 * an account that was never created or was closed after emptying. Every other
 * failure (timeout, 429, transport error) throws BalanceUnavailableError so
 * the caller can retry later instead of mistaking an outage for an empty
 * wallet.
 */
export async function tokenBalance(cfg: Config, mint: string): Promise<BN> {
  const conn = getConnection(cfg);
  const wallet = loadWallet(cfg);
  const ata = getAssociatedTokenAddressSync(new PublicKey(mint), wallet.publicKey, true);
  try {
    const res = await conn.getTokenAccountBalance(ata, cfg.rpc.commitment);
    return new BN(res.value.amount);
  } catch (e) {
    if (isAccountNotFound(e)) return new BN(0); // affirmatively absent
    throw new BalanceUnavailableError(mint, e);
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

/**
 * Thrown instead of selling a mint on `devPosition.neverSellMints`.
 *
 * A distinct type so callers can tell "refused on purpose" apart from "the
 * sale failed" -- the two deserve different handling, and conflating them
 * would let a protected mint look like a transient RPC problem worth
 * retrying.
 */
export class ProtectedMintError extends Error {
  readonly mint: string;
  constructor(mint: string) {
    super(`refusing to sell ${mint}: listed in devPosition.neverSellMints`);
    this.name = "ProtectedMintError";
    this.mint = mint;
  }
}

/** Is this mint one the operator has said must never be sold? */
export function isProtectedMint(cfg: Config, mint: string): boolean {
  return cfg.devPosition.neverSellMints.includes(mint);
}

/**
 * Sell the entire dev position in `mint`.
 *
 * Every sale in the codebase routes through here -- the automated exit loop
 * (positions/manager.ts) and the admin force-sell command (web/commands.ts)
 * alike -- which is why the never-sell check lives at the top of this
 * function rather than at either call site. Same reasoning as invariant 1:
 * a single choke point is the only kind of guarantee worth having.
 */
export async function sellAll(cfg: Config, mint: string, slippagePct: number): Promise<SellResult> {
  if (isProtectedMint(cfg, mint)) throw new ProtectedMintError(mint);

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

  // See chain/rpc.ts withBalanceLock: this window must not overlap a launch's
  // or a fee claim's own before/after snapshots, run from the independent
  // launch loop and admin command queue, or their balance change gets folded
  // into this sell's measured proceeds.
  const { before, signature, after } = await withBalanceLock(async () => {
    const b = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, cfg.rpc.commitment);
    const a = await conn.getBalance(wallet.publicKey, cfg.rpc.commitment);
    return { before: b, signature: sig, after: a };
  });

  // Measured, not estimated: this figure feeds the P&L ledger, and the ledger
  // is reconciled against the real wallet balance during live verification.
  const solReceived = lamportsToSol(after - before);

  log.info("dev position sold", {
    mint, signature, tokens: tokens.toString(), solReceived,
  });

  return { signature, tokensSold: tokens.toString(), solReceived, dryRun: false };
}
