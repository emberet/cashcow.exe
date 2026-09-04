/**
 * Build the lore corpus: official catalogues whose entries collide with
 * names that trend. Writes data/lore/minor-planets.json.
 *
 * Source: NASA/JPL Small-Body Database Query API -- every NAMED minor planet
 * (26,455 of them as of 2026-09). Free, unauthenticated, one request.
 *
 * Run occasionally, not on a timer: the IAU names a few hundred minor
 * planets a year, so a stale corpus is a corpus missing this year's names,
 * never a wrong one. The bot only READS the file it writes.
 *
 * Usage: node scripts/fetch-lore-corpus.ts [--out data/lore/minor-planets.json]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fetchJson } from "../src/util/http.ts";
import { normalize } from "../src/util/text.ts";
import { FUNCTION_WORDS } from "../src/scoring/filters.ts";
import type { LoreEntry } from "../src/lore/corpus.ts";

const argv = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const OUT = arg("out", "data/lore/minor-planets.json");

// Ask only for named objects: sb-cdata's "name|DF" means "name is defined".
const API =
  "https://ssd-api.jpl.nasa.gov/sbdb_query.api" +
  "?fields=full_name,name,class,diameter" +
  "&sb-kind=a" +
  '&sb-cdata={"AND":["name|DF"]}';

/** JPL orbit-class codes, spelled out for a human reading a coin page. */
const CLASS_NAMES: Record<string, string> = {
  MBA: "main-belt asteroid",
  IMB: "inner main-belt asteroid",
  OMB: "outer main-belt asteroid",
  MCA: "Mars-crossing asteroid",
  APO: "Apollo near-Earth asteroid",
  AMO: "Amor near-Earth asteroid",
  ATE: "Aten near-Earth asteroid",
  IEO: "Atira near-Earth asteroid",
  TJN: "Jupiter trojan",
  CEN: "centaur",
  TNO: "trans-Neptunian object",
  AST: "asteroid",
  PAA: "asteroid on a parabolic orbit",
  HYA: "asteroid on a hyperbolic orbit",
};

type QueryResponse = { count?: number; fields?: string[]; data?: string[][] };

function factFor(num: string, name: string, cls: string, diameter: string | null): string {
  const kind = CLASS_NAMES[cls] ?? "minor planet";
  const bits: string[] = [`${num} ${name} is a ${kind}`];
  const km = diameter ? Number(diameter) : NaN;
  if (Number.isFinite(km) && km > 0) {
    bits.push(km >= 10 ? `about ${Math.round(km)} km across`
                       : `about ${km.toFixed(1)} km across`);
  }
  // NO discovery year. JPL's `first_obs` is the start of the observation arc
  // in the current orbit solution, not the discovery: it reports 1995 for
  // Ceres, discovered in 1801. Publishing it as a discovery date would put an
  // unverified value straight onto a coin page -- the exact bug family in
  // DECISIONS #39-#43. Name, class and size are all directly stated.
  return bits.join(", ") + ".";
}

async function main(): Promise<void> {
  process.stdout.write("fetching named minor planets from JPL...\n");
  const json = await fetchJson<QueryResponse>(API, { timeoutMs: 120_000, retries: 2 });
  const fields = json.fields ?? [];
  const idx = (f: string) => fields.indexOf(f);
  const iFull = idx("full_name"), iName = idx("name"), iClass = idx("class");
  const iDia = idx("diameter");
  if (iFull < 0 || iName < 0) throw new Error(`unexpected fields: ${fields.join(",")}`);

  const entries: LoreEntry[] = [];
  let skippedFunctionWord = 0, skippedShape = 0;

  for (const row of json.data ?? []) {
    const full = (row[iFull] ?? "").trim();
    const name = (row[iName] ?? "").trim();
    if (!name) continue;

    const num = full.split(/\s+/)[0] ?? "";
    if (!/^\d+$/.test(num)) { skippedShape++; continue; }

    const key = normalize(name).trim();
    // A name that is only a function word ("Yes", "Now", "The") would attach
    // trivia to precisely the contentless terms isMeaninglessTerm() exists to
    // reject. Drop them at build time so the lookup can stay simple.
    if (!key || FUNCTION_WORDS.has(key)) { skippedFunctionWord++; continue; }
    // Single letters and pure punctuation are not lookups anyone wants.
    if (key.length < 3) { skippedShape++; continue; }

    entries.push({
      source: "minorPlanet",
      key,
      title: `${num} ${name}`,
      name,
      fact: factFor(num, name, row[iClass] ?? "", row[iDia] ?? null),
      // The MPC page is server-rendered, so it is a link a human can actually
      // click and read -- JPL's own lookup tool is a JS app that renders
      // nothing without scripting.
      url: `https://www.minorplanetcenter.net/db_search/show_object?object_id=${num}`,
      rank: Number(num),
    });
  }

  entries.sort((a, b) => a.rank - b.rank);
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({
    version: 1,
    source: "NASA/JPL Small-Body Database",
    sourceUrl: "https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html",
    fetchedAt: new Date().toISOString(),
    entries,
  }, null, 0) + "\n");

  process.stdout.write(
    `wrote ${entries.length} entries to ${OUT}\n` +
    `  skipped ${skippedFunctionWord} function-word names, ${skippedShape} malformed\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`fetch-lore-corpus failed: ${String(e)}\n`);
  process.exit(1);
});
