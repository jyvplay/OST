/**
 * TT52 — PDF editing (ISO 32000-2 §7.5.6 incremental updates, §7.7.3 page tree, §12.5 annotations, §12.7 forms).
 * Original code from the specification.
 *
 * save()      — incremental update: the original bytes are kept verbatim as a prefix; changed + new objects and a new
 *               cross-reference section (an xref stream when the file's last section is one, else a classic table) are
 *               appended. Encrypted files stay encrypted: new/changed strings and streams are encrypted with the file key.
 * saveClean() — full rewrite of the objects reachable from the trailer (drops deleted pages, old revisions, orphans):
 *               the privacy option after deleting content. Encryption is kept (re-encrypted under the new numbering).
 * Operations: rotate / delete / reorder / insert blank pages, import (merge) pages from another document, extract pages
 * into a new document, annotations with generated appearance streams (Highlight, Underline, StrikeOut, Ink, Square,
 * Circle, FreeText, Text), annotation removal, AcroForm field filling with appearance generation, document info.
 */
import { N, PDict, PRef, PStr, PStream, fmtNum, isArr, isDict, isName, isNum, isRef, isStream, latin1ToBytes, makeText, serialize, textString, type PObj, type Bytes } from "./pdfobj";
import { PdfDoc } from "./pdfdoc";
import { helvWidth, wrap, winAnsiBytes, pdfLiteral } from "./pdftextfit";

const enc = new TextEncoder();
const concatBytes = (parts: Bytes[]) => { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
function pdfDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0"); const tz = -d.getTimezoneOffset(); const s = tz >= 0 ? "+" : "-"; const a = Math.abs(tz);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${s}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
}
function randomBytes(n: number) { const b = new Uint8Array(n); (globalThis.crypto as Crypto).getRandomValues(b); return b; }

const helvFontDict = () => new PDict().set("Type", N("Font")).set("Subtype", N("Type1")).set("BaseFont", N("Helvetica")).set("Encoding", N("WinAnsiEncoding"));

export interface AnnotSpec {
  type: "Highlight" | "Underline" | "StrikeOut" | "Squiggly" | "Ink" | "Square" | "Circle" | "FreeText" | "Text";
  /** user-space rectangles (Highlight/Underline/StrikeOut: one per marked line) */
  rects?: number[][];
  /** Ink strokes: arrays of [x, y, x, y, …] */
  ink?: number[][];
  rect?: number[];
  color?: [number, number, number];
  opacity?: number; width?: number;
  contents?: string; author?: string; fontSize?: number;
}

export class PdfEditor {
  readonly doc: PdfDoc;
  private changed = new Map<number, PObj>();
  private gens = new Map<number, number>();
  private next: number;
  private pageOrder: PRef[] | null = null;
  private pageDicts = new Map<number, PDict>();
  private trailerInfo: PRef | null | undefined = undefined;

  constructor(doc: PdfDoc) {
    this.doc = doc;
    const size = doc.num(doc.trailer.get("Size"), 0);
    this.next = Math.max(doc.maxObj + 1, size, 1);
  }
  /** allocate a new indirect object */
  add(o: PObj): PRef { const n = this.next++; this.changed.set(n, o); this.gens.set(n, 0); return new PRef(n, 0); }
  /** replace (or set) the object with this number */
  put(num: number, o: PObj) { this.changed.set(num, o); if (!this.gens.has(num)) this.gens.set(num, this.doc.genOf(num)); }
  get(o: PObj | undefined): PObj | undefined { if (isRef(o) && this.changed.has(o.num)) return this.changed.get(o.num); return this.doc.resolve(o); }
  dict(o: PObj | undefined): PDict | null { const r = this.get(o); return isDict(r) ? r : isStream(r) ? r.dict : null; }
  get dirty() { return this.changed.size > 0 || this.pageOrder !== null; }

  /** a writable copy of an indirect dictionary (copy-on-write) */
  private edit(ref: PRef): PDict {
    const cur = this.get(ref); if (!isDict(cur)) throw new Error(`object ${ref.num} is not a dictionary`);
    if (this.changed.has(ref.num)) return cur;
    const cp = new PDict(); for (const [k, v] of cur.m) cp.set(k, v); this.put(ref.num, cp); return cp;
  }

