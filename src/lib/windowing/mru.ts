/**
 * TT56 (WM-05) — most-recently-used order for the switcher, pure and DOM-free (unit-tested in Node).
 *
 * Model: `mru` lists window ids newest-first; `wsMru` lists workspace ids newest-first. A window moves to the front when it
 * GAINS focus (focus/open/restore/tile/place, or a commit from the switcher); closing removes it; windows the list does not
 * know yet (hydrated from an older saved state) are appended in z-order, so the list always covers exactly the live windows.
 *
 * The switcher is "lock while held" (Alt+Tab semantics): pressing the chord opens the overlay with the PREVIOUS item
 * preselected, further presses advance (Shift reverses), releasing the modifier commits, Escape cancels — nothing is
 * focused (so the MRU order does not change) until the commit.
 */
export type SwitchMode = "window" | "app" | "workspace";
export const SWITCH_MODES: SwitchMode[] = ["window", "app", "workspace"];

export interface MruWindow { id: string; z: number; module: string; title: string; workspace: number; minimized: boolean }
export interface MruState { windows: MruWindow[]; workspaces: { id: number; name: string }[]; activeWorkspace: number; mru?: string[]; wsMru?: number[] }
export interface SwitchItem { key: string; label: string; sub: string; winId?: string; workspace?: number; module?: string }

/** `id` to the front, without duplicates. */
export function touch<T>(list: readonly T[], id: T): T[] { return [id, ...list.filter((x) => x !== id)]; }

/**
 * Drops ids that no longer exist and appends unknown ones (highest z first).
 *
 * TT143 performance repair. The previous version de-duplicated with
 * `a.indexOf(id) === i` inside a filter: O(n²) on every reducer command, and by
 * the profile it was 36 % of the `unit` suite's samples (the reducer runs it on
 * every state change, and the suite drives ~10⁵ commands). A `Set` makes it O(n)
 * with the identical first-occurrence result. `syncWsMru` had the same shape plus
 * `kept.includes` per workspace; both are now linear, and the semantics are
 * unchanged: first occurrence wins, unknown ids (or workspaces) are appended.
 */
export function syncMru(mru: readonly string[] | undefined, windows: readonly { id: string; z: number }[]): string[] {
  const live = new Set(windows.map((w) => w.id));
  const kept: string[] = [];
  const seen = new Set<string>();
  let discarded = false;
  for (const id of mru ?? []) {
    if (!live.has(id) || seen.has(id)) { discarded = true; continue; }
    seen.add(id);
    kept.push(id);
  }
  // TT143: the produced array IS the input when nothing was dropped, nothing was
  // de-duplicated and every live window is already present. Returning that same
  // array keeps `withMru` allocation-free for the common case (a reducer command
  // that does not change focus), which is where this function's 19 % of samples
  // went: it was rebuilding n strings per command and the state spread copied them
  // again. Callers never mutate the result, so sharing it is safe.
  if (!discarded && kept.length === windows.length) return (mru as string[]) ?? kept;
  const extra: { id: string; z: number }[] = [];
  for (const w of windows) if (!seen.has(w.id)) extra.push(w);
  if (extra.length > 1) extra.sort((a, b) => b.z - a.z);
  for (const w of extra) kept.push(w.id);
  return kept;
}
export function syncWsMru(ws: readonly number[] | undefined, workspaces: readonly { id: number }[], active: number): number[] {
  const live = new Set(workspaces.map((w) => w.id));
  const kept: number[] = [];
  const seen = new Set<number>();
  for (const id of ws ?? []) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    kept.push(id);
  }
  for (const w of workspaces) if (!seen.has(w.id)) kept.push(w.id);
  // The active workspace leads, unless the order already says so (same as before).
  if (live.has(active) && kept[0] !== active) return touch(kept, active);
  return kept;
}

/** Items of one switcher mode, newest first. */
export function switchItems(s: MruState, mode: SwitchMode, appName: (module: string) => string = (m) => m): SwitchItem[] {
  const order = syncMru(s.mru, s.windows);
  const byId = new Map(s.windows.map((w) => [w.id, w]));
  const here = order.map((id) => byId.get(id)!).filter((w) => w.workspace === s.activeWorkspace);
  if (mode === "window") return here.map((w) => ({ key: `w:${w.id}`, label: w.title || appName(w.module), sub: `${appName(w.module)}${w.minimized ? " · minimised" : ""}`, winId: w.id, module: w.module }));
  if (mode === "app") {
    const seen = new Map<string, SwitchItem & { n: number }>();
    for (const w of here) {
      const it = seen.get(w.module);
      if (it) { it.n++; it.sub = `${it.n} windows`; } else seen.set(w.module, { key: `a:${w.module}`, label: appName(w.module), sub: "1 window", winId: w.id, module: w.module, n: 1 });
    }
    return [...seen.values()].map(({ n: _n, ...it }) => { void _n; return it; });
  }
  const ws = syncWsMru(s.wsMru, s.workspaces, s.activeWorkspace);
  return ws.map((id) => {
    const n = s.windows.filter((w) => w.workspace === id).length;
    return { key: `s:${id}`, label: s.workspaces.find((w) => w.id === id)?.name ?? `Workspace ${id}`, sub: `${n} window${n === 1 ? "" : "s"}`, workspace: id };
  });
}
/** The preselected entry when the overlay opens: the previous item (so one press + release toggles between the two most recent). */
export const initialIndex = (n: number, dir: 1 | -1 = 1) => (n <= 1 ? 0 : dir === 1 ? 1 : n - 1);
export const stepIndex = (i: number, n: number, dir: 1 | -1) => (n === 0 ? 0 : (i + dir + n) % n);
