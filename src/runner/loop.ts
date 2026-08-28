import type { Keypair } from "@solana/web3.js";
import type { Db } from "../util/db.ts";
import { isPretend, type Config } from "../config/schema.ts";
import { BudgetGuard, BudgetDenied } from "../risk/budget.ts";
import type { KillSwitch } from "../risk/killswitch.ts";
import { pollAll, enabledFeeds } from "../feeds/registry.ts";
import type { FeedContext } from "../feeds/types.ts";
import {
  ingestSignals, buildCandidates, qualifying, pruneSignals, checkWarmup,
  type Candidate,
} from "../scoring/score.ts";
import { compileFilters, checkTerm, checkAll } from "../scoring/filters.ts";
import { checkSaturation, findSelfDuplicate, DuplicateIdentityError } from "../scoring/saturation.ts";
import { pumpFunMarket } from "../chain/market.ts";
import { generateIdentity, RiskyTrendError } from "../assets/naming.ts";
import { renderTokenImage } from "../assets/image.ts";
import { pinTokenMetadata } from "../assets/ipfs.ts";
import { launchToken, estimateLaunchCostSol, type LaunchResult } from "../chain/launch.ts";
import { grindMintKeypairParallel } from "../chain/vanity.ts";
import { availableParallelism } from "node:os";
import { claimCreatorFees } from "../chain/fees.ts";
import { getBalanceSol } from "../chain/rpc.ts";
import { loadWallet, publishWalletAddress } from "../chain/wallet.ts";
import { openPosition } from "../positions/store.ts";
import { evaluateOpenPositions } from "../positions/manager.ts";
import { kvGet, kvSet } from "../util/db.ts";
import { effectiveScoring } from "../risk/experimentalWindow.ts";
import { log, errFields } from "../util/log.ts";
import { sleep, safeHttpUrl } from "../util/http.ts";
import { consumeCommands } from "../web/commands.ts";
import { computeCapacity } from "../risk/capacity.ts";
import { recordLaunch, refreshOutcomes, attributeFees } from "../learning/outcomes.ts";
import { runTuning } from "../learning/tuner.ts";
import { writeOverlay } from "../learning/overlay.ts";

/**
 * The orchestrator.
 *
 * Two independent cadences, because the two jobs have different urgency. Exits
 * are evaluated on a fast tick and run unconditionally -- including while the
 * bot is halted -- so an open position is never stranded by the brake. Launches
 * run on a slower tick and pass through every gate in order, cheapest first:
 * halt, warmup, score, content filters, saturation, then budget. The expensive
 * steps (model call, image render, IPFS pin) only happen once a candidate has
 * cleared everything that can reject it for free.
 */

const LAST_FEE_CLAIM = "lastFeeClaimMs";
const LAST_TUNING = "lastTuningMs";
const LAST_OUTCOME_REFRESH = "lastOutcomeRefreshMs";

/**
 * Stop trying after this many launches fail back to back in one tick.
 *
 * A failure that repeats is almost always systemic -- an unfunded wallet, a
 * dead RPC, a program change -- not something the next candidate will dodge.
 * An unfunded devnet wallet produced 249 consecutive failed attempts before
 * this existed, each one a full model call, image render and RPC round trip.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export type TickStats = {
  candidates: number;
  qualified: number;
  launched: number;
  rejected: Record<string, number>;
};

/** The attrition story for one tick, persisted so the dashboard can show it. */
type Funnel = {
  sniffed: number; phrases: number; terms: number; warm: number;
  scored: number; examined: number; clean: number;
  uncrowded: number; affordable: number; launched: number;
};

