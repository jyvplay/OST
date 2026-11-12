/**
 * TT147 (HW-04) — accelerated inference: what this machine will actually do.
 *
 * The row is not "run a model"; it is "know where the compute would happen".
 * Three APIs answer that, and each answers a different question:
 *
 *   • WebGPU `requestAdapter` returns an adapter or null. An adapter that
 *     reports `isFallbackAdapter` (or a software vendor such as SwiftShader) is
 *     a CPU pretending to be a GPU — which is exactly what a container without
 *     a graphics device provides, and what several "WebGPU works!" demos hide.
 *   • WebNN (`navigator.ml.createContext`) names the device it will use:
 *     `cpu`, `gpu` or `npu`. That is the only browser API that mentions an NPU
 *     at all, and it is behind a flag in every shipping engine as of writing.
 *   • `navigator.hardwareConcurrency` is not acceleration, but it is the honest
 *     fallback number when nothing else is available.
 *
 * Nothing here runs a model, so nothing here can be mistaken for a benchmark.
 * The report says which device an inference *would* target, and quotes the
 * strings the API returned rather than translating them into a marketing name.
 */

export type DeviceKind = "npu" | "gpu" | "cpu" | "none";

export interface AdapterFacts {
  /** Vendor/architecture strings exactly as reported. */
  vendor: string | null;
  architecture: string | null;
  device: string | null;
  description: string | null;
  /** The API's own admission that this adapter is a software fallback. */
  fallback: boolean;
}

export interface AcceleratorReport {
  webgpu: {
    available: boolean;
    adapter: AdapterFacts | null;
    /** hardware | software | none — derived only from facts the API returned. */
    verdict: "hardware" | "software" | "none";
    reason: string;
  };
  webnn: {
    available: boolean;
    deviceType: DeviceKind | null;
    reason: string;
  };
  /** Where an inference would land if both APIs are missing. */
  fallback: { threads: number; note: string };
  /** One line for a settings row. */
  summary: string;
}

/**
 * Software rasterisers name themselves. Matching the reported vendor/description
 * is the only honest way to distinguish "a GPU" from "a GPU-shaped CPU": the API
 * gives no boolean for it except `isFallbackAdapter`, which Chromium sets only
 * when it is already falling back.
 */
const SOFTWARE_HINTS = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|lavapipe|mesa offscreen/i;

export function classifyAdapter(a: AdapterFacts | null): { verdict: "hardware" | "software" | "none"; reason: string } {
  if (!a) return { verdict: "none", reason: "no WebGPU adapter was returned" };
  const text = [a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(" ");
  if (a.fallback) return { verdict: "software", reason: "the adapter reports itself as a fallback (CPU rasteriser)" };
  if (SOFTWARE_HINTS.test(text)) return { verdict: "software", reason: `the adapter names software: ${text.trim().slice(0, 80)}` };
  return { verdict: "hardware", reason: text ? `adapter reports ${text.trim().slice(0, 80)}` : "an adapter was returned with no identifying strings" };
}

/** Minimal shapes of the browser objects, so the probe is testable without them. */
export interface GpuLike {
  requestAdapter(options?: { powerPreference?: "low-power" | "high-performance" }): Promise<{
    isFallbackAdapter?: boolean;
    info?: { vendor?: string; architecture?: string; device?: string; description?: string };
    requestAdapterInfo?: () => Promise<{ vendor?: string; architecture?: string; device?: string; description?: string }>;
  } | null>;
}

export interface MlLike {
  createContext(options: { deviceType?: "cpu" | "gpu" | "npu" }): Promise<unknown>;
}

export interface AcceleratorInputs {
  gpu?: GpuLike | null;
  ml?: MlLike | null;
  hardwareConcurrency?: number;
}

/** Read the adapter facts without inventing any of them. */
async function adapterFacts(gpu: GpuLike): Promise<AdapterFacts | null> {
  let adapter: Awaited<ReturnType<GpuLike["requestAdapter"]>> = null;
  try { adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }); } catch { return null; }
  if (!adapter) return null;
  let info: { vendor?: string; architecture?: string; device?: string; description?: string } | undefined = adapter.info;
  if (!info && typeof adapter.requestAdapterInfo === "function") {
    try { info = await adapter.requestAdapterInfo(); } catch { info = undefined; }
  }
  return {
    vendor: info?.vendor ?? null,
    architecture: info?.architecture ?? null,
    device: info?.device ?? null,
    description: info?.description ?? null,
    fallback: adapter.isFallbackAdapter === true,
  };
}

/** WebNN is only reported as available when a context was really created. */
async function webnnDevice(ml: MlLike): Promise<{ available: boolean; deviceType: DeviceKind | null; reason: string }> {
  for (const want of ["npu", "gpu", "cpu"] as const) {
    try {
      await ml.createContext({ deviceType: want });
      return { available: true, deviceType: want, reason: `a WebNN context was created on the ${want}` };
    } catch (e) {
      // Keep trying the next device: a browser may support WebNN with no NPU.
      if (want === "cpu") return { available: false, deviceType: null, reason: `WebNN is present but refused a context: ${(e as Error).message}` };
    }
  }
  return { available: false, deviceType: null, reason: "WebNN is absent" };
}

export async function probeAccelerators(inputs: AcceleratorInputs): Promise<AcceleratorReport> {
  const threads = Math.max(1, Math.floor(inputs.hardwareConcurrency ?? 1));
  const adapter = inputs.gpu ? await adapterFacts(inputs.gpu) : null;
  const verdict = inputs.gpu ? classifyAdapter(adapter) : { verdict: "none" as const, reason: "this engine has no WebGPU object" };
  const nn = inputs.ml ? await webnnDevice(inputs.ml) : { available: false, deviceType: null as DeviceKind | null, reason: "this engine has no WebNN object" };
  const summary = (() => {
    if (nn.deviceType === "npu") return "an NPU answers through WebNN";
    if (verdict.verdict === "hardware") return "a real GPU adapter is available";
    if (verdict.verdict === "software") return "GPU API present, but compute lands on the CPU";
    if (nn.deviceType === "gpu") return "WebNN offers the GPU only";
    return `${threads} CPU thread(s); no accelerator claims are made`;
  })();
  return {
    webgpu: { available: Boolean(inputs.gpu), adapter, verdict: verdict.verdict, reason: verdict.reason },
    webnn: nn,
    fallback: { threads, note: `without an accelerator, inference would run on ${threads} thread(s) in the main engine` },
    summary,
  };
}

/** The browser-bound wrapper: the only place that touches `navigator`. */
export async function browserAccelerators(): Promise<AcceleratorReport> {
  const nav = navigator as Navigator & { gpu?: GpuLike; ml?: MlLike };
  return probeAccelerators({ gpu: nav.gpu ?? null, ml: nav.ml ?? null, hardwareConcurrency: navigator.hardwareConcurrency });
}
