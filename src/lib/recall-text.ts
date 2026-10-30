/** TT125 RC-03: recall hits as copyable text, newest first. */
export interface RecallHit { title: string; where: string; at?: number; }
export function recallHitsText(hits: ReadonlyArray<RecallHit>): string {
  if (!hits.length) return "no hits recorded";
  return [...hits].sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    .map((h) => (h.at == null ? `${h.title}  (${h.where})` : `${new Date(h.at).toISOString().slice(0, 16).replace("T", " ")}  ${h.title}  (${h.where})`)).join("\n");
}
