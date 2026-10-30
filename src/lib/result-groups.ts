/**
 * SR-10 — Find result grouping. Groups hits by source in first-seen order
 * (the order the ranking produced; grouping must not re-rank), counting
 * per source so "3 files · 1 note" is answerable without scrolling.
 */
export interface GroupedHit<T> { source: string; hits: T[] }

export function groupBySource<T extends { source: string }>(hits: T[]): GroupedHit<T>[] {
  const out: GroupedHit<T>[] = [];
  const bySource = new Map<string, GroupedHit<T>>();
  for (const h of hits) {
    let g = bySource.get(h.source);
    if (!g) { g = { source: h.source, hits: [] }; bySource.set(h.source, g); out.push(g); }
    g.hits.push(h);
  }
  return out;
}

export function sourceSummary<T extends { source: string }>(hits: T[]): string {
  return groupBySource(hits).map((g) => `${g.hits.length} ${g.source}`).join(" · ");
}
