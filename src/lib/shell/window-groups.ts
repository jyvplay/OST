/**
 * TT136 (WM-02) — window groups.
 *
 * Grouping is the last missing piece of WM: before this, a window could be
 * reordered, closed and minimised, but a group of windows (a Session or a
 * slideshow) behaved as N independent windows. A group is:
 *
 *   minimize  → minimises every member;
 *   close     → closes every member (with a confirmation the caller asks for);
 *   focus     → brings every member forward in order;
 *   layout    → positions members in a stack/grid without moving them to the
 *               individual controls.
 *
 * Pure, window-identity based, and independent of z-order (which the caller
 * holds). Nothing here performs I/O.
 */

export type LayoutKind = "stack" | "grid" | "dock" | "cascade";

export interface WindowRef {
  id: string;
  app: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  minimised: boolean;
}

export interface Group {
  id: string;
  name: string;
  memberIds: string[];
  /** Timestamp the group was created; ordering, not evidence. */
  createdAt: number;
}

export const GROUP_LIMIT = 64;
export const GROUP_MEMBERS_LIMIT = 32;

export function normalizeWindow(w: WindowRef): WindowRef {
  if (typeof w.id !== "string" || !/^w-[a-z0-9-]{1,32}$/.test(w.id)) throw new Error("Window id must be w-<1…32 alphanumerics/dashes>");
  if (!Number.isInteger(w.x) || !Number.isInteger(w.y)) throw new Error("Window coordinates must be integers");
  if (!Number.isInteger(w.w) || w.w < 80 || w.w > 7_680) throw new Error("Window width must be 80…7,680");
  if (!Number.isInteger(w.h) || w.h < 60 || w.h > 4_320) throw new Error("Window height must be 60…4,320");
  if (!Number.isInteger(w.z) || w.z < 0) throw new Error("Window z-order must be a non-negative integer");
  return { ...w, minimised: w.minimised === true };
}

export function makeGroup(id: string, name: string, memberIds: readonly string[], now: number): Group {
  if (!Number.isFinite(now) || now < 0) throw new Error("now must be a finite timestamp");
  if (typeof id !== "string" || !/^g-[a-z0-9-]{1,32}$/.test(id)) throw new Error("Group id must be g-<1…32 alphanumerics/dashes>");
  if (typeof name !== "string" || name.length === 0 || name.length > 40) throw new Error("Group name must be 1…40 characters");
  if (memberIds.length === 0 || memberIds.length > GROUP_MEMBERS_LIMIT) throw new Error(`A group needs 1…${GROUP_MEMBERS_LIMIT} members`);
  if (new Set(memberIds).size !== memberIds.length) throw new Error("A window cannot be in a group twice");
  return { id, name, memberIds: [...memberIds], createdAt: now };
}

export type LayoutResult = { applied: WindowRef[] } | { refused: string };

/** Layout the group's windows inside a viewport without moving any outside the group. */
export function layoutGroup(group: Group, windows: readonly WindowRef[], kind: LayoutKind, viewport: { w: number; h: number }, gap = 12): LayoutResult {
  const members = windows.filter((w) => group.memberIds.includes(w.id));
  if (members.length !== group.memberIds.length) return { refused: `Group ${group.id} is missing ${group.memberIds.length - members.length} window(s)` };
  if (members.length > GROUP_MEMBERS_LIMIT) return { refused: `Group has more than ${GROUP_MEMBERS_LIMIT} members` };
  const placed = members.map((w) => normalizeWindow(w));
  const cols = kind === "grid" ? Math.min(group.memberIds.length, 3) : kind === "dock" ? 1 : 1;
  const rows = kind === "grid" ? Math.ceil(placed.length / cols) : placed.length;
  const cellW = kind === "stack" ? Math.min(placed[0].w, viewport.w - gap) : (viewport.w - gap * (cols + 1)) / cols;
  const cellH = kind === "stack" ? Math.min(placed[0].h, viewport.h - gap) : (viewport.h - gap * (rows + 1)) / rows;
  const out = placed.map((w, i) => {
    const col = kind === "grid" ? i % cols : 0;
    const row = kind === "grid" ? Math.floor(i / cols) : i;
    return { ...w, x: Math.round(gap + col * (cellW + gap)), y: Math.round(gap + row * (cellH + gap)), w: Math.round(Math.min(w.w, cellW)), h: Math.round(Math.min(w.h, cellH)) };
  });
  return { applied: out };
}

export interface GroupOp { ok: boolean; affected: number; reason: string }

/** Minimize every member of the group, in reverse z-order so the last one lands last. */
export function minimizeGroup(windows: readonly WindowRef[], group: Group): { windows: WindowRef[]; op: GroupOp } {
  const sorted = [...windows].sort((a, b) => b.z - a.z);
  const byId = new Map(sorted.map((w) => [w.id, w]));
  let affected = 0;
  const next = sorted.map((w) => {
    const member = group.memberIds.includes(w.id);
    if (member && !w.minimised) affected++;
    return { ...w, minimised: member ? true : w.minimised };
  });
  return { windows: next, op: { ok: affected > 0 || byId.has(group.id) === false, affected, reason: affected ? `${affected} window(s) minimised` : "Nothing to minimise" } };
}

export function closeGroup(windows: readonly WindowRef[], group: Group): { windows: WindowRef[]; op: GroupOp } {
  const keep = windows.filter((w) => !group.memberIds.includes(w.id));
  return { windows: keep, op: { ok: true, affected: windows.length - keep.length, reason: `${windows.length - keep.length} window(s) closed` } };
}

export function focusGroup(windows: readonly WindowRef[], group: Group, z: number): { windows: WindowRef[]; op: GroupOp } {
  if (!Number.isInteger(z) || z < 0) throw new Error("Focus z-order must be a non-negative integer");
  const byId = new Map(windows.map((w) => [w.id, w]));
  let affected = 0;
  const next = windows.map((w) => {
    const member = group.memberIds.includes(w.id);
    if (member && w.z < z) affected++;
    return member ? { ...w, z, minimised: false } : w;
  });
  return { windows: next, op: { ok: affected > 0, affected, reason: affected ? `${affected} window(s) brought forward` : "Already on top" } };
}

export interface GroupSummary { id: string; name: string; count: number; apps: string[]; zMax: number }

export function summarize(group: Group, windows: readonly WindowRef[]): GroupSummary {
  const members = windows.filter((w) => group.memberIds.includes(w.id));
  return {
    id: group.id,
    name: group.name,
    count: members.length,
    apps: [...new Set(members.map((w) => w.app))],
    zMax: Math.max(0, ...members.map((w) => w.z)),
  };
}

export function describeGroup(g: GroupSummary): string {
  return `${g.name} (${g.count}) · ${g.apps.join(", ")}`;
}
