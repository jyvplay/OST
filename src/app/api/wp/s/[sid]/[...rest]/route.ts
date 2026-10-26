import { type NextRequest } from "next/server";
import {
  classifyError, decodeTarget, documentCsp, readerCsp, WP_PREFIX, downstreamHeaders, encodeAttr, encodeTarget, escapeHtml, isTracker, rewriteCss, rewriteHtml, rewriteModuleSource, siteOf, upstreamHeaders,
} from "@/lib/wp-core";
import { docInfo, docOrigin, getSession, newDoc, type WpSession } from "@/lib/server/wp-sessions";
import { corsCheck, inferDest, credCode, exposeHeaders, flagString, nextChainFlags, policyFor, PreflightCache, preflightCheck, scriptResponseHeaders, storableSetCookies, type Policy, resourcePolicy, storableForResource } from "@/lib/wp-cors";
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

/** TT42: a browser without Fetch Metadata gets Sec-Fetch-Dest / -Mode INFERRED from the URL tag and Accept (inferDest) */
const INFERRED = new WeakMap<NextRequest, { dest: string; mode: string }>();
const hdrDest = (req: NextRequest) => req.headers.get("sec-fetch-dest") ?? INFERRED.get(req)?.dest ?? null;
const hdrMode = (req: NextRequest) => req.headers.get("sec-fetch-mode") ?? INFERRED.get(req)?.mode ?? null;
/** A navigation (top-level or frame) per Fetch Metadata — browsers without it: per the inferred destination (TT42). */
function isNavigation(req: NextRequest): boolean {
  const dest = hdrDest(req), mode = hdrMode(req);
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
  const isDoc = /^(document|iframe|frame)$/.test(hdrDest(req) ?? "document");
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
  { const inf = inferDest((n) => req.headers.get(n), d); if (inf) INFERRED.set(req, inf); }
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
  const fdest = hdrDest(req), fmode = hdrMode(req);
  // TT40 (WP-16): a markup subresource ("<sid>:<doc>:r") — honoured only for what the BROWSER says is a subresource
  // load (not a navigation, not script: Sec-Fetch-Dest empty → the script rules below with "same-origin")
  const resTag0 = !!(d.resource && d.doc) && fdest !== "empty" && !isNavigation(req);
  // TT41: a subresource the BROWSER fetches in CORS mode (a module script or crossorigin element whose URL was set by
  // script, so it carries "r") is a credentials-"same-origin" CORS request of its document, not a no-cors load
  const corsRes = resTag0 && fmode === "cors";
  const resTag = resTag0 && !corsRes;
  const di = d.doc ? docInfo(s, d.doc) : null;
  const rp = resTag ? resourcePolicy({ initiator: di?.origin ?? null, target, siteOf, referrerUrl: di?.url, ancestorsCrossSite: di?.xs }) : null;
  // TT41 (WP-19): an iframe / frame of a proxied document ("<sid>:<doc>:f", honoured only when the browser says it is
  // loading a frame). Its navigation is cross-site for SameSite unless the frame is same-site with its parent AND the
  // parent's own ancestors are (Chromium's "site for cookies"): then only SameSite=None cookies go, only those may be
  // set, and the frame's document — and everything it loads — stays cross-site. An unknown parent counts as cross-site.
  const frameTag = !!(d.frame && d.doc) && /^(iframe|frame)$/.test(fdest ?? "");
  const fp = frameTag ? resourcePolicy({ initiator: di?.origin ?? null, target, siteOf, referrerUrl: di?.url, ancestorsCrossSite: di?.xs }) : null;
  const frameXs = !!fp && (!di || fp.crossSite);
  // (an "r" tag on anything the browser calls a navigation is ignored: it is an untagged navigation, as before)
  // (an "f" tag on a frame navigation is handled by fp; on any other navigation it is ignored like "r"; on anything
  // else — an image, a fetch — it gets the script rules below, never the untagged full jar)
  const pol: Policy | null = !resTag && !frameTag && (corsRes || (d.doc !== undefined && !d.resource && !(d.frame && isNavigation(req))) || fdest === "empty")
    ? policyFor({ initiator: d.doc ? docOrigin(s, d.doc) : null, target, cred: corsRes ? "same-origin" : d.cred ?? "same-origin", method, headers: req.headers.entries(), siteOf, referrerUrl: di?.url ?? null, chain: d.flags, ancestorsCrossSite: di?.xs })
    : null;
  const noCors = fmode === "no-cors"; // the response is opaque to the page anyway; the browser limits method and headers
  if (pol?.refused && !noCors) return corsRefused(pol.refused);
  if (pol && pol.needsPreflight && !noCors) {
    const pf = await preflight(s, pol, target, method);
    if (!pf.ok) return corsRefused(pf.reason);
  }
  const uh = upstreamHeaders(req.headers.entries(), target, { ua: s.ua, cookie: rp ? s.jar.header(target, Date.now(), false, rp.crossSite) : pol ? (pol.sendCookies ? s.jar.header(target, Date.now(), false, pol.crossSite) : "") : fp ? s.jar.header(target, Date.now(), false, frameXs) : s.jar.header(target), method });
  if (fp) {
    uh["sec-fetch-site"] = fp.secFetchSite; uh["sec-fetch-mode"] = "navigate"; uh["sec-fetch-dest"] = fdest!;
    if (fp.referer) uh.referer = fp.referer; else delete uh.referer;
  }
  if (rp) {
    uh["sec-fetch-site"] = rp.secFetchSite;
    if (rp.referer) uh.referer = rp.referer; else delete uh.referer;
    delete uh.origin; // no-cors GET subresources carry no Origin
  }
  if (pol) {
    if (pol.origin) uh.origin = pol.origin; else delete uh.origin;
    if (pol.referer) uh.referer = pol.referer; else delete uh.referer;
    // TT41: the destination the browser named (script, style, image, worker … for CORS-mode loads), "empty" for fetch()
    uh["sec-fetch-site"] = pol.secFetchSite; uh["sec-fetch-mode"] = noCors ? "no-cors" : "cors";
    uh["sec-fetch-dest"] = fdest && /^(script|style|image|font|audio|video|track|worker|sharedworker|manifest|json)$/.test(fdest) ? fdest : "empty";
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
  for (const line of rp ? storableForResource(rp.crossSite, scLines) : pol ? storableSetCookies(pol, scLines) : fp ? storableForResource(frameXs, scLines) : scLines) s.jar.set(line, target);

  const headers: Record<string, string> = pol
    ? { ...CORS, ...scriptResponseHeaders(uph), ...downstreamHeaders(uph), "access-control-expose-headers": exposeHeaders(pol, uph), "x-fusion-wp-target": target.href,
        // TT41 (WP-18): through the sandbox every response is "cors"; the shim reports "basic" for these, as natively
        ...(pol.sameOrigin ? { "x-fusion-wp-tainting": "basic" } : {}) }
    : { ...CORS, ...downstreamHeaders(uph), "x-fusion-wp-target": target.href };
  const loc = up.headers.location;
  if (up.status >= 300 && up.status < 400 && loc) {
    up.body.resume();
    let next: string | null = null;
    // a script request's redirect keeps its document and credentials tag; TT41: plus what the chain has done so far
    // (tainted origin, cross-origin / cross-site hops, referrer cut) — see wp-cors ChainFlags
    let nextUrl: URL | null = null;
    try { nextUrl = new URL(loc, target); } catch { /* bad Location */ }
    const seg = !d.doc ? s.sid
      : pol && nextUrl ? `${s.sid}:${d.doc}:${credCode(pol.cred)}${flagString(nextChainFlags(pol, target, nextUrl))}`
      : `${s.sid}:${d.doc}:${d.frame ? "f" : d.resource ? "r" : credCode(d.cred ?? "same-origin")}`;
    if (nextUrl) next = encodeTarget(nextUrl, seg);
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
    // a stylesheet loaded as a document's subresource passes that document on to its url() / @import loads
    // (with a child id: SameSite / Sec-Fetch-Site stay the PAGE's, the Referer becomes the stylesheet's URL)
    if (isCss) return new Response(rewriteCss(text, target, resTag ? `${s.sid}:${di ? newDoc(s, di.origin, target.href, di.xs) : d.doc}:r` : s.sid), { status: up.status, headers: { ...headers, "content-type": "text/css; charset=utf-8" } });
    // TT38 (G/I): page secrets go only into documents the BROWSER is navigating to. A page's own fetch() of another
    // site's HTML through the proxy (Sec-Fetch-Dest: empty — a header page script cannot set) gets neither that site's
    // script cookies nor its WebSocket origin token, so it cannot read them or open a socket in that site's name.
    const nav = isNavigation(req);
    const docId = nav ? newDoc(s, target.origin, target.href, frameXs) : "";
    const inject = `<script src="/wp-shim.js" data-fusion-wp="1" data-sid="${s.sid}" data-url="${encodeAttr(target.href)}" data-ua="${s.ua}" data-cookies="${nav ? encodeAttr(s.jar.header(target, Date.now(), true)) : ""}" data-wst="${nav ? originToken(s.sid, target.origin) : ""}" data-doc="${docId}"></script>`;
    const { html } = rewriteHtml(text, { sid: s.sid, url: target.href, inject, resSid: docId ? `${s.sid}:${docId}:r` : undefined });
    return new Response(html, {
      status: up.status,
      headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": documentCsp(selfOrigins(req), { nestedFrame: frameTag && !!di }) },
    });
  }
  // TT41 (WP-17): JavaScript the browser loads as a SCRIPT (module graph, classic script, worker, import()) has its
  // module specifiers proxied — inside the frame its base URL is the proxy's, so "/x.js", "../x.js" and absolute URLs
  // would otherwise go to Fusion's own host, past the proxy prefix, or straight to the network — and its
  // import.meta.url reads become the module's real address. Not for fetch() (Sec-Fetch-Dest: empty): a page reading
  // a script as text gets it byte for byte. Larger than the rewrite budget, or not lexable → served unchanged.
  const isJs = /^(text|application)\/(x-)?(javascript|ecmascript)\b|^text\/jscript\b/.test(type);
  if (isJs && up.status >= 200 && up.status < 300 && fdest && /^(script|worker|sharedworker)$/.test(fdest)) {
    const clen = Number(up.headers["content-length"] ?? 0);
    if (!(clen > TEXT_MAX) && !up.headers["content-encoding"]) {
      const chunks: Buffer[] = []; let size = 0, over = false;
      for await (const c of up.body as AsyncIterable<Buffer>) { chunks.push(c); size += c.length; if (size > TEXT_MAX) { over = true; break; } }
      s.stats.bytesIn += size;
      if (!over) {
        const text = decodeText(Buffer.concat(chunks, size), type);
        const seg = d.doc ? `${s.sid}:${d.doc}:s` : s.sid;
        const meta = new URL(target.href); meta.hash = "";
        const r = rewriteModuleSource(text, { base: target, seg, metaUrl: meta.href });
        const h: Record<string, string> = { ...headers, "content-type": "text/javascript; charset=utf-8", "x-fusion-wp-js": r.error ? `unchanged (${r.error.replace(/[^\x20-\x7e]/g, "?").slice(0, 80)})` : `${r.rewritten} specifiers, ${r.metaUrls} import.meta.url` };
        delete h["content-length"];
        return new Response(r.code, { status: up.status, headers: h });
      }
      // over budget: replay what was read, then the rest, unchanged
      const { Readable } = await import("node:stream");
      const rest = up.body as AsyncIterable<Buffer>;
      const replay = Readable.from((async function* () { for (const c of chunks) yield c; for await (const c of rest) yield c; })());
      return new Response(toWebStream(replay, (n) => { s.stats.bytesIn += n; }), { status: up.status, headers });
    }
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
  if (rest === "__shared-who" && req.method === "GET") return sharedWho(req, s);
  if (rest === "__shared-host" && req.method === "GET") return sharedHost(req, s);
  return new Response("unknown control endpoint", { status: 404, headers: CORS });
}

/** TT43 (WP-22): which site a document of this session really is — asked by the Fusion window's SharedWorker broker
 *  (src/lib/wp-shared-broker.ts) before it lets the document join a worker. The document id is a secret the server
 *  issued to that document alone; unknown or evicted ids get 404. Only same-origin callers (the Fusion window): a
 *  proxied page (opaque origin, Sec-Fetch-Site cross-site / Origin null) is refused. */
function fusionCaller(req: NextRequest): boolean {
  const site = req.headers.get("sec-fetch-site"), origin = req.headers.get("origin");
  if (origin === "null") return false;
  return site === null ? true : site === "same-origin";
}
function sharedWho(req: NextRequest, s: WpSession): Response {
  if (!fusionCaller(req)) return new Response("forbidden", { status: 403 });
  const di = docInfo(s, new URL(req.url).searchParams.get("d") ?? "");
  if (!di) return new Response(JSON.stringify({ error: "unknown document" }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  return new Response(JSON.stringify({ origin: di.origin, xs: di.xs }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
/** TT43 (WP-22): the hidden HOST document in which a site's shared workers run — a proxied document of the site the
 *  SERVER has on record for document d (never what a page claims), with its own document id (frame ancestry carried
 *  over), sandboxed like every proxied page, running only the proxy runtime in host mode. */
function sharedHost(req: NextRequest, s: WpSession): Response {
  if (!fusionCaller(req)) return new Response("forbidden", { status: 403 });
  const di = docInfo(s, new URL(req.url).searchParams.get("d") ?? "");
  if (!di) return new Response("unknown document", { status: 404, headers: { "cache-control": "no-store" } });
  const site = new URL("/", di.origin);
  const hd = newDoc(s, di.origin, site.href, di.xs);
  const inject = `<script src="/wp-shim.js" data-fusion-wp="1" data-shared-host="1" data-sid="${s.sid}" data-url="${encodeAttr(site.href)}" data-ua="${s.ua}" data-cookies="" data-wst="${originToken(s.sid, di.origin)}" data-doc="${hd}"></script>`;
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Shared worker host</title>${inject}</head><body></body></html>`, {
    status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": documentCsp(selfOrigins(req)) },
  });
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
