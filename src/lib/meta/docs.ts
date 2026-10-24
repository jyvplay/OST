/**
 * TT54 (FF-13) — document metadata: PDF (the TT52 engine: trailer /Info, catalog /Metadata XMP, page count,
 * first-page size, encryption), OOXML (docProps/core.xml Dublin Core + app.xml statistics + the embedded
 * thumbnail the package relationship names), ODF (meta.xml + Thumbnails/thumbnail.png), EPUB (OPF dc:*).
 * Zip access goes through office/zipkit (bounded inflate), XML through a namespace-agnostic local-name match.
 */
import { openZip } from "../office/zipkit";
import { PdfDoc, PasswordRequired } from "../pdf/pdfdoc";
import { isDict, isStream, textString, type PObj } from "../pdf/pdfobj";
import { readXmp, unescapeXml } from "./xmp";

export interface DocInfo {
  format: string; mime: string;
  pages?: number; words?: number; slides?: number; sheets?: number; lines?: number; characters?: number;
  pageSize?: { w: number; h: number; unit: "pt" };
  encrypted?: boolean;
  tags: Record<string, string>;
  thumbnail?: { mime: string; data: Uint8Array };
  warnings: string[];
}

/** PDF date "D:YYYYMMDDHHmmSSOHH'mm'" -> ISO-8601 (missing parts default as §7.9.4 says) */
export function pdfDate(s: string): string | undefined {
  const m = s.trim().match(/^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*([Zz+-])?\s*(\d{2})?'?\s*(\d{2})?'?/);
  if (!m) return undefined;
  const [, y, mo = "01", d = "01", h = "00", mi = "00", se = "00", z, oh, om] = m;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +se > 59) return undefined;
  const off = !z ? "" : z === "Z" || z === "z" ? "Z" : `${z}${oh ?? "00"}:${om ?? "00"}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${se}${off}`;
}

const INFO_KEYS: [string, string][] = [["Title", "title"], ["Author", "creator"], ["Subject", "subject"], ["Keywords", "keywords"], ["Creator", "application"], ["Producer", "producer"]];

export function readPdfMeta(b: Uint8Array): DocInfo {
  const out: DocInfo = { format: "pdf", mime: "application/pdf", tags: {}, warnings: [] };
  let doc: PdfDoc;
  try { doc = PdfDoc.open(b); } catch (e) { if (e instanceof PasswordRequired) out.encrypted = true; else out.warnings.push(`pdf: ${(e as Error).message}`); return out; }
  if (doc.trailer.has("Encrypt")) out.encrypted = true;
  try { const pages = doc.pages(); out.pages = pages.length; const p = pages[0]; if (p) { const [x0, y0, x1, y1] = p.crop; let w = Math.abs(x1 - x0), h = Math.abs(y1 - y0); if (p.rotate % 180) [w, h] = [h, w]; out.pageSize = { w: Math.round(w * 100) / 100, h: Math.round(h * 100) / 100, unit: "pt" }; } }
  catch (e) { out.warnings.push(`pdf pages: ${(e as Error).message}`); }
  const info = doc.resolve(doc.trailer.get("Info")) as PObj | undefined;
  if (isDict(info)) {
    for (const [k, t] of INFO_KEYS) { const v = textString(doc.resolve(info.get(k)) as PObj); if (v && v.trim()) out.tags[t] = v.trim(); }
    for (const [k, t] of [["CreationDate", "created"], ["ModDate", "modified"]] as const) { const v = textString(doc.resolve(info.get(k)) as PObj); const iso = v ? pdfDate(v) : undefined; if (iso) out.tags[t] = iso; }
  }
  try {
    const md = doc.resolve(doc.catalog()?.get("Metadata")) as PObj | undefined;
    if (isStream(md)) {
      const raw = doc.decode(md).data; const x = readXmp(new TextDecoder().decode(raw));
      if (!out.tags.title && x["dc:title"]) out.tags.title = x["dc:title"];
      if (!out.tags.creator && x["dc:creator"]) out.tags.creator = x["dc:creator"];
      if (!out.tags.description && x["dc:description"]) out.tags.description = x["dc:description"];
    }
  } catch (e) { out.warnings.push(`pdf xmp: ${(e as Error).message}`); }
  return out;
}