  /* -------------------------------------------------------------- pages */
  pageRefs(): PRef[] {
    if (this.pageOrder) return this.pageOrder;
    return this.doc.pages().map((p) => { if (!p.ref) throw new Error("pdf: page without an object reference cannot be edited"); return p.ref; });
  }
  pageCount() { return this.pageRefs().length; }
  /** flatten the page tree: every page gets its inherited attributes and becomes a direct kid of the root /Pages */
  private flatten() {
    if (this.pageOrder) return;
    const pages = this.doc.pages();
    for (const p of pages) {
      if (!p.ref) throw new Error("pdf: page without an object reference cannot be edited");
      const d = this.edit(p.ref);
      if (!d.has("Resources") && p.resources) d.set("Resources", p.resources);
      if (!d.has("MediaBox")) d.set("MediaBox", p.media.slice());
      if (!d.has("CropBox") && (p.crop[0] !== p.media[0] || p.crop[1] !== p.media[1] || p.crop[2] !== p.media[2] || p.crop[3] !== p.media[3])) d.set("CropBox", p.crop.slice());
      if (p.rotate) d.set("Rotate", p.rotate);
      this.pageDicts.set(p.ref.num, d);
    }
    this.pageOrder = pages.map((p) => p.ref!);
  }
  private commitPages() {
    if (!this.pageOrder) return;
    const cat = this.doc.catalog()!; const rootRef = cat.get("Pages");
    const kids = this.pageOrder.slice();
    const rootDict = new PDict().set("Type", N("Pages")).set("Kids", kids).set("Count", kids.length);
    let rref: PRef;
    // a damaged tree can list the root node itself (or another /Pages node) as a page: never reuse such a number
    const clash = isRef(rootRef) && kids.some((k) => k.num === rootRef.num);
    for (const k of kids) { const d = this.pageDicts.get(k.num) ?? this.edit(k); if (d.has("Kids")) { d.set("Kids", undefined); d.set("Count", undefined); } d.set("Type", N("Page")); }
    if (isRef(rootRef) && !clash) { rref = rootRef; this.put(rootRef.num, rootDict); }
    else { rref = this.add(rootDict); this.editCatalog().set("Pages", rref); }
    for (const k of kids) { const d = this.pageDicts.get(k.num) ?? this.edit(k); d.set("Parent", rref); }
  }
  private editCatalog(): PDict { const r = this.doc.trailer.get("Root"); if (!isRef(r)) throw new Error("pdf: catalog is not an indirect object"); return this.edit(r); }
  rotate(index: number, delta: number) {
    const ref = this.pageRefs()[index]; if (!ref) throw new RangeError("no such page");
    this.flatten(); const d = this.pageDicts.get(ref.num)!; const cur = this.doc.num(d.get("Rotate"), 0);
    d.set("Rotate", ((((cur + delta) % 360) + 360) % 360));
  }
  deletePages(indices: number[]) {
    this.flatten(); const del = new Set(indices);
    if (del.size >= this.pageOrder!.length) throw new Error("a PDF must keep at least one page");
    this.pageOrder = this.pageOrder!.filter((_, i) => !del.has(i));
  }
  /** new order: a permutation (or subset) of current indices */
  reorder(order: number[]) {
    this.flatten(); const cur = this.pageOrder!;
    if (order.some((i) => i < 0 || i >= cur.length) || new Set(order).size !== order.length || !order.length) throw new Error("invalid page order");
    this.pageOrder = order.map((i) => cur[i]);
  }
  movePage(from: number, to: number) { const n = this.pageRefs().length; const o = [...Array(n).keys()]; const [x] = o.splice(from, 1); o.splice(to, 0, x); this.reorder(o); }
  insertBlank(at: number, w = 612, h = 792) {
    this.flatten();
    const content = this.add(new PStream(new PDict().set("Length", 0), new Uint8Array(0)));
    const d = new PDict().set("Type", N("Page")).set("MediaBox", [0, 0, w, h]).set("Resources", new PDict()).set("Contents", content);
    const ref = this.add(d); this.pageDicts.set(ref.num, d);
    this.pageOrder!.splice(Math.max(0, Math.min(at, this.pageOrder!.length)), 0, ref);
    return ref;
  }
  /** deep-copy pages of another document into this one (merge) */
  importPages(src: PdfDoc, indices: number[], at = this.pageRefs().length) {
    this.flatten();
    const map = new Map<number, PRef>(); const queue: [number, PRef][] = [];
    const refFor = (num: number): PRef => { let r = map.get(num); if (!r) { r = new PRef(this.next++, 0); this.gens.set(r.num, 0); map.set(num, r); queue.push([num, r]); } return r; };
    const copy = (o: PObj | undefined, depth = 0): PObj => {
      if (depth > 200) return null;
      if (o instanceof PRef) return src.xref.has(o.num) ? refFor(o.num) : null;
      if (Array.isArray(o)) return o.map((x) => copy(x, depth + 1));
      if (o instanceof PDict) { const d = new PDict(); for (const [k, v] of o.m) d.set(k, copy(v, depth + 1)); return d; }
      if (o instanceof PStream) { const d = copy(o.dict, depth + 1) as PDict; return new PStream(d, o.raw); }
      if (o instanceof PStr) return new PStr(o.b, o.hex);
      return o ?? null;
    };
    const srcPages = src.pages(); const newRefs: PRef[] = [];
    for (const i of indices) {
      const p = srcPages[i]; if (!p) continue;
      const d = new PDict();
      for (const [k, v] of p.dict.m) { if (k === "Parent" || k === "StructParents" || k === "B" || k === "Annots") continue; d.set(k, copy(v)); }
      d.set("Resources", copy(p.resources ?? new PDict())); d.set("MediaBox", p.media.slice());
      if (p.crop.join() !== p.media.join()) d.set("CropBox", p.crop.slice());
      if (p.rotate) d.set("Rotate", p.rotate);
      // annotations: copy, but drop form widgets (their fields belong to the source AcroForm) and Popup back-links stay
      const annots = src.arr(p.dict.get("Annots")).filter((a) => { const ad = src.dict(a); return ad && !isName(src.resolve(ad.get("Subtype")), "Widget"); });
      const ref = this.add(d); this.pageDicts.set(ref.num, d);
      if (annots.length) d.set("Annots", annots.map((a) => { const c = copy(a); if (isRef(c)) return c; return this.add(c); }));
      newRefs.push(ref);
    }
    // materialise the referenced objects
    for (let k = 0; k < queue.length && k < 2_000_000; k++) {
      const [num, r] = queue[k]; const o = src.getObj(num);
      if (isDict(o) && isName(o.get("Type"), "Page")) { this.changed.set(r.num, null); continue; } // page refs inside annots (/P, /Dest): dangling → null
      this.changed.set(r.num, copy(o));
    }
    // fix annotation /P back-references to the new pages
    newRefs.forEach((ref) => { const d = this.pageDicts.get(ref.num)!; for (const a of this.doc.arr(d.get("Annots"))) { const ad = isRef(a) ? this.changed.get(a.num) : a; if (isDict(ad) && ad.has("P")) ad.set("P", ref); } });
    this.pageOrder!.splice(Math.max(0, Math.min(at, this.pageOrder!.length)), 0, ...newRefs);
    return newRefs;
  }

