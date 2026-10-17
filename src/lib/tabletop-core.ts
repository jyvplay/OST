/**
 * TT26 — "Tabletop": a 3D desktop seen as the inside of a box (floor + 4 walls). This file is the pure part: the
 * saved floor state (loose cards + piles), pile operations, deterministic pile jitter, fan-out geometry, hit testing,
 * the box geometry/camera maths and the wall catalogue. No React, no DOM — scripts/tabletop-unit.mts checks it.
 *
 * Cards are golden rectangles (w : h = 1 : φ). That is a *soft* aesthetic choice, not a law: the evidence for φ
 * specifically is mixed (see docs/DESIGN-TABLETOP-TT26.md); it sits inside the 3:5…5:8 band that Fechner's and later
 * rectangle-preference studies found most chosen, and it gives the micro peek a page-like proportion.
 */
export const PHI = (1 + Math.sqrt(5)) / 2;
export const CARD_W = 112;
export const CARD_H = Math.round(CARD_W * PHI); // 181
export const CARD_GAP = 24;
export const MAX_PILE = 64;

export interface CardPos { x: number; y: number }
export interface Pile { id: string; name: string; paths: string[]; x: number; y: number }
export interface TableState { v: 1; cards: Record<string, CardPos>; piles: Pile[] }
export const emptyTable = (): TableState => ({ v: 1, cards: {}, piles: [] });

export const WALLS = ["north", "east", "south", "west"] as const;
export type Wall = (typeof WALLS)[number];
export type Face = Wall | "floor";
export const WALL_INFO: Record<Wall, { title: string; blurb: string }> = {
  north: { title: "Windows", blurb: "Every open window on this workspace" },
  east: { title: "Widgets", blurb: "Clock, calendar and system status" },
  south: { title: "Recent", blurb: "Recently changed files" },
  west: { title: "Apps", blurb: "Every app, by group" },
};
export const isFace = (v: unknown): v is Face => v === "floor" || (WALLS as readonly string[]).includes(v as string);

const fin = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const clampPos = (v: unknown) => Math.max(-4000, Math.min(20000, Math.round(fin(v))));

/** FNV-1a 32-bit (the repo's standard non-crypto hash). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/**
 * Validate an untrusted saved table against the files that actually exist (VFS is the truth, as SH-04 for icons):
 * unknown paths are dropped, a path belongs to at most one pile (first wins) and is then not also a loose card,
 * piles left with fewer than 2 cards dissolve (the survivor becomes a loose card at the pile's spot), numbers are
 * clamped, names trimmed. Total: any input → a valid TableState.
 */
export function normalizeTable(raw: unknown, existing: readonly string[]): TableState {
  const out = emptyTable();
  if (!raw || typeof raw !== "object") return out;
  const t = raw as Partial<TableState>;
  const have = new Set(existing);
  const used = new Set<string>();
  const ids = new Set<string>();
  for (const p of Array.isArray(t.piles) ? t.piles : []) {
    if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.id || ids.has(p.id)) continue;
    const paths = (Array.isArray(p.paths) ? p.paths : []).filter((x): x is string => typeof x === "string" && have.has(x) && !used.has(x)).slice(0, MAX_PILE);
    const x = clampPos(p.x), y = clampPos(p.y);
    if (paths.length >= 2) {
      paths.forEach((q) => used.add(q));
      ids.add(p.id);
      out.piles.push({ id: p.id.slice(0, 40), name: (typeof p.name === "string" && p.name.trim() ? p.name.trim() : "Pile").slice(0, 60), paths, x, y });
    } else if (paths.length === 1) {
      used.add(paths[0]);
      out.cards[paths[0]] = { x, y };
    }
  }
  const cards = t.cards && typeof t.cards === "object" ? t.cards : {};
  for (const [k, v] of Object.entries(cards)) {
    if (!have.has(k) || out.piles.some((p) => p.paths.includes(k)) || out.cards[k]) continue;
    if (v && typeof v === "object") out.cards[k] = { x: clampPos((v as CardPos).x), y: clampPos((v as CardPos).y) };
  }
  return out;
}

export type FloorItem = { kind: "card"; key: string; path: string; x: number; y: number } | { kind: "pile"; key: string; pile: Pile; x: number; y: number };

/**
 * Everything on the floor with a position: piles at their spot, loose cards at their saved spot, unsaved cards on a
 * grid of free CARD_W×CARD_H slots (row-major, reading order), skipping slots already covered by something.
 */
