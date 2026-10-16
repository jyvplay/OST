import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Test-only fixture: a minimal page that refuses iframing, used by
 * scripts/e2e.mts to exercise the Browser module's embeddability probe and
 * its B1 (same-origin proxy) / B3 (reader mode) fallback mechanisms against a
 * deterministic, self-hosted target — no dependency on any external site's
 * uptime, content, or framing policy staying constant over time.
 */
export async function GET() {
  const html = `<!doctype html><html><head><title>Denied Frame Fixture</title></head>
<body><article><h1>Fusion test fixture</h1><p>This page sends X-Frame-Options: DENY on purpose, for
scripts/e2e.mts to exercise the Browser module's embeddability probe and its fallback
mechanisms (same-origin proxy, reader mode).</p><nav>should be stripped by reader mode</nav>
<script>window.top!==window.self&&(top.location="http://example.invalid/busted")</script>
</article></body></html>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8", "x-frame-options": "DENY" } });
}
