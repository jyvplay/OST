/**
 * TT52 — PDF document reader (ISO 32000-2 §7.5, §7.7.3): cross-reference tables and streams, hybrid files, the
 * incremental-update chain, object streams, damaged-file recovery, lazy object resolution, decryption, page tree.
 * Original code written from the specification.
 *
 * Guards (bounded work on hostile input): 64 MiB… actually MAX_PDF (256 MiB) input, 8 million objects, 50,000 pages,
 * 256 MiB per decoded stream, /Prev chains of at most 4,096 sections, reference cycles detected.
 */
import {
  Lexer, PDict, PName, PRef, PStr, PStream, isArr, isDict, isName, isNum, isRef, isStream, parseObj, indexOf, lastIndexOf, matchAt,
  N, textString, type PObj, type Bytes, type StreamResolver,
} from "./pdfobj";
import { applyFilters, filterChain, type FilterSpec } from "./pdffilters";
import { SecurityHandler, streamCryptName } from "./pdfcrypt";

export const MAX_PDF = 256 << 20, MAX_OBJECTS = 8_000_000, MAX_PAGES = 50_000, MAX_STREAM = 256 << 20;

export interface XEntry { type: 0 | 1 | 2; off: number; gen: number; stm?: number; idx?: number }
export class PasswordRequired extends Error { constructor(m = "pdf: a password is required to open this file") { super(m); } }

export interface PdfPage {
  index: number; ref: PRef | null; dict: PDict;
  media: [number, number, number, number]; crop: [number, number, number, number]; rotate: number;
  resources: PDict | null;
}

export class PdfDoc {
  readonly bytes: Bytes;
  readonly xref = new Map<number, XEntry>();
  trailer = new PDict();
  /** byte offset of the last startxref target (needed for incremental updates) */
  startxref = -1;
  /** the last cross-reference section is a stream (incremental updates then append an xref stream) */
  lastXrefIsStream = false;
  /** true when the xref was rebuilt by scanning (file damaged) */
  recovered = false;
  readonly warnings: string[] = [];
  version = "1.4";
  sec: SecurityHandler | null = null;
  private cache = new Map<number, PObj>();
  private objstmCache = new Map<number, { offs: number[]; nums: number[]; first: number; data: Bytes }>();
  private resolving = new Set<number>();
  private pagesCache: PdfPage[] | null = null;
  maxObj = 0;

  private constructor(bytes: Bytes) { this.bytes = bytes; }

  /** open a PDF; throws PasswordRequired when the empty password does not unlock it and none was given */
  static open(bytes: Bytes, password?: string): PdfDoc {
    if (bytes.length > MAX_PDF) throw new Error("pdf: file exceeds the 256 MiB guard");
    const d = new PdfDoc(bytes);
    const hdr = indexOf(bytes, "%PDF-", 0, Math.min(bytes.length, 1024));
    if (hdr < 0) {
      // header missing or damaged: accept when the start looks like PDF objects (other readers do the same)
      if (!/\d+\s+\d+\s+obj/.test(new TextDecoder("latin1").decode(bytes.subarray(0, 4096)))) throw new Error("pdf: not a PDF file (no %PDF- header)");
      d.warnings.push("missing %PDF- header");
    }
    const vm = /^%PDF-(\d\.\d)/.exec(String.fromCharCode(...bytes.subarray(hdr, hdr + 8))); if (vm) d.version = vm[1];
    // decryption comes before the catalog check: the page tree may sit in an encrypted object stream
    let chainOk = true;
    try { d.readXrefChain(); if (!d.trailer.has("Root")) throw new Error("no /Root"); }
    catch (e) { chainOk = false; d.warnings.push(`cross-reference damaged (${(e as Error).message}); rebuilt by scanning the file`); d.recover(); }
    d.setupEncryption(password); // PasswordRequired propagates: it is not damage
    if (chainOk) {
      try { d.checkRoot(); }
      catch (e) { d.warnings.push(`cross-reference damaged (${(e as Error).message}); rebuilt by scanning the file`); const sec = d.sec, er = d.encryptRef; d.recover(); d.sec = sec; d.encryptRef = er; }
    }
    const cat = d.catalog(); const v = cat?.get("Version"); if (isName(v) && /^\d\.\d$/.test(v.n) && v.n > d.version) d.version = v.n;
    return d;
  }

