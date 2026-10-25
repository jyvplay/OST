/**
 * TT75 — FF-10 EPUB reader, package layer (original code, written from EPUB 3.3 / OCF 3.3 / EPUB RS 3.3 and the
 * W3C epub-tests expectations; isomorphic: browser and Node ≥ 18). Nothing leaves the device.
 *
 *  OCF:  ZIP via zipkit (stored / deflate only; split or spanned archives refused), META-INF/container.xml → the FIRST
 *        rootfile whose media type is the package document; other META-INF files are ignored.
 *        Font obfuscation (META-INF/encryption.xml): IDPF (key = SHA-1 of the unique identifier with XML whitespace
 *        removed, XOR over the first 1040 bytes) and Adobe (key = the 16 bytes of the identifier's UUID, first 1024
 *        bytes). Any other encryption algorithm is DRM: those resources are refused (and a protected spine → error).
 *  OPF:  metadata (first dc:title is the title, creators in document order, whitespace collapsed, the unique
 *        identifier), manifest (hrefs resolved and percent-decoded; "../" clamps at the container root; a
 *        path-absolute href resolves from the container root), spine (duplicates stay distinct, linear="no" kept
 *        but marked, a commented-out itemref is ignored because comments are not elements), page-progression-
 *        direction, rendition:* globals with itemref overrides (the first conflicting property wins), manifest
 *        fallback chains for non-core spine items and images.
 *  Nav:  the EPUB 3 navigation document (toc, page-list, landmarks; hidden attributes are ignored; an image-only
 *        label uses its alt / title) whether or not it is in the spine; EPUB 2 NCX as fallback.
 */
import { openZip, type ZipArchive } from "../office/zipkit";
import { parseXml, attr, textOf, decText, type XEl, type XNode } from "../office/xmltree";

export class EpubError extends Error {}
export interface ManifestItem { id: string; path: string; mediaType: string; properties: string[]; fallback?: string; mediaOverlay?: string }
export type Layout = "reflowable" | "pre-paginated" | "roll";
export type Spread = "none" | "landscape" | "both" | "auto";
export interface SpineItem {
  index: number; idref: string; item: ManifestItem; linear: boolean; properties: string[];
  /** the manifest item actually shown (after the fallback chain for a non-core media type) */
  shown: ManifestItem | null;
  layout: Layout; spread: Spread; flow: string; pageSpread: "left" | "right" | "center" | null;
}
export interface NavPoint { label: string; href: string | null; children: NavPoint[] }
export interface EpubBook {
  opfPath: string; version: string; identifier: string; title: string; titles: string[]; creators: string[];
  language: string; publisher: string; description: string;
  manifest: Map<string, ManifestItem>; byPath: Map<string, ManifestItem>; spine: SpineItem[];
  direction: "ltr" | "rtl" | "default"; layout: Layout; spread: Spread; flow: string; orientation: string;
  toc: NavPoint[]; pageList: NavPoint[]; landmarks: NavPoint[]; navPath: string | null; coverPath: string | null;
  warnings: string[];
  /** resource bytes by container path (de-obfuscated; DRM-protected → EpubError) */
  read(path: string): Promise<Uint8Array | null>;
  readText(path: string): Promise<string | null>;
  has(path: string): boolean;
}

export const OPF_TYPE = "application/oebps-package+xml";
/** EPUB 3.3 core media types (images, audio, fonts, styles, content) */
export const CORE_IMAGE = new Set(["image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp"]);
export const CORE_SPINE = new Set(["application/xhtml+xml", "image/svg+xml"]);
const IDPF_ALG = "http://www.idpf.org/2008/embedding", ADOBE_ALG = "http://ns.adobe.com/pdf/enc#RC";
export const MAX_EPUB_BYTES = 512 << 20;

export const ln = (name: string) => name.slice(name.indexOf(":") + 1);
const els = (e: XEl): XEl[] => e.kids.filter((k): k is XEl => k.k === "el");
const byLn = (e: XEl | undefined, name: string) => (e ? els(e).filter((k) => ln(k.name) === name) : []);
/** attribute by local name (any prefix) */
export const attrLn = (e: XEl, name: string): string | undefined => { const a = e.attrs.find((x) => x[0] === name || ln(x[0]) === name && x[0].includes(":")); return a ? decText(a[1]) : undefined; };
export const collapse = (s: string) => s.replace(/[\t\n\r ]+/g, " ").trim();

