/**
 * TT70 WM-13: drag a window across workspaces by holding it at the left / right edge of the desktop for 600 ms.
 * Pure state machine (the component owns the timer, because a pointer held still sends no events):
 *   - entering an edge zone ARMS a hop to the neighbouring workspace (only if one exists);
 *   - leaving the zone, releasing, cancelling or losing pointer capture DISARMS it (the component clears the timer);
 *   - after a hop the edge LATCHES: no second hop and no half-screen snap until the pointer has left the zone, so one
 *     long hold moves one workspace, and releasing right after a hop does not also tile the window.
 */
export const EDGE_HOLD_MS = 600;
export const EDGE_ZONE_PX = 8;

export type Side = -1 | 0 | 1;
export interface EdgeHold { side: Side; latched: Side }
export const EDGE_IDLE: EdgeHold = { side: 0, latched: 0 };

/** which edge zone the pointer is in (x relative to the desktop's left, width = desktop width) */
export function edgeSide(x: number, width: number, zone = EDGE_ZONE_PX): Side {
  if (!(width > 2 * zone)) return 0;
  if (x <= zone) return -1;
  if (x >= width - 1 - zone) return 1;
  return 0;
}

/** the workspace next to `active` in list order (left = previous, right = next); null at either end */
export function neighbourWorkspace(workspaces: readonly { id: number }[], active: number, side: Side): number | null {
  if (side === 0) return null;
  const i = workspaces.findIndex((w) => w.id === active);
  if (i < 0) return null;
  return workspaces[i + side]?.id ?? null;
}

/**
 * One pointer move. Returns the new state and what the component must do with its timer:
 * "arm" (start a fresh EDGE_HOLD_MS timer for `side`), "disarm" (clear it) or "keep".
 */
export function edgeMove(s: EdgeHold, side: Side, canHop: boolean): { state: EdgeHold; timer: "arm" | "disarm" | "keep" } {
  const latched = side === s.latched ? s.latched : 0; // leaving the latched edge releases the latch
  if (side === s.side) return { state: { side, latched }, timer: "keep" };
  if (side === 0 || side === latched || !canHop) return { state: { side, latched }, timer: "disarm" };
  return { state: { side, latched }, timer: "arm" };
}

/** the timer fired: hop (the component moves the window and switches workspace) and latch this edge */
export function edgeFired(s: EdgeHold): EdgeHold { return { side: s.side, latched: s.side }; }

/** while latched at an edge, the half-screen snap of that side is suppressed */
export const snapSuppressed = (s: EdgeHold) => s.latched !== 0 && s.side === s.latched;