  /* -------------------------------------------------------------- xref */
  private readXrefChain() {
    const b = this.bytes;
    const sx = lastIndexOf(b, "startxref", b.length - 9, Math.max(0, b.length - 4096));
    if (sx < 0) throw new Error("startxref not found");
    const lx = new Lexer(b, sx + 9); const off = lx.next();
    if (!isNum(off)) throw new Error("bad startxref");
    this.startxref = off;
    const seen = new Set<number>(); let pos: number | null = off; let first = true; let sections = 0;
    while (pos !== null && pos >= 0) {
      if (seen.has(pos)) { this.warnings.push("cross-reference chain loops; stopped"); break; }
      if (++sections > 4096) throw new Error("too many cross-reference sections");
      seen.add(pos);
      const { trailer, isStream } = this.readXrefSection(pos);
      if (first) { this.trailer = trailer; this.lastXrefIsStream = isStream; first = false; }
      // TT54: an update whose trailer omits /Info or /ID inherits them from an older section (pdf.js / pypdf behave alike)
      else for (const k of ["Info", "ID"]) if (!this.trailer.has(k) && trailer.has(k)) this.trailer.set(k, trailer.get(k));
      // hybrid file: the table's trailer points at an xref stream with the compressed objects (§7.5.8.4)
      const xs = trailer.get("XRefStm"); if (isNum(xs) && !seen.has(xs)) { seen.add(xs); try { this.readXrefSection(xs); } catch (e) { this.warnings.push(`XRefStm: ${(e as Error).message}`); } }
      const prev = trailer.get("Prev"); pos = isNum(prev) ? prev : null;
    }
  }
  /** read one section; earlier-read (newer) entries win, so only fill missing object numbers */
  private readXrefSection(pos: number): { trailer: PDict; isStream: boolean } {
    const b = this.bytes;
    let p = pos; while (p < b.length && /\s/.test(String.fromCharCode(b[p]))) p++;
    if (matchAt(b, p, "xref")) return { trailer: this.readXrefTable(p + 4), isStream: false };
    // some writers point a few bytes off: look around for "xref"
    const near = indexOf(b, "xref", Math.max(0, pos - 32), Math.min(b.length, pos + 32));
    if (near >= 0 && !matchAt(b, near - 1, "start")) return { trailer: this.readXrefTable(near + 4), isStream: false };
    // cross-reference stream
    const lx = new Lexer(b, p); const n = lx.next(), g = lx.next(), kw = lx.next();
    if (!isNum(n) || !isNum(g) || !(kw && typeof kw === "object" && "k" in kw && (kw as { k: string }).k === "obj")) throw new Error(`no xref at ${pos}`);
    const s = parseObj(lx, 0, this.sr(), n, g);
    if (!isStream(s) || !isName(s.dict.get("Type"), "XRef")) throw new Error(`object at ${pos} is not an xref stream`);
    this.readXrefStream(s);
    return { trailer: s.dict, isStream: true };
  }
  private readXrefTable(p: number): PDict {
    const b = this.bytes; const lx = new Lexer(b, p);
    for (;;) {
      const save = lx.p; const a = lx.next();
      if (a && typeof a === "object" && "k" in a && (a as { k: string }).k === "trailer") break;
      if (!isNum(a)) { lx.p = save; break; }
      const cnt = lx.next(); if (!isNum(cnt) || cnt < 0 || cnt > MAX_OBJECTS) throw new Error("bad xref subsection");
      let start = a;
      // read cnt entries of the form "oooooooooo ggggg n|f" (whitespace-tolerant)
      for (let i = 0; i < cnt; i++) {
        const off = lx.next(), gen = lx.next(), t = lx.next();
        if (!isNum(off) || !isNum(gen) || !(t && typeof t === "object" && "k" in t)) throw new Error("bad xref entry");
        const k = (t as { k: string }).k; const num = start + i;
        // a common writer bug: first subsection starts at 1 while listing the free head of object 0
        if (i === 0 && num === 1 && k === "f" && off === 0 && gen === 65535) { start--; continue; }
        if (!this.xref.has(num) && num < MAX_OBJECTS) this.xref.set(num, k === "n" ? { type: 1, off, gen } : { type: 0, off, gen });
        if (num > this.maxObj) this.maxObj = num;
      }
    }
    const t = parseObj(lx, 0, this.sr());
    if (!isDict(t)) throw new Error("trailer missing");
    return t;
  }
  private readXrefStream(s: PStream) {
    const W = s.dict.get("W"); if (!isArr(W) || W.length < 3) throw new Error("xref stream without /W");
    const w = W.map((x) => (isNum(x) ? x : 0)); if (w.some((x) => x < 0 || x > 8)) throw new Error("bad /W");
    const size = s.dict.get("Size"); const idx = s.dict.get("Index");
    const ranges: number[] = isArr(idx) ? idx.map((x) => (isNum(x) ? x : 0)) : [0, isNum(size) ? size : 0];
    const data = this.decodeRaw(s).data; const rec = w[0] + w[1] + w[2]; if (!rec) return;
    let p = 0;
    const field = (len: number, dflt: number) => { if (!len) return dflt; let v = 0; for (let i = 0; i < len; i++) v = v * 256 + (data[p++] ?? 0); return v; };
    for (let r = 0; r + 1 < ranges.length; r += 2) {
      const start = ranges[r], cnt = ranges[r + 1];
      for (let i = 0; i < cnt && p + rec <= data.length; i++) {
        const type = field(w[0], 1), f2 = field(w[1], 0), f3 = field(w[2], 0); const num = start + i;
        if (num >= MAX_OBJECTS) continue;
        if (!this.xref.has(num)) {
          if (type === 1) this.xref.set(num, { type: 1, off: f2, gen: f3 });
          else if (type === 2) this.xref.set(num, { type: 2, off: 0, gen: 0, stm: f2, idx: f3 });
          else if (type === 0) this.xref.set(num, { type: 0, off: f2, gen: f3 });
        }
        if (num > this.maxObj) this.maxObj = num;
      }
    }
  }
  /** the xref read fine but points at garbage: verify the catalog resolves, else recover */
  private checkRoot() {
    const r = this.trailer.get("Root");
    const c = this.resolve(r);
    if (!isDict(c)) throw new Error("/Root does not resolve to a dictionary");
    // spot-check: the page tree root must be a dictionary too
    if (!isDict(this.resolve(c.get("Pages")))) throw new Error("/Pages does not resolve");
  }

