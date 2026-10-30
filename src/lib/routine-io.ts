/** TT117 RT-01 — routine export/import. A routine file is data, not code: every
 * action is re-validated against the same whitelist the editor enforces, so an
 * imported routine can do nothing a typed routine could not. Names are capped,
 * duplicate names are refused (a silent overwrite would hide a replaced routine). */
import { validateActions, type RoutineAction } from "./routines";
export const ROUTINE_EXPORT_KIND = "fusion.routines.v1";
export interface RoutineDoc { name: string; actions: RoutineAction[] }

export function exportRoutines(routines: RoutineDoc[]): string {
  return JSON.stringify({ kind: ROUTINE_EXPORT_KIND, exportedAt: new Date().toISOString(), routines: routines.map((r) => ({ name: r.name, actions: validateActions(r.actions) })) }, null, 2);
}
export function parseRoutineImport(json: string, existingNames: string[]): { routines: RoutineDoc[]; skipped: string[] } {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { throw new Error("routine import is not valid JSON"); }
  const d = doc as { kind?: string; routines?: unknown };
  if (!d || d.kind !== ROUTINE_EXPORT_KIND || !Array.isArray(d.routines)) throw new Error("not a Fusion routines export");
  if (d.routines.length > 100) throw new Error("routine import has too many routines");
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  const routines: RoutineDoc[] = [], skipped: string[] = [];
  for (const raw of d.routines) {
    const r = raw as { name?: unknown; actions?: unknown };
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 80) : "";
    if (!name) throw new Error("routine import contains an unnamed routine");
    if (taken.has(name.toLowerCase())) { skipped.push(name); continue; }
    taken.add(name.toLowerCase());
    routines.push({ name, actions: validateActions(r.actions) }); // throws on a non-whitelisted action: file refused whole
  }
  return { routines, skipped };
}
