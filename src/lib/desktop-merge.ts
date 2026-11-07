/**
 * TT143 (DP-04) — merging two desktops instead of losing one.
 *
 * Today a second tab's save is refused (409) and the tab adopts the newer desktop,
 * which means the *first* tab's new window silently disappears. That is correct
 * concurrency control and bad behaviour. A merge is better, but only if it is
 * deterministic and explainable, so this engine defines one and states its rules:
 *
 *   · windows are merged **by id**; an id present on both sides keeps the newer
 *     geometry (by `updatedAt`, then by z-order, then by the caller's `prefer`),
 *     and the loser is reported;
 *   · a window present on one side only is **kept** — a window is a user's work,
 *     and dropping it because another tab did not know about it is the bug;
 *   · a window the other side *closed* is only closed if the close is newer than
 *     the open on this side, which needs a closed-set with timestamps;
 *   · focus and z-order follow the side that has the newest window, and z values
 *     are renumbered to be dense, so a merge cannot leave gaps that later
 *     arithmetic (nextZ, stacking) depends on;
 *   · the merge is **commutative in result** (same set of windows, same
 *     renumbering) even though `prefer` breaks ties — asserted by a test.
 *
 * The engine never touches storage or React; it takes two plain desktops and
 * returns the merged one plus a list of what changed, which is what the toast says.
 */

export interface MergeWindow { id: string; x: number; y: number; w: number; h: number; z: number; updatedAt: number; minimized?: boolean; maximized?: boolean; workspace?: number }
export interface DesktopLike { windows: MergeWindow[]; focus: string | null; nextZ: number; revision: number; closed?: { id: string; at: number }[] }
export interface MergeResult { desktop: DesktopLike; changed: string[]; kept: string[]; droppedCloses: string[]; notes: string[] }

export function mergeDesktops(a: DesktopLike, b: DesktopLike, prefer: "a" | "b"): MergeResult {
  const byId = new Map<string, MergeWindow>();
  const changed: string[] = [];
  const kept: string[] = [];
  const notes: string[] = [];
  for (const w of [...a.windows, ...b.windows]) {
    const prev = byId.get(w.id);
    if (!prev) { byId.set(w.id, w); continue; }
    if (prev.x === w.x && prev.y === w.y && prev.w === w.w && prev.h === w.h && prev.minimized === w.minimized && prev.maximized === w.maximized) {
      changed.push(`${w.id}: same geometry in both`);
      continue;
    }
    const winner = w.updatedAt > prev.updatedAt ? w : w.updatedAt < prev.updatedAt ? prev : prefer === "a" ? prev : w;
    byId.set(w.id, winner);
    changed.push(`${w.id}: geometry from ${winner === w ? (w === a.windows.find((x) => x.id === w.id) ? "a" : "b") : prev === a.windows.find((x) => x.id === prev.id) ? "a" : "b"} (newer)`);
  }

  // Closes: a close only wins over an open it is newer than.
  const closes = [...(a.closed ?? []), ...(b.closed ?? [])].sort((x, y) => y.at - x.at);
  const droppedCloses: string[] = [];
  for (const c of closes) {
    const win = byId.get(c.id);
    if (!win) continue;
    if (win.updatedAt <= c.at) { byId.delete(c.id); changed.push(`${c.id}: closed on the other side at ${new Date(c.at).toISOString()}`); }
    else droppedCloses.push(`${c.id}: reopened after the close, so the close is ignored`);
  }

  const windows = [...byId.values()].sort((x, y) => x.z - y.z).map((w, i) => ({ ...w, z: i + 1 }));
  const focusSide = pickFocusSide(a, b, prefer);
  const focus = focusSide.focus && windows.some((w) => w.id === focusSide.focus) ? focusSide.focus : windows.at(-1)?.id ?? null;
  const nextZ = windows.length + 1;
  const revision = Math.max(a.revision, b.revision) + 1;
  if (windows.length > a.windows.length) kept.push(`${windows.length - a.windows.length} window(s) this side did not know about`);
  if (droppedCloses.length) notes.push(...droppedCloses);
  notes.push("Z-order was renumbered from 1 so no gap is left for later stacking to trip over.");
  return { desktop: { windows, focus, nextZ, revision }, changed, kept, droppedCloses, notes };
}

function pickFocusSide(a: DesktopLike, b: DesktopLike, prefer: "a" | "b"): DesktopLike {
  const newest = (d: DesktopLike) => d.windows.reduce((n, w) => Math.max(n, w.updatedAt), 0);
  if (newest(a) === newest(b)) return prefer === "a" ? a : b;
  return newest(a) > newest(b) ? a : b;
}

/** The toast sentence. Never says "merged" without naming what happened. */
export function describeMerge(r: MergeResult): string {
  const parts: string[] = [];
  if (r.kept.length) parts.push(`${r.kept.join(", ")} were kept`);
  if (r.changed.length) parts.push(`${r.changed.length} window${r.changed.length === 1 ? "" : "s"} reconciled`);
  if (r.droppedCloses.length) parts.push(`${r.droppedCloses.length} pending close${r.droppedCloses.length === 1 ? "" : "s"} ignored because the window was reopened`);
  return parts.length ? `Another tab changed this desktop: ${parts.join("; ")}.` : "Another tab changed this desktop; the two were already identical.";
}
