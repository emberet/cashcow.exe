/**
 * Airdrop allocation report -- READ ONLY.
 *
 * Works out who qualifies for a SOL airdrop against a token's holder base and
 * how much each address gets, then writes the numbers out for a human to
 * review and send. It never loads a wallet key and never signs anything: the
 * only writes it performs are to local files.
 *
 * Qualification (both must hold):
 *   - >= `--threshold` tokens NOW, and
 *   - >= `--threshold` tokens `--hours` ago, so someone who bought in this
 *     morning to farm the drop does not qualify.
 *
 * Allocation is pro-rata on tokens held across the qualifying set.
 *
 * Usage:
 *   node scripts/airdrop-allocation.ts \
 *     --mint 67iVaRRQ...pump --keep 1 --threshold 2000000 --hours 6 \
 *     --service-fee 0.05 --out <dir>
 */

import { loadConfig } from "../src/config/load.ts";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

type Args = {
  mint: string; keep: number; threshold: number; hours: number;
  serviceFee: number; out: string; sender: string;
};

function parseArgs(argv: string[]): Args {
  const get = (k: string) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (k: string, d?: number) => {
    const v = get(k);
    if (v === undefined) {
      if (d === undefined) throw new Error(`--${k} is required`);
      return d;
    }
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${k} must be a number, got "${v}"`);
    return n;
  };
  const mint = get("mint");
  if (!mint) throw new Error("--mint is required");
  const sender = get("sender");
  if (!sender) throw new Error("--sender is required (the paying wallet, excluded from the drop)");

  // No default: a fee reserve that is too small can make the last transfer
  // fail, so this is a decision the operator makes explicitly.
  const serviceFee = num("service-fee");

  return {
    mint, sender,
    keep: num("keep", 1),
    threshold: num("threshold", 2_000_000),
    hours: num("hours", 6),
    serviceFee,
    out: get("out") ?? ".",
  };
}

// ---------------------------------------------------------------- rpc

let RPC = "";
let rpcCalls = 0;

async function rpc<T>(method: string, params: unknown): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt++) {
    rpcCalls++;
    const res = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
    });
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
      continue;
    }
    const json = await res.json() as { result?: T; error?: unknown };
    if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error).slice(0, 200)}`);
    return json.result as T;
  }
  throw new Error(`${method}: gave up after retries`);
}

/** Bounded concurrency -- Helius is fine with this, a public RPC would not be. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

// ---------------------------------------------------------------- types

type Holder = {
  owner: string;
  tokenAccount: string;
  tokens: number;
  /** Balance at the start of the window, once computed. */
  tokensBefore?: number;
  basis?: string;
  excluded?: string;
  lamports?: number;
  /** Wallet holds no SOL: the transfer must create the account. */
  needsRent?: boolean;
  allocSol?: number;
};

