/**
 * TT39 (WP-10): per-origin isolation INSIDE one Private proxy session — the Fetch standard's rules for requests made
 * by page script (fetch / XMLHttpRequest / EventSource / workers), applied by the proxy server. Original code written
 * from the WHATWG Fetch standard (CORS protocol, CORS-safelisted request headers, CORS-preflight, credentials modes)
 * and RFC 6265bis (SameSite). Pure: no Node or DOM APIs.
 *
 * Why: every proxied page is served from Fusion's one origin with `Access-Control-Allow-Origin: *`, so without this a
 * page could read ANY site's responses — made with that site's cookies from the session jar — by script. A browser
 * forbids exactly that. Now each request carries the id of the document that made it (registered server-side at
 * navigation with that document's real origin), plus the page's credentials mode; the server decides what a browser
 * would: which cookies go, whether a preflight is needed and passes, and whether the page may read the answer. A
 * response the page may not read leaves the server WITHOUT Access-Control-Allow-Origin, so the browser itself fails
 * the request — the page sees the same TypeError as natively.
 */

export type Cred = "include" | "same-origin" | "omit";
const CRED_CODE: Record<string, Cred> = { i: "include", s: "same-origin", o: "omit" };
export function credCode(c: Cred): string { return c === "include" ? "i" : c === "omit" ? "o" : "s"; }

/** "<sid>" or "<sid>:<doc>:<cred>" (the session segment of a proxied path); TT40: "<sid>:<doc>:r" = a markup
 *  SUBRESOURCE (img / script / stylesheet / media …) of that document — no-cors, credentials "include", SameSite. */
export function parseSidSegment(seg: string): { sid: string; doc?: string; cred?: Cred; resource?: true } | null {
  const parts = seg.split(":");
  if (parts.length === 1) return { sid: seg };
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]{8,32}$/.test(parts[1])) return null;
  if (parts[2] === "r") return { sid: parts[0], doc: parts[1], resource: true };
  if (!CRED_CODE[parts[2]]) return null;
  return { sid: parts[0], doc: parts[1], cred: CRED_CODE[parts[2]] };
}

/**
 * TT40 (WP-16): a markup subresource's request, as a browser makes it (RFC 6265bis §5.2 "same-site" for subresources,
 * Fetch Metadata, Referrer Policy default strict-origin-when-cross-origin). The document is known from the tag; an
 * unknown / expired / forged document id counts as cross-site (fewer cookies, never more).
 *   cookies       all of the site's cookies when same-site; only SameSite=None ones when cross-site
 *   Set-Cookie    stored as for script requests: cross-site responses may store only SameSite=None cookies
 *   Sec-Fetch-Site / Referer   from the document's origin (the browser's own say "same-origin" for every proxied URL)
 */
export function resourcePolicy(o: { initiator: string | null; target: URL; siteOf: SiteOf; referrerUrl?: string | null }): { crossSite: boolean; secFetchSite: "same-origin" | "same-site" | "cross-site"; referer: string | null } {
  const init = o.initiator ? new URL(o.initiator) : null;
  const sameOrigin = !!init && init.origin === o.target.origin;
  const sameSite = !!init && init.protocol === o.target.protocol && o.siteOf(init.hostname) === o.siteOf(o.target.hostname);
  return {
    crossSite: !sameSite,
    secFetchSite: sameOrigin ? "same-origin" : sameSite ? "same-site" : "cross-site",
    referer: init ? strictOriginWhenCrossOrigin(o.referrerUrl ? new URL(o.referrerUrl) : init, o.target) : null,
  };
}
/** Referrer Policy "strict-origin-when-cross-origin" (the default): the full URL (no fragment, no credentials) to the
 *  same origin, only the origin elsewhere, nothing on an https → http downgrade. */
export function strictOriginWhenCrossOrigin(ref: URL, target: URL): string | null {
  if (ref.protocol === "https:" && target.protocol === "http:") return null;
  if (ref.origin !== target.origin) return `${ref.origin}/`;
  const u = new URL(ref.href); u.hash = ""; u.username = ""; u.password = "";
  return u.href;
}
export function storableForResource(crossSite: boolean, lines: string[]): string[] {
  return crossSite ? lines.filter((l) => /;\s*samesite\s*=\s*none\b/i.test(l)) : lines;
}

/** Registrable domain (passed in so this file stays free of the suffix list): "site" for SameSite decisions. */
export type SiteOf = (host: string) => string;

