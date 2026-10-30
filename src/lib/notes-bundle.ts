/** NT-06: every note in one Markdown file. Reuses NT-04's single-note
 *  rendering so a bundled note looks exactly like its solo export; notes
 *  are ordered by title so the bundle is stable between exports. */
import { noteToMarkdown } from "./note-export";
export interface BundleNote { title: string; body: string; tags?: string; updatedAt?: string }
export function notesBundle(notes: BundleNote[], now: Date): string {
  const ordered = [...notes].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  const head = `# Notes bundle\n\nExported ${now.toISOString()} · ${ordered.length} note${ordered.length === 1 ? "" : "s"}\n`;
  if (!ordered.length) return `${head}\n(no notes)\n`;
  return `${head}\n${ordered.map((n) => noteToMarkdown({ title: n.title, body: n.body, tags: n.tags }, now)).join("\n---\n")}`;
}
