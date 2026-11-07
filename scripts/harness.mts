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
import { mkdirSync, writeFileSync } from "node:fs";

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
    if (!only) writeFileSync(`docs/test-results/${suite}.json`, JSON.stringify({ suite, at: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.pass);
    const testMs = results.reduce((n, r) => n + r.ms, 0);
    const slowest = results.slice().sort((a, b) => b.ms - a.ms)[0];
    const startupMs = Math.round(performance.now() - testMs);
    console.log(`\n TIMING tests=${testMs}ms startup+imports=${startupMs}ms total=${Math.round(performance.now())}ms slowest=${slowest ? `${slowest.name} (${slowest.ms}ms)` : "none"}`);
    console.log(`${results.length - failed.length} passed, ${failed.length} failed`);
    if (!results.length) { console.log("FAILED: no tests selected"); process.exitCode = 1; }
    if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(" | ")); process.exitCode = 1; }
  };
  return { test, finish };
}
