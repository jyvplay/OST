/**
 * TT57 — cell hyperlinks (Excel "Insert ▸ Link", Ctrl+K).
 *
 * SpreadsheetML (ECMA-376 Part 1 §18.3.1.47): a worksheet's <hyperlinks> holds <hyperlink ref r:id location tooltip
 * display>. An external target lives in the SHEET's relationship part as a hyperlink relationship with
 * TargetMode="External"; `location` is a place inside the workbook ("Sheet2!B4", a defined name) or, together with a
 * target, the fragment of that target. `ref` may be a range: every cell of it carries the link.
 *
 * The model keeps one record per <hyperlink> (ref kept as a range), so a save writes back what was read.
 * Opening is deliberately narrow: only http(s) and mailto targets ever leave the app, and a workbook location only
 * moves the selection. Everything else (file:, javascript:, UNC paths, custom schemes) is kept in the file but never
 * followed — a spreadsheet from the internet must not be able to launch things.
 */
import { evalRaw, type Sheet, type Workbook, type EvalContext } from "./engine";
import type { CellAddr, RangeAddr } from "./types";
import { rangeRef, adjustRange, parseRef } from "./sheetlayout";

export interface SheetLink {
  /** A1 cell or range the link covers. */
  ref: string;
  /** External address (URL, mailto:, relative file path). */
  target?: string;
  /** Place in this workbook ("Sheet2!A1", a defined name) or the target's fragment. */
  location?: string;
  tooltip?: string;
  /** The display string Excel recorded (informational; the cell value is what shows). */
  display?: string;
}

type R = { c0: number; r0: number; c1: number; r1: number };
const MAX_LINKS = 10000;
const clip = (s: unknown, n: number) => (typeof s === "string" && s.length ? s.slice(0, n) : undefined);
// script-like schemes: kept verbatim in a file that already has them (lossless save — Apache POI's own corpus has a
// javascript:// link), but never typed in, never opened (linkAction only follows http(s)/mailto)
const SCRIPTY = /^\s*(javascript|vbscript|data):/i;

/** Validate an untrusted link record (file or JSON); null when unusable. */
export function sanitizeLink(x: unknown): SheetLink | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, unknown>;
  const r = typeof o.ref === "string" ? parseRef(o.ref) : null;
  if (!r) return null;
  const target = clip(o.target, 2083), location = clip(o.location, 255), tooltip = clip(o.tooltip, 255), display = clip(o.display, 255);
  // Excel writes address-less records too (a tooltip-only "screen tip" on a header cell) — kept so a save loses nothing
  if (!target && !location && !tooltip && !display) return null;
  return { ref: rangeRef(r), target, location, tooltip, display };
}

const inR = (r: R, c: number, rw: number) => c >= r.c0 && c <= r.c1 && rw >= r.r0 && rw <= r.r1;

/** The link at a cell (first record wins, as Excel shows the first <hyperlink> covering a cell). */
// parsed ranges cached per links array (setLink / adjust / JSON always assign a NEW array, so identity = version);
// the grid asks once per rendered cell, so this keeps a 1,300-cell repaint at one parse per link
const parsedCache = new WeakMap<SheetLink[], (R | null)[]>();
export function linkAt(sheet: Sheet, col: number, row: number): SheetLink | undefined {
  if (!sheet.links.length) return undefined;
  let rs = parsedCache.get(sheet.links);
  if (!rs) { rs = sheet.links.map((l) => parseRef(l.ref)); parsedCache.set(sheet.links, rs); }
  for (let i = 0; i < rs.length; i++) { const r = rs[i]; if (r && inR(r, col, row)) return sheet.links[i]; }
  return undefined;
}

/**
 * Put (or with `link` null remove) a link on every cell of `range`. Existing records are split around the range so
 * cells outside it keep their link (Excel's "Remove Hyperlink" on part of a linked range does the same).
 */
