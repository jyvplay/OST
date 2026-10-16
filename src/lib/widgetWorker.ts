"use client";

/**
 * Mechanism S1 (sandbox alternative — repair of the SH-05 gap found last
 * turn): run user-authored widget LOGIC in a dedicated Web Worker instead of
 * (or in addition to) a sandboxed iframe.
 *
 * WHY this actually fixes the falsified claim, not just moves the bug:
 * iframe process-isolation is a Chromium PERFORMANCE HEURISTIC (Site
 * Isolation) — the HTML spec never guarantees a same-process sandboxed
 * iframe cannot block the embedder's main thread, and our own adversarial
 * test last turn proved exactly that (default config froze the shell; only
 * --site-per-process did not). A Worker is different IN THE SPEC, not just in
 * practice: the HTML Standard defines dedicated workers as running on a
 * SEPARATE AGENT (an independent thread of execution), and `Worker.terminate()`
 * is specified to immediately stop that agent's event loop WITHOUT requiring
 * the worker's own code to cooperate or yield. An infinite `while(true){}`
 * inside a worker cannot prevent `.terminate()` from working, because the
 * termination is enforced by the engine from OUTSIDE the worker's thread —
 * there is no code path by which a worker can observe or veto it. This is
 * implemented identically by every engine (V8/JSC/SpiderMonkey), independent
 * of any Chromium-specific site-isolation configuration.
 *
 * Trade-off (declared, not hidden): a worker has no DOM, so a widget running
 * this way cannot render arbitrary HTML/CSS directly. To avoid reopening an
 * XSS hole by having the worker hand back raw HTML for the main thread to
 * inject, the wire protocol is a small, STRUCTURED render-tree (text/color/
 * background only) that trusted React code interprets — a hostile or buggy
 * widget can misbehave visually, never inject markup or script into the host
 * document. Widgets that truly need arbitrary DOM (rich HTML/CSS) remain on
 * the iframe path from last turn, opt-in, with the measured isolation caveat
 * already documented for SH-05.
 */
export interface WidgetTree { text?: string; color?: string; bg?: string; sub?: string }
export type WidgetStatus = "starting" | "live" | "unresponsive" | "crashed";

const COMPUTE_BUDGET_MS = 300;

export class WorkerWidgetHost {
  private worker: Worker | null = null;
  private seq = 0;
  private pending: { seq: number; timer: number; resolve: (t: WidgetTree | null) => void } | null = null;
  private code: string;
  status: WidgetStatus = "starting";
  terminations = 0;

  constructor(code: string) { this.code = code; }

  private spawn() {
    const blob = new Blob([this.code], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url, { name: "fusion-widget" });
    URL.revokeObjectURL(url);
    w.onmessage = (e: MessageEvent) => {
      const data = e.data as { type: string; seq: number; tree?: WidgetTree };
      if (data?.type === "render" && this.pending && data.seq === this.pending.seq) {
        window.clearTimeout(this.pending.timer);
        this.pending.resolve(data.tree ?? null);
        this.pending = null;
        this.status = "live";
      }
    };
    w.onerror = () => { this.status = "crashed"; this.pending?.resolve(null); this.pending = null; };
    this.worker = w;
  }

  /** Sends props, waits up to COMPUTE_BUDGET_MS for a structured reply, then
   *  FORCIBLY terminates and respawns a clean worker if the deadline passes —
   *  this is the line that is true regardless of browser/process config. */
  async tick(props: Record<string, unknown>): Promise<WidgetTree | null> {
    if (!this.worker) this.spawn();
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.pending = {
        seq,
        timer: window.setTimeout(() => {
          this.terminations += 1;
          this.status = "unresponsive";
          this.worker?.terminate(); // spec-guaranteed stop, independent of site isolation
          this.worker = null;
          this.pending = null;
          resolve(null);
        }, COMPUTE_BUDGET_MS),
        resolve,
      };
      this.worker!.postMessage({ type: "tick", seq, props });
    });
  }

  dispose() { this.worker?.terminate(); this.worker = null; }
}

/** Minimal, safe sample widget source — the contract any /Widgets/*.worker.js file must follow. */
export const SAMPLE_WORKER_WIDGET = `
let n = 0;
onmessage = (e) => {
  if (e.data.type !== "tick") return;
  n += 1;
  postMessage({ type: "render", seq: e.data.seq, tree: { text: String(n), sub: "ticks (worker-isolated)", color: "#bcd4ff" } });
};
`.trim();
