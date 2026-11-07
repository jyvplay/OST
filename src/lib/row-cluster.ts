/**
 * TT143 (SR-06) — clustering a row so one click means one thing.
 *
 * A results list with 600 rows cannot act on all of them, and it must not silently
 * act on "the ones that happen to be visible". This engine groups rows into
 * **clusters of consecutive rows with the same provenance**, which is the unit a
 * bulk action can honestly describe ("these 41 results from Files"). The rules
 * that make it safe:
 *
 *   · a cluster never spans a section boundary, so a bulk action cannot mix a note
 *     and a file;
 *   · a cluster smaller than the threshold is *shown* but not offered as a bulk
 *     target, because a "select all 2" affordance is noise;
 *   · an empty provenance is its own cluster and is labelled as unknown, rather
 *     than being merged into the first real one;
 *   · the selection is a set of **row ids**, never indices, so a filtered list
 *     cannot shift a selection onto a row the user never saw.
 */

export interface Row { id: string; section: string; provenance: string; sizeBytes?: number }
export interface Cluster { key: string; section: string; provenance: string; ids: string[]; bytes: number; actionable: boolean }

export const MIN_ACTIONABLE = 3;

export function cluster(rows: readonly Row[]): Cluster[] {
  const out: Cluster[] = [];
  let current: Cluster | null = null;
  for (const r of rows) {
    const provenance = r.provenance?.trim() || "(unknown source)";
    const key = `${r.section}␟${provenance}`;
    if (!current || current.key !== key) {
      current = { key, section: r.section, provenance, ids: [], bytes: 0, actionable: false };
      out.push(current);
    }
    current.ids.push(r.id);
    current.bytes += r.sizeBytes ?? 0;
  }
  for (const c of out) c.actionable = c.ids.length >= MIN_ACTIONABLE;
  return out;
}

/** Toggle a whole cluster, honouring "everything was already selected" as deselect. */
export function toggleCluster(selected: ReadonlySet<string>, c: Cluster): Set<string> {
  const next = new Set(selected);
  const all = c.ids.every((id) => selected.has(id));
  for (const id of c.ids) { if (all) next.delete(id); else next.add(id); }
  return next;
}

/** The selection summary. It names sections, so a mixed selection cannot be read as one kind of thing. */
export function describeSelection(rows: readonly Row[], selected: ReadonlySet<string>): string {
  const chosen = rows.filter((r) => selected.has(r.id));
  if (!chosen.length) return "Nothing selected.";
  const bySection = new Map<string, number>();
  for (const r of chosen) bySection.set(r.section, (bySection.get(r.section) ?? 0) + 1);
  const parts = [...bySection.entries()].map(([s, n]) => `${n} in ${s}`);
  return `${chosen.length} selected (${parts.join(", ")}).`;
}

/**
 * Which ids to act on for "select all matching": the *filtered* rows only, and the
 * caller is told how many were excluded, so the UI can say "all 41 shown".
 */
export function selectAll(rows: readonly Row[], limit = 500): { ids: string[]; truncated: boolean; note: string } {
  const ids = rows.slice(0, limit).map((r) => r.id);
  const truncated = rows.length > limit;
  return { ids, truncated, note: truncated ? `the first ${limit} of ${rows.length} rows; narrow the filter to act on the rest` : `all ${rows.length} shown` };
}
