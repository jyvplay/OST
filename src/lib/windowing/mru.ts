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

/** Drops ids that no longer exist and appends unknown ones (highest z first). */
export function syncMru(mru: readonly string[] | undefined, windows: readonly { id: string; z: number }[]): string[] {
  const live = new Set(windows.map((w) => w.id));
  const kept = (mru ?? []).filter((id, i, a) => live.has(id) && a.indexOf(id) === i);
  const known = new Set(kept);
  const extra = windows.filter((w) => !known.has(w.id)).sort((a, b) => b.z - a.z).map((w) => w.id);
  return [...kept, ...extra];
}
export function syncWsMru(ws: readonly number[] | undefined, workspaces: readonly { id: number }[], active: number): number[] {
  const live = new Set(workspaces.map((w) => w.id));
  const kept = (ws ?? []).filter((id, i, a) => live.has(id) && a.indexOf(id) === i);
  const extra = workspaces.map((w) => w.id).filter((id) => !kept.includes(id));
  const all = [...kept, ...extra];
  return live.has(active) && all[0] !== active ? touch(all, active) : all;
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
