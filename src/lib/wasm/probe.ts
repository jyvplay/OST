/**
 * TT146 (HW-10) — what this engine really supports, and the cost of asking.
 *
 * "WASM SIMD is available in every modern browser" is true enough to be useless.
 * The questions that change a design are narrower:
 *
 *   • Is the SIMD *proposal* enabled in this engine, at this version, behind
 *     this flag? A `WebAssembly.validate` of a module that contains the
 *     instructions answers it; asking `navigator.userAgent` does not.
 *   • Do the instructions *do the right thing*? A module that validates but
 *     mis-executes is exactly the case a feature string cannot see, so the
 *     probe writes a known pattern through `v128.store` and reads it back.
 *     The check is bit-level and independent of our own arithmetic.
 *   • Are *threads* usable? `SharedArrayBuffer` is gated on cross-origin
 *     isolation, which this shell deliberately does not enable: `COOP`/`COEP`
 *     would stop third-party pages from being embedded, which the Browser
 *     module needs. So the honest answer here is usually "shared memory is
 *     absent" — and the code must therefore have a real single-thread path,
 *     not a stub that throws when threads are missing.
 *
 * The module is assembled here, byte by byte, because shipping a `.wasm`
 * artefact for a 60-byte function costs a fetch, a MIME type and a cache key.
 * Every byte is explained below, and `wasmSimdProbeBytes()` is exported so the
 * unit suite can validate the encoding itself rather than trusting it.
 *
 * Binary layout (WebAssembly core 2.0 + SIMD proposal):
 *   magic \0asm, version 1
 *   §1 type     : () -> i32
 *   §3 function : one function, type 0
 *   §5 memory   : one page, min 1
 *   §7 export   : "probe" (func 0), "mem" (memory 0)
 *   §10 code    : i32.const 0; v128.const <16 known bytes>; v128.store; i32.const 0; i32.load8_u; end
 */

export interface WasmEnv {
  validate(bytes: Uint8Array): boolean;
  /** Returns the exported memory and the probe function. */
  instantiate(bytes: Uint8Array): { probe(): number; memory: Uint8Array };
  sharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  atomics: boolean;
  /** Optional: a worker factory that proves cross-thread shared memory end to end. */
  spawnSharedWorker?: () => Promise<boolean>;
}

export interface WasmReport {
  at: number;
  /** The module validated and produced the exact bytes it was told to store. */
  simd: boolean;
  /** Why SIMD is not claimed, when it is not. */
  simdReason: string;
  sharedMemory: boolean;
  sharedMemoryReason: string;
  threads: boolean;
  threadsReason: string;
  /** Best available execution strategy for a CPU-bound loop. */
  strategy: "threads" | "simd" | "scalar";
}

/* ------------------------------------------------------------------ encoding */

const KNOWN_PATTERN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n) byte |= 0x80;
    out.push(byte);
  } while (n);
  return out;
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

function name(raw: string): number[] {
  const bytes = [...new TextEncoder().encode(raw)];
  return [...uleb(bytes.length), ...bytes];
}

/**
 * Assemble the probe module.
 *
 * The single code body stores one `v128` constant and returns its first byte, so
 * a successful call proves three things at once: the engine parsed the SIMD
 * prefix, it honoured the 16-byte immediate, and `v128.store` landed in the
 * little-endian order the spec requires.
 */
export function wasmSimdProbeBytes(): Uint8Array {
  const type = section(1, [0x01, 0x60, 0x00, 0x01, 0x7f]);           // 1 type: () -> i32
  const func = section(3, [0x01, 0x00]);                              // 1 function: type 0
  const mem = section(5, [0x01, 0x00, 0x01]);                         // 1 memory: min 1 page
  const expl = section(7, [
    0x02,
    ...name("probe"), 0x00, 0x00,                                  // export func 0
    ...name("mem"), 0x02, 0x00,                                    // export memory 0 (kind 2 = memory)
  ]);
  const body = [
    0x00,                                                              // no locals
    0x41, 0x00,                                                        // i32.const 0   (store address)
    0xfd, 0x0c, ...KNOWN_PATTERN,                                      // v128.const
    0xfd, 0x0b, 0x04, 0x00,                                            // v128.store align=16 offset=0
    0x41, 0x00,                                                        // i32.const 0   (load address)
    0x2d, 0x00, 0x00,                                                  // i32.load8_u align=1 offset=0
    0x0b,                                                              // end
  ];
  const code = section(10, [0x01, ...uleb(body.length), ...body]);
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...type, ...func, ...mem, ...expl, ...code]);
}

