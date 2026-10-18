import { type NextRequest } from "next/server";
import {
  classifyError, decodeTarget, documentCsp, downstreamHeaders, encodeAttr, encodeTarget, escapeHtml, isTracker, rewriteCss, rewriteHtml, upstreamHeaders,
} from "@/lib/wp-core";
import { getSession, type WpSession } from "@/lib/server/wp-sessions";
import { decodeText, readAll, toWebStream, upstreamRequest } from "@/lib/server/wp-fetch";

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
  let up;
  try {
    up = await upstreamRequest(target.href, {
      method, body, maxBytes: STREAM_MAX,
      headers: upstreamHeaders(req.headers.entries(), target, { ua: s.ua, cookie: s.jar.header(target), method }),
    });
  } catch (e) {
    s.stats.errors++;
    const c = classifyError(e);
    // which hosts could not be reached, and why (shown in the toolbar: a page missing its CSS says where it went)
    if (Object.keys(s.stats.failedHosts).length < 50 || s.stats.failedHosts[target.hostname]) s.stats.failedHosts[target.hostname] = c.kind;
    return errorPage(req, target.href, c.kind === "private" || c.kind === "scheme" ? 403 : 502, `Could not reach ${target.hostname}`, c.message);
  }
  // cookies stay in this session's jar; the page never sees Set-Cookie
  const sc = up.headers["set-cookie"];
  for (const line of Array.isArray(sc) ? sc : sc ? [sc] : []) s.jar.set(line, target);

  const headers: Record<string, string> = { ...CORS, ...downstreamHeaders(up.headers as Record<string, string | string[] | undefined>), "x-fusion-wp-target": target.href };
  const loc = up.headers.location;
  if (up.status >= 300 && up.status < 400 && loc) {
    up.body.resume();
    let next: string | null = null;
    try { next = encodeTarget(new URL(loc, target), s.sid); } catch { /* bad Location */ }
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
    const inject = `<script src="/wp-shim.js" data-fusion-wp="1" data-sid="${s.sid}" data-url="${encodeAttr(target.href)}" data-ua="${s.ua}" data-cookies="${encodeAttr(s.jar.header(target, Date.now(), true))}"></script>`;
    const { html } = rewriteHtml(text, { sid: s.sid, url: target.href, inject });
    return new Response(html, {
      status: up.status,
      headers: { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": documentCsp(selfOrigins(req)) },
    });
  }
  // everything else streams straight through (images, scripts, fonts, media with Range → 206)
  const len = up.headers["content-length"];
  if (len && !up.headers["content-encoding"]) headers["content-length"] = String(len);
  return new Response(toWebStream(up.body, (n) => { s.stats.bytesIn += n; }), { status: up.status, headers });
}

/** Control endpoints inside a session: the page's document.cookie writes come back here. */
async function control(req: NextRequest, s: WpSession, rest: string): Promise<Response> {
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
      const up = await upstreamRequest(u.href, { method: "GET", maxBytes: 20 * 1024 * 1024, headers: upstreamHeaders([], u, { ua: s.ua, cookie: s.jar.header(u), method: "GET" }) });
      if (up.status >= 300 && up.status < 400) { up.body.resume(); return new Response(`redirected to ${String(up.headers.location ?? "")}`, { status: 409, headers: CORS }); }
      const buf = await readAll(up.body);
      return new Response(new Uint8Array(buf), { status: up.status, headers: { ...CORS, "content-type": "application/octet-stream", "content-disposition": "attachment", "content-security-policy": "sandbox; default-src 'none'", "x-fusion-wp-type": String(up.headers["content-type"] ?? "").replace(/[\r\n]/g, "").slice(0, 200), "access-control-expose-headers": "x-fusion-wp-type" } });
    } catch (e) { return new Response(classifyError(e).message, { status: 502, headers: CORS }); }
  }
  return new Response("unknown control endpoint", { status: 404, headers: CORS });
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
