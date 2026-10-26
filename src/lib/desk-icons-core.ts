/**
 * TT26 — rearrangeable desktop icons. Pure (no React, no DOM) so scripts/tabletop-unit.mts can check it.
 *
 * Positions are stored as *grid cells* (x = column, y = row) in DesktopState.icons, not pixels: they survive text-size
 * changes (125 % ↔ 200 %) and window resizes, and every icon always sits on the grid (Finder/Explorer "snap to grid").
 * Icons stay VFS paths (SH-04): a saved position for a path that no longer exists is simply dropped.
 */
export interface IconPos { id: string; path: string; x: number; y: number }
export interface Placed { path: string; col: number; row: number }

const cellKey = (c: number, r: number) => `${c}:${r}`;
const okInt = (v: unknown, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < max;

/**
 * Lay `paths` out on a cols×rows grid. Saved positions win (first saved entry wins a contested cell, out-of-grid
 * entries are ignored); the rest fill the first free cells column-major (top-to-bottom, then the next column), the
 * way desktop icons auto-arrange. Paths beyond cols×rows are not placed (the caller shows "+N more").
 */
export function layoutIcons(paths: readonly string[], saved: readonly IconPos[] | undefined, cols: number, rows: number): Placed[] {
  const C = Math.max(1, Math.floor(cols)), R = Math.max(1, Math.floor(rows));
  const want = new Set(paths);
  const taken = new Set<string>();
  const at = new Map<string, Placed>();
  for (const s of Array.isArray(saved) ? saved : []) {
    if (!s || typeof s.path !== "string" || !want.has(s.path) || at.has(s.path)) continue;
    if (!okInt(s.x, C) || !okInt(s.y, R) || taken.has(cellKey(s.x, s.y))) continue;
    taken.add(cellKey(s.x, s.y));
    at.set(s.path, { path: s.path, col: s.x, row: s.y });
  }
  let cursor = 0;
  for (const p of paths) {
    if (at.has(p)) continue;
    while (cursor < C * R && taken.has(cellKey(Math.floor(cursor / R), cursor % R))) cursor++;
    if (cursor >= C * R) break;
    const col = Math.floor(cursor / R), row = cursor % R;
    taken.add(cellKey(col, row));
    at.set(p, { path: p, col, row });
  }
  return paths.filter((p) => at.has(p)).map((p) => at.get(p)!);
}

const toSaved = (placed: readonly Placed[]): IconPos[] => placed.map((p) => ({ id: p.path, path: p.path, x: p.col, y: p.row }));

/** Move `path` to (col,row), clamped into the grid. If another icon is there the two swap places. */
export function moveIcon(placed: readonly Placed[], path: string, col: number, row: number, cols: number, rows: number): IconPos[] {
  const C = Math.max(1, Math.floor(cols)), R = Math.max(1, Math.floor(rows));
  const me = placed.find((p) => p.path === path);
  if (!me) return toSaved(placed);
  const c = Math.max(0, Math.min(C - 1, Math.round(Number.isFinite(col) ? col : me.col)));
  const r = Math.max(0, Math.min(R - 1, Math.round(Number.isFinite(row) ? row : me.row)));
  return toSaved(placed.map((p) => {
    if (p.path === path) return { ...p, col: c, row: r };
    if (p.col === c && p.row === r) return { ...p, col: me.col, row: me.row };
    return p;
  }));
}

/** Keyboard move (Alt+Arrow): one cell in a direction, same swap rule. */
export const nudgeIcon = (placed: readonly Placed[], path: string, dc: number, dr: number, cols: number, rows: number): IconPos[] => {
  const me = placed.find((p) => p.path === path);
  return me ? moveIcon(placed, path, me.col + dc, me.row + dr, cols, rows) : toSaved(placed);
};

/** "Clean up": keep the current reading order (column-major) but close every gap. */
export function cleanUp(placed: readonly Placed[], cols: number, rows: number): IconPos[] {
  const order = [...placed].sort((a, b) => a.col - b.col || a.row - b.row).map((p) => p.path);
  return toSaved(layoutIcons(order, [], cols, rows));
}

/** "Sort by name": natural, case-insensitive order (file2 before file10), column-major. */
export function sortByName(placed: readonly Placed[], names: Record<string, string>, cols: number, rows: number): IconPos[] {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const order = [...placed].map((p) => p.path).sort((a, b) => coll.compare(names[a] ?? a, names[b] ?? b));
  return toSaved(layoutIcons(order, [], cols, rows));
}

/** Pixel point (an icon's centre, relative to the icon area) → the grid cell containing it. */
export const cellAt = (x: number, y: number, cellW: number, cellH: number) =>
  ({ col: Math.max(0, Math.floor(x / cellW)), row: Math.max(0, Math.floor(y / cellH)) });
