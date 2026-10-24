/**
 * TT28 Business "Snap": layouts, drag targets and Snap Assist order. Pure and hook-free (unit-tested by
 * scripts/snap-unit.mts). Original code, modelled on the BEHAVIOUR users know from Windows 11 (layout flyout on the
 * maximise button, drag to an edge for a half, to a corner for a quarter, then "Snap Assist" offering the other open
 * windows for the zones that are still empty). No Microsoft code or assets are involved.
 */

export interface Rect { x: number; y: number; w: number; h: number }
/** A zone as fractions of the desk (0…1). */
export interface Zone { key: string; fx: number; fy: number; fw: number; fh: number }
export interface SnapLayout { id: string; label: string; zones: Zone[]; minWidth?: number }

const z = (key: string, fx: number, fy: number, fw: number, fh: number): Zone => ({ key, fx, fy, fw, fh });
const T1 = 1 / 3, T2 = 2 / 3;

/** The flyout's layouts, in display order. Wide-only layouts carry minWidth (as Windows hides them on narrow screens). */
export const SNAP_LAYOUTS: SnapLayout[] = [
  { id: "halves", label: "Two halves", zones: [z("left", 0, 0, .5, 1), z("right", .5, 0, .5, 1)] },
  { id: "two-thirds", label: "Two thirds and one third", zones: [z("major", 0, 0, T2, 1), z("minor", T2, 0, T1, 1)] },
  { id: "thirds", label: "Three columns", zones: [z("third-l", 0, 0, T1, 1), z("third-c", T1, 0, T1, 1), z("third-r", T2, 0, T1, 1)] },
  { id: "half-quarters", label: "Half and two quarters", zones: [z("left", 0, 0, .5, 1), z("tr", .5, 0, .5, .5), z("br", .5, .5, .5, .5)] },
  { id: "quarters", label: "Four quarters", zones: [z("tl", 0, 0, .5, .5), z("tr", .5, 0, .5, .5), z("bl", 0, .5, .5, .5), z("br", .5, .5, .5, .5)] },
  { id: "wide-centre", label: "Quarter, half, quarter", minWidth: 1600, zones: [z("q-l", 0, 0, .25, 1), z("centre", .25, 0, .5, 1), z("q-r", .75, 0, .25, 1)] },
];

export const layoutsFor = (deskW: number): SnapLayout[] => SNAP_LAYOUTS.filter((l) => !l.minWidth || deskW >= l.minWidth);
export const layoutById = (id: string): SnapLayout | null => SNAP_LAYOUTS.find((l) => l.id === id) ?? null;

/**
 * Integer rect for a zone. Edges are computed from the fractional EDGES (not origin + size), so neighbouring zones
 * share the same pixel edge: a layout always tiles the desk exactly, with no 1-px gaps or overlaps at any size.
 */
export function zoneRect(zone: Zone, desk: { w: number; h: number }): Rect {
  const W = Math.max(0, Math.floor(desk.w)), H = Math.max(0, Math.floor(desk.h));
  const x0 = Math.round(zone.fx * W), x1 = Math.round((zone.fx + zone.fw) * W);
  const y0 = Math.round(zone.fy * H), y1 = Math.round((zone.fy + zone.fh) * H);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ------------------------------------------------------------------ dragging */
export interface DragTarget { key: "full" | "left" | "right" | "tl" | "tr" | "bl" | "br"; rect: Rect; layout: string }
const EDGE = 8;       // px from the desk edge that counts as "at the edge"
/** Corner region along an edge: where a drag to the side becomes a quarter instead of a half. */
export const cornerSpan = (desk: { w: number; h: number }) => Math.round(Math.max(48, Math.min(160, Math.min(desk.w, desk.h) * 0.16)));

/**
 * Where a window being dragged by its title bar would snap, from the POINTER position in desk coordinates
 * (like the OSes, it's the pointer that matters, not the window's edge). Corners give quarters, the side edges give
 * halves, the top edge maximises; anything else returns null. The bottom edge only snaps in its corners.
 */
export function dragTarget(px: number, py: number, desk: { w: number; h: number }): DragTarget | null {
  const W = desk.w, H = desk.h; if (!(W > 0 && H > 0) || !Number.isFinite(px) || !Number.isFinite(py)) return null;
  const c = cornerSpan(desk);
  const atL = px <= EDGE, atR = px >= W - EDGE, atT = py <= EDGE, atB = py >= H - EDGE;
  const nearT = py <= c, nearB = py >= H - c, nearL = px <= c, nearR = px >= W - c;
  let key: DragTarget["key"] | null = null;
  if ((atL && nearT) || (atT && nearL)) key = "tl";
  else if ((atR && nearT) || (atT && nearR)) key = "tr";
  else if ((atL && nearB) || (atB && nearL)) key = "bl";
  else if ((atR && nearB) || (atB && nearR)) key = "br";
  else if (atT) key = "full";
  else if (atL) key = "left";
  else if (atR) key = "right";
  if (!key) return null;
  const layout = key === "left" || key === "right" ? "halves" : key === "full" ? "" : "quarters";
  const zone = key === "full" ? z("full", 0, 0, 1, 1) : layoutById(layout)!.zones.find((q) => q.key === key)!;
  return { key, rect: zoneRect(zone, desk), layout };
}

/* --------------------------------------------------------------- snap assist */
export interface AssistPlan { layout: string; zones: { key: string; rect: Rect }[] }
/**
 * After a window lands in zone `filledKey` of `layoutId`, the zones still to fill, in reading order (top-to-bottom,
 * left-to-right). Returns null when nothing is left or there are no other windows to offer.
 */
export function assistPlan(layoutId: string, filledKey: string, desk: { w: number; h: number }, otherWindows: number): AssistPlan | null {
  const l = layoutById(layoutId); if (!l || otherWindows <= 0) return null;
  const zones = l.zones.filter((q) => q.key !== filledKey)
    .map((q) => ({ key: q.key, rect: zoneRect(q, desk) }))
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  return zones.length ? { layout: l.id, zones } : null;
}

/** Mini-diagram geometry for the flyout: each zone in a box of `w`×`h` px with `gap` px gutters. */
export function thumbZones(l: SnapLayout, w: number, h: number, gap = 3): (Rect & { key: string })[] {
  return l.zones.map((q) => {
    const r = zoneRect(q, { w, h });
    const gl = q.fx > 0 ? gap / 2 : 0, gr = q.fx + q.fw < 0.999 ? gap / 2 : 0;
    const gt = q.fy > 0 ? gap / 2 : 0, gb = q.fy + q.fh < 0.999 ? gap / 2 : 0;
    return { key: q.key, x: r.x + gl, y: r.y + gt, w: Math.max(1, r.w - gl - gr), h: Math.max(1, r.h - gt - gb) };
  });
}