  /** damaged file: scan every "n g obj", last definition wins; find trailers or the catalog (§7.5 + common practice) */
  private recover() {
    this.recovered = true; this.xref.clear(); this.cache.clear(); this.objstmCache.clear();
    const b = this.bytes; const re = /(\d{1,10})\s+(\d{1,24})\s+obj\b/g;
    const text = new TextDecoder("latin1").decode(b);
    let m: RegExpExecArray | null; let trailer: PDict | null = null;
    while ((m = re.exec(text))) {
      // the object number must start a token (avoid matching digits inside a longer number)
      if (m.index > 0 && /[0-9]/.test(text[m.index - 1])) continue;
      const num = Number(m[1]); if (num >= MAX_OBJECTS) continue;
      this.xref.set(num, { type: 1, off: m.index, gen: Math.min(65535, Number(m[2])) }); if (num > this.maxObj) this.maxObj = num;
    }
    // trailers: the last one with a /Root that resolves
    for (let p = lastIndexOf(b, "trailer"); p >= 0; p = lastIndexOf(b, "trailer", p - 1)) {
      try { const t = parseObj(new Lexer(b, p + 7), 0, this.sr()); if (isDict(t) && this.goodRoot(t.get("Root"))) { trailer = t; break; } } catch { /* next */ }
      if (p === 0) break;
    }
    // xref streams found by the scan carry trailer keys and compressed-object entries
    const streams: PStream[] = [];
    for (const [num, e] of this.xref) {
      if (e.type !== 1) continue;
      const o = this.safeResolve(num);
      if (isStream(o) && isName(o.dict.get("Type"), "XRef")) streams.push(o);
    }
    for (const s of streams) {
      try { this.readXrefStreamAdditive(s); } catch { /* skip */ }
      if (!trailer && this.goodRoot(s.dict.get("Root"))) trailer = s.dict;
    }
    // objects inside object streams that the scan could not see
    for (const [num, e] of [...this.xref]) {
      if (e.type !== 1) continue; const o = this.safeResolve(num);
      if (isStream(o) && isName(o.dict.get("Type"), "ObjStm")) {
        try { const os = this.objstm(num); os.nums.forEach((n, i) => { if (!this.xref.has(n) || this.xref.get(n)!.type === 2) this.xref.set(n, { type: 2, off: 0, gen: 0, stm: num, idx: i }); if (n > this.maxObj) this.maxObj = n; }); } catch { /* skip */ }
      }
    }
    if (!trailer || !this.goodRoot(trailer.get("Root"))) {
      // a trailer whose /Root is wrong (points at /Info, say): keep its other keys, find the real catalog
      trailer = trailer ?? this.anyTrailer() ?? new PDict();
      let weak: number | null = null;
      for (const [num] of this.xref) {
        const o = this.safeResolve(num); if (!isDict(o) || !isName(o.get("Type"), "Catalog")) continue;
        if (isDict(this.resolve(o.get("Pages")))) { weak = null; trailer.set("Root", new PRef(num, this.xref.get(num)!.gen)); break; }
        weak ??= num;
      }
      if (weak !== null) trailer.set("Root", new PRef(weak, this.xref.get(weak)!.gen)); // catalog with a broken page tree: pages() falls back
      if (!trailer.has("Root") || !isDict(this.resolve(trailer.get("Root")))) trailer.set("Root", undefined);
    }
    if (!trailer.has("Root")) throw new Error("pdf: no document catalog found (file is not a usable PDF)");
    // TT54: the rebuilt trailer may have come from a section without /Encrypt, /ID or /Info (or from the catalog search):
    // borrow them from any other trailer / xref-stream dictionary the scan finds. Losing /Encrypt would silently skip
    // decryption and show ciphertext.
    if (!trailer.has("Encrypt") || !trailer.has("ID") || !trailer.has("Info")) {
      const cands: PDict[] = streams.map((x) => x.dict);
      for (let p = b.length, n = 0; n < 32; n++) {
        p = lastIndexOf(b, "trailer", p - 1); if (p < 0) break;
        try { const t = parseObj(new Lexer(b, p + 7), 0, this.sr()); if (isDict(t)) cands.push(t); } catch { /* next */ }
        if (p === 0) break;
      }
      for (const k of ["Encrypt", "ID", "Info"]) if (!trailer.has(k)) { const c = cands.find((t) => t.has(k) && t.get(k) !== null); if (c) { trailer.set(k, c.get(k)); this.warnings.push(`recovered /${k} from another trailer`); } }
    }
    this.trailer = trailer; this.cache.clear(); this.lastXrefIsStream = false;
    this.startxref = -1;
  }
  /** a usable catalog: a dictionary whose /Pages resolves to a dictionary */
  private goodRoot(r: PObj | undefined): boolean { try { const c = this.resolve(r); return isDict(c) && isDict(this.resolve(c.get("Pages"))); } catch { return false; } }
  private anyTrailer(): PDict | null {
    const b = this.bytes; const p = lastIndexOf(b, "trailer"); if (p < 0) return null;
    try { const t = parseObj(new Lexer(b, p + 7), 0, this.sr()); return isDict(t) ? t : null; } catch { return null; }
  }
  private readXrefStreamAdditive(s: PStream) {
    // in recovery, compressed-object entries from xref streams fill gaps only
    const before = new Map(this.xref); this.readXrefStream(s);
    for (const [k, v] of before) this.xref.set(k, v);
  }
  private safeResolve(num: number): PObj { try { return this.getObj(num); } catch { return null; } }

