import { randomBytes } from "node:crypto";
import { CookieJar, type UaKind } from "../wp-core";
import type { PreflightCache } from "../wp-cors";

/**
 * TT35 proxy sessions — RAM only (amnesic: nothing is written to disk or the database). A session is a capability:
 * its id is 128 random bits, and every proxied request must carry it, so another website cannot use this server as
 * an open relay through the user's browser. Each session has its own cookie jar, so two tabs (or two profiles)
 * never share site state — the isolation PR-07o asks for, by construction.
 */
export interface WpSession {
  sid: string; ua: UaKind; profile: string; jar: CookieJar; created: number; lastUsed: number;
  /** TT37: bumped by "New circuit" — changes the session's SOCKS isolation credentials (a fresh Tor circuit). */
  circuit: number;
  /** TT39 (WP-10): document id → that document's origin (issued at navigation; LRU) and the CORS-preflight cache */
  docs?: Map<string, string>;
  preflights?: PreflightCache;
  stats: { requests: number; blocked: number; bytesIn: number; errors: number; blockedHosts: Record<string, number>; failedHosts: Record<string, string> };
}
export const WP_IDLE_MS = 30 * 60_000;
export const WP_MAX_SESSIONS = 64;

type Store = Map<string, WpSession>;
// one store per server process, shared by every route bundle that imports this module
const g = globalThis as unknown as { __fusionWpSessions?: Store };
const store: Store = (g.__fusionWpSessions ??= new Map());
// TT38: whoever holds per-session resources (WebSocket bridges, keep-alive pools) is told when a session ends —
// closed, swept idle, or evicted — so nothing outlives the session it belongs to.
const gh = globalThis as unknown as { __fusionWpEndHooks?: Map<string, (sid: string) => void> };
const endHooks = (gh.__fusionWpEndHooks ??= new Map());
export function onSessionEnd(name: string, fn: (sid: string) => void): void { endHooks.set(name, fn); }
function end(sid: string): boolean {
  const had = store.delete(sid);
  if (had) for (const fn of endHooks.values()) { try { fn(sid); } catch { /* a hook must not break the store */ } }
  return had;
}

function sweep(now: number) {
  for (const [k, s] of store) if (now - s.lastUsed > WP_IDLE_MS) end(k);
  while (store.size >= WP_MAX_SESSIONS) {
    let oldest: WpSession | null = null;
    for (const s of store.values()) if (!oldest || s.lastUsed < oldest.lastUsed) oldest = s;
    if (!oldest) break;
    end(oldest.sid);
  }
}

export function createSession(ua: UaKind = "desktop", profile = "default", now = Date.now()): WpSession {
  sweep(now);
  const sid = randomBytes(16).toString("base64url");
  const s: WpSession = { sid, ua, profile: profile.slice(0, 40), jar: new CookieJar(), created: now, lastUsed: now, circuit: 0, stats: { requests: 0, blocked: 0, bytesIn: 0, errors: 0, blockedHosts: {}, failedHosts: {} } };
  store.set(sid, s);
  return s;
}
export function getSession(sid: string, now = Date.now()): WpSession | null {
  const s = store.get(sid);
  if (!s) return null;
  if (now - s.lastUsed > WP_IDLE_MS) { end(sid); return null; }
  s.lastUsed = now;
  return s;
}
export function dropSession(sid: string): boolean { return end(sid); }
export function sessionCount(): number { return store.size; }
export function publicStats(s: WpSession) {
  return { sid: s.sid, ua: s.ua, profile: s.profile, circuit: s.circuit, cookies: s.jar.size, cookieDomains: s.jar.domains(), ...s.stats, blockedHosts: s.stats.blockedHosts };
}

/** TT39 (WP-10): register a navigated document; its id rides on that document's script requests. */
export const WP_MAX_DOCS = 1024;
export function newDoc(s: WpSession, origin: string): string {
  const id = randomBytes(12).toString("base64url");
  const m = (s.docs ??= new Map());
  m.set(id, origin);
  while (m.size > WP_MAX_DOCS) m.delete(m.keys().next().value as string);
  return id;
}
/** The registered origin of a document id, or null when unknown (forged, from another session, or evicted). */
export function docOrigin(s: WpSession, id: string): string | null {
  const m = s.docs, o = m?.get(id);
  if (!m || o === undefined) return null;
  m.delete(id); m.set(id, o); // least-recently-used eviction
  return o;
}
