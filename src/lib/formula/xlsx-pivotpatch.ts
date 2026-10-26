/**
 * TT63 — PivotTable parts in the LOSSLESS .xlsx save (xlsx-patch.ts). Original code.
 *
 * The package may hold PivotTables of two kinds:
 *   • OURS — a table whose (sheet, name) matches a definition this app loaded from the `_FusionPivot` names AND whose
 *     rowFields / colFields / dataFields / source ref still equal that loaded definition (so nobody re-pivoted it in
 *     Excel since). Ours are regenerated in place (same part names, same cacheId) when the workbook changed, removed
 *     when the user deleted the pivot, and created for pivots that have no part yet;
 *   • NATIVE — everything else (an Excel-made pivot, or one of ours that was re-pivoted in Excel). Native tables and
 *     their caches are never touched; a new pivot whose name collides with a native one gets "Name (2)".
 * A cache shared with another table is never rewritten: our table then gets a cache of its own.
 */
import { parseXml, serializeXml, attr, kids, el, decText, type XDoc, type XEl } from "../office/xmltree";
import { resolvePart } from "./chartxml";
import { pivotPartsFor, uniquePivotName, relTarget, CT_PIVOT_CACHE, CT_PIVOT_RECORDS, CT_PIVOT_TABLE, REL_PIVOT_CACHE, REL_PIVOT_RECORDS, REL_PIVOT_TABLE, type PivotSaveNote } from "./pivotxml";
import type { Workbook } from "./engine";
import type { PivotDef } from "./pivotsheet";

export interface PivotPatchIO {
  read(part: string): Promise<string | null>;
  exists(part: string): boolean;
  write(part: string, xml: string): void;
  remove(part: string): void;
  override(part: string, contentType: string | null): void;
  sheetPartNow(name: string): string | undefined;
}
/** the workbook-level <pivotCaches> list (cacheId → cache definition part) */
export interface PivotCacheBook { caches(): { id: number; part: string }[]; add(id: number, part: string): void; remove(id: number): void }
export interface PivotPatchReport { parts: string[]; written: number; removed: number; notes: PivotSaveNote[] }