function recordDecline(
  db: Db, cfg: Config,
  a: { term: string; norm: string; reason: string; detail: string; score: number },
): void {
  db.prepare(
    `INSERT INTO declined (ts, term, norm, reason, detail, score, dry_run)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(Date.now(), a.term, a.norm, a.reason, a.detail.slice(0, 200), a.score, isPretend(cfg) ? 1 : 0);
}

function recordFunnel(db: Db, cfg: Config, f: Funnel): void {
  db.prepare(
    `INSERT INTO pipeline_stats
       (ts, sniffed, phrases, terms, warm, scored, examined, clean, uncrowded, affordable, launched, dry_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(), f.sniffed, f.phrases, f.terms, f.warm, f.scored, f.examined,
    f.clean, f.uncrowded, f.affordable, f.launched, isPretend(cfg) ? 1 : 0,
  );
}

export async function runLoop(
  db: Db, cfg: Config, budget: BudgetGuard, kill: KillSwitch,
): Promise<void> {
  const ctx: FeedContext = { cfg, budget };
  let stopping = false;

  kill.installSignalHandlers(() => { stopping = true; });

  // Publish the address for the dashboard. This process is the one that is
  // allowed to hold the key, so it is the one that resolves the address --
  // the web process reads it from the database and never loads the secret
  // itself (invariant 4). No-op when no real wallet is configured.
  publishWalletAddress(db, cfg);

  log.info("cashcow.exe started", {
    mode: cfg.dryRun ? "DRY RUN (no transactions)" : "LIVE",
    network: cfg.network,
    feeds: enabledFeeds(cfg).map((f) => f.adapter.id),
    capacityMode: cfg.risk.adaptive.enabled ? "adaptive (wallet-derived)" : "static",
    maxLaunchesPerDay: cfg.risk.maxLaunchesPerDay,
    maxSolPerDay: cfg.risk.maxSolPerDay,
    learning: cfg.learning.enabled
      ? (cfg.learning.autoApply ? "on (auto-apply)" : "on (propose only)")
      : "off",
    devBuySol: cfg.devPosition.enabled ? cfg.devPosition.buySol : 0,
  });

  // Exits: fast, and never gated on the kill switch. Queued admin commands are
  // drained on the same tick, so a force-sell from the dashboard lands within
  // one exit interval without the web process ever touching the wallet key.
  const positionTimer = setInterval(() => {
    void (async () => {
      await consumeCommands(db, cfg, budget);
      await evaluateOpenPositions(db, cfg, budget);
    })().catch((e) => log.error("position tick failed", errFields(e)));
  }, cfg.devPosition.exit.pollSeconds * 1000);

  // Launches: slower, and gated on everything.
  const launchIntervalMs = slowestFeedInterval(cfg) * 1000;

  try {
    while (!stopping) {
      try {
        await launchTick(db, cfg, budget, kill, ctx);
        await maybeClaimFees(db, cfg, budget);
        await maybeTune(db, cfg);
        pruneSignals(db, cfg.scoring.maxSignalAgeMinutes * 60_000 * 4);
      } catch (e) {
        log.error("launch tick failed", errFields(e));
      }
      await sleep(launchIntervalMs);
    }
  } finally {
    clearInterval(positionTimer);
    log.info("draining: evaluating open positions one last time");
    await consumeCommands(db, cfg, budget).catch(() => {});
    await evaluateOpenPositions(db, cfg, budget).catch((e) => {
      log.error("final position drain failed", errFields(e));
    });
  }
}

function slowestFeedInterval(cfg: Config): number {
  const enabled = Object.values(cfg.feeds).filter((f) => f.enabled);
  if (!enabled.length) return 300;
  return Math.min(...enabled.map((f) => f.pollSeconds));
}

export async function launchTick(
  db: Db, cfg: Config, budget: BudgetGuard, kill: KillSwitch, ctx: FeedContext,
): Promise<TickStats> {
  const stats: TickStats = { candidates: 0, qualified: 0, launched: 0, rejected: {} };
  const reject = (why: string) => { stats.rejected[why] = (stats.rejected[why] ?? 0) + 1; };

  // Recompute what the wallet can sustain before anything else. Doing this per
  // tick rather than at startup is the point: capacity tracks the balance as
  // fees arrive and as losses accumulate.
  let capacityBalance: number | undefined;
  if (!cfg.dryRun) {
    capacityBalance = await getBalanceSol(cfg, loadWallet(cfg).publicKey).catch(() => undefined);
  }
  const capacity = computeCapacity(db, cfg, capacityBalance);
  budget.setCapacity(capacity);

  // Keep outcome data current; the tuner is only as good as this. Throttled to
  // its own cadence -- each pending mint is an HTTP round trip, and re-checking
  // every 90s tells us nothing a 5-minute check would not.
  const lastRefresh = Number(kvGet(db, LAST_OUTCOME_REFRESH) ?? 0);
  if (Date.now() - lastRefresh >= cfg.learning.outcomeRefreshMinutes * 60_000) {
    kvSet(db, LAST_OUTCOME_REFRESH, String(Date.now()));
    await refreshOutcomes(db, cfg).catch((e) => log.debug("outcome refresh failed", errFields(e)));
  }

  // Feeds are polled even while halted: the signal history keeps warming, so
  // resuming does not start from a cold start with meaningless velocity.
  const results = await pollAll(ctx);
  const weights = new Map(enabledFeeds(cfg).map(({ adapter, weight }) => [adapter.id, weight]));
  const rawSignals = results.flatMap((r) => r.signals);
  const phraseCount = ingestSignals(db, rawSignals, weights, cfg.scoring);

  // Reads through the 24h experimental window (src/risk/experimentalWindow.ts)
  // when one is active; otherwise identical to cfg.scoring. Every downstream
  // gate in this function (buildCandidates/checkWarmup/qualifying) reads this
  // value, not cfg.scoring, so the window and the base config never disagree
  // mid-tick.
  const scoring = effectiveScoring(db, cfg);

  const candidates = buildCandidates(db, scoring);
  stats.candidates = candidates.length;

  const funnel: Funnel = {
    sniffed: rawSignals.length,
    phrases: phraseCount,
    terms: candidates.length,
    warm: candidates.filter((c) => c.observations >= scoring.minObservations).length,
    scored: 0, examined: 0, clean: 0, uncrowded: 0, affordable: 0, launched: 0,
  };

  if (!kill.allowsNewLaunches()) {
    log.info("halted: skipping launches", { reason: kill.haltReason(), candidates: candidates.length });
    recordFunnel(db, cfg, funnel);
    return stats;
  }

  const warm = checkWarmup(db, scoring);
  if (!warm.warm) {
    log.info("warming up", { spanMinutes: warm.spanMinutes.toFixed(1), reason: warm.reason });
    recordFunnel(db, cfg, funnel);
    return stats;
  }

  const passing = qualifying(candidates, scoring);
  stats.qualified = passing.length;
  funnel.scored = passing.length;
  if (!passing.length) {
    recordFunnel(db, cfg, funnel);
    log.debug("no candidate cleared the threshold", {
      candidates: candidates.length, threshold: scoring.threshold,
      best: candidates[0]?.score.toFixed(1),
    });
    return stats;
  }

  const filters = compileFilters(cfg.filters);
  let consecutiveFailures = 0;

  for (const candidate of passing) {
    if (!kill.allowsNewLaunches()) break;
    funnel.examined++;

    // --- free rejections first -------------------------------------------
    const contentCheck = checkTerm(candidate.term, filters);
    if (!contentCheck.allowed) {
      log.info("candidate rejected by filter", { term: candidate.term, reason: contentCheck.reason });
      reject(contentCheck.category);
      recordDecline(db, cfg, {
        term: candidate.term, norm: candidate.key, score: candidate.score,
        reason: contentCheck.category, detail: contentCheck.reason,
      });
      continue;
    }
    funnel.clean++;

    const saturation = await checkSaturation(
      db, candidate.term, undefined, cfg.saturation, pumpFunMarket,
    );
    if (saturation.saturated) {
      log.info("candidate saturated, skipping", { term: candidate.term, reason: saturation.reason });
      reject("saturated");
      recordDecline(db, cfg, {
        term: candidate.term, norm: candidate.key, score: candidate.score,
        reason: "crowded", detail: saturation.reason ?? "",
      });
      continue;
    }
    funnel.uncrowded++;

    // --- budget, before anything expensive --------------------------------
    const devBuySol = cfg.devPosition.enabled ? cfg.devPosition.buySol : 0;
    const estimate = estimateLaunchCostSol(cfg, devBuySol);

    let walletBalanceSol: number | undefined;
    // Only a real send can breach the wallet floor; a simulation moves nothing.
    if (!isPretend(cfg)) {
      walletBalanceSol = await getBalanceSol(cfg, loadWallet(cfg).publicKey);
    }

    const allowed = budget.canSpend(estimate, {
      isLaunch: true,
      opensPosition: devBuySol > 0,
      walletBalanceSol,
    });
    if (!allowed.ok) {
      log.info("launch denied by budget", { term: candidate.term, code: allowed.code, reason: allowed.reason });
      reject(`budget:${allowed.code}`);
      recordDecline(db, cfg, {
        term: candidate.term, norm: candidate.key, score: candidate.score,
        reason: "budget", detail: allowed.reason,
      });
      // Daily caps will not clear within this tick; stop trying.
      break;
    }
    funnel.affordable++;

    try {
      await launchCandidate(db, cfg, budget, candidate, filters, estimate);
      stats.launched++;
      funnel.launched++;
      consecutiveFailures = 0;
    } catch (e) {
      if (e instanceof RiskyTrendError) {
        log.info("candidate rejected by risk screen", { term: candidate.term, reason: e.message });
        reject(`risk:${e.category}`);
        recordDecline(db, cfg, {
          term: candidate.term, norm: candidate.key, score: candidate.score,
          reason: e.category, detail: e.message,
        });
        continue;
      }
      if (e instanceof DuplicateIdentityError) {
        log.info("generated identity duplicates a recent launch, skipping", {
          term: candidate.term, detail: e.detail,
        });
        reject("duplicate");
        recordDecline(db, cfg, {
          term: candidate.term, norm: candidate.key, score: candidate.score,
          reason: "duplicate", detail: e.detail,
        });
        continue;
      }
      if (e instanceof BudgetDenied) {
        log.warn("launch denied at execution time", { term: candidate.term, code: e.code });
        reject(`budget:${e.code}`);
        break;
      }
      log.error("launch failed", { term: candidate.term, ...errFields(e) });
      reject("error");

      if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.error(
          "too many consecutive launch failures; abandoning this tick. " +
          "Repeated failures are systemic, not candidate-specific -- check the " +
          "wallet balance, the RPC, and whether the pump.fun program changed.",
          { failures: consecutiveFailures, lastTerm: candidate.term },
        );
        reject("aborted:consecutive_failures");
        break;
      }
    }
  }

  recordFunnel(db, cfg, funnel);
  return stats;
}

