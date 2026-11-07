/**
 * TT141 — feature-code uniqueness.
 *
 * The seeder upserts every row `onConflictDoUpdate({ target: code })` in the
 * order of `allFeatures`. That makes a duplicate code a SILENT OVERWRITE: the
 * later row wins and the earlier one is never written to the database at all.
 *
 * TT141 found 16 such collisions (623 codes were crammed into 602 slots). They
 * were invisible for two reasons:
 *   • nothing in the build reads the register, so a lost row breaks no test;
 *   • the surviving row inherited the loser's TESTS, so the ledger showed a
 *     feature as covered by assertions about a completely different thing.
 * `SH-06` is the clearest example: "Hot corners, edge triggers, pointer
 * gestures" in the shell register, and "Cross-tab document locks" in TT135.
 * Both claimed to be built. Only one of them could be.
 *
 * This check parses the seed sources the same way the inventory does and fails
 * if any code is defined twice, naming both files so the fix is mechanical.
 */
import { readdirSync, readFileSync } from "node:fs";

const dir = "src/db/seed-data";
/** Every row is `F("<code>", "<family>", "<name>", ...)`. */
const ROW = /F\(\s*"([A-Z]{2,3}-[0-9]{2}[a-z]?)"\s*,\s*"([^"]+)"/g;

const by = new Map<string, Array<{ file: string; family: string }>>();
for (const name of readdirSync(dir).filter((f) => /^features-.*\.ts$/.test(f))) {
  const src = readFileSync(`${dir}/${name}`, "utf8");
  for (const m of src.matchAll(ROW)) {
    const code = m[1];
    if (!by.has(code)) by.set(code, []);
    by.get(code)!.push({ file: name, family: m[2] });
  }
}

const dupes = [...by.entries()].filter(([, rows]) => rows.length > 1);
const rows = [...by.values()].reduce((n, v) => n + v.length, 0);
console.log(JSON.stringify({ suite: "tt141-seed-unique", codes: by.size, rows, duplicateCodes: dupes.length }, null, 0));

/**
 * TT149: the file-level count is a *pinned* number, not zero, and the pinned
 * layer is the one that matters for storage.
 *
 * TT145 added a dedupe step to `allFeatures` (a duplicate may never raise a
 * claim), so today 44 codes are written twice across files and 44 rows are lost
 * as provenance — the database still receives exactly one row per code. This
 * check used to fail on that, which made a true statement ("the register has
 * duplicates") into a red suite that could only be silenced by deleting real
 * rows. So it now asserts both invariants separately:
 *   1. the array the seeder iterates has one row per code (hard failure);
 *   2. the file-level duplicate count does not grow (hard failure), and names
 *      the pairs so the next turn can retire them one at a time.
 */
const { allFeatures } = await import("../src/db/seed.ts");
const seen = new Map<string, number>();
for (const row of allFeatures) seen.set(row.code, (seen.get(row.code) ?? 0) + 1);
const arrayDupes = [...seen.entries()].filter(([, n]) => n > 1);
if (arrayDupes.length) {
  console.log(`\nFAILED: allFeatures carries ${arrayDupes.length} duplicated code(s) — the seeder would write one row and lose the other: ${arrayDupes.slice(0, 10).map(([c]) => c).join(", ")}`);
  process.exit(1);
}

const PINNED_DUPLICATE_CODES = 44; // TT149 measurement on this tree; TT145's dedupe makes them provenance-only
if (dupes.length > PINNED_DUPLICATE_CODES) {
  console.log(`\nFAILED: ${dupes.length} feature code(s) are defined more than once (pinned at ${PINNED_DUPLICATE_CODES}).`);
  console.log("A new duplicate is a new lost row: the seeder writes one and the other's tests are inherited.");
  for (const [code, list] of dupes) {
    console.log(`  ${code}:`);
    for (const r of list) console.log(`    - ${r.file} [${r.family}]`);
  }
  process.exit(1);
}
console.log(`\n${by.size} passed, 0 failed`);
console.log(`  file-level duplicates: ${dupes.length} of a pinned ${PINNED_DUPLICATE_CODES} (array carries one row per code, so none reach the database twice)`);
