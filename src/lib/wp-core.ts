/**
 * TT35 — Fusion web proxy, pure core (no Node / DOM APIs, so it runs in unit tests, the server and — for the URL
 * codec — mirrors the in-page runtime in public/wp-shim.js).
 *
 * Original code. Design ideas (not code) taken from reading how rewriting proxies are structured: an injected client
 * runtime, header rewriting, Location rewriting, an emulated cookie store. Licences reviewed: Ultraviolet and current
 * Scramjet are AGPL-3.0 — nothing was copied from them or from any other proxy.
 *
 * URL scheme (path-preserving):  /api/wp/s/<sid>/<scheme>/<host[:port]><path>?<query>#<hash>
 * Because the target's path structure is kept, the BROWSER resolves relative URLs ("img/a.png", "../x", "?q=1")
 * correctly by itself; only root-relative ("/static/a.css") and absolute URLs need rewriting.
 */

import { parseSidSegment, type Cred } from "./wp-cors";

export const WP_PREFIX = "/api/wp/s/";
const SID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function isSid(s: string): boolean { return SID_RE.test(s); }

/** Absolute http(s) URL → proxied path (same-origin, relative to our server). Non-http(s) → null. */
export function encodeTarget(abs: string | URL, sid: string): string | null {
  let u: URL;
  try { u = typeof abs === "string" ? new URL(abs) : abs; } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || u.username || u.password) return null; // credentials in URLs are refused, never forwarded
  return `${WP_PREFIX}${sid}/${u.protocol.slice(0, -1)}/${u.host}${u.pathname}${u.search}${u.hash}`;
}

/** Proxied pathname + search → { sid, target }. Throws a plain-language Error on anything malformed. */
export function decodeTarget(pathname: string, search = ""): { sid: string; target: URL; rest: string; doc?: string; cred?: Cred; resource?: true } {
  if (!pathname.startsWith(WP_PREFIX)) throw new Error("not a proxy path");
  const tail = pathname.slice(WP_PREFIX.length);
  const s1 = tail.indexOf("/");
  if (s1 < 0) throw new Error("missing target");
  // TT39 (WP-10): script requests carry "<sid>:<document id>:<credentials mode>" — see src/lib/wp-cors.ts
  const seg = parseSidSegment(tail.slice(0, s1));
  if (!seg || !isSid(seg.sid)) throw new Error("bad session id");
  const { sid, doc, cred, resource } = seg;
  const rest = tail.slice(s1 + 1);
  if (rest.startsWith("__")) return { sid, target: new URL("about:blank"), rest }; // control endpoints (__cookie)
  const s2 = rest.indexOf("/");
  const scheme = s2 < 0 ? rest : rest.slice(0, s2);
  if (scheme !== "http" && scheme !== "https") throw new Error("only http and https can be proxied");
  const after = s2 < 0 ? "" : rest.slice(s2 + 1);
  const s3 = after.indexOf("/");
  const host = s3 < 0 ? after : after.slice(0, s3);
  const path = s3 < 0 ? "/" : after.slice(s3);
  if (!host || /[@\s\\]/.test(host)) throw new Error("bad host");
  const target = new URL(`${scheme}://${host}${path}${search}`);
  if (target.host.toLowerCase() !== host.toLowerCase().replace(/:(80|443)$/, (m) => ((scheme === "http" && m === ":80") || (scheme === "https" && m === ":443") ? "" : m))) throw new Error("bad host");
  if (doc && resource) return { sid, target, rest, doc, resource };
  return doc ? { sid, target, rest, doc, cred } : { sid, target, rest };
}

const PASS_SCHEMES = /^(data|blob|javascript|mailto|tel|sms|about|ftp|ws|wss|intent|geo|magnet|chrome|file):/i;

/** Rewrite one URL found in a page whose (target) base URL is `base`. Returns the input unchanged when it must not be touched. */
export function rewriteUrl(raw: string, base: string | URL, sid: string): string {
  const v = raw.trim();
  if (!v || v.startsWith("#") || PASS_SCHEMES.test(v)) return raw;
  if (v.startsWith(WP_PREFIX)) return raw; // already ours
  let abs: URL;
  try { abs = new URL(v, base); } catch { return raw; }
  return encodeTarget(abs, sid) ?? raw;
}

