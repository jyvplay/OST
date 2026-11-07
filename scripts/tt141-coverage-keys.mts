/**
 * TT141 — coverage-key contract.
 *
 * The ledger credits a feature row from `docs/test-results/*.json`: a row counts
 * as tested only if some PASSING result declares that code under `covers`.
 *
 * The bug this exists to prevent, found in TT141: 126 test declarations across
 * four suites were written as
 *
 *     await test("HW-09 · ...", { CODE: "HW-09" }, () => ...)
 *
 * `CODE` is not a defined identifier, so the object literal evaluates its VALUE
 * (undefined) as the property key and produces `{ "CODE": "HW-09" }`. The suite
 * still PASSED — assertions ran and were reported — but the feature code was
 * buried in a key called CODE, so the ledger could not see that HW-09 had any
 * coverage. 126 tests were invisible for however many turns it took to notice.
 *
 * This check reads every result file and fails if any `covers` key is not a
 * feature code. An empty `covers` object is allowed: a suite-level harness test
 * legitimately covers no single feature. A MALFORMED key is never allowed,
 * because it is always a typo that silently loses coverage.
 */
import { readdirSync, readFileSync } from "node:fs";

const CODE = /^[A-Z]{2,3}-[0-9]{2}[a-z]?$/;
const dir = "docs/test-results";

let files = 0;
let rows = 0;
let emptyCovers = 0;
const malformed = new Map<string, number>();

for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
  let parsed: { results?: Array<{ covers?: Record<string, string> }> };
  try {
    parsed = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
  } catch {
    // A result file the harness is mid-write is not this check's business.
    continue;
  }
  if (!Array.isArray(parsed.results)) continue;
  files++;
  for (const r of parsed.results) {
    rows++;
    const keys = Object.keys(r.covers ?? {});
    if (keys.length === 0) {
      emptyCovers++;
      continue;
    }
    for (const k of keys) {
      if (!CODE.test(k)) {
        const id = `${name} → "${k}"`;
        malformed.set(id, (malformed.get(id) ?? 0) + 1);
      }
    }
  }
}

const total = [...malformed.values()].reduce((a, b) => a + b, 0);
console.log(JSON.stringify({ suite: "tt141-coverage-keys", files, rows, emptyCovers, malformed: total }, null, 0));

if (total > 0) {
  console.log(`\nFAILED: ${total} coverage key(s) are not feature codes. A result that names its coverage`);
  console.log("wrongly is a test the ledger cannot count, so the feature looks untested forever.");
  for (const [id, n] of [...malformed.entries()].slice(0, 20)) console.log(`  - ${id} ×${n}`);
  process.exit(1);
}
console.log(`\n${files} passed, 0 failed`);
