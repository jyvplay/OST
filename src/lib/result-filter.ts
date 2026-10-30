/** SR-11: the result list as plain text — one line per hit (title, source,
 *  reference) for pasting into a note or report. Snippets are excluded on
 *  purpose: a copied list is an index, not a second copy of the content. */
export interface FindHitLike { title: string; ref: string; source: string }
export function resultsText(hits: FindHitLike[]): string {
  return hits.map((h) => `${h.title} [${h.source}] ${h.ref}`).join("\n");
}
