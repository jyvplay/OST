/**
 * TT55 — the Files clipboard (FM-03 / FM-15): Copy or Cut in one pane / window, Paste in another. Lives for the tab's
 * session (sessionStorage) so two Files windows share it; it holds paths only, never file contents.
 */
export interface FileClip { mode: "copy" | "cut"; paths: string[]; at: number }
const KEY = "fusion.files.clip";
const subs = new Set<() => void>();
let cur: FileClip | null = null;
const load = (): FileClip | null => {
  if (cur) return cur;
  try { const j = typeof sessionStorage === "undefined" ? null : JSON.parse(sessionStorage.getItem(KEY) ?? "null") as FileClip | null; cur = j && Array.isArray(j.paths) ? j : null; } catch { cur = null; }
  return cur;
};
export const getClip = (): FileClip | null => load();
export function setClip(input: Omit<FileClip, "at"> | null) {
  const c: FileClip | null = input ? { ...input, at: Date.now() } : null;
  cur = c;
  try { if (typeof sessionStorage !== "undefined") { if (c) sessionStorage.setItem(KEY, JSON.stringify(c)); else sessionStorage.removeItem(KEY); } } catch { /* quota */ }
  for (const f of subs) f();
}
export function subscribeClip(f: () => void): () => void { subs.add(f); return () => { subs.delete(f); }; }
