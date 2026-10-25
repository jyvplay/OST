/**
 * TT75 — FF-10 EPUB reader, content layer (original code). Turns one spine document into a self-contained, script-free
 * XHTML (or SVG) document for a sandboxed frame. Isomorphic: resource URLs come from the caller (`urlFor` → blob: URLs
 * in the browser, plain tokens in tests), so the whole sanitiser is testable headless.
 *
 *  - Well-formedness is required (EPUB content is XML): a parse error is reported, the chapter is not guessed at.
 *  - The DOCTYPE goes (its entities are never expanded — no external entities); the XHTML 1.x named entities that
 *    EPUB 2 books use become numeric references; any other undeclared entity is dropped (and noted).
 *  - Removed: script, base, meta refresh, handler attributes (on*), javascript:/vbscript:/data:text/html URLs,
 *    srcdoc, target, iframe/frame/embed/applet (object is replaced by its fallback content unless it shows an image).
 *  - Resources (img/src+srcset, svg image/use href, audio/video/source/track, poster, object data, linked
 *    stylesheets) must be manifest items (or data: images): anything else — remote URLs, file:, items not in the
 *    manifest — is not loaded. Non-core image types follow their manifest fallback chain.
 *  - CSS (linked, <style>, style="…"): url() rewritten the same way, internal @import inlined (depth ≤ 8), remote
 *    @import dropped, and the -epub- prefixed properties mapped to their standard names (EPUB 3.3 §6.3.2).
 *  - Links get data-epub-href (container path + fragment) or data-epub-ext (http/https/mailto, opened only after the
 *    reader asks); the frame never navigates by itself.
 *  - A CSP meta is the first child of <head>: default-src 'none' plus blob:/data: for images, media, styles, fonts.
 */
import { parseXml, serializeEl, decText, encAttr, type XEl, type XNode } from "../office/xmltree";
import { XHTML_ENTITIES } from "./entities";
import { CORE_IMAGE, EpubError, QNAME, ln, resolveHref, stripDoctype, type EpubBook, type ManifestItem } from "./epub-core";

export const READER_CSP = "default-src 'none'; img-src blob: data:; media-src blob:; style-src 'unsafe-inline' blob:; font-src blob: data:";
export interface PrepareOpts {
  /** URL for a container resource (already de-obfuscated); null = do not load */
  urlFor(path: string, item: ManifestItem): Promise<string | null>;
  /** extra CSS appended last in <head> (reader preferences) */
  readerCss?: string;
}
export interface Prepared { doc: string; mediaType: "application/xhtml+xml" | "image/svg+xml"; notes: string[]; ids: string[] }

const XHTML_NS = "http://www.w3.org/1999/xhtml";
// TT75: every book <meta http-equiv> is dropped (refresh, set-cookie, the book's own Content-Security-Policy — the frame
// carries exactly one policy, the reader's)
const DROP = new Set(["script", "base", "iframe", "frame", "frameset", "embed", "applet", "noscript", "portal"]);
const URL_ATTRS: Record<string, string[]> = {
  img: ["src"], image: ["href"], audio: ["src"], video: ["src", "poster"], source: ["src"], track: ["src"],
  input: ["src"], object: ["data"], use: ["href"], feImage: ["href"], script: [], link: ["href"],
};
const MEDIA_EL = new Set(["audio", "video", "source", "track"]);

/** entity references: XML predefined and numeric stay; XHTML named → numeric; unknown → removed */
export function fixEntities(s: string, notes: string[]): string {
  let unknown = 0;
  const out = s.replace(/&([A-Za-z_][\w.-]*);/g, (m, name: string) => {
    if (name === "amp" || name === "lt" || name === "gt" || name === "quot" || name === "apos") return m;
    const cp = XHTML_ENTITIES[name]; if (cp !== undefined) return `&#${cp};`;
    unknown++; return "";
  });
  if (unknown) notes.push(`${unknown} undeclared entity reference(s) were not expanded`);
  return out;
}

