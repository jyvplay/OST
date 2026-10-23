/**
 * SH-06 hot corner (TT67). A corner fires ONCE when the pointer ENTERS it and re-arms only after the pointer has left —
 * the macOS behaviour. Until TT67 the desktop re-fired every 1.2 s while the pointer stayed in the corner, so a resting
 * (jittering) pointer reopened the launcher the user had just closed with Escape.
 */
export type HotCornerZone = { w: number; h: number };
export const TOP_LEFT_ZONE: HotCornerZone = { w: 6, h: 42 };
export function hotCornerTracker(zone: HotCornerZone = TOP_LEFT_ZONE): (x: number, y: number) => boolean {
  let inside = false;
  return (x, y) => {
    const now = x >= 0 && y >= 0 && x < zone.w && y < zone.h;
    const fire = now && !inside;
    inside = now;
    return fire;
  };
}