/** srcset = candidates "url [descriptor]" separated by commas; a URL may itself contain commas (HTML §4.8.4.3.1). */
export function rewriteSrcset(value: string, base: string | URL, sid: string): string {
  const out: string[] = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(value[i])) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !/\s/.test(value[j])) j++;
    let url = value.slice(i, j);
    let desc = "";
    if (url.endsWith(",")) { url = url.replace(/,+$/, ""); }
    else {
      let k = j;
      let depth = 0;
      while (k < n && (depth > 0 || value[k] !== ",")) { if (value[k] === "(") depth++; else if (value[k] === ")") depth--; k++; }
      desc = value.slice(j, k).trim();
      j = k;
    }
    out.push(desc ? `${rewriteUrl(url, base, sid)} ${desc}` : rewriteUrl(url, base, sid));
    i = j + 1;
  }
  return out.join(", ");
}

/** CSS: url(...) in any form, and @import "..." strings. Comments and other strings are left alone. */
export function rewriteCss(css: string, base: string | URL, sid: string): string {
  let out = "";
  let i = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    if (c === "/" && css[i + 1] === "*") { const e = css.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; out += css.slice(i, end); i = end; continue; }
    if (c === '"' || c === "'") { // a string: rewrite only when it directly follows @import
      const end = scanString(css, i);
      const before = out.replace(/\s+$/, "");
      if (/@import$/i.test(before)) out += c + rewriteUrl(unescapeCss(css.slice(i + 1, end - 1)), base, sid).replace(/["\\\n]/g, (m) => `\\${m === "\n" ? "a " : m}`) + c;
      else out += css.slice(i, end);
      i = end; continue;
    }
    if ((c === "u" || c === "U") && /^url\(/i.test(css.slice(i, i + 4)) && !/[\w-]/.test(css[i - 1] ?? "")) {
      let j = i + 4;
      while (j < n && /\s/.test(css[j])) j++;
      let url: string; let end: number;
      if (css[j] === '"' || css[j] === "'") { const se = scanString(css, j); url = unescapeCss(css.slice(j + 1, se - 1)); end = css.indexOf(")", se); }
      else { end = css.indexOf(")", j); url = (end < 0 ? css.slice(j) : css.slice(j, end)).trim(); }
      if (end < 0) { out += css.slice(i); break; }
      out += `url("${rewriteUrl(url, base, sid).replace(/["\\\n]/g, (m) => `\\${m === "\n" ? "a " : m}`)}")`;
      i = end + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
function scanString(s: string, i: number): number { const q = s[i]; let j = i + 1; while (j < s.length && s[j] !== q && s[j] !== "\n") { if (s[j] === "\\") j++; j++; } return Math.min(j + 1, s.length); }
function unescapeCss(s: string): string { return s.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1"); }

// ---------------------------------------------------------------------------------------------------- HTML rewriter
const URL_ATTRS: Record<string, string[]> = {
  href: ["a", "area", "link", "base"],
  src: ["img", "script", "iframe", "frame", "embed", "source", "track", "audio", "video", "input"],
  action: ["form"], formaction: ["button", "input"], poster: ["video"], data: ["object"], background: ["body", "table", "td", "th"],
  "xlink:href": ["*"], manifest: ["html"], icon: ["command"],
};
const SRCSET_ATTRS = new Set(["srcset", "imagesrcset"]);
/** TT40: attributes that LOAD a subresource into this document (never a navigation). */
const RESOURCE_ATTR: Record<string, Set<string>> = {
  src: new Set(["img", "script", "source", "track", "audio", "video", "input"]), href: new Set(["link"]), poster: new Set(["video"]),
  background: new Set(["body", "table", "td", "th"]),
};
export function isResourceAttr(tag: string, attr: string): boolean { return RESOURCE_ATTR[attr]?.has(tag) ?? false; }
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "plaintext"]);

export interface HtmlRewriteOptions {
  sid: string;
  /** TT40 (WP-16): the segment for SUBRESOURCE attributes ("<sid>:<doc>:r"); navigations (a, area, form, iframe,
   *  frame, object, embed, base, meta refresh) keep `sid` so a new page never inherits this document's id */
  resSid?: string;
  /** the target URL of this document */
  url: string;
  /** markup injected first thing in <head> (the runtime + its data) */
  inject?: string;
}
export interface HtmlRewriteReport { rewritten: number; removed: string[]; base: string }

/**
 * A single-pass tokenizer (HTML §13.2.5, simplified to what URL rewriting needs): text, comments, doctype, CDATA,
 * start/end tags with quoted / unquoted / valueless attributes, and raw-text elements whose content is NOT parsed
 * as markup (<script>, <style>, <textarea>, <title>…). Attribute values are entity-decoded before rewriting and
 * re-encoded after, so "&amp;" in a query survives.
 */
export function rewriteHtml(html: string, o: HtmlRewriteOptions): { html: string; report: HtmlRewriteReport } {
  const res = o.resSid ?? o.sid;
  let base = o.url;
  const report: HtmlRewriteReport = { rewritten: 0, removed: [], base };
  let out = "";
  let i = 0;
  const n = html.length;
  let injected = !o.inject;
  const inject = () => { if (!injected) { out += o.inject; injected = true; } };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    i = lt;
    if (html.startsWith("<!--", i)) { const e = html.indexOf("-->", i + 4); const end = e < 0 ? n : e + 3; out += html.slice(i, end); i = end; continue; }
    if (html.startsWith("<![CDATA[", i)) { const e = html.indexOf("]]>", i); const end = e < 0 ? n : e + 3; out += html.slice(i, end); i = end; continue; }
    if (html[i + 1] === "!" || html[i + 1] === "?") { const e = html.indexOf(">", i); const end = e < 0 ? n : e + 1; out += html.slice(i, end); i = end; continue; }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(i, i + 64));
    if (!m) { out += "<"; i++; continue; }
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    // scan attributes up to the tag's ">" (respecting quotes)
    let j = i + m[0].length;
    const attrs: { name: string; value: string | null; raw: string }[] = [];
    let selfClose = false;
    while (j < n) {
      while (j < n && /[\s/]/.test(html[j])) { if (html[j] === "/" && html[j + 1] === ">") selfClose = true; j++; }
      if (j >= n || html[j] === ">") break;
      const a0 = j;
      while (j < n && !/[\s/>=]/.test(html[j])) j++;
      const an = html.slice(a0, j);
      let k = j; while (k < n && /\s/.test(html[k])) k++;
      if (html[k] === "=") {
        k++; while (k < n && /\s/.test(html[k])) k++;
        let v: string;
        if (html[k] === '"' || html[k] === "'") { const q = html[k]; const e = html.indexOf(q, k + 1); const end = e < 0 ? n : e; v = html.slice(k + 1, end); j = Math.min(end + 1, n); }
        else { const s = k; while (k < n && !/[\s>]/.test(html[k])) k++; v = html.slice(s, k); j = k; }
        attrs.push({ name: an, value: v, raw: html.slice(a0, j) });
      } else { attrs.push({ name: an, value: null, raw: an }); j = Math.max(j, a0 + 1); }
    }
    const tagEnd = Math.min(j + 1, n);
    if (closing) { out += html.slice(i, tagEnd); i = tagEnd; if (name === "head") inject(); continue; }

    // ---- start tag: decide each attribute
    const lower = (s: string) => s.toLowerCase();
    const get = (k: string) => attrs.find((a) => lower(a.name) === k)?.value ?? null;
    let drop = false;
    if (name === "meta") {
      const he = lower(decodeEntities(get("http-equiv") ?? ""));
      if (he === "content-security-policy" || he === "content-security-policy-report-only" || he === "x-frame-options") { drop = true; report.removed.push(`meta ${he}`); }
    }
    if (name === "base") {
      const h = get("href");
      if (h !== null) { try { base = new URL(decodeEntities(h), base).toString(); report.base = base; } catch { /* keep */ } }
    }
    const parts: string[] = [];
    for (const a of attrs) {
      const an = lower(a.name);
      if (a.value === null) { parts.push(a.raw); continue; }
      const val = decodeEntities(a.value);
      let nv: string | null = val;
      if ((URL_ATTRS[an] && (URL_ATTRS[an].includes(name) || URL_ATTRS[an].includes("*")))) nv = rewriteUrl(val, base, isResourceAttr(name, an) ? res : o.sid);
      else if (SRCSET_ATTRS.has(an)) nv = rewriteSrcset(val, base, res);
      else if (an === "style") nv = rewriteCss(val, base, res);
      else if (an === "integrity" || an === "ping") { nv = null; report.removed.push(`${name}[${an}]`); }
      else if (an === "crossorigin" && lower(val) === "use-credentials") nv = "anonymous"; // credentials never cross the proxy
      else if (an === "target" && /^_(top|parent)$/i.test(val)) nv = "_self"; // inside the frame, not over the whole desktop
      else if (name === "meta" && an === "content" && lower(decodeEntities(get("http-equiv") ?? "")) === "refresh") nv = rewriteRefresh(val, base, o.sid);
      if (nv === null) continue;
      if (nv !== val) report.rewritten++;
      parts.push(nv === val ? a.raw : `${a.name}="${encodeAttr(nv)}"`);
    }
    if (!drop) out += `<${html.slice(i + 1, i + 1 + m[2].length)}${parts.length ? " " + parts.join(" ") : ""}${selfClose ? " /" : ""}>`;
    i = tagEnd;
    if (name === "head" || name === "html" && !/<head[\s>]/i.test(html)) inject();
    if (RAW_TEXT.has(name) && !selfClose) {
      const close = new RegExp(`</${name}[\\s/>]`, "i");
      const rel = html.slice(i).search(close);
      const end = rel < 0 ? n : i + rel;
      const body = html.slice(i, end);
      if (name === "style") { const r = rewriteCss(body, base, res); if (r !== body) report.rewritten++; out += r; }
      else out += body;
      i = end;
    }
  }
  if (!injected) out = o.inject + out;
  return { html: out, report };
}

function rewriteRefresh(v: string, base: string, sid: string): string {
  const m = /^(\s*\d+(?:\.\d+)?\s*[;,]\s*(?:url\s*=\s*)?)(['"]?)(.*?)\2\s*$/i.exec(v);
  return m ? `${m[1]}${rewriteUrl(m[3], base, sid)}` : v;
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
export function decodeEntities(s: string): string {
  if (s.indexOf("&") < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);?/g, (all, e: string) => {
    if (e[0] === "#") { const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all; }
    return NAMED[e.toLowerCase()] ?? all;
  });
}
export function encodeAttr(s: string): string { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// ---------------------------------------------------------------------------------------------------- cookie jar
export interface Cookie { name: string; value: string; domain: string; path: string; hostOnly: boolean; secure: boolean; httpOnly: boolean; expires: number; created: number; sameSite?: "strict" | "lax" | "none" }

/** The smallest public-suffix guard that matters: single labels and the common multi-label registries. Declared partial. */
const PUBLIC_SUFFIXES = new Set(["com", "net", "org", "edu", "gov", "io", "co", "uk", "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "co.jp", "co.nz", "com.br", "co.in", "github.io", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev", "blogspot.com", "appspot.com", "cloudfront.net", "s3.amazonaws.com", "azurewebsites.net", "e2b.app"]);

/**
 * TT38: the registrable domain ("site") of a host, for SameSite decisions — the longest known public suffix plus one
 * label (the built-in suffix list above is short; an unknown multi-label suffix falls back to the last two labels).
 * IP literals are their own site.
 */
export function siteOf(host: string): string {
  const h = host.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":")) return h;
  const labels = h.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i + 1).join(".");
    if (PUBLIC_SUFFIXES.has(suffix)) return labels.slice(i).join(".");
  }
  return labels.slice(-2).join(".");
}
export function sameSite(a: string, b: string): boolean { return siteOf(a) === siteOf(b); }
/** TT40: the host IS a known public suffix (github.io, co.uk …) — nobody's registrable domain. */
export function isPublicSuffix(host: string): boolean { return PUBLIC_SUFFIXES.has(host.replace(/\.$/, "").toLowerCase()); }

export function domainMatch(host: string, domain: string): boolean { return host === domain || (host.endsWith("." + domain) && !/^\d+\.\d+\.\d+\.\d+$/.test(host)); }

/** RFC 6265 §5.1.4 default-path */
export function defaultPath(path: string): string { if (!path.startsWith("/")) return "/"; const k = path.lastIndexOf("/"); return k <= 0 ? "/" : path.slice(0, k); }
export function pathMatch(reqPath: string, cookiePath: string): boolean {
  return reqPath === cookiePath || (reqPath.startsWith(cookiePath) && (cookiePath.endsWith("/") || reqPath[cookiePath.length] === "/"));
}

export class CookieJar {
  private list: Cookie[] = [];
  static readonly MAX_TOTAL = 600;
  static readonly MAX_PER_DOMAIN = 60;
  static readonly MAX_BYTES = 4096;
  get size(): number { return this.list.length; }
  clear(): void { this.list = []; }
  /** RFC 6265 §5.2 + §5.3. Returns a reason when the cookie is refused (for tests and the UI). */
  set(header: string, url: URL, now = Date.now(), fromScript = false): string | null {
    if (header.length > CookieJar.MAX_BYTES) return "too large";
    const [pair, ...attrs] = header.split(";");
    const eq = pair.indexOf("=");
    const name = (eq < 0 ? "" : pair.slice(0, eq)).trim();
    const value = (eq < 0 ? pair : pair.slice(eq + 1)).trim();
    if (!name && !value) return "empty";
    if (/[\x00-\x1f\x7f]/.test(name + value)) return "control characters";
    const host = url.hostname.toLowerCase();
    let domain = ""; let path = ""; let secure = false; let httpOnly = false; let expires = Infinity; let maxAge: number | null = null; let sameSite: "strict" | "lax" | "none" = "lax"; // TT38: no attribute = Lax (Chrome's default since 2020)
    for (const a of attrs) {
      const k = a.indexOf("=");
      const an = (k < 0 ? a : a.slice(0, k)).trim().toLowerCase();
      const av = (k < 0 ? "" : a.slice(k + 1)).trim();
      if (an === "domain" && av) domain = av.replace(/^\./, "").toLowerCase();
      else if (an === "path") path = av.startsWith("/") ? av : "";
      else if (an === "secure") secure = true;
      else if (an === "httponly") httpOnly = true;
      else if (an === "samesite") { const v = av.toLowerCase(); sameSite = v === "strict" ? "strict" : v === "none" ? "none" : "lax"; }
      else if (an === "max-age" && /^-?\d+$/.test(av)) maxAge = Number(av);
      else if (an === "expires") { const t = Date.parse(av); if (!Number.isNaN(t)) expires = t; }
    }
    if (maxAge !== null) expires = maxAge <= 0 ? -Infinity : now + maxAge * 1000;
    if (fromScript && httpOnly) return "HttpOnly from script";
    if (secure && url.protocol !== "https:") return "Secure over http";
    if (sameSite === "none" && !secure) return "SameSite=None without Secure"; // refused by browsers since 2020
    let hostOnly = true; // RFC 6265 §5.3 step 6: no Domain attribute → the cookie goes back to this exact host only
    if (domain) {
      if ((PUBLIC_SUFFIXES.has(domain) || !domain.includes(".")) && domain !== host) return "public suffix";
      if (!domainMatch(host, domain)) return "domain mismatch";
      hostOnly = false;
    } else domain = host;
    if (!path) path = defaultPath(url.pathname);
    if (name.startsWith("__Secure-") && !secure) return "__Secure- without Secure";
    if (name.startsWith("__Host-") && (!secure || !hostOnly || path !== "/")) return "__Host- rules";
    const existing = this.list.findIndex((c) => c.name === name && c.domain === domain && c.path === path);
    const created = existing >= 0 ? this.list[existing].created : now;
    if (existing >= 0) { if (fromScript && this.list[existing].httpOnly) return "HttpOnly from script"; this.list.splice(existing, 1); }
    if (expires < now) return null; // a deletion (expired / Max-Age<=0) — removed above
    this.list.push({ name, value, domain, path, hostOnly, secure, httpOnly, expires, created, sameSite });
    // eviction: expired first, then the oldest in an over-full domain, then the oldest overall
    this.list = this.list.filter((c) => c.expires > now);
    const inDomain = this.list.filter((c) => c.domain === domain);
    if (inDomain.length > CookieJar.MAX_PER_DOMAIN) { const old = inDomain.sort((a, b) => a.created - b.created)[0]; this.list.splice(this.list.indexOf(old), 1); }
    if (this.list.length > CookieJar.MAX_TOTAL) { this.list.sort((a, b) => a.created - b.created); this.list.shift(); }
    return null;
  }
  /** RFC 6265 §5.4: the Cookie header for a request to `url` (longer paths first, then older). */
  header(url: URL, now = Date.now(), forScript = false, crossSite = false): string {
    const host = url.hostname.toLowerCase();
    const hits = this.list.filter((c) => c.expires > now
      && (!crossSite || c.sameSite === "none") // TT38: a cross-site initiator gets SameSite=None cookies only
      && (c.hostOnly ? host === c.domain : domainMatch(host, c.domain))
      && pathMatch(url.pathname || "/", c.path)
      && (!c.secure || url.protocol === "https:")
      && (!forScript || !c.httpOnly));
    hits.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    return hits.map((c) => (c.name ? `${c.name}=${c.value}` : c.value)).join("; ");
  }
  domains(): string[] { return [...new Set(this.list.map((c) => c.domain))].sort(); }
}

// ---------------------------------------------------------------------------------------------------- shields
/**
 * Hosts whose only job is tracking / ad delivery. Requests to them (and their subdomains) are answered 204 by the
 * proxy and never leave the server. A short, hand-picked list of facts (domain names), not a copied filter list.
 */
export const TRACKER_HOSTS = [
  "google-analytics.com", "googletagmanager.com", "googletagservices.com", "doubleclick.net", "googlesyndication.com", "googleadservices.com",
  "adservice.google.com", "connect.facebook.net", "pixel.facebook.com", "scorecardresearch.com", "hotjar.com", "hotjar.io", "segment.io",
  "cdn.segment.com", "api.segment.io", "mixpanel.com", "amplitude.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
  "quantserve.com", "quantcount.com", "adnxs.com", "rubiconproject.com", "pubmatic.com", "moatads.com", "chartbeat.com", "chartbeat.net",
  "nr-data.net", "bat.bing.com", "clarity.ms", "mc.yandex.ru", "ads-twitter.com", "analytics.twitter.com", "analytics.tiktok.com",
  "stats.wp.com", "pixel.wp.com", "omtrdc.net", "demdex.net", "everesttech.net", "krxd.net", "bluekai.com", "adsrvr.org", "casalemedia.com",
  "openx.net", "media.net", "amazon-adsystem.com", "advertising.com", "yieldmo.com", "sharethrough.com", "fullstory.com", "mouseflow.com",
  "crazyegg.com", "optimizely.com", "branch.io", "app-measurement.com", "braze.com", "onesignal.com", "comscore.com", "parsely.com",
];
export function isTracker(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return TRACKER_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

// ---------------------------------------------------------------------------------------------------- headers
/** Request headers that never cross the proxy (identity, our own cookies, hop-by-hop, client hints). */
const DROP_REQ = /^(cookie|host|origin|referer|user-agent|connection|keep-alive|upgrade|te|trailer|transfer-encoding|proxy-.*|forwarded|via|x-forwarded-.*|x-real-ip|cf-.*|sec-.*|dnt|accept-language|accept-encoding|content-length|priority|purpose|x-middleware-.*|next-.*|rsc|x-invoke-.*|x-nextjs-.*)$/i;
export const UA = {
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  mobile: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
} as const;
export type UaKind = keyof typeof UA;

export function upstreamHeaders(incoming: Iterable<[string, string]>, target: URL, o: { ua: UaKind; cookie: string; method: string }): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of incoming) if (!DROP_REQ.test(k)) h[k.toLowerCase()] = v;
  h["user-agent"] = UA[o.ua];
  h["accept-language"] = "en-US,en;q=0.9"; // one value for everyone: no locale fingerprint
  h["accept-encoding"] = "gzip, deflate, br";
  h["sec-gpc"] = "1"; // Global Privacy Control
  h.referer = `${target.origin}/`; // origin-only, and only the target's own: never where the user came from
  if (o.method !== "GET" && o.method !== "HEAD") h.origin = target.origin;
  if (o.cookie) h.cookie = o.cookie;
  if (!h.accept) h.accept = "*/*";
  return h;
}