const local = (xml: string, name: string): string | undefined => {
  const m = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`));
  if (!m) return undefined; const v = unescapeXml(m[1].replace(/<[^>]+>/g, "")).trim(); return v || undefined;
};

const OOXML_MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export async function readZipDocMeta(b: Uint8Array): Promise<DocInfo | null> {
  let z; try { z = openZip(b); } catch { return null; }
  const names = new Set(z.entries.map((e) => e.name));
  if (names.has("[Content_Types].xml")) {
    const ct = (await z.readText("[Content_Types].xml")) ?? "";
    const format = /wordprocessingml\.document\.main|word\/document\.xml/.test(ct) ? "docx" : /spreadsheetml\.sheet\.main|xl\/workbook\.xml/.test(ct) ? "xlsx" : /presentationml\.presentation\.main|ppt\/presentation\.xml/.test(ct) ? "pptx" : null;
    if (!format) return null;
    const out: DocInfo = { format, mime: OOXML_MIME[format], tags: {}, warnings: [] };
    const rels = (await z.readText("_rels/.rels")) ?? "";
    const target = (type: string) => { const m = rels.match(new RegExp(`<Relationship\\b[^>]*Type="[^"]*/${type}"[^>]*>`)); const t = m?.[0].match(/Target="([^"]+)"/)?.[1]; return t ? t.replace(/^\//, "") : undefined; };
    const core = await z.readText(target("metadata/core-properties") ?? "docProps/core.xml");
    if (core) {
      for (const [n, k] of [["title", "title"], ["subject", "subject"], ["creator", "creator"], ["keywords", "keywords"], ["description", "description"], ["lastModifiedBy", "lastModifiedBy"], ["revision", "revision"], ["created", "created"], ["modified", "modified"], ["category", "category"]] as const) {
        const v = local(core, n); if (v) out.tags[k] = v;
      }
    }
    const app = await z.readText(target("extended-properties") ?? "docProps/app.xml");
    if (app) {
      const num = (n: string) => { const v = local(app, n); return v && /^\d+$/.test(v) ? +v : undefined; };
      const a = local(app, "Application"); if (a) out.tags.application = a + (local(app, "AppVersion") ? ` ${local(app, "AppVersion")}` : "");
      const co = local(app, "Company"); if (co) out.tags.company = co;
      out.pages = num("Pages"); out.words = num("Words"); out.slides = num("Slides"); out.characters = num("Characters");
      if (format === "xlsx") { const t = app.match(/<(?:\w+:)?TitlesOfParts>[\s\S]*?<\/(?:\w+:)?TitlesOfParts>/)?.[0]; const n = t ? (t.match(/<(?:\w+:)?lpstr>/g) ?? []).length : 0; if (n) out.sheets = n; }
    }
    if (format === "xlsx" && !out.sheets) { const wb = (await z.readText("xl/workbook.xml")) ?? ""; out.sheets = (wb.match(/<(?:\w+:)?sheet\b/g) ?? []).length || undefined; }
    if (format === "pptx" && !out.slides) out.slides = [...names].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length || undefined;
    const th = target("metadata/thumbnail");
    if (th && names.has(th)) { const d = await z.read(th); if (d) out.thumbnail = { mime: /\.png$/i.test(th) ? "image/png" : /\.wmf$/i.test(th) ? "image/wmf" : /\.emf$/i.test(th) ? "image/emf" : "image/jpeg", data: d }; }
    return out;
  }
  if (names.has("mimetype")) {
    const mt = ((await z.readText("mimetype")) ?? "").trim();
    if (mt === "application/epub+zip") {
      const out: DocInfo = { format: "epub", mime: mt, tags: {}, warnings: [] };
      const cont = (await z.readText("META-INF/container.xml")) ?? ""; const opfPath = cont.match(/full-path="([^"]+)"/)?.[1];
      const opf = opfPath ? (await z.readText(opfPath)) ?? "" : "";
      for (const [n, k] of [["title", "title"], ["creator", "creator"], ["language", "language"], ["publisher", "publisher"], ["date", "created"], ["description", "description"]] as const) { const v = local(opf, n); if (v) out.tags[k] = v; }
      return out;
    }
    if (mt.startsWith("application/vnd.oasis.opendocument.")) {
      const kind = mt.split(".").pop()!; const format = ({ text: "odt", spreadsheet: "ods", presentation: "odp", graphics: "odg" } as Record<string, string>)[kind] ?? kind;
      const out: DocInfo = { format, mime: mt, tags: {}, warnings: [] };
      const meta = (await z.readText("meta.xml")) ?? "";
      for (const [n, k] of [["title", "title"], ["subject", "subject"], ["initial-creator", "creator"], ["creator", "lastModifiedBy"], ["keyword", "keywords"], ["description", "description"], ["creation-date", "created"], ["date", "modified"], ["generator", "application"]] as const) { const v = local(meta, n); if (v) out.tags[k] = v; }
      const st = meta.match(/<meta:document-statistic\b[^>]*>/)?.[0] ?? "";
      const at = (a: string) => { const v = st.match(new RegExp(`meta:${a}="(\\d+)"`))?.[1]; return v ? +v : undefined; };
      out.pages = at("page-count"); out.words = at("word-count"); out.sheets = at("table-count") && format === "ods" ? at("table-count") : undefined; out.characters = at("character-count");
      if (names.has("Thumbnails/thumbnail.png")) { const d = await z.read("Thumbnails/thumbnail.png"); if (d) out.thumbnail = { mime: "image/png", data: d }; }
      return out;
    }
  }
  return null;
}

/** UTF-8 text statistics (≤ 4 MiB; anything larger reports size only) */
export function readText(b: Uint8Array): DocInfo | null {
  if (b.length > 4 << 20) return null;
  let s: string; try { s = new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { return null; }
  if (/[\x00-\x08\x0e-\x1f]/.test(s.slice(0, 8192))) return null;
  const lines = s.length ? s.split(/\r\n|\r|\n/).length - (/(\r\n|\r|\n)$/.test(s) ? 1 : 0) : 0;
  const words = (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) ?? []).length;
  return { format: "text", mime: "text/plain", lines, words, characters: [...s].length, tags: {}, warnings: [] };
}
