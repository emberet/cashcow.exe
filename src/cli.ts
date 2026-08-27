import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, PROJECT_ROOT } from "./config/load.ts";
import { openDb, closeDb } from "./util/db.ts";
import { BudgetGuard } from "./risk/budget.ts";
import { KillSwitch } from "./risk/killswitch.ts";
import { pollAll, enabledFeeds, allFeedIds, getFeed } from "./feeds/registry.ts";
import { ingestSignals, buildCandidates, qualifying } from "./scoring/score.ts";
import { compileFilters, checkTerm } from "./scoring/filters.ts";
import { checkSaturation } from "./scoring/saturation.ts";
import { pumpFunMarket } from "./chain/market.ts";
import { runLoop, launchTick } from "./runner/loop.ts";
import { evaluateOpenPositions } from "./positions/manager.ts";
import { claimCreatorFees, creatorVaultBalanceSol } from "./chain/fees.ts";
import { listStuck } from "./positions/store.ts";
import { startWebServer } from "./web/server.ts";
import {
  hashPassword,
  authState,
  storedHash,
  setStoredPassword,
  clearStoredPassword,
  MIN_PASSWORD_LENGTH,
} from "./web/auth.ts";
import { createInterface } from "node:readline/promises";
import { computeCapacity, balanceNeededFor, costPerLaunch } from "./risk/capacity.ts";
import { outcomeSummary, settledOutcomes, refreshOutcomes } from "./learning/outcomes.ts";
import { runTuning, tuningHistory } from "./learning/tuner.ts";
import { overlaySummary, clearOverlay, writeOverlay } from "./learning/overlay.ts";
import { describeMandate } from "./learning/guardrails.ts";
import { runPreflight, SETUP_LINKS } from "./cli/preflight.ts";
import { getBalanceSol } from "./chain/rpc.ts";
import { loadWallet } from "./chain/wallet.ts";
import { log, errFields } from "./util/log.ts";
import type { FeedContext } from "./feeds/types.ts";

// Load .env before config so secrets referenced by env name resolve.
const envPath = resolve(PROJECT_ROOT, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const HELP = `
cashcow.exe -- trend detection to pump.fun launcher

  feeds [--feed <id>]   Poll feeds once and report what each returned
  score                 Poll, ingest, and print ranked launch candidates
  run [--dry-run] [--once] [--web]   Main loop; --web also serves the dashboard
  web                   Serve the dashboard and admin portal only
  admin-password [--save] [--clear]
                        Set the admin password. Default prints an
                        ADMIN_PASSWORD_HASH line for .env; --save stores it in
                        the database instead (takes effect immediately, no
                        restart); --clear drops that override so .env wins again
  positions             Show open and recent dev positions
  budget                Show the rolling 24h spend/launch/loss picture
  fees [--claim]        Show, and optionally claim, pump.fun creator fees
  preflight [--links] [--for-mainnet]   Verify every credential by using it
  capacity [--balance N]  How many launches/day the wallet can sustain, and why
  outcomes [--refresh]  What happened to the tokens it launched
  learn [--apply] [--mandate]  Run a tuning pass from real outcomes
  tuning [--clear]      Show or discard what the tuner has learned
  halt [reason]         Stop new launches (open positions still exit)
  resume                Clear the halt
  backtest-launches [--days-ago-start N] [--days-ago-end N] [--max-pages N] [--rpc URL]
                         One-time historical research pass over past pump.fun
                         launches; writes a report, proposes scoring changes
                         for you to hand-apply, never edits config itself.
                         Holder reads need a dedicated mainnet RPC: set
                         SOLANA_RPC_URL in .env (preferred -- keeps the key
                         out of shell history), or pass --rpc explicitly
  profit [--record]     Net profit to date; --record also snapshots the
                         calculated 40/50/10 split (requires distribution.enabled)

Flags: --config <path>  --verbose  --json
Feeds: ${allFeedIds().join(", ")}
`;

function parseArgs(argv: string[]) {
  const cmd = argv[0] ?? "help";
  const flags = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags.set(key, next); i++; }
      else flags.set(key, true);
    } else positional.push(a);
  }
  return { cmd, flags, positional };
}

