import { NextResponse, type NextRequest } from "next/server";
import { WP_PREFIX } from "@/lib/wp-core";
import { readJsonObject } from "@/lib/http-json";
import { clearUaOverride, createSession, dropSession, getSession, normalizeUaSite, publicStats, setUaOverride } from "@/lib/server/wp-sessions";
import { dropPools } from "@/lib/server/wp-connect";
import { closeSessionSockets } from "@/lib/server/wp-ws";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * TT35 proxy sessions (RAM only). POST {ua?, profile?} → a new session; GET ?sid[&site=host] → live counters and,
 * when a site is named, that site's effective identity; PATCH ?sid {clearCookies?, ua?, site?, clearSiteUa?}; DELETE
 * ?sid ends it and forgets its cookies and identity overrides. State-changing calls are same-origin only (the CSRF
 * guard in src/proxy.ts), so a proxied page cannot mint or end sessions.
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
  if (!s) return ok({ error: "no such session" }, 404);
  const site = req.nextUrl.searchParams.get("site");
  if (site === null) return ok(publicStats(s));
  const key = normalizeUaSite(site);
  return key ? ok(publicStats(s, key)) : ok({ error: "invalid site host" }, 400);
}
export async function PATCH(req: NextRequest) {
  const b = (await readJsonObject(req)) as { clearCookies?: boolean; ua?: string; newCircuit?: boolean; site?: unknown; clearSiteUa?: boolean } | Response;
  if (b instanceof Response) return b; // a bad body is a 400 whatever the session
  const s = getSession(req.nextUrl.searchParams.get("sid") ?? "");
  if (!s) return ok({ error: "no such session" }, 404);
  const sitePatch = Object.prototype.hasOwnProperty.call(b, "site") || b.clearSiteUa === true;
  const site = sitePatch ? normalizeUaSite(b.site) : null;
  if (sitePatch && !site) return ok({ error: "invalid site host" }, 400);
  if (sitePatch && b.clearSiteUa !== true && b.ua !== "desktop" && b.ua !== "mobile") return ok({ error: "identity must be desktop or mobile" }, 400);
  if (!sitePatch && b.ua !== undefined && b.ua !== "desktop" && b.ua !== "mobile") return ok({ error: "identity must be desktop or mobile" }, 400);
  if (sitePatch && b.clearSiteUa === true && b.ua !== undefined) return ok({ error: "cannot set and clear a site identity together" }, 400);
  if (b.clearCookies) s.jar.clear();
  if (b.newCircuit === true) {
    s.circuit++; // TT37: new SOCKS isolation credentials → Tor builds a fresh circuit
    // TT38: and nothing keeps riding the old one — pooled connections closed, open WebSockets closed (1001)
    dropPools(s.sid); closeSessionSockets(s.sid);
  }
  if (sitePatch && site) {
    if (b.clearSiteUa === true) clearUaOverride(s, site);
    else setUaOverride(s, site, b.ua);
    return ok(publicStats(s, site));
  }
  if (b.ua === "mobile" || b.ua === "desktop") s.ua = b.ua;
  return ok(publicStats(s));
}
export function DELETE(req: NextRequest) {
  return ok({ dropped: dropSession(req.nextUrl.searchParams.get("sid") ?? "") });
}
