import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PROJECT_ROOT } from "../config/load.ts";

export type Db = DatabaseSync;

let handle: Db | undefined;

const MIGRATIONS: string[] = [
  // v1 -- initial schema
  `
  CREATE TABLE signals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    feed       TEXT    NOT NULL,
    term       TEXT    NOT NULL,
    norm       TEXT    NOT NULL,
    raw_score  REAL    NOT NULL,
    observed_at INTEGER NOT NULL,
    url        TEXT,
    meta       TEXT
  );
  CREATE INDEX idx_signals_norm_time ON signals(norm, observed_at);
  CREATE INDEX idx_signals_time      ON signals(observed_at);
  CREATE INDEX idx_signals_feed      ON signals(feed, observed_at);

  -- Append-only. Negative sol_delta = money out, positive = money in.
  -- Reconciled against real wallet balance during live verification.
  CREATE TABLE spend_ledger (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    kind      TEXT    NOT NULL,
    mint      TEXT,
    sol_delta REAL    NOT NULL,
    signature TEXT,
    dry_run   INTEGER NOT NULL DEFAULT 0,
    note      TEXT
  );
  CREATE INDEX idx_ledger_ts   ON spend_ledger(ts);
  CREATE INDEX idx_ledger_kind ON spend_ledger(kind, ts);

  CREATE TABLE launches (
    mint       TEXT    PRIMARY KEY,
    term       TEXT    NOT NULL,
    norm       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    symbol     TEXT    NOT NULL,
    uri        TEXT,
    score      REAL,
    feeds      TEXT,
    created_at INTEGER NOT NULL,
    signature  TEXT,
    dry_run    INTEGER NOT NULL DEFAULT 0,
    status     TEXT    NOT NULL DEFAULT 'created'
  );
  CREATE INDEX idx_launches_norm    ON launches(norm);
  CREATE INDEX idx_launches_created ON launches(created_at);
  CREATE INDEX idx_launches_symbol  ON launches(symbol);

  -- Cost basis is recorded at open, not reconstructed later: every dev-position
  -- sale is a taxable disposal and retrofitting basis across hundreds of
  -- events is painful.
  CREATE TABLE positions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    mint           TEXT    NOT NULL,
    symbol         TEXT,
    entry_sol      REAL    NOT NULL,
    entry_tokens   REAL    NOT NULL,
    entry_price    REAL    NOT NULL,
    entry_fee_sol  REAL    NOT NULL DEFAULT 0,
    opened_at      INTEGER NOT NULL,
    opened_sig     TEXT,
    status         TEXT    NOT NULL DEFAULT 'open',
    exit_reason    TEXT,
    exit_sol       REAL,
    exit_tokens    REAL,
    exit_fee_sol   REAL    DEFAULT 0,
    closed_at      INTEGER,
    closed_sig     TEXT,
    sell_attempts  INTEGER NOT NULL DEFAULT 0,
    last_error     TEXT,
    realized_pnl_sol REAL,
    dry_run        INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_positions_status ON positions(status);
  CREATE INDEX idx_positions_mint   ON positions(mint);

  -- Non-SOL spend meters (e.g. the X API, billed per read in USD).
  CREATE TABLE meter (
    key    TEXT NOT NULL,
    period TEXT NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (key, period)
  );

  CREATE TABLE fee_claims (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    sol_amount REAL    NOT NULL,
    signature  TEXT,
    dry_run    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE kv (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,

  // v2 -- web dashboard and admin portal
  `
  -- Admin actions that must spend SOL are enqueued here rather than executed
  -- by the web process. The bot consumes them on its next tick, so the wallet
  -- key stays in exactly one process and a bug in the web layer can never sign
  -- a transaction.
  CREATE TABLE commands (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT    NOT NULL,
    payload      TEXT,
    requested_at INTEGER NOT NULL,
    requested_by TEXT,
    status       TEXT    NOT NULL DEFAULT 'pending',
    started_at   INTEGER,
    finished_at  INTEGER,
    result       TEXT,
    error        TEXT
  );
  CREATE INDEX idx_commands_status ON commands(status, requested_at);

  -- Opaque session tokens are stored hashed, so a database leak does not hand
  -- over live sessions.
  CREATE TABLE web_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    label      TEXT
  );
  CREATE INDEX idx_sessions_expiry ON web_sessions(expires_at);

  -- Every admin mutation is recorded. If money moved, there is a row saying who
  -- asked and what happened.
  CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    action  TEXT    NOT NULL,
    detail  TEXT,
    ip      TEXT
  );
  CREATE INDEX idx_audit_ts ON audit_log(ts);
  `,

  // v3 -- separate "when the source says it happened" from "when we saw it"
  `
  -- observed_at is the source's own timestamp, and it cannot be trusted for
  -- timing logic: a /biz/ sticky thread reports a creation time 16 months old,
  -- which made a bot running for two minutes report 484 days of history and
  -- silently satisfied the cold-start warmup gate. ingested_at is our clock.
  ALTER TABLE signals ADD COLUMN ingested_at INTEGER NOT NULL DEFAULT 0;
  UPDATE signals SET ingested_at = observed_at WHERE ingested_at = 0;
  CREATE INDEX idx_signals_ingested      ON signals(ingested_at);
  CREATE INDEX idx_signals_norm_ingested ON signals(norm, ingested_at);
  `,

  // v4 -- learning from what actually happened
  `
  -- One row per launch, joining the features that CAUSED the launch to what
  -- the token then did. This is the entire training substrate: without
  -- outcomes attached to the decision that produced them, tuning is guesswork
  -- dressed up as feedback.
  CREATE TABLE launch_outcomes (
    mint            TEXT    PRIMARY KEY,
    launched_at     INTEGER NOT NULL,
    term            TEXT,
    symbol          TEXT,
    score           REAL,
    components      TEXT,
    feeds           TEXT,
    families        TEXT,
    naming_source   TEXT,
    launch_hour_utc INTEGER,
    first_mcap_usd  REAL,
    peak_mcap_usd   REAL,
    last_mcap_usd   REAL,
    replies         INTEGER DEFAULT 0,
    graduated       INTEGER DEFAULT 0,
    is_banned       INTEGER DEFAULT 0,
    entry_sol       REAL,
    exit_sol        REAL,
    realized_pnl_sol REAL,
    -- Estimated, not measured: pump.fun claims creator fees in bulk across all
    -- of a wallet's tokens, so per-token fees can only be apportioned by each
    -- token's share of observed performance. Labelled as an estimate wherever
    -- it is shown.
    estimated_fee_sol REAL DEFAULT 0,
    verdict         TEXT    NOT NULL DEFAULT 'pending',
    observations    INTEGER NOT NULL DEFAULT 0,
    first_checked_at INTEGER,
    last_checked_at INTEGER,
    settled_at      INTEGER,
    dry_run         INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_outcomes_verdict ON launch_outcomes(verdict, launched_at);
  CREATE INDEX idx_outcomes_launched ON launch_outcomes(launched_at);

  -- Every tuning pass, including what was rejected and why. A config that
  -- changes itself is only acceptable if every change is attributable and
  -- revertible.
  CREATE TABLE tuning_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL,
    sample_size  INTEGER NOT NULL,
    accepted     TEXT,
    rejected     TEXT,
    rationale    TEXT,
    model        TEXT,
    applied      INTEGER NOT NULL DEFAULT 0,
    reverted_at  INTEGER
  );
  CREATE INDEX idx_tuning_ts ON tuning_runs(ts);
  `,

  // v5 -- the funnel, and why things were turned away
  `
  -- One row per launch tick. The dashboard's headline is the attrition story:
  -- how many rumours came in, and where each one died. Without persisting it
  -- the page could only ever show the current instant.
  CREATE TABLE pipeline_stats (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    sniffed     INTEGER NOT NULL DEFAULT 0,
    phrases     INTEGER NOT NULL DEFAULT 0,
    terms       INTEGER NOT NULL DEFAULT 0,
    warm        INTEGER NOT NULL DEFAULT 0,
    scored      INTEGER NOT NULL DEFAULT 0,
    -- How many of the scored candidates were actually LOOKED AT. The loop stops
    -- examining once the daily allowance is gone, so without this the funnel
    -- would report the unexamined remainder as rejections.
    examined    INTEGER NOT NULL DEFAULT 0,
    clean       INTEGER NOT NULL DEFAULT 0,
    uncrowded   INTEGER NOT NULL DEFAULT 0,
    affordable  INTEGER NOT NULL DEFAULT 0,
    launched    INTEGER NOT NULL DEFAULT 0,
    dry_run     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_pipeline_ts ON pipeline_stats(ts, dry_run);

  -- Candidates that cleared the score threshold and were then turned away.
  -- Surfaced publicly on a DELAY (see web/queries.ts): showing live what the
  -- bot is about to reject still reveals what it is looking at.
  CREATE TABLE declined (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    term    TEXT    NOT NULL,
    norm    TEXT    NOT NULL,
    reason  TEXT    NOT NULL,
    detail  TEXT,
    score   REAL,
    dry_run INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_declined_ts ON declined(ts, dry_run);
  CREATE INDEX idx_declined_norm ON declined(norm, ts);
  `,
];

export function openDb(dbPath: string): Db {
  if (handle) return handle;
  const abs = isAbsolute(dbPath) ? dbPath : resolve(PROJECT_ROOT, dbPath);
  mkdirSync(dirname(abs), { recursive: true });

  const db = new DatabaseSync(abs);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Durability matters more than throughput here; we write a few rows per minute.
  db.exec("PRAGMA synchronous = FULL");

  migrate(db);
  handle = db;
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${v + 1} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function closeDb(): void {
  handle?.close();
  handle = undefined;
}

/** Test helper: an isolated in-memory database with the schema applied. */
export function openMemoryDb(): Db {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

export function kvGet(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
    | { value: string } | undefined;
  return row?.value;
}

export function kvSet(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}
