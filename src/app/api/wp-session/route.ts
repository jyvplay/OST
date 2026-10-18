import { NextResponse, type NextRequest } from "next/server";
import { WP_PREFIX } from "@/lib/wp-core";
import { readJsonObject } from "@/lib/http-json";
import { createSession, dropSession, getSession, publicStats } from "@/lib/server/wp-sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * TT35 proxy sessions (RAM only). POST {ua?, profile?} → a new session; GET ?sid → its live counters (requests,
 * trackers blocked, cookies held); PATCH ?sid {clearCookies?, ua?}; DELETE ?sid ends it and forgets its cookies.
 * State-changing calls are same-origin only (the CSRF guard in src/proxy.ts), so a proxied page cannot mint or
 * end sessions.
 */
const ok = (j: unknown, status = 200) => NextResponse.json(j, { status, headers: { "cache-control": "no-store" } });

export async function POST(req: NextRequest) {
  const b = (await readJsonObject(req)) as { ua?: string; profile?: string } | Response;
  if (b instanceof Response) return b;
  const s = createSession(b.ua === "mobile" ? "mobile" : "desktop", typeof b.profile === "string" && b.profile ? b.profile : "default");
  return ok({ sid: s.sid, prefix: `${WP_PREFIX}${s.sid}/`, ua: s.ua, profile: s.profile });
}
export function GET(req: NextRequest) {
  const s = getSession(req.nextUrl.searchParams.get("sid") ?? "");
  return s ? ok(publicStats(s)) : ok({ error: "no such session" }, 404);
}
export async function PATCH(req: NextRequest) {
  const b = (await readJsonObject(req)) as { clearCookies?: boolean; ua?: string } | Response;
  if (b instanceof Response) return b; // a bad body is a 400 whatever the session
  const s = getSession(req.nextUrl.searchParams.get("sid") ?? "");
  if (!s) return ok({ error: "no such session" }, 404);
  if (b.clearCookies) s.jar.clear();
  if (b.ua === "mobile" || b.ua === "desktop") s.ua = b.ua;
  return ok(publicStats(s));
}
export function DELETE(req: NextRequest) {
  return ok({ dropped: dropSession(req.nextUrl.searchParams.get("sid") ?? "") });
}