  /* -------------------------------------------------------------- info */
  setInfo(fields: Partial<Record<"Title" | "Author" | "Subject" | "Keywords", string>>) {
    const cur = this.doc.trailer.get("Info");
    const d = isRef(cur) ? this.edit(cur) : (() => { const nd = new PDict(); const old = this.doc.dict(cur); if (old) for (const [k, v] of old.m) nd.set(k, v); this.trailerInfo = this.add(nd); return nd; })();
    for (const [k, v] of Object.entries(fields)) { if (v === undefined) continue; if (v === "") d.set(k, undefined); else d.set(k, makeText(v)); }
    d.set("ModDate", makeText(pdfDate()));
  }

  /* -------------------------------------------------------------- annotations */
  addAnnotation(index: number, a: AnnotSpec): PRef {
    const pref = this.pageRefs()[index]; if (!pref) throw new RangeError("no such page");
    const col = a.color ?? (a.type === "Highlight" ? [1, 0.85, 0.1] : [0.9, 0.1, 0.1]);
    const ad = new PDict().set("Type", N("Annot")).set("Subtype", N(a.type)).set("F", 4).set("P", pref)
      .set("M", makeText(pdfDate())).set("NM", makeText(`fusion-${Array.from(randomBytes(6), (b) => b.toString(16).padStart(2, "0")).join("")}`)).set("C", col.slice());
    if (a.contents) ad.set("Contents", makeText(a.contents));
    if (a.author) ad.set("T", makeText(a.author));
    if (a.opacity !== undefined && a.opacity < 1) ad.set("CA", a.opacity);
    const w = a.width ?? 2;
    let rect: number[]; let ap: string; const res = new PDict();
    const c3 = col.map((v) => fmtNum(v)).join(" ");
    const markup = a.type === "Highlight" || a.type === "Underline" || a.type === "StrikeOut" || a.type === "Squiggly";
    if (markup) {
      const rs = a.rects ?? []; if (!rs.length) throw new Error("markup annotations need rectangles");
      const qp: number[] = []; for (const r of rs) qp.push(r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]); // TL TR BL BR (Acrobat order)
      ad.set("QuadPoints", qp);
      rect = bbox(rs.flatMap((r) => [[r[0], r[1]], [r[2], r[3]]]), 1);
      if (a.type === "Highlight") {
        res.set("ExtGState", new PDict().set("G0", new PDict().set("BM", N("Multiply")).set("ca", a.opacity ?? 1).set("CA", a.opacity ?? 1)));
        ap = `/G0 gs ${c3} rg ` + rs.map((r) => `${fmtNum(r[0])} ${fmtNum(r[1])} ${fmtNum(r[2] - r[0])} ${fmtNum(r[3] - r[1])} re`).join(" ") + " f";
      } else {
        ap = `${c3} RG ${fmtNum(Math.max(0.5, (rs[0][3] - rs[0][1]) / 14))} w ` + rs.map((r) => {
          const y = a.type === "StrikeOut" ? (r[1] + r[3]) / 2 : r[1] + (r[3] - r[1]) * 0.08;
          if (a.type === "Squiggly") { let s = `${fmtNum(r[0])} ${fmtNum(y)} m`; const step = (r[3] - r[1]) / 6; let up = true; for (let x = r[0] + step; x <= r[2]; x += step, up = !up) s += ` ${fmtNum(x)} ${fmtNum(y + (up ? step / 2 : 0))} l`; return s + " S"; }
          return `${fmtNum(r[0])} ${fmtNum(y)} m ${fmtNum(r[2])} ${fmtNum(y)} l S`;
        }).join(" ");
      }
    } else if (a.type === "Ink") {
      const ink = (a.ink ?? []).filter((s) => s.length >= 2); if (!ink.length) throw new Error("ink annotations need strokes");
      ad.set("InkList", ink.map((s) => s.slice())); ad.set("BS", new PDict().set("W", w));
      const pts: number[][] = []; for (const s of ink) for (let i = 0; i + 1 < s.length; i += 2) pts.push([s[i], s[i + 1]]);
      rect = bbox(pts, w);
      ap = `${c3} RG ${fmtNum(w)} w 1 J 1 j ` + ink.map((s) => { let t = `${fmtNum(s[0])} ${fmtNum(s[1])} m`; if (s.length === 2) t += ` ${fmtNum(s[0] + 0.01)} ${fmtNum(s[1])} l`; for (let i = 2; i + 1 < s.length; i += 2) t += ` ${fmtNum(s[i])} ${fmtNum(s[i + 1])} l`; return t + " S"; }).join(" ");
      if (a.opacity !== undefined && a.opacity < 1) { res.set("ExtGState", new PDict().set("G0", new PDict().set("CA", a.opacity))); ap = "/G0 gs " + ap; }
    } else if (a.type === "Square" || a.type === "Circle") {
      const r = norm4(a.rect ?? [0, 0, 0, 0]); rect = r; ad.set("BS", new PDict().set("W", w));
      const x = r[0] + w / 2, y = r[1] + w / 2, W = r[2] - r[0] - w, H = r[3] - r[1] - w;
      if (a.type === "Square") ap = `${c3} RG ${fmtNum(w)} w ${fmtNum(x)} ${fmtNum(y)} ${fmtNum(W)} ${fmtNum(H)} re S`;
      else { const k = 0.5523; const cx = x + W / 2, cy = y + H / 2, rx = W / 2, ry = H / 2; ap = `${c3} RG ${fmtNum(w)} w ${fmtNum(cx + rx)} ${fmtNum(cy)} m ${[[cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry], [cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy], [cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry], [cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy]].map((s) => s.map(fmtNum).join(" ") + " c").join(" ")} S`; }
    } else if (a.type === "FreeText") {
      const r = norm4(a.rect ?? [0, 0, 200, 40]); rect = r; const fs = a.fontSize ?? 12; const text = a.contents ?? "";
      ad.set("DA", makeText(`/Helv ${fmtNum(fs)} Tf ${c3} rg`)); ad.set("C", undefined);
      res.set("Font", new PDict().set("Helv", helvFontDict()));
      const lines = wrap(text, r[2] - r[0] - 4, fs);
      ap = `BT /Helv ${fmtNum(fs)} Tf ${c3} rg ` + lines.map((l, i) => `1 0 0 1 ${fmtNum(r[0] + 2)} ${fmtNum(r[3] - 2 - fs * (i + 1) * 1.15 + fs * 0.2)} Tm (${pdfLiteral(winAnsiBytes(l))}) Tj`).join(" ") + " ET";
    } else { // Text (sticky note): a note icon
      const r = a.rect ? norm4(a.rect) : [0, 0, 20, 20]; rect = [r[0], r[1], r[0] + 20, r[1] + 20]; ad.set("Name", N("Comment"));
      const [x, y] = rect; ap = `${c3} rg 0 0 0 RG 0.6 w ${fmtNum(x + 1)} ${fmtNum(y + 4)} 18 15 re b 1 1 1 rg ${fmtNum(x + 4)} ${fmtNum(y + 13)} 12 1.5 re f ${fmtNum(x + 4)} ${fmtNum(y + 9)} 9 1.5 re f ${fmtNum(x + 5)} ${fmtNum(y + 4)} m ${fmtNum(x + 5)} ${fmtNum(y)} l ${fmtNum(x + 9)} ${fmtNum(y + 4)} l f`;
      ad.set("Open", false);
    }
    ad.set("Rect", rect);
    const apStream = new PStream(new PDict().set("Type", N("XObject")).set("Subtype", N("Form")).set("BBox", rect.slice()).set("Resources", res), enc.encode(ap));
    ad.set("AP", new PDict().set("N", this.add(apStream)));
    const aref = this.add(ad);
    this.appendAnnot(pref, aref);
    return aref;
  }
  private appendAnnot(pref: PRef, aref: PRef) {
    const pd = this.pageDicts.get(pref.num) ?? this.edit(pref);
    const cur = pd.get("Annots");
    if (isRef(cur)) { const arr = this.get(cur); const list = isArr(arr) ? arr.slice() : []; list.push(aref); this.put(cur.num, list); }
    else { const list = isArr(cur) ? cur.slice() : []; list.push(aref); pd.set("Annots", list); }
  }
  removeAnnotation(index: number, aref: PRef) {
    const pref = this.pageRefs()[index]; const pd = this.pageDicts.get(pref.num) ?? this.edit(pref);
    const cur = pd.get("Annots"); const keep = (x: PObj) => !(isRef(x) && x.num === aref.num);
    if (isRef(cur)) { const arr = this.get(cur); this.put(cur.num, isArr(arr) ? arr.filter(keep) : []); }
    else if (isArr(cur)) pd.set("Annots", cur.filter(keep));
  }

  /* -------------------------------------------------------------- forms */
  /** fully qualified field names → field refs (terminal fields) */
  fields(): { name: string; ref: PRef | null; dict: PDict; type: string; value: string; options: string[]; flags: number; widgets: (PRef | PDict)[] }[] {
    const af = this.dict(this.doc.catalog()?.get("AcroForm")); if (!af) return [];
    const out: ReturnType<PdfEditor["fields"]> = []; const seen = new Set<number>();
    const walk = (o: PObj | undefined, prefix: string, inhFT: string, inhFf: number, depth: number) => {
      if (depth > 32) return; if (isRef(o)) { if (seen.has(o.num)) return; seen.add(o.num); }
      const d = this.dict(o); if (!d) return;
      const t = this.get(d.get("T")); const name = t instanceof PStr ? (prefix ? `${prefix}.${textString(t)}` : textString(t)) : prefix;
      const ftv = this.get(d.get("FT")); const ft = isName(ftv) ? ftv.n : inhFT; const ff = this.doc.num(this.get(d.get("Ff")), inhFf);
      const kids = this.get(d.get("Kids")); const kidFields = isArr(kids) ? kids.filter((k) => { const kd = this.dict(k); return kd && kd.has("T"); }) : [];
      if (kidFields.length) { for (const k of kidFields) walk(k, name, ft, ff, depth + 1); return; }
      const widgets = isArr(kids) && kids.length ? (kids as (PRef | PDict)[]) : [isRef(o) ? o : d];
      const v = this.get(d.get("V"));
      const value = v instanceof PStr ? textString(v) : isName(v) ? v.n : isArr(v) ? v.map((x) => (x instanceof PStr ? textString(x) : "")).join(", ") : "";
      const opt = this.get(d.get("Opt")); const options = isArr(opt) ? opt.map((x) => { const y = this.get(x); if (isArr(y)) { const z = this.get(y[1]); return z instanceof PStr ? textString(z) : ""; } return y instanceof PStr ? textString(y) : ""; }) : [];
      out.push({ name, ref: isRef(o) ? o : null, dict: d, type: ft, value, options, flags: ff, widgets });
    };
    for (const f of this.doc.arr(af.get("Fields"))) walk(f, "", "", 0, 0);
    return out;
  }
  /** set a field value and regenerate its widgets' appearances; returns false when the field is unknown/read-only */
  fillField(name: string, value: string | boolean): boolean {
    const f = this.fields().find((x) => x.name === name); if (!f || !f.ref) return false;
    if (f.flags & 1) return false; // ReadOnly
    const fd = this.edit(f.ref);
    if (f.type === "Btn") {
      if (f.flags & (1 << 16)) return false; // push button: no value
      // the on-state name comes from the widgets' /AP /N keys
      let onName = "";
      const widgets = f.widgets.map((w) => (isRef(w) ? w : null)).filter(Boolean) as PRef[];
      const targets = widgets.length ? widgets : [f.ref];
      for (const w of targets) {
        const wd = w.num === f.ref.num ? fd : this.edit(w);
        const apn = this.dict(this.dict(wd.get("AP"))?.get("N"));
        const states = apn ? [...apn.m.keys()].filter((k) => k !== "Off") : ["Yes"];
        const want = typeof value === "string" ? value : value ? states[0] : "Off";
        const st = states.includes(want) ? want : "Off";
        wd.set("AS", N(st)); if (st !== "Off") onName = st;
      }
      fd.set("V", N(onName || "Off"));
      return true;
    }
    const text = String(value);
    fd.set("V", makeText(text));
    // appearance per widget, from /DA (field → AcroForm default) with a standard font for layout
    const af = this.dict(this.doc.catalog()?.get("AcroForm"))!;
    const daObj = this.get(fd.get("DA")) ?? this.get(af.get("DA")); const da = daObj instanceof PStr ? textString(daObj) : "/Helv 0 Tf 0 g";
    const dm = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da); const fontName = dm ? dm[1] : "Helv"; let size = dm ? Number(dm[2]) : 0;
    const colorOps = da.replace(/\/[^\s/]+\s+[\d.]+\s+Tf/, "").trim() || "0 g";
    const dr = this.dict(af.get("DR")); const drFont = dr ? this.dict(this.dict(dr.get("Font"))?.get(fontName)) : null;
    const base = drFont ? this.get(drFont.get("BaseFont")) : null; const sub = drFont ? this.get(drFont.get("Subtype")) : null;
    const std = isName(base) ? stdFontFor(base.n) : "Helvetica";
    const simple = !drFont || !isName(sub, "Type0");
    const fontRes = new PDict().set(fontName, drFont && simple ? (drFont as PObj) : helvFontDict());
    if (!simple) { af.has("NeedAppearances"); this.edit(this.doc.catalog()!.get("AcroForm") as PRef).set("NeedAppearances", true); return true; } // composite fonts: let the viewer regenerate
    const q = this.doc.num(this.get(fd.get("Q")) ?? this.get(af.get("Q")), 0);
    const multiline = (f.flags & (1 << 12)) !== 0; const comb = (f.flags & (1 << 24)) !== 0; const maxLen = this.doc.num(this.get(fd.get("MaxLen")), 0);
    const password = (f.flags & (1 << 13)) !== 0;
    const shown = password ? "*".repeat([...text].length) : text;
    const widgets = f.widgets.length ? f.widgets : [f.ref];
    for (const w of widgets) {
      const wd = isRef(w) ? (w.num === f.ref.num ? fd : this.edit(w)) : w;
      const r = norm4(this.doc.arr(wd.get("Rect")).map((x) => this.doc.num(x))); const W = r[2] - r[0], H = r[3] - r[1];
      const mk = this.dict(wd.get("MK")); const rotm = mk ? this.doc.num(mk.get("R"), 0) : 0;
      const [bw, bh] = rotm % 180 ? [H, W] : [W, H];
      let fs = size || (multiline ? 12 : Math.max(4, Math.min(12, (bh - 4) * 0.75)));
      if (!size && !multiline) { const tw = helvWidth(shown, fs, std); if (tw > bw - 4) fs = Math.max(4, (fs * (bw - 4)) / tw); }
      let body: string;
      if (comb && maxLen > 0) {
        const cell = bw / maxLen; body = [...shown].slice(0, maxLen).map((ch, i) => `1 0 0 1 ${fmtNum(i * cell + (cell - helvWidth(ch, fs, std)) / 2)} ${fmtNum((bh - fs * 0.7) / 2)} Tm (${pdfLiteral(winAnsiBytes(ch))}) Tj`).join(" ");
      } else {
        const lines = multiline ? wrap(shown, bw - 4, fs) : [shown];
        body = lines.map((l, i) => { const lw = helvWidth(l, fs, std); const x = q === 1 ? (bw - lw) / 2 : q === 2 ? bw - 2 - lw : 2; const y = multiline ? bh - 2 - fs * (i + 1) * 1.15 + fs * 0.25 : (bh - fs * 0.72) / 2; return `1 0 0 1 ${fmtNum(x)} ${fmtNum(y)} Tm (${pdfLiteral(winAnsiBytes(l))}) Tj`; }).join(" ");
      }
      const ap = `/Tx BMC q 1 1 ${fmtNum(bw - 2)} ${fmtNum(bh - 2)} re W n BT /${fontName} ${fmtNum(fs)} Tf ${colorOps} ${body} ET Q EMC`;
      const mtx = rotm === 90 ? [0, 1, -1, 0, bw, 0] : rotm === 180 ? [-1, 0, 0, -1, bw, bh] : rotm === 270 ? [0, -1, 1, 0, 0, bh] : null;
      const sd = new PDict().set("Type", N("XObject")).set("Subtype", N("Form")).set("BBox", [0, 0, bw, bh]).set("Resources", new PDict().set("Font", fontRes));
      if (mtx) sd.set("Matrix", mtx);
      const apd = new PDict().set("N", this.add(new PStream(sd, enc.encode(ap))));
      wd.set("AP", apd);
    }
    return true;
  }

  /* -------------------------------------------------------------- writing */
  private encryptFor(o: PObj, num: number, gen: number, depth = 0): PObj {
    const sec = this.doc.sec; if (!sec) return o;
    if (depth > 100) return o;
    if (o instanceof PStr) return new PStr(sec.encryptString(num, gen, o.b), o.hex);
    if (Array.isArray(o)) return o.map((x) => this.encryptFor(x, num, gen, depth + 1));
    if (o instanceof PDict) { const d = new PDict(); for (const [k, v] of o.m) d.set(k, this.encryptFor(v, num, gen, depth + 1)); return d; }
    if (o instanceof PStream) {
      const d = this.encryptFor(o.dict, num, gen, depth + 1) as PDict;
      if (isName(d.get("Type"), "XRef")) return new PStream(d, o.raw);
      if (isName(d.get("Type"), "Metadata") && !sec.encryptMetadata) return new PStream(d, o.raw);
      return new PStream(d, sec.encryptStream(num, gen, o.raw));
    }
    return o;
  }
  private writeObj(num: number, gen: number, o: PObj): Bytes {
    const e = this.encryptFor(o, num, gen);
    if (e instanceof PStream) {
      const d = new PDict(); for (const [k, v] of e.dict.m) d.set(k, v); d.set("Length", e.raw.length);
      return concatBytes([enc.encode(`${num} ${gen} obj\n${serialize(d)}\nstream\n`), e.raw, enc.encode(`\nendstream\nendobj\n`)]);
    }
    return latin1ToBytes(`${num} ${gen} obj\n${serialize(e)}\nendobj\n`);
  }
  private newId(): PObj[] {
    const id = this.doc.resolve(this.doc.trailer.get("ID")); const id0 = isArr(id) && id[0] instanceof PStr ? id[0] : new PStr(randomBytes(16), true);
    return [id0, new PStr(randomBytes(16), true)];
  }
  /** incremental update (falls back to a full rewrite for files whose cross-reference had to be rebuilt) */
  save(): Bytes {
    this.commitPages();
    if (this.doc.recovered || this.doc.startxref < 0 || !this.xrefExact()) return this.saveClean();
    const base = this.doc.bytes; const parts: Bytes[] = [base];
    let off = base.length; if (base[base.length - 1] !== 10 && base[base.length - 1] !== 13) { parts.push(enc.encode("\n")); off++; }
    const entries: [number, number, number][] = [];
    const nums = [...this.changed.keys()].sort((a, b) => a - b);
    for (const n of nums) { const gen = this.gens.get(n) ?? 0; const b = this.writeObj(n, gen, this.changed.get(n)!); entries.push([n, off, gen]); parts.push(b); off += b.length; }
    const size = Math.max(this.next, this.doc.num(this.doc.trailer.get("Size"), 0));
    const trailer = new PDict().set("Size", size).set("Root", this.doc.trailer.get("Root")).set("Prev", this.doc.startxref).set("ID", this.newId());
    const info = this.trailerInfo ?? this.doc.trailer.get("Info"); if (info) trailer.set("Info", info);
    if (this.doc.trailer.get("Encrypt")) trailer.set("Encrypt", this.doc.trailer.get("Encrypt"));
    if (this.doc.lastXrefIsStream) {
      const xnum = size; const all = [...entries, [xnum, off, 0] as [number, number, number]].sort((a, b) => a[0] - b[0]);
      const idx: number[] = []; const rows: number[] = [];
      for (const [n, o, g] of all) { if (idx.length && idx[idx.length - 2] + idx[idx.length - 1] === n) idx[idx.length - 1]++; else idx.push(n, 1); rows.push(1, (o >>> 24) & 255, (o >>> 16) & 255, (o >>> 8) & 255, o & 255, (g >> 8) & 255, g & 255); }
      trailer.set("Size", xnum + 1).set("Type", N("XRef")).set("W", [1, 4, 2]).set("Index", idx);
      const data = Uint8Array.from(rows); trailer.set("Length", data.length);
      parts.push(concatBytes([enc.encode(`${xnum} 0 obj\n${serialize(trailer)}\nstream\n`), data, enc.encode(`\nendstream\nendobj\nstartxref\n${off}\n%%EOF\n`)]));
    } else {
      const sorted = entries.sort((a, b) => a[0] - b[0]); let s = "xref\n";
      for (let i = 0; i < sorted.length;) { let j = i; while (j + 1 < sorted.length && sorted[j + 1][0] === sorted[j][0] + 1) j++; s += `${sorted[i][0]} ${j - i + 1}\n`; for (let k = i; k <= j; k++) s += `${String(sorted[k][1]).padStart(10, "0")} ${String(sorted[k][2]).padStart(5, "0")} n\r\n`; i = j + 1; }
      s += `trailer\n${serialize(trailer)}\nstartxref\n${off}\n%%EOF\n`;
      parts.push(latin1ToBytes(s));
    }
    return concatBytes(parts);
  }
  /** every in-use classic entry points exactly at "num gen obj" (otherwise readers had to repair the file, and an
   *  incremental section chained onto it would inherit the damage — we write a clean copy instead) */
  xrefExact(): boolean {
    const b = this.doc.bytes;
    for (const [num, e] of this.doc.xref) {
      if (e.type !== 1) continue;
      let p = e.off; if (p < 0 || p >= b.length) return false;
      const head = new TextDecoder("latin1").decode(b.subarray(p, Math.min(b.length, p + 32)));
      const m = /^(\d+)\s+(\d+)\s+obj/.exec(head); if (!m || Number(m[1]) !== num) return false;
    }
    return true;
  }
  /** full rewrite of the reachable objects, densely renumbered (a "clean copy") */
  saveClean(): Bytes {
    this.commitPages();
    const map = new Map<number, number>(); const order: number[] = [];
    const reach = (o: PObj | undefined, depth = 0) => {
      const stack: [PObj | undefined, number][] = [[o, depth]];
      while (stack.length) {
        const [x, dpt] = stack.pop()!; if (dpt > 400) continue;
        if (x instanceof PRef) { if (map.has(x.num)) continue; const v = this.get(x); if (v === null || v === undefined) continue; if (isStream(v) && (isName(v.dict.get("Type"), "XRef") || isName(v.dict.get("Type"), "ObjStm"))) continue; map.set(x.num, order.length + 1); order.push(x.num); stack.push([v, dpt + 1]); }
        else if (Array.isArray(x)) for (const y of x) stack.push([y, dpt + 1]);
        else if (x instanceof PDict) for (const y of x.m.values()) stack.push([y, dpt + 1]);
        else if (x instanceof PStream) stack.push([x.dict, dpt + 1]);
      }
    };
    const root = this.doc.trailer.get("Root"); const info = this.trailerInfo ?? this.doc.trailer.get("Info"); const encr = this.doc.trailer.get("Encrypt");
    reach(root); reach(info);
    const renum = (o: PObj | undefined, depth = 0): PObj => {
      if (depth > 400) return null;
      if (o instanceof PRef) { const n = map.get(o.num); return n ? new PRef(n, 0) : null; }
      if (Array.isArray(o)) return o.map((x) => renum(x, depth + 1));
      if (o instanceof PDict) { const d = new PDict(); for (const [k, v] of o.m) d.set(k, renum(v, depth + 1)); return d; }
      if (o instanceof PStream) return new PStream(renum(o.dict, depth + 1) as PDict, o.raw);
      return o ?? null;
    };
    const parts: Bytes[] = [enc.encode(`%PDF-${this.doc.version}\n%\u00e2\u00e3\u00cf\u00d3\n`)]; parts[0] = latin1ToBytes(`%PDF-${this.doc.version}\n%\u00e2\u00e3\u00cf\u00d3\n`);
    let off = parts[0].length; const offs: number[] = [];
    order.forEach((old, i) => { const b = this.writeObj(i + 1, 0, renum(this.get(new PRef(old, 0)))); offs.push(off); parts.push(b); off += b.length; });
    let encRef: PRef | null = null;
    if (encr && this.doc.sec) { // the Encrypt dictionary itself is never encrypted
      const n = order.length + 1; const ed = this.doc.resolve(encr);
      const b = latin1ToBytes(`${n} 0 obj\n${serialize(ed)}\nendobj\n`); offs.push(off); parts.push(b); off += b.length; encRef = new PRef(n, 0);
    }
    const count = offs.length; let s = `xref\n0 ${count + 1}\n0000000000 65535 f\r\n`;
    for (const o of offs) s += `${String(o).padStart(10, "0")} 00000 n\r\n`;
    const trailer = new PDict().set("Size", count + 1).set("Root", renum(root)).set("ID", this.newId());
    if (info && map.has((info as PRef).num)) trailer.set("Info", renum(info));
    if (encRef) trailer.set("Encrypt", encRef);
    s += `trailer\n${serialize(trailer)}\nstartxref\n${off}\n%%EOF\n`; parts.push(latin1ToBytes(s));
    return concatBytes(parts);
  }
}

