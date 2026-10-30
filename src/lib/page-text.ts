/** TT125 PD-03: rebuild reading order from a PDF text layer.
 *  The caller supplies each span with its position in page space; we group
 *  spans into lines by vertical proximity, then order lines top-to-bottom and
 *  spans left-to-right. No layout invention: spans keep their own text. */
export interface TextSpan { str: string; x: number; y: number; }
export function pdfPageText(spans: ReadonlyArray<TextSpan>, lineSlack = 2): string {
  const live = spans.filter((s) => s.str.trim().length > 0);
  if (!live.length) return "";
  const sorted = [...live].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: TextSpan[][] = [];
  for (const s of sorted) {
    const line = lines.find((l) => Math.abs(l[0].y - s.y) <= lineSlack);
    if (line) line.push(s); else lines.push([s]);
  }
  lines.sort((a, b) => a[0].y - b[0].y);
  return lines.map((l) => l.sort((a, b) => a.x - b.x).map((s) => s.str).join(" ").replace(/\s+/g, " ").trim()).join("\n");
}
