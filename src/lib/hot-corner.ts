/**
 * SH-06 hot corner (TT67). A corner fires ONCE when the pointer ENTERS it and re-arms only after the pointer has left —
 * the macOS behaviour. Until TT67 the desktop re-fired every 1.2 s while the pointer stayed in the corner, so a resting
 * (jittering) pointer reopened the launcher the user had just closed with Escape.
 */
export type HotCornerZone = { w: number; h: number };
export const TOP_LEFT_ZONE: HotCornerZone = { w: 6, h: 42 };
/**
 * TT69: two rules against a launcher that opened with no user motion (seen in 3 browser suites: it covered the page):
 *  - the FIRST event seen only arms the tracker (a pointer already resting in the corner when tracking starts is not
 *    an entry);
 *  - an event with zero movement (a browser's synthetic hover update at a resting cursor) never fires; it still updates
 *    where the pointer is (Chromium's first pointerrawupdate of a session reports movement 0 — it must arm the tracker). Pass movementX / movementY when known; omit them for "unknown" (treated as motion).
 */
export function hotCornerTracker(zone: HotCornerZone = TOP_LEFT_ZONE): (x: number, y: number, mx?: number, my?: number) => boolean {
  let inside: boolean | null = null;
  return (x, y, mx, my) => {
    const now = x >= 0 && y >= 0 && x < zone.w && y < zone.h;
    const fire = inside === false && now && !(mx === 0 && my === 0);
    inside = now;
    return fire;
  };
}