  /* -------------------------------------------------------------- encryption */
  private setupEncryption(password?: string) {
    const enc = this.resolve(this.trailer.get("Encrypt"));
    if (!isDict(enc)) return;
    const id = this.resolve(this.trailer.get("ID")); const id0 = isArr(id) && id[0] instanceof PStr ? (id[0] as PStr).b : new Uint8Array(0);
    // the Encrypt dictionary may hold indirect /CF and crypt-filter dictionaries (never themselves encrypted): resolve them
    const flat = (o: PObj | undefined, depth: number): PObj => { const r = this.resolve(o) ?? null; if (depth > 4) return r; if (isDict(r)) { const d = new PDict(); for (const [k, v] of r.m) d.set(k, flat(v, depth + 1)); return d; } return r; };
    const h = new SecurityHandler(flat(enc, 0) as PDict, id0);
    const encRef = this.trailer.get("Encrypt");
    if (!h.authenticate(password ?? "")) {
      // PDF 2.0 §7.6.5: with /StmF and /StrF Identity (absent = Identity) only /EFF — embedded files — is encrypted
      // (typically /AuthEvent /EFOpen); the document itself is plain and opens without the password.
      const e2 = flat(enc, 0) as PDict; const nm = (k: string) => { const v = e2.get(k); return isName(v) ? v.n : "Identity"; };
      const vNum = e2.get("V");
      if (isNum(vNum) && vNum >= 4 && nm("StmF") === "Identity" && nm("StrF") === "Identity") {
        this.warnings.push("only embedded files are encrypted (crypt filter /EFF); the document opens without a password; attachments stay locked (and are not readable after a full rewrite)");
        this.encryptRef = isRef(encRef) ? encRef.num : -1; return;
      }
      if (password === undefined) throw new PasswordRequired();
      throw new PasswordRequired("pdf: wrong password");
    }
    this.sec = h; this.encryptRef = isRef(encRef) ? encRef.num : -1; this.cache.clear();
  }
  encryptRef = -1;

