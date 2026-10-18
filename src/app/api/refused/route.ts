import { NextResponse, type NextRequest } from "next/server";

/**
 * Where src/proxy.ts sends requests it refuses (CSRF guard 403, malformed JSON 400) — see the note there for why the
 * proxy must not answer them itself. Only those two statuses can be produced; the message is returned as JSON text.
 * Reaching it directly only ever yields an error response.
 */
export const dynamic = "force-dynamic";

function answer(req: NextRequest) {
  const status = req.headers.get("x-fusion-refused-status") === "400" ? 400 : 403;
  let error = "refused";
  try { error = decodeURIComponent(req.headers.get("x-fusion-refused-error") ?? "refused").slice(0, 300); } catch { /* keep "refused" */ }
  return NextResponse.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

export const GET = answer;
export const POST = answer;
export const PUT = answer;
export const PATCH = answer;
export const DELETE = answer;