async function main() {
  const { cmd, flags, positional } = parseArgs(process.argv.slice(2));
  if (cmd === "help" || flags.has("help")) { console.log(HELP); return; }

  if (typeof flags.get("config") === "string") {
    process.env.TRENDBOT_CONFIG = String(flags.get("config"));
  }

  const overrides: Record<string, unknown> = {};
  if (flags.get("dry-run") === true) overrides.dryRun = true;
  if (flags.get("verbose") === true) overrides.logging = { level: "debug" };
  if (flags.get("json") === true) {
    overrides.logging = { ...(overrides.logging as object ?? {}), json: true };
  }

  const cfg = loadConfig(overrides);
  const db = openDb(cfg.storage.dbPath);
  const budget = new BudgetGuard(db, cfg);
  const kill = new KillSwitch(cfg.storage.haltFile);
  const ctx: FeedContext = { cfg, budget };

  switch (cmd) {
    case "feeds": {
      const only = flags.get("feed");
      if (typeof only === "string") {
        const adapter = getFeed(only);
        if (!adapter) throw new Error(`unknown feed "${only}". Known: ${allFeedIds().join(", ")}`);
        const ready = adapter.readiness(ctx);
        if (!ready.ready) { console.log(`${only}: NOT READY -- ${ready.reason}`); break; }
        const t0 = Date.now();
        const signals = await adapter.poll(ctx);
        console.log(`${only}: ${signals.length} signals in ${Date.now() - t0}ms`);
        for (const s of signals.slice(0, 15)) {
          console.log(`  ${s.rawScore.toFixed(3)}  ${s.term.slice(0, 90)}`);
        }
        break;
      }

      const results = await pollAll(ctx, { force: true });
      console.log(`\nFeed poll -- ${results.length} enabled\n`);
      for (const r of results) {
        const status = r.ok ? "ok" : r.skipped ? "skipped" : "FAILED";
        const detail = r.skipped ?? r.error ?? `${r.signals.length} signals`;
        console.log(`  ${r.feed.padEnd(14)} ${status.padEnd(8)} ${String(r.durationMs).padStart(5)}ms  ${detail}`);
      }
      const total = results.reduce((n, r) => n + r.signals.length, 0);
      console.log(`\n  total: ${total} signals from ${results.filter((r) => r.ok).length}/${results.length} feeds\n`);
      break;
    }

    case "score": {
      const results = await pollAll(ctx, { force: true });
      const weights = new Map(enabledFeeds(cfg).map(({ adapter, weight }) => [adapter.id, weight]));
      const signals = results.flatMap((r) => r.signals);
      const n = ingestSignals(db, signals, weights, cfg.scoring);
      log.info("signals ingested", { raw: signals.length, phrases: n });

      const candidates = buildCandidates(db, cfg.scoring);
      const filters = compileFilters(cfg.filters);
      const passing = qualifying(candidates, cfg.scoring);

      console.log(`\n${candidates.length} candidates, ${passing.length} above threshold ${cfg.scoring.threshold}\n`);
      console.log("  score  vel  corr  affin tick  feeds                term");
      console.log("  " + "-".repeat(84));

      for (const c of candidates.slice(0, 25)) {
        const f = checkTerm(c.term, filters);
        const mark = !f.allowed ? "BLOCKED" : c.score >= cfg.scoring.threshold ? "PASS" : "";
        const k = c.components;
        console.log(
          `  ${c.score.toFixed(1).padStart(5)}  ${k.velocity.toFixed(2)} ${k.corroboration.toFixed(2)}  ` +
          `${k.cryptoAffinity.toFixed(2)}  ${k.tickerability.toFixed(2)}  ` +
          `${c.feeds.join("+").slice(0, 20).padEnd(20)} ${c.term.slice(0, 40).padEnd(40)} ${mark}`,
        );
        if (!f.allowed) console.log(`         ^ ${f.reason}`);
      }

      // Saturation is a network call, so only check the ones that would launch.
      if (passing.length) {
        console.log("\nSaturation check on qualifying candidates:");
        for (const c of passing.slice(0, 5)) {
          const sat = await checkSaturation(db, c.term, undefined, cfg.saturation, pumpFunMarket);
          console.log(`  ${c.term.slice(0, 40).padEnd(40)} ${sat.saturated ? "SATURATED" : "clear"}` +
            (sat.reason ? ` -- ${sat.reason}` : ""));
        }
      }
      console.log();
      break;
    }

    case "preflight": {
      if (flags.get("links") === true || flags.get("help") === true) {
        console.log(SETUP_LINKS);
        break;
      }
      console.log("\n  checking each credential by using it, not by testing it is non-empty\n");
      const forMainnet = flags.get("for-mainnet") === true;
      const results = await runPreflight(db, cfg, forMainnet);
      const mark = { ok: "  ok  ", warn: " warn ", fail: " FAIL " };
      for (const r of results) {
        console.log(`  [${mark[r.status]}] ${r.name.padEnd(24)} ${r.detail}`);
        if (r.fix) console.log(`${" ".repeat(35)}-> ${r.fix}`);
      }
      const fails = results.filter((r) => r.status === "fail").length;
      const warns = results.filter((r) => r.status === "warn").length;
      console.log(`\n  ${fails} blocking, ${warns} worth reading.`);
      console.log(fails === 0
        ? "  Nothing blocking. Re-read the warnings before you flip dryRun.\n"
        : "  Not ready. `npm run preflight -- --links` has the signup links.\n");
      if (fails > 0) process.exitCode = 1;
      break;
    }

    case "capacity": {
      const flagBal = flags.get("balance");
      let balance = typeof flagBal === "string" ? Number(flagBal) : undefined;
      if (balance === undefined && !cfg.dryRun) {
        balance = await getBalanceSol(cfg, loadWallet(cfg).publicKey).catch(() => undefined);
      }

      const cap = computeCapacity(db, cfg, balance);
      const per = costPerLaunch(cfg);

      console.log(`\n  mode            ${cap.adaptive ? "adaptive (wallet-derived)" : "static"}`);
      if (balance !== undefined) console.log(`  wallet          ${balance.toFixed(4)} SOL`);
      console.log(`  cost / launch   ${per.toFixed(4)} SOL  (create ${cfg.launch.estimatedCreateCostSol} + dev buy ${cfg.devPosition.enabled ? cfg.devPosition.buySol : 0} + fees)`);
      console.log(`  budget / day    ${cap.solPerDay.toFixed(4)} SOL`);
      console.log(`  LAUNCHES / DAY  ${cap.launchesPerDay}`);
      console.log(`  limited by      ${cap.binding}`);
      if (cap.detail.throttled) console.log(`  THROTTLED       ${cap.detail.throttleReason}`);
      if (cap.detail.newsVolume?.throttled) {
        const nv = cap.detail.newsVolume;
        console.log(`  NEWS VOLUME     ${nv.scoredCount} qualifying candidate(s) in the last ` +
          `${nv.lookbackHours}h (need ${cfg.risk.adaptive.newsVolumeThrottle.highVolumeScoredCount}+ ` +
          `for the full allowance) -> scaled to ${(nv.scale * 100).toFixed(0)}%`);
      }

      console.log(`\n  wallet needed to sustain a given rate (dev buy ${cfg.devPosition.enabled ? cfg.devPosition.buySol : 0} SOL):`);
      for (const n of [3, 6, 12, 24, 48]) {
        console.log(`    ${String(n).padStart(3)} launches/day -> ${balanceNeededFor(cfg, n).toFixed(2).padStart(8)} SOL`);
      }
      if (cfg.devPosition.enabled) {
        const noBuy = { ...cfg, devPosition: { ...cfg.devPosition, enabled: false } };
        console.log(`\n  the dev buy dominates: with it disabled, cost/launch drops to ` +
          `${costPerLaunch(noBuy).toFixed(4)} SOL and 24/day needs only ${balanceNeededFor(noBuy, 24).toFixed(2)} SOL.`);
      }
      console.log();
      break;
    }

    case "outcomes": {
      if (flags.get("refresh") === true) {
        const n = await refreshOutcomes(db, cfg);
        console.log(`  refreshed ${n} outcome(s)`);
      }
      const o = outcomeSummary(db, cfg);
      console.log(`\n  launches ${o.total}   settled ${o.settled}   pending ${o.pending}`);
      console.log(`  hits ${o.hits}   modest ${o.modest}   duds ${o.duds}` +
        (o.hitRate == null ? "" : `   hit rate ${(o.hitRate * 100).toFixed(1)}%`));
      console.log(`  realised P&L ${o.realisedPnlSol.toFixed(4)} SOL   fees (est) ${o.estimatedFeeSol.toFixed(5)} SOL`);
      console.log(`  best peak market cap  $${Math.round(o.bestPeakMcapUsd).toLocaleString()}\n`);

      const rows = settledOutcomes(db, cfg, 15);
      if (rows.length) {
        console.log("  verdict  score  peak mcap    feeds                 term");
        console.log("  " + "-".repeat(78));
        for (const r of rows) {
          console.log(`  ${r.verdict.padEnd(8)} ${r.score.toFixed(1).padStart(5)}  ` +
            `$${String(Math.round(r.peakMcapUsd)).padStart(9)}  ` +
            `${r.feeds.join("+").slice(0, 20).padEnd(21)} ${r.term.slice(0, 30)}`);
        }
        console.log();
      }
      break;
    }

    case "learn": {
      if (flags.get("mandate") === true) { console.log(`\n${describeMandate()}\n`); break; }

      await refreshOutcomes(db, cfg);
      const run = await runTuning(db, cfg);

      if (!run.ran) { console.log(`\n  tuning did not run: ${run.reason}\n`); break; }

      console.log(`\n  sample: ${run.sampleSize} settled launches`);
      console.log(`  rationale: ${run.rationale}\n`);

      if (run.result?.accepted.length) {
        console.log("  accepted:");
        for (const a of run.result.accepted) {
          console.log(`    ${a.path.padEnd(38)} ${a.from} -> ${a.to}${a.clamped ? "  (clamped)" : ""}`);
        }
      } else console.log("  no changes accepted");

      if (run.result?.rejected.length) {
        console.log("\n  rejected by guardrails:");
        for (const r of run.result.rejected) console.log(`    ${r.path.padEnd(38)} ${r.reason}`);
      }

      const shouldApply = run.applied || flags.get("apply") === true;
      if (shouldApply && run.result?.accepted.length) {
        writeOverlay(run.result.overlay);
        console.log("\n  applied to data/tuning.json -- restart to pick it up\n");
      } else if (run.result?.accepted.length) {
        console.log("\n  not applied (pass --apply, or set learning.autoApply)\n");
      } else console.log();
      break;
    }

    case "tuning": {
      if (flags.get("clear") === true) {
        console.log(clearOverlay()
          ? "\n  overlay cleared; config reverted to its authored values\n"
          : "\n  no overlay to clear\n");
        break;
      }
      const ov = overlaySummary();
      console.log(`\n  overlay: ${ov.present ? `active since ${new Date(ov.updatedAt ?? 0).toLocaleString()}` : "none"}`);
      for (const [k, v] of Object.entries(ov.values)) console.log(`    ${k.padEnd(40)} ${v}`);

      const hist = tuningHistory(db, 10);
      if (hist.length) {
        console.log("\n  history:");
        for (const h of hist) {
          const acc = JSON.parse(String(h.accepted ?? "[]")) as unknown[];
          console.log(`    ${new Date(Number(h.ts)).toLocaleString()}  n=${h.sample_size}  ` +
            `${acc.length} change(s)  ${h.applied ? "applied" : "proposed"}`);
        }
      }
      console.log();
      break;
    }

    case "web": {
      const srv = await startWebServer(db, cfg, kill);
      console.log(`\n  dashboard  ${srv.url}/`);
      console.log(`  admin      ${srv.url}/admin  ${authState(db).configured ? "" : "(disabled - no password set)"}`);
      console.log("\n  Ctrl-C to stop.\n");
      await new Promise<void>((r) => {
        process.on("SIGINT", () => { void srv.close().then(r); });
        process.on("SIGTERM", () => { void srv.close().then(r); });
      });
      break;
    }

    case "admin-password": {
      // --clear drops the stored override so ADMIN_PASSWORD_HASH governs again.
      // Needed because once a hash is saved to the database, editing .env has
      // no effect -- which is a confusing way to lock yourself out.
      if (flags.has("clear")) {
        clearStoredPassword(db);
        const after = storedHash(db);
        console.log("\n  Stored password cleared.");
        console.log(after.source === "env"
          ? "  ADMIN_PASSWORD_HASH from the environment is now in effect.\n"
          : "  No password is set anywhere, so the admin portal is now DISABLED.\n");
        break;
      }

      // Read from a TTY prompt so the password never lands in shell history.
      // Refuse a pipe explicitly: on EOF the prompt simply never resolves and
      // the process exits 0 having done nothing, which with --save looks
      // exactly like success. Say so rather than silently not saving.
      if (!process.stdin.isTTY) {
        console.log("\n  This command needs an interactive terminal: it prompts for the");
        console.log("  password so it never appears in an argument or in shell history.");
        console.log("  Run it directly in a terminal, not through a pipe or a script.\n");
        process.exitCode = 1; break;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const pw = await rl.question("New admin password: ");
      const again = await rl.question("Confirm: ");
      rl.close();

      if (pw !== again) { console.log("\n  Passwords do not match.\n"); process.exitCode = 1; break; }
      if (pw.length < MIN_PASSWORD_LENGTH) {
        console.log(`\n  Use at least ${MIN_PASSWORD_LENGTH} characters.\n`);
        process.exitCode = 1; break;
      }

      // --save writes straight to the database: no .env editing, and it takes
      // effect immediately. This is the way back in after a lockout.
      if (flags.has("save")) {
        setStoredPassword(db, pw);
        console.log("\n  Password saved. It takes effect immediately — no restart needed.");
        console.log("  It overrides ADMIN_PASSWORD_HASH; run `admin-password --clear` to undo.");
        console.log("  The password itself is not stored anywhere. Keep it in a password manager.\n");
        break;
      }

      console.log("\n  Add this line to your .env file:\n");
      console.log(`ADMIN_PASSWORD_HASH=${hashPassword(pw)}\n`);
      // Without this warning the printed line would be a silent no-op.
      if (storedHash(db).source === "db") {
        console.log("  WARNING: a password saved in the database is currently overriding");
        console.log("  ADMIN_PASSWORD_HASH, so the line above will have NO EFFECT until you");
        console.log("  run `node src/cli.ts admin-password --clear` (or use --save instead).\n");
      }
      console.log("  The password itself is not stored anywhere. Keep it in a password manager.\n");
      break;
    }

    case "run": {
      if (!cfg.dryRun && cfg.network === "mainnet-beta") {
        console.log("\n  *** LIVE MAINNET -- this will sign and send real transactions ***");
        console.log(`  caps: ${cfg.risk.maxLaunchesPerDay} launches/day, ` +
          `${cfg.risk.maxSolPerDay} SOL/day, dev buy ${cfg.devPosition.buySol} SOL`);
        console.log("  starting in 5s, Ctrl-C to abort\n");
        await new Promise((r) => setTimeout(r, 5000));
      }
      if (flags.get("web") === true) {
        const srv = await startWebServer(db, cfg, kill);
        console.log(`  dashboard: ${srv.url}/   admin: ${srv.url}/admin`);
      }
      const stuck = listStuck(db);
      if (stuck.length) {
        log.warn("positions are STUCK and need manual attention", {
          count: stuck.length, mints: stuck.map((p) => p.mint),
        });
      }
      if (flags.get("once") === true) {
        // One pass, for testing and for running under cron.
        const stats = await launchTick(db, cfg, budget, kill, ctx);
        await evaluateOpenPositions(db, cfg, budget);
        console.log(`\n  candidates ${stats.candidates}  qualified ${stats.qualified}  launched ${stats.launched}`);
        const rej = Object.entries(stats.rejected);
        if (rej.length) console.log(`  rejected: ${rej.map(([k, v]) => `${k}=${v}`).join("  ")}`);
        console.log();
        break;
      }
      await runLoop(db, cfg, budget, kill);
      break;
    }

    case "fees": {
      const available = await creatorVaultBalanceSol(cfg);
      console.log(`\n  unclaimed creator fees: ${available.toFixed(6)} SOL`);
      if (flags.get("claim") === true) {
        const res = await claimCreatorFees(cfg);
        console.log(res.skipped
          ? `  skipped: ${res.skipped}`
          : `  claimed ${res.claimedSol.toFixed(6)} SOL${res.dryRun ? " [dry run]" : ""}` +
            (res.signature ? ` (${res.signature})` : ""));
      } else {
        console.log("  pass --claim to collect\n");
      }
      break;
    }

    case "budget": {
      const s = budget.summary();
      console.log(`\nRolling ${s.windowHours}h  (${s.dryRun ? "DRY RUN" : "LIVE"} accounting)\n`);
      console.log(`  launches   ${s.launches} / ${s.maxLaunches}`);
      console.log(`  SOL spent  ${s.solSpent.toFixed(4)} / ${s.maxSol}`);
      console.log(`  realised loss ${s.realizedLoss.toFixed(4)} / ${s.maxLoss}`);
      console.log(`  open positions ${s.openPositions} / ${s.maxPositions}`);
      console.log(`  halted     ${kill.isHalted() ? `YES -- ${kill.haltReason()}` : "no"}\n`);
      break;
    }

    case "profit": {
      const { profitSummary } = await import("./web/queries.ts");
      const p = profitSummary(db, cfg);
      console.log(`\n  fees claimed        ${p.feesTotalSol.toFixed(5)} SOL`);
      console.log(`  realised P&L        ${p.realisedPnlSol.toFixed(5)} SOL`);
      console.log(`  launch/creation cost ${p.uncapturedSpendSol.toFixed(5)} SOL`);
      console.log(`  ------------------------------------`);
      console.log(`  NET PROFIT          ${p.netProfitSol.toFixed(5)} SOL`);
      console.log(`  (excludes open positions' locked-up capital -- not lost, just deployed --`);
      console.log(`   and the X-API USD meter, a different currency)\n`);

      if (flags.get("record") === true) {
        if (!cfg.distribution.enabled) {
          console.log(`  --record requested but distribution.enabled is false; nothing written.\n`);
          break;
        }
        const { recordDistributionSnapshot } = await import("./accounting/distribution.ts");
        const snap = recordDistributionSnapshot(db, cfg, p.netProfitSol);
        console.log(`  recorded distribution snapshot #${snap.id}:`);
        for (const s of snap.splits) {
          console.log(`    ${s.label.padEnd(24)} ${s.pct}%  ->  ${s.sol.toFixed(5)} SOL`);
        }
        console.log(`  (calculated figures only -- no funds moved, no token, no recipients yet)\n`);
      }
      break;
    }

    case "halt":
      kill.halt(positional.join(" ") || "manual halt via CLI");
      break;

    case "resume":
      kill.resume();
      break;

    case "backtest-launches": {
      const { runBacktest, DEFAULT_BACKTEST_OPTS } = await import("./research/backtest.ts");
      const num = (key: string, fallback: number) => {
        const v = flags.get(key);
        return typeof v === "string" && Number.isFinite(Number(v)) ? Number(v) : fallback;
      };
      const rpcOverride = flags.get("rpc");
      await runBacktest(cfg, {
        ...DEFAULT_BACKTEST_OPTS,
        daysAgoStart: num("days-ago-start", DEFAULT_BACKTEST_OPTS.daysAgoStart),
        daysAgoEnd: num("days-ago-end", DEFAULT_BACKTEST_OPTS.daysAgoEnd),
        maxPages: num("max-pages", DEFAULT_BACKTEST_OPTS.maxPages),
      }, typeof rpcOverride === "string" ? rpcOverride : undefined);
      break;
    }

    case "positions": {
      const rows = db.prepare(
        `SELECT id, mint, symbol, entry_sol, entry_price, opened_at, status,
                exit_reason, realized_pnl_sol, dry_run
           FROM positions ORDER BY opened_at DESC LIMIT 30`,
      ).all() as Array<Record<string, unknown>>;
      if (!rows.length) { console.log("\nno positions recorded\n"); break; }
      console.log("\n  id   status  symbol      entry SOL   pnl SOL   opened               reason");
      console.log("  " + "-".repeat(84));
      for (const r of rows) {
        const opened = new Date(Number(r.opened_at)).toISOString().replace("T", " ").slice(0, 19);
        const pnl = r.realized_pnl_sol == null ? "     -" : Number(r.realized_pnl_sol).toFixed(4).padStart(7);
        console.log(
          `  ${String(r.id).padEnd(4)} ${String(r.status).padEnd(7)} ${String(r.symbol ?? "").padEnd(11)} ` +
          `${Number(r.entry_sol).toFixed(4).padStart(9)}  ${pnl}   ${opened}  ${r.exit_reason ?? ""}` +
          `${r.dry_run ? "  [dry]" : ""}`,
        );
      }
      console.log();
      break;
    }

    default:
      console.log(`unknown command: ${cmd}`);
      console.log(HELP);
      process.exitCode = 1;
  }

  closeDb();
}

main().catch((e) => {
  log.error("fatal", errFields(e));
  process.exitCode = 1;
  closeDb();
});