export function setLink(sheet: Sheet, range: R, link: Omit<SheetLink, "ref"> | null): void {
  const out: SheetLink[] = [];
  for (const l of sheet.links) {
    const r = parseRef(l.ref);
    if (!r) continue;
    const ix = { c0: Math.max(r.c0, range.c0), r0: Math.max(r.r0, range.r0), c1: Math.min(r.c1, range.c1), r1: Math.min(r.r1, range.r1) };
    if (ix.c0 > ix.c1 || ix.r0 > ix.r1) { out.push(l); continue; }
    // up to four remainders: rows above / below the range, then the columns left / right within its rows
    const parts: R[] = [];
    if (r.r0 < ix.r0) parts.push({ c0: r.c0, r0: r.r0, c1: r.c1, r1: ix.r0 - 1 });
    if (r.r1 > ix.r1) parts.push({ c0: r.c0, r0: ix.r1 + 1, c1: r.c1, r1: r.r1 });
    if (r.c0 < ix.c0) parts.push({ c0: r.c0, r0: ix.r0, c1: ix.c0 - 1, r1: ix.r1 });
    if (r.c1 > ix.c1) parts.push({ c0: ix.c1 + 1, r0: ix.r0, c1: r.c1, r1: ix.r1 });
    for (const p of parts) out.push({ ...l, ref: rangeRef(p) });
  }
  if (link) {
    const s = sanitizeLink({ ...link, ref: rangeRef(range) });
    if (s) out.unshift(s);
  }
  sheet.links = out.slice(0, MAX_LINKS);
}

/**
 * The link a cell carries: its <hyperlink> record, else a =HYPERLINK(address, …) formula at the root of the cell
 * (the address argument is evaluated against current values, so =HYPERLINK(A1) follows A1).
 */
export function cellLink(wb: Workbook, sheetName: string, col: number, row: number): (Omit<SheetLink, "ref"> & { formula?: boolean }) | undefined {
  const sheet = wb.sheets.get(sheetName);
  if (!sheet) return undefined;
  const l = linkAt(sheet, col, row);
  if (l) return l;
  const f = sheet.grid.get(`${col},${row}`)?.formula;
  if (!f || f.t !== "call" || f.name.replace(/^_xlfn\./i, "").toUpperCase() !== "HYPERLINK" || !f.args.length) return undefined;
  const sheetOf = (a: CellAddr) => a.sheet ?? sheetName;
  const ctx: EvalContext = {
    resolveRef: (a: CellAddr) => wb.valueAt(sheetOf(a), a.col, a.row) ?? "",
    resolveRange: (rg: RangeAddr) => [[wb.valueAt(sheetOf(rg.from), rg.from.col, rg.from.row) ?? ""]],
    cursor: { sheet: sheetName, col, row },
  };
  let v: unknown;
  try { v = evalRaw(f.args[0], ctx); } catch { return undefined; }
  if (Array.isArray(v)) v = (v as unknown[][])[0]?.[0];
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const a = parseAddress(String(v));
  return a ? { ...a, formula: true } : undefined;
}

/** What clicking the link does: open an address, jump inside the workbook, or nothing (unsafe / unsupported). */
export type LinkAction = { kind: "url"; url: string } | { kind: "place"; sheet?: string; ref: string } | { kind: "none"; why: string };

export function linkAction(l: Pick<SheetLink, "target" | "location">, sheetNames: string[]): LinkAction {
  if (l.target) {
    const t = l.target.trim();
    const url = l.location ? `${t}#${l.location}` : t;
    if (/^https?:\/\/[^\s]+$/i.test(t)) return { kind: "url", url };
    if (/^mailto:[^\s]+$/i.test(t)) return { kind: "url", url: t };
    return { kind: "none", why: `Links to "${t.slice(0, 60)}" are kept in the file but not opened here (only web and e-mail addresses are).` };
  }
  const loc = (l.location ?? "").trim();
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)$/.exec(loc);
  if (m) {
    const name = (m[1] ?? m[2]).replace(/''/g, "'");
    const sheet = sheetNames.find((s) => s.toLowerCase() === name.toLowerCase());
    if (!sheet) return { kind: "none", why: `Reference isn't valid: there is no sheet named "${name}".` };
    return { kind: "place", sheet, ref: m[3].replace(/\$/g, "").toUpperCase() };
  }
  if (/^\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/.test(loc)) return { kind: "place", ref: loc.replace(/\$/g, "").toUpperCase() };
  return { kind: "none", why: loc ? `"${loc.slice(0, 60)}" is not a cell reference in this workbook.` : "This link has no address." };
}