async function launchCandidate(
  db: Db,
  cfg: Config,
  budget: BudgetGuard,
  candidate: Candidate,
  filters: ReturnType<typeof compileFilters>,
  estimate: number,
): Promise<void> {
  const identity = await generateIdentity(cfg, candidate, filters);

  // Re-check the generated identity: a clean trend can still yield a dirty name.
  const check = checkAll([identity.name, identity.symbol, identity.description], filters);
  if (!check.allowed) {
    throw new Error(`generated identity rejected: ${check.reason}`);
  }

  // ...and a trend that looked distinct can still be renamed into a collision:
  // "Fed Rate Decision" and "FOMC Meeting" are unlike each other as terms, and
  // both plausibly mint as "MoneyPrinter". The gate upstream only saw the term
  // and had no symbol to compare, so this is the first point the real name and
  // ticker exist. Cheaper than the render and pin that follow.
  const nameDupe = findSelfDuplicate(db, identity.name, identity.symbol, cfg.saturation);
  if (nameDupe) {
    const agoH = ((Date.now() - nameDupe.createdAt) / 3600_000).toFixed(1);
    throw new DuplicateIdentityError(
      `"${identity.name}" (${identity.symbol}) matches ` +
      `${nameDupe.symbol || nameDupe.name} launched ${agoH}h ago ` +
      `on ${nameDupe.matchedOn}, similarity ${nameDupe.score.toFixed(2)}`,
    );
  }

  const image = await renderTokenImage(cfg, identity, candidate.term, budget);
  const pinned = await pinTokenMetadata(cfg, identity, image);

  const devBuySol = cfg.devPosition.enabled ? cfg.devPosition.buySol : 0;

  // Last gate before money moves.
  budget.assertCanSpend(estimate, { isLaunch: true, opensPosition: devBuySol > 0 });

  let mintKeypair: Keypair | undefined;
  if (cfg.launch.vanitySuffix) {
    // Spread the grind across every available core rather than the caller's
    // single thread -- see src/chain/vanity.ts for why this isn't optional
    // for anything longer than a 1-2 char suffix.
    const workers = cfg.launch.vanityWorkers ?? availableParallelism();
    const ground = await grindMintKeypairParallel(
      cfg.launch.vanitySuffix, cfg.launch.vanityTimeoutMs, workers,
    );
    if (ground) {
      log.info("vanity mint address found", {
        suffix: cfg.launch.vanitySuffix, attempts: ground.attempts, ms: ground.ms,
        mint: ground.keypair.publicKey.toBase58(),
      });
      mintKeypair = ground.keypair;
    } else {
      log.warn("vanity grind timed out, using a random address", {
        suffix: cfg.launch.vanitySuffix, timeoutMs: cfg.launch.vanityTimeoutMs,
      });
    }
  }

  const result = await launchToken(cfg, {
    name: identity.name,
    symbol: identity.symbol,
    uri: pinned.uri,
    devBuySol,
    slippagePct: cfg.devPosition.buySlippagePct,
    mintKeypair,
  });

  db.prepare(
    `INSERT INTO launches (mint, term, norm, name, symbol, uri, score, feeds,
                           created_at, signature, dry_run, status, source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'created', ?)`,
  ).run(
    result.mint, candidate.term, candidate.key, identity.name, identity.symbol,
    pinned.uri, candidate.score, JSON.stringify(candidate.feeds),
    Date.now(), result.signature ?? null, isPretend(cfg) ? 1 : 0,
    safeHttpUrl(candidate.sampleUrl),
  );

  const { solDelta: launchCost, measured } = resolveLaunchCost(cfg, result, devBuySol);

  budget.record({
    kind: "launch",
    solDelta: -launchCost,
    mint: result.mint,
    signature: result.signature,
    note: `${identity.symbol} <- "${candidate.term}"` + (measured ? " (measured)" : " (estimated)"),
  });

  if (devBuySol > 0) {
    budget.record({ kind: "dev_buy", solDelta: -devBuySol, mint: result.mint, signature: result.signature });
    openPosition(db, {
      mint: result.mint,
      symbol: identity.symbol,
      entrySol: devBuySol,
      entryTokens: result.tokensReceived,
      signature: result.signature,
      dryRun: isPretend(cfg),
    });
  }

  recordLaunch(db, {
    mint: result.mint,
    term: candidate.term,
    symbol: identity.symbol,
    score: candidate.score,
    components: candidate.components as unknown as Record<string, number>,
    feeds: candidate.feeds,
    families: candidate.families,
    namingSource: identity.source,
    entrySol: devBuySol,
    dryRun: isPretend(cfg),
  });

  log.info("LAUNCHED", {
    mint: result.mint, name: identity.name, symbol: identity.symbol,
    term: candidate.term, score: candidate.score.toFixed(1),
    feeds: candidate.feeds, devBuySol, naming: identity.source, art: image.theme,
    url: `https://pump.fun/coin/${result.mint}`,
    dryRun: result.dryRun,
  });
}

