import { NextResponse, type NextRequest } from "next/server";
import { csrfVerdict } from "@/lib/wp-core";

/**
 * TT23 repair: a malformed JSON body used to crash ~25 API route handlers (`await req.json()` threw, giving an
 * unhandled 500 and a stack in the server log). One edge check instead of 25 edits: a non-empty body that claims
 * to be JSON but does not parse gets a 400 with a plain message before the route runs.
 *
 * Empty bodies pass through unchanged; routes keep their own field validation. Only /api is matched.
 */
/**
 * TT37 root cause of the long-unexplained `uncaughtException: Error: aborted` (ECONNRESET): when this proxy answers a
 * request with a body ITSELF, Next 16 has already swapped the request's body for a buffered copy
 * (body-streams replaceRequestBody), which also replaces the IncomingMessage's listeners and _destroy — and only the
 * NextResponse.next() / rewrite path re-attaches an `error` listener. A client that then hangs up makes Node's
 * abortIncoming emit an error nobody listens to (vercel/next.js#99278). Reproduced 6/6 with raw-socket resets
 * (scripts/e2e-tt37.mts, "client resets"), 0/3 on the next() path. So refusals are now REWRITTEN to /api/refused,
 * which answers with the same status and body through Next's normal route path.
 */
function refuse(req: NextRequest, status: 400 | 403, error: string) {
  const u = req.nextUrl.clone();
  u.pathname = "/api/refused"; u.search = "";
  // request headers, not the query: a middleware rewrite's query did not reach the route (found by the 400 check)
  const headers = new Headers(req.headers);
  headers.set("x-fusion-refused-status", String(status));
  headers.set("x-fusion-refused-error", encodeURIComponent(error));
  return NextResponse.rewrite(u, { request: { headers } });
}

export async function proxy(req: NextRequest) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return NextResponse.next();
  // TT108: the refusal target must be exempt from this matcher. A rewrite re-enters the
  // middleware, so the rewritten request was judged a second time — and it still carried
  // the cross-site Origin (or the malformed body) that caused the refusal, so it was
  // rewritten again, and again. In a development build the loop is absorbed; in a
  // production build Next proxies each hop over HTTP and the client got nothing for
  // thirty seconds and then a 500. Every CSRF refusal and every malformed-JSON refusal
  // was affected. Measured on the TT107 build as well, so this is an old defect that
  // only a production-mode gate could see.
  // The comparison must survive URL normalisation: a rewrite keeps the original request's trailing slash, so
  // "/api/notes/" was rewritten to "/api/refused/", which did not match this exemption and was refused again.
  if (req.nextUrl.pathname.replace(/\/+$/, "") === "/api/refused") return NextResponse.next();
  // TT35 CSRF guard: a state-changing call must come from the desktop itself — never from another website, nor from a
  // proxied page (opaque origin "null"), which could otherwise POST to /api/fs with a text/plain body.
  const hosts = [req.headers.get("host"), ...(req.headers.get("x-forwarded-host") ?? "").split(",")].map((h) => (h ?? "").trim()).filter(Boolean);
  const v = csrfVerdict({ method: req.method, path: req.nextUrl.pathname, origin: req.headers.get("origin"), secFetchSite: req.headers.get("sec-fetch-site"), hosts });
  if (!v.ok) return refuse(req, 403, `refused: ${v.reason}`);
  if (req.nextUrl.pathname.startsWith("/api/wp/s/")) return NextResponse.next(); // proxied bodies are forwarded, not parsed
  // This route parses and bounds its own small confirmation stream. Cloning
  // the whole request here would defeat that bound for an oversized body.
  if (req.nextUrl.pathname === "/api/privacy/thumbnail-cache") return NextResponse.next();
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("json")) return NextResponse.next();
  const text = await req.clone().text();
  if (!text.trim()) return NextResponse.next();
  try { JSON.parse(text); } catch {
    return refuse(req, 400, "malformed JSON body");
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