export function floorItems(table: TableState, paths: readonly string[], areaW: number): FloorItem[] {
  const out: FloorItem[] = table.piles.map((p) => ({ kind: "pile", key: `pile:${p.id}`, pile: p, x: p.x, y: p.y }));
  const inPile = new Set(table.piles.flatMap((p) => p.paths));
  const loose = paths.filter((p) => !inPile.has(p));
  for (const p of loose) if (table.cards[p]) out.push({ kind: "card", key: `card:${p}`, path: p, x: table.cards[p].x, y: table.cards[p].y });
  const sw = CARD_W + CARD_GAP, sh = CARD_H + CARD_GAP;
  const cols = Math.max(1, Math.floor((Math.max(sw, fin(areaW, 800)) - CARD_GAP) / sw));
  let slot = 0;
  const covered = (x: number, y: number) => out.some((o) => Math.abs(o.x - x) < CARD_W * 0.6 && Math.abs(o.y - y) < CARD_H * 0.6);
  for (const p of loose) {
    if (table.cards[p]) continue;
    let x = 0, y = 0;
    for (let guard = 0; guard < 2000; guard++, slot++) {
      x = CARD_GAP + (slot % cols) * sw; y = CARD_GAP + Math.floor(slot / cols) * sh;
      if (!covered(x, y)) break;
    }
    slot++;
    out.push({ kind: "card", key: `card:${p}`, path: p, x, y });
  }
  return out;
}

/** The item whose card rectangle contains (x, y) (topmost = last), excluding `exceptKey`. */
export function hitItem(items: readonly FloorItem[], x: number, y: number, exceptKey?: string): FloorItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.key === exceptKey) continue;
    if (x >= it.x && x <= it.x + CARD_W && y >= it.y && y <= it.y + CARD_H) return it;
  }
  return null;
}

const pathsOf = (table: TableState, key: string): string[] =>
  key.startsWith("pile:") ? table.piles.find((p) => `pile:${p.id}` === key)?.paths ?? [] : key.startsWith("card:") ? [key.slice(5)] : [];

/**
 * Drop `dragKey` (a card or a pile) onto `targetKey`: the result is one pile at the target's position with the
 * target's cards underneath and the dragged cards on top (as when you drop a sheet on a stack of paper).
 * Dropping onto itself, or anything unknown (pass `existing` to check card paths against the VFS), is a no-op. Pile ids are deterministic (FNV-1a of the member paths).
 */
export function pileUp(table: TableState, dragKey: string, targetKey: string, pos: CardPos, existing?: readonly string[]): TableState {
  if (dragKey === targetKey) return table;
  const known = existing ? new Set(existing) : null;
  const keep = (ps: string[]) => (known ? ps.filter((p) => known.has(p)) : ps);
  const dragged = keep(pathsOf(table, dragKey)), under = keep(pathsOf(table, targetKey));
  if (!dragged.length || !under.length) return table;
  const target = targetKey.startsWith("pile:") ? table.piles.find((p) => `pile:${p.id}` === targetKey) : undefined;
  const paths = [...under, ...dragged.filter((p) => !under.includes(p))].slice(0, MAX_PILE);
  const piles = table.piles.filter((p) => `pile:${p.id}` !== dragKey && `pile:${p.id}` !== targetKey);
  const id = target?.id ?? `p${fnv1a(paths.join("\n")).toString(36)}`;
  const name = target?.name ?? `Pile ${table.piles.length + 1}`;
  const cards = { ...table.cards };
  for (const p of paths) delete cards[p];
  return { v: 1, cards, piles: [...piles, { id, name, paths, x: Math.round(pos.x), y: Math.round(pos.y) }] };
}

/** Take one card out of a pile and put it at `pos`; a pile left with one card dissolves into a loose card. */
export function takeFromPile(table: TableState, pileId: string, path: string, pos: CardPos): TableState {
  const pile = table.piles.find((p) => p.id === pileId);
  if (!pile || !pile.paths.includes(path)) return table;
  const rest = pile.paths.filter((p) => p !== path);
  const cards = { ...table.cards, [path]: { x: Math.round(pos.x), y: Math.round(pos.y) } };
  let piles = table.piles.filter((p) => p.id !== pileId);
  if (rest.length >= 2) piles = [...piles, { ...pile, paths: rest }];
  else if (rest.length === 1) cards[rest[0]] = { x: pile.x, y: pile.y };
  return { v: 1, cards, piles };
}

/** Spread a pile back out into loose cards on a small grid starting at the pile's spot. */
export function unstack(table: TableState, pileId: string): TableState {
  const pile = table.piles.find((p) => p.id === pileId);
  if (!pile) return table;
  const cards = { ...table.cards };
  const cols = Math.ceil(Math.sqrt(pile.paths.length));
  pile.paths.forEach((p, i) => { cards[p] = { x: pile.x + (i % cols) * (CARD_W + CARD_GAP), y: pile.y + Math.floor(i / cols) * (CARD_H + CARD_GAP) }; });
  return { v: 1, cards, piles: table.piles.filter((p) => p.id !== pileId) };
}

export const moveItem = (table: TableState, key: string, pos: CardPos): TableState => {
  const x = Math.round(pos.x), y = Math.round(pos.y);
  if (key.startsWith("pile:")) return { ...table, piles: table.piles.map((p) => (`pile:${p.id}` === key ? { ...p, x, y } : p)) };
  if (key.startsWith("card:")) return { ...table, cards: { ...table.cards, [key.slice(5)]: { x, y } } };
  return table;
};

export const renamePile = (table: TableState, pileId: string, name: string): TableState =>
  ({ ...table, piles: table.piles.map((p) => (p.id === pileId ? { ...p, name: name.trim().slice(0, 60) || p.name } : p)) });