/**
 * What to book against spend_ledger for the "launch" row.
 *
 * Prefers the measured wallet delta over the estimate, so the ledger
 * reconciles against the chain instead of drifting by the transaction fee.
 * But a measured cost can only ever be non-negative -- create-and-buy cannot
 * hand money back -- so a negative reading is not "spent nothing", it is
 * proof the balance snapshot in chain/launch.ts overlapped a concurrent
 * inflow (a creator-fee claim or a position sell landing mid-window). The old
 * `Math.max(0, ...)` floor silently turned that corruption into a booked
 * launch cost of exactly 0. chain/rpc.ts's withBalanceLock now serializes
 * those windows so this should no longer happen in practice; this is the
 * belt to that braces -- fail loud and fall back to the estimate rather than
 * silently under-counting the day's spend against `risk.maxSolPerDay`.
 */
export function resolveLaunchCost(
  cfg: Config, result: LaunchResult, devBuySol: number,
): { solDelta: number; measured: boolean } {
  if (result.actualCostSol === undefined) {
    return { solDelta: cfg.launch.estimatedCreateCostSol, measured: false };
  }

  const measuredSol = result.actualCostSol - devBuySol;
  if (measuredSol < 0) {
    log.warn(
      "measured launch cost came back negative -- a concurrent balance change likely " +
      "landed inside the balance snapshot window; falling back to the estimate instead " +
      "of flooring the ledger to 0",
      {
        mint: result.mint, actualCostSol: result.actualCostSol, devBuySol, measuredSol,
        fallbackSol: cfg.launch.estimatedCreateCostSol,
      },
    );
    return { solDelta: cfg.launch.estimatedCreateCostSol, measured: false };
  }

  return { solDelta: measuredSol, measured: true };
}