/** URL/IRI-ish href → container path. Returns null for absolute URLs (scheme) and empty paths. Fragment kept apart. */
export function resolveHref(fromPath: string, href: string): { path: string; frag: string } | null {
  const h = href.trim(); if (!h) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(h)) return null;
  const hashAt = h.indexOf("#"); const frag = hashAt >= 0 ? h.slice(hashAt + 1) : "";
  let p = hashAt >= 0 ? h.slice(0, hashAt) : h; p = p.replace(/\?.*$/, "");
  if (p.startsWith("//")) return null; // network-path reference
  if (!p) return { path: fromPath, frag: safeDecode(frag) };
  const segs = p.startsWith("/") ? [] : fromPath.split("/").slice(0, -1);
  for (const raw of p.split("/")) {
    const s = safeDecode(raw);
    if (s === "" || s === ".") continue;
    if (s === "..") { segs.pop(); continue; } // clamps at the root
    segs.push(s);
  }
  return { path: segs.join("/"), frag: safeDecode(frag) };
}
const safeDecode = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** text of an XML/XHTML resource: BOM-aware UTF-8 / UTF-16 */
export function decodeText(b: Uint8Array): string {
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b.subarray(2));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b.subarray(2));
  return new TextDecoder("utf-8").decode(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b);
}
export function parseXmlStrict(text: string, what: string): XEl {
  try { return parseXml(text).root; } catch (e) { throw new EpubError(`${what} is not well-formed XML (${(e as Error).message})`); }
}

function checkArchive(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) !== 0x06054b50) continue;
    if (dv.getUint16(i + 4, true) !== 0 || dv.getUint16(i + 6, true) !== 0 || dv.getUint16(i + 8, true) !== dv.getUint16(i + 10, true))
      throw new EpubError("this EPUB is a split / spanned ZIP archive, which OCF does not allow");
    return;
  }
  throw new EpubError("not an EPUB: no ZIP end-of-central-directory record");
}

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-1", data as Uint8Array<ArrayBuffer>));
}
/** XOR de-obfuscation (its own inverse) */
export function xorPrefix(data: Uint8Array, key: Uint8Array, n: number): Uint8Array {
  const out = data.slice(); const m = Math.min(n, out.length);
  for (let i = 0; i < m; i++) out[i] ^= key[i % key.length];
  return out;
}
export async function idpfKey(uniqueId: string): Promise<Uint8Array> { return sha1(new TextEncoder().encode(uniqueId.replace(/[\x20\x09\x0d\x0a]/g, ""))); }
export function adobeKey(uniqueId: string): Uint8Array | null {
  const hex = uniqueId.replace(/^urn:uuid:/i, "").replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 32) return null;
  return Uint8Array.from({ length: 16 }, (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16));
}

function parseNavList(ol: XEl | undefined, base: string, depth = 0): NavPoint[] {
  if (!ol || depth > 32) return [];
  const out: NavPoint[] = [];
  for (const li of byLn(ol, "li")) {
    const head = els(li).find((k) => ln(k.name) === "a" || ln(k.name) === "span");
    const sub = byLn(li, "ol")[0];
    let label = head ? collapse(textOf(head)) : "";
    if (head && !label) { // image-only (or empty) label → alt / title text
      const img = findDeep(head, (x) => ["img", "image", "svg"].includes(ln(x.name)));
      label = collapse((img && (attrLn(img, "alt") ?? attrLn(img, "title"))) || attrLn(head, "title") || "");
    }
    const href = head && ln(head.name) === "a" ? attrLn(head, "href") : undefined;
    const r = href ? resolveHref(base, href) : null;
    out.push({ label: label || "(untitled)", href: r ? r.path + (r.frag ? `#${r.frag}` : "") : href && /^[a-z]+:/i.test(href) ? href : null, children: parseNavList(sub, base, depth + 1) });
  }
  return out;
}
function findDeep(e: XEl, pred: (x: XEl) => boolean, depth = 0): XEl | undefined {
  if (depth > 64) return undefined;
  for (const k of els(e)) { if (pred(k)) return k; const f = findDeep(k, pred, depth + 1); if (f) return f; }
  return undefined;
}
function findAllDeep(e: XEl, pred: (x: XEl) => boolean, out: XEl[] = [], depth = 0): XEl[] {
  if (depth > 256) return out;
  for (const k of els(e)) { if (pred(k)) out.push(k); findAllDeep(k, pred, out, depth + 1); }
  return out;
}
const epubType = (e: XEl) => (e.attrs.find((a) => ln(a[0]) === "type" && a[0].includes(":"))?.[1] ?? "").split(/\s+/);

