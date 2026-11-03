/** Original, bounded text/library constructions. No evaluator, network or HTML. */
import { NOTE_LIMITS, noteFields, noteTitlePrefix, noteWrite, type NoteFields, type NoteRecord } from "./note-model";
import { noteMarkdown, safeNoteLink, NOTE_PREVIEW_LINES } from "./note-markdown";

export const NOTE_BATCH_LIMIT = 32;
export const NOTE_COLLECTION_BYTES = 4 * 1024 * 1024;
export function noteBatch(value: unknown): NoteFields[] {
  if (!Array.isArray(value) || !value.length || value.length > NOTE_BATCH_LIMIT) throw new Error("Choose 1–32 notes");
  const fields = value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["title", "body", "tags", "pinned"].includes(key))) throw new Error("Unsupported note field; identities and revisions cannot be imported");
    if (!Object.hasOwn(item, "title")) throw new Error("Every copied note requires an explicit title");
    return noteWrite(item as Record<string, unknown>);
  });
  if (new TextEncoder().encode(JSON.stringify(fields)).byteLength > NOTE_COLLECTION_BYTES) throw new Error("A note collection is limited to 4 MiB of UTF-8 JSON");
  return fields;
}
export function exportNoteCopies(rows: readonly NoteRecord[]): string {
  const text = JSON.stringify({ kind: "fusion.note-copies.v1", notes: noteBatch(rows.map(noteFields)) }, null, 2) + "\n";
  if (new TextEncoder().encode(text).byteLength > NOTE_COLLECTION_BYTES) throw new Error("Export exceeds 4 MiB; select fewer notes");
  return text;
}
export function importNoteCopies(text: string): NoteFields[] {
  if (new TextEncoder().encode(text).byteLength > NOTE_COLLECTION_BYTES) throw new Error("Import is limited to 4 MiB");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a note collection object");
  const object = parsed as Record<string, unknown>;
  if (object.kind !== "fusion.note-copies.v1" || Object.keys(object).some(key => key !== "kind" && key !== "notes")) throw new Error("Unsupported note collection");
  return noteBatch(object.notes);
}
export function mergedNote(rows: readonly NoteRecord[], title: string): NoteFields {
  if (rows.length < 2 || rows.length > NOTE_BATCH_LIMIT) throw new Error("Choose 2–32 saved notes to merge");
  return noteWrite({ title, body: rows.map(row => `# ${row.title}\n\n${row.body}`).join("\n\n---\n\n"), tags: "", pinned: false });
}
export function splitNote(value: NoteFields): NoteFields[] {
  const parsed = noteMarkdown(value.body);
  if (parsed.truncated) throw new Error(`Splitting requires at most ${NOTE_PREVIEW_LINES} source lines; the note was not changed`);
  const headings = parsed.blocks.filter(block => block.kind === "heading" && block.level === 1);
  const starts = [0]; for (let i = 0; i < value.body.length; i++) if (value.body[i] === "\n") starts.push(i + 1);
  const cuts = headings.map(heading => ({ at: starts[heading.line], title: heading.text }));
  if (!cuts.length) throw new Error("Add top-level # headings before splitting");
  if (cuts[0].at !== 0) cuts.unshift({ at: 0, title: `${value.title} — introduction` });
  if (cuts.length < 2) throw new Error("At least two sections are needed");
  return noteBatch(cuts.map((cut, i) => ({ ...value, title: noteTitlePrefix(cut.title).trim() || `Section ${i + 1}`, pinned: false, body: value.body.slice(cut.at, cuts[i + 1]?.at ?? value.body.length) })));
}
export function replaceNoteText(body: string, find: string, replacement: string): { body: string; count: number } {
  if (!find || find.length > 512 || replacement.length > 16_384) throw new Error("Find needs 1–512 characters; replacement allows 16,384");
  let count = 0, at = 0;
  while ((at = body.indexOf(find, at)) >= 0) { count++; at += find.length; }
  if (body.length + count * (replacement.length - find.length) > NOTE_LIMITS.body) throw new Error("Replacement would exceed the note body limit");
  const output = body.split(find).join(replacement);
  noteWrite({ title: "Validation", body: output });
  return { body: output, count };
}
export function insertNoteLink(body: string, start: number, end: number, label: string, url: string): string {
  const href = safeNoteLink(url);
  if (!href || !label.trim() || /[\[\]\x00-\x1f\x7f]/.test(label) || label.length > 512) throw new Error("Use a plain label without brackets and an http, https or mailto URL");
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > body.length) throw new Error("Selection is no longer valid");
  const output = body.slice(0, start) + `[${label}](${href.replaceAll("(", "%28").replaceAll(")", "%29")})` + body.slice(end);
  return noteWrite({ title: "Validation", body: output }).body;
}
export function markdownTable(columns: number, rows: number): string {
  if (!Number.isInteger(columns) || columns < 2 || columns > 16 || !Number.isInteger(rows) || rows < 1 || rows > 100) throw new Error("Tables require 2–16 columns and 1–100 data rows");
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(Array.from({ length: columns }, (_, i) => `Column ${i + 1}`)), line(Array(columns).fill("---")), ...Array.from({ length: rows }, () => line(Array(columns).fill(" ")))].join("\n");
}
export interface NoteTemplate { kind: "fusion.note-template.v1"; fields: NoteFields }
export function noteTemplate(value: unknown): NoteTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid note template");
  const object = value as Record<string, unknown>;
  if (object.kind !== "fusion.note-template.v1" || Object.keys(object).some(key => key !== "kind" && key !== "fields")) throw new Error("Unsupported note template");
  const template: NoteTemplate = { kind: "fusion.note-template.v1", fields: noteBatch([object.fields])[0] };
  if (new TextEncoder().encode(JSON.stringify(template)).byteLength > NOTE_COLLECTION_BYTES) throw new Error("A complete template is limited to 4 MiB of UTF-8 JSON");
  return template;
}
export function expandNoteTemplate(template: NoteTemplate, title: string, now: Date): NoteFields {
  const pad = (n: number) => String(n).padStart(2, "0");
  const tokens: Record<string, string> = { title, date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`, time: `${pad(now.getHours())}:${pad(now.getMinutes())}` };
  const expand = (s: string) => s.replace(/\{\{(title|date|time)\}\}/g, (_, key: string) => tokens[key]);
  return noteWrite({ title, body: expand(template.fields.body), tags: expand(template.fields.tags), pinned: false });
}
export function templateFilename(name: string): string {
  if (!name.trim() || name.length > 80 || /[/\\\x00-\x1f\x7f]/.test(name) || name.trim() === "." || name.trim() === "..") throw new Error("Use a template name of 1–80 characters without slashes or controls");
  // The same strict Unicode check as the public Notes contract.
  noteWrite({ title: name }); return `${name.trim()}.json`;
}