/** Response headers passed back to the page (everything else — Set-Cookie, CSP, XFO, HSTS, COOP/COEP, Alt-Svc, NEL… — stops here). */
const KEEP_RES = new Set(["content-type", "content-range", "accept-ranges", "last-modified", "etag", "expires", "content-language", "vary", "content-disposition"]);
export function downstreamHeaders(upstream: Record<string, string | string[] | undefined>): Record<string, string> {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(upstream)) {
    if (v === undefined) continue;
    const key = k.toLowerCase();
    if (!KEEP_RES.has(key)) continue;
    const val = Array.isArray(v) ? v.join(", ") : v;
    if (key === "content-disposition") { h[key] = sanitizeDisposition(val); continue; }
    h[key] = val.replace(/[\r\n]/g, "");
  }
  return h;
}
function sanitizeDisposition(v: string): string {
  const type = /^\s*attachment/i.test(v) ? "attachment" : "inline";
  const m = /filename\*?\s*=\s*(?:UTF-8'')?"?([^";]+)"?/i.exec(v);
  let name = m ? m[1] : "";
  try { name = decodeURIComponent(name); } catch { /* raw */ }
  name = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 150);
  return name ? `${type}; filename*=UTF-8''${encodeURIComponent(name)}` : type;
}

/** CSP for proxied DOCUMENTS: an opaque origin (sandbox without allow-same-origin) that may only load from us. */
/** The reader page is Fusion's own sanitised markup: scripts only from Fusion (the runtime), no inline script at all. */
export function readerCsp(selfOrigins: string[]): string {
  const src = ["'self'", ...selfOrigins].join(" ");
  return [
    "sandbox allow-scripts allow-popups allow-downloads",
    `default-src ${src}`, `script-src ${src}`, `style-src 'unsafe-inline'`, `img-src ${src} data:`, `connect-src ${src}`,
    `form-action 'none'`, `base-uri 'none'`, `frame-ancestors ${src}`, "object-src 'none'",
  ].join("; ");
}
export function documentCsp(selfOrigins: string[]): string {
  const src = ["'self'", ...selfOrigins].join(" ");
  return [
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-pointer-lock allow-presentation",
    `default-src ${src} data: blob: 'unsafe-inline' 'unsafe-eval'`,
    `img-src ${src} data: blob:`, `media-src ${src} data: blob:`, `font-src ${src} data:`,
    `connect-src ${src} data: blob:`, `frame-src ${src} data: blob:`, `worker-src ${src} blob:`,
    `form-action ${src}`, `base-uri ${src}`, `frame-ancestors ${src}`, "object-src 'none'",
  ].join("; ");
}

