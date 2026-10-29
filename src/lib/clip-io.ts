/** TT117 CB-01 — clipboard history export/import.
 * Sensitive entries are exported only as a redaction marker and are REFUSED on
 * import: a masked secret must never come back as a usable clip. Import dedupes
 * against existing entries by (text, sensitive) and caps the merged history;
 * malformed files are refused whole rather than partially applied. */
import type { ClipEntry } from "../components/shell-context";
export const CLIP_EXPORT_KIND = "fusion.clipboard.v1";
export interface ClipImportReport { added: ClipEntry[]; skippedDuplicates: number; refusedSensitive: number }

export function exportClips(clips: ClipEntry[]): string {
  const entries = clips.map((c) => c.sensitive
    ? { text: "", at: c.at, sensitive: true, from: c.from, pinned: !!c.pinned, redacted: true }
    : { text: c.text, at: c.at, sensitive: false, from: c.from, pinned: !!c.pinned });
  return JSON.stringify({ kind: CLIP_EXPORT_KIND, exportedAt: new Date().toISOString(), entries }, null, 2);
}
export function parseClipImport(json: string, existing: ClipEntry[], cap = 200): ClipImportReport {
  let doc: unknown;
  try { doc = JSON.parse(json); } catch { throw new Error("clipboard import is not valid JSON"); }
  const d = doc as { kind?: string; entries?: unknown };
  if (!d || d.kind !== CLIP_EXPORT_KIND || !Array.isArray(d.entries)) throw new Error("not a Fusion clipboard export");
  if (d.entries.length > 1000) throw new Error("clipboard import has too many entries");
  const seen = new Set(existing.map((c) => `${c.sensitive ? "s" : "t"}:${c.text}`));
  const added: ClipEntry[] = [];
  let skippedDuplicates = 0, refusedSensitive = 0;
  for (const raw of d.entries) {
    const e = raw as Partial<ClipEntry> & { redacted?: boolean };
    if (e.sensitive || e.redacted) { refusedSensitive++; continue; }
    if (typeof e.text !== "string" || !e.text || e.text.length > 100_000 || typeof e.at !== "number" || !Number.isSafeInteger(e.at)) {
      throw new Error("clipboard import contains an invalid entry");
    }
    const key = `t:${e.text}`;
    if (seen.has(key)) { skippedDuplicates++; continue; }
    seen.add(key);
    added.push({ text: e.text, at: e.at, sensitive: false, from: String(e.from ?? "import").slice(0, 60), pinned: !!e.pinned });
  }
  const merged = [...added, ...existing];
  if (merged.length > cap) throw new Error(`import would exceed the ${cap}-entry history cap; clear entries first`);
  return { added, skippedDuplicates, refusedSensitive };
}
