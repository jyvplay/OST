/**
 * Shared test harness. Every test declares which register rows it covers and
 * at what level:
 *   full    — exercises the row's primary contract end to end at the layer where
 *             it lives (pure lib directly / server via HTTP / UI in real Chromium),
 *             including at least one negative or adversarial assertion
 *   partial — exercises one component of the row (e.g. only the server half of a
 *             UI feature, or one sub-capability), or happy path only
 * Results are written to docs/test-results/<suite>.json; scripts/ledger.mjs joins
 * them with the live register. A row counts as tested only if the test PASSED.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Write the results file only when it would actually change.
 *
 * Every suite rewrote its JSON on every run even when nothing had changed, and
 * the gate runs ~40 suites: that is 40 sync writes plus 40 dirtied files in a
 * git working tree, for bytes that were already on disk. Comparing the new
 * serialisation against the existing one turns a no-op run into a no-op write,
 * which is both faster and stops `git status` filling with timestamp-only
 * diffs. `at` is deliberately excluded from the comparison so a run that
 * changed no result is still reported as unchanged.
 */
function writeIfChanged(path: string, body: string): boolean {
  try {
    const prev = readFileSync(path, "utf8");
    const strip = (t: string) => t.replace(/"at": "[^"]*",\n?/, "");
    if (strip(prev) === strip(body)) return false;
  } catch {
    // No previous file: fall through to the write.
  }
  writeFileSync(path, body);
  return true;
}

export type Level = "full" | "partial";
export type Covers = Record<string, Level>;
interface Result { suite: string; name: string; covers: Covers; pass: boolean; error?: string; ms: number }

export function makeHarness(suite: string) {
  const results: Result[] = [];
  // HARNESS_ONLY=prefix[,prefix] runs a subset (mutation runs); such a partial run never writes the results file
  const only = process.env.HARNESS_ONLY;
  const test = async (name: string, covers: Covers, fn: () => unknown | Promise<unknown>) => {
    if (only && !only.split(",").some((p) => name.startsWith(p))) return;
    const t0 = performance.now();
    try {
      await fn();
      results.push({ suite, name, covers, pass: true, ms: Math.round(performance.now() - t0) });
      console.log(`  ✓ ${name}`);
    } catch (e) {
      const error = (e as Error).message; if (process.env.HARNESS_STACK) console.log((e as Error).stack);
      results.push({ suite, name, covers, pass: false, error, ms: Math.round(performance.now() - t0) });
      console.log(`  ✗ ${name}\n    ${error}`);
    }
  };
  /**
   * TT143: where the time actually goes.
   *
   * A suite's total wall time is not its test time: imports, the first reducer
   * call and the process itself all cost, and a "faster" claim without a split
   * cannot say which one changed. `finish` therefore reports the per-test sum,
   * the largest test, and the process's own startup, so a speed change can be
   * attributed instead of asserted.
   */
  const finish = () => {
    mkdirSync("docs/test-results", { recursive: true });
    if (!only) writeIfChanged(`docs/test-results/${suite}.json`, JSON.stringify({ suite, at: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.pass);
    /**
     * Where the wall time went — merged from both branches (TT143 + main).
     *
     * `tests` is the sum of the assertions, and `startup+imports` is everything
     * else the process paid, which is the split that makes a speed claim
     * attributable: a suite whose test time is flat but whose wall time moved is
     * telling you the loader changed, not the code under test. The per-test
     * breakdown prints only when it is worth reading, so a 5 ms suite stays quiet.
     */
    const testMs = results.reduce((n, r) => n + r.ms, 0);
    const total = Math.round(performance.now());
    console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
    console.log(` TIMING tests=${testMs}ms startup+imports=${total - testMs}ms total=${total}ms`);
    if (testMs >= 30) {
      const slowest = [...results].sort((a, b) => b.ms - a.ms).slice(0, 3).filter((r) => r.ms >= 5);
      if (slowest.length) console.log(`slowest: ${slowest.map((r) => `${r.ms}ms ${r.name.slice(0, 46)}`).join(" | ")}`);
    }
    if (!results.length) { console.log("FAILED: no tests selected"); process.exitCode = 1; }
    if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(" | ")); process.exitCode = 1; }
  };
  return { test, finish };
}
