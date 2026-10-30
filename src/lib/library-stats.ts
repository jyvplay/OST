/** MU-05: stream-library statistics line. Counts are computed from the
 *  stored library (both faces), so the Video and Music windows quote the
 *  same totals for the shared file. */
export interface LibItem { kind: string; provider: string }
export function libraryStats(items: LibItem[], kind: string): string {
  const mine = items.filter((i) => i.kind === kind);
  if (!mine.length) return "library empty";
  const providers = new Set(mine.map((i) => i.provider)).size;
  return `${mine.length} saved · ${providers} provider${providers === 1 ? "" : "s"}`;
}