export const EPUB_CSS_PROPS: Record<string, string> = {
  "-epub-hyphens": "hyphens", "-epub-line-break": "line-break", "-epub-text-align-last": "text-align-last", "-epub-word-break": "word-break",
  "-epub-writing-mode": "writing-mode", "-epub-text-orientation": "text-orientation", "-epub-text-combine": "text-combine-upright",
  "-epub-text-combine-horizontal": "text-combine-upright", "-epub-text-emphasis": "text-emphasis", "-epub-text-emphasis-color": "text-emphasis-color",
  "-epub-text-emphasis-position": "text-emphasis-position", "-epub-text-emphasis-style": "text-emphasis-style",
  "-epub-text-underline-position": "text-underline-position", "-epub-text-transform": "text-transform",
};
/** -epub- properties → standard; values: text-combine "horizontal" → "all", "-epub-fullwidth" → "full-width", "vertical-rl" etc. pass through */
export function mapEpubCss(css: string): string {
  return css.replace(/(^|[{;\s])(-epub-[a-z-]+)(\s*:\s*)([^;}]*)/g, (m, pre: string, prop: string, colon: string, val: string) => {
    const std = EPUB_CSS_PROPS[prop]; if (!std) return m;
    let v = val.replace(/-epub-fullwidth/g, "full-width");
    if (std === "text-combine-upright") v = v.replace(/^\s*horizontal\b.*$/, "all");
    if (std === "text-orientation") v = v.replace(/\bvertical-right\b/, "mixed").replace(/\brotate-right\b/, "sideways");
    return `${pre}${std}${colon}${v}`;
  }).replace(/(^|[:\s])-epub-fullwidth\b/g, "$1full-width");
}

const isDataImage = (u: string) => /^data:image\/(png|jpe?g|gif|webp|svg\+xml|avif)[;,]/i.test(u.trim());
const BAD_URL = /^\s*(javascript|vbscript|livescript|file):|^\s*data:(?!image\/|font\/|application\/font|application\/x-font|audio\/|video\/)/i;