/** a new document holding copies of some pages of `src` (extract / split) */
export function extractPages(src: PdfDoc, indices: number[]): Bytes {
  const skeleton = latin1ToBytes("%PDF-1.7\n1 0 obj\n<</Type /Catalog/Pages 2 0 R>>\nendobj\n2 0 obj\n<</Type /Pages/Kids [3 0 R]/Count 1>>\nendobj\n3 0 obj\n<</Type /Page/Parent 2 0 R/MediaBox [0 0 612 792]/Resources <<>>>>\nendobj\n");
  const xrefAt = skeleton.length;
  const tail = latin1ToBytes(`xref\n0 4\n0000000000 65535 f\r\n0000000009 00000 n\r\n0000000058 00000 n\r\n0000000115 00000 n\r\ntrailer\n<</Size 4/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`);
  const blank = PdfDoc.open(concatBytes([skeleton, tail]));
  const ed = new PdfEditor(blank);
  ed.importPages(src, indices, 1); ed.deletePages([0]);
  return ed.saveClean();
}
/** concatenate whole documents */
export function mergeDocuments(docs: PdfDoc[]): Bytes {
  if (!docs.length) throw new Error("nothing to merge");
  const ed = new PdfEditor(docs[0]);
  for (const d of docs.slice(1)) ed.importPages(d, d.pages().map((_, i) => i));
  return ed.saveClean();
}

function stdFontFor(base: string): string { const b = base.replace(/^[A-Z]{6}\+/, ""); if (/Cour/i.test(b)) return /Bold/i.test(b) ? "Courier-Bold" : "Courier"; if (/Times|Roman|Serif/i.test(b) && !/Sans/i.test(b)) return /Bold/i.test(b) ? "Times-Bold" : "Times-Roman"; return /Bold/i.test(b) ? "Helvetica-Bold" : "Helvetica"; }
function norm4(r: number[]): number[] { return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]; }
function bbox(pts: number[][], pad: number): number[] { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]; }
