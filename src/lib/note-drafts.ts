import { NOTE_LIMITS, noteFields, noteInteger, noteWrite, type NoteFields, type NoteRecord } from "./note-model";

/** Per-window reload recovery, never a host request. Amnesic callers pass null:
 * the identical codec then lives in page RAM and is dropped on emergency exit.
 * Storage quota errors are surfaced, not silently evicted or host-fallbacked. */
export interface NoteDraft { v: 1; base: NoteRecord; value: NoteFields; savedAt: number }
export const NOTE_DRAFT_TTL = 7 * 86400_000;
export const NOTE_RAM_DRAFT_LIMITS = { entries: 64, bytes: 64 * 1024 * 1024 } as const;
const ram = new Map<string, { text: string; expiresAt: number }>();
let ramBytes = 0;
export const noteDraftKey = (win: string, id: number) => `fusion.notes.draft.v1:${encodeURIComponent(win)}:${noteInteger(id)}`;
export function decodeNoteDraft(text: string | null, id: number, now = Date.now()): NoteDraft | null {
  // Two worst-case JSON-escaped bodies, not just the edited value.
  if (!text || text.length > NOTE_LIMITS.body * 12 + 32_768) return null;
  try {
    const d = JSON.parse(text) as NoteDraft;
    if (d.v !== 1 || d.base?.id !== id || noteInteger(d.base.revision, "revision") < 1 || !Number.isFinite(d.savedAt) || d.savedAt > now + 60_000 || now - d.savedAt > NOTE_DRAFT_TTL) return null;
    if (typeof d.base.createdAt !== "string" || typeof d.base.updatedAt !== "string") return null;
    if (["title", "body", "tags", "pinned"].some(k => !Object.prototype.hasOwnProperty.call(d.base, k))) return null;
    noteWrite(d.base as unknown as Record<string, unknown>);
    // An EDITING state can have a temporarily blank title or text that Save
    // will refuse. Preserve it for correction, rather than losing that draft.
    if (!d.value || typeof d.value.pinned !== "boolean") return null;
    for (const k of ["title", "body", "tags"] as const) if (typeof d.value[k] !== "string" || d.value[k].length > NOTE_LIMITS[k]) return null;
    return { v: 1, base: { id: d.base.id, revision: d.base.revision, createdAt: d.base.createdAt, updatedAt: d.base.updatedAt, ...noteFields(d.base) }, value: noteFields(d.value), savedAt: d.savedAt };
  } catch { return null; }
}
export function readNoteDraft(storage: Pick<Storage, "getItem"> | null, key: string, id: number): NoteDraft | null {
  const entry = ram.get(key);
  if (!storage && entry && entry.expiresAt < Date.now()) removeNoteDraft(null, key);
  return decodeNoteDraft(storage ? storage.getItem(key) : ram.get(key)?.text ?? null, id);
}
export function writeNoteDraft(storage: Pick<Storage, "setItem"> | null, key: string, draft: NoteDraft): void {
  const text = JSON.stringify(draft);
  if (storage) { storage.setItem(key, text); return; }
  const now = Date.now();
  for (const [k, entry] of ram) if (entry.expiresAt < now) removeNoteDraft(null, k);
  const prior = ram.get(key), size = text.length * 2;
  if ((!prior && ram.size >= NOTE_RAM_DRAFT_LIMITS.entries) || ramBytes - (prior?.text.length ?? 0) * 2 + size > NOTE_RAM_DRAFT_LIMITS.bytes) throw new Error("RAM draft recovery quota reached; keep the unsaved note open");
  ramBytes += size - (prior?.text.length ?? 0) * 2;
  ram.set(key, { text, expiresAt: draft.savedAt + NOTE_DRAFT_TTL });
}
export function removeNoteDraft(storage: Pick<Storage, "removeItem"> | null, key: string): void {
  if (storage) storage.removeItem(key);
  else { ramBytes -= (ram.get(key)?.text.length ?? 0) * 2; ram.delete(key); }
}
export function clearRamNoteDrafts(): void { ram.clear(); ramBytes = 0; }
