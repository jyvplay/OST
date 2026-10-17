/**
 * TT25 — main-UI layouts and the dock maths. No React, server-safe: used by the shell, the settings validator,
 * Settings / Quick panel and scripts/layout-unit.mts.
 *
 *   fusion   — the original hybrid (top bar + bottom shelf). Kept as the default so nothing that worked is removed.
 *   business — after Windows: no top bar; a full-width bottom taskbar with Start, search, Task view, pinned and
 *              running apps (underline indicators), a system tray, a stacked clock and a "Show desktop" sliver.
 *   art      — after macOS: a slim menu bar on top (logo menu, focused app name, Window menu, status items, clock)
 *              and a centred floating dock holding every app, with hover magnification, running dots, a launch
 *              bounce, minimised windows after a separator and a Launchpad grid.
 */
export const LAYOUT_IDS = ["fusion", "business", "art"] as const;
export type LayoutId = (typeof LAYOUT_IDS)[number];
export const DEFAULT_LAYOUT: LayoutId = "fusion";
export const isLayout = (v: unknown): v is LayoutId => typeof v === "string" && (LAYOUT_IDS as readonly string[]).includes(v);
export const layoutOf = (v: unknown): LayoutId => (isLayout(v) ? v : DEFAULT_LAYOUT);

export const LAYOUTS: Record<LayoutId, { label: string; blurb: string }> = {
  fusion: { label: "Fusion", blurb: "Top bar and bottom shelf (the original hybrid)" },
  business: { label: "Business", blurb: "Windows-style taskbar along the bottom with Start, search and a system tray" },
  art: { label: "Art", blurb: "Mac-style menu bar and a centred dock of every app that magnifies under the pointer" },
};

/** Largest magnification (×) and how far it reaches, in base icon widths, from the pointer. */
export const DOCK_MAX_SCALE = 1.75;
export const DOCK_REACH = 2.5;

/**
 * Magnification per icon. `centers` are the icon centres *at base size* (px, any origin), `pointer` is the pointer
 * position on the same axis (or null when the pointer is not over the dock). Uses the resting (unmagnified)
 * geometry so that growth cannot feed back into the pointer → icon mapping (the dock stays stable while it grows).
 * Cosine falloff: scale = 1 + (max−1)·½(1+cos(π·d/R)) for d < R, else 1, with R = reach·base. Pure, total.
 */
export function dockScales(centers: readonly number[], pointer: number | null, base: number, max = DOCK_MAX_SCALE, reach = DOCK_REACH): number[] {
  if (pointer === null || !Number.isFinite(pointer) || !(base > 0) || !(max > 1)) return centers.map(() => 1);
  const R = reach * base;
  return centers.map((c) => {
    const d = Math.abs(c - pointer);
    if (!(d < R)) return 1;
    return 1 + (max - 1) * 0.5 * (1 + Math.cos(Math.PI * d / R));
  });
}

/**
 * Base icon size so `count` icons (plus `separators` thin dividers) fit inside `width` with `gap` between items
 * and `pad` padding on each side, clamped to [min, max]. When even `min` does not fit, returns `min` and the dock
 * scrolls (it never spills off-screen): callers check `dockFits`.
 */
export function fitIconSize(count: number, width: number, opts: { gap?: number; pad?: number; separators?: number; sepWidth?: number; min?: number; max?: number } = {}): number {
  const { gap = 6, pad = 10, separators = 0, sepWidth = 13, min = 24, max = 52 } = opts;
  if (count <= 0) return max;
  const free = width - 2 * pad - separators * sepWidth - (count - 1 + separators) * gap;
  const size = Math.floor(free / count);
  return Math.max(min, Math.min(max, size));
}
export const dockWidth = (count: number, size: number, opts: { gap?: number; pad?: number; separators?: number; sepWidth?: number } = {}): number => {
  const { gap = 6, pad = 10, separators = 0, sepWidth = 13 } = opts;
  return count * size + separators * sepWidth + Math.max(0, count - 1 + separators) * gap + 2 * pad;
};

/**
 * Business-layout taskbar button behaviour (Windows): no window → open one; the module's window is focused and it
 * has one window → minimise it; otherwise → bring the next window of that module forward (cycling).
 * `windows` are the module's windows in z-order (front last). Returns the action the shell should take.
 */
export function taskbarAction(windows: readonly { id: string; minimized: boolean }[], focusedId: string | null):
  { kind: "open" } | { kind: "minimize"; id: string } | { kind: "focus"; id: string } {
  if (windows.length === 0) return { kind: "open" };
  const fi = windows.findIndex((w) => w.id === focusedId && !w.minimized);
  if (fi >= 0 && windows.length === 1) return { kind: "minimize", id: windows[fi].id };
  if (fi >= 0) return { kind: "focus", id: windows[(fi + windows.length - 1) % windows.length].id };
  const visible = [...windows].reverse().find((w) => !w.minimized);
  return { kind: "focus", id: (visible ?? windows[windows.length - 1]).id };
}
