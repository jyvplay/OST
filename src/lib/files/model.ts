/**
 * TT55 — pure models behind the Files module (FM-01/02/06/13/15/16, SH-09). No React, no fetch: unit-testable in Node.
 *
 *  selection   click / Ctrl(⌘)-toggle / Shift-range from an anchor / select-all / keyboard extend, over the VISIBLE order
 *  history     back / forward stacks (a new navigation clears forward; duplicates of the current entry are ignored)
 *  names       conflict-free destination names: "a.txt" → "a copy.txt" → "a copy 2.txt" (dirs: "Folder copy"); and
 *              "untitled" → "untitled 2" for new items — the server refuses to overwrite, so the client must pick
 *  menu        one context-menu model for every surface: concise vs full sets, type-to-search over labels + keywords
 *  paths       join / parent / base helpers that never produce "//" or a trailing slash
 */

export interface Sel { paths: string[]; anchor: string | null; focus: string | null }
export const emptySel = (): Sel => ({ paths: [], anchor: null, focus: null });

/** pointer selection. `order` is the visible order (after filter / sort) */
export function clickSelect(s: Sel, order: string[], path: string, mods: { ctrl?: boolean; shift?: boolean }): Sel {
  if (mods.shift && s.anchor && order.includes(s.anchor)) {
    const a = order.indexOf(s.anchor), b = order.indexOf(path);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    // Ctrl+Shift adds the range to the existing selection; Shift alone replaces it
    const paths = mods.ctrl ? [...new Set([...s.paths, ...range])] : range;
    return { paths, anchor: s.anchor, focus: path };
  }
  if (mods.ctrl) {
    const has = s.paths.includes(path);
    return { paths: has ? s.paths.filter((p) => p !== path) : [...s.paths, path], anchor: path, focus: path };
  }
  return { paths: [path], anchor: path, focus: path };
}
export const selectAll = (order: string[]): Sel => ({ paths: [...order], anchor: order[0] ?? null, focus: order[order.length - 1] ?? null });
/** keyboard: move the focus by `delta` (clamped); Shift extends from the anchor, Ctrl moves focus only */
export function keySelect(s: Sel, order: string[], delta: number | "home" | "end", mods: { ctrl?: boolean; shift?: boolean }): Sel {
  if (!order.length) return s;
  const cur = s.focus && order.includes(s.focus) ? order.indexOf(s.focus) : -1;
  const i = delta === "home" ? 0 : delta === "end" ? order.length - 1 : Math.max(0, Math.min(order.length - 1, (cur < 0 ? (delta > 0 ? -1 : order.length) : cur) + delta));
  const to = order[i];
  if (mods.ctrl && !mods.shift) return { ...s, focus: to };
  if (mods.shift) return clickSelect({ ...s, anchor: s.anchor ?? order[Math.max(0, cur)] }, order, to, { shift: true });
  return { paths: [to], anchor: to, focus: to };
}
/** drop paths that are no longer visible (after navigation / filter / delete) */
export const pruneSel = (s: Sel, order: string[]): Sel => {
  const set = new Set(order); const paths = s.paths.filter((p) => set.has(p));
  return { paths, anchor: s.anchor && set.has(s.anchor) ? s.anchor : null, focus: s.focus && set.has(s.focus) ? s.focus : null };
};

export interface Hist { back: string[]; cur: string; fwd: string[] }
export const hist = (start: string): Hist => ({ back: [], cur: start, fwd: [] });
export const navigate = (h: Hist, to: string): Hist => (to === h.cur ? h : { back: [...h.back, h.cur].slice(-50), cur: to, fwd: [] });
export const goBack = (h: Hist): Hist => (h.back.length ? { back: h.back.slice(0, -1), cur: h.back[h.back.length - 1], fwd: [h.cur, ...h.fwd] } : h);
export const goForward = (h: Hist): Hist => (h.fwd.length ? { back: [...h.back, h.cur], cur: h.fwd[0], fwd: h.fwd.slice(1) } : h);

export const joinPath = (dir: string, name: string) => `${dir === "/" ? "" : dir.replace(/\/+$/, "")}/${name}`;
export const parentPath = (p: string) => (p === "/" || !p.includes("/") ? "/" : p.slice(0, p.lastIndexOf("/")) || "/");
export const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
/** breadcrumb segments: "/a/b" → [["/", "/"], ["a", "/a"], ["b", "/a/b"]] */
export const crumbs = (p: string): [string, string][] => {
  const out: [string, string][] = [["/", "/"]]; let acc = "";
  for (const seg of p.split("/").filter(Boolean)) { acc += `/${seg}`; out.push([seg, acc]); }
  return out;
};
/** "a.tar.gz" → ["a.tar", ".gz"]; dotfiles keep their name: ".env" → [".env", ""] */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i <= 0 ? [name, ""] : [name.slice(0, i), name.slice(i)];
}
/** a destination name that does not collide with `taken` (case-sensitive, like the VFS) */
export function copyName(name: string, taken: Iterable<string>, isDir = false, style: "copy" | "number" = "copy"): string {
  const set = new Set(taken); if (!set.has(name)) return name;
  const [stem, ext] = isDir ? [name, ""] : splitExt(name);
  // strip an existing " copy" / " copy N" / " N" suffix so copies of copies do not grow "copy copy"
  const root = style === "copy" ? stem.replace(/ copy(?: \d+)?$/, "") : stem.replace(/ \d+$/, "");
  for (let n = 1; n < 10_000; n++) {
    const cand = style === "copy" ? `${root} copy${n === 1 ? "" : ` ${n}`}${ext}` : `${root} ${n + 1}${ext}`;
    if (!set.has(cand)) return cand;
  }
  throw new Error("no free name");
}

/** names that the VFS (and every desktop OS) cannot store */
export function badName(name: string): string | null {
  if (!name.trim()) return "The name is empty.";
  if (name === "." || name === "..") return "“.” and “..” are reserved.";
  if (/[/\\\u0000]/.test(name)) return "Names cannot contain / or \\.";
  if (name.length > 255) return "Names are limited to 255 characters.";
  return null;
}

export interface MenuItem { id: string; label: string; group: string; concise?: boolean; keywords?: string; disabled?: boolean; danger?: boolean }
/** concise = the everyday subset; full = everything. Type-to-search matches every word of the query against
 *  label + keywords (accent- and case-insensitive), in full mode, keeping the group order. */
export function menuView<T extends MenuItem>(items: T[], mode: "concise" | "full", query: string): T[] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const q = fold(query.trim());
  if (q) { const words = q.split(/\s+/); return items.filter((i) => { const hay = fold(`${i.label} ${i.keywords ?? ""}`); return words.every((w) => hay.includes(w)); }); }
  return mode === "full" ? items : items.filter((i) => i.concise);
}

/** sort used by every view: folders first, then natural (numeric-aware) name order, or by size / date */
export type SortKey = "name" | "size" | "date";
export function sortNodes<T extends { name: string; kind: string; size: number; updatedAt: string }>(nodes: T[], key: SortKey, desc = false): T[] {
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const out = [...nodes].sort((a, b) => {
    if ((a.kind === "dir") !== (b.kind === "dir")) return a.kind === "dir" ? -1 : 1;
    const c = key === "size" ? a.size - b.size : key === "date" ? Date.parse(a.updatedAt) - Date.parse(b.updatedAt) : 0;
    return (c || coll.compare(a.name, b.name)) * (desc ? -1 : 1);
  });
  return out;
}
