/**
 * TT36 (PR-07k): reader view for any web page — original code.
 *
 * 1. parse: a forgiving tokenizer builds a light element tree (quoted / unquoted / valueless attributes, void
 *    elements, implied </p> and </li>, stray end tags ignored); the contents of script / style / svg / template /
 *    form controls are never kept.
 * 2. prune: page chrome goes — nav / header / footer / aside / form / dialog, ARIA landmarks for navigation, banners,
 *    footers and sidebars, hidden elements, and blocks whose class / id read like menus, share bars, cookie notices,
 *    comments or ads.
 * 3. score: every paragraph-like block with real text gives points to its parent (full) and grandparent (half) —
 *    more for longer text and commas; containers named like content (article, post, readme, markdown…) gain, those
 *    named like chrome lose; the score is scaled by (1 − link density). The best container wins; siblings that are
 *    themselves strong (or long, link-poor paragraphs) are kept with it.
 * 4. serialise: an allow-list of text and structure tags only; attributes are dropped except href (links), src /
 *    alt (images, lazy-load and srcset aware; tracking pixels dropped), colspan / rowspan / start (numbers). Every
 *    URL goes through `mapUrl`, so the caller decides where links and images point (through the proxy).
 * The idea of content scoring is the well-known one popularised by Arc90's Readability; nothing here is taken from
 * an implementation of it.
 */

export interface ReaderResult {
  title: string; byline: string; site: string; lang: string; dir: "ltr" | "rtl" | "";
  html: string; text: string; words: number; minutes: number; images: number; links: number;
}
export type MapUrl = (absoluteUrl: string, kind: "link" | "image") => string | null;

interface El { tag: string; attrs: Record<string, string>; kids: Node[]; parent: El | null; score?: number }
type Node = El | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const SKIP_CONTENT = new Set(["script", "style", "noscript", "template", "svg", "math", "iframe", "object", "canvas", "select", "textarea", "button", "head"]);
const CHROME_TAGS = new Set(["nav", "header", "footer", "aside", "form", "dialog", "menu"]);
const CHROME_ROLES = /^(navigation|banner|contentinfo|complementary|dialog|alertdialog|search|menu|menubar|toolbar)$/i;
const CHROME_NAME = /(^|[\s_-])(nav|navbar|menu|footer|masthead|sidebar|side-bar|comments?|share|sharing|social|cookies?|consent|banner|promo|related|breadcrumbs?|skip|modal|popup|newsletter|subscribe|advert|ads?|sponsor|toolbar|pagination|widget|disqus)([\s_-]|$)/i;
const CONTENT_NAME = /(^|[\s_-])(article|body|content|entry|main|post|text|blog|story|readme|markdown|prose|documentation|docs?)([\s_-]|$)/i;
const PARA = new Set(["p", "pre", "td", "blockquote", "li", "dd"]);
const BLOCK_CLOSES_P = new Set(["p", "div", "ul", "ol", "table", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "section", "article", "figure", "hr", "dl", "header", "footer", "nav", "aside", "main", "form"]);
const KEEP = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code", "em", "strong", "b", "i", "u", "s", "sub", "sup", "mark", "small", "br", "hr", "img", "figure", "figcaption", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "dl", "dt", "dd", "a", "div", "section", "article", "main", "span", "abbr", "cite", "q", "time", "kbd", "var", "samp", "del", "ins", "picture"]);
const UNWRAP_AS_DIV = new Set(["div", "section", "article", "main"]);
const UNWRAP = new Set(["span", "picture"]);

