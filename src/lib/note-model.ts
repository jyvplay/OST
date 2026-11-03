/** Notes' bounded public write contract. Revision checks, not wall-clock
 * timestamps, distinguish A → B → A edits within one row lifetime, for
 * cooperating revision-checked clients. Restore/reused-identity ABA is separate. */
export const NOTE_LIMITS = { title: 500, body: 1_048_576, tags: 2_048 } as const;
/** Trim generated titles without manufacturing a lone high surrogate. */
export function noteTitlePrefix(value: string, limit: number = NOTE_LIMITS.title): string {
  return value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
}
export function noteCopyTitle(value: string): string { return `${noteTitlePrefix(value, NOTE_LIMITS.title - 5)} copy`; }
export interface NoteFields { title: string; body: string; tags: string; pinned: boolean }
export interface NoteRecord extends NoteFields { id: number; revision: number; createdAt: string; updatedAt: string }
export class NoteInputError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "NoteInputError"; this.status = status; }
}
export function noteInteger(value: unknown, name = "id"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new NoteInputError(`${name} must be a positive 32-bit integer`);
  return value;
}
export function noteFields(note: NoteFields): NoteFields {
  return { title: note.title, body: note.body, tags: note.tags, pinned: note.pinned };
}
export function sameNote(a: NoteFields, b: NoteFields): boolean {
  return a.title === b.title && a.body === b.body && a.tags === b.tags && a.pinned === b.pinned;
}
export function noteWrite(input: Record<string, unknown>, previous?: NoteFields): NoteFields {
  const next = previous ? noteFields(previous) : { title: "Untitled", body: "", tags: "", pinned: false };
  let supplied = false;
  for (const key of ["title", "body", "tags"] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    supplied = true;
    const value = input[key];
    if (typeof value !== "string" || value.length > NOTE_LIMITS[key] || value.includes("\0") || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) throw new NoteInputError(`${key} must be text up to ${NOTE_LIMITS[key]} characters, with valid Unicode and without NUL`);
    if (key === "title" && (!value.trim() || /[\x00-\x1f\x7f]/.test(value))) throw new NoteInputError("title must contain nonblank single-line text");
    next[key] = key === "title" ? value.trim() : value;
  }
  if (Object.prototype.hasOwnProperty.call(input, "pinned")) {
    supplied = true;
    if (typeof input.pinned !== "boolean") throw new NoteInputError("pinned must be boolean");
    next.pinned = input.pinned;
  }
  if (previous && !supplied) throw new NoteInputError("no editable note fields supplied");
  return next;
}
export function assertNoteRevision(value: unknown, current: number): void {
  if (noteInteger(value, "expectedRevision") !== current) throw new NoteInputError("This note changed in another window. Reload before saving or deleting.", 409);
}
export function filterNotes<T extends NoteFields>(notes: readonly T[], query: string): T[] {
  const key = (value: string) => value.normalize("NFKC").toLowerCase();
  const terms = key(query).trim().split(/\s+/).filter(Boolean);
  return notes.filter(n => { const haystack = key(`${n.title}\n${n.body}\n${n.tags}`); return terms.every(t => haystack.includes(t)); });
}
export function importNoteMarkdown(bytes: Uint8Array, filename: string): NoteFields {
  if (bytes.byteLength > NOTE_LIMITS.body) throw new NoteInputError("Markdown import is limited to 1 MiB of UTF-8 bytes");
  let body: string;
  try { body = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new NoteInputError("Markdown must be valid UTF-8 text"); }
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const title = noteTitlePrefix((heading || filename.replace(/\.(?:md|markdown|txt)$/i, "") || "Imported note").replace(/[\x00-\x1f\x7f]/g, " ").trim()) || "Imported note";
  return noteWrite({ title, body });
}
export function excerptNote(text: string, start: number, end: number): string {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length) throw new NoteInputError("Select some note text first");
  return text.slice(start, end);
}