async function maybeTune(db: Db, cfg: Config): Promise<void> {
  if (!cfg.learning.enabled) return;

  const last = Number(kvGet(db, LAST_TUNING) ?? 0);
  if (Date.now() < last + cfg.learning.intervalHours * 3600_000) return;

  try {
    const run = await runTuning(db, cfg);
    kvSet(db, LAST_TUNING, String(Date.now()));

    if (!run.ran) {
      log.info("tuning skipped", { reason: run.reason });
      return;
    }
    if (run.applied && run.result) {
      writeOverlay(run.result.overlay);
      log.warn("tuning applied -- selection criteria changed", {
        changes: run.result.accepted,
        rationale: run.rationale,
        note: "restart to pick up the new values",
      });
    } else if (run.result?.accepted.length) {
      log.info("tuning proposed changes (autoApply off, not applied)", {
        changes: run.result.accepted, rationale: run.rationale,
      });
    }
  } catch (e) {
    log.warn("tuning run failed", errFields(e));
  }
}

async function maybeClaimFees(db: Db, cfg: Config, budget: BudgetGuard): Promise<void> {
  if (!cfg.fees.enabled) return;

  const last = Number(kvGet(db, LAST_FEE_CLAIM) ?? 0);
  const dueAt = last + cfg.fees.claimIntervalMinutes * 60_000;
  if (Date.now() < dueAt) return;

  try {
    const result = await claimCreatorFees(cfg);
    kvSet(db, LAST_FEE_CLAIM, String(Date.now()));

    if (result.claimedSol > 0 && !result.skipped) {
      db.prepare(
        `INSERT INTO fee_claims (ts, sol_amount, signature, dry_run) VALUES (?, ?, ?, ?)`,
      ).run(Date.now(), result.claimedSol, result.signature ?? null, isPretend(cfg) ? 1 : 0);

      budget.record({
        kind: "fee_claim",
        solDelta: result.claimedSol,
        signature: result.signature,
        note: "creator fees",
      });

      // Bulk claim -> per-token estimate, so the tuner has a money signal and
      // not just market-cap proxies. Clearly an estimate; the exact total is
      // in fee_claims.
      attributeFees(db, cfg, result.claimedSol, last || Date.now() - 7 * 86400_000);
    }
  } catch (e) {
    log.warn("creator fee claim failed", errFields(e));
  }
}
