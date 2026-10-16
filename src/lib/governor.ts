"use client";

/**
 * RG-01 load governor — a thermal proxy.
 *
 * The web exposes no thermal headroom and no CPU time. Instead of pretending,
 * this governor closes the loop on *observed cost*: an EWMA of frame intervals
 * sampled only while something is animating, plus the long-task rate and the
 * battery state. It is the honest analog of ADPF: we cannot ask for more
 * performance, so we spend less of it.
 */

export type GovernorState = "COOL" | "WARM" | "HOT" | "THROTTLED" | "CRITICAL";

export interface GovernorSnapshot {
  state: GovernorState;
  frameMs: number;
  fps: number;
  longTasksPerMin: number;
  batteryLevel: number | null;
  charging: boolean | null;
  saveData: boolean;
  effects: boolean;
  backgroundWork: boolean;
  maxCastHeight: number;
  reason: string;
}

type Listener = (s: GovernorSnapshot) => void;

class Governor {
  private frameMs = 16.7;
  private longTasks: number[] = [];
  private listeners = new Set<Listener>();
  private observer: PerformanceObserver | null = null;
  private battery: { level: number; charging: boolean } | null = null;
  private activeTicks = 0;
  private lastTs = 0;
  private running = false;

  start() {
    if (this.running || typeof window === "undefined") return;
    this.running = true;
    try {
      this.observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) this.longTasks.push(performance.now());
        }
        this.longTasks = this.longTasks.filter((t) => performance.now() - t < 60_000);
        this.emit();
      });
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch { /* Safari/Firefox: no longtask entries — frame cost still works */ }

    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener: (t: string, f: () => void) => void }> };
    nav.getBattery?.().then((b) => {
      const update = () => { this.battery = { level: b.level, charging: b.charging }; this.emit(); };
      update();
      b.addEventListener("levelchange", update);
      b.addEventListener("chargingchange", update);
    }).catch(() => undefined);
  }

  /** Called by the compositor's rAF loop ONLY while something is animating. */
  tick(ts: number) {
    if (this.lastTs) {
      const dt = ts - this.lastTs;
      if (dt > 0 && dt < 500) this.frameMs = this.frameMs * 0.9 + dt * 0.1;
    }
    this.lastTs = ts;
    this.activeTicks += 1;
    if (this.activeTicks % 30 === 0) this.emit();
  }

  idle() { this.lastTs = 0; }

  snapshot(): GovernorSnapshot {
    const longTasksPerMin = this.longTasks.length;
    const fps = Math.min(240, Math.round(1000 / Math.max(this.frameMs, 1)));
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    const saveData = Boolean(nav.connection?.saveData);
    const low = this.battery ? this.battery.level < 0.2 && !this.battery.charging : false;

    let state: GovernorState = "COOL";
    let reason = "Frame cost within budget.";
    if (this.frameMs > 14) { state = "WARM"; reason = `Frame cost ${this.frameMs.toFixed(1)} ms.`; }
    if (this.frameMs > 22 || longTasksPerMin > 20) { state = "HOT"; reason = `Frame cost ${this.frameMs.toFixed(1)} ms, ${longTasksPerMin} long tasks/min.`; }
    if (this.frameMs > 34 || longTasksPerMin > 50) { state = "THROTTLED"; reason = "Sustained frame cost above 34 ms — effects disabled, background work paused."; }
    if (this.frameMs > 60) { state = "CRITICAL"; reason = "Frame cost above 60 ms — minimum visual mode."; }
    if (low && state === "COOL") { state = "WARM"; reason = "Battery below 20% and discharging."; }
    if (saveData && state === "COOL") { state = "WARM"; reason = "Data saver is enabled."; }

    return {
      state, frameMs: Number(this.frameMs.toFixed(1)), fps, longTasksPerMin,
      batteryLevel: this.battery?.level ?? null, charging: this.battery?.charging ?? null, saveData,
      effects: state === "COOL" || state === "WARM",
      backgroundWork: state !== "THROTTLED" && state !== "CRITICAL" && !low,
      maxCastHeight: state === "COOL" ? 1080 : state === "WARM" ? 1080 : state === "HOT" ? 720 : 540,
      reason,
    };
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.snapshot());
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const s = this.snapshot();
    this.listeners.forEach((l) => l(s));
  }
}

const g = globalThis as typeof globalThis & { __fusionGovernor?: Governor };
export const governor = g.__fusionGovernor ?? (g.__fusionGovernor = new Governor());
