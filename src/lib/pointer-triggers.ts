export type PointerAction = "launcher" | "overview" | "quickPanel" | "palette";
export type PointerEdge = "left" | "right" | "top" | "bottom";

export interface PointerSample {
  x: number;
  y: number;
  width: number;
  height: number;
  at: number;
  movementX?: number;
  movementY?: number;
  buttons?: number;
}

export const HOT_CORNER_WIDTH = 6;
export const HOT_CORNER_HEIGHT = 42;
export const EDGE_RAIL = 4;
export const EDGE_FLICK_DISTANCE = 18;
export const EDGE_FLICK_WINDOW_MS = 600;
export const MOUSE_GESTURE_MIN_DISTANCE = 36;
export const MOUSE_GESTURE_AXIS_RATIO = 1.25;

const EDGE_CORNER_GUARD = HOT_CORNER_HEIGHT;

type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
interface EdgeArm { edge: PointerEdge; x: number; y: number; at: number }

const CORNER_ACTION: Record<Corner, PointerAction> = {
  "top-left": "launcher",
  "top-right": "overview",
  "bottom-left": "quickPanel",
  "bottom-right": "palette",
};
const EDGE_ACTION: Record<PointerEdge, PointerAction> = {
  left: "launcher",
  right: "overview",
  top: "quickPanel",
  bottom: "palette",
};

function validViewport(s: PointerSample): boolean {
  return Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.width) && Number.isFinite(s.height)
    && Number.isFinite(s.at) && s.width > 0 && s.height > 0 && s.x >= 0 && s.y >= 0 && s.x < s.width && s.y < s.height;
}

function cornerAt(s: PointerSample): Corner | null {
  if (!validViewport(s)) return null;
  const w = Math.min(HOT_CORNER_WIDTH, s.width / 2);
  const h = Math.min(HOT_CORNER_HEIGHT, s.height / 2);
  const left = s.x < w, right = s.x >= s.width - w;
  const top = s.y < h, bottom = s.y >= s.height - h;
  if (left && top) return "top-left";
  if (right && top) return "top-right";
  if (left && bottom) return "bottom-left";
  if (right && bottom) return "bottom-right";
  return null;
}

function edgeAt(s: PointerSample): PointerEdge | null {
  if (!validViewport(s)) return null;
  if (s.height > EDGE_CORNER_GUARD * 2 && s.y >= EDGE_CORNER_GUARD && s.y < s.height - EDGE_CORNER_GUARD) {
    if (s.x < EDGE_RAIL) return "left";
    if (s.x >= s.width - EDGE_RAIL) return "right";
  }
  if (s.width > EDGE_CORNER_GUARD * 2 && s.x >= EDGE_CORNER_GUARD && s.x < s.width - EDGE_CORNER_GUARD) {
    if (s.y < EDGE_RAIL) return "top";
    if (s.y >= s.height - EDGE_RAIL) return "bottom";
  }
  return null;
}

function edgeEntry(previous: PointerSample, current: PointerSample): PointerEdge | null {
  const edge = edgeAt(current);
  if (!edge) return null;
  switch (edge) {
    case "left": return previous.x >= EDGE_RAIL ? edge : null;
    case "right": return previous.x < current.width - EDGE_RAIL ? edge : null;
    case "top": return previous.y >= EDGE_RAIL ? edge : null;
    case "bottom": return previous.y < current.height - EDGE_RAIL ? edge : null;
  }
}

function inwardDistance(edge: PointerEdge, arm: EdgeArm, current: PointerSample): number {
  switch (edge) {
    case "left": return current.x - arm.x;
    case "right": return arm.x - current.x;
    case "top": return current.y - arm.y;
    case "bottom": return arm.y - current.y;
  }
}

function tangentDistance(edge: PointerEdge, arm: EdgeArm, current: PointerSample): number {
  return edge === "left" || edge === "right" ? Math.abs(current.y - arm.y) : Math.abs(current.x - arm.x);
}

/**
 * In-memory entry/flick tracker for SH-06. The first point only establishes position, so a cursor already resting in
 * a corner cannot open a panel on mount. Corners trigger on entry. Edges first arm in the 4 px rail, then require an
 * inward flick; no event is prevented and no pointer position is persisted.
 */
export function createPointerTriggerTracker(): (sample: PointerSample) => PointerAction | null {
  let previous: PointerSample | null = null;
  let previousCorner: Corner | null = null;
  let edgeArm: EdgeArm | null = null;

  return (sample) => {
    const before = previous;
    previous = { ...sample };
    if (!validViewport(sample)) {
      previousCorner = null;
      edgeArm = null;
      return null;
    }

    const corner = cornerAt(sample);
    if (!before) {
      previousCorner = corner;
      edgeArm = null;
      return null;
    }

    const moved = typeof sample.movementX === "number" && typeof sample.movementY === "number"
      ? sample.movementX !== 0 || sample.movementY !== 0
      : sample.x !== before.x || sample.y !== before.y;
    if ((sample.buttons ?? 0) !== 0) {
      previousCorner = corner;
      edgeArm = null;
      return null;
    }

    if (corner) {
      edgeArm = null;
      const entered = moved && corner !== previousCorner;
      previousCorner = corner;
      return entered ? CORNER_ACTION[corner] : null;
    }
    previousCorner = null;
    if (!moved) return null;

    if (edgeArm) {
      const elapsed = sample.at - edgeArm.at;
      const activeEdge = edgeAt(sample);
      const invalid = elapsed < 0 || elapsed > EDGE_FLICK_WINDOW_MS
        || (activeEdge !== null && activeEdge !== edgeArm.edge)
        || tangentDistance(edgeArm.edge, edgeArm, sample) > EDGE_CORNER_GUARD;
      if (invalid) edgeArm = null;
      else if (inwardDistance(edgeArm.edge, edgeArm, sample) >= EDGE_FLICK_DISTANCE) {
        const action = EDGE_ACTION[edgeArm.edge];
        edgeArm = null;
        return action;
      }
    }

    if (!edgeArm) {
      const entered = edgeEntry(before, sample);
      if (entered) edgeArm = { edge: entered, x: sample.x, y: sample.y, at: sample.at };
    }
    return null;
  };
}

/** Right-button gesture classification; target/surface eligibility is handled at the DOM boundary. */
export function pointerGestureAction(button: number, dx: number, dy: number): PointerAction | null {
  if (button !== 2 || !Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const x = Math.abs(dx), y = Math.abs(dy);
  if (Math.max(x, y) < MOUSE_GESTURE_MIN_DISTANCE) return null;
  if (x >= y * MOUSE_GESTURE_AXIS_RATIO) return dx < 0 ? "launcher" : "overview";
  if (y >= x * MOUSE_GESTURE_AXIS_RATIO) return dy < 0 ? "quickPanel" : "palette";
  return null;
}