const relsPathOf = (part: string) => { const i = part.lastIndexOf("/"); return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`; };
const RELS_EMPTY = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;
const head = (x: string) => /<(?:[\w.-]+:)?pivotTableDefinition\b[^>]*>/.exec(x)?.[0] ?? "";
const attrOf = (tag: string, name: string) => { const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag); return m ? decText(m[1] ?? m[2]) : undefined; };
const fieldList = (x: string, list: string) => { const m = new RegExp(`<(?:[\\w.-]+:)?${list}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${list}>`).exec(x); return m ? [...m[1].matchAll(/<(?:[\w.-]+:)?field\b[^>]*\sx\s*=\s*"(-?\d+)"/g)].map((k) => Number(k[1])).filter((n) => n >= 0) : []; };
const dataFlds = (x: string) => [...x.matchAll(/<(?:[\w.-]+:)?dataField\b[^>]*>/g)].map((m) => Number(attrOf(m[0], "fld") ?? -1));

/** does a table (+ its cache) still describe the definition this app loaded? (false = re-pivoted outside → native) */
export function stillOurs(tableXml: string, cacheXml: string | null, d: PivotDef): boolean {
  const vals = d.spec.values.length ? d.spec.values.map((v) => v.field) : [d.spec.rows[0] ?? d.spec.cols[0]];
  const eq = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  const ws = cacheXml ? /<(?:[\w.-]+:)?worksheetSource\b[^>]*>/.exec(cacheXml)?.[0] ?? "" : "";
  return eq(fieldList(tableXml, "rowFields"), d.spec.rows) && eq(fieldList(tableXml, "colFields"), d.spec.cols) && eq(dataFlds(tableXml), vals)
    && (attrOf(ws, "ref") ?? "").toUpperCase() === d.src.ref.toUpperCase();
}

interface Existing { sheet: string; sheetPart: string; rel: XEl; table: string; name: string; cacheId: number; ours?: PivotDef }

export async function patchPivots(io: PivotPatchIO, book: PivotCacheBook, orig: Workbook, now: Workbook, renames: Record<string, string>): Promise<PivotPatchReport> {
  const rep: PivotPatchReport = { parts: [], written: 0, removed: 0, notes: [] };
  const docs = new Map<string, XDoc>(); const touched = new Set<string>();
  const load = async (p: string, fallback?: string) => { let d = docs.get(p); if (!d) { const x = (await io.read(p)) ?? fallback; if (x === undefined) return undefined; d = parseXml(x); docs.set(p, d); } return d; };
  const relEl = (rels: XDoc, a: Record<string, string>) => { const e = el(rels.root.name.replace(/Relationships$/, "Relationship"), a); rels.root.kids.push(e); rels.root.selfClose = false; return e; };
  const freeRid = (rels: XDoc) => { let i = 1; while (kids(rels.root).some((r) => attr(r, "Id") === `rId${i}`)) i++; return `rId${i}`; };
  const claimed = new Set<string>();
  const freePart = (stem: string) => { let n = 1; while (io.exists(`${stem}${n}.xml`) || claimed.has(`${stem}${n}.xml`.toLowerCase())) n++; const p = `${stem}${n}.xml`; claimed.add(p.toLowerCase()); return p; };
  const cachePart = (id: number) => book.caches().find((c) => c.id === id)?.part;

  // a part name that an existing relationship points at is taken even when the part is missing (dangling rels exist
  // in real files: a cache whose records part was dropped must not silently adopt OUR records)
  const claimTargets = (from: string, rels: XDoc | undefined) => { for (const r of kids(rels?.root)) if (attr(r, "TargetMode") !== "External") claimed.add(resolvePart(from, attr(r, "Target") ?? "").toLowerCase()); };
  for (const c of book.caches()) if (c.part && io.exists(relsPathOf(c.part))) claimTargets(c.part, await load(relsPathOf(c.part)));
  // 1. the tables in the package, on the sheets that still exist
  const existing: Existing[] = [];
  for (const sh of now.sheets.values()) {
    const sp = io.sheetPartNow(sh.name); if (!sp) continue;
    if (!io.exists(relsPathOf(sp))) continue;
    const rels = await load(relsPathOf(sp)); if (!rels) continue;
    claimTargets(sp, rels);
    for (const r of kids(rels.root)) {
      if (!(attr(r, "Type") ?? "").endsWith("/pivotTable") || attr(r, "TargetMode") === "External") continue;
      const table = resolvePart(sp, attr(r, "Target") ?? ""); const x = await io.read(table); if (!x) continue;
      const h = head(x); if (io.exists(relsPathOf(table))) claimTargets(table, await load(relsPathOf(table)));
      const e: Existing = { sheet: sh.name, sheetPart: sp, rel: r, table, name: attrOf(h, "name") ?? "", cacheId: Number(attrOf(h, "cacheId") ?? -1) };
      const od = orig.sheets.get(renames[sh.name] ?? sh.name)?.pivots.find((p) => p.name === e.name);
      if (od) { const cp = cachePart(e.cacheId); if (stillOurs(x, cp ? await io.read(cp) : null, od)) e.ours = od; }
      existing.push(e);
    }
  }
  const refs = (id: number) => existing.filter((e) => e.cacheId === id).length;

  const dropCache = async (id: number) => {
    const cp = cachePart(id); book.remove(id); if (!cp) return;
    const crels = io.exists(relsPathOf(cp)) ? await load(relsPathOf(cp)) : undefined;
    for (const r of kids(crels?.root)) if ((attr(r, "Type") ?? "").endsWith("/pivotCacheRecords")) { const rp = resolvePart(cp, attr(r, "Target") ?? ""); io.remove(rp); io.override(rp, null); rep.parts.push(rp); }
    if (crels) { io.remove(relsPathOf(cp)); docs.delete(relsPathOf(cp)); touched.delete(relsPathOf(cp)); }
    io.remove(cp); io.override(cp, null); rep.parts.push(cp);
  };
  const dropTable = async (e: Existing) => {
    const srels = (await load(relsPathOf(e.sheetPart)))!;
    srels.root.kids = srels.root.kids.filter((k) => k !== e.rel); touched.add(relsPathOf(e.sheetPart));
    io.remove(e.table); io.override(e.table, null); if (io.exists(relsPathOf(e.table))) io.remove(relsPathOf(e.table));
    existing.splice(existing.indexOf(e), 1); rep.parts.push(e.table); rep.removed++;
    if (e.cacheId >= 0 && !refs(e.cacheId)) await dropCache(e.cacheId);
  };

  // 2. every current definition: regenerate ours in place, add the missing ones
  const matched = new Set<Existing>();
  for (const sh of now.sheets.values()) {
    const sp = io.sheetPartNow(sh.name); if (!sp) continue;
    const taken = new Set(existing.filter((e) => e.sheet === sh.name && !e.ours).map((e) => e.name.toLowerCase()));
    for (const d of sh.pivots) {
      const ex = existing.find((e) => e.sheet === sh.name && e.ours && e.name === d.name && !matched.has(e));
      const name = ex ? ex.name : uniquePivotName(d.name, taken);
      if (ex) { taken.add(name.toLowerCase()); matched.add(ex); }
      // the cache: ours alone → reuse its part and id; shared or missing → a new cache
      let cacheId: number, cp: string | undefined, newCache = false;
      if (ex && refs(ex.cacheId) === 1 && (cp = cachePart(ex.cacheId))) cacheId = ex.cacheId;
      else { cacheId = Math.max(0, ...book.caches().map((c) => c.id), ...existing.map((e) => e.cacheId)) + 1; cp = freePart("xl/pivotCache/pivotCacheDefinition"); newCache = true; }
      const crels = (await load(relsPathOf(cp!), RELS_EMPTY))!;
      let recRel = kids(crels.root).find((r) => (attr(r, "Type") ?? "").endsWith("/pivotCacheRecords"));
      // Excel's convention pairs pivotCacheRecordsN with pivotCacheDefinitionN; keep it whenever that name is free
      const pairNo = /pivotCacheDefinition(\d+)\.xml$/i.exec(cp!)?.[1], paired = pairNo && `xl/pivotCache/pivotCacheRecords${pairNo}.xml`;
      const recPart = recRel ? resolvePart(cp!, attr(recRel, "Target") ?? "") : paired && !io.exists(paired) && !claimed.has(paired.toLowerCase()) ? (claimed.add(paired.toLowerCase()), paired) : freePart("xl/pivotCache/pivotCacheRecords");
      const rid = recRel ? attr(recRel, "Id")! : freeRid(crels);
      const r = pivotPartsFor(now, sh, d, cacheId, { name, recordsRid: rid });
      if (!r.ok) {
        rep.notes.push({ sheet: sh.name, name: d.name, native: false, why: r.why });
        if (ex) await dropTable(ex); // a stale table would contradict the cells: the values (and the definition names) remain
        continue;
      }
      if (!recRel) { recRel = relEl(crels, { Id: rid, Type: REL_PIVOT_RECORDS, Target: relTarget(cp!, recPart) }); touched.add(relsPathOf(cp!)); }
      if (newCache) { book.add(cacheId, cp!); io.override(cp!, CT_PIVOT_CACHE); touched.add(relsPathOf(cp!)); }
      io.write(cp!, r.parts.cacheXml); io.write(recPart, r.parts.recordsXml); io.override(recPart, CT_PIVOT_RECORDS);
      let table = ex?.table;
      if (!table) {
        table = freePart("xl/pivotTables/pivotTable");
        const srels = (await load(relsPathOf(sp), RELS_EMPTY))!;
        relEl(srels, { Id: freeRid(srels), Type: REL_PIVOT_TABLE, Target: relTarget(sp, table) }); touched.add(relsPathOf(sp));
        io.override(table, CT_PIVOT_TABLE);
      }
      // the table → cache relationship (rewritten when the table moved to a cache of its own)
      const trels = (await load(relsPathOf(table), RELS_EMPTY))!;
      trels.root.kids = trels.root.kids.filter((k) => !(k.k === "el" && (attr(k, "Type") ?? "").endsWith("/pivotCacheDefinition")));
      relEl(trels, { Id: freeRid(trels), Type: REL_PIVOT_CACHE, Target: relTarget(table, cp!) }); touched.add(relsPathOf(table));
      io.write(table, r.parts.tableXml);
      rep.parts.push(cp!, recPart, table); rep.written++;
      rep.notes.push({ sheet: sh.name, name: r.parts.name, native: true });
      if (ex && newCache) ex.cacheId = cacheId;
    }
  }
  // 3. ours that the user deleted
  for (const e of [...existing]) if (e.ours && !matched.has(e)) await dropTable(e);
  for (const p of touched) { const d = docs.get(p); if (d) { io.write(p, serializeXml(d)); rep.parts.push(p); } }
  rep.parts = [...new Set(rep.parts)];
  return rep;
}
