/**
 * Fusion window engine — pure, deterministic, serialisable.
 *
 * Rules that make this different from the typical React "window manager":
 *  1. No Date.now(), no Math.random(), no DOM access inside the reducer. Ids and
 *     timestamps arrive inside the command, so a command log replays to a byte
 *     identical state (TD-06 state replay test).
 *  2. Invariants are re-applied after EVERY command, not at the call sites, so a
 *     window can never be dragged off-screen or resized below usability.
 *  3. Geometry is host-relative (viewport in the state), so the same command
 *     produces correct results in the tab host, a Document-PiP host and a
 *     second-screen host.
 */

export type HostKind = "tab" | "pip" | "screen";
export type Density = "compact" | "balanced" | "touch";

export interface Rect { x: number; y: number; w: number; h: number }

export interface WindowState extends Rect {
  id: string;
  module: string;
  title: string;
  z: number;
  minimized: boolean;
  maximized: boolean;
  workspace: number;
  host: HostKind;
  density?: Density;
  props: Record<string, unknown>;
  restore?: Rect;
}

export interface WorkspaceState { id: number; name: string }

export interface DesktopState {
  windows: WindowState[];
  focus: string | null;
  workspaces: WorkspaceState[];
  activeWorkspace: number;
  nextZ: number;
  viewport: { w: number; h: number };
  icons: { id: string; path: string; x: number; y: number }[];
  focusMode: boolean;
  revision: number;
  /** TT25 "Show desktop": ids minimised by the last showDesktop, restored by the next one (cleared by any focus/open). */
  peek?: string[];
  /** TT26 Tabletop floor: loose card positions + piles (validated against the VFS by tabletop-core normalizeTable). */
  table?: import("../tabletop-core").TableState;
}

export const MIN_W: Record<Density, number> = { compact: 240, balanced: 280, touch: 320 };
export const MIN_H: Record<Density, number> = { compact: 180, balanced: 200, touch: 240 };
export const TITLEBAR_VISIBLE = 48; // px of title bar that must stay reachable

export const initialDesktop = (): DesktopState => ({
  windows: [],
  focus: null,
  workspaces: [
    { id: 1, name: "Main" },
    { id: 2, name: "Build" },
    { id: 3, name: "Media" },
  ],
  activeWorkspace: 1,
  nextZ: 10,
  viewport: { w: 1440, h: 900 },
  icons: [],
  focusMode: false,
  revision: 1,
});

export type TileSlot =
  | "left" | "right" | "top" | "bottom"
  | "tl" | "tr" | "bl" | "br"
  | "third-l" | "third-c" | "third-r"
  | "center" | "full";

export type WindowCommand =
  | { t: "open"; id: string; module: string; title: string; props?: Record<string, unknown>; rect?: Partial<Rect>; host?: HostKind }
  | { t: "close"; id: string }
  | { t: "focus"; id: string }
  | { t: "move"; id: string; x: number; y: number }
  | { t: "resize"; id: string; w: number; h: number; x?: number; y?: number }
  | { t: "nudge"; id: string; dx: number; dy: number }
  | { t: "grow"; id: string; dw: number; dh: number }
  | { t: "minimize"; id: string }
  | { t: "restore"; id: string }
  | { t: "toggleMax"; id: string }
  | { t: "tile"; id: string; slot: TileSlot }
  /** TT28 Snap layouts / Snap Assist: put a window into an arbitrary zone rect (clamped like every other rect). */
  | { t: "place"; id: string; rect: Rect }
  | { t: "setTitle"; id: string; title: string }
  | { t: "setProps"; id: string; props: Record<string, unknown> }
  | { t: "setHost"; id: string; host: HostKind }
  | { t: "setDensity"; id: string; density: Density }
  | { t: "toWorkspace"; id: string; workspace: number }
  | { t: "switchWorkspace"; workspace: number }
  | { t: "renameWorkspace"; workspace: number; name: string }
  | { t: "addWorkspace"; id: number; name: string }
  | { t: "viewport"; w: number; h: number }
  | { t: "cycle"; dir: 1 | -1 }
  | { t: "focusMode"; on: boolean }
  | { t: "cascade" }
  | { t: "closeAll" }
  | { t: "showDesktop" }
  | { t: "icons"; icons: DesktopState["icons"] }
  | { t: "table"; table: NonNullable<DesktopState["table"]> }
  | { t: "hydrate"; state: DesktopState }
  /** TT48: a save was refused (409) because another tab/window saved a newer desktop — adopt it, keep this tab's windows */
  | { t: "reconcile"; state: DesktopState };

