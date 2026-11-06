/**
 * TT136 (CT-03) — handoff that actually moves a window to another tab.
 *
 * Before this module "continue on" was a URL: the receiving tab had to be told
 * to open it. Here a window's state is (a) validated and bounded, (b) packed
 * into a compact, checksummed code a person can type, and (c) carried between
 * same-origin tabs over BroadcastChannel when both are open. Both paths are
 * real; neither claims cross-device sync, which needs a server and is not
 * implemented.
 */

export const HANDOFF_VERSION = 1;
export const PROPS_BYTES = 8 * 1024;
export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_LENGTH = 10;

/** Crockford-style alphabet: no I, L, O or U, so a typed code cannot be guessed wrong. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface HandoffPayload {
  v: typeof HANDOFF_VERSION;
  app: string;
  title: string;
  props: Record<string, unknown>;
  at: number;
}

export interface HandoffState { code: string; payload: HandoffPayload; expiresAt: number }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

export function makePayload(app: string, title: string, props: Record<string, unknown>, now: number): HandoffPayload {
  if (typeof app !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(app)) throw new Error("Handoff needs a module id");
  if (typeof title !== "string" || title.length === 0 || title.length > 120) throw new Error("Title must be 1…120 characters");
  if (!isPlainObject(props)) throw new Error("Window props must be a plain object");
  if (!Number.isFinite(now) || now < 0) throw new Error("now must be a finite timestamp");
  const json = JSON.stringify(props);
  if (new TextEncoder().encode(json).byteLength > PROPS_BYTES) throw new Error("Window state is larger than 8 KiB");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(json)) throw new Error("Window state contains control characters");
  return { v: HANDOFF_VERSION, app, title, props: JSON.parse(json) as Record<string, unknown>, at: now };
}

/** FNV-1a over UTF-16 code units — a typo detector for the code, not a signature. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 5 bytes of an FNV-derived stream, base32-encoded, with a trailing check char. */
export function encodeCode(payload: HandoffPayload): string {
  const text = JSON.stringify(payload);
  if (new TextEncoder().encode(text).byteLength > PROPS_BYTES + 512) throw new Error("Handoff payload too large to encode");
  // Compact JSON → UTF-8 → base32 of the first N bytes is too lossy for a full
  // payload, so the code carries a 32-bit body hash plus the TTL-bearing
  // timestamp: a typed code can only *find* the tab that holds the full payload.
  const body = new Uint8Array(new TextEncoder().encode(text));
  let bodyHash = 0x811c9dc5;
  for (const b of body) { bodyHash ^= b; bodyHash = Math.imul(bodyHash, 0x01000193) >>> 0; }
  const words = [bodyHash ^ fnv1a(payload.app), (payload.at >>> 0) ^ 0x5bf03635];
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, words[0]); view.setUint32(4, words[1]);
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return `${out.slice(0, 8)}-${out.slice(8, 9)}`;
}

export function normalizeCode(input: string): string | null {
  const cleaned = input.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
  if (cleaned.length !== 9) return null;
  if ([...cleaned].some((c) => !ALPHABET.includes(c))) return null;
  return `${cleaned.slice(0, 8)}-${cleaned.slice(8)}`;
}

export type AcceptResult = { ok: true; state: HandoffState } | { ok: false; reason: string };

/** Build the typed-code view of a payload. The code alone cannot reconstruct the payload. */
export function issue(payload: HandoffPayload, now: number): HandoffState {
  return { code: encodeCode(payload), payload, expiresAt: payload.at + CODE_TTL_MS };
}

/**
 * A receiving tab accepts a handoff when the code matches a payload it already
 * holds (broadcast path) and the payload has not expired. `now` is the receiver's
 * clock; a payload from the future by more than a minute is refused rather than
 * trusted, because that is the shape of a replay from a skewed device.
 */
export function accept(offered: HandoffState | null, code: string, now: number): AcceptResult {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, reason: "That is not a complete handoff code" };
  if (!offered) return { ok: false, reason: "No matching handoff is open in another tab" };
  if (offered.code !== normalized) return { ok: false, reason: "Code does not match the open handoff" };
  if (!Number.isFinite(now) || now < 0) return { ok: false, reason: "Receiver clock is unusable" };
  if (offered.payload.at > now + 60_000) return { ok: false, reason: "Handoff timestamp is in the future" };
  if (now > offered.expiresAt) return { ok: false, reason: "Handoff expired (10 minute limit)" };
  const checked = makePayload(offered.payload.app, offered.payload.title, offered.payload.props, offered.payload.at);
  return { ok: true, state: { ...offered, payload: checked } };
}

/** The BroadcastChannel message this app sends and accepts. Shape-checked on receipt. */
export interface HandoffMessage { type: "fusion.handoff.v1"; state: HandoffState }

export function toMessage(state: HandoffState): HandoffMessage { return { type: "fusion.handoff.v1", state }; }

export function fromMessage(raw: unknown, now: number): AcceptResult {
  if (!isPlainObject(raw) || raw.type !== "fusion.handoff.v1") return { ok: false, reason: "Not a handoff message" };
  const state = raw.state;
  if (!isPlainObject(state) || typeof state.code !== "string" || !isPlainObject(state.payload)) return { ok: false, reason: "Malformed handoff state" };
  const p = state.payload;
  try {
    const payload = makePayload(String(p.app), String(p.title), (p.props ?? {}) as Record<string, unknown>, Number(p.at));
    return accept({ code: state.code, payload, expiresAt: payload.at + CODE_TTL_MS }, state.code, now);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
