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
  const test = async (name: string, covers: Covers, fn: () => unknown | Promise<unknown>) => {
    const t0 = performance.now();
    try {
      await fn();
      results.push({ suite, name, covers, pass: true, ms: Math.round(performance.now() - t0) });
      console.log(`  ✓ ${name}`);
    } catch (e) {
      const error = (e as Error).message;
      results.push({ suite, name, covers, pass: false, error, ms: Math.round(performance.now() - t0) });
      console.log(`  ✗ ${name}\n    ${error}`);
    }
  };
  const finish = () => {
    mkdirSync("docs/test-results", { recursive: true });
    writeFileSync(`docs/test-results/${suite}.json`, JSON.stringify({ suite, at: new Date().toISOString(), results }, null, 2));
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
    if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(" | ")); process.exitCode = 1; }
  };
  return { test, finish };
}
