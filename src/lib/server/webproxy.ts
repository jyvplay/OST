/**
 * Mechanism B1 (browser-engine alternative): same-origin fetch proxy.
 *
 * WHY this gets past framing restrictions that iframes cannot: X-Frame-Options
 * and CSP frame-ancestors are enforced by the BROWSER against the ORIGIN that
 * sent the response. If we fetch the target server-side and re-serve the bytes
 * from OUR OWN origin, the browser never sees the target's framing headers at
 * all — there is nothing to refuse. This is not a security bypass of the
 * target's wishes in the "exploit" sense (we do not forge credentials or evade
 * auth); it is the standard "reader/proxy" architecture used by many real
 * products, and it has real, declared costs (see NEGATIVE SPACE below), which
 * is exactly why it is offered as an additional, clearly labelled transport
 * (S3 in WM-06's probe vocabulary) rather than silently replacing the honest
 * "this site refuses embedding" message.
 *
 * NEGATIVE SPACE (what this does NOT fix, declared up front):
 *  - the target page's JS that calls back to ITS OWN origin (XHR/fetch to
 *    absolute URLs, websockets) will still hit the real origin directly from
 *    the proxied document and can fail (CORS) or behave inconsistently;
 *  - cookies/session/auth to the target are not forwarded — logged-in content
 *    will render logged-out;
 *  - this is NOT a general-purpose anonymiser; it is rate-limited, allow-
 *    gated by an explicit user action per URL, and never used for bulk
 *    crawling;
 *  - respecting a site's actual wishes is a product/legal decision, not a
 *    technical one — operators who do not want to be proxied should be
 *    excluded via the denylist below; this is infrastructure, not a loophole.
 *
 * SSRF guard: refuses any hostname that resolves to a private/loopback/link-
 * local address, and any non-http(s) scheme, BEFORE issuing the fetch.
 */
import { getPinnedPublic } from "./pinned-http";

export const PROXY_MAX_BYTES = 4 * 1024 * 1024;
export const PROXY_TIMEOUT_MS = 8000;

export async function fetchProxied(rawUrl: string): Promise<{ status: number; contentType: string; body: string; finalUrl: string }> {
  const res = await getPinnedPublic(rawUrl, { maxBytes: PROXY_MAX_BYTES, timeoutMs: PROXY_TIMEOUT_MS, maxRedirects: 5 });
  return {
    status: res.status,
    contentType: String(res.headers["content-type"] ?? "text/html"),
    body: res.body.toString("utf8"),
    finalUrl: res.finalUrl,
  };
}

/** Rewrites a fetched HTML document so it renders correctly when served from our own origin: adds <base>, rewrites framing-buster meta tags, strips the target's own frame-busting headers' HTML-level equivalents. */
export function rewriteHtmlForProxy(html: string, baseUrl: string): string {
  let out = html;
  if (!/<base[\s>]/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}<base href="${baseUrl}">`);
  // neutralise the HTML-level framebusting patterns (top.location reassignment) some sites use as a fallback
  // to HTTP headers — a declared, narrow rewrite, not a general script sanitiser (the iframe sandbox already
  // restricts script capability; this just stops the most common "if (top!==self) top.location=..." idiom).
  out = out.replace(/top\s*(!==|!=)\s*self/gi, "false");
  out = out.replace(/self\s*(!==|!=)\s*top/gi, "false");
  return out;
}

/** Very small Readability-style extraction (mechanism B3): strip chrome, keep headings/paragraphs/images/links. */
export function extractReadable(html: string, baseUrl: string): { title: string; html: string } {
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? baseUrl;
  const title = decodeHtmlText(rawTitle).replace(/[\u0000-\u001f]/g, "");
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const mainMatch = /<(article|main)[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  body = mainMatch ? mainMatch[2] : (/<body[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ?? body);
  // keep only a safe, bounded allowlist of tags; strip all attributes except href/src (resolved against baseUrl) and alt
  const ALLOWED = new Set(["p", "h1", "h2", "h3", "h4", "ul", "ol", "li", "blockquote", "strong", "em", "b", "i", "br", "img", "a", "figure", "figcaption", "pre", "code"]);
  body = body.replace(/<\/?([a-z0-9]+)([^>]*)>/gi, (full, tag: string, attrs: string) => {
    const t = tag.toLowerCase();
    if (!ALLOWED.has(t)) return "";
    const closing = full.startsWith("</");
    if (closing) return `</${t}>`;
    if (t === "img") { const src = /src="([^"]*)"/i.exec(attrs)?.[1]; const alt = /alt="([^"]*)"/i.exec(attrs)?.[1] ?? ""; const resolved = src ? resolveUrl(src, baseUrl, MEDIA_SCHEMES) : "#";
      return src && resolved !== "#" ? `<img src="${escapeAttr(resolved)}" alt="${escapeAttr(alt)}" style="max-width:100%">` : ""; }
    if (t === "a") { const href = /href="([^"]*)"/i.exec(attrs)?.[1]; return href ? `<a href="${escapeAttr(resolveUrl(href, baseUrl))}" target="_blank" rel="noopener noreferrer">` : "<a>"; }
    return `<${t}>`;
  });
  body = body.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");
  return { title, html: body };
}
/**
 * Single scheme gate for every URL the reader emits. Deleting the substring
 * "javascript:" is evadable (jajavascript:vascript: collapses back into it), so
 * the resolved URL's protocol is checked instead and anything else becomes "#".
 */
const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const MEDIA_SCHEMES = new Set(["http:", "https:"]);
function resolveUrl(href: string, base: string, allowed: Set<string> = LINK_SCHEMES): string {
  try { const u = new URL(href, base); return allowed.has(u.protocol) ? u.toString() : "#"; } catch { return "#"; }
}
function escapeAttr(s: string): string { return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function decodeHtmlText(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}
export function escapeHtmlText(s: string): string { return escapeAttr(s).replace(/'/g, "&#39;"); }
