import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn, type ChildProcess } from "node:child_process";

import { openDb, closeDb, BUSY_TIMEOUT_MS } from "../src/util/db.ts";

/** Blocking sleep; node:sqlite is synchronous so there is no loop to yield to. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Start a genuinely separate process that grabs a write lock on `dbPath`,
 * holds it for `holdMs`, then releases. Returns once the lock is actually
 * held, so the caller is guaranteed to be contending rather than racing.
 *
 * A real process is required: an in-process second connection would not
 * reproduce the boot scenario, and a synchronous blocking call in this process
 * would deadlock against any timer meant to release the lock.
 */
function spawnLockHolder(dbPath: string, flagPath: string, holdMs: number): ChildProcess {
  const script = join(dirname(flagPath), "holder.cjs");
  writeFileSync(script, `
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("fs");
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE TABLE IF NOT EXISTS lock_probe(x)");
    fs.writeFileSync(${JSON.stringify(flagPath)}, "held");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${holdMs});
    try { db.exec("ROLLBACK"); } catch {}
    db.close();
  `);
  const child = spawn(process.execPath, [script], { stdio: "ignore" });

  const deadline = Date.now() + 5000;
  while (!existsSync(flagPath)) {
    if (Date.now() > deadline) throw new Error("lock holder never acquired the lock");
    sleepSync(20);
  }
  return child;
}

/**
 * Two processes hold this database open: the bot (`run --web`) and the public
 * web server (`web` under TRENDBOT_CONFIG). Both LaunchAgents start at once at
 * boot, and the loser used to die with "database is locked". KeepAlive
 * restarted it, so the only visible symptom was the public dashboard being
 * down for the ~10s ThrottleInterval after every reboot.
 *
 * Two separate problems, and it is worth keeping them apart because the first
 * attempt at a fix addressed only the second one and claimed to have solved
 * the first:
 *
 *  1. `PRAGMA journal_mode = WAL` is what actually threw (the stack named
 *     `db.ts:298`). It needs exclusive access and ignores busy_timeout
 *     entirely. Fixed by reading the mode first and only writing when a real
 *     conversion is needed, plus a bounded retry for that case.
 *  2. SQLite's default `busy_timeout` is 0, so every *other* statement -- the
 *     migrations, and all normal writes afterwards -- also failed instantly
 *     under contention rather than waiting. Fixed by setting the timeout, and
 *     setting it FIRST, since it only affects statements that follow it.
 *
 * Found by an actual hard reboot; these tests are what would have caught it.
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
   * THE REAL GUARD, and the one the first attempt at this fix got wrong.
   *
   * The stack from the crash pointed at `db.ts:298` -- `PRAGMA journal_mode =
   * WAL`, not migrate(). That statement needs exclusive access and does NOT
   * honour busy_timeout: SQLite returns SQLITE_BUSY without ever calling the
   * busy handler, so setting a timeout (let alone setting it on the line
   * *after*) cannot protect it.
   *
   * This reproduces the crash exactly: a real second process holds a write
   * lock on a not-yet-WAL database while openDb runs. Without the fix openDb
   * throws "database is locked" in ~0ms. With it, openDb either skips the
   * write (already WAL) or retries until the holder releases, and succeeds.
   */
  test("openDb survives a lock held by another process during WAL setup", () => {
    const path = join(dir, "bot.db");

    // Seed a database in rollback-journal mode, so openDb must genuinely
    // convert it -- this is what takes the exclusive lock.
    const seed = new DatabaseSync(path);
    seed.exec("CREATE TABLE probe(x)");
    seed.close();

    const holder = spawnLockHolder(path, join(dir, "held"), 700);
    try {
      const started = Date.now();
      const db = openDb(path); // must not throw
      const took = Date.now() - started;

      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(mode.journal_mode.toLowerCase(), "wal");

      // It should have had to wait for the holder rather than sailing through,
      // otherwise the test is not actually exercising contention.
      assert.ok(took >= 200, `expected to contend for the lock, finished in ${took}ms`);
    } finally {
      holder.kill();
    }
  });

  test("a second open of the same path reuses one handle", () => {
    const path = join(dir, "bot.db");
    assert.equal(openDb(path), openDb(path));
  });
});
