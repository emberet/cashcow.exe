/**
 * Export everything this experiment has observed and learned into a
 * portable, future-project-readable corpus. READ ONLY against the live DB;
 * writes only to the output directory.
 *
 * Format: JSONL per table (one row per line, schema in the README), plus the
 * research and decision documents, plus a distilled LESSONS.md. JSONL rather
 * than a SQLite copy because the consumer is likely a different program (or
 * a model) that should not need this project's migrations to read it.
 *
 * Usage: node scripts/export-corpus.ts [--db data/bot.db] [--out data/export]
 */

import { mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/util/db.ts";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};

const DB_PATH = arg("db", "data/bot.db");
const OUT = arg("out", "data/export");

const TABLES: Array<{ name: string; note: string }> = [
  { name: "signals",
    note: "ROLLING WINDOW ONLY -- pruned continuously; cumulative counts live in pipeline_stats" },
  { name: "launches", note: "every token minted, real and pretend (dry_run column)" },
  { name: "launch_outcomes", note: "settled verdicts per launch; the learning evidence base" },
  { name: "positions", note: "dev-position lifecycle incl. exit reasons and realized P&L" },
  { name: "spend_ledger", note: "append-only money movements; the accounting ground truth" },
  { name: "fee_claims", note: "creator-fee claims with on-chain signatures" },
  { name: "tuning_runs", note: "every self-tuning decision the bot made, with reasoning" },
  { name: "pipeline_stats", note: "cumulative funnel counters per tick" },
  { name: "declined", note: "candidates rejected at the gates, and which gate" },
];

const db = openDb(DB_PATH);
mkdirSync(OUT, { recursive: true });

const manifest: Array<{ file: string; rows?: number; note: string }> = [];

for (const t of TABLES) {
  const rows = db.prepare(`SELECT * FROM ${t.name}`).all() as Record<string, unknown>[];
  // node:sqlite returns null-prototype objects; spread normalises them for JSON.
  const jsonl = rows.map((r) => JSON.stringify({ ...r })).join("\n") + (rows.length ? "\n" : "");
  const file = `${t.name}.jsonl`;
  writeFileSync(join(OUT, file), jsonl);
  manifest.push({ file, rows: rows.length, note: t.note });
  console.log(`  ${file.padEnd(24)} ${String(rows.length).padStart(7)} rows`);
}

// Documents: decisions, research, the self-improvement log if present.
for (const doc of ["docs/DECISIONS.md", "docs/self-improvement.md"]) {
  if (existsSync(doc)) {
    const base = doc.split("/").pop()!;
    copyFileSync(doc, join(OUT, base));
    manifest.push({ file: base, note: "verbatim copy at export time" });
    console.log(`  ${base}`);
  }
}
if (existsSync("data/research")) {
  for (const f of readdirSync("data/research")) {
    copyFileSync(join("data/research", f), join(OUT, f));
    manifest.push({ file: f, note: "research pass output, verbatim" });
    console.log(`  ${f}`);
  }
}

// The distilled lessons -- the part a future project can absorb in one read.
writeFileSync(join(OUT, "LESSONS.md"), `# Lessons from cashcow.exe, day 1-2

Distilled from docs/DECISIONS.md (full text alongside); numbers refer to its
sections. Written to be readable without the codebase.

## About autonomous money

- **Nothing that moves the books may act on a value the chain has not
  affirmatively stated.** A failed balance read is not a zero balance (§43);
  an unreconciled estimate is not a cost (§42); a missing sale record is not
  a loss when the sale simply hadn't been checked (§39). Three different
  bugs, one family: the books absorbed a guess and a safety rail fired on
  fiction.
- **Safety rails themselves need the same skepticism as the risk they
  guard.** Every invented loss above charged a real breaker
  (maxDailyLossSol) that then throttled real activity.
- **Single choke points work.** One function for selling, one for spending,
  one for claiming -- every money bug found was fixable in one place and
  testable in one place (§37, never-sell rail; invariant 1).
- **Estimates must be reconciled against what actually happened, in the same
  unit the biller uses.** And when the diagnosis of a discrepancy is a guess,
  say so in the record -- the first explanation written for §42 was wrong and
  had to be retracted in place.

## About trend detection

- **Corroboration breadth beats signal volume.** 24/25 single-family
  launches were duds; the tuner independently reached the same conclusion
  (threshold 65->70, minCorroboratingFeeds 1->2) from the same evidence.
- **A noisy high-volume source can be worse than nothing**: /biz/ produced
  9/9 duds while contributing 40%+ of raw signals. Dampen long unbroken
  failure streaks; never boost thin success (feedReliability, §44).
- **"Before it pops" is a second derivative.** Presence and even velocity
  lag; the last-30-minutes rate against the prior baseline is the earliest
  computable signal (accelerationOf, §44).
- **Enumerated lists silently exempt what they don't enumerate.** Two
  weight-summing checks each missed the newly added component; both now
  derive from the schema object (§44).

## About operating in public

- **Behave differently or wear the flag.** The rug heuristic (§37) was
  triggered by config, not intent -- on-chain there is no difference. The fix
  was to change behaviour (24h holds), not to rotate wallets, which is the
  concealment the warning exists to catch.
- **Transparency is load-bearing**: publishing duds, sources, and the full
  airdrop sheet is what makes every other claim checkable.
- **Disclosure separates announcement from shilling** (§2): same post, same
  account -- the difference is whether the account says what it is.

## Dataset notes

- signals.jsonl is a ROLLING WINDOW; cumulative funnel counts are in
  pipeline_stats.jsonl.
- dry_run=1 rows are simulation ("pretend") activity; never mix them with
  real accounting.
- Timestamps are Unix ms. ingested_at is trustworthy; observed_at is
  source-claimed and is display metadata only (invariant 5).
`);

writeFileSync(join(OUT, "README.md"), `# cashcow.exe -- exported corpus

Everything the experiment observed and learned, exported ${new Date().toISOString()}.
READ-ONLY snapshot; the live system continues past this export.

## Files

${manifest.map((m) => `- \`${m.file}\`${m.rows !== undefined ? ` (${m.rows} rows)` : ""} -- ${m.note}`).join("\n")}
- \`LESSONS.md\` -- the distilled part; start here.

## Schema

JSONL: one JSON object per line, keys are the SQLite column names. Notable
columns: \`dry_run\` (1 = simulated, keep separate from real accounting),
\`ingested_at\`/\`observed_at\` (Unix ms; trust the former, §invariant 5),
\`verdict\` in launch_outcomes (hit / modest / dud / null = unsettled).

## Provenance

Exported by scripts/export-corpus.ts from ${DB_PATH}. The DECISIONS.md copy
is the authoritative why-log for every number here.
`);

db.close();
console.log(`\nexported to ${OUT}`);
