import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDb, closeDb, BUSY_TIMEOUT_MS } from "../src/util/db.ts";

/**
 * Two processes hold this database open: the bot (`run --web`) and the public
 * web server (`web` under TRENDBOT_CONFIG). WAL lets them read concurrently,
 * but a writer still takes an exclusive lock.
 *
 * SQLite's default `busy_timeout` is 0, which means contention fails INSTANTLY
 * rather than waiting. Both LaunchAgents start at once at boot, both call
 * migrate() -- which opens a transaction even when there is nothing to migrate
 * -- and the loser died with "database is locked". KeepAlive restarted it, so
 * the only visible symptom was the public dashboard being down for the ~10s
 * ThrottleInterval after every reboot. Found by an actual hard reboot; these
 * tests are what would have caught it first.
 */
describe("concurrent access from the bot and the web server", () => {
  let dir: string;

  beforeEach(() => {
    closeDb(); // openDb caches a module-level handle; start each test clean
    dir = mkdtempSync(join(tmpdir(), "cashcow-db-"));
  });
  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test("openDb sets a non-zero busy timeout", () => {
    const db = openDb(join(dir, "bot.db"));
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    // Guards against the pragma being dropped: SQLite's default is 0, and 0 is
    // precisely the value that turns a momentary lock into a crash.
    assert.equal(row.timeout, BUSY_TIMEOUT_MS);
    assert.ok(row.timeout > 0);
  });

  test("WAL is on, so the two processes can read while one writes", () => {
    const db = openDb(join(dir, "bot.db"));
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    assert.equal(row.journal_mode, "wal");
  });

  /**
   * NOTE ON WHAT THIS DOES AND DOES NOT GUARD.
   *
   * This test overrides busy_timeout on its own connection, so it passes with
   * or without the fix in openDb. It is not the regression guard -- "openDb
   * sets a non-zero busy timeout" above is, because it asserts the pragma that
   * openDb actually applies.
   *
   * What this one does is pin the *mechanism*, so the guard above cannot be
   * dismissed as cargo-cult if someone reads it cold: it shows concretely that
   * 0 means "crash immediately" and non-zero means "wait, then give up". The
   * real timeout is not used directly because blocking for BUSY_TIMEOUT_MS
   * would add 5s to every suite run for no extra coverage.
   */
  test("busy_timeout is what decides crash-now vs wait: both arms", () => {
    const path = join(dir, "bot.db");
    openDb(path); // creates the file with the schema

    // Stand-in for the other process, holding the write lock for the duration.
    const other = new DatabaseSync(path);
    other.exec("BEGIN IMMEDIATE");

    // Arm 1: timeout 0 -- the old behaviour, and the reason a boot race was
    // fatal rather than merely slow.
    const impatient = new DatabaseSync(path);
    impatient.exec("PRAGMA busy_timeout = 0");
    let started = Date.now();
    assert.throws(() => impatient.exec("BEGIN IMMEDIATE"), /locked|busy/i);
    const failedAfter = Date.now() - started;
    assert.ok(failedAfter < 100, `expected an instant failure, took ${failedAfter}ms`);

    // Arm 2: timeout set -- blocks, then gives up. A startup race resolves
    // itself inside this window instead of killing the process.
    const patient = new DatabaseSync(path);
    const shortMs = 250;
    patient.exec(`PRAGMA busy_timeout = ${shortMs}`);
    started = Date.now();
    assert.throws(() => patient.exec("BEGIN IMMEDIATE"), /locked|busy/i);
    const waited = Date.now() - started;
    assert.ok(
      waited >= shortMs * 0.8,
      `expected to wait ~${shortMs}ms for the lock, gave up after ${waited}ms`,
    );

    other.exec("ROLLBACK");
    other.close();
    impatient.close();
    patient.close();
  });

  test("a second open of the same path reuses one handle", () => {
    const path = join(dir, "bot.db");
    assert.equal(openDb(path), openDb(path));
  });
});
