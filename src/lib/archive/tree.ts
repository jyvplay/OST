/**
 * TT79 — folder view over a flat ZIP directory (pure; used by the Archive app and unit-tested).
 * ZIP archives often omit folder entries ("a/b/c.txt" with no "a/" or "a/b/"), so folders are derived from paths.
 */
import type { ArchiveEntry } from "./zip";

export interface FolderRow { kind: "folder"; name: string; path: string; files: number; size: number; packed: number; explicit: ArchiveEntry | null }
export interface FileRow { kind: "file"; name: string; path: string; entry: ArchiveEntry }
export type Row = FolderRow | FileRow;

const norm = (n: string) => n.replace(/\\/g, "/").replace(/^\/+/, "");

/** rows of `folder` ("" = root, else "a/b/"): sub-folders first (alphabetical), then files */
export function listFolder(entries: ArchiveEntry[], folder: string): Row[] {
  const pre = folder && !folder.endsWith("/") ? folder + "/" : folder;
  const folders = new Map<string, FolderRow>(); const files: FileRow[] = [];
  for (const e of entries) {
    // unsafe names (absolute, "..", drive letters) are never turned into navigable folders: they are listed flat at
    // the root under their full raw name, where the "unsafe" badge is visible
    if (!e.safePath) { if (!pre) files.push({ kind: "file", name: e.name, path: "\u0000unsafe:" + e.index, entry: e }); continue; }
    const n = norm(e.name);
    if (!n.startsWith(pre) || n === pre) continue;
    const rest = n.slice(pre.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const name = rest.slice(0, slash), path = pre + name + "/";
      let f = folders.get(name);
      if (!f) { f = { kind: "folder", name, path, files: 0, size: 0, packed: 0, explicit: null }; folders.set(name, f); }
      if (rest === name + "/") f.explicit = e;
      else if (!e.dir) { f.files++; f.size += e.usize; f.packed += e.csize; }
    } else files.push({ kind: "file", name: rest, path: n, entry: e });
  }
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...[...folders.values()].sort((a, b) => coll.compare(a.name, b.name)), ...files.sort((a, b) => coll.compare(a.name, b.name))];
}

/** every entry name at or under the given rows (a folder selects its whole subtree) */
export function namesUnder(entries: ArchiveEntry[], rows: Row[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.kind === "file") out.add(r.entry.name);
    else for (const e of entries) if (norm(e.name).startsWith(r.path)) out.add(e.name);
  }
  return [...out];
}

export const parentFolder = (folder: string) => { const t = folder.replace(/\/$/, ""); const i = t.lastIndexOf("/"); return i < 0 ? "" : t.slice(0, i + 1); };
export const crumbs = (folder: string) => { const parts = folder.split("/").filter(Boolean); return parts.map((p, i) => ({ name: p, path: parts.slice(0, i + 1).join("/") + "/" })); };

/** a guess at whether bytes are UTF-8 text worth previewing as text */
export function looksText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192); let ctrl = 0;
  for (let i = 0; i < n; i++) { const c = b[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) ctrl++; }
  if (ctrl > n / 50) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, Math.max(0, n - 4))); return true; } catch { return false; }
}
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg|ico)$/i;
export const MIME_BY_EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon" };
