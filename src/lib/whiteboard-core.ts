/**
 * Whiteboard (TT23) — the pure engine behind the Whiteboard module. No React or DOM, so scripts/whiteboard-engine.mts
 * can test it under Node.
 *
 * Model. A board is an ordered list of elements; array order is z-order (last is on top).
 *   • Shapes (rect, ellipse, diamond, sticky, text) are boxes: x, y, w, h with w, h ≥ 0.
 *   • Line and arrow use x, y for the start point and x + w, y + h for the end, so w and h may be negative.
 *   • A connector end may be BOUND to a shape (`start` / `end` = element id). A bound end is never stored as a
 *     coordinate: on every render it is re-resolved to the point where the line from the other end meets the shape's
 *     boundary. Moving a shape therefore drags its connectors with it.
 *   • Pen strokes store points relative to x, y and are simplified with Ramer–Douglas–Peucker.
 *
 * Every operation returns a new Board; the module keeps the snapshots as an exact undo history.
 *
 * Honest scope (also in docs/WHITEBOARD.md):
 *   • no real-time multi-user editing; no images or embeds;
 *   • no curved or elbow connectors;
 *   • text is not auto-wrapped (explicit line breaks only);
 *   • no rotation;
 *   • SVG export only (no PNG or PDF).
 */

export const BOARD_FORMAT = "fusion-board-1";
export type Kind = "rect" | "ellipse" | "diamond" | "sticky" | "text" | "line" | "arrow" | "pen";
export const SHAPE_KINDS: readonly Kind[] = ["rect", "ellipse", "diamond", "sticky", "text"];
export const KINDS: readonly Kind[] = [...SHAPE_KINDS, "line", "arrow", "pen"];
export const MAX_ELEMENTS = 5000;

export interface El {
  id: string; kind: Kind;
  x: number; y: number; w: number; h: number;
  stroke: string; fill: string; sw: number; text: string;
  pts?: [number, number][];
  start?: string | null; end?: string | null;
  group?: string | null;
}
export interface Board { format: typeof BOARD_FORMAT; els: El[]; seq: number }
export interface Pt { x: number; y: number }
export interface Box { x: number; y: number; w: number; h: number }

/** Sticky-note and stroke colours: all reach ≥ 4.5:1 with the #1b1b1f text drawn on them (checked in the engine suite). */
export const STICKY_COLORS = ["#fff1a8", "#ffd6e0", "#c9f0dc", "#cfe3ff", "#e6d9ff", "#ffe0c2"] as const;
export const STROKE_COLORS = ["#1b1b1f", "#c62828", "#1565c0", "#2e7d32", "#6a1b9a", "#ef6c00"] as const;
export const TEXT_INK = "#1b1b1f";

export const emptyBoard = (): Board => ({ format: BOARD_FORMAT, els: [], seq: 1 });
export const isShape = (e: El) => SHAPE_KINDS.includes(e.kind);
export const isConnector = (e: El) => e.kind === "line" || e.kind === "arrow";
const byId = (b: Board, id: string | null | undefined) => (id ? b.els.find((e) => e.id === id) : undefined);

const DEFAULTS: Record<Kind, Partial<El>> = {
  rect: { stroke: "#1b1b1f", fill: "transparent", sw: 2 },
  ellipse: { stroke: "#1b1b1f", fill: "transparent", sw: 2 },
  diamond: { stroke: "#1b1b1f", fill: "transparent", sw: 2 },
  sticky: { stroke: "transparent", fill: STICKY_COLORS[0], sw: 0 },
  text: { stroke: "transparent", fill: "transparent", sw: 0 },
  line: { stroke: "#1b1b1f", fill: "transparent", sw: 2 },
  arrow: { stroke: "#1b1b1f", fill: "transparent", sw: 2 },
  pen: { stroke: "#1b1b1f", fill: "transparent", sw: 2 },
};