// Round FIRST, clamp SECOND. (v3.0 clamped then rounded, which the property test
// caught pushing x up to 0.5 px past the bound when the viewport was fractional.)
const clampRect = (r: Rect, vp: { w: number; h: number }, density: Density): Rect => {
  const minW = MIN_W[density];
  const minH = MIN_H[density];
  const vw = Math.floor(vp.w);
  const vh = Math.floor(vp.h);
  const w = Math.max(minW, Math.min(Math.round(r.w), Math.max(minW, vw)));
  const h = Math.max(minH, Math.min(Math.round(r.h), Math.max(minH, vh)));
  // at least TITLEBAR_VISIBLE px of the title bar must remain inside the host
  const x = Math.max(-(w - TITLEBAR_VISIBLE * 2), Math.min(Math.round(r.x), vw - TITLEBAR_VISIBLE));
  const y = Math.max(0, Math.min(Math.round(r.y), vh - TITLEBAR_VISIBLE));
  return { x, y, w, h };
};

export const tileRect = (slot: TileSlot, vp: { w: number; h: number }): Rect => {
  const w = vp.w;
  const h = vp.h;
  const half = Math.floor(w / 2);
  const third = Math.floor(w / 3);
  const halfH = Math.floor(h / 2);
  switch (slot) {
    case "left": return { x: 0, y: 0, w: half, h };
    case "right": return { x: half, y: 0, w: w - half, h };
    case "top": return { x: 0, y: 0, w, h: halfH };
    case "bottom": return { x: 0, y: halfH, w, h: h - halfH };
    case "tl": return { x: 0, y: 0, w: half, h: halfH };
    case "tr": return { x: half, y: 0, w: w - half, h: halfH };
    case "bl": return { x: 0, y: halfH, w: half, h: h - halfH };
    case "br": return { x: half, y: halfH, w: w - half, h: h - halfH };
    case "third-l": return { x: 0, y: 0, w: third, h };
    case "third-c": return { x: third, y: 0, w: third, h };
    case "third-r": return { x: third * 2, y: 0, w: w - third * 2, h };
    case "center": return { x: Math.round(w * 0.12), y: Math.round(h * 0.1), w: Math.round(w * 0.76), h: Math.round(h * 0.8) };
    case "full":
    default: return { x: 0, y: 0, w, h };
  }
};

/** Invariants are enforced centrally; no call site may bypass them. */
function invariants(state: DesktopState): DesktopState {
  const seenZ = new Set<number>();
  const windows = state.windows.map((win) => {
    const density = win.density ?? "balanced";
    const geo = win.maximized
      ? tileRect("full", state.viewport)
      : clampRect({ x: win.x, y: win.y, w: win.w, h: win.h }, state.viewport, density);
    let z = win.z;
    while (seenZ.has(z)) z += 1; // total order, no ties
    seenZ.add(z);
    return { ...win, ...geo, z };
  });
  const focus = windows.some((w) => w.id === state.focus) ? state.focus : (windows.filter((w) => !w.minimized).sort((a, b) => b.z - a.z)[0]?.id ?? null);
  return { ...state, windows, focus };
}

/** Commands after which a pending "Show desktop" restore no longer makes sense (the user picked a window). */
const ENDS_PEEK = new Set<WindowCommand["t"]>(["open", "focus", "restore", "switchWorkspace", "closeAll", "minimize", "cycle"]);

export function reduce(state: DesktopState, cmd: WindowCommand): DesktopState {
  const next = reduceInner(state, cmd);
  if (next !== state && next.peek && ENDS_PEEK.has(cmd.t)) { const { peek: _drop, ...rest } = next; void _drop; return rest; }
  return next;
}