// ---------------------------------------------------------------------------------------------------- errors
export type FetchFailure = "dns" | "refused" | "reset" | "timeout" | "tls" | "private" | "too-large" | "scheme" | "proxy" | "other";
/** Map a Node network error to a plain-language class, so a blocked network is never reported as a broken site. */
export function classifyError(e: unknown): { kind: FetchFailure; message: string } {
  const err = e as { code?: string; message?: string };
  const code = String(err?.code ?? ""); const msg = String(err?.message ?? e);
  // TT37: failures of the upstream route (the proxy Fusion's server goes through) are named as such — never
  // blamed on the site
  if ((e as Error)?.name === "ProxyRouteError" || code === "EPROXYREFUSED") return { kind: "proxy", message: `The network route failed: ${msg}. Check Browser → Network route (or that Tor / the proxy is running).` };
  if (/onion addresses need/i.test(msg)) return { kind: "proxy", message: "Onion addresses (.onion) can only be opened through the Tor route. Set Browser → Network route to Tor (SOCKS5)." };
  if (/private|loopback|link-local|reserved/i.test(msg)) return { kind: "private", message: "Refused: the address is on a private or local network (the proxy never reaches inside your network)." };
  if (/local\/internal|SSRF/i.test(msg)) return { kind: "private", message: "Refused: local and internal host names are never proxied (SSRF guard)." };
  if (/only ports/i.test(msg)) return { kind: "scheme", message: "Only the standard web ports (80 and 443) can be proxied." };
  if (/only http|scheme|protocol/i.test(msg)) return { kind: "scheme", message: "Only http and https pages can be proxied." };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo|DNS/i.test(msg)) return { kind: "dns", message: "The site's name could not be resolved (DNS)." };
  if (code === "ECONNREFUSED") return { kind: "refused", message: "The site refused the connection." };
  if (code === "ECONNRESET" || code === "EPIPE" || /socket hang up|disconnected before secure TLS|ECONNRESET/i.test(msg)) return { kind: "reset", message: "The connection was cut during setup. This usually means a firewall or egress policy between this server and the site blocks it — not that the site is down." };
  if (code === "ETIMEDOUT" || /timed out|timeout/i.test(msg)) return { kind: "timeout", message: "The site did not answer in time." };
  if (/CERT|certificate|self.signed|SSL|TLS/i.test(code + msg)) return { kind: "tls", message: "The site's security certificate could not be verified, so the page was not loaded." };
  if (/exceeds|too large|limit/i.test(msg)) return { kind: "too-large", message: "The response was larger than the proxy's safety limit." };
  return { kind: "other", message: msg.slice(0, 200) };
}

