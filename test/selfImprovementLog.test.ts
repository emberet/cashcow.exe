import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configSchema } from "../src/config/schema.ts";
import { openMemoryDb, type Db } from "../src/util/db.ts";
import { appendSelfImprovementEntry } from "../src/learning/selfImprovementLog.ts";
import type { TuningRun } from "../src/learning/tuner.ts";

/**
 * `appendSelfImprovementEntry` is the net-new piece of the self-improvement
 * feature: a human-readable, rolling companion to the `tuning_runs` SQL
 * table (already covered in test/learning.test.ts), written from every
 * `runTuning()` path except the disabled one. These tests cover its own
 * contract in isolation -- formatting, append-only behaviour, and the
 * growth cap -- using a temp path so the real docs/self-improvement.md is
 * never touched.
 */

const cfg = (over: Record<string, unknown> = {}) => configSchema.parse({ dryRun: true, ...over });

describe("appendSelfImprovementEntry — human-readable rolling audit log", () => {
  let dir: string;
  let db: Db;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "trendbot-self-improve-"));
    file = join(dir, "self-improvement.md");
    db = openMemoryDb();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("the header is written once, not duplicated across repeated calls", () => {
    const noOp: TuningRun = { ran: false, reason: "learning.enabled is false", sampleSize: 0, applied: false };
    appendSelfImprovementEntry(db, cfg(), noOp, file);
    appendSelfImprovementEntry(db, cfg(), noOp, file);

    const content = readFileSync(file, "utf8");
    const headerCount = (content.match(/^# Self-improvement log$/gm) ?? []).length;
    assert.equal(headerCount, 1, "the header must appear exactly once, however many entries follow");
  });

  test("a no-op run (insufficient sample size) writes a 'waiting' entry with the reason verbatim", () => {
    const run: TuningRun = {
      ran: false,
      reason: "only 6 settled launches, need 20. Tuning on fewer would fit noise and call it learning.",
      sampleSize: 6,
      applied: false,
    };
    appendSelfImprovementEntry(db, cfg(), run, file);

    const content = readFileSync(file, "utf8");
    assert.match(content, /Skipped: only 6 settled launches, need 20/);
  });

  test("a full run formats both accepted and rejected changes", () => {
    const run: TuningRun = {
      ran: true,
      sampleSize: 25,
      rationale: "Threshold band 70-85 shows the strongest hit-rate separation.",
      applied: true,
      result: {
        overlay: {},
        accepted: [{ path: "scoring.threshold", from: 65, to: 68, clamped: false }],
        rejected: [{ path: "risk.maxSolPerDay", reason: "forbidden: spend ceilings, launch caps and the loss breaker" }],
      },
    };
    appendSelfImprovementEntry(db, cfg(), run, file);

    const content = readFileSync(file, "utf8");
    assert.match(content, /Threshold band 70-85 shows the strongest hit-rate separation\./);
    assert.match(content, /`scoring\.threshold`: 65 → 68/);
    assert.match(content, /`risk\.maxSolPerDay`: rejected -- forbidden: spend ceilings/);
    assert.match(content, /Applied: yes\./);
    assert.match(content, /Sample: 25 settled launches/);
  });

  test("a full run with no proposed changes says so explicitly", () => {
    const run: TuningRun = {
      ran: true, sampleSize: 25, rationale: "Evidence does not justify a change.", applied: false,
      result: { overlay: {}, accepted: [], rejected: [] },
    };
    appendSelfImprovementEntry(db, cfg(), run, file);
    assert.match(readFileSync(file, "utf8"), /No changes proposed this run\./);
  });

  test("the file is genuinely append-only -- prior entries survive a new call", () => {
    const first: TuningRun = { ran: false, reason: "only 3 settled launches, need 20.", sampleSize: 3, applied: false };
    const second: TuningRun = { ran: false, reason: "only 9 settled launches, need 20.", sampleSize: 9, applied: false };
    appendSelfImprovementEntry(db, cfg(), first, file);
    appendSelfImprovementEntry(db, cfg(), second, file);

    const content = readFileSync(file, "utf8");
    assert.match(content, /only 3 settled launches/);
    assert.match(content, /only 9 settled launches/);
  });

  test("growth is capped -- appending past the entry limit trims the oldest, keeps the header", () => {
    for (let i = 0; i < 520; i++) {
      const run: TuningRun = { ran: false, reason: `cycle ${i}`, sampleSize: 0, applied: false };
      appendSelfImprovementEntry(db, cfg(), run, file);
    }
    const content = readFileSync(file, "utf8");
    assert.match(content, /^# Self-improvement log$/m, "header must survive trimming");
    assert.doesNotMatch(content, /cycle 0[^0-9]/, "the oldest entry must have been trimmed");
    assert.match(content, /cycle 519/, "the newest entry must be present");
  });
});