  /* -------------------------------------------------------------- objects */
  private sr(): StreamResolver {
    return { length: (o) => { if (isNum(o)) return o; if (isRef(o)) { const e = this.xref.get(o.num); if (!e || this.resolving.has(o.num)) return null; const v = this.getObj(o.num); return isNum(v) ? v : null; } return null; } };
  }
  /** the object with this number (latest revision), decrypted; null when absent */
  getObj(num: number): PObj {
    if (this.cache.has(num)) return this.cache.get(num)!;
    const e = this.xref.get(num); if (!e || e.type === 0) return null;
    if (this.resolving.has(num)) throw new Error(`pdf: object ${num} refers to itself while loading`);
    this.resolving.add(num);
    try {
      let o: PObj = null;
      if (e.type === 1) o = this.readAt(num, e);
      else {
        const os = this.objstm(e.stm!); let i = e.idx!;
        if (os.nums[i] !== num) i = os.nums.indexOf(num); // stale index: find by number
        if (i >= 0) { const lx = new Lexer(os.data, os.first + os.offs[i]); o = parseObj(lx, 0, undefined); }
      }
      if (this.cache.size < 2_000_000) this.cache.set(num, o);
      return o;
    } finally { this.resolving.delete(num); }
  }
  private readAt(num: number, e: XEntry): PObj {
    const b = this.bytes; if (e.off <= 0 || e.off >= b.length) return null;
    let lx = new Lexer(b, e.off); let n = lx.next(), g = lx.next(), kw = lx.next();
    const ok = () => isNum(n) && n === num && isNum(g) && kw && typeof kw === "object" && "k" in kw && (kw as { k: string }).k === "obj";
    if (!ok()) {
      // offsets that are slightly off (common): search nearby for "num gen obj"
      const pat = `${num} ${e.gen} obj`; const near = indexOf(b, pat, Math.max(0, e.off - 64), Math.min(b.length, e.off + 64 + pat.length));
      if (near < 0) throw new Error(`object ${num} not found at offset ${e.off}`);
      lx = new Lexer(b, near); n = lx.next(); g = lx.next(); kw = lx.next();
    }
    const o = parseObj(lx, 0, this.sr(), num, isNum(g) ? g : 0);
    return this.sec && num !== this.encryptRef ? this.decryptObj(o, num, isNum(g) ? g : 0) : o;
  }
  private decryptObj(o: PObj, num: number, gen: number, depth = 0): PObj {
    if (depth > 64) return o;
    if (o instanceof PStr) return new PStr(this.sec!.decryptString(num, gen, o.b), o.hex);
    if (Array.isArray(o)) return o.map((x) => this.decryptObj(x, num, gen, depth + 1));
    if (o instanceof PDict) { const d = new PDict(); for (const [k, v] of o.m) d.set(k, this.decryptObj(v, num, gen, depth + 1)); return d; }
    if (o instanceof PStream) {
      const d = this.decryptObj(o.dict, num, gen, depth + 1) as PDict;
      if (isName(d.get("Type"), "XRef")) return new PStream(d, o.raw, num, gen); // xref streams are never encrypted
      if (isName(d.get("Type"), "Metadata") && !this.sec!.encryptMetadata) return new PStream(d, o.raw, num, gen);
      const raw = this.sec!.decryptStream(num, gen, o.raw, streamCryptName(d, (x) => this.resolve(x)));
      return new PStream(d, raw, num, gen);
    }
    return o;
  }
  private objstm(num: number) {
    const c = this.objstmCache.get(num); if (c) return c;
    const s = this.getObj(num); if (!isStream(s)) throw new Error(`object stream ${num} missing`);
    const n = this.resolve(s.dict.get("N")), first = this.resolve(s.dict.get("First"));
    if (!isNum(n) || !isNum(first) || n < 0 || n > 1_000_000) throw new Error("bad object stream");
    const data = this.decodeRaw(s).data; const lx = new Lexer(data, 0, Math.min(first, data.length));
    const nums: number[] = [], offs: number[] = [];
    for (let i = 0; i < n; i++) { const a = lx.next(), b = lx.next(); if (!isNum(a) || !isNum(b)) break; nums.push(a); offs.push(b); }
    const r = { offs, nums, first, data }; this.objstmCache.set(num, r); return r;
  }
  /** follow references (with a hop bound) */
  resolve(o: PObj | undefined): PObj | undefined {
    let hops = 0;
    while (o instanceof PRef) { if (++hops > 32) return null; o = this.getObj(o.num); }
    return o;
  }
  get(d: PDict | null | undefined, k: string): PObj | undefined { return d ? this.resolve(d.get(k)) : undefined; }
  dict(o: PObj | undefined): PDict | null { const r = this.resolve(o); return isDict(r) ? r : isStream(r) ? r.dict : null; }
  num(o: PObj | undefined, d = 0): number { const r = this.resolve(o); return isNum(r) ? r : d; }
  arr(o: PObj | undefined): PObj[] { const r = this.resolve(o); return isArr(r) ? r : []; }

