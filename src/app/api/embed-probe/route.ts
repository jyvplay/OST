import { NextResponse, type NextRequest } from "next/server";
import { getPinnedPublic } from "@/lib/server/pinned-http";

export const dynamic = "force-dynamic";

/**
 * WM-06 / PR-07: measure embeddability BEFORE offering a window.
 * This is the web's replacement for Android's freeform broker probe: the server
 * reads X-Frame-Options and CSP frame-ancestors so the shell can pick
 * S1 iframe-window / S2 split / S3 handoff-tab / S4 picture-in-picture.
 */
export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get("url");
  if (!target) return NextResponse.json({ ok: false, error: "url required" }, { status: 400 });
  let url: URL;
  try {
    // "ftp://x.test/" must not be coerced into "https://ftp//x.test/": only a
    // bare host (no scheme at all) may be defaulted to https.
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid url" }, { status: 400 });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return NextResponse.json({ ok: false, error: "only http(s) can be probed" }, { status: 400 });
  }

  const started = Date.now();
  try {
    const res = await getPinnedPublic(url.toString(), { maxBytes: 1024 * 1024, timeoutMs: 7000, maxRedirects: 5 });
    const xfo = String(res.headers["x-frame-options"] ?? "").toLowerCase();
    const csp = String(res.headers["content-security-policy"] ?? "");
    // Multiple CSP policies are comma-separated and all apply. Within each
    // policy only its first exact frame-ancestors directive is effective.
    // This is a conservative advisory, not a full browser CSP evaluator.
    const ancestorPolicies = csp.split(",").flatMap(policy => {
      for (const directive of policy.split(";")) {
        const match = /^\s*frame-ancestors(?:\s+([\s\S]*))?\s*$/i.exec(directive);
        if (match) return [(match[1] ?? "").trim()];
      }
      return [];
    });
    const frameAncestors = ancestorPolicies.map(v => v || "(empty)").join("; ");
    const cspRestricted = ancestorPolicies.some(v => v !== "*");
    let verdict: "embeddable" | "deny" | "sameorigin" | "csp-restricted" | "unknown" = "embeddable";
    let reason = "No framing restriction headers were sent.";
    if (xfo.includes("deny")) { verdict = "deny"; reason = "X-Frame-Options: DENY"; }
    else if (xfo.includes("sameorigin")) { verdict = "sameorigin"; reason = "X-Frame-Options: SAMEORIGIN"; }
    else if (cspRestricted) { verdict = "csp-restricted"; reason = `CSP frame-ancestors ${frameAncestors}`; }
    const host = verdict === "embeddable" ? "S1-window" : "S3-handoff";
    return NextResponse.json({
      ok: true, url: res.finalUrl, status: res.status, verdict, reason, host,
      headers: { "x-frame-options": xfo || null, "frame-ancestors": frameAncestors || null },
      tookMs: Date.now() - started,
    });
  } catch (err) {
    return NextResponse.json({
      ok: true, url: url.toString(), status: 0, verdict: "unknown",
      reason: `probe failed: ${String((err as Error).message ?? err)}`,
      host: "S3-handoff", tookMs: Date.now() - started,
    });
  }
}