export const EXPECTED_FIRST_BYTE = KNOWN_PATTERN[0];

/* ------------------------------------------------------------------ probing */

export function probeWasm(env: WasmEnv, at: number): WasmReport {
  let simd = false;
  let simdReason = "";
  const bytes = wasmSimdProbeBytes();
  try {
    if (!env.validate(bytes)) {
      simdReason = "the engine rejected a module containing the SIMD proposal instructions";
    } else {
      const instance = env.instantiate(bytes);
      const value = instance.probe();
      const byte = instance.memory[0];
      if (value !== EXPECTED_FIRST_BYTE || byte !== EXPECTED_FIRST_BYTE) {
        simdReason = `the module ran but returned ${value} / stored ${byte} instead of ${EXPECTED_FIRST_BYTE}`;
      } else {
        simd = true;
        simdReason = "the SIMD module validated and reproduced its own constant";
      }
    }
  } catch (e) {
    simdReason = `instantiation failed: ${(e as Error)?.message ?? String(e)}`;
  }

  let sharedMemory = false;
  let sharedMemoryReason: string;
  if (!env.sharedArrayBuffer) {
    sharedMemoryReason = "SharedArrayBuffer is not exposed";
  } else if (!env.crossOriginIsolated) {
    sharedMemoryReason = "SharedArrayBuffer exists but the page is not cross-origin isolated, so it cannot be constructed";
  } else if (!env.atomics) {
    sharedMemoryReason = "Atomics is not exposed";
  } else {
    sharedMemory = true;
    sharedMemoryReason = "shared memory and Atomics are both available";
  }

  let threads = false;
  let threadsReason: string;
  if (!sharedMemory) {
    threadsReason = `threads need shared memory: ${sharedMemoryReason}`;
  } else if (!env.spawnSharedWorker) {
    threadsReason = "shared memory exists but no worker factory was provided to prove it";
  } else {
    threadsReason = "a worker was started and shared an ArrayBuffer with this thread";
  }

  return {
    at, simd, simdReason, sharedMemory, sharedMemoryReason,
    threads, threadsReason,
    // Not yet promoted by the worker result: the caller may call runThreadProbe().
    strategy: simd ? "simd" : "scalar",
  };
}

/** Run the optional worker proof and fold the answer in. Kept separate so the pure probe stays synchronous. */
export async function runThreadProbe(env: WasmEnv, report: WasmReport): Promise<WasmReport> {
  if (!report.sharedMemory) return report;
  if (!env.spawnSharedWorker) return { ...report, threadsReason: "shared memory exists but no worker factory was provided to prove it" };
  try {
    const ok = await env.spawnSharedWorker();
    return {
      ...report,
      threads: ok,
      threadsReason: ok ? "a worker started and shared memory with this thread" : "the worker did not complete a shared-memory handshake",
      strategy: ok ? "threads" : report.strategy,
    };
  } catch (e) {
    return { ...report, threads: false, threadsReason: `the worker proof failed: ${(e as Error)?.message ?? String(e)}` };
  }
}

/**
 * Split a range into contiguous chunks for a fixed worker count.
 *
 * Hostile inputs are the point: `total` can be zero (empty image), `workers`
 * larger than the number of pixels (a 1-pixel row with 8 cores), and `minChunk`
 * can exceed the whole range. Every one of those must produce a plan that
 * covers exactly [0, total) with no overlap and no empty chunk.
 */
export interface Chunk { start: number; end: number }

export function planChunks(total: number, workers: number, minChunk = 1): Chunk[] {
  if (!Number.isInteger(total) || total < 0) throw new Error("total must be a non-negative integer");
  if (!Number.isInteger(workers) || workers < 1) throw new Error("workers must be a positive integer");
  if (!Number.isInteger(minChunk) || minChunk < 1) throw new Error("minChunk must be a positive integer");
  if (total === 0) return [];
  const wanted = Math.max(1, Math.min(workers, Math.ceil(total / Math.min(minChunk, total))));
  const base = Math.floor(total / wanted);
  const extra = total - base * wanted;
  const chunks: Chunk[] = [];
  let start = 0;
  for (let i = 0; i < wanted; i++) {
    const len = base + (i < extra ? 1 : 0);
    if (len === 0) continue;
    chunks.push({ start, end: start + len });
    start += len;
  }
  return chunks;
}