/** Add an element. Shapes are normalised so w, h ≥ 0 (a box dragged up-left is stored the same as one dragged down-right). */
export function addEl(b: Board, p: Partial<El> & { kind: Kind }): [Board, string] {
  if (b.els.length >= MAX_ELEMENTS) throw new Error(`a board holds at most ${MAX_ELEMENTS} elements`);
  const id = `e${b.seq}`;
  let el = canon({ x: 0, y: 0, w: 0, h: 0, stroke: "#1b1b1f", fill: "transparent", sw: 2, text: "", ...DEFAULTS[p.kind], ...p, id });
  if (isShape(el)) el = normBox(el);
  return [{ ...b, els: [...b.els, el], seq: b.seq + 1 }, id];
}
/** One canonical key set and order, so a saved board re-loads byte-identical (tested). */
function canon(e: Partial<El> & { id: string; kind: Kind }): El {
  const out: El = { id: e.id, kind: e.kind, x: e.x ?? 0, y: e.y ?? 0, w: e.w ?? 0, h: e.h ?? 0, stroke: e.stroke ?? "#1b1b1f", fill: e.fill ?? "transparent", sw: e.sw ?? 2, text: e.text ?? "", group: e.group ?? null, start: e.start ?? null, end: e.end ?? null };
  if (e.pts) out.pts = e.pts;
  return out;
}
function normBox(e: El): El {
  const x = e.w < 0 ? e.x + e.w : e.x, y = e.h < 0 ? e.y + e.h : e.y;
  return { ...e, x, y, w: Math.abs(e.w), h: Math.abs(e.h) };
}

export function patch(b: Board, ids: string[], fn: (e: El) => Partial<El>): Board {
  const set = new Set(ids);
  return { ...b, els: b.els.map((e) => (set.has(e.id) ? { ...e, ...fn(e) } : e)) };
}

/** All members of any group touched by `ids` (selecting one grouped element selects the group). */
export function expandGroups(b: Board, ids: string[]): string[] {
  const groups = new Set(ids.map((id) => byId(b, id)?.group).filter(Boolean));
  const out = new Set(ids);
  for (const e of b.els) if (e.group && groups.has(e.group)) out.add(e.id);
  return [...out];
}

/* ---------------------------------------------------------------------------------------------- geometry */

export const center = (e: Box): Pt => ({ x: e.x + e.w / 2, y: e.y + e.h / 2 });

/**
 * Where the ray from a shape's centre towards `toward` leaves the shape.
 *   • rect, sticky, text: the box edge.
 *   • ellipse: solve (dx·t/rx)² + (dy·t/ry)² = 1.
 *   • diamond: |dx·t|/(w/2) + |dy·t|/(h/2) = 1.
 */
