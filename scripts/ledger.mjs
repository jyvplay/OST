/**
 * Ledger generator. Joins the live feature register (/api/features) with the
 * machine-readable results of every suite in docs/test-results/*.json and
 * writes:
 *   docs/LEDGER.md              — human-readable counts + per-row table
 *   src/data/coverage.json      — consumed by /api/ledger and the Spec module
 *
 * Definitions (applied mechanically, no hand edits):
 *   Fully built      = register status "built"
 *   Partially built  = status "partial" or "probe" (probe = runs end to end only
 *                      where the browser exposes the API)
 *   Not buildable    = status "blocked" (platform impossibility, reason rendered)
 *   Fully tested     = at least one PASSING test tags the row "full"
 *   Partially tested = only "partial" tags among passing tests
 *   Untested         = no passing test tags the row
 *   A failing test contributes nothing; rows touched only by failing tests are
 *   listed separately so a regression is visible, not silently counted.
 *
 * Run: BASE=http://localhost:3999 node scripts/ledger.mjs
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const BASE = process.env.BASE ?? "http://localhost:3999";
const reg = await (await fetch(`${BASE}/api/features`)).json();
const rows = reg.rows;

const suites = readdirSync("docs/test-results").filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(`docs/test-results/${f}`, "utf8")));

const cov = new Map();          // code -> { level, tests[] }
const failingTouch = new Map(); // code -> [test names]
const unknownCodes = new Set();
const codes = new Set(rows.map((r) => r.code));
let totalTests = 0, passedTests = 0;

for (const s of suites) {
  for (const t of s.results) {
    totalTests += 1;
    if (t.pass) passedTests += 1;
    for (const [code, level] of Object.entries(t.covers)) {
      if (!codes.has(code)) { unknownCodes.add(code); continue; }
      if (!t.pass) { failingTouch.set(code, [...(failingTouch.get(code) ?? []), `${s.suite}: ${t.name}`]); continue; }
      const cur = cov.get(code) ?? { level: "partial", tests: [] };
      if (level === "full") cur.level = "full";
      cur.tests.push(`${s.suite}: ${t.name}`);
      cov.set(code, cur);
    }
  }
}
if (unknownCodes.size) { console.error("Tests reference unknown feature codes:", [...unknownCodes].join(", ")); process.exit(1); }

const testLevel = (code) => cov.get(code)?.level ?? "untested";
const buildClass = (st) => (st === "built" ? "full" : st === "partial" || st === "probe" ? "partial" : st === "blocked" ? "blocked" : "none");

const count = (pred) => rows.filter(pred).length;
const built = { full: count((r) => buildClass(r.status) === "full"), partial: count((r) => buildClass(r.status) === "partial"), blocked: count((r) => r.status === "blocked"), none: count((r) => buildClass(r.status) === "none") };
const tested = { full: count((r) => testLevel(r.code) === "full"), partial: count((r) => testLevel(r.code) === "partial"), untested: count((r) => testLevel(r.code) === "untested") };

const matrix = {};
for (const b of ["full", "partial", "blocked", "none"]) for (const t of ["full", "partial", "untested"])
  matrix[`${b}|${t}`] = count((r) => buildClass(r.status) === b && testLevel(r.code) === t);

const families = [...new Set(rows.map((r) => r.family))];
const famRows = families.map((f) => {
  const fr = rows.filter((r) => r.family === f);
  const c = (p) => fr.filter(p).length;
  return `| ${f} | ${fr.length} | ${c((r) => r.status === "built")} | ${c((r) => r.status === "partial" || r.status === "probe")} | ${c((r) => r.status === "blocked")} | ${c((r) => testLevel(r.code) === "full")} | ${c((r) => testLevel(r.code) === "partial")} | ${c((r) => testLevel(r.code) === "untested")} |`;
});

const suiteLines = suites.map((s) => {
  const p = s.results.filter((r) => r.pass).length;
  return `| ${s.suite} | ${s.results.length} | ${p} | ${s.results.length - p} | ${s.at} |`;
});

const md = `# Fusion Shell Web — build / test ledger (generated)

Generated ${new Date().toISOString()} by \`scripts/ledger.mjs\` from the live register (${BASE}) and
${suites.length} machine-readable suite result files in \`docs/test-results/\`. Nothing in the counts is hand-edited.

## Headline

| | Count |
|---|---:|
| **Features in register** | **${rows.length}** |
| Fully built | ${built.full} |
| Partially built (partial ${count((r) => r.status === "partial")} + probe ${count((r) => r.status === "probe")}) | ${built.partial} |
| Not buildable on this platform (blocked, reason rendered in UI) | ${built.blocked} |
| Not built at all (skeleton) | ${built.none} |
| **Fully tested** (≥1 passing test tagged \`full\`) | **${tested.full}** |
| **Partially tested** (only \`partial\` tags) | **${tested.partial}** |
| Untested | ${tested.untested} |
| Automated tests executed / passed | ${totalTests} / ${passedTests} |

## Build × test matrix

| build \\ test | fully tested | partially tested | untested |
|---|---:|---:|---:|
| fully built | ${matrix["full|full"]} | ${matrix["full|partial"]} | ${matrix["full|untested"]} |
| partially built | ${matrix["partial|full"]} | ${matrix["partial|partial"]} | ${matrix["partial|untested"]} |
| blocked | ${matrix["blocked|full"]} | ${matrix["blocked|partial"]} | ${matrix["blocked|untested"]} |
| skeleton | ${matrix["none|full"]} | ${matrix["none|partial"]} | ${matrix["none|untested"]} |

"Blocked + fully tested" means a test asserts that the UI renders the platform-impossibility reason — it
verifies the honesty contract, not the (impossible) capability.

## Suites

| suite | tests | passed | failed | ran at |
|---|---:|---:|---:|---|
${suiteLines.join("\n")}

${failingTouch.size ? `## Rows touched by FAILING tests (not counted as tested)\n\n${[...failingTouch].map(([c, t]) => `- ${c}: ${t.join("; ")}`).join("\n")}\n` : "## Rows touched by failing tests\n\nNone.\n"}
## By family

| family | rows | built | partial+probe | blocked | fully tested | partially tested | untested |
|---|---:|---:|---:|---:|---:|---:|---:|
${famRows.join("\n")}

## Per-row detail

| code | status | tested | evidence (passing tests) |
|---|---|---|---|
${rows.map((r) => `| ${r.code} | ${r.status} | ${testLevel(r.code)} | ${(cov.get(r.code)?.tests ?? []).slice(0, 3).join("; ").replace(/\|/g, "/")}${(cov.get(r.code)?.tests.length ?? 0) > 3 ? ` (+${cov.get(r.code).tests.length - 3})` : ""} |`).join("\n")}

## Definitions

- **Fully built** = register status \`built\`: runs end to end in this build against real browser/DB APIs.
- **Partially built** = \`partial\` (a named sub-capability is degraded) or \`probe\` (runs only where the browser exposes the API).
- **Fully tested** = a passing automated test exercises the row's primary contract end to end at the layer where it lives (pure library / server over HTTP / UI in real headless Chromium 131) including at least one negative or adversarial assertion.
- **Partially tested** = passing tests exercise only part of the row (e.g. the module mounts without error, or only the server half is exercised).
- Mount-only smoke tests tag a module's rows \`partial\`: rendering without an uncaught error is evidence of integration, not of function.
`;

writeFileSync("docs/LEDGER.md", md);
mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/coverage.json", JSON.stringify({
  generatedAt: new Date().toISOString(), totals: { built, tested, tests: { total: totalTests, passed: passedTests } },
  rows: Object.fromEntries(rows.map((r) => [r.code, { tested: testLevel(r.code), tests: cov.get(r.code)?.tests ?? [] }])),
}, null, 1));
console.log(JSON.stringify({ features: rows.length, built, tested, tests: `${passedTests}/${totalTests}`, failingTouch: failingTouch.size }, null, 1));
