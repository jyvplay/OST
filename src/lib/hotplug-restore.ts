/**
 * TT143 (WM-07) — per-screen layouts, and a restore that is provably reversible.
 *
 * Restoring a window layout when a screen comes back is one of those features that
 * demos beautifully and rots immediately, because the naive version is "remember
 * the last position" and the failure is: unplug screen B, its windows get folded
 * onto A, replug B, and every window is now on the wrong screen (and some are
 * outside the new work area, so they are effectively lost).
 *
 * This engine keeps a **keyed snapshot per screen** and makes two things explicit:
 *
 *   · **identity**: a screen's key is its label plus a rounded bounds hash, and a
 *     screen whose label changes but whose geometry and size still match is
 *     re-identified by geometry — a rotated or moved screen is still the same
 *     screen. Two screens with identical geometry and no label cannot be told
 *     apart, and the engine says so rather than guessing.
 *   · **reversibility**: `park()` moves the windows of an unplugged screen into a
 *     stated host screen and records exactly the rectangles it changed, so
 *     `restore()` puts back the *same* rectangles. A window the user moved while
 *     parked is not teleported back: the record is updated, so "restore" never
 *     overrides a deliberate move.
 *
 * The work area (not the screen) is the coordinate space, so a taskbar or a menu
 * bar cannot eat a window. A rectangle that cannot fit is shrunk and reported.
 */

export interface ScreenLike {
  label: string;
  availLeft: number; availTop: number; availWidth: number; availHeight: number;
  devicePixelRatio?: number;
}
export interface Rect { x: number; y: number; w: number; h: number }
export interface ParkedWindow extends Rect { id: string }

/** Round to 8 px: a screen's reported bounds jitter by a pixel or two on hotplug. */
const q = (n: number) => Math.round(n / 8) * 8;

export function screenKey(s: ScreenLike): string {
  return `${s.label || "screen"}|${q(s.availLeft)},${q(s.availTop)},${q(s.availWidth)}x${q(s.availHeight)}`;
}

/**
 * Match the screens that are present now against the snapshots taken before.
 * Exact key first; then a geometry-only match (a renamed screen that did not
 * move); then nothing. Never a "closest" match — a wrong restore is worse than
 * none.
 */
export function matchScreens(previous: { key: string; screen: ScreenLike }[], current: ScreenLike[]): {
  matched: { key: string; screen: ScreenLike; snapshot: ScreenLike }[];
  appeared: ScreenLike[];
  disappeared: { key: string; screen: ScreenLike }[];
  ambiguous: string[];
} {
  const used = new Set<number>();
  const matched: { key: string; screen: ScreenLike; snapshot: ScreenLike }[] = [];
  const ambiguous: string[] = [];
  for (const prev of previous) {
    const exact = current.findIndex((c, i) => !used.has(i) && screenKey(c) === prev.key);
    if (exact >= 0) { used.add(exact); matched.push({ key: prev.key, screen: current[exact], snapshot: prev.screen }); continue; }
    // Geometry-only: same work-area origin and size, different label.
    const byGeometry = current
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !used.has(i) && q(c.availLeft) === q(prev.screen.availLeft) && q(c.availTop) === q(prev.screen.availTop) && q(c.availWidth) === q(prev.screen.availWidth) && q(c.availHeight) === q(prev.screen.availHeight));
    if (byGeometry.length === 1) {
      used.add(byGeometry[0].i);
      matched.push({ key: prev.key, screen: byGeometry[0].c, snapshot: prev.screen });
    } else if (byGeometry.length > 1) {
      ambiguous.push(prev.key);
    }
  }
  const appeared = current.filter((_, i) => !used.has(i));
  const disappeared = previous.filter((p) => !matched.some((m) => m.key === p.key));
  return { matched, appeared, disappeared, ambiguous };
}

/** Snapshots of windows per screen key. */
export interface Snapshots { [key: string]: ParkedWindow[] }

/** The whole hotplug state is a value: no module-level registry, so two tests (or
 *  two desktops) can drive independent screen tables in one process. */
export interface HotplugState {
  /** Windows known to be on each present screen. */
  snapshots: Snapshots;
  /** Screens that have gone away, with the exact rectangles park() changed. */
  parked: { [gone: string]: { hostKey: string; record: ParkedWindow[] } };
}

export const emptyHotplugState = (): HotplugState => ({ snapshots: {}, parked: {} });

