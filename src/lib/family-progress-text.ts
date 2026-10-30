/** SP-03: family progress as text, worst families first — the copy is a
 *  work list, so it leads with what is least complete. Percentages come
 *  from the same engine the on-screen strip uses, so they cannot drift. */
import { familyProgress, type FeatureRow } from "./family-progress";
export function familyProgressText(rows: FeatureRow[]): string {
  const fams = familyProgress(rows).sort((a, b) => a.pct - b.pct || a.family.localeCompare(b.family));
  if (!fams.length) return "(no families)";
  return fams.map((f) => `${f.family} ${f.pct}% (${f.built}/${f.total} built)`).join("\n");
}
