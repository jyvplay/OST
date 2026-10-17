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

/**
 * TT27: each OS-like layout has a matching look — Art → Silver (light macOS-like), Business → Daylight (Windows 11 light).
 * Switching layout applies the pair (style + light theme) unless appearance.pairStyle is "off". Fusion keeps the current look.
 */
export const LAYOUT_STYLE_PAIR: Partial<Record<LayoutId, string>> = { art: "silver", business: "daylight" };
export function pairedSettings(layout: LayoutId, settings: Record<string, string | undefined>): [string, string][] {
  const style = LAYOUT_STYLE_PAIR[layout];
  if (!style || settings["appearance.pairStyle"] === "off") return [];
  const out: [string, string][] = [];
  if (settings["appearance.style"] !== style) out.push(["appearance.style", style]);
  if (settings["appearance.theme"] !== "light") out.push(["appearance.theme", "light"]);
  return out;
}

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

/* ------------------------------------------------------------------------------------------------------------------
 * TT26 — aesthetic dock sizing. The TT25 dock shrank its icons until all 37 apps fitted (≈30 px on a 1440 screen),
 * i.e. it maximised slots, not looks. The dock now picks a *pleasing* resting size first and makes the content fit
 * the size, not the other way round:
 *   1. idealDockIcon — ≈5.5 % of the shorter usable axis, snapped to the 4-px grid and clamped to the 44–64 px band
 *      (44 = Apple HIG minimum hit target; 48 dp Material; ≤64 keeps the dock from dominating a laptop screen), or a
 *      user preset (Small 44 / Medium 52 / Large 64).
 *   2. planDock — if the dock would be wider than DOCK_FILL of the screen, whole groups fold into macOS-style
 *      "stacks" (one tile → a grid of that group's apps), biggest saving first, so every app is still one click from
 *      the dock. Running and pinned apps of a folded group stay visible as their own icons (running dots).
 *   3. Only when every group is folded and it still does not fit (a phone) are pinned apps folded back too, then the
 *      size steps down the 4-px grid to DOCK_FLOOR; below that (many minimised windows) the dock scrolls inside itself.
 * ---------------------------------------------------------------------------------------------------------------- */
export const DOCK_SIZE_IDS = ["auto", "small", "medium", "large"] as const;
export type DockSizeId = (typeof DOCK_SIZE_IDS)[number];
export const DOCK_PRESETS: Record<Exclude<DockSizeId, "auto">, number> = { small: 44, medium: 52, large: 64 };
export const DOCK_BAND = { min: 44, max: 64 } as const;
export const DOCK_FLOOR = 32;
/** The dock may use at most this share of the available width (breathing room either side, as on macOS). */
export const DOCK_FILL = 0.9;
/** Spacing between dock tiles: 8 px (Material's minimum spacing between touch targets, and on the 4-px grid). */
export const DOCK_GAP = 8;
export const DOCK_PAD = 8;
export const DOCK_SEP_W = 9;
/** Apps that stay in the dock even when their group is folded into a stack (macOS keeps System Settings out). */
export const DOCK_PINNED = ["files", "settings"] as const;

export const snap4 = (v: number): number => Math.round(v / 4) * 4;

export function idealDockIcon(vw: number, vh: number, pref: unknown = "auto"): number {
  if (typeof pref === "string" && pref in DOCK_PRESETS) return DOCK_PRESETS[pref as Exclude<DockSizeId, "auto">];
  const w = Number.isFinite(vw) && vw > 0 ? vw : 1440, h = Number.isFinite(vh) && vh > 0 ? vh : 900;
  const raw = Math.min(h, w * 0.625) * 0.055;
  return Math.max(DOCK_BAND.min, Math.min(DOCK_BAND.max, snap4(raw)));
}

export interface DockGroupIn { id: string; apps: readonly string[] }
export interface DockPlan {
  size: number;
  /** groups shown as a single stack tile */
  folded: string[];
  /** per group: the apps shown as their own icons (all of them when expanded; running + pinned when folded) */
  visible: Record<string, string[]>;
  icons: number;
  separators: number;
  width: number;
  fits: boolean;
}

/**
 * `lead` icons before the groups (Launchpad), `tail` icons after them (minimised windows + Trash), one separator
 * between groups and one before the tail. Pure and total: never returns a size outside [DOCK_FLOOR, DOCK_BAND.max].
 */
export function planDock(groups: readonly DockGroupIn[], avail: number, ideal: number,
  opts: { lead?: number; tail?: number; running?: readonly string[]; pinned?: readonly string[]; fill?: number } = {}): DockPlan {
  const { lead = 1, tail = 1, running = [], pinned = DOCK_PINNED, fill = DOCK_FILL } = opts;
  const limit = Math.max(0, (Number.isFinite(avail) ? avail : 0) * fill);
  const keep = new Set([...running, ...pinned]);
  const unpin = () => { for (const p of pinned) if (!running.includes(p)) keep.delete(p); };
  const folded = new Set<string>();
  const seps = groups.length; // between groups (n−1) + before the tail (1)
  const visibleOf = (g: DockGroupIn) => (folded.has(g.id) ? g.apps.filter((a) => keep.has(a)) : [...g.apps]);
  const count = () => lead + tail + groups.reduce((n, g) => n + visibleOf(g).length + (folded.has(g.id) ? 1 : 0), 0);
  const widthAt = (size: number) => dockWidth(count(), size, { gap: DOCK_GAP, pad: DOCK_PAD, separators: seps, sepWidth: DOCK_SEP_W });
  let size = Math.max(DOCK_FLOOR, Math.min(DOCK_BAND.max, Number.isFinite(ideal) ? snap4(ideal) : DOCK_BAND.min));
  while (widthAt(size) > limit) {
    // fold the expanded group that saves the most icons; ties fold the later group (Core stays out longest)
    let best: DockGroupIn | null = null, bestSave = 0;
    for (const g of groups) {
      if (folded.has(g.id)) continue;
      const save = g.apps.length - g.apps.filter((a) => keep.has(a)).length - 1;
      if (save > 0 && save >= bestSave) { best = g; bestSave = save; }
    }
    if (!best) break;
    folded.add(best.id);
  }
  // everything folded and still too wide: pinned (not running) apps go back into their stacks first…
  if (widthAt(size) > limit && folded.size === groups.length) unpin();
  // …and only then does the size step down the 4-px grid
  while (widthAt(size) > limit && size > DOCK_FLOOR) size -= 4;
  const visible: Record<string, string[]> = {};
  for (const g of groups) visible[g.id] = visibleOf(g);
  const width = widthAt(size);
  return { size, folded: groups.filter((g) => folded.has(g.id)).map((g) => g.id), visible, icons: count(), separators: seps, width, fits: width <= limit };
}