// ---------------------------------------------------------------------------------------------------- CSRF
/**
 * Verdict for a state-changing request to our own /api. Browsers stamp every request with Sec-Fetch-Site and (for
 * non-GET) Origin; pages cannot forge either. Same-origin passes; a sandboxed frame ("null"), another site, or a
 * sibling subdomain is refused. Non-browser clients (no Sec-Fetch-Site, no Origin — scripts, curl, the test
 * harness) pass: CSRF needs a victim's browser.
 */
export function csrfVerdict(r: { method: string; path: string; origin: string | null; secFetchSite: string | null; hosts: string[] }): { ok: boolean; reason: string } {
  const m = r.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return { ok: true, reason: "safe method" };
  if (r.path.startsWith("/api/wp/s/")) return { ok: true, reason: "proxy (session capability)" };
  if (r.secFetchSite) {
    if (r.secFetchSite === "same-origin") return { ok: true, reason: "same-origin" };
    if (r.secFetchSite === "none") return { ok: true, reason: "user-initiated" };
    return { ok: false, reason: `cross-origin request (${r.secFetchSite})` };
  }
  if (r.origin === null) return { ok: true, reason: "no browser provenance" };
  if (r.origin === "null") return { ok: false, reason: "opaque origin" };
  try { const h = new URL(r.origin).host.toLowerCase(); if (r.hosts.some((x) => x.toLowerCase() === h)) return { ok: true, reason: "origin matches host" }; } catch { /* fallthrough */ }
  return { ok: false, reason: "foreign origin" };
}

export function escapeHtml(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }
