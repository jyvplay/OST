/**
 * TT37 — IN-07 gamepad pointer mode: the pure mapping from a Gamepad snapshot to pointer motion, scrolling and
 * edge-triggered actions. No DOM here (src/components/GamepadPointer.tsx applies the result), so every rule is
 * unit-testable with exact numbers.
 *
 * Button / axis indices follow the W3C Gamepad "standard" mapping: buttons 0 bottom face (A / Cross), 1 right face
 * (B / Circle), 2 left face (X / Square), 3 top face (Y / Triangle), 4 / 5 front bumpers (LB / RB), 8 select,
 * 9 start, 12–15 d-pad up / down / left / right; axes 0 / 1 left stick x / y, 2 / 3 right stick x / y (y down = +1).
 * Pads without the standard mapping still get the left stick, A and B (indices 0 / 1 are the same on nearly all).
 */
export interface PadSnapshot { axes: readonly number[]; buttons: readonly { pressed: boolean; value?: number }[]; mapping?: string }
export interface PointerState { x: number; y: number; enabled: boolean; held: boolean[]; repeatAt: number[]; carryScroll: number; /** a "down" was emitted and its "up" is owed */ downSent: boolean }
export type PadAction =
  | { type: "move"; x: number; y: number }
  | { type: "down" } | { type: "up" } // A pressed / released → pointerdown / pointerup + click
  | { type: "context" } // X → contextmenu
  | { type: "escape" } // B
  | { type: "focus"; dir: 1 | -1 } // RB / LB → next / previous focusable
  | { type: "scroll"; dy: number; dx: number }
  | { type: "toggle"; enabled: boolean }; // Start

export const DEADZONE = 0.15;
export const MAX_SPEED = 1400; // px / s at full deflection
export const CURVE = 2.2; // response exponent: fine control near the centre, speed at the edge
export const SCROLL_SPEED = 1600; // px / s at full right-stick deflection
export const NUDGE = 1; // px per d-pad step
export const REPEAT_DELAY = 350, REPEAT_RATE = 45; // ms: first auto-repeat, then every 45 ms

export function initialState(vw: number, vh: number): PointerState {
  return { x: Math.round(vw / 2), y: Math.round(vh / 2), enabled: true, held: [], repeatAt: [], carryScroll: 0, downSent: false };
}

/** Radial deadzone + power curve: maps a raw stick (x, y) to a velocity factor in [-1, 1]² with |v| ≤ 1. */
export function shapeStick(x: number, y: number, dz = DEADZONE, curve = CURVE): [number, number] {
  const fx = Number.isFinite(x) ? x : 0, fy = Number.isFinite(y) ? y : 0;
  const m = Math.hypot(fx, fy);
  if (m <= dz) return [0, 0];
  const mm = Math.min(1, m);
  const k = Math.pow((mm - dz) / (1 - dz), curve) / m; // scale the direction vector, keep its angle
  return [fx * k, fy * k];
}

const pressed = (p: PadSnapshot, i: number) => !!p.buttons[i]?.pressed;

/**
 * One frame. `dt` in ms (clamped to 100 so a stalled tab does not teleport the cursor), viewport in CSS px.
 * Returns the new state and the actions to apply, in order.
 */
export function step(s: PointerState, p: PadSnapshot, dt: number, now: number, vw: number, vh: number): { state: PointerState; actions: PadAction[] } {
  const actions: PadAction[] = [];
  const standard = p.mapping === "standard";
  const d = Math.max(0, Math.min(100, Number.isFinite(dt) ? dt : 0)) / 1000;
  const held = [...s.held], repeatAt = [...s.repeatAt];
  const edge = (i: number) => { const now_ = pressed(p, i), was = !!held[i]; held[i] = now_; return now_ && !was ? "down" : !now_ && was ? "up" : null; };
  let enabled = s.enabled;
  let owed = s.downSent;
  if (standard && edge(9) === "down") {
    enabled = !enabled;
    if (!enabled && owed) { actions.push({ type: "up" }); owed = false; } // never leave the page with a stuck press
    actions.push({ type: "toggle", enabled });
  }
  if (!enabled) {
    // keep tracking edges so releasing a button after re-enabling does not fire a stray "up"
    for (let i = 0; i < Math.max(p.buttons.length, held.length); i++) if (i !== 9) held[i] = pressed(p, i);
    return { state: { ...s, enabled, held, repeatAt, downSent: owed }, actions };
  }
  let { x, y } = s;
  const [vx, vy] = shapeStick(p.axes[0] ?? 0, p.axes[1] ?? 0);
  x += vx * MAX_SPEED * d; y += vy * MAX_SPEED * d;
  if (standard) {
    for (const [i, dx, dy] of [[12, 0, -1], [13, 0, 1], [14, -1, 0], [15, 1, 0]] as const) {
      const e = edge(i);
      if (e === "down") { x += dx * NUDGE; y += dy * NUDGE; repeatAt[i] = now + REPEAT_DELAY; }
      else if (pressed(p, i) && now >= (repeatAt[i] ?? Infinity)) { x += dx * NUDGE; y += dy * NUDGE; repeatAt[i] = now + REPEAT_RATE; }
    }
  }
  x = Math.max(0, Math.min(vw - 1, x)); y = Math.max(0, Math.min(vh - 1, y));
  if (x !== s.x || y !== s.y) actions.push({ type: "move", x, y });
  const a = edge(0);
  let downSent = owed;
  // an "up" only answers a "down" we sent: A pressed while the mode was off must not click on release
  if (a === "down") { actions.push({ type: "down" }); downSent = true; } else if (a === "up" && downSent) { actions.push({ type: "up" }); downSent = false; }
  if (edge(1) === "down") actions.push({ type: "escape" });
  if (standard) {
    if (edge(2) === "down") actions.push({ type: "context" });
    if (edge(5) === "down") actions.push({ type: "focus", dir: 1 });
    if (edge(4) === "down") actions.push({ type: "focus", dir: -1 });
  }
  let carryScroll = s.carryScroll;
  if (standard) {
    const [sx, sy] = shapeStick(p.axes[2] ?? 0, p.axes[3] ?? 0);
    const dy = sy * SCROLL_SPEED * d + carryScroll, dx = sx * SCROLL_SPEED * d;
    const whole = Math.trunc(dy);
    carryScroll = sy === 0 ? 0 : dy - whole; // sub-pixel scroll carries over, so slow scrolling still moves
    if (whole !== 0 || Math.abs(dx) >= 1) actions.push({ type: "scroll", dy: whole, dx: Math.trunc(dx) });
  }
  return { state: { x, y, enabled, held, repeatAt, carryScroll, downSent }, actions };
}