/**
 * Deterministic "messy stack" offset for the i-th card of a pile: rotation within ±6°, offset within ±5 px, the top
 * card (i = n−1) straight so its micro peek reads cleanly. Same pile → same look on every render and every device.
 */
export function pileJitter(pileId: string, path: string, i: number, n: number): { dx: number; dy: number; rot: number } {
  if (i === n - 1) return { dx: 0, dy: 0, rot: 0 };
  const h = fnv1a(`${pileId}\n${path}`);
  const u = (k: number) => ((h >>> (k * 8)) & 0xff) / 255;
  return { dx: Math.round((u(0) - 0.5) * 10), dy: Math.round((u(1) - 0.5) * 10), rot: Math.round((u(2) - 0.5) * 120) / 10 };
}

/**
 * Fan-out geometry: n cards spread on an arc above/around the pile (like fanning a hand of cards), falling back to
 * a centred grid when the arc would be wider than the floor. Positions are top-left corners in floor px, clamped
 * inside [0, areaW−CARD_W] × [0, areaH−CARD_H].
 */
export function fanLayout(n: number, pile: CardPos, areaW: number, areaH: number): { x: number; y: number; rot: number }[] {
  const W = Math.max(CARD_W, fin(areaW, 800)), H = Math.max(CARD_H, fin(areaH, 600));
  const clampX = (x: number) => Math.max(0, Math.min(W - CARD_W, Math.round(x)));
  const clampY = (y: number) => Math.max(0, Math.min(H - CARD_H, Math.round(y)));
  if (n <= 0) return [];
  const step = CARD_W * 0.72;
  const arcW = (n - 1) * step + CARD_W;
  if (n <= 9 && arcW <= W - 2 * CARD_GAP) {
    const cx = Math.max(arcW / 2, Math.min(W - arcW / 2, pile.x + CARD_W / 2));
    return Array.from({ length: n }, (_, i) => {
      const t = n === 1 ? 0 : i / (n - 1) - 0.5; // −½…½
      return { x: clampX(cx - arcW / 2 + i * step), y: clampY(pile.y - CARD_H * 0.35 + Math.abs(t) * 2 * 28), rot: Math.round(t * 2 * 12 * 10) / 10 };
    });
  }
  const cols = Math.max(1, Math.min(Math.floor((W - CARD_GAP) / (CARD_W + CARD_GAP)), Math.ceil(Math.sqrt(n * PHI))));
  const gw = cols * (CARD_W + CARD_GAP) - CARD_GAP;
  const x0 = Math.max(0, Math.min(W - gw, pile.x + CARD_W / 2 - gw / 2));
  return Array.from({ length: n }, (_, i) => ({ x: clampX(x0 + (i % cols) * (CARD_W + CARD_GAP)), y: clampY(pile.y + Math.floor(i / cols) * (CARD_H + CARD_GAP) - CARD_H * 0.35), rot: 0 }));
}

/**
 * Box geometry for a desk of w×h px. The camera looks straight down into an open box whose rim is the screen edge:
 * walls run from the rim (z = 0) to the floor (z = −depth). With CSS perspective p the floor projects at scale
 * s = p / (p + depth) — `floorScale` — which the floor content counter-scales so text on it renders at true size.
 */
export function boxGeometry(w: number, h: number): { depth: number; perspective: number; floorScale: number } {
  const W = Math.max(320, fin(w, 1440)), H = Math.max(240, fin(h, 900));
  const depth = Math.round(Math.min(W, H) * 0.5);
  const perspective = Math.round(Math.max(W, H) * 0.85);
  return { depth, perspective, floorScale: perspective / (perspective + depth) };
}

/**
 * CSS transform of a face in "box" pose (transform-origin noted per face): the floor is pushed back by depth; each
 * wall is hinged on its screen edge and folded 90° into the box. In "main" pose a face is flat, full-desk, z = 0.
 * Rotation signs follow CSS (y down): north wall top-hinged rotateX(−90°) sends its lower edge to z = −depth, etc.
 */
export function faceTransform(face: Face, depth: number): { transform: string; origin: string } {
  switch (face) {
    case "floor": return { transform: `translateZ(${-depth}px)`, origin: "50% 50%" };
    case "north": return { transform: "rotateX(-90deg)", origin: "50% 0%" };
    case "south": return { transform: "rotateX(90deg)", origin: "50% 100%" };
    case "west": return { transform: "rotateY(90deg)", origin: "0% 50%" };
    case "east": return { transform: "rotateY(-90deg)", origin: "100% 50%" };
  }
}

/** Faces that are *not* the main view move away as the chosen wall unfolds: they swing further back and fade. */
export function awayTransform(face: Face, depth: number): string {
  switch (face) {
    case "floor": return `translateZ(${-depth * 2.2}px) rotateX(25deg)`;
    case "north": return "rotateX(-120deg)";
    case "south": return "rotateX(120deg)";
    case "west": return "rotateY(120deg)";
    case "east": return "rotateY(-120deg)";
  }
}