export function parseNavDoc(xhtml: string, navPath: string) {
  const root = parseXmlStrict(stripDoctype(xhtml), "the navigation document");
  const navs = findAllDeep(root, (x) => ln(x.name) === "nav");
  const pick = (t: string) => { const n = navs.find((x) => epubType(x).includes(t)); return n ? parseNavList(byLn(n, "ol")[0] ?? findDeep(n, (x) => ln(x.name) === "ol"), navPath) : []; };
  return { toc: pick("toc"), pageList: pick("page-list"), landmarks: pick("landmarks") };
}
export function parseNcx(xml: string, ncxPath: string): NavPoint[] {
  const root = parseXmlStrict(stripDoctype(xml), "the NCX");
  const walk = (e: XEl | undefined, d: number): NavPoint[] => (e && d < 32 ? byLn(e, "navPoint").map((np) => {
    const src = byLn(np, "content")[0] ? attrLn(byLn(np, "content")[0], "src") : undefined; const r = src ? resolveHref(ncxPath, src) : null;
    return { label: collapse(textOf(byLn(byLn(np, "navLabel")[0] ?? np, "text")[0] ?? np)) || "(untitled)", href: r ? r.path + (r.frag ? `#${r.frag}` : "") : null, children: walk(np, d + 1) };
  }) : []);
  return walk(byLn(root, "navMap")[0], 0);
}