/* ------------------------------------------------------------------ 1. parse */
export function parseHtml(html: string): El {
  const root: El = { tag: "#root", attrs: {}, kids: [], parent: null };
  let cur = root, i = 0;
  const n = html.length;
  const open = (el: El) => { el.parent = cur; cur.kids.push(el); if (!VOID.has(el.tag)) cur = el; };
  const closeTo = (tag: string) => {
    for (let e: El | null = cur; e && e !== root; e = e.parent) if (e.tag === tag) { cur = e.parent ?? root; return true; }
    return false;
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { cur.kids.push(html.slice(i)); break; }
    if (lt > i) cur.kids.push(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) { const e = html.indexOf("-->", lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") { const e = html.indexOf(">", lt); i = e < 0 ? n : e + 1; continue; }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(lt, lt + 64));
    if (!m) { cur.kids.push("&lt;"); i = lt + 1; continue; }
    // find the tag end, respecting quotes
    let j = lt + m[0].length, q = "";
    for (; j < n; j++) { const c = html[j]; if (q) { if (c === q) q = ""; } else if (c === '"' || c === "'") q = c; else if (c === ">") break; }
    const tag = m[2].toLowerCase(), body = html.slice(lt + m[0].length, j);
    i = j + 1;
    if (m[1]) { // end tag
      if (tag === "p" && !closeTo("p")) continue;
      closeTo(tag);
      continue;
    }
    const attrs: Record<string, string> = {};
    const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let a: RegExpExecArray | null;
    while ((a = re.exec(body))) { const k = a[1].toLowerCase(); if (!(k in attrs)) attrs[k] = a[2] ?? a[3] ?? a[4] ?? ""; }
    if (SKIP_CONTENT.has(tag)) { // skip to the matching end tag; its contents never reach the tree
      const endRe = new RegExp(`</${tag}[\\s>]`, "ig"); // case-insensitive search in the ORIGINAL (lower-casing can change lengths)
      endRe.lastIndex = i;
      const end = endRe.exec(html)?.index ?? -1;
      i = end < 0 ? n : html.indexOf(">", end) + 1 || n;
      continue;
    }
    if (tag === "p" || BLOCK_CLOSES_P.has(tag)) { for (let e: El | null = cur; e && e !== root; e = e.parent) { if (e.tag === "p") { cur = e.parent ?? root; break; } if (!["span", "a", "em", "strong", "b", "i"].includes(e.tag)) break; } }
    if (tag === "li") { for (let e: El | null = cur; e && e !== root; e = e.parent) { if (e.tag === "li") { cur = e.parent ?? root; break; } if (e.tag === "ul" || e.tag === "ol") break; } }
    if (tag === "html" || tag === "body") { Object.assign(root.attrs, attrs); continue; }
    open({ tag, attrs, kids: [], parent: null });
  }
  return root;
}

/* ------------------------------------------------------------------ helpers */
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (_m, e: string) => {
  const k = e.toLowerCase();
  if (k[0] === "#") { const cp = k[1] === "x" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ""; }
  return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", "#39": "'" } as Record<string, string>)[k] ?? "";
});
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function textOf(e: Node): string { return typeof e === "string" ? decode(e) : e.kids.map(textOf).join(""); }
function linkTextOf(e: Node): string { return typeof e === "string" ? "" : e.tag === "a" ? textOf(e) : e.kids.map(linkTextOf).join(""); }
function* walk(e: El): Generator<El> { for (const k of e.kids) if (typeof k !== "string") { yield k; yield* walk(k); } }
const nameOf = (e: El) => `${e.attrs.class ?? ""} ${e.attrs.id ?? ""}`;
const isHidden = (e: El) => "hidden" in e.attrs || e.attrs["aria-hidden"] === "true" || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(e.attrs.style ?? "");

/* ------------------------------------------------------------------ 2. prune */
function prune(e: El): void {
  e.kids = e.kids.filter((k) => {
    if (typeof k === "string") return true;
    if (CHROME_TAGS.has(k.tag) || CHROME_ROLES.test(k.attrs.role ?? "") || isHidden(k)) return false;
    // a chrome-named block goes only if it is not itself the obvious content holder
    if (CHROME_NAME.test(nameOf(k)) && !CONTENT_NAME.test(nameOf(k)) && k.tag !== "article" && k.tag !== "main") return false;
    prune(k);
    return true;
  });
}

/* ------------------------------------------------------------------ 3. score */
function pickContent(root: El): El {
  const scored = new Set<El>();
  for (const p of walk(root)) {
    if (!PARA.has(p.tag)) continue;
    const t = textOf(p).trim();
    if (t.length < 25) continue;
    const pts = 1 + (t.match(/[,，、]/g)?.length ?? 0) + Math.min(3, Math.floor(t.length / 100));
    const parent = p.parent, grand = parent?.parent;
    for (const [c, w] of [[parent, 1], [grand, 0.5]] as const) {
      if (!c || c.tag === "#root") continue;
      if (!scored.has(c)) { scored.add(c); c.score = initial(c); }
      c.score! += pts * w;
    }
  }
  let best: El | null = null;
  for (const c of scored) {
    const all = textOf(c).length || 1;
    c.score = c.score! * (1 - linkTextOf(c).length / all);
    if (!best || c.score > best.score!) best = c;
  }
  if (!best || textOf(best).trim().length < 140) {
    // little paragraph text (a short or unusual page): the main landmark, else the whole body
    for (const e of walk(root)) if (e.tag === "main" || e.tag === "article") return e;
    return root;
  }
  // keep strong siblings (multi-part articles) and long, link-poor sibling paragraphs
  const par = best.parent;
  if (!par) return best;
  const threshold = Math.max(10, best.score! * 0.2);
  const keep = par.kids.filter((k): k is El => typeof k !== "string" && (k === best || (k.score ?? 0) >= threshold || (k.tag === "p" && textOf(k).length > 80 && linkTextOf(k).length / (textOf(k).length || 1) < 0.25)));
  if (keep.length === 1) return best;
  return { tag: "div", attrs: {}, kids: keep, parent: null };
}
function initial(e: El): number {
  let s = e.tag === "article" ? 10 : e.tag === "main" ? 8 : e.tag === "section" || e.tag === "div" ? 2 : e.tag === "pre" || e.tag === "td" || e.tag === "blockquote" ? 3 : e.tag === "ul" || e.tag === "ol" || e.tag === "form" ? -3 : 0;
  if (CONTENT_NAME.test(nameOf(e))) s += 25;
  if (CHROME_NAME.test(nameOf(e))) s -= 25;
  return s;
}

/* ------------------------------------------------------------------ 4. serialise */
function resolve(href: string, base: string): string | null {
  try { const u = new URL(decode(href).trim(), base); return u.protocol === "http:" || u.protocol === "https:" ? u.href : null; } catch { return null; }
}
function pickImage(a: Record<string, string>, base: string): string | null {
  const lazy = a["data-src"] || a["data-original"] || a["data-lazy-src"];
  const set = a.srcset || a["data-srcset"];
  let best = "";
  if (set) { // the widest (or densest) candidate
    let top = -1;
    for (const c of set.split(/,\s+/)) { const [u, d] = c.trim().split(/\s+/); const v = d ? parseFloat(d) * (d.endsWith("x") ? 1000 : 1) : 1; if (u && v > top) { top = v; best = u; } }
  }
  const src = lazy || best || a.src || "";
  if (!src || /^data:/i.test(src)) return null;
  return resolve(src, base);
}
function serialise(e: Node, base: string, map: MapUrl, stats: { images: number; links: number }): string {
  if (typeof e === "string") return e.replace(/</g, "&lt;");
  const inner = () => e.kids.map((k) => serialise(k, base, map, stats)).join("");
  if (!KEEP.has(e.tag)) return inner(); // unknown wrappers: keep their text
  if (UNWRAP.has(e.tag)) return inner();
  if (UNWRAP_AS_DIV.has(e.tag)) { const s = inner(); return s.trim() ? `<div>${s}</div>` : ""; }
  if (e.tag === "img") {
    const w = parseInt(e.attrs.width ?? "", 10), h = parseInt(e.attrs.height ?? "", 10);
    if ((w > 0 && w <= 3) || (h > 0 && h <= 3)) return ""; // tracking pixels
    const abs = pickImage(e.attrs, base), to = abs ? map(abs, "image") : null;
    if (!to) return "";
    stats.images++;
    return `<img src="${esc(to)}" alt="${esc(decode(e.attrs.alt ?? ""))}" loading="lazy">`;
  }
  if (e.tag === "br" || e.tag === "hr") return `<${e.tag}>`;
  let attrs = "";
  if (e.tag === "a") {
    const raw = e.attrs.href ?? "";
    if (/^\s*#/.test(raw)) attrs = ` href="${esc(raw.trim())}"`;
    else { const abs = raw ? resolve(raw, base) : null, to = abs ? map(abs, "link") : null; if (to) { attrs = ` href="${esc(to)}"`; stats.links++; } }
  }
  if ((e.tag === "td" || e.tag === "th") && /^\d{1,3}$/.test(e.attrs.colspan ?? "")) attrs += ` colspan="${e.attrs.colspan}"`;
  if ((e.tag === "td" || e.tag === "th") && /^\d{1,3}$/.test(e.attrs.rowspan ?? "")) attrs += ` rowspan="${e.attrs.rowspan}"`;
  if (e.tag === "ol" && /^-?\d{1,6}$/.test(e.attrs.start ?? "")) attrs += ` start="${e.attrs.start}"`;
  const s = inner();
  if (!s.trim() && !["td", "th"].includes(e.tag)) return "";
  return `<${e.tag}${attrs}>${s}</${e.tag}>`;
}

function meta(root: El, keys: string[]): string {
  for (const e of walk(root)) if (e.tag === "meta") { const k = (e.attrs.property || e.attrs.name || "").toLowerCase(); if (keys.includes(k) && e.attrs.content) return decode(e.attrs.content).trim(); }
  return "";
}

/** Extract the readable part of a page. `html` is the page source; `base` its final URL. */
export function readable(html: string, base: string, mapUrl: MapUrl): ReaderResult {
  // <head> metadata first (the tree skips head contents)
  const headEnd = html.search(/<\/head\s*>/i);
  const head = parseHeadMeta(headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 20000));
  const root = parseHtml(html);
  const lang = (root.attrs.lang ?? /<html[^>]*\slang\s*=\s*["']?([\w-]+)/i.exec(html)?.[1] ?? "").slice(0, 20);
  const dirRaw = (root.attrs.dir ?? "").toLowerCase();
  prune(root);
  const content = pickContent(root);
  const stats = { images: 0, links: 0 };
  let out = serialise(content, base, mapUrl, stats).replace(/(<div>\s*<\/div>)+/g, "");
  const text = textOf(content).replace(/\s+/g, " ").trim();
  const words = text ? text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  let site = head.site;
  try { site = site || new URL(base).hostname.replace(/^www\./, ""); } catch { /* keep */ }
  const title = head.title || site;
  // a leading <h1> repeating the title is dropped (the reader shows the title itself)
  const h1 = /^\s*(?:<div>\s*)*<h1>([\s\S]*?)<\/h1>/.exec(out);
  if (h1 && decode(h1[1].replace(/<[^>]+>/g, "")).trim().toLowerCase() === title.toLowerCase()) out = out.replace(/<h1>[\s\S]*?<\/h1>/, "");
  return { title, byline: head.byline, site, lang, dir: dirRaw === "rtl" ? "rtl" : dirRaw === "ltr" ? "ltr" : "", html: out, text, words, minutes: Math.max(1, Math.round(words / 230)), ...stats };
}

function parseHeadMeta(head: string): { title: string; site: string; byline: string } {
  const root = parseHtmlHead(head);
  const og = meta(root, ["og:title", "twitter:title"]);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  return { title: (og || (t ? decode(t).replace(/\s+/g, " ").trim() : "")).slice(0, 300), site: meta(root, ["og:site_name", "application-name"]).slice(0, 100), byline: meta(root, ["author", "article:author", "byl"]).slice(0, 200) };
}
/** head-only parse: the main parser drops <head>, so metas are read with the head treated as a plain container */
function parseHtmlHead(head: string): El { return parseHtml(head.replace(/<head(\s[^>]*)?>/i, "<div>").replace(/<title[\s\S]*?<\/title>/i, "")); }

/**
 * The reader page: Fusion's own typography around the extracted content. `inject` is the in-page runtime tag (so
 * the address, find in page and Back / Forward keep working); everything else is static, sanitised markup.
 */
export function readerDocument(r: ReaderResult, o: { target: string; inject: string; original: string }): string {
  const e = esc;
  const meta = [r.site, r.byline, `${r.minutes} min read`, `${r.words.toLocaleString("en-US")} words`].filter(Boolean).map((x) => `<span>${e(x)}</span>`).join(" · ");
  return `<!doctype html><html lang="${e(r.lang || "en")}"${r.dir ? ` dir="${r.dir}"` : ""}><head><meta charset="utf-8">${o.inject}
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(r.title)}</title>
<style>
:root{color-scheme:light dark;--fg:#1d2433;--dim:#5b6475;--bg:#fbfaf7;--link:#0b62c4;--rule:#e4e1d8;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--dim:#a6adbb;--bg:#16181d;--link:#7cb6ff;--rule:#2c2f36;--code:#22252c}}
html{background:var(--bg);color:var(--fg)}
body{margin:0 auto;max-width:68ch;padding:40px 24px 96px;font:20px/1.62 Charter,"Iowan Old Style","Source Serif 4",Georgia,serif}
header{border-bottom:1px solid var(--rule);margin-bottom:28px;padding-bottom:16px}
h1.reader-title{font:700 2.0em/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0 0 10px}
.reader-meta{color:var(--dim);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.reader-meta a{color:var(--dim)}
h1,h2,h3,h4,h5,h6{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.25;margin:1.6em 0 .5em}
p,ul,ol,blockquote,pre,table,figure{margin:0 0 1em}
a{color:var(--link)}
img{max-width:100%;height:auto;border-radius:6px}
pre,code,kbd,samp{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:.82em;background:var(--code);border-radius:4px}
pre{padding:12px 14px;overflow:auto;line-height:1.45}code{padding:.1em .3em}pre code{padding:0;background:none}
blockquote{border-left:3px solid var(--rule);margin-left:0;padding-left:16px;color:var(--dim)}
table{border-collapse:collapse;display:block;overflow:auto}th,td{border:1px solid var(--rule);padding:6px 10px;text-align:left}
hr{border:0;border-top:1px solid var(--rule)}
</style></head><body>
<header><h1 class="reader-title">${e(r.title)}</h1><div class="reader-meta" data-reader-meta>${meta} · <a href="${e(o.original)}" data-reader-original>Original page</a></div></header>
<article data-reader="${e(o.target)}">${r.html || "<p>No readable text was found on this page.</p>"}</article>
</body></html>`;
}
