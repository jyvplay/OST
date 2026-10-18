import { type NextRequest } from "next/server";
import {
  classifyError, decodeTarget, documentCsp, readerCsp, WP_PREFIX, downstreamHeaders, encodeAttr, encodeTarget, escapeHtml, isTracker, rewriteCss, rewriteHtml, siteOf, upstreamHeaders,
} from "@/lib/wp-core";
import { docOrigin, getSession, newDoc, type WpSession } from "@/lib/server/wp-sessions";
import { corsCheck, credCode, exposeHeaders, policyFor, PreflightCache, preflightCheck, scriptResponseHeaders, storableSetCookies, type Policy } from "@/lib/wp-cors";
import { readable, readerDocument } from "@/lib/reader-core";
import { decodeText, readAll, toWebStream, upstreamRequest } from "@/lib/server/wp-fetch";
import { openBridge, originToken, sendToBridge, WsOpenError, WS_MAX_MESSAGE } from "@/lib/server/wp-ws";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * TT35 — the Fusion web proxy. Every request a proxied page makes (document, CSS, image, script, font, media with
 * byte ranges, fetch / XHR with any method, form posts) comes back here, is checked, and is fetched server-side.
 * The page itself lives in an opaque origin (CSP sandbox) that may only load from this server, so it can neither
 * touch the desktop's own APIs or storage nor contact a third party directly.
 */
const TEXT_MAX = 8 * 1024 * 1024; // HTML / CSS are buffered to be rewritten: memory bound
const STREAM_MAX = 4 * 1024 * 1024 * 1024; // everything else streams through in constant memory (downloads, media)
const BODY_MAX = 8 * 1024 * 1024;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "content-length, content-range, accept-ranges, content-type, etag, last-modified, x-fusion-wp-target",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store", // amnesic: no proxied page ever lands in the browser's disk cache
};

/** A navigation (top-level or frame) per Fetch Metadata; browsers without it (pre-2023 Safari) are trusted as before. */
function isNavigation(req: NextRequest): boolean {
  const dest = req.headers.get("sec-fetch-dest"), mode = req.headers.get("sec-fetch-mode");
  if (!dest && !mode) return true;
  return /^(document|iframe|frame|embed|object)$/.test(dest ?? "") || mode === "navigate";
}

function selfOrigins(req: NextRequest): string[] {
  const hosts = new Set<string>();
  for (const h of [req.headers.get("host"), req.headers.get("x-forwarded-host")]) for (const x of (h ?? "").split(",")) if (x.trim()) hosts.add(x.trim());
  const out: string[] = [];
  for (const h of hosts) out.push(`http://${h}`, `https://${h}`);
  return out;
}

