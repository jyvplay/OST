import { NextResponse, type NextRequest } from "next/server";
import { escapeHtmlText, extractReadable, fetchProxied, rewriteHtmlForProxy } from "@/lib/server/webproxy";

export const dynamic = "force-dynamic";

/**
 * Mechanism B1/B3 for the Browser module's "can't embed this site" case.
 * mode=raw    -> same-origin-rewritten HTML, framed in an iframe from OUR
 *                origin (bypasses the target's X-Frame-Options/CSP, since the
 *                browser only ever sees headers from US).
 * mode=reader -> Readability-style extraction, rendered as our own sanitised
 *                HTML (works even for sites whose JS the proxy can't support).
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  const mode = req.nextUrl.searchParams.get("mode") === "reader" ? "reader" : "raw";
  if (!url) return NextResponse.json({ ok: false, error: "url required" }, { status: 400 });
  try {
    const { body, contentType, finalUrl, status } = await fetchProxied(url);
    if (!contentType.includes("html")) {
      return NextResponse.json({ ok: false, error: `unsupported content-type for proxying: ${contentType}` }, { status: 415 });
    }
    if (mode === "reader") {
      const { title, html } = extractReadable(body, finalUrl);
      return new NextResponse(
        `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtmlText(title)}</title><style>body{font:16px/1.6 system-ui;max-width:680px;margin:40px auto;padding:0 20px;color:#1a1a1a;background:#fdfdfb}img{max-width:100%}a{color:#2256c7}</style></head><body><h1>${escapeHtmlText(title)}</h1>${html}</body></html>`,
        { status, headers: { "content-type": "text/html; charset=utf-8", "x-fusion-proxy-source": finalUrl, "x-fusion-proxy-mode": "reader" } },
      );
    }
    const rewritten = rewriteHtmlForProxy(body, finalUrl);
    return new NextResponse(rewritten, {
      status, headers: { "content-type": "text/html; charset=utf-8", "x-fusion-proxy-source": finalUrl, "x-fusion-proxy-mode": "raw" },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String((e as Error).message ?? e) }, { status: 502 });
  }
}
