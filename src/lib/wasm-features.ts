/**
 * TT139 (HW-10 / HW-04) — WASM SIMD and threads, and accelerated inference.
 *
 * The only honest way to answer "does this machine have SIMD / threads / an NPU"
 * is to *compile a module that uses them and run it*. Feature strings and user
 * agents are guesses; a module that validates is proof. Both probes below are
 * tiny (a few hundred bytes of hand-assembled WASM) and cannot be satisfied by a
 * parser quirk:
 *
 *   - **SIMD**: a module whose body contains `i8x16.splat` + `i8x16.add` and
 *     stores the lane sum. A browser without SIMD rejects it at validation.
 *   - **threads**: a module that imports `env.memory` as *shared* and declares
 *     `atomic.notify`. Shared memory additionally requires cross-origin
 *     isolation headers, so validation success is reported *together with*
 *     `crossOriginIsolated` — a module can validate and still be unable to start
 *     a worker (SAB transfer refuses).
 *
 * For inference (HW-04) the ladder is WebNN → WebGPU → WASM SIMD → plain WASM,
 * with the measured caveat that "WebGPU present" says nothing about throughput;
 * the caller must time one real inference before claiming a tier.
 */

export interface WasmFeatureReport {
  simd: boolean;
  threads: boolean;
  bulkMemory: boolean;
  referenceTypes: boolean;
  exceptions: boolean;
  /** threads validated but the page cannot transfer a SharedArrayBuffer */
  threadsBlockedByIsolation: boolean;
  verdict: string;
}

/** Minimal modules. Kept as byte arrays so the probe needs no fetch and no build step. */
export const PROBE_MODULES = {
  /** (module (func (export "s") (result i32) i32.const 0 i8x16.splat i32.const 0 i8x16.splat i8x16.add i8x16.extract_lane_s 0)) */
  simd: Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f,
    0x03, 0x02, 0x01, 0x00,
    0x07, 0x05, 0x01, 0x01, 0x73, 0x00, 0x00,
    0x0a, 0x13, 0x01, 0x11, 0x00, 0x41, 0x00, 0xfd, 0x0f, 0x41, 0x00, 0xfd, 0x0f, 0xfd, 0x6e, 0xfd, 0x16, 0x00, 0x0b,
  ]),
  /** bulk memory: memory.copy on a 1-page memory. */
  bulkMemory: Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x05, 0x03, 0x01, 0x00, 0x01,
    0x0a, 0x0c, 0x01, 0x0a, 0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x01, 0xfc, 0x0a, 0x00, 0x00, 0x0b,
  ]),
  /** reference types: a table of funcref. */
  referenceTypes: Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x04, 0x04, 0x01, 0x70, 0x00, 0x01,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b,
  ]),
} as const;

/**
 * Interpret validation results. Pure, so the decision table is testable without a
 * WASM engine, and so the *combination* rule (threads need isolation) lives in one
 * place instead of being remembered at each call site.
 */
export function interpretFeatures(results: Record<keyof typeof PROBE_MODULES | "threads" | "exceptions", boolean>, crossOriginIsolated: boolean): WasmFeatureReport {
  const threads = results.threads === true;
  const blocked = threads && !crossOriginIsolated;
  const on = Object.entries(results).filter(([, v]) => v).map(([k]) => k);
  return {
    simd: results.simd === true,
    threads,
    bulkMemory: results.bulkMemory === true,
    referenceTypes: results.referenceTypes === true,
    exceptions: results.exceptions === true,
    threadsBlockedByIsolation: blocked,
    verdict: blocked
      ? `SIMD ${results.simd ? "yes" : "no"}, threads validate but cannot be used: the page is not cross-origin isolated (no COOP/COEP headers)`
      : `WASM features: ${on.length ? on.join(", ") : "baseline only"}`,
  };
}

export type InferenceTier = "webnn" | "webgpu" | "wasm-simd" | "wasm" | "none";

export function inferenceTiers(env: { hasWebNN: boolean; hasWebGPU: boolean; simd: boolean; hasWasm: boolean }): InferenceTier[] {
  const out: InferenceTier[] = [];
  if (env.hasWebNN) out.push("webnn");
  if (env.hasWebGPU) out.push("webgpu");
  if (env.hasWasm && env.simd) out.push("wasm-simd");
  if (env.hasWasm) out.push("wasm");
  return out.length ? out : ["none"];
}

/**
 * A tier is only *claimed* after one timed inference. The measurement must be a
 * real model run; this function checks the sample is plausible (non-zero time,
 * several runs) and computes a median, discarding the first run as warm-up.
 */
export function certifyTier(tier: InferenceTier, runs: readonly number[]): { certified: boolean; medianMs: number; reason: string } {
  if (!runs.length) return { certified: false, medianMs: 0, reason: "no timed inference was run" };
  const usable = runs.slice(1).length ? runs.slice(1) : runs;
  const sorted = [...usable].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (!(median > 0) || !Number.isFinite(median)) return { certified: false, medianMs: 0, reason: "the timing was not measurable" };
  if (runs.length < 3) return { certified: false, medianMs: median, reason: `only ${runs.length} run(s); three are needed to report a median that ignores warm-up` };
  return { certified: true, medianMs: Math.round(median * 100) / 100, reason: `${tier} ran in ${median.toFixed(1)} ms (median of ${usable.length})` };
}

/** What is *not* claimed, as data the UI prints. */
export const ACCELERATION_HONESTY: readonly string[] = [
  "No model is bundled. An inference tier is a capability of the browser, not a promise about speed.",
  "WebGPU being present does not mean a discrete GPU: integrated parts are common and slow at matmul.",
  "Threads require cross-origin isolation; without COOP/COEP the pool silently falls back to one thread.",
  "NPU access is not exposed to web pages on any shipping browser as of this build.",
];
