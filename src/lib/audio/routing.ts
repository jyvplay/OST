/**
 * TT137 (MD-06, MD-09) — Audio device routing and per-window audio dashboard.
 *
 * Pure routing decisions and per-window audio state. No Web Audio I/O —
 * just the policy layer.
 */

// ── MD-06: Audio device routing ───────────────────────────────────────────────
export interface AudioDevice {
  id: string;
  label: string;
  kind: "input" | "output";
  /** Whether the device is the system default. */
  default: boolean;
  /** Channel count, if known. */
  channels?: number;
  /** Sample rate, if known. */
  sampleRate?: number;
}

export interface RoutingDecision {
  /** Output device for a given window. */
  outputDevice: string;
  /** Input device for a given window. */
  inputDevice: string;
  /** Whether the routing is the system default. */
  isDefault: boolean;
  /** Reason for the decision. */
  reason: string;
}

export function routeAudio(windowId: string, devices: readonly AudioDevice[], preferDefault = true): RoutingDecision {
  const outputs = devices.filter((d) => d.kind === "output");
  const inputs = devices.filter((d) => d.kind === "input");
  if (outputs.length === 0) return { outputDevice: "", inputDevice: "", isDefault: true, reason: "No output device available" };
  if (inputs.length === 0) return { outputDevice: outputs[0].id, inputDevice: "", isDefault: true, reason: "No input device available" };

  const defaultOut = outputs.find((d) => d.default) ?? outputs[0];
  const defaultIn = inputs.find((d) => d.default) ?? inputs[0];

  if (preferDefault) {
    return { outputDevice: defaultOut.id, inputDevice: defaultIn.id, isDefault: true, reason: "Using system default devices" };
  }
  // Route to the first non-default device for this window
  const nonDefaultOut = outputs.find((d) => !d.default);
  const nonDefaultIn = inputs.find((d) => !d.default);
  return {
    outputDevice: nonDefaultOut?.id ?? defaultOut.id,
    inputDevice: nonDefaultIn?.id ?? defaultIn.id,
    isDefault: false,
    reason: `Window ${windowId} routed to non-default devices`,
  };
}

export function reroute(windowId: string, fromDevice: string, toDevice: string, devices: readonly AudioDevice[]): RoutingDecision {
  if (!devices.some((d) => d.id === toDevice)) throw new Error(`Device ${toDevice} not found`);
  const target = devices.find((d) => d.id === toDevice)!;
  if (target.kind === "output") {
    return { outputDevice: toDevice, inputDevice: routeAudio(windowId, devices).inputDevice, isDefault: target.default, reason: `Rerouted ${windowId} output to ${target.label}` };
  }
  return { outputDevice: routeAudio(windowId, devices).outputDevice, inputDevice: toDevice, isDefault: target.default, reason: `Rerouted ${windowId} input to ${target.label}` };
}

// ── MD-09: Per-window audio dashboard ──────────────────────────────────────────
export interface WindowAudioState {
  windowId: string;
  /** Current volume (0…1). */
  volume: number;
  /** Whether muted. */
  muted: boolean;
  /** Output device id. */
  outputDevice: string;
  /** Input device id. */
  inputDevice: string;
  /** Whether an AudioContext is running. */
  contextRunning: boolean;
  /** Estimated latency in ms, if known. */
  latencyMs?: number;
}

export interface AudioDashboard {
  windows: Map<string, WindowAudioState>;
}

export function createDashboard(): AudioDashboard {
  return { windows: new Map() };
}

export function addWindow(dash: AudioDashboard, winId: string, outputDevice: string, inputDevice: string): { ok: true } | { ok: false; reason: string } {
  if (!/^w-[a-z0-9-]{1,32}$/.test(winId)) throw new Error("Window id invalid");
  if (dash.windows.has(winId)) return { ok: false, reason: `Window ${winId} already has audio state` };
  dash.windows.set(winId, { windowId: winId, volume: 1, muted: false, outputDevice, inputDevice, contextRunning: false });
  return { ok: true };
}

export function setVolume(dash: AudioDashboard, winId: string, volume: number): { ok: true } | { ok: false; reason: string } {
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error("Volume must be 0…1");
  const w = dash.windows.get(winId);
  if (!w) return { ok: false, reason: `Window ${winId} not found` };
  w.volume = volume;
  return { ok: true };
}

export function toggleMute(dash: AudioDashboard, winId: string): { ok: true; muted: boolean } | { ok: false; reason: string } {
  const w = dash.windows.get(winId);
  if (!w) return { ok: false, reason: `Window ${winId} not found` };
  w.muted = !w.muted;
  return { ok: true, muted: w.muted };
}

export function setContextState(dash: AudioDashboard, winId: string, running: boolean, latencyMs?: number): { ok: true } | { ok: false; reason: string } {
  const w = dash.windows.get(winId);
  if (!w) return { ok: false, reason: `Window ${winId} not found` };
  w.contextRunning = running;
  if (running && latencyMs !== undefined) {
    if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new Error("Latency must be non-negative");
    w.latencyMs = Math.round(latencyMs * 10) / 10;
  }
  return { ok: true };
}

export interface DashboardReport {
  total: number;
  running: number;
  muted: number;
  avgVolume: number;
  windows: WindowAudioState[];
}

export function reportDashboard(dash: AudioDashboard): DashboardReport {
  const windows = [...dash.windows.values()];
  const total = windows.length;
  const running = windows.filter((w) => w.contextRunning).length;
  const muted = windows.filter((w) => w.muted).length;
  const avgVolume = total === 0 ? 0 : Math.round(windows.reduce((s, w) => s + w.volume, 0) / total * 100) / 100;
  return { total, running, muted, avgVolume, windows };
}

export function describeWindow(w: WindowAudioState): string {
  return `${w.windowId} · vol ${Math.round(w.volume * 100)}%${w.muted ? " · muted" : ""} · ${w.contextRunning ? "running" : "stopped"}${w.latencyMs !== undefined ? ` · ${w.latencyMs}ms` : ""}`;
}
