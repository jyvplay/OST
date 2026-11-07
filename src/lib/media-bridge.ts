/**
 * TT139 (MS-01 / MS-04) — chat connectors that are a seam, not a fake.
 *
 * Two protocols a user can point at their own infrastructure:
 *   - `MS-01` BlueBubbles-shaped bridge REST: `GET /api/v1/ping` then
 *     `GET /api/v1/chat?offset=0&limit=n`, `POST /api/v1/message/text`. The user
 *     runs it; Fusion never handles an Apple ID.
 *   - `MS-04` Matrix client-server: `GET /_matrix/client/v3/versions`,
 *     `POST /_matrix/client/v3/login` is *not* implemented (no password ever
 *     leaves the page), so the seam accepts an access token the user already
 *     has, and `GET /_matrix/client/v3/rooms/{id}/messages` is paginated with
 *     the required `dir` and `from` tokens.
 *
 * Everything here is pure: URL construction, response validation, pagination
 * bookkeeping, and the redaction rules that keep tokens out of logs and out of
 * error messages. The point of the file is that a *wrong* response is a typed
 * failure rather than an empty screen. Limits: no TLS pinning, no push, and the
 * Matrix path never refreshes tokens — an expired token is reported as such.
 */

export interface BridgeRequest { method: "GET" | "POST" | "PUT"; url: string; headers: Record<string, string>; body?: string; /** what the UI says it is doing */ purpose: string }

const MAX_MESSAGES = 200;

function trimBase(base: string): string | null {
  const raw = String(base ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin + u.pathname.replace(/\/+$/, "");
  } catch { return null; }
}

/** A localhost bridge is normal for BlueBubbles; anything else must be https. */
export function bridgeAllowed(base: string): { ok: boolean; reason: string } {
  const b = trimBase(base);
  if (!b) return { ok: false, reason: "the address is not a URL" };
  const u = new URL(b);
  if (u.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)) {
    return { ok: false, reason: "a bridge on another machine must use https — a token over plain http is readable by anyone on the network" };
  }
  return { ok: true, reason: "ok" };
}

export function bridgeRequests(base: string, password: string, opts: { chatGuid?: string; text?: string; limit?: number } = {}): BridgeRequest[] {
  const b = trimBase(base);
  if (!b) throw new Error("bridge: invalid base URL");
  const limit = Math.min(Math.max(1, opts.limit ?? 30), MAX_MESSAGES);
  const headers = { "Content-Type": "application/json", ...(password ? { Authorization: `Bearer ${password}` } : {}) };
  const out: BridgeRequest[] = [
    { method: "GET", url: `${b}/api/v1/ping`, headers, purpose: "check the bridge is reachable" },
    { method: "GET", url: `${b}/api/v1/chat?offset=0&limit=${limit}`, headers, purpose: "list recent chats" },
  ];
  if (opts.chatGuid) out.push({ method: "GET", url: `${b}/api/v1/chat/${encodeURIComponent(opts.chatGuid)}/message?offset=0&limit=${limit}`, headers, purpose: "read one conversation" });
  if (opts.chatGuid && opts.text) out.push({ method: "POST", url: `${b}/api/v1/message/text`, headers, body: JSON.stringify({ chatGuid: opts.chatGuid, tempGuid: `fusion-${Date.now()}`, message: opts.text }), purpose: "send one message" });
  return out;
}

export interface BridgeMessage { id: string; from: string; text: string; at: number | null; mine: boolean }

/** BlueBubbles returns `{status, message, data:[...]}`; anything else is a shape error. */
export function parseBridgeChats(payload: unknown): { ok: true; chats: { guid: string; title: string; lastAt: number | null }[] } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "the bridge returned no JSON body" };
  const p = payload as { status?: number; message?: string; data?: unknown };
  if (p.status !== undefined && p.status >= 400) return { ok: false, error: `the bridge refused the request (${p.status}${p.message ? `: ${p.message}` : ""})` };
  if (!Array.isArray(p.data)) return { ok: false, error: "the bridge response has no data array — is this a BlueBubbles-compatible bridge?" };
  const chats = p.data.slice(0, MAX_MESSAGES).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const guid = typeof r.guid === "string" ? r.guid : null;
    if (!guid) return [];
    const title = typeof r.displayName === "string" && r.displayName ? r.displayName : guid;
    const last = typeof r.lastMessageDate === "number" ? r.lastMessageDate : null;
    return [{ guid, title, lastAt: last }];
  });
  return { ok: true, chats };
}

export function parseBridgeMessages(payload: unknown, selfHandle = ""): { ok: true; messages: BridgeMessage[] } | { ok: false; error: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "the bridge returned no JSON body" };
  const p = payload as { data?: unknown; status?: number };
  if (p.status !== undefined && p.status >= 400) return { ok: false, error: `the bridge refused the request (${p.status})` };
  const rows = Array.isArray(p.data) ? p.data : Array.isArray(payload) ? (payload as unknown[]) : null;
  if (!rows) return { ok: false, error: "no message array in the bridge response" };
  const messages = rows.slice(0, MAX_MESSAGES).flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const r = row as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text : typeof r.subject === "string" ? r.subject : "";
    if (!text) return [];
    const handle = (r.handle as { address?: string } | undefined)?.address ?? "";
    const isFromMe = r.isFromMe === true || (selfHandle !== "" && handle === selfHandle);
    return [{ id: typeof r.guid === "string" ? r.guid : `${r.dateCreated ?? ""}-${text.slice(0, 12)}`, from: handle || (isFromMe ? "me" : "unknown"), text, at: typeof r.dateCreated === "number" ? r.dateCreated : null, mine: isFromMe }];
  });
  return { ok: true, messages };
}