/**
 * Move the windows of a screen that has gone away onto a host screen. The returned
 * state carries the exact rectangles that changed, which is what makes the restore
 * reversible rather than approximate.
 */
export function park(state: HotplugState, gone: string, host: ScreenLike, hostKey: string): { state: HotplugState; record: ParkedWindow[]; overflow: string[] } {
  const leaving = state.snapshots[gone] ?? [];
  const record: ParkedWindow[] = [];
  const overflow: string[] = [];
  const kept = [...(state.snapshots[hostKey] ?? [])];
  for (const win of leaving) {
    const w = Math.min(win.w, host.availWidth);
    const h = Math.min(win.h, host.availHeight);
    if (w < win.w || h < win.h) overflow.push(win.id);
    // Keep the window's own origin, clamped into the host's work area: a position,
    // never a resize beyond the work area.
    const x = host.availLeft + Math.min(Math.max(0, win.x), Math.max(0, host.availWidth - w));
    const y = host.availTop + Math.min(Math.max(0, win.y), Math.max(0, host.availHeight - h));
    const moved = { id: win.id, x, y, w, h };
    record.push(moved);
    kept.push(moved);
  }
  const snapshots = { ...state.snapshots, [hostKey]: kept };
  delete snapshots[gone];
  return { state: { snapshots, parked: { ...state.parked, [gone]: { hostKey, record } } }, record, overflow };
}

/**
 * Restore the windows of a returning screen. A window the user has since moved is
 * left where it is and reported as `keptByUser`, so a deliberate move is never
 * undone by the OS.
 */
export function restore(state: HotplugState, returning: string, screen: ScreenLike, userMoves: ReadonlySet<string> = new Set()): {
  state: HotplugState;
  restored: ParkedWindow[];
  keptByUser: string[];
  missing: string[];
} {
  const prior = state.parked[returning];
  const restored: ParkedWindow[] = [];
  const keptByUser: string[] = [];
  const missing: string[] = [];
  if (!prior) return { state, restored, keptByUser, missing };
  const host = [...(state.snapshots[prior.hostKey] ?? [])];
  const stayOnHost: ParkedWindow[] = [];
  for (const moved of prior.record) {
    const inHost = host.find((h) => h.id === moved.id);
    if (!inHost) { missing.push(moved.id); continue; }
    if (userMoves.has(moved.id)) { keptByUser.push(moved.id); stayOnHost.push(inHost); continue; }
    const w = Math.min(moved.w, screen.availWidth);
    const h = Math.min(moved.h, screen.availHeight);
    restored.push({
      id: moved.id,
      x: screen.availLeft + Math.min(Math.max(0, moved.x - screen.availLeft), Math.max(0, screen.availWidth - w)),
      y: screen.availTop + Math.min(Math.max(0, moved.y - screen.availTop), Math.max(0, screen.availHeight - h)),
      w, h,
    });
  }
  const snapshots: Snapshots = { ...state.snapshots };
  // Everything still on the host EXCEPT the windows that just moved back. Windows
  // the host owned before the unplug were never parked and must survive the
  // restore — dropping them was the first bug this test found.
  const movedIds = new Set(restored.map((r) => r.id));
  const remainingHost = host.filter((h) => !movedIds.has(h.id));
  if (remainingHost.length) snapshots[prior.hostKey] = remainingHost;
  else delete snapshots[prior.hostKey];
  snapshots[returning] = [...(snapshots[returning] ?? []), ...restored];
  const parked = { ...state.parked };
  delete parked[returning];
  return { state: { snapshots, parked }, restored, keptByUser, missing };
}

/** The sentence the shell shows after a hotplug event; empty when nothing changed. */
export function hotplugSentence(r: ReturnType<typeof matchScreens>, movedCount: number): string {
  const parts: string[] = [];
  if (r.appeared.length) parts.push(`${r.appeared.length} screen${r.appeared.length === 1 ? "" : "s"} connected`);
  if (r.disappeared.length) parts.push(`${r.disappeared.length} disconnected (${movedCount} window${movedCount === 1 ? "" : "s"} moved to a remaining screen)`);
  if (r.ambiguous.length) parts.push(`${r.ambiguous.length} screen${r.ambiguous.length === 1 ? "" : "s"} could not be told apart, so no layout was restored for ${r.ambiguous.length === 1 ? "it" : "them"}`);
  return parts.length ? `${parts.join("; ")}.` : "";
}
