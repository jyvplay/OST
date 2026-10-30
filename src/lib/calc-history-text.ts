/** CV-03: calculator history as text. One "expr = result" per line in
 *  the order calculated (oldest first), so a pasted history reads as a
 *  worked calculation rather than a reversed log. */
export interface CalcEntryLike { expr: string; text: string }
export function historyAsText(entries: CalcEntryLike[]): string {
  return [...entries].reverse().map((e) => `${e.expr} = ${e.text}`).join("\n");
}
