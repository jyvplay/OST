/**
 * TT137 (AP-05) — Background/startup inventory.
 *
 * Pure inventory of background agents, service workers, and startup
 * registrations. No I/O — just classification and reporting.
 */

export type BackgroundKind = "service-worker" | "periodic-sync" | "notification" | "alarm" | "media-session" | "offscreen" | "window-control" | "background-fetch";

export interface BackgroundEntry {
  id: string;
  kind: BackgroundKind;
  /** Module that owns this background entry. */
  module: string;
  /** Whether the entry is active. */
  active: boolean;
  /** Whether the entry is registered at startup. */
  startup: boolean;
  /** Last time the entry ran (epoch ms), or null if never. */
  lastRun: number | null;
  /** Description for the user. */
  description: string;
}

export interface InventoryState {
  entries: BackgroundEntry[];
}

export const INVENTORY_LIMIT = 200;

export function createInventory(): InventoryState {
  return { entries: [] };
}

export function registerEntry(state: InventoryState, entry: BackgroundEntry, now: number): { ok: true } | { ok: false; reason: string } {
  if (state.entries.length >= INVENTORY_LIMIT) return { ok: false, reason: `Inventory limit (${INVENTORY_LIMIT}) reached` };
  if (!/^bg-[a-z0-9-]{1,40}$/.test(entry.id)) throw new Error("Background id must be bg-<1…40>");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(entry.module)) throw new Error("Module id invalid");
  if (state.entries.some((e) => e.id === entry.id)) return { ok: false, reason: `Entry ${entry.id} already registered` };
  state.entries.push({ ...entry, lastRun: entry.lastRun ?? now });
  return { ok: true };
}

export function unregisterEntry(state: InventoryState, id: string): { ok: true } | { ok: false; reason: string } {
  const idx = state.entries.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, reason: `Entry ${id} not found` };
  state.entries.splice(idx, 1);
  return { ok: true };
}

export function markActive(state: InventoryState, id: string, active: boolean, now: number): { ok: true } | { ok: false; reason: string } {
  const e = state.entries.find((x) => x.id === id);
  if (!e) return { ok: false, reason: `Entry ${id} not found` };
  e.active = active;
  if (active) e.lastRun = now;
  return { ok: true };
}

export interface InventoryReport {
  total: number;
  active: number;
  startup: number;
  byKind: Record<BackgroundKind, number>;
  byModule: Record<string, number>;
  entries: BackgroundEntry[];
}

export function report(state: InventoryState): InventoryReport {
  const byKind: Record<BackgroundKind, number> = {
    "service-worker": 0, "periodic-sync": 0, "notification": 0, "alarm": 0,
    "media-session": 0, "offscreen": 0, "window-control": 0, "background-fetch": 0,
  };
  const byModule: Record<string, number> = {};
  for (const e of state.entries) {
    byKind[e.kind]++;
    byModule[e.module] = (byModule[e.module] ?? 0) + 1;
  }
  return {
    total: state.entries.length,
    active: state.entries.filter((e) => e.active).length,
    startup: state.entries.filter((e) => e.startup).length,
    byKind,
    byModule,
    entries: [...state.entries],
  };
}

/** Check that no entry claims to be a service worker without being registered as one. */
export function checkConsistency(state: InventoryState): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const e of state.entries) {
    if (e.kind === "service-worker" && !e.startup) issues.push(`${e.id} is a service worker but not marked startup`);
    if (e.kind === "alarm" && !e.active) issues.push(`${e.id} is an alarm but not active`);
    if (e.lastRun !== null && e.lastRun < 0) issues.push(`${e.id} has an invalid lastRun`);
  }
  return { ok: issues.length === 0, issues };
}

export function describeEntry(e: BackgroundEntry): string {
  return `${e.id} (${e.kind}) · ${e.module} · ${e.active ? "active" : "idle"}${e.startup ? " · startup" : ""}`;
}