export async function processCss(css: string, cssPath: string, book: EpubBook, opts: PrepareOpts, notes: string[], depth = 0, seen = new Set<string>()): Promise<string> {
  if (depth > 8) return "";
  let out = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // @import
  const imports = [...out.matchAll(/@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*([^;]*);?/gi)];
  for (const m of imports) {
    const href = (m[2] ?? m[4] ?? "").trim(); const media = (m[5] ?? "").trim(); let rep = "";
    const r = resolveHref(cssPath, href);
    if (r && !seen.has(r.path) && book.byPath.get(r.path)?.mediaType === "text/css") {
      const t = await book.readText(r.path).catch(() => null);
      if (t !== null) { const inner = await processCss(t, r.path, book, opts, notes, depth + 1, new Set([...seen, r.path])); rep = media ? `@media ${media} {\n${inner}\n}` : inner; }
    } else if (!r) notes.push(`a remote stylesheet import (${href.slice(0, 80)}) was not loaded`);
    out = out.replace(m[0], () => rep);
  }
  // url()
  const urls = [...new Set([...out.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)].map((m) => m[0]))];
  for (const whole of urls) {
    const raw = /url\(\s*(['"]?)([^'")]*)\1\s*\)/i.exec(whole)![2].trim(); let rep = "none";
    if (/^data:(image|font|application\/(x-)?font)/i.test(raw)) rep = whole;
    else if (raw.startsWith("#")) rep = whole; // SVG paint server / filter references
    else { const r = resolveHref(cssPath, raw); const it = r ? book.byPath.get(r.path) : undefined; const u = it ? await opts.urlFor(it.path, it) : null; if (u) rep = `url("${u}")`; else if (!r) notes.push("a remote resource referenced from CSS was not loaded"); }
    out = out.split(whole).join(rep);
  }
  return mapEpubCss(out);
}

/** follow the manifest fallback chain of an image to a core image type */
function imageItem(book: EpubBook, it: ManifestItem | undefined): ManifestItem | undefined {
  const seen = new Set<string>(); let cur = it;
  while (cur && !seen.has(cur.id)) { if (CORE_IMAGE.has(cur.mediaType) || cur.mediaType === "image/avif") return cur; seen.add(cur.id); cur = cur.fallback ? book.manifest.get(cur.fallback) : undefined; }
  return undefined;
}

export async function prepareChapter(book: EpubBook, path: string, opts: PrepareOpts): Promise<Prepared> {
  const notes: string[] = [];
  const item = book.byPath.get(path);
  const text = await book.readText(path);
  if (text === null) throw new EpubError(`${path} is missing from the book`);
  const isSvg = item?.mediaType === "image/svg+xml";
  let root: XEl;
  try { root = parseXml(fixEntities(stripDoctype(text), notes)).root; }
  catch (e) { throw new EpubError(`this chapter (${path}) is not well-formed XML, so it cannot be shown: ${(e as Error).message}`); }
  const badName = (e: XEl, d: number): string | null => { if (!QNAME.test(e.name)) return e.name; if (d > 512) return null; for (const k of e.kids) if (k.k === "el") { const b = badName(k, d + 1); if (b) return b; } for (const [a] of e.attrs) if (!QNAME.test(a)) return a; return null; };
  const bad = badName(root, 0);
  if (bad) throw new EpubError(`this chapter (${path}) is not well-formed XML, so it cannot be shown: invalid name "${bad.slice(0, 40)}"`);
  const ids: string[] = [];
  const cssJobs: Promise<void>[] = [];

  const setA = (e: XEl, name: string, v: string | null) => {
    const i = e.attrs.findIndex((a) => a[0] === name);
    if (v === null) { if (i >= 0) { e.attrs.splice(i, 1); e.quote.splice(i, 1); e.ws?.splice(i, 1); e.eq?.splice(i, 1); } return; }
    if (i >= 0) e.attrs[i][1] = encAttr(v); else { e.attrs.push([name, encAttr(v)]); e.quote.push('"'); e.ws?.splice(e.ws.length - 1, 0, " "); e.eq?.push("="); }
  };
  const resourceUrl = async (raw: string, forImage: boolean): Promise<string | null> => {
    const v = raw.trim(); if (!v) return null;
    if (forImage && isDataImage(v)) return v;
    if (v.startsWith("#")) return v;
    const r = resolveHref(path, v); if (!r) return null; // remote / other schemes are not loaded
    let it = book.byPath.get(r.path); if (!it) { notes.push(`${r.path} is not in the manifest, so it is not shown`); return null; }
    if (forImage) { it = imageItem(book, it); if (!it) return null; }
    const u = await opts.urlFor(it.path, it); return u ? u + (r.frag ? `#${r.frag}` : "") : null;
  };

  const walk = async (e: XEl, depth: number): Promise<void> => {
    if (depth > 512) { e.kids = []; return; }
    const next: XNode[] = [];
    for (const k of e.kids) {
      if (k.k === "raw") { if (k.raw.startsWith("<![CDATA[")) next.push(k); continue; } // comments / PIs go
      if (k.k === "text") { next.push(k); continue; }
      const name = ln(k.name);
      if ((name === "set" || name === "animate") && /href$/i.test(decText(k.attrs.find((a) => a[0] === "attributeName")?.[1] ?? ""))) continue; // SVG link retargeting
      if (DROP.has(name) || (name === "meta" && /\S/.test(decText(k.attrs.find((a) => a[0].toLowerCase() === "http-equiv")?.[1] ?? "")))) continue;
      if (name === "object") {
        const data = k.attrs.find((a) => a[0] === "data")?.[1] ?? ""; const type = decText(k.attrs.find((a) => a[0] === "type")?.[1] ?? "");
        const r = data ? resolveHref(path, decText(data)) : null; const it = r ? imageItem(book, book.byPath.get(r.path)) : undefined;
        if (!(it && (type.startsWith("image/") || !type))) { await walk(k, depth + 1); next.push(...k.kids); continue; } // fallback content
      }
      // attributes
      for (const [an] of [...k.attrs]) {
        const lname = ln(an).toLowerCase(); const val = decText(k.attrs.find((a) => a[0] === an)?.[1] ?? "");
        if (lname.startsWith("on") || lname === "srcdoc" || lname === "target" || lname === "formaction" || lname === "action" || lname === "ping") { setA(k, an, null); continue; }
        // browsers ignore ASCII whitespace / controls inside a URL scheme ("java\tscript:"), so test without them
        if (BAD_URL.test(val.replace(/[\x00-\x20]/g, "")) && /^(href|src|data|poster|action|background|cite|longdesc|usemap|srcset|xlink:href|to|from|values)$/i.test(ln(an))) { setA(k, an, null); continue; }
      }
      if (k.attrs.some((a) => a[0] === "id")) ids.push(decText(k.attrs.find((a) => a[0] === "id")![1]));
      const urlAttrs = URL_ATTRS[name] ?? [];
      for (const an of [...k.attrs.map((a) => a[0])]) {
        const lname = ln(an);
        if (name === "link") continue;
        if (urlAttrs.includes(lname) && (lname !== "href" || name !== "a")) {
          const v = decText(k.attrs.find((a) => a[0] === an)![1]);
          const u = await resourceUrl(v, name === "img" || name === "image" || name === "input" || name === "object" || (name === "video" && lname === "poster") || name === "feImage");
          if (name === "use" && v.startsWith("#")) continue;
          setA(k, an, u);
          if (!u && MEDIA_EL.has(name)) notes.push("a media resource that is not in the book was not loaded");
        }
        if (lname === "srcset") {
          const parts = decText(k.attrs.find((a) => a[0] === an)![1]).split(",").map((p) => p.trim()).filter(Boolean);
          const kept: string[] = [];
          for (const p of parts) { const [u, ...d] = p.split(/\s+/); const nu = await resourceUrl(u, true); if (nu) kept.push([nu, ...d].join(" ")); }
          setA(k, an, kept.length ? kept.join(", ") : null);
        }
        if (lname === "style") { const v = decText(k.attrs.find((a) => a[0] === an)![1]); cssJobs.push(processCss(v, path, book, opts, notes).then((c) => setA(k, an, c.replace(/@import[^;]*;?/gi, "")))); }
      }
      if (name === "a" || (name === "area")) {
        const hrefAttr = k.attrs.find((a) => ln(a[0]) === "href")?.[0];
        if (hrefAttr) {
          const v = decText(k.attrs.find((a) => a[0] === hrefAttr)![1]).trim();
          if (/^(https?|mailto):/i.test(v)) {
            // TT75: the address lives ONLY in data-epub-ext — even if the reader's click handler were missing, the
            // frame could not navigate to it (href "#"); hover shows it through title
            setA(k, "data-epub-ext", v); setA(k, hrefAttr, "#"); if (!k.attrs.some((a) => ln(a[0]) === "title")) setA(k, "title", v);
          }
          else { const r = resolveHref(path, v); if (r) { setA(k, "data-epub-href", r.path + (r.frag ? `#${r.frag}` : "")); setA(k, hrefAttr, r.path === path && r.frag ? `#${r.frag}` : "#"); } else setA(k, hrefAttr, null); }
        }
      }
      if (name === "link") {
        const rel = decText(k.attrs.find((a) => a[0] === "rel")?.[1] ?? "").toLowerCase().split(/\s+/);
        const href = decText(k.attrs.find((a) => a[0] === "href")?.[1] ?? "");
        const r = href ? resolveHref(path, href) : null; const it = r ? book.byPath.get(r.path) : undefined;
        if (rel.includes("stylesheet") && !rel.includes("alternate") && it && it.mediaType === "text/css") {
          const style: XEl = { k: "el", name: isSvg ? "style" : "style", attrs: [], quote: [], kids: [], selfClose: false };
          const media = k.attrs.find((a) => a[0] === "media"); if (media) { style.attrs.push(["media", media[1]]); style.quote.push('"'); }
          cssJobs.push(book.readText(it.path).then((t) => (t === null ? "" : processCss(t, it.path, book, opts, notes))).then((c) => { style.kids = [{ k: "text", raw: escStyle(c) }]; }).catch(() => { /* unreadable stylesheet */ }));
          next.push(style);
        } else if (href && !rel.includes("stylesheet")) { /* icons, alternates, prefetch: not loaded */ }
        continue;
      }
      if (name === "style") {
        const css = k.kids.map((x) => (x.k === "text" ? decText(x.raw) : x.k === "raw" && x.raw.startsWith("<![CDATA[") ? x.raw.slice(9, -3) : "")).join("");
        cssJobs.push(processCss(css, path, book, opts, notes).then((c) => { k.kids = [{ k: "text", raw: escStyle(c) }]; }));
      }
      await walk(k, depth + 1);
      next.push(k);
    }
    e.kids = next;
  };
  await walk(root, 0);
  await Promise.all(cssJobs);

  if (isSvg || ln(root.name) === "svg") {
    if (!root.attrs.some((a) => a[0] === "xmlns")) { root.attrs.unshift(["xmlns", "http://www.w3.org/2000/svg"]); root.quote.unshift('"'); root.ws?.unshift(" "); root.eq?.unshift("="); }
    return { doc: `<?xml version="1.0" encoding="UTF-8"?>\n${serializeEl(root)}`, mediaType: "image/svg+xml", notes, ids };
  }
  // <head>: CSP first, reader CSS last
  if (!root.attrs.some((a) => a[0] === "xmlns")) { root.attrs.unshift(["xmlns", XHTML_NS]); root.quote.unshift('"'); root.ws?.unshift(" "); root.eq?.unshift("="); }
  let head = root.kids.find((k): k is XEl => k.k === "el" && ln(k.name) === "head");
  if (!head) { head = { k: "el", name: "head", attrs: [], quote: [], kids: [], selfClose: false }; root.kids.unshift(head); }
  head.selfClose = false;
  const meta: XEl = { k: "el", name: "meta", attrs: [["http-equiv", "Content-Security-Policy"], ["content", encAttr(READER_CSP)]], quote: ['"', '"'], kids: [], selfClose: true };
  head.kids.unshift(meta);
  if (opts.readerCss) head.kids.push({ k: "el", name: "style", attrs: [["id", "epub-reader-css"]], quote: ['"'], kids: [{ k: "text", raw: escStyle(opts.readerCss) }], selfClose: false });
  // XHTML: empty non-void elements must not self-close when the document is ever re-serialised as HTML; keep XML form
  return { doc: `<?xml version="1.0" encoding="UTF-8"?>\n${serializeEl(root)}`, mediaType: "application/xhtml+xml", notes, ids };
}
/** CSS text inside an XML <style>: escape the XML-significant characters (the document is parsed as XML) */
const escStyle = (css: string) => css.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** viewport of a fixed-layout XHTML document: the first <meta name="viewport">, first width / height win, units ignored */
export function fxlViewport(xhtml: string): { width: number; height: number } | null {
  const metas = [...xhtml.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).filter((m) => /\bname\s*=\s*["']viewport["']/i.test(m));
  if (!metas.length) {
    const svg = /<svg\b[^>]*>/i.exec(xhtml)?.[0]; // SVG spine item: viewBox / width / height
    if (svg) { const vb = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg); if (vb) return { width: Number(vb[1]), height: Number(vb[2]) }; }
    return null;
  }
  const content = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(metas[0])?.[2] ?? "";
  let width: number | undefined, height: number | undefined;
  for (const part of content.split(/[,;]+/)) {
    const m = /^\s*([a-z-]+)\s*=\s*([^\s,;]*)/i.exec(part); if (!m) continue;
    const key = m[1].toLowerCase(); const n = parseFloat(m[2]);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (key === "width" && width === undefined) width = n;
    if (key === "height" && height === undefined) height = n;
  }
  return width && height ? { width, height } : null;
}