// ── Matrix ──────────────────────────────────────────────────────────────────
export interface MatrixSession { homeserver: string; accessToken: string; userId: string }

export function matrixAllowed(session: { homeserver: string; accessToken: string }): { ok: boolean; reason: string } {
  const b = trimBase(session.homeserver);
  if (!b) return { ok: false, reason: "the homeserver is not a URL" };
  if (new URL(b).protocol !== "https:") return { ok: false, reason: "a Matrix homeserver must be https — the access token travels in a header" };
  if (!session.accessToken || session.accessToken.length < 20) return { ok: false, reason: "an access token is required (log in with your own client and paste the token)" };
  return { ok: true, reason: "ok" };
}

export function matrixRequests(session: MatrixSession, opts: { roomId?: string; from?: string; text?: string; limit?: number } = {}): BridgeRequest[] {
  const check = matrixAllowed(session);
  if (!check.ok) throw new Error(`matrix: ${check.reason}`);
  const base = trimBase(session.homeserver)!;
  const limit = Math.min(Math.max(1, opts.limit ?? 30), 100);
  const headers = { Authorization: `Bearer ${session.accessToken}`, "Content-Type": "application/json" };
  const out: BridgeRequest[] = [
    { method: "GET", url: `${base}/_matrix/client/v3/versions`, headers, purpose: "confirm the homeserver speaks the client-server API" },
    { method: "GET", url: `${base}/_matrix/client/v3/joined_rooms`, headers, purpose: "list the rooms this token can see" },
  ];
  if (opts.roomId) {
    const from = opts.from ? `&from=${encodeURIComponent(opts.from)}` : "";
    out.push({ method: "GET", url: `${base}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/messages?dir=b&limit=${limit}${from}`, headers, purpose: "read a room backwards" });
  }
  if (opts.roomId && opts.text) {
    const txn = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    out.push({ method: "PUT", url: `${base}/_matrix/client/v3/rooms/${encodeURIComponent(opts.roomId)}/send/m.room.message/${txn}`, headers, body: JSON.stringify({ msgtype: "m.text", body: opts.text }), purpose: "send one message" });
  }
  return out;
}

export function parseMatrixVersions(payload: unknown): { ok: boolean; versions: string[]; error: string | null } {
  const p = payload as { versions?: unknown } | null;
  if (!p || !Array.isArray(p.versions)) return { ok: false, versions: [], error: "this endpoint is not a Matrix homeserver (no versions array)" };
  const versions = p.versions.filter((v): v is string => typeof v === "string");
  const usable = versions.some((v) => /^v1\.\d+$/.test(v));
  return { ok: usable, versions, error: usable ? null : "the homeserver does not advertise a v1.x client-server API" };
}

export interface MatrixPage { messages: { eventId: string; sender: string; text: string; at: number | null }[]; end: string | null }

export function parseMatrixMessages(payload: unknown): { ok: true; page: MatrixPage } | { ok: false; error: string } {
  const p = payload as { chunk?: unknown; end?: unknown; errcode?: unknown; error?: unknown } | null;
  if (!p || typeof p !== "object") return { ok: false, error: "empty response" };
  if (p.errcode) return { ok: false, error: `the homeserver refused the request: ${String(p.errcode)}${p.error ? ` — ${String(p.error)}` : ""}` };
  if (!Array.isArray(p.chunk)) return { ok: false, error: "the response has no chunk array" };
  const messages = p.chunk.flatMap((ev) => {
    if (!ev || typeof ev !== "object") return [];
    const e = ev as Record<string, unknown>;
    if (e.type !== "m.room.message") return [];
    const content = e.content as { body?: unknown; msgtype?: unknown } | undefined;
    const text = typeof content?.body === "string" ? content.body : "";
    if (!text) return [];
    return [{ eventId: typeof e.event_id === "string" ? e.event_id : "", sender: typeof e.sender === "string" ? e.sender : "unknown", text, at: typeof e.origin_server_ts === "number" ? e.origin_server_ts : null }];
  });
  return { ok: true, page: { messages, end: typeof p.end === "string" ? p.end : null } };
}

/** Redaction used on every error path: a token must never reach a log or a toast. */
export function redact(value: string, secrets: readonly string[]): string {
  let out = String(value ?? "");
  for (const secret of secrets) {
    if (!secret || secret.length < 6) continue;
    out = out.split(secret).join("[redacted]");
  }
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{6,}/gi, "$1[redacted]");
  out = out.replace(/(access_token=)[A-Za-z0-9._~+/=-]{6,}/gi, "$1[redacted]");
  return out;
}
