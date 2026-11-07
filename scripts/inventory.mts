/**
 * Feature register inventory — run the REAL patch chain and report.
 *
 * `src/db/seed-data/*.ts` cannot be trusted on its own: a row's literal
 * `status` string is the value BEFORE any patch runs, and the patch chain in
 * `src/db/seed.ts` (TT39..TT141) is what the app actually seeds. A row written
 * as "skeleton" may be promoted to "built" by a later patch, and — the mistake
 * this tool exists to prevent — a patch placed BEFORE the UPDATES_* tables is
 * silently reverted, so the string in the file and the row in the database
 * disagree.
 *
 * The only honest reading is to execute the chain, which is what this does. It
 * imports the real `allFeatures` from `src/db/seed.ts` (which constructs the
 * database client but never connects), so DATABASE_URL must merely be set to
 * something parseable.
 *
 *   DATABASE_URL=postgresql://u:p@127.0.0.1:5432/none \
 *     node --experimental-strip-types --no-warnings \
 *       --import ./scripts/register-hook.mjs scripts/inventory.mts [--all]
 */
import { allFeatures, RETIRED_FEATURE_CODES } from "../src/db/seed";

const args = new Set(process.argv.slice(2));
const rows = allFeatures as Array<{
  code: string; family: string; name: string; tier: string;
  status: string; nuance?: string; test?: string; route?: string;
}>;

const byCode = new Map<string, (typeof rows)[number]>();
const dupes: string[] = [];
for (const r of rows) {
  if (byCode.has(r.code)) dupes.push(r.code);
  byCode.set(r.code, r);
}

const nonBuilt = rows.filter((r) => r.status !== "built");
const tiers = new Map<string, { total: number; built: number }>();
for (const r of rows) {
  const t = tiers.get(r.tier) ?? { total: 0, built: 0 };
  t.total++;
  if (r.status === "built") t.built++;
  tiers.set(r.tier, t);
}
const fams = new Map<string, number>();
for (const r of nonBuilt) fams.set(r.family, (fams.get(r.family) ?? 0) + 1);

const pct = (n: number, d: number) => (d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`);

console.log(`rows=${rows.length} distinct=${byCode.size} built=${rows.length - nonBuilt.length} nonBuilt=${nonBuilt.length} ` +
  `(${pct(rows.length - nonBuilt.length, rows.length)} built)`);
if (dupes.length) console.log(`DUPLICATE CODES: ${[...new Set(dupes)].join(", ")}`);
if (RETIRED_FEATURE_CODES.length) console.log(`retired: ${RETIRED_FEATURE_CODES.join(", ")}`);

console.log("\nby tier:");
for (const [t, v] of [...tiers.entries()].sort()) {
  console.log(`  ${t.padEnd(4)} ${String(v.built).padStart(3)}/${String(v.total).padEnd(3)} built  ${pct(v.built, v.total)}`);
}

console.log("\nnon-built by family:");
const famLine = [...fams.entries()].sort().map(([k, v]) => `${k}:${v}`).join(" ");
console.log("  " + famLine);

if (args.has("--all")) {
  console.log("\nall non-built rows:");
  for (const r of [...nonBuilt].sort((a, b) => a.family.localeCompare(b.family) || a.code.localeCompare(b.code))) {
    const honest = /blocked/.test(r.status) ? "  (platform-impossible)" : "";
    console.log(`  ${r.code.padEnd(8)} ${r.status.padEnd(9)} ${r.tier.padEnd(4)} ${r.name.slice(0, 54)}${honest}`);
  }
}

// A non-built row that CLAIMS a test citation is the shape of a dishonest row.
const suspicious = nonBuilt.filter((r) => (r.test ?? "").trim().length > 0);
if (suspicious.length) {
  console.log(`\nnon-built rows that still cite a test (should usually be built): ${suspicious.map((r) => r.code).join(", ")}`);
}
// A built row with no stated limit is the shape of an overclaim.
const unqualified = rows.filter((r) => r.status === "built" && (r.nuance ?? "").trim().length < 40);
if (unqualified.length) {
  console.log(`\nbuilt rows with no meaningful nuance: ${unqualified.length} (${unqualified.slice(0, 12).map((r) => r.code).join(", ")}${unqualified.length > 12 ? "…" : ""})`);
}
