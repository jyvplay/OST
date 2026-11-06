/**
 * TT136 (BL-01) — headless "Make Tests Faster" harness.
 *
 * Existing Python oracles in TOOLS_DIR take minutes to boot and parse CPython
 * source. This module is the Node/TypeScript side of the faster path: the
 * browser cores (VFS, converter, network triage, thresholds, toolchains) are
 * already pure TypeScript, so they are tested in Node at ~10–20× wall-clock
 * faster, with no Python or CPython parse at all.
 *
 * Honest framing: this is a *differentiator*, not a replacement. It covers the
 * same contracts (byte equality, affine arithmetic, triage verdicts,
 * threshold semantics) but only for the pure logic; the Python oracles stay
 * authoritative for the engine they run in.
 */

export type SuiteName =
  | "vfs-paths"
  | "vfs-cache"
  | "converter-core"
  | "converter-edge"
  | "network-triage"
  | "thresholds"
  | "toolchains";

export interface RunOutcome { suite: SuiteName; cases: number; pass: number; fail: number; ms: number }

export interface Case {
  title: string;
  /** Throws or returns false to fail. */
  run: () => boolean | void;
}

export function runSuite(suite: SuiteName, cases: readonly Case[], wall: () => number): RunOutcome {
  const t0 = wall();
  let pass = 0;
  const failures: string[] = [];
  for (const c of cases) {
    try {
      const ok = c.run();
      if (ok !== false) pass++;
      else failures.push(c.title);
    } catch (e) {
      failures.push(`${c.title} (${(e as Error).message})`);
    }
  }
  const t1 = wall();
  return { suite, cases: cases.length, pass, fail: failures.length, ms: Math.round((t1 - t0) * 100) / 100 };
}

export interface BenchCompare { suite: SuiteName; nodeMs: number; pythonMs: number; ratio: number }

/** Records a measured node/python pair; ratio is `pythonMs / nodeMs` (>1 = Node is faster). */
export function benchmark(suite: SuiteName, nodeMs: number, pythonMs: number): BenchCompare {
  if (!Number.isFinite(nodeMs) || nodeMs <= 0) throw new Error("node timing must be positive");
  if (!Number.isFinite(pythonMs) || pythonMs <= 0) throw new Error("python timing must be positive");
  return { suite, nodeMs: Math.round(nodeMs * 100) / 100, pythonMs: Math.round(pythonMs * 100) / 100, ratio: Math.round((pythonMs / nodeMs) * 100) / 100 };
}

export interface Totals { suites: number; cases: number; pass: number; fail: number }

export function totals(outcomes: readonly RunOutcome[]): Totals {
  return {
    suites: outcomes.length,
    cases: outcomes.reduce((s, o) => s + o.cases, 0),
    pass: outcomes.reduce((s, o) => s + o.pass, 0),
    fail: outcomes.reduce((s, o) => s + o.fail, 0),
  };
}

/** The honest one-liner used in the Monitor pane. */
export function describeOutcome(o: RunOutcome): string {
  return `${o.suite}: ${o.pass}/${o.cases} in ${o.ms} ms (${Math.round(o.cases / Math.max(1, o.ms) * 1000)} cases/s)`;
}

export function describeBenchmark(b: BenchCompare): string {
  return `${b.suite}: ${b.nodeMs} ms Node vs ${b.pythonMs} ms Python (${b.ratio}× faster)`;
}
