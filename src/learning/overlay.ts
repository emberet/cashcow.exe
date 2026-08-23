import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PROJECT_ROOT } from "../config/load.ts";
import { boundFor, FORBIDDEN_PREFIXES } from "./guardrails.ts";
import { log } from "../util/log.ts";

/**
 * Persistence for tuned values.
 *
 * Tuned settings live in their own file rather than being written back into
 * the operator's `config.json`. Two reasons, both about trust: the operator's
 * file stays theirs and diffable, and the entire learned state can be thrown
 * away with one command when it turns out to have learned something stupid.
 *
 * The overlay is filtered on READ as well as on write. If someone hand-edits
 * this file to set `risk.maxSolPerDay`, it is ignored — the allowlist is
 * re-applied every load, so the file cannot become a back door into the spend
 * limits the tuner is forbidden from touching.
 */

export const OVERLAY_FILENAME = "data/tuning.json";

export type OverlayFile = {
  updatedAt: number;
  runId?: number;
  values: Record<string, unknown>;
};

function overlayPath(p = OVERLAY_FILENAME): string {
  return isAbsolute(p) ? p : resolve(PROJECT_ROOT, p);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Flatten to dotted paths so each leaf can be checked against the allowlist. */
function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!isObject(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (isObject(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

function nest(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let cur = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      if (!isObject(cur[key])) cur[key] = {};
      cur = cur[key] as Record<string, unknown>;
    }
    cur[parts[parts.length - 1]!] = value;
  }
  return out;
}

/**
 * Strip anything not tunable. Applied on every read, so hand-editing the file
 * cannot smuggle in a forbidden key.
 */
export function sanitise(values: Record<string, unknown>): {
  clean: Record<string, unknown>;
  dropped: string[];
} {
  const flat = flatten(values);
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [path, value] of Object.entries(flat)) {
    const forbidden = FORBIDDEN_PREFIXES.some(
      (f) => path === f.prefix || path.startsWith(f.prefix),
    );
    if (forbidden || !boundFor(path) || typeof value !== "number" || !Number.isFinite(value)) {
      dropped.push(path);
      continue;
    }
    clean[path] = value;
  }

  return { clean: nest(clean), dropped };
}

export function readOverlay(path = OVERLAY_FILENAME): Record<string, unknown> {
  const file = overlayPath(path);
  if (!existsSync(file)) return {};

  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as OverlayFile;
    const { clean, dropped } = sanitise(parsed.values ?? {});
    if (dropped.length) {
      log.warn("tuning overlay contained keys outside the tunable allowlist; ignoring them", {
        dropped,
      });
    }
    return clean;
  } catch (e) {
    log.warn("tuning overlay is unreadable, ignoring it", { err: String(e).slice(0, 160) });
    return {};
  }
}

/** Merge new values over whatever is already there, then persist. */
export function writeOverlay(
  newValues: Record<string, unknown>,
  runId?: number,
  path = OVERLAY_FILENAME,
): void {
  const file = overlayPath(path);
  mkdirSync(dirname(file), { recursive: true });

  const merged = { ...flatten(readOverlay(path)), ...flatten(newValues) };
  const { clean } = sanitise(nest(merged));

  const payload: OverlayFile = { updatedAt: Date.now(), runId, values: clean };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  log.info("tuning overlay written", { file, keys: Object.keys(flatten(clean)).length });
}

/** Throw away everything learned and go back to the operator's config. */
export function clearOverlay(path = OVERLAY_FILENAME): boolean {
  const file = overlayPath(path);
  if (!existsSync(file)) return false;
  rmSync(file);
  log.info("tuning overlay cleared; config reverted to its authored values", { file });
  return true;
}

export function overlaySummary(path = OVERLAY_FILENAME): {
  present: boolean; updatedAt?: number; values: Record<string, unknown>;
} {
  const file = overlayPath(path);
  if (!existsSync(file)) return { present: false, values: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as OverlayFile;
    return {
      present: true,
      updatedAt: parsed.updatedAt,
      values: flatten(sanitise(parsed.values ?? {}).clean),
    };
  } catch {
    return { present: false, values: {} };
  }
}