function errorPage(req: NextRequest, target: string, status: number, title: string, detail: string): Response {
  const isDoc = /^(document|iframe|frame)$/.test(req.headers.get("sec-fetch-dest") ?? "document");
  if (!isDoc) return new Response(`${title}: ${detail}`, { status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } });
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f8fa;color:#1f2328}
main{max-width:560px;padding:28px;background:#fff;border:1px solid #d0d7de;border-radius:14px}h1{font-size:19px;margin:0 0 8px}code{background:#eef1f4;padding:1px 5px;border-radius:5px;word-break:break-all}</style></head>
<body><main data-fusion-wp-error="${encodeAttr(title)}"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p><p><code>${escapeHtml(target)}</code></p></main></body></html>`;
  return new Response(html, { status, headers: { ...CORS, "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" } });
}

/**
 * TT39 (WP-10): a script request the page may not make or read. Leaving out Access-Control-Allow-Origin makes the
 * BROWSER fail it exactly as it fails a native cross-origin request (TypeError, no status, no body); the reason is in
 * a header only a non-browser client (a test) can see.
 */
function corsRefused(reason: string): Response {
  return new Response(null, { status: 403, headers: { "x-fusion-wp-cors": reason.replace(/[^\x20-\x7e]/g, "?").slice(0, 300), "cache-control": "no-store" } });
}

/** The site's own CORS preflight (OPTIONS), made by the proxy the way a browser would, cached per Fetch §4.9. */
async function preflight(s: WpSession, pol: Policy, target: URL, method: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const cache = (s.preflights ??= new PreflightCache());
  if (!cache.needs(pol, target.href, method)) return { ok: true };
  const h: Record<string, string> = {
    accept: "*/*", "access-control-request-method": method, origin: pol.origin ?? pol.initiator ?? "null",
    "user-agent": upstreamHeaders([], target, { ua: s.ua, cookie: "", method: "GET" })["user-agent"], "accept-language": "en-US,en;q=0.9",
    "sec-fetch-mode": "cors", "sec-fetch-site": pol.secFetchSite, "sec-fetch-dest": "empty",
  };
  if (pol.unsafeHeaders.length) h["access-control-request-headers"] = pol.unsafeHeaders.join(",");
  if (pol.referer) h.referer = pol.referer;
  let r;
  try { r = await upstreamRequest(target.href, { method: "OPTIONS", maxBytes: 1 << 20, session: { sid: s.sid, circuit: s.circuit }, headers: h }); }
  catch (e) { return { ok: false, reason: `preflight failed: ${classifyError(e).message}` }; }
  r.body.resume();
  const c = preflightCheck(pol, method, r.status, r.headers as Record<string, string | string[] | undefined>);
  if (!c.ok) return c;
  cache.store(pol, target.href, c);
  return { ok: true };
}

async function handle(req: NextRequest): Promise<Response> {
  const raw = new URL(req.url);
  let d: ReturnType<typeof decodeTarget>;
  try { d = decodeTarget(raw.pathname, raw.search); } catch (e) { return errorPage(req, raw.pathname, 400, "Not a proxy address", (e as Error).message); }
  const s = getSession(d.sid);
  if (!s) return errorPage(req, raw.pathname, 403, "Proxy session ended", "This proxied page belonged to a session that has expired or was closed. Reload the tab from Fusion's address bar to start a new one.");
  if (d.rest.startsWith("__")) return control(req, s, d.rest);

  const target = d.target;
  s.stats.requests++;
  if (isTracker(target.hostname)) {
    s.stats.blocked++;
    s.stats.blockedHosts[target.hostname] = (s.stats.blockedHosts[target.hostname] ?? 0) + 1;
    return new Response(null, { status: 204, headers: { ...CORS, "x-fusion-wp-blocked": "tracker" } });
  }
  const method = req.method.toUpperCase();
  let body: Buffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > BODY_MAX) return errorPage(req, target.href, 413, "Upload too large", "The proxy forwards request bodies up to 8 MB.");
    body = Buffer.from(await req.arrayBuffer());
    if (body.length > BODY_MAX) return errorPage(req, target.href, 413, "Upload too large", "The proxy forwards request bodies up to 8 MB.");
  }
  // TT39 (WP-10): requests made by page SCRIPT — tagged by the shim with the document that made them, or marked by
  // the browser itself (Sec-Fetch-Dest: empty, which script cannot change) — follow the Fetch standard's rules for
  // that document's origin. An untagged or forged-tag script request has no verified origin: it is treated like one
  // from an opaque origin ("null") and carries no cookies. Browsers without Fetch Metadata keep the TT35 behaviour for
  // untagged requests.
  const fdest = req.headers.get("sec-fetch-dest"), fmode = req.headers.get("sec-fetch-mode");
  const pol: Policy | null = d.doc !== undefined || fdest === "empty"
    ? policyFor({ initiator: d.doc ? docOrigin(s, d.doc) : null, target, cred: d.cred ?? "same-origin", method, headers: req.headers.entries(), siteOf })
    : null;
  const noCors = fmode === "no-cors"; // the response is opaque to the page anyway; the browser limits method and headers
  if (pol && pol.needsPreflight && !noCors) {
    const pf = await preflight(s, pol, target, method);
    if (!pf.ok) return corsRefused(pf.reason);
  }
  const uh = upstreamHeaders(req.headers.entries(), target, { ua: s.ua, cookie: pol ? (pol.sendCookies ? s.jar.header(target, Date.now(), false, pol.crossSite) : "") : s.jar.header(target), method });
  if (pol) {
    if (pol.origin) uh.origin = pol.origin; else delete uh.origin;
    if (pol.referer) uh.referer = pol.referer; else delete uh.referer;
    uh["sec-fetch-site"] = pol.secFetchSite; uh["sec-fetch-mode"] = noCors ? "no-cors" : "cors"; uh["sec-fetch-dest"] = "empty";
  }
  let up;
  try {
    up = await upstreamRequest(target.href, {
      method, body, maxBytes: STREAM_MAX, session: { sid: s.sid, circuit: s.circuit },
      headers: uh,
    });
  } catch (e) {
    s.stats.errors++;
    const c = classifyError(e);
    // which hosts could not be reached, and why (shown in the toolbar: a page missing its CSS says where it went)
    if (Object.keys(s.stats.failedHosts).length < 50 || s.stats.failedHosts[target.hostname]) s.stats.failedHosts[target.hostname] = c.kind;
    return errorPage(req, target.href, c.kind === "private" || c.kind === "scheme" ? 403 : 502, `Could not reach ${target.hostname}`, c.message);
  }
  const uph = up.headers as Record<string, string | string[] | undefined>;
  // TT39: the CORS check runs on every response of a cross-origin script request, redirects included
  if (pol && !pol.sameOrigin && !noCors) {
    const c = corsCheck(pol, uph);
    if (!c.ok) { up.body.resume(); return corsRefused(c.reason); }
  }
  // cookies stay in this session's jar; the page never sees Set-Cookie. TT39: a script request stores cookies only if
  // it was allowed to send them, and a cross-site one only SameSite=None cookies.
  const sc = up.headers["set-cookie"];
  const scLines = Array.isArray(sc) ? sc : sc ? [sc] : [];
  for (const line of pol ? storableSetCookies(pol, scLines) : scLines) s.jar.set(line, target);

  const headers: Record<string, string> = pol
    ? { ...CORS, ...scriptResponseHeaders(uph), ...downstreamHeaders(uph), "access-control-expose-headers": exposeHeaders(pol, uph), "x-fusion-wp-target": target.href }
    : { ...CORS, ...downstreamHeaders(uph), "x-fusion-wp-target": target.href };
  const loc = up.headers.location;
  if (up.status >= 300 && up.status < 400 && loc) {
    up.body.resume();
    let next: string | null = null;
    // a script request's redirect keeps its document and credentials tag
    const seg = d.doc ? `${s.sid}:${d.doc}:${credCode(d.cred ?? "same-origin")}` : s.sid;
    try { next = encodeTarget(new URL(loc, target), seg); } catch { /* bad Location */ }
    if (!next) return errorPage(req, target.href, 502, "Unsupported redirect", `The site redirected to an address the proxy will not follow: ${String(loc).slice(0, 200)}`);
    return new Response(null, { status: up.status, headers: { ...headers, location: next } });
  }
  const type = String(up.headers["content-type"] ?? "").toLowerCase();
  const isHtml = /text\/html|application\/xhtml\+xml/.test(type);
  const isCss = /text\/css/.test(type);
  if (method === "HEAD" || up.status === 204 || up.status === 304) { up.body.resume(); return new Response(null, { status: up.status, headers }); }

  if (isHtml || isCss) {
    let buf: Buffer;
    try { buf = await readAll(up.body, TEXT_MAX); } catch (e) { const c = classifyError(e); return errorPage(req, target.href, 502, `Could not read ${target.hostname}`, c.message); }
    s.stats.bytesIn += buf.length;
    const text = decodeText(buf, type);
    if (isCss) return new Response(rewriteCss(text, target, s.sid), { status: up.status, headers: { ...headers, "content-type": "text/css; charset=utf-8" } });
    // TT38 (G/I): page secrets go only into documents the BROWSER is navigating to. A page's own fetch() of another
    // site's HTML through the proxy (Sec-Fetch-Dest: empty — a header page script cannot set) gets neither that site's
    // script cookies nor its WebSocket origin token, so it cannot read them or open a socket in that site's name.
    const nav = isNavigation(req);
    const inject = `<script src="/wp-shim.js" data-fusion-wp="1" data-sid="${s.sid}" data-url="${encodeAttr(target.href)}" data-ua="${s.ua}" data-cookies="${nav ? encodeAttr(s.jar.header(target, Date.now(), true)) : ""}" data-wst="${nav ? originToken(s.sid, target.origin) : ""}" data-doc="${nav ? newDoc(s, target.origin) : ""}"></script>`;
    const { html } = rewriteHtml(text, { sid: s.sid, url: target.href, inject });
    return new Response(html, {
      status: up.status,
      headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": documentCsp(selfOrigins(req)) },
    });
  }
  // everything else streams straight through (images, scripts, fonts, media with Range → 206)
  // TT38: Server-Sent Events (EventSource) must arrive event by event — never buffered or compressed on the way
  if (/^text\/event-stream/.test(type)) { headers["cache-control"] = "no-store, no-transform"; headers["x-accel-buffering"] = "no"; }
  const len = up.headers["content-length"];
  if (len && !up.headers["content-encoding"]) headers["content-length"] = String(len);
  return new Response(toWebStream(up.body, (n) => { s.stats.bytesIn += n; }), { status: up.status, headers });
}

/** Control endpoints inside a session: the page's document.cookie writes come back here. */
async function control(req: NextRequest, s: WpSession, rest: string): Promise<Response> {
  // TT38 (WP-08): WebSocket bridge (src/lib/server/wp-ws.ts) — the shim's WebSocket class talks to these
  if (rest === "__ws/open" && req.method === "POST") {
    let j: { url?: unknown; protocols?: unknown; origin?: unknown; token?: unknown };
    try { j = JSON.parse((await req.text()).slice(0, 16384)); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
    const protocols = Array.isArray(j.protocols) ? j.protocols.map(String).slice(0, 32) : [];
    let stream: ReadableStream<Uint8Array>;
    try { stream = openBridge(s, { url: String(j.url ?? ""), protocols, origin: typeof j.origin === "string" ? j.origin : undefined, token: typeof j.token === "string" ? j.token : undefined, signal: req.signal }); }
    catch (e) { return new Response((e as Error).message, { status: e instanceof WsOpenError ? e.status : 400, headers: { ...CORS, "content-type": "text/plain; charset=utf-8" } }); }
    // octet-stream + no-transform: no compression layer may hold frames back; x-accel-buffering for nginx in front
    return new Response(stream, { status: 200, headers: { ...CORS, "content-type": "application/octet-stream", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" } });
  }
  const wsSend = /^__ws\/([0-9a-f]{32})$/.exec(rest);
  if (wsSend && req.method === "POST") {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > WS_MAX_MESSAGE + 64) return new Response("message too large", { status: 413, headers: CORS });
    const body = Buffer.from(await req.arrayBuffer());
    if (body.length > WS_MAX_MESSAGE + 64) return new Response("message too large", { status: 413, headers: CORS });
    return new Response(null, { status: sendToBridge(s.sid, wsSend[1], body), headers: CORS });
  }
  if (rest === "__cookie" && req.method === "POST") {
    let j: { url?: string; cookie?: string };
    try { j = JSON.parse((await req.text()).slice(0, 8192)); } catch { return new Response("bad json", { status: 400, headers: CORS }); }
    let u: URL;
    try { u = new URL(String(j.url)); } catch { return new Response("bad url", { status: 400, headers: CORS }); }
    const why = s.jar.set(String(j.cookie ?? ""), u, Date.now(), true);
    return new Response(why ? JSON.stringify({ refused: why }) : null, { status: why ? 200 : 204, headers: CORS });
  }
  if (rest === "__raw" && req.method === "GET") {
    // Save to Files: the ORIGINAL bytes of one resource (no rewriting). Never renderable on our origin: forced to an
    // octet-stream attachment inside a CSP sandbox; the real type travels in x-fusion-wp-type.
    let u: URL;
    try { u = new URL(String(new URL(req.url).searchParams.get("u"))); } catch { return new Response("bad url", { status: 400, headers: CORS }); }
    if (isTracker(u.hostname)) return new Response("blocked", { status: 403, headers: CORS });
    try {
      const up = await upstreamRequest(u.href, { method: "GET", maxBytes: 20 * 1024 * 1024, session: { sid: s.sid, circuit: s.circuit }, headers: upstreamHeaders([], u, { ua: s.ua, cookie: s.jar.header(u), method: "GET" }) });
      if (up.status >= 300 && up.status < 400) { up.body.resume(); return new Response(`redirected to ${String(up.headers.location ?? "")}`, { status: 409, headers: CORS }); }
      const buf = await readAll(up.body);
      return new Response(new Uint8Array(buf), { status: up.status, headers: { ...CORS, "content-type": "application/octet-stream", "content-disposition": "attachment", "content-security-policy": "sandbox; default-src 'none'", "x-fusion-wp-type": String(up.headers["content-type"] ?? "").replace(/[\r\n]/g, "").slice(0, 200), "access-control-expose-headers": "x-fusion-wp-type" } });
    } catch (e) { return new Response(classifyError(e).message, { status: 502, headers: CORS }); }
  }
  if (rest === "__reader" && req.method === "GET") return reader(req, s);
  return new Response("unknown control endpoint", { status: 404, headers: CORS });
}

/** TT36 (PR-07k): reader view of any page, fetched within this session (its cookies and identity). Links stay in the
 *  reader, images come through the proxy; redirects are followed here (≤ 5 hops, each re-checked by netguard). */
async function reader(req: NextRequest, s: WpSession): Promise<Response> {
  let u: URL;
  try { u = new URL(String(new URL(req.url).searchParams.get("u"))); } catch { return errorPage(req, "", 400, "Reader", "Not a web address."); }
  if (u.protocol !== "http:" && u.protocol !== "https:") return errorPage(req, u.href, 400, "Reader", "Reader works on http and https pages.");
  if (isTracker(u.hostname)) return errorPage(req, u.href, 403, "Reader", "That host is on the tracker list.");
  let up: Awaited<ReturnType<typeof upstreamRequest>> | null = null;
  for (let hop = 0; hop <= 5; hop++) {
    s.stats.requests++;
    try {
      up = await upstreamRequest(u.href, { method: "GET", maxBytes: TEXT_MAX + 1, session: { sid: s.sid, circuit: s.circuit }, headers: upstreamHeaders([], u, { ua: s.ua, cookie: s.jar.header(u), method: "GET" }) });
    } catch (e) {
      s.stats.errors++;
      const c = classifyError(e);
      if (Object.keys(s.stats.failedHosts).length < 50 || s.stats.failedHosts[u.hostname]) s.stats.failedHosts[u.hostname] = c.kind;
      return errorPage(req, u.href, c.kind === "private" || c.kind === "scheme" ? 403 : 502, `Could not reach ${u.hostname}`, c.message);
    }
    const sc = up.headers["set-cookie"];
    for (const line of Array.isArray(sc) ? sc : sc ? [sc] : []) s.jar.set(line, u);
    if (up.status >= 300 && up.status < 400 && up.headers.location) {
      up.body.resume();
      try { u = new URL(String(up.headers.location), u); } catch { return errorPage(req, u.href, 502, "Reader", "The site sent a bad redirect."); }
      up = null;
      continue;
    }
    break;
  }
  if (!up) return errorPage(req, u.href, 502, "Reader", "Too many redirects.");
  const type = String(up.headers["content-type"] ?? "").toLowerCase();
  if (!/text\/html|application\/xhtml\+xml/.test(type)) { up.body.resume(); return errorPage(req, u.href, 415, "Reader", `Reader works on web pages; this address is ${type.split(";")[0] || "not a page"}.`); }
  let buf: Buffer;
  try { buf = await readAll(up.body, TEXT_MAX); } catch (e) { return errorPage(req, u.href, 502, `Could not read ${u.hostname}`, classifyError(e).message); }
  s.stats.bytesIn += buf.length;
  const r = readable(decodeText(buf, type), u.href, (abs, kind) => {
    if (kind === "image") return isTracker(new URL(abs).hostname) ? null : encodeTarget(abs, s.sid);
    return `${WP_PREFIX}${s.sid}/__reader?u=${encodeURIComponent(abs)}`;
  });
  const inject = `<script src="/wp-shim.js" data-fusion-wp="1" data-sid="${s.sid}" data-url="${encodeAttr(u.href)}" data-ua="${s.ua}" data-cookies="" data-reader="1"></script>`;
  const html = readerDocument(r, { target: u.href, inject, original: encodeTarget(u.href, s.sid) ?? "#" });
  return new Response(html, { status: up.status, headers: { ...CORS, "content-type": "text/html; charset=utf-8", "content-security-policy": readerCsp(selfOrigins(req)), "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-fusion-wp-target": u.href } });
}

export const GET = handle, HEAD = handle, POST = handle, PUT = handle, PATCH = handle, DELETE = handle;
export function OPTIONS(req: NextRequest): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "access-control-allow-headers": (req.headers.get("access-control-request-headers") ?? "content-type").slice(0, 1000),
      "access-control-max-age": "600",
    },
  });
}
