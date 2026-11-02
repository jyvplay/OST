import { searchInput, type SearchInput } from "./search-query";
export interface ExportSearchHit { source: string; ref: string; title: string; snippet: string; how: string; rank: number; matchedFields?: { field: string; value: string }[] }
/** CSV is spreadsheet-safe rather than byte-identical: dangerous formula
 * prefixes get an apostrophe. JSON is the lossless portable representation. */
export function exportSearchResults(input: SearchInput, hits: readonly ExportSearchHit[], format: "json" | "csv"): string {
  if (hits.length > 200) throw new Error("Export is limited to 200 visible results; narrow the result filter");
  const current = searchInput(input);
  for (const hit of hits) if (![hit.source, hit.ref, hit.title, hit.snippet, hit.how].every(value => typeof value === "string") || !Number.isFinite(hit.rank)) throw new Error("Invalid result data");
  let text: string;
  if (format === "json") text = JSON.stringify({ kind: "fusion.search-results.v1", input: current, hits }, null, 2) + "\n";
  else if (format === "csv") {
    const cell = (value: string | number) => { let text = String(value); if (/^[\s\uFEFF]*[=+\-@]/.test(text)) text = "'" + text; return `"${text.replaceAll('"', '""')}"`; };
    text = [["source", "reference", "title", "snippet", "strategy", "rank"].map(cell).join(","), ...hits.map(hit => [hit.source, hit.ref, hit.title, hit.snippet, hit.how, hit.rank].map(cell).join(","))].join("\r\n") + "\r\n";
  } else throw new Error("Unsupported result export format");
  if (new TextEncoder().encode(text).byteLength > 4_194_304) throw new Error("Result export exceeds 4 MiB");
  return text;
}
