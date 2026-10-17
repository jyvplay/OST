import { NextResponse, type NextRequest } from "next/server";

/**
 * TT23 repair: a malformed JSON body used to crash ~25 API route handlers (`await req.json()` threw, giving an
 * unhandled 500 and a stack in the server log). One edge check instead of 25 edits: a non-empty body that claims
 * to be JSON but does not parse gets a 400 with a plain message before the route runs.
 *
 * Empty bodies pass through unchanged; routes keep their own field validation. Only /api is matched.
 */
export async function proxy(req: NextRequest) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return NextResponse.next();
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("json")) return NextResponse.next();
  const text = await req.clone().text();
  if (!text.trim()) return NextResponse.next();
  try { JSON.parse(text); } catch {
    return NextResponse.json({ error: "malformed JSON body" }, { status: 400 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