function reduceInner(state: DesktopState, cmd: WindowCommand): DesktopState {
  const bump = (s: DesktopState): DesktopState => invariants({ ...s, revision: s.revision + 1 });
  const map = (fn: (w: WindowState) => WindowState, id: string) =>
    state.windows.map((w) => (w.id === id ? fn(w) : w));

  switch (cmd.t) {
    case "hydrate":
      return invariants({ ...cmd.state, revision: Math.max(cmd.state.revision, state.revision) });

    case "reconcile": {
      // the newer desktop wins for shared data (workspaces, icons, tabletop, …) but each tab keeps its OWN windows:
      // nothing open here disappears, and the other tab's windows do not pop up here (a window is per-tab UI)
      return invariants({ ...cmd.state, windows: state.windows, focus: state.focus, nextZ: Math.max(state.nextZ, cmd.state.nextZ),
        activeWorkspace: cmd.state.workspaces.some((w) => w.id === state.activeWorkspace) ? state.activeWorkspace : cmd.state.activeWorkspace,
        viewport: state.viewport, revision: Math.max(cmd.state.revision, state.revision) });
    }

    case "open": {
      const existing = state.windows.find((w) => w.id === cmd.id);
      if (existing) {
        return bump({ ...state, focus: cmd.id, nextZ: state.nextZ + 1,
          windows: map((w) => ({ ...w, minimized: false, z: state.nextZ + 1 }), cmd.id) });
      }
      const count = state.windows.length;
      const base: Rect = {
        x: 80 + (count % 6) * 36,
        y: 70 + (count % 6) * 28,
        w: cmd.rect?.w ?? 760,
        h: cmd.rect?.h ?? 520,
      };
      // TT21: larger default text makes default windows larger — keep a new window inside the desktop
      // (shift it up/left first, shrink only if it is bigger than the desktop itself).
      const vp = state.viewport;
      const fitW = Math.min(base.w, Math.max(320, vp.w - 8)), fitH = Math.min(base.h, Math.max(240, vp.h - 8));
      const wantX = cmd.rect?.x ?? base.x, wantY = cmd.rect?.y ?? base.y;
      const fitX = Math.max(0, Math.min(wantX, vp.w - fitW - 4)), fitY = Math.max(0, Math.min(wantY, vp.h - fitH - 4));
      const win: WindowState = {
        id: cmd.id, module: cmd.module, title: cmd.title,
        x: fitX, y: fitY, w: fitW, h: fitH,
        z: state.nextZ + 1, minimized: false, maximized: false,
        workspace: state.activeWorkspace, host: cmd.host ?? "tab", props: cmd.props ?? {},
      };
      return bump({ ...state, windows: [...state.windows, win], focus: win.id, nextZ: state.nextZ + 1 });
    }

    case "close":
      return bump({ ...state, windows: state.windows.filter((w) => w.id !== cmd.id), focus: state.focus === cmd.id ? null : state.focus });

    case "closeAll":
      return bump({ ...state, windows: [], focus: null });

    case "focus":
      return bump({ ...state, focus: cmd.id, nextZ: state.nextZ + 1,
        windows: map((w) => ({ ...w, z: state.nextZ + 1, minimized: false }), cmd.id) });

    case "move":
      return bump({ ...state, windows: map((w) => ({ ...w, x: cmd.x, y: cmd.y, maximized: false }), cmd.id) });

    case "nudge":
      return bump({ ...state, windows: map((w) => ({ ...w, x: w.x + cmd.dx, y: w.y + cmd.dy, maximized: false }), cmd.id) });

    case "resize":
      return bump({ ...state, windows: map((w) => ({
        ...w, w: cmd.w, h: cmd.h, x: cmd.x ?? w.x, y: cmd.y ?? w.y, maximized: false,
      }), cmd.id) });

    case "grow":
      return bump({ ...state, windows: map((w) => ({ ...w, w: w.w + cmd.dw, h: w.h + cmd.dh, maximized: false }), cmd.id) });

    case "minimize":
      return bump({ ...state, windows: map((w) => ({ ...w, minimized: true }), cmd.id), focus: null });

    case "restore":
      return bump({ ...state, focus: cmd.id, nextZ: state.nextZ + 1,
        windows: map((w) => ({ ...w, minimized: false, z: state.nextZ + 1 }), cmd.id) });

    case "toggleMax":
      return bump({ ...state, windows: map((w) => {
        if (w.maximized) {
          const r = w.restore ?? { x: 100, y: 80, w: 760, h: 520 };
          return { ...w, maximized: false, ...r, restore: undefined };
        }
        return { ...w, maximized: true, restore: { x: w.x, y: w.y, w: w.w, h: w.h } };
      }, cmd.id) });

    case "tile": {
      const r = tileRect(cmd.slot, state.viewport);
      return bump({ ...state, focus: cmd.id, nextZ: state.nextZ + 1,
        windows: map((w) => ({ ...w, ...r, maximized: cmd.slot === "full", minimized: false, z: state.nextZ + 1,
          restore: w.restore ?? { x: w.x, y: w.y, w: w.w, h: w.h } }), cmd.id) });
    }

    case "place": {
      if (![cmd.rect?.x, cmd.rect?.y, cmd.rect?.w, cmd.rect?.h].every((v) => typeof v === "number" && Number.isFinite(v))) return state;
      return bump({ ...state, focus: cmd.id, nextZ: state.nextZ + 1,
        windows: map((w) => ({ ...w, ...clampRect(cmd.rect, state.viewport, w.density ?? "balanced"), maximized: false, minimized: false, z: state.nextZ + 1,
          restore: w.restore ?? { x: w.x, y: w.y, w: w.w, h: w.h } }), cmd.id) });
    }

    case "setTitle":
      return bump({ ...state, windows: map((w) => ({ ...w, title: cmd.title }), cmd.id) });

    case "setProps":
      return bump({ ...state, windows: map((w) => ({ ...w, props: { ...w.props, ...cmd.props } }), cmd.id) });

    case "setHost":
      return bump({ ...state, windows: map((w) => ({ ...w, host: cmd.host }), cmd.id) });

    case "setDensity":
      return bump({ ...state, windows: map((w) => ({ ...w, density: cmd.density }), cmd.id) });

    case "toWorkspace":
      return bump({ ...state, windows: map((w) => ({ ...w, workspace: cmd.workspace }), cmd.id) });

    case "switchWorkspace":
      return bump({ ...state, activeWorkspace: cmd.workspace });

    case "renameWorkspace":
      return bump({ ...state, workspaces: state.workspaces.map((ws) => (ws.id === cmd.workspace ? { ...ws, name: cmd.name } : ws)) });

    case "addWorkspace":
      return bump({ ...state, workspaces: [...state.workspaces, { id: cmd.id, name: cmd.name }] });

    case "viewport": {
      const w = Math.max(320, Math.floor(cmd.w)), h = Math.max(240, Math.floor(cmd.h));
      // TT21: a ResizeObserver tick with an unchanged size is a no-op. Bumping anyway re-armed the 600 ms
      // persistence debounce on every top-bar reflow at 2x text, which delayed geometry saves past 1.8 s.
      if (state.viewport.w === w && state.viewport.h === h) return state;
      return bump({ ...state, viewport: { w, h } });
    }

    case "cycle": {
      const visible = state.windows
        .filter((w) => w.workspace === state.activeWorkspace && !w.minimized)
        .sort((a, b) => b.z - a.z);
      if (visible.length === 0) return state;
      const idx = Math.max(0, visible.findIndex((w) => w.id === state.focus));
      const next = visible[(idx + (cmd.dir === 1 ? 1 : visible.length - 1)) % visible.length];
      return reduce(state, { t: "focus", id: next.id });
    }

    case "focusMode":
      return bump({ ...state, focusMode: cmd.on });

    case "showDesktop": {
      // Windows "Show desktop": minimise every visible window on this workspace; pressing it again puts exactly
      // those windows back (still in their z-order), unless the user has opened/focused something in between.
      const back = (state.peek ?? []).filter((id) => state.windows.some((w) => w.id === id && w.minimized));
      if (back.length) {
        const set = new Set(back);
        const top = state.windows.filter((w) => set.has(w.id)).sort((a, b) => b.z - a.z)[0];
        const { peek: _p, ...rest } = state; void _p;
        return bump({ ...rest, windows: state.windows.map((w) => (set.has(w.id) ? { ...w, minimized: false } : w)), focus: top?.id ?? null });
      }
      const ids = state.windows.filter((w) => !w.minimized && w.workspace === state.activeWorkspace).map((w) => w.id);
      if (!ids.length) return state;
      const set = new Set(ids);
      return bump({ ...state, windows: state.windows.map((w) => (set.has(w.id) ? { ...w, minimized: true } : w)), focus: null, peek: ids });
    }

    case "cascade":
      return bump({ ...state, windows: state.windows.map((w, i) => ({
        ...w, x: 60 + i * 32, y: 60 + i * 26, maximized: false,
      })) });

    case "icons":
      return bump({ ...state, icons: cmd.icons });
    case "table":
      return bump({ ...state, table: cmd.table });

    default:
      return state;
  }
}

/** Deterministic hash of the visible state — used by the replay test (TD-06). */
export function stateHash(s: DesktopState): string {
  const payload = JSON.stringify({
    w: s.windows.map((x) => [x.id, x.module, x.x, x.y, x.w, x.h, x.z, x.minimized, x.maximized, x.workspace]),
    f: s.focus, a: s.activeWorkspace, v: s.viewport,
  });
  let h = 2166136261;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
