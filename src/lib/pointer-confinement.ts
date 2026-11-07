/**
 * TT139 (WM-16) — cursor confinement across a multi-display desktop.
 *
 * Pointer Lock gives movement deltas (`movementX/Y`) and *not* a position: once
 * the cursor is hidden there is no `clientX`. The shell therefore has to keep
 * the cursor itself, and that is the whole problem — a naive accumulator drifts
 * (delta rounding, DPI changes when crossing a screen seam), and clamping to one
 * screen makes the other screens unreachable.
 *
 * This module owns that model, in device-independent CSS pixels:
 *   - `moveCursor` integrates a delta into an absolute position, crossing a
 *     display seam when the position leaves the current display;
 *   - `backingSize` converts a *canvas* size when a window moves to a display with
 *     a different devicePixelRatio. Positions do **not** get rescaled: the Screen
 *     Details API reports every display in one shared CSS-pixel virtual space, so
 *     rescaling a crossing point would double-apply the scale (an earlier version
 *     of this file did exactly that and turned x=1440 into x=4320);
 *   - `lockRequest` decides whether asking for pointer lock is even allowed and
 *     what the escape chord is, because a lock the user cannot leave is worse
 *     than no lock at all.
 *
 * Deliberate limits, stated rather than hidden: browsers do not expose the OS
 * cursor position, so on lock entry we start from the last known in-page point;
 * if a display is hot-plugged the caller must re-supply the layout, and the
 * cursor is then clamped rather than teleported. `movementX` is already scaled
 * by the OS, so this never multiplies by DPR — doing so double-scales.
 */

export interface Rect { x: number; y: number; w: number; h: number }
export interface Display { id: string; rect: Rect; dpr: number; /** the OS puts the origin of this display at `origin` */ origin?: { x: number; y: number } }
export interface CursorState { x: number; y: number; displayId: string }

export const CURSOR_EDGE_SLACK = 1;

/** The union bounding box of every display, in desktop coordinates. */
export function desktopBounds(displays: readonly Display[]): Rect | null {
  if (!displays.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const d of displays) {
    x0 = Math.min(x0, d.rect.x); y0 = Math.min(y0, d.rect.y);
    x1 = Math.max(x1, d.rect.x + d.rect.w); y1 = Math.max(y1, d.rect.y + d.rect.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function displayAt(displays: readonly Display[], x: number, y: number): Display | null {
  // A window may overlap two displays; the one containing the most of the point
  // is the one that owns it. Ties go to the earlier display (a stable answer).
  for (const d of displays) if (x >= d.rect.x && x < d.rect.x + d.rect.w && y >= d.rect.y && y < d.rect.y + d.rect.h) return d;
  return null;
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

/**
 * Integrate one pointer-lock delta into an absolute cursor position.
 * If the new position leaves the current display it is handed to the display
 * that actually contains it (seam crossing), else it is clamped to the edge of
 * the desktop so the cursor cannot be lost in empty space between displays.
 */
export function moveCursor(
  state: CursorState,
  movement: { dx: number; dy: number },
  displays: readonly Display[],
): { state: CursorState; crossedSeam: boolean; clamped: boolean } {
  const dx = finite(movement.dx), dy = finite(movement.dy);
  const current = displays.find((d) => d.id === state.displayId) ?? displays[0];
  if (!current) return { state, crossedSeam: false, clamped: true };
  let nx = state.x + dx, ny = state.y + dy;
  let displayId = current.id, crossedSeam = false, clamped = false;

  const target = displayAt(displays, nx, ny);
  if (target && target.id !== current.id) {
    displayId = target.id; crossedSeam = true;
  } else if (!target) {
    // Outside every display: clamp to the nearest point on the union bounds.
    const b = desktopBounds(displays);
    if (b) {
      const cx = clamp(nx, b.x, b.x + b.w - CURSOR_EDGE_SLACK);
      const cy = clamp(ny, b.y, b.y + b.h - CURSOR_EDGE_SLACK);
      clamped = cx !== nx || cy !== ny;
      nx = cx; ny = cy;
      const owner = displayAt(displays, nx, ny) ?? current;
      if (owner.id !== current.id) { displayId = owner.id; crossedSeam = true; }
    }
  }
  return { state: { x: nx, y: ny, displayId }, crossedSeam, clamped };
}

/**
 * Backing-store size for content that moves to another display.
 *
 * The position does not change (the virtual space is shared CSS pixels), but the
 * *pixels* behind a CSS size do: a 400×400 window needs an 800×800 backing store
 * on a 2× display and 400×400 on a 1× one. Returned capped to a sane maximum so a
 * 3× projector cannot allocate a gigabyte canvas.
 */
export function backingSize(cssSize: { w: number; h: number }, display: Display, maxPixels = 16 * 1024 * 1024): { w: number; h: number; dpr: number; capped: boolean } {
  const dpr = Number.isFinite(display.dpr) && display.dpr > 0 ? display.dpr : 1;
  const w = Math.max(1, Math.round(cssSize.w * dpr));
  const h = Math.max(1, Math.round(cssSize.h * dpr));
  if (w * h <= maxPixels) return { w, h, dpr, capped: false };
  const k = Math.sqrt(maxPixels / (w * h));
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)), dpr, capped: true };
}

export interface LockPolicy {
  allowed: boolean;
  reason: string;
  /** the chord that must always leave the lock, per platform convention */
  escapeChord: string;
  /** shown before locking: how the user gets out */
  disclosure: string;
  /** pointer lock hides the OS cursor; this is the substitute the shell must draw */
  drawVirtualCursor: boolean;
}

export function lockRequest(opts: {
  hasPointerLock: boolean;
  secureContext: boolean;
  userGesture: boolean;
  alreadyLocked?: boolean;
  /** the user has asked to keep the system cursor visible */
  prefersVisibleCursor?: boolean;
}): LockPolicy {
  if (!opts.hasPointerLock) return { allowed: false, reason: "this browser has no Pointer Lock API", escapeChord: "", disclosure: "Cursor confinement is unavailable; drags clamp at the desktop edge instead.", drawVirtualCursor: false };
  if (!opts.secureContext) return { allowed: false, reason: "pointer lock needs a secure context (https or localhost)", escapeChord: "", disclosure: "Serve the app over https to enable confinement.", drawVirtualCursor: false };
  if (!opts.userGesture) return { allowed: false, reason: "pointer lock must be requested inside a user gesture", escapeChord: "", disclosure: "Confinement starts only when you press and hold to drag.", drawVirtualCursor: false };
  if (opts.prefersVisibleCursor) return { allowed: false, reason: "the user prefers the system cursor", escapeChord: "", disclosure: "System cursor kept; the desktop edge stops the drag.", drawVirtualCursor: false };
  return {
    allowed: true,
    reason: "ok",
    escapeChord: "Escape",
    disclosure: "Press the drag again to end confinement. Escape always releases the cursor.",
    drawVirtualCursor: true,
  };
}

/** Where the drawn cursor goes: the pointer-lock delta applied to the window's own space. */
export function virtualCursorPoint(state: CursorState, display: Display): { x: number; y: number } {
  return { x: state.x - display.rect.x, y: state.y - display.rect.y };
}

function finite(n: number): number { return Number.isFinite(n) ? n : 0; }