export function boundaryPoint(e: El, toward: Pt): Pt {
  const c = center(e), dx = toward.x - c.x, dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const rx = Math.max(e.w / 2, 0.0001), ry = Math.max(e.h / 2, 0.0001);
  let t: number;
  if (e.kind === "ellipse") t = 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
  else if (e.kind === "diamond") t = 1 / (Math.abs(dx) / rx + Math.abs(dy) / ry);
  else t = Math.min(dx === 0 ? Infinity : rx / Math.abs(dx), dy === 0 ? Infinity : ry / Math.abs(dy));
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** The connector's real end points, with bound ends resolved to their shapes' boundaries. */
export function resolveConnector(b: Board, e: El): { a: Pt; z: Pt } {
  const s = byId(b, e.start), t = byId(b, e.end);
  const rawA = { x: e.x, y: e.y }, rawZ = { x: e.x + e.w, y: e.y + e.h };
  const aim = (other: El | undefined, raw: Pt) => (other ? center(other) : raw);
  if (s && t && s.id === t.id) return { a: boundaryPoint(s, rawZ), z: boundaryPoint(t, rawA) };
  return {
    a: s ? boundaryPoint(s, aim(t, rawZ)) : rawA,
    z: t ? boundaryPoint(t, aim(s, rawA)) : rawZ,
  };
}

/** Axis-aligned bounds of any element (connectors via their resolved end points, pen via its points). */
export function bounds(b: Board, e: El): Box {
  if (isConnector(e)) {
    const { a, z } = resolveConnector(b, e);
    return { x: Math.min(a.x, z.x), y: Math.min(a.y, z.y), w: Math.abs(z.x - a.x), h: Math.abs(z.y - a.y) };
  }
  if (e.kind === "pen" && e.pts?.length) {
    const xs = e.pts.map((p) => p[0] + e.x), ys = e.pts.map((p) => p[1] + e.y);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  return { x: e.x, y: e.y, w: e.w, h: e.h };
}
export function unionBox(boxes: Box[]): Box | null {
  if (!boxes.length) return null;
  const x = Math.min(...boxes.map((r) => r.x)), y = Math.min(...boxes.map((r) => r.y));
  return { x, y, w: Math.max(...boxes.map((r) => r.x + r.w)) - x, h: Math.max(...boxes.map((r) => r.y + r.h)) - y };
}

export function distToSegment(p: Pt, a: Pt, z: Pt): number {
  const vx = z.x - a.x, vy = z.y - a.y, len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/** Is `p` inside the shape itself (not just its bounding box)? */
export function insideShape(e: El, p: Pt, tol = 0): boolean {
  const c = center(e), rx = e.w / 2 + tol, ry = e.h / 2 + tol;
  if (rx <= 0 || ry <= 0) return false;
  const dx = p.x - c.x, dy = p.y - c.y;
  if (e.kind === "ellipse") return (dx / rx) ** 2 + (dy / ry) ** 2 <= 1;
  if (e.kind === "diamond") return Math.abs(dx) / rx + Math.abs(dy) / ry <= 1;
  return Math.abs(dx) <= rx && Math.abs(dy) <= ry;
}

/** Topmost element under the point. Connectors and pen strokes count within `tol` of the stroke. */
export function hitTest(b: Board, p: Pt, tol = 6): string | null {
  for (let i = b.els.length - 1; i >= 0; i--) {
    const e = b.els[i];
    if (isShape(e)) { if (insideShape(e, p, tol / 2)) return e.id; continue; }
    if (isConnector(e)) { const { a, z } = resolveConnector(b, e); if (distToSegment(p, a, z) <= tol + e.sw / 2) return e.id; continue; }
    const pts = (e.pts ?? []).map(([x, y]) => ({ x: x + e.x, y: y + e.y }));
    for (let k = 1; k < pts.length; k++) if (distToSegment(p, pts[k - 1], pts[k]) <= tol + e.sw / 2) return e.id;
    if (pts.length === 1 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= tol) return e.id;
  }
  return null;
}

/** The topmost shape that can take a connector end at `p` (lines, arrows, pen strokes and `exclude` are skipped). */
export function bindTarget(b: Board, p: Pt, exclude?: string): string | null {
  for (let i = b.els.length - 1; i >= 0; i--) {
    const e = b.els[i];
    if (e.id !== exclude && isShape(e) && insideShape(e, p, 4)) return e.id;
  }
  return null;
}

/** Elements whose whole bounds lie inside the marquee (the Excalidraw / Figma rule). */
export function marquee(b: Board, box: Box): string[] {
  const r = { x: Math.min(box.x, box.x + box.w), y: Math.min(box.y, box.y + box.h), w: Math.abs(box.w), h: Math.abs(box.h) };
  return b.els.filter((e) => {
    const q = bounds(b, e);
    return q.x >= r.x && q.y >= r.y && q.x + q.w <= r.x + r.w && q.y + q.h <= r.y + r.h;
  }).map((e) => e.id);
}

/** Ramer–Douglas–Peucker polyline simplification. The end points are always kept. */
export function simplify(pts: [number, number][], eps = 1.2): [number, number][] {
  if (pts.length < 3) return pts.slice();
  const a = { x: pts[0][0], y: pts[0][1] }, z = { x: pts.at(-1)![0], y: pts.at(-1)![1] };
  let worst = 0, idx = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distToSegment({ x: pts[i][0], y: pts[i][1] }, a, z);
    if (d > worst) { worst = d; idx = i; }
  }
  if (worst <= eps) return [pts[0], pts.at(-1)!];
  return [...simplify(pts.slice(0, idx + 1), eps).slice(0, -1), ...simplify(pts.slice(idx), eps)];
}

export const snap = (v: number, grid: number) => (grid > 0 ? Math.round(v / grid) * grid : v);

/* ---------------------------------------------------------------------------------------------- editing */

/** Freeze a connector end that is about to lose its shape: its resolved position is written back as coordinates. */
function freezeEnds(b: Board, e: El, dropStart: boolean, dropEnd: boolean): El {
  if (!dropStart && !dropEnd) return e;
  const { a, z } = resolveConnector(b, e);
  const A = dropStart ? a : { x: e.x, y: e.y }, Z = dropEnd ? z : { x: e.x + e.w, y: e.y + e.h };
  return { ...e, x: A.x, y: A.y, w: Z.x - A.x, h: Z.y - A.y, start: dropStart ? null : e.start, end: dropEnd ? null : e.end };
}

/**
 * Move elements by (dx, dy).
 *   • Shapes and pen strokes translate.
 *   • A connector that moves keeps an end bound only if that end's shape moves with it; otherwise the end is
 *     detached at its resolved position, then translated.
 *   • Connectors that are not selected but are bound to moving shapes follow automatically, because their ends are
 *     resolved at render time.
 */
export function move(b: Board, ids: string[], dx: number, dy: number): Board {
  const set = new Set(ids);
  return {
    ...b, els: b.els.map((e) => {
      if (!set.has(e.id)) return e;
      if (isConnector(e)) {
        const f = freezeEnds(b, e, !!e.start && !set.has(e.start), !!e.end && !set.has(e.end));
        return { ...f, x: f.x + dx, y: f.y + dy };
      }
      return { ...e, x: e.x + dx, y: e.y + dy };
    }),
  };
}

/** Resize to a new box (shapes normalise; pen strokes scale their points; a connector's raw end points are re-set). */
export function resize(b: Board, id: string, box: Box): Board {
  return {
    ...b, els: b.els.map((e) => {
      if (e.id !== id) return e;
      if (isShape(e)) return normBox({ ...e, ...box });
      if (e.kind === "pen" && e.pts?.length) {
        const old = bounds(b, e), sx = old.w ? box.w / old.w : 1, sy = old.h ? box.h / old.h : 1;
        const pts = e.pts.map(([x, y]) => [box.x + (x + e.x - old.x) * sx, box.y + (y + e.y - old.y) * sy] as [number, number]);
        return { ...e, x: 0, y: 0, pts };
      }
      return { ...e, ...box };
    }),
  };
}

/** Delete elements. Connectors bound to a deleted shape are kept and detached at their resolved positions. */
export function remove(b: Board, ids: string[]): Board {
  const gone = new Set(ids);
  return {
    ...b, els: b.els.filter((e) => !gone.has(e.id)).map((e) =>
      isConnector(e) ? freezeEnds(b, e, !!e.start && gone.has(e.start), !!e.end && gone.has(e.end)) : e),
  };
}

/**
 * Duplicate elements, offset by `off`. The copies get fresh ids.
 *   • A binding is kept only between copied elements (it is remapped to the copy); any other binding is detached.
 *   • Groups are remapped to new group ids.
 */
export function duplicate(b: Board, ids: string[], off = 16): [Board, string[]] {
  const set = new Set(ids), map = new Map<string, string>(), gmap = new Map<string, string>();
  let seq = b.seq;
  for (const e of b.els) if (set.has(e.id)) map.set(e.id, `e${seq++}`);
  const copies: El[] = [];
  for (const e of b.els) {
    if (!set.has(e.id)) continue;
    let c: El = isConnector(e) ? freezeEnds(b, e, !!e.start && !set.has(e.start), !!e.end && !set.has(e.end)) : { ...e };
    if (c.group) { if (!gmap.has(c.group)) gmap.set(c.group, `g${seq++}`); c = { ...c, group: gmap.get(c.group)! }; }
    c = { ...c, id: map.get(e.id)!, x: c.x + off, y: c.y + off, start: c.start ? map.get(c.start) ?? null : c.start, end: c.end ? map.get(c.end) ?? null : c.end };
    if (c.pts) c.pts = c.pts.map((p) => [p[0], p[1]] as [number, number]);
    copies.push(c);
  }
  if (b.els.length + copies.length > MAX_ELEMENTS) throw new Error(`a board holds at most ${MAX_ELEMENTS} elements`);
  return [{ ...b, els: [...b.els, ...copies], seq }, copies.map((c) => c.id)];
}

export type Order = "front" | "back" | "forward" | "backward";
/** Change z-order; the selection's relative order is preserved. */
export function reorder(b: Board, ids: string[], how: Order): Board {
  const set = new Set(ids);
  const sel = b.els.filter((e) => set.has(e.id)), rest = b.els.filter((e) => !set.has(e.id));
  if (how === "front") return { ...b, els: [...rest, ...sel] };
  if (how === "back") return { ...b, els: [...sel, ...rest] };
  const els = b.els.slice();
  if (how === "forward") {
    for (let i = els.length - 2; i >= 0; i--) if (set.has(els[i].id) && !set.has(els[i + 1].id)) [els[i], els[i + 1]] = [els[i + 1], els[i]];
  } else {
    for (let i = 1; i < els.length; i++) if (set.has(els[i].id) && !set.has(els[i - 1].id)) [els[i], els[i - 1]] = [els[i - 1], els[i]];
  }
  return { ...b, els };
}

export function group(b: Board, ids: string[]): Board {
  if (ids.length < 2) return b;
  const g = `g${b.seq}`;
  return { ...patch(b, ids, () => ({ group: g })), seq: b.seq + 1 };
}
export const ungroup = (b: Board, ids: string[]): Board => patch(b, expandGroups(b, ids), () => ({ group: null }));

export type Align = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
/** Align to the selection's bounding box (connectors follow their shapes, so they are not moved themselves). */
export function align(b: Board, ids: string[], how: Align): Board {
  const els = b.els.filter((e) => ids.includes(e.id) && !isConnector(e));
  const box = unionBox(els.map((e) => bounds(b, e)));
  if (!box || els.length < 2) return b;
  let out = b;
  for (const e of els) {
    const r = bounds(b, e);
    const dx = how === "left" ? box.x - r.x : how === "right" ? box.x + box.w - (r.x + r.w) : how === "hcenter" ? box.x + box.w / 2 - (r.x + r.w / 2) : 0;
    const dy = how === "top" ? box.y - r.y : how === "bottom" ? box.y + box.h - (r.y + r.h) : how === "vcenter" ? box.y + box.h / 2 - (r.y + r.h / 2) : 0;
    out = move(out, [e.id], dx, dy);
  }
  return out;
}

/** Equal gaps between ≥ 3 elements along an axis; the outermost two stay put. */
export function distribute(b: Board, ids: string[], axis: "h" | "v"): Board {
  const els = b.els.filter((e) => ids.includes(e.id) && !isConnector(e));
  if (els.length < 3) return b;
  const k = axis === "h" ? "x" : "y", s = axis === "h" ? "w" : "h";
  const rs = els.map((e) => ({ e, r: bounds(b, e) })).sort((p, q) => p.r[k] - q.r[k]);
  const first = rs[0].r, last = rs.at(-1)!.r;
  const total = rs.reduce((n, q) => n + q.r[s], 0);
  const gap = (last[k] + last[s] - first[k] - total) / (rs.length - 1);
  let cur = first[k] + first[s] + gap, out = b;
  for (const q of rs.slice(1, -1)) {
    out = move(out, [q.e.id], axis === "h" ? cur - q.r.x : 0, axis === "v" ? cur - q.r.y : 0);
    cur += q.r[s] + gap;
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- import / export */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const COLOR = /^(#[0-9a-f]{3,8}|transparent)$/i;
const num = (n: number) => +n.toFixed(2);

/** Standalone SVG. Text is escaped, colours are whitelisted, and the output contains no script or foreign content. */
export function toSvg(b: Board, pad = 24): string {
  const box = unionBox(b.els.map((e) => bounds(b, e))) ?? { x: 0, y: 0, w: 100, h: 100 };
  const vb = [box.x - pad, box.y - pad, box.w + pad * 2, box.h + pad * 2].map(num);
  const c = (v: string) => (COLOR.test(v) ? v : "#1b1b1f");
  const textOf = (e: El, cx: number, cy: number, size = 16) => {
    if (!e.text) return "";
    const lines = e.text.split("\n");
    return `<text x="${num(cx)}" y="${num(cy - ((lines.length - 1) * size * 1.25) / 2)}" font-family="Nunito, system-ui, sans-serif" font-size="${size}" fill="${TEXT_INK}" text-anchor="middle" dominant-baseline="middle">${lines.map((l, i) => `<tspan x="${num(cx)}" dy="${i ? size * 1.25 : 0}">${esc(l)}</tspan>`).join("")}</text>`;
  };
  const parts = b.els.map((e) => {
    const st = `stroke="${c(e.stroke)}" stroke-width="${num(e.sw)}" fill="${c(e.fill)}"`;
    const m = center(e);
    switch (e.kind) {
      case "rect": return `<rect x="${num(e.x)}" y="${num(e.y)}" width="${num(e.w)}" height="${num(e.h)}" rx="6" ${st}/>${textOf(e, m.x, m.y)}`;
      case "sticky": return `<rect x="${num(e.x)}" y="${num(e.y)}" width="${num(e.w)}" height="${num(e.h)}" rx="4" fill="${c(e.fill)}" stroke="#00000022"/>${textOf(e, m.x, m.y)}`;
      case "ellipse": return `<ellipse cx="${num(m.x)}" cy="${num(m.y)}" rx="${num(e.w / 2)}" ry="${num(e.h / 2)}" ${st}/>${textOf(e, m.x, m.y)}`;
      case "diamond": return `<path d="M${num(m.x)} ${num(e.y)}L${num(e.x + e.w)} ${num(m.y)}L${num(m.x)} ${num(e.y + e.h)}L${num(e.x)} ${num(m.y)}Z" ${st}/>${textOf(e, m.x, m.y)}`;
      case "text": return textOf(e, m.x, m.y, 18);
      case "pen": return `<path d="${(e.pts ?? []).map((p, i) => `${i ? "L" : "M"}${num(p[0] + e.x)} ${num(p[1] + e.y)}`).join("")}" fill="none" stroke="${c(e.stroke)}" stroke-width="${num(e.sw)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      default: {
        const { a, z } = resolveConnector(b, e);
        const head = e.kind === "arrow" ? arrowHead(a, z, 12 + e.sw * 2) : "";
        return `<path d="M${num(a.x)} ${num(a.y)}L${num(z.x)} ${num(z.y)}" stroke="${c(e.stroke)}" stroke-width="${num(e.sw)}" fill="none" stroke-linecap="round"/>${head ? `<path d="${head}" fill="${c(e.stroke)}"/>` : ""}${textOf(e, (a.x + z.x) / 2, (a.y + z.y) / 2 - 12, 14)}`;
      }
    }
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb.join(" ")}" width="${vb[2]}" height="${vb[3]}"><rect x="${vb[0]}" y="${vb[1]}" width="${vb[2]}" height="${vb[3]}" fill="#ffffff"/>${parts.join("")}</svg>`;
}

/** Triangle path for an arrow head at `z`, pointing along a→z. */
export function arrowHead(a: Pt, z: Pt, size = 14): string {
  const ang = Math.atan2(z.y - a.y, z.x - a.x), s = 0.45;
  const p1 = { x: z.x - size * Math.cos(ang - s), y: z.y - size * Math.sin(ang - s) };
  const p2 = { x: z.x - size * Math.cos(ang + s), y: z.y - size * Math.sin(ang + s) };
  return `M${num(z.x)} ${num(z.y)}L${num(p1.x)} ${num(p1.y)}L${num(p2.x)} ${num(p2.y)}Z`;
}

/** Strict loader for .fboard JSON: unknown kinds, bad numbers, bad colours or dangling bindings are refused or repaired. */
export function parseBoard(json: string): { board: Board; repaired: number } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error("not JSON"); }
  const r = raw as { format?: unknown; els?: unknown; seq?: unknown };
  if (!r || r.format !== BOARD_FORMAT || !Array.isArray(r.els)) throw new Error(`not a ${BOARD_FORMAT} document`);
  if (r.els.length > MAX_ELEMENTS) throw new Error(`a board holds at most ${MAX_ELEMENTS} elements`);
  let repaired = 0, maxSeq = 0;
  const fin = (v: unknown, lim = 1e6) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= lim ? v : NaN);
  const ids = new Set<string>();
  const els: El[] = r.els.map((x: unknown, i: number) => {
    const e = x as Record<string, unknown>;
    if (!e || typeof e !== "object" || !KINDS.includes(e.kind as Kind)) throw new Error(`element ${i}: unknown kind`);
    const nums = ["x", "y", "w", "h"].map((k) => fin(e[k]));
    if (nums.some(Number.isNaN)) throw new Error(`element ${i}: bad geometry`);
    const id = typeof e.id === "string" && /^e\d+$/.test(e.id) && !ids.has(e.id) ? e.id : (repaired++, `e${1e6 + i}`);
    ids.add(id); maxSeq = Math.max(maxSeq, +id.slice(1));
    const col = (v: unknown, d: string) => (typeof v === "string" && COLOR.test(v) ? v : (repaired++, d));
    const pts = Array.isArray(e.pts) ? (e.pts as unknown[]).slice(0, 20000).filter((p): p is [number, number] => Array.isArray(p) && !Number.isNaN(fin(p[0])) && !Number.isNaN(fin(p[1]))).map((p) => [p[0], p[1]] as [number, number]) : undefined;
    return canon({
      id, kind: e.kind as Kind, x: nums[0], y: nums[1], w: nums[2], h: nums[3],
      stroke: col(e.stroke ?? "#1b1b1f", "#1b1b1f"), fill: col(e.fill ?? "transparent", "transparent"),
      sw: Math.min(Math.max(Number.isNaN(fin(e.sw)) ? 2 : (e.sw as number), 0), 40),
      text: typeof e.text === "string" ? e.text.slice(0, 10000) : "",
      group: typeof e.group === "string" ? e.group : null,
      start: typeof e.start === "string" ? e.start : null, end: typeof e.end === "string" ? e.end : null, pts,
    });
  });
  // a binding must point at a shape on this board, else the end is detached where it was drawn
  const shapes = new Set(els.filter(isShape).map((e) => e.id));
  for (const e of els) {
    if (e.start && !shapes.has(e.start)) { e.start = null; repaired++; }
    if (e.end && !shapes.has(e.end)) { e.end = null; repaired++; }
    if (!isConnector(e) && (e.start || e.end)) { e.start = e.end = null; repaired++; }
  }
  const seq = Math.max(typeof r.seq === "number" && Number.isFinite(r.seq) ? r.seq : 1, maxSeq + 1);
  return { board: { format: BOARD_FORMAT, els, seq }, repaired };
}

export const serialize = (b: Board) => JSON.stringify(b);

/** Plain-language description of an element (used by the Layers list and screen readers). */
export function describe(b: Board, e: El): string {
  const name = { rect: "Rectangle", ellipse: "Ellipse", diamond: "Diamond", sticky: "Sticky note", text: "Text", line: "Line", arrow: "Arrow", pen: "Drawing" }[e.kind];
  const label = (id?: string | null) => { const t = byId(b, id); return t ? (t.text.split("\n")[0] || `${t.kind} ${t.id}`) : null; };
  if (isConnector(e)) {
    const s = label(e.start), t = label(e.end);
    return `${name}${s || t ? ` from ${s ?? "free point"} to ${t ?? "free point"}` : ""}${e.text ? `: ${e.text.split("\n")[0]}` : ""}`;
  }
  return `${name}${e.text ? `: ${e.text.split("\n")[0].slice(0, 40)}` : ""}`;
}