/** User-typed address → target/location ("Sheet2!A1" and "#Sheet2!A1" are places; "example.com" gets https://). */
export function parseAddress(raw: string): { target?: string; location?: string } | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith("#")) return s.length > 1 ? { location: s.slice(1) } : null;
  if (/^(?:'(?:[^']|'')+'|[^!:/\s]+)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/.test(s)) return { location: s };
  if (SCRIPTY.test(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return { target: s };
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { target: `mailto:${s}` };
  if (/^[^\s/]+\.[^\s/]+/.test(s)) return { target: `https://${s}` };
  return null;
}

/* ------------------------------------------------------------------ xlsx */
const dec = (s: string) => s.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-fA-F]+));/g, (_m, n: string, d?: string, h?: string) => d ? String.fromCodePoint(Number(d)) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" } as Record<string, string>)[n]);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attrsOf = (s: string) => { const o: Record<string, string> = {}; for (const m of s.matchAll(/([\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) o[m[1]] = dec(m[2] ?? m[3] ?? ""); return o; };

/** Read a worksheet's <hyperlinks>; `relsXml` is that sheet's relationship part (or ""). */
export function readLinks(sheetXml: string, relsXml: string): SheetLink[] {
  const block = /<(?:\w+:)?hyperlinks\b[^>]*>([\s\S]*?)<\/(?:\w+:)?hyperlinks>/.exec(sheetXml)?.[1];
  if (!block) return [];
  const rels = new Map<string, Record<string, string>>();
  for (const m of relsXml.matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) { const a = attrsOf(m[1]); if (a.Id) rels.set(a.Id, a); }
  const out: SheetLink[] = [];
  for (const m of block.matchAll(/<(?:\w+:)?hyperlink\b([^>]*?)\/?>/g)) {
    const a = attrsOf(m[1]);
    const rid = Object.entries(a).find(([k]) => /(^|:)id$/.test(k) && k.includes(":"))?.[1];
    const rel = rid ? rels.get(rid) : undefined;
    const l = sanitizeLink({ ref: a.ref, target: rel && /\/hyperlink$/.test(rel.Type ?? "") ? rel.Target : undefined, location: a.location, tooltip: a.tooltip, display: a.display });
    if (l && out.length < MAX_LINKS) out.push(l);
  }
  return out;
}

export const REL_HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

/** <hyperlinks> markup plus the relationships it needs; ids come from `nextId` so they never collide with a part's own. */
export function linksXml(links: SheetLink[], nextId: () => string, prefix = ""): { xml: string; rels: string[] } {
  if (!links.length) return { xml: "", rels: [] };
  const rels: string[] = [];
  const items = links.map((l) => {
    let rid = "";
    if (l.target) { rid = nextId(); rels.push(`<Relationship Id="${rid}" Type="${REL_HYPERLINK}" Target="${esc(l.target)}" TargetMode="External"/>`); }
    return `<${prefix}hyperlink ref="${esc(l.ref)}"${rid ? ` r:id="${rid}"` : ""}${l.location ? ` location="${esc(l.location)}"` : ""}${l.tooltip ? ` tooltip="${esc(l.tooltip)}"` : ""}${l.display ? ` display="${esc(l.display)}"` : ""}/>`;
  });
  return { xml: `<${prefix}hyperlinks>${items.join("")}</${prefix}hyperlinks>`, rels };
}