// ------------------------------------------------------------------------------------- CORS-safelisted headers
const SIMPLE_METHODS = new Set(["GET", "HEAD", "POST"]);
// Fetch §2.2.2 forbidden request-header names: page script can never set these, so they never count for CORS
const FORBIDDEN = new Set(["accept-charset", "accept-encoding", "access-control-request-headers", "access-control-request-method", "connection", "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host", "keep-alive", "origin", "referer", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade", "via", "user-agent"]);
// added by the browser itself (cache mode, client hints, priority) — not author headers
const UA_ADDED = new Set(["cache-control", "pragma", "priority", "purpose", "save-data", "downlink", "ect", "rtt", "device-memory", "dpr", "viewport-width", "width"]);
export function isAuthorHeader(name: string): boolean {
  const n = name.toLowerCase();
  return !FORBIDDEN.has(n) && !UA_ADDED.has(n) && !n.startsWith("proxy-") && !n.startsWith("sec-") && !n.startsWith("x-middleware-") && !n.startsWith("next-") && n !== "rsc" && !n.startsWith("x-forwarded-") && n !== "x-real-ip" && n !== "forwarded";
}
const TE = new TextEncoder();
const utf8Len = (v: string): number => TE.encode(v).length;
const UNSAFE_BYTE = /[\x00-\x08\x0a-\x1f"():<>?@[\\\]{}\x7f]/;
/** Fetch "CORS-safelisted request-header" (name, value). */
export function isSafelistedHeader(name: string, value: string): boolean {
  const n = name.toLowerCase();
  if (utf8Len(value) > 128) return false;
  switch (n) {
    case "accept": return !UNSAFE_BYTE.test(value);
    case "accept-language": case "content-language": return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
    case "content-type": {
      if (UNSAFE_BYTE.test(value)) return false;
      const essence = value.split(";")[0].trim().toLowerCase();
      return essence === "application/x-www-form-urlencoded" || essence === "multipart/form-data" || essence === "text/plain";
    }
    case "range": return /^bytes=\d+-\d*$/.test(value) && (() => { const m = /^bytes=(\d+)-(\d*)$/.exec(value)!; return m[2] === "" || Number(m[1]) <= Number(m[2]); })();
    default: return false;
  }
}
/** Fetch "CORS-unsafe request-header names": sorted, lower-case, de-duplicated (incl. the 1024-byte total rule). */
export function unsafeHeaderNames(headers: Iterable<[string, string]>): string[] {
  const unsafe = new Set<string>(); let safeBytes = 0; const safeNames: string[] = [];
  for (const [k, v] of headers) {
    if (!isAuthorHeader(k)) continue;
    const n = k.toLowerCase();
    if (isSafelistedHeader(n, v)) { safeBytes += utf8Len(v); safeNames.push(n); } else unsafe.add(n);
  }
  if (safeBytes > 1024) for (const n of safeNames) unsafe.add(n);
  return [...unsafe].sort();
}

// ------------------------------------------------------------------------------------- the policy for one request
export interface Policy {
  initiator: string | null; // the document's origin, or null = unverified (treated like an opaque origin: "null")
  cred: Cred;
  sameOrigin: boolean;
  sameSite: boolean;
  /** cookies attached at all, and if so whether only SameSite=None ones (cross-site) */
  sendCookies: boolean;
  crossSite: boolean;
  /** headers to put on the upstream request */
  origin: string | null; referer: string | null; secFetchSite: "same-origin" | "same-site" | "cross-site";
  needsPreflight: boolean;
  unsafeHeaders: string[];
}

export function policyFor(o: { initiator: string | null; target: URL; cred: Cred; method: string; headers: Iterable<[string, string]>; siteOf: SiteOf }): Policy {
  const method = o.method.toUpperCase();
  const init = o.initiator ? new URL(o.initiator) : null;
  const sameOrigin = !!init && init.origin === o.target.origin;
  // "same site" is schemeful (RFC 6265bis): http://a.example and https://a.example are different sites
  const sameSite = !!init && init.protocol === o.target.protocol && o.siteOf(init.hostname) === o.siteOf(o.target.hostname);
  const sendCookies = !!init && (o.cred === "include" || (o.cred === "same-origin" && sameOrigin));
  const unsafe = sameOrigin ? [] : unsafeHeaderNames(o.headers);
  const needsPreflight = !sameOrigin && (!SIMPLE_METHODS.has(method) || unsafe.length > 0);
  return {
    initiator: init ? init.origin : null, cred: o.cred, sameOrigin, sameSite, sendCookies, crossSite: !sameSite,
    // a browser sends Origin on every CORS request and on same-origin requests other than GET / HEAD
    origin: sameOrigin ? (method === "GET" || method === "HEAD" ? null : init!.origin) : (init ? init.origin : "null"),
    // strict-origin-when-cross-origin (the default policy): the page's origin, never its path, cross-origin;
    // nothing when going from https to http
    referer: init && !(init.protocol === "https:" && o.target.protocol === "http:") ? `${init.origin}/` : null,
    secFetchSite: sameOrigin ? "same-origin" : sameSite ? "same-site" : "cross-site",
    needsPreflight, unsafeHeaders: unsafe,
  };
}

type H = Record<string, string | string[] | undefined>;
const one = (h: H, k: string): string | undefined => { const v = h[k.toLowerCase()]; return Array.isArray(v) ? v.join(", ") : v; };

/** Fetch "CORS check": may the page read this response? */
export function corsCheck(p: Policy, res: H): { ok: true } | { ok: false; reason: string } {
  if (p.sameOrigin) return { ok: true };
  const acao = one(res, "access-control-allow-origin");
  const origin = p.initiator ?? "null";
  if (acao === undefined) return { ok: false, reason: "no Access-Control-Allow-Origin header" };
  if (acao.includes(",")) return { ok: false, reason: "multiple Access-Control-Allow-Origin values" };
  const v = acao.trim();
  if (v === "*" && p.cred !== "include") return { ok: true };
  if (v === "*") return { ok: false, reason: "wildcard Access-Control-Allow-Origin with credentials" };
  if (v !== origin) return { ok: false, reason: `Access-Control-Allow-Origin '${v}' does not match '${origin}'` };
  if (p.cred !== "include") return { ok: true };
  return one(res, "access-control-allow-credentials")?.trim() === "true" ? { ok: true } : { ok: false, reason: "credentials not allowed (Access-Control-Allow-Credentials is not 'true')" };
}

function tokens(v: string | undefined): string[] { return (v ?? "").split(",").map((x) => x.trim()).filter(Boolean); }

/**
 * The Fetch standard says `Access-Control-Allow-Headers: *` never covers Authorization. Deployed browsers do not
 * enforce that yet (Chromium allows it — verified against real Chromium by scripts/e2e-tt39.mts — behind the
 * CORSNonWildcardRequestHeadersSupport policy; Firefox only warns), so sites rely on it. The proxy follows what
 * browsers do; flip this when they start enforcing. Not a leak either way: the page itself set the header.
 */
export const STRICT_AUTH_WILDCARD = false;
const wildcardCovers = (name: string, strict: boolean) => !strict || name !== "authorization";

/** Fetch "CORS-preflight fetch" result check. Returns the cache lifetime in seconds when it passes. */
export function preflightCheck(p: Policy, method: string, status: number, res: H, strict = STRICT_AUTH_WILDCARD): { ok: true; maxAge: number; methods: string[]; headers: string[] } | { ok: false; reason: string } {
  if (status < 200 || status > 299) return { ok: false, reason: `preflight answered HTTP ${status}` };
  const c = corsCheck(p, res);
  if (!c.ok) return { ok: false, reason: `preflight: ${c.reason}` };
  const methods = tokens(one(res, "access-control-allow-methods"));
  const headerNames = tokens(one(res, "access-control-allow-headers")).map((x) => x.toLowerCase());
  const m = method.toUpperCase();
  const wildcardOk = p.cred !== "include";
  // methods are compared case-sensitively (the request method was already normalised); simple methods always pass
  if (!SIMPLE_METHODS.has(m) && !methods.includes(m) && !(wildcardOk && methods.includes("*"))) return { ok: false, reason: `method ${m} not allowed by preflight` };
  for (const name of p.unsafeHeaders) {
    if (headerNames.includes(name)) continue;
    // `*` covers any header name (see STRICT_AUTH_WILDCARD for Authorization), and only without credentials
    if (wildcardOk && headerNames.includes("*") && wildcardCovers(name, strict)) continue;
    return { ok: false, reason: `request header '${name}' not allowed by preflight` };
  }
  const ageRaw = one(res, "access-control-max-age");
  const age = ageRaw && /^\d+$/.test(ageRaw.trim()) ? Number(ageRaw.trim()) : 5; // default 5 s
  // an empty method list still caches the method this preflight was made for (Fetch, CORS-preflight fetch step 7.3)
  return { ok: true, maxAge: Math.min(age, 7200), methods: methods.length ? methods : [m], headers: headerNames }; // Chromium's 2-hour cap
}

/**
 * The CORS-preflight cache (Fetch §4.9): one entry per (initiator, credentials, URL, method-or-header-name), each with
 * its own expiry; `*` entries match any method / header name when credentials are not included.
 */
export class PreflightCache {
  private m = new Map<string, number>();
  private max: number;
  constructor(max = 2048) { this.max = max; }
  private k(p: Policy, url: string, kind: "m" | "h", name: string) { return `${p.initiator}|${p.cred}|${url}|${kind}|${name}`; }
  private live(key: string, now: number): boolean { const e = this.m.get(key); if (e === undefined) return false; if (e <= now) { this.m.delete(key); return false; } return true; }
  /** Does this request still need a preflight? */
  needs(p: Policy, url: string, method: string, now = Date.now(), strict = STRICT_AUTH_WILDCARD): boolean {
    const wild = p.cred !== "include", M = method.toUpperCase();
    if (!SIMPLE_METHODS.has(M) && !this.live(this.k(p, url, "m", M), now) && !(wild && this.live(this.k(p, url, "m", "*"), now))) return true;
    return p.unsafeHeaders.some((h) => !this.live(this.k(p, url, "h", h), now) && !(wild && wildcardCovers(h, strict) && this.live(this.k(p, url, "h", "*"), now)));
  }
  store(p: Policy, url: string, r: { maxAge: number; methods: string[]; headers: string[] }, now = Date.now()): void {
    if (r.maxAge <= 0) return;
    const exp = now + r.maxAge * 1000;
    for (const x of r.methods) this.m.set(this.k(p, url, "m", x), exp);
    for (const x of r.headers) this.m.set(this.k(p, url, "h", x), exp);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value as string);
  }
  get size(): number { return this.m.size; }
}

/** Set-Cookie lines a response may store: none without credentials; only SameSite=None ones from a cross-site request. */
export function storableSetCookies(p: Policy, lines: string[]): string[] {
  if (!p.sendCookies) return [];
  return p.crossSite ? lines.filter((l) => /;\s*samesite\s*=\s*none\b/i.test(l)) : lines;
}

/** Response headers the page may read: everything same-origin; cross-origin, the safelist plus what the site exposes. */
export function exposeHeaders(p: Policy, res: H): string {
  if (p.sameOrigin) return "*";
  const aceh = tokens(one(res, "access-control-expose-headers"));
  // "*" in Access-Control-Expose-Headers means all, but not with credentials
  if (aceh.includes("*") && p.cred !== "include") return "*";
  return [...new Set([...aceh.filter((x) => x !== "*").map((x) => x.toLowerCase()), "x-fusion-wp-target"])].join(", ");
}

/**
 * Response headers a script response may carry back (a site's own X-Total-Count, Link-less API headers…). Same
 * rules as for pages otherwise: nothing that would act on Fusion's own origin (cookies, CSP, HSTS, Clear-Site-Data,
 * auth prompts, Service-Worker scope, preload Link, Refresh) and nothing hop-by-hop or re-encoded.
 */
const SCRIPT_DROP = new Set(["set-cookie", "set-cookie2", "content-security-policy", "content-security-policy-report-only", "x-frame-options",
  "strict-transport-security", "alt-svc", "nel", "report-to", "reporting-endpoints", "connection", "keep-alive", "transfer-encoding",
  "content-encoding", "content-length", "permissions-policy", "feature-policy", "clear-site-data", "service-worker-allowed", "link", "refresh",
  "www-authenticate", "proxy-authenticate", "location", "sourcemap", "x-sourcemap", "origin-agent-cluster", "document-policy", "timing-allow-origin",
  "x-xss-protection", "x-content-type-options", "referrer-policy", "cache-control", "pragma", "upgrade", "trailer", "te", "accept-ch", "critical-ch",
  "speculation-rules", "no-vary-search", "x-dns-prefetch-control", "supports-loading-mode", "proxy-connection", "x-fusion-wp-target", "x-fusion-wp-cors"]);
export function scriptResponseHeaders(upstream: H): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(upstream)) {
    const key = k.toLowerCase();
    if (v === undefined || SCRIPT_DROP.has(key) || key.startsWith("access-control-") || key.startsWith("cross-origin-") || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(key)) continue;
    const val = (Array.isArray(v) ? v.join(", ") : v).replace(/[\r\n]/g, "");
    out[key] = val;
  }
  return out;
}