// ---------------------------------------------------------------- main

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  RPC = cfg.rpc.primary;

  const log = (s: string) => process.stdout.write(s + "\n");
  log(`\nAirdrop allocation report (READ ONLY -- nothing is signed or sent)`);
  log(`  mint       ${a.mint}`);
  log(`  sender     ${a.sender}`);
  log(`  threshold  ${a.threshold.toLocaleString()} tokens, held for >= ${a.hours}h`);
  log(`  keep back  ${a.keep} SOL   service fee reserve ${a.serviceFee} SOL\n`);

  // --- supply ---------------------------------------------------------
  const supply = await rpc<{ value: { decimals: number; uiAmount: number } }>(
    "getTokenSupply", [a.mint],
  );
  const decimals = supply.value.decimals;
  const totalSupply = supply.value.uiAmount;
  log(`supply: ${totalSupply.toLocaleString()} (${decimals} decimals)`);

  // --- census: every non-zero token account, aggregated BY OWNER -------
  // A wallet may hold several token accounts for one mint; counting accounts
  // instead of owners would both double-count and pay the same person twice.
  const byOwner = new Map<string, { raw: number; accounts: string[] }>();
  for (let page = 1; page <= 50; page++) {
    const res = await rpc<{ token_accounts?: Array<{ owner: string; address: string; amount: string | number }> }>(
      "getTokenAccounts", { mint: a.mint, page, limit: 1000, options: { showZeroBalance: false } },
    );
    const items = res.token_accounts ?? [];
    for (const t of items) {
      const cur = byOwner.get(t.owner) ?? { raw: 0, accounts: [] };
      cur.raw += Number(t.amount);
      cur.accounts.push(t.address);
      byOwner.set(t.owner, cur);
    }
    if (items.length < 1000) break;
  }

  const ui = (raw: number) => raw / 10 ** decimals;
  const all: Holder[] = [...byOwner.entries()]
    .map(([owner, v]) => ({ owner, tokenAccount: v.accounts[0]!, tokens: ui(v.raw) }))
    .sort((x, y) => y.tokens - x.tokens);

  const censusTotal = all.reduce((s, h) => s + h.tokens, 0);
  log(`owners: ${all.length}   census total: ${censusTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })}` +
      `  (${((censusTotal / totalSupply) * 100).toFixed(2)}% of supply)`);

  // --- candidates at/above the threshold ------------------------------
  const candidates = all.filter((h) => h.tokens >= a.threshold);
  const belowThreshold = all.length - candidates.length;
  log(`\ncandidates >= ${a.threshold.toLocaleString()}: ${candidates.length}  (${belowThreshold} below threshold)`);

  // --- exclude program-owned accounts (AMM pools, bonding curves) ------
  // Detected structurally rather than by hardcoded address, so a future pool
  // is caught too. This is the same class holders.ts excludes by name.
  // getMultipleAccounts takes 100 addresses per call, so this is one or two
  // requests instead of one per candidate -- which rate-limited immediately.
  log(`\nchecking account ownership...`);
  const infos: Array<{ owner?: string; lamports?: number } | null> = [];
  for (let i = 0; i < candidates.length; i += 100) {
    const batch = candidates.slice(i, i + 100).map((h) => h.owner);
    const res = await rpc<{ value: Array<{ owner?: string; lamports?: number } | null> }>(
      "getMultipleAccounts", [batch, { encoding: "jsonParsed" }],
    );
    infos.push(...res.value);
  }

  candidates.forEach((h, i) => {
    const v = infos[i];
    h.lamports = v?.lamports ?? 0;

    // A null account is NOT a disqualification. A wallet that has only ever
    // received tokens can hold millions of them while owning no SOL at all --
    // its token account exists, its system account never had to. Two of these
    // are the 3rd and 4th largest holders (25.9M and 22.6M), so dropping them
    // would have been a serious, silent unfairness. The transfer itself
    // creates the account; it only has to clear the rent-exempt minimum,
    // which is asserted after allocation.
    if (!v) { h.needsRent = true; return; }

    // Program-owned means it is not a wallet: the AMM pool, a bonding curve,
    // or a token account that turned up as an owner. Detected structurally so
    // future pools are caught without hardcoding addresses.
    if (v.owner && v.owner !== SYSTEM_PROGRAM) {
      h.excluded = `program-owned account (${v.owner}) -- pool/curve, not a holder`;
      return;
    }
    if (h.owner === a.sender) h.excluded = "sender wallet -- cannot airdrop to itself";
  });

  // --- the 6h test ----------------------------------------------------
  const cutoff = Math.floor(Date.now() / 1000) - a.hours * 3600;
  const live = candidates.filter((h) => !h.excluded);
  log(`checking ${a.hours}h holding for ${live.length} candidates (cutoff ${new Date(cutoff * 1000).toISOString()})...`);

  await mapLimit(live, 3, async (h) => {
    const sigs = await rpc<Array<{ signature: string; blockTime: number | null }>>(
      "getSignaturesForAddress", [h.tokenAccount, { limit: 200 }],
    );
    const inWindow = sigs.filter((s) => s.blockTime && s.blockTime >= cutoff);

    if (sigs.length === 0) {
      h.excluded = "no transaction history for the token account";
      return;
    }
    if (inWindow.length === 0) {
      // Nothing touched the account inside the window, so the balance now is
      // the balance then.
      h.tokensBefore = h.tokens;
      h.basis = `no activity in ${a.hours}h -- balance unchanged`;
      return;
    }

    // The earliest transaction INSIDE the window: its pre-balance is exactly
    // the balance at the window's start.
    const earliest = inWindow[inWindow.length - 1]!;
    const tx = await rpc<{
      meta?: { preTokenBalances?: Array<{ owner?: string; mint?: string; uiTokenAmount: { uiAmount: number | null } }> };
    } | null>("getTransaction", [earliest.signature, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }]);

    const pre = (tx?.meta?.preTokenBalances ?? [])
      .find((b) => b.owner === h.owner && b.mint === a.mint);
    h.tokensBefore = Number(pre?.uiTokenAmount.uiAmount ?? 0);
    h.basis = `balance ${a.hours}h ago from pre-balance of ${earliest.signature.slice(0, 12)}...`;

    if (h.tokensBefore < a.threshold) {
      h.excluded = `held ${Math.round(h.tokensBefore).toLocaleString()} ${a.hours}h ago, below threshold`;
    }
  });

  const qualifying = candidates.filter((h) => !h.excluded);
  const excluded = candidates.filter((h) => h.excluded);
  const unfunded = qualifying.filter((h) => h.needsRent);
  log(`\nqualifying: ${qualifying.length}   excluded: ${excluded.length}` +
      (unfunded.length ? `   (${unfunded.length} hold no SOL -- the transfer creates their account)` : ""));
  for (const e of excluded) {
    log(`  - ${e.owner.slice(0, 12)}... ${Math.round(e.tokens).toLocaleString().padStart(14)}  ${e.excluded}`);
  }

  // --- the pot --------------------------------------------------------
  const balLamports = await rpc<{ value: number }>("getBalance", [a.sender]).then((r) => r.value);
  const slot = await rpc<number>("getSlot", []);
  const walletSol = balLamports / 1e9;

  const SIGNATURE_FEE = 0.000005;
  const PER_TX_RECIPIENTS = 10;                       // slerf batches; conservative
  const txCount = Math.ceil(qualifying.length / PER_TX_RECIPIENTS);
  const networkFee = txCount * SIGNATURE_FEE;
  const feeReserve = networkFee + a.serviceFee;
  const pot = walletSol - a.keep - feeReserve;

  if (pot <= 0) throw new Error(`nothing to distribute: balance ${walletSol} - keep ${a.keep} - fees ${feeReserve} = ${pot}`);

  const qualTokens = qualifying.reduce((s, h) => s + h.tokens, 0);
  for (const h of qualifying) {
    // Floor to lamports so the sum can never exceed the pot through rounding.
    h.allocSol = Math.floor((pot * (h.tokens / qualTokens)) * 1e9) / 1e9;
  }
  const distributed = qualifying.reduce((s, h) => s + (h.allocSol ?? 0), 0);

  // Recipients whose wallet does not exist yet are created BY this transfer,
  // so their amount has to clear rent-exemption or the transfer fails on
  // chain. At current pot sizes every share is orders of magnitude above it,
  // but that is an accident of arithmetic, not a guarantee -- check it.
  const rentMin = await rpc<number>("getMinimumBalanceForRentExemption", [0]) / 1e9;
  const underRent = qualifying.filter((h) => h.needsRent && (h.allocSol ?? 0) < rentMin);
  if (underRent.length) {
    log(`\nWARNING: ${underRent.length} unfunded recipient(s) allocated below the ` +
        `${rentMin} SOL rent-exempt minimum -- those transfers would fail:`);
    for (const h of underRent) log(`  ${h.owner} ${h.allocSol} SOL`);
  }

  // --- invariants -----------------------------------------------------
  if (distributed > pot + 1e-9) throw new Error(`allocation ${distributed} exceeds pot ${pot}`);
  const spend = distributed + a.keep + feeReserve;
  if (spend > walletSol + 1e-9) throw new Error(`total ${spend} exceeds wallet ${walletSol}`);

  log(`\nwallet     ${walletSol.toFixed(9)} SOL  (slot ${slot})`);
  log(`keep       ${a.keep.toFixed(9)}`);
  log(`fees       ${feeReserve.toFixed(9)}  (network ${networkFee.toFixed(9)} over ~${txCount} tx + service ${a.serviceFee})`);
  log(`POT        ${pot.toFixed(9)}`);
  log(`distributed${distributed.toFixed(9)}   dust ${(pot - distributed).toFixed(9)}`);

  // --- SOL price ------------------------------------------------------
  let solUsd = 0, priceSource = "unavailable";
  try {
    const r = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot");
    const j = await r.json() as { data?: { amount?: string } };
    if (j.data?.amount) { solUsd = Number(j.data.amount); priceSource = "Coinbase spot"; }
  } catch { /* leave unavailable; the sheet says so */ }
  log(`SOL price  ${solUsd ? `$${solUsd} (${priceSource})` : "unavailable"}`);

  // --- outputs --------------------------------------------------------
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");

  const csv = qualifying.map((h) => `${h.owner},${h.allocSol!.toFixed(9)}`).join("\n") + "\n";
  writeFileSync(join(a.out, "airdrop-slerf.csv"), csv);

  writeFileSync(join(a.out, "airdrop-allocation.json"), JSON.stringify({
    generatedAt: new Date().toISOString(),
    mint: a.mint, sender: a.sender, slot,
    threshold: a.threshold, hours: a.hours, cutoffIso: new Date(cutoff * 1000).toISOString(),
    walletSol, keep: a.keep, networkFee, serviceFee: a.serviceFee, feeReserve,
    pot, distributed, dust: pot - distributed,
    solUsd, priceSource, rpcCalls, rentMin,
    unfundedRecipients: unfunded.length,
    totalSupply, censusOwners: all.length, candidates: candidates.length,
    qualifyingTokens: qualTokens,
    qualifying: qualifying.map((h) => ({
      owner: h.owner, tokens: h.tokens, tokensBefore: h.tokensBefore,
      pctOfQualifying: (h.tokens / qualTokens) * 100,
      allocSol: h.allocSol, allocUsd: (h.allocSol ?? 0) * solUsd,
      basis: h.basis, lamports: h.lamports, needsRent: !!h.needsRent,
    })),
    excluded: excluded.map((h) => ({
      owner: h.owner, tokens: h.tokens, tokensBefore: h.tokensBefore, reason: h.excluded,
    })),
    belowThreshold,
  }, null, 2));

  log(`\nwrote airdrop-slerf.csv (${qualifying.length} rows) and airdrop-allocation.json to ${a.out}`);
  log(`rpc calls: ${rpcCalls}\n`);
}

main().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