  /* -------------------------------------------------------------- streams */
  /** decode a stream's byte filters (stops at an image codec, which is reported) */
  decode(s: PStream): { data: Bytes; partial: boolean; image: FilterSpec | null; unsupported?: string } {
    return applyFilters(s.raw, filterChain(s.dict, (x) => this.resolve(x)), MAX_STREAM);
  }
  private decodeRaw(s: PStream) { return applyFilters(s.raw, filterChain(s.dict, (x) => this.resolve(x)), MAX_STREAM); }
  /** decoded bytes of a stream or of an array of streams (content streams may be split, §7.8.2) */
  contentBytes(o: PObj | undefined): Bytes {
    const r = this.resolve(o);
    const parts: Bytes[] = [];
    const add = (x: PObj | undefined) => { const s = this.resolve(x); if (isStream(s)) { const d = this.decode(s); parts.push(d.data); } };
    if (isArr(r)) r.forEach(add); else add(r);
    const total = parts.reduce((n, p) => n + p.length + 1, 0); const out = new Uint8Array(total); let o2 = 0;
    for (const p of parts) { out.set(p, o2); o2 += p.length; out[o2++] = 10; } // streams are separated by whitespace when concatenated
    return out;
  }

  /* -------------------------------------------------------------- catalog, pages */
  catalog(): PDict | null { return this.dict(this.trailer.get("Root")); }
  info(): Record<string, string> {
    const i = this.dict(this.trailer.get("Info")); const out: Record<string, string> = {};
    if (i) for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) { const v = this.resolve(i.get(k)); if (v instanceof PStr) out[k] = textString(v); }
    return out;
  }
  pages(): PdfPage[] {
    if (this.pagesCache) return this.pagesCache;
    const out: PdfPage[] = []; const cat = this.catalog(); const seen = new Set<number>();
    type Inh = { res: PDict | null; media: number[] | null; crop: number[] | null; rot: number };
    const rect = (o: PObj | undefined): number[] | null => { const a = this.arr(o).map((x) => this.num(x, NaN)); return a.length === 4 && a.every(Number.isFinite) ? a : null; };
    const walk = (node: PObj | undefined, inh: Inh, depth: number) => {
      if (depth > 128 || out.length >= MAX_PAGES) return;
      const ref = node instanceof PRef ? node : null;
      if (ref) { if (seen.has(ref.num)) { this.warnings.push(`page tree cycle at object ${ref.num}`); return; } seen.add(ref.num); }
      const d = this.dict(node); if (!d) return;
      const res = this.dict(d.get("Resources")) ?? inh.res;
      const media = rect(d.get("MediaBox")) ?? inh.media; const crop = rect(d.get("CropBox")) ?? inh.crop;
      const rv = this.resolve(d.get("Rotate")); const rot = isNum(rv) ? rv : inh.rot;
      const kids = this.resolve(d.get("Kids")); const type = this.resolve(d.get("Type"));
      if (isArr(kids) && !isName(type, "Page")) { for (const k of kids) walk(k, { res, media, crop, rot }, depth + 1); return; }
      let mb = norm(media ?? [0, 0, 612, 792]);
      if (mb[2] - mb[0] < 1 || mb[3] - mb[1] < 1) mb = [0, 0, 612, 792]; // degenerate MediaBox: US Letter, like other viewers
      let cb = crop ? norm(crop) : mb;
      // CropBox is clipped to MediaBox (§14.11.2); an empty intersection falls back to MediaBox
      cb = [Math.max(cb[0], mb[0]), Math.max(cb[1], mb[1]), Math.min(cb[2], mb[2]), Math.min(cb[3], mb[3])];
      if (cb[2] <= cb[0] || cb[3] <= cb[1]) cb = mb;
      out.push({ index: out.length, ref, dict: d, media: mb, crop: cb as [number, number, number, number], rotate: (((Math.round(rot / 90) * 90) % 360) + 360) % 360, resources: res });
    };
    walk(cat?.get("Pages"), { res: null, media: null, crop: null, rot: 0 }, 0);
    if (!out.length) {
      // broken page tree: every /Type /Page object, in object-number order (what recovering viewers do)
      this.warnings.push("page tree unusable; pages collected by scanning objects");
      const nums = [...this.xref.keys()].sort((a, b) => a - b);
      for (const n of nums) {
        if (out.length >= MAX_PAGES) break;
        let o: PObj; try { o = this.getObj(n); } catch { continue; }
        if (isDict(o) && isName(o.get("Type"), "Page")) { seen.clear(); walk(new PRef(n, this.genOf(n)), { res: null, media: null, crop: null, rot: 0 }, 0); }
      }
    }
    this.pagesCache = out; return out;
  }
  invalidatePages() { this.pagesCache = null; }
  /** object number → generation for writers */
  genOf(num: number) { return this.xref.get(num)?.gen ?? 0; }
}
function norm(r: number[]): [number, number, number, number] { return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]; }

export { N, PName, PDict, PRef, PStr, PStream };
