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

if (dupes.length) {
  console.log(`\nFAILED: ${dupes.length} feature code(s) are defined more than once.`);
  console.log("The seeder upserts on code, so the later definition silently replaces the");
  console.log("earlier one: that feature is never stored, and it inherits the other row's tests.");
  for (const [code, list] of dupes) {
    console.log(`  ${code}:`);
    for (const r of list) console.log(`    - ${r.file} [${r.family}]`);
  }
  process.exit(1);
}
console.log(`\n${by.size} passed, 0 failed`);