/** drop a DOCTYPE (and its internal subset): entities declared there are NOT expanded (no external entities) */
export function stripDoctype(s: string): string {
  return s.replace(/<!DOCTYPE(?:[^[>]|\[[\s\S]*?\])*>/i, "");
}

export async function openEpub(input: Uint8Array): Promise<EpubBook> {
  if (input.length > MAX_EPUB_BYTES) throw new EpubError("the file exceeds the 512 MiB guard");
  checkArchive(input);
  let zip: ZipArchive;
  try { zip = openZip(input); } catch (e) { throw new EpubError(`not a readable EPUB (${(e as Error).message})`); }
  const warnings: string[] = [];
  const odd = zip.entries.find((e) => e.method !== 0 && e.method !== 8);
  if (odd) throw new EpubError(`${odd.name} uses ZIP compression method ${odd.method}; OCF allows only stored or Deflate (W3C ocf-zip-comp)`);
  const mt = zip.entries[0];
  if (!mt || mt.name !== "mimetype") warnings.push("the mimetype file is not the first entry");
  else if (mt.method !== 0) warnings.push("the mimetype file is compressed");
  const rawRead = async (path: string) => { try { return await zip.read(path); } catch (e) { throw new EpubError(`${path}: ${(e as Error).message}`); } };
  const containerBytes = await rawRead("META-INF/container.xml");
  if (!containerBytes) throw new EpubError("not an EPUB: META-INF/container.xml is missing");
  const container = parseXmlStrict(decodeText(containerBytes), "META-INF/container.xml");
  const rootfiles = findAllDeep(container, (x) => ln(x.name) === "rootfile");
  const rf = rootfiles.find((r) => (attrLn(r, "media-type") ?? "") === OPF_TYPE) ?? rootfiles[0];
  const opfPath = rf ? resolveHref("", attrLn(rf, "full-path") ?? "")?.path ?? "" : "";
  if (!opfPath) throw new EpubError("container.xml names no package document");
  const opfBytes = await rawRead(opfPath);
  if (!opfBytes) throw new EpubError(`the package document ${opfPath} is missing`);
  const opf = parseXmlStrict(stripDoctype(decodeText(opfBytes)), "the package document");
  const version = attrLn(opf, "version") ?? attr(opf, "version") ?? "";
  const md = byLn(opf, "metadata")[0];
  const mdEls = md ? els(md).flatMap((e) => (ln(e.name) === "dc-metadata" || ln(e.name) === "x-metadata" ? els(e) : [e])) : [];
  const dc = (n: string) => mdEls.filter((e) => ln(e.name) === n && e.name.includes(":") || e.name === `dc:${n}`).map((e) => collapse(textOf(e))).filter(Boolean);
  const uidRef = attr(opf, "unique-identifier");
  const idEl = mdEls.find((e) => ln(e.name) === "identifier" && attr(e, "id") === uidRef) ?? mdEls.find((e) => ln(e.name) === "identifier");
  const identifier = idEl ? textOf(idEl).trim() : "";
  const metaProp = (p: string) => { const m = mdEls.find((e) => ln(e.name) === "meta" && attr(e, "property") === p && !attr(e, "refines")); return m ? collapse(textOf(m)) : ""; };
  const titles = dc("title");

  const manifest = new Map<string, ManifestItem>(); const byPath = new Map<string, ManifestItem>();
  for (const it of byLn(byLn(opf, "manifest")[0], "item")) {
    const id = attr(it, "id"), href = attr(it, "href"); if (!id || href === undefined || manifest.has(id)) continue;
    const r = resolveHref(opfPath, href); if (!r) continue; // remote resources are not package resources
    const item: ManifestItem = { id, path: r.path, mediaType: (attr(it, "media-type") ?? "").toLowerCase().trim(), properties: (attr(it, "properties") ?? "").split(/\s+/).filter(Boolean), fallback: attr(it, "fallback"), mediaOverlay: attr(it, "media-overlay") };
    manifest.set(id, item); if (!byPath.has(item.path)) byPath.set(item.path, item);
  }
  // encryption.xml → obfuscated fonts / DRM
  const obf = new Map<string, "idpf" | "adobe">(); const drm = new Set<string>();
  const encBytes = await rawRead("META-INF/encryption.xml");
  if (encBytes) {
    try {
      const enc = parseXmlStrict(decodeText(encBytes), "META-INF/encryption.xml");
      for (const ed of findAllDeep(enc, (x) => ln(x.name) === "EncryptedData")) {
        const alg = findDeep(ed, (x) => ln(x.name) === "EncryptionMethod"); const ref = findDeep(ed, (x) => ln(x.name) === "CipherReference");
        const uri = ref ? attr(ref, "URI") : undefined; const r = uri ? resolveHref("", uri) : null; if (!r) continue;
        const a = alg ? attr(alg, "Algorithm") : "";
        if (a === IDPF_ALG) obf.set(r.path, "idpf"); else if (a === ADOBE_ALG) obf.set(r.path, "adobe"); else drm.add(r.path);
      }
    } catch (e) { warnings.push((e as Error).message); }
  }
  const keys: { idpf?: Uint8Array; adobe?: Uint8Array | null } = {};
  const read = async (path: string): Promise<Uint8Array | null> => {
    if (drm.has(path)) throw new EpubError(`${path} is encrypted (DRM) — this reader opens only unprotected books`);
    const b = await rawRead(path); if (!b) return null;
    const kind = obf.get(path); if (!kind) return b;
    if (kind === "idpf") { keys.idpf ??= await idpfKey(identifier); return xorPrefix(b, keys.idpf, 1040); }
    if (keys.adobe === undefined) keys.adobe = adobeKey(identifier);
    return keys.adobe ? xorPrefix(b, keys.adobe, 1024) : b;
  };

  // rendition globals (first declaration wins)
  const pick = <T extends string>(v: string, allowed: readonly T[], dflt: T): T => (allowed as readonly string[]).includes(v) ? v as T : dflt;
  // "roll" (EPUB RS 3.3 §roll layouts): the documents form one continuous vertical strip with no gaps
  const layout = pick(metaProp("rendition:layout"), ["reflowable", "pre-paginated", "roll"] as const, "reflowable");
  const spread = pick(metaProp("rendition:spread") === "portrait" ? "both" : metaProp("rendition:spread"), ["none", "landscape", "both", "auto"] as const, "auto");
  const flow = pick(metaProp("rendition:flow"), ["paginated", "scrolled-continuous", "scrolled-doc", "auto"] as const, "auto");
  const orientation = pick(metaProp("rendition:orientation"), ["landscape", "portrait", "auto"] as const, "auto");

  const spineEl = byLn(opf, "spine")[0];
  const ppd = attr(spineEl ?? opf, "page-progression-direction");
  const direction = ppd === "rtl" || ppd === "ltr" ? ppd : "default";
  const shownFor = (it: ManifestItem): ManifestItem | null => {
    const seen = new Set<string>(); let cur: ManifestItem | undefined = it;
    while (cur && !seen.has(cur.id)) { if (CORE_SPINE.has(cur.mediaType)) return cur; seen.add(cur.id); cur = cur.fallback ? manifest.get(cur.fallback) : undefined; }
    return null;
  };
  const spine: SpineItem[] = [];
  for (const ir of byLn(spineEl, "itemref")) {
    const idref = attr(ir, "idref"); const item = idref ? manifest.get(idref) : undefined; if (!item) { warnings.push(`spine itemref ${idref} has no manifest item`); continue; }
    const props = (attr(ir, "properties") ?? "").split(/\s+/).filter(Boolean);
    const first = <T extends string>(prefix: string, allowed: readonly T[]): T | null => { for (const p of props) { const v = p.startsWith(prefix) ? p.slice(prefix.length) : null; if (v && (allowed as readonly string[]).includes(v)) return v as T; } return null; };
    const ps = props.map((p) => p.replace(/^rendition:/, "")).find((p) => /^page-spread-(left|right|center)$/.test(p));
    spine.push({
      index: spine.length, idref: idref!, item, linear: attr(ir, "linear") !== "no", properties: props, shown: shownFor(item),
      layout: first("rendition:layout-", ["reflowable", "pre-paginated", "roll"] as const) ?? layout,
      spread: first("rendition:spread-", ["none", "landscape", "both", "auto"] as const) ?? spread,
      flow: first("rendition:flow-", ["paginated", "scrolled-continuous", "scrolled-doc", "auto"] as const) ?? flow,
      pageSpread: ps ? ps.slice("page-spread-".length) as "left" | "right" | "center" : null,
    });
  }
  if (!spine.length) throw new EpubError("the spine is empty — nothing to read");
  for (const s of spine) if (drm.has(s.item.path)) throw new EpubError("this book is DRM-protected (its content is encrypted) — only unprotected EPUBs can be opened");

  // navigation: EPUB 3 nav (in the spine or not), else NCX
  let toc: NavPoint[] = [], pageList: NavPoint[] = [], landmarks: NavPoint[] = [];
  const navItem = [...manifest.values()].find((m) => m.properties.includes("nav"));
  if (navItem) {
    try { const t = await read(navItem.path); if (t) ({ toc, pageList, landmarks } = parseNavDoc(decodeText(t), navItem.path)); }
    catch (e) { warnings.push(`navigation document: ${(e as Error).message}`); }
  }
  if (!toc.length) {
    const ncxId = spineEl ? attr(spineEl, "toc") : undefined;
    const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find((m) => m.mediaType === "application/x-dtbncx+xml");
    if (ncx) { try { const t = await read(ncx.path); if (t) toc = parseNcx(decodeText(t), ncx.path); } catch (e) { warnings.push(`NCX: ${(e as Error).message}`); } }
  }
  const coverItem = [...manifest.values()].find((m) => m.properties.includes("cover-image"))
    ?? (() => { const m = mdEls.find((e) => ln(e.name) === "meta" && attr(e, "name") === "cover"); const id = m ? attr(m, "content") : undefined; return id ? manifest.get(id) : undefined; })();

  return {
    opfPath, version, identifier, title: titles[0] ?? "Untitled", titles, creators: dc("creator"), language: dc("language")[0] ?? "",
    publisher: dc("publisher")[0] ?? "", description: dc("description")[0] ?? "",
    manifest, byPath, spine, direction, layout, spread, flow, orientation, toc, pageList, landmarks,
    navPath: navItem?.path ?? null, coverPath: coverItem && CORE_IMAGE.has(coverItem.mediaType) ? coverItem.path : null, warnings,
    read, readText: async (p) => { const b = await read(p); return b ? decodeText(b) : null; }, has: (p) => zip.has(p),
  };
}

/** spine index of a container path (first match: duplicate spine items link to the first) */
export const spineIndexOf = (book: EpubBook, path: string) => book.spine.findIndex((s) => s.item.path === path || s.shown?.path === path);

/** plain text of an XHTML chapter (search, word counts) — body only, block boundaries become newlines */
export function chapterText(xhtml: string): string {
  let root: XEl; try { root = parseXml(stripDoctype(xhtml)).root; } catch { return ""; }
  const body = findDeep(root, (x) => ln(x.name) === "body") ?? root;
  const BLOCK = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "br", "tr", "section", "blockquote", "pre", "dt", "dd", "figcaption"]);
  const out: string[] = [];
  const walk = (n: XNode, d: number) => {
    if (d > 256) return;
    if (n.k === "text") { out.push(decText(n.raw)); return; }
    if (n.k !== "el") return;
    const name = ln(n.name); if (name === "script" || name === "style") return;
    for (const k of n.kids) walk(k, d + 1);
    if (BLOCK.has(name)) out.push("\n");
  };
  walk(body, 0);
  return out.join("").replace(/[ \t\r]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Fixed-layout spreads (EPUB 3.3 rendition:spread / page-spread-*): groups of spine indices shown together. A pair is
 * [first-in-reading-order, second]; with ltr progression the first sits on the left, with rtl on the right.
 * page-spread-center (and reflowable items, and spread "none" / "landscape" in portrait) stand alone. Unmarked pages
 * alternate, the first page taking the "second" slot (a cover alone, as reading systems do).
 */
export interface SpreadSlot { first: number | null; second: number | null; single: boolean }
export function spreadGroups(book: Pick<EpubBook, "spine" | "direction" | "language">, landscape: boolean): SpreadSlot[] {
  const out: SpreadSlot[] = []; const rtl = progression(book) === "rtl";
  const firstSide = rtl ? "right" : "left", secondSide = rtl ? "left" : "right";
  let pending: number | null = null; let nextSide: string = secondSide;
  const flush = () => { if (pending !== null) { out.push({ first: pending, second: null, single: false }); pending = null; } };
  for (const s of book.spine) {
    const on = s.layout === "pre-paginated" && (s.spread === "both" || ((s.spread === "landscape" || s.spread === "auto") && landscape));
    if (!on || s.pageSpread === "center") { flush(); out.push({ first: s.index, second: null, single: true }); nextSide = secondSide; continue; }
    const side = s.pageSpread ?? nextSide;
    if (side === firstSide) { flush(); pending = s.index; nextSide = secondSide; }
    else { if (pending !== null) { out.push({ first: pending, second: s.index, single: false }); pending = null; } else out.push({ first: null, second: s.index, single: false }); nextSide = firstSide; }
  }
  flush();
  return out;
}

/** scripts written right to left (BCP 47 primary subtags) */
const RTL_LANGS = new Set(["ar", "arc", "ckb", "dv", "fa", "ha", "he", "iw", "khw", "ks", "ku", "ps", "sd", "syr", "ug", "ur", "yi"]);
/**
 * Effective page progression: the spine's page-progression-direction; when "default", the publication language decides
 * (an Arabic / Hebrew / Persian / Urdu … book reads right to left — W3C pkg-spine-progression-default).
 */
export function progression(book: Pick<EpubBook, "direction" | "language">): "ltr" | "rtl" {
  if (book.direction !== "default") return book.direction;
  const lang = book.language.toLowerCase().split(/[-_]/)[0];
  return RTL_LANGS.has(lang) || /^[a-z]{2,3}-(arab|hebr|syrc|thaa|nkoo|adlm)\b/i.test(book.language) ? "rtl" : "ltr";
}
/** XML 1.0 + Namespaces QName check (an element named a::b is an error — W3C pub-xml-names) */
export const QNAME = /^[A-Za-z_\u00C0-\uFFFF][\w.\-\u00B7\u00C0-\uFFFF]*(?::[A-Za-z_\u00C0-\uFFFF][\w.\-\u00B7\u00C0-\uFFFF]*)?$/;
