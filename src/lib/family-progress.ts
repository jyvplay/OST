/** SP-02: per-family completion for the Spec register. Percentages are
 *  built/(all rows in the family); partial/probe/blocked stay visible as
 *  their own counts rather than being folded into a misleading average. */
export interface FeatureRow { family: string; status: string }
export interface FamilyProgress { family: string; total: number; built: number; pct: number }
export function familyProgress(rows: FeatureRow[]): FamilyProgress[] {
  const by = new Map<string, FamilyProgress>();
  for (const r of rows) {
    const f = by.get(r.family) ?? { family: r.family, total: 0, built: 0, pct: 0 };
    f.total++; if (r.status === "built") f.built++;
    by.set(r.family, f);
  }
  const out = [...by.values()].map((f) => ({ ...f, pct: f.total ? Math.round((f.built / f.total) * 100) : 0 }));
  return out.sort((a, b) => b.pct - a.pct || a.family.localeCompare(b.family));
}
