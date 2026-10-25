/**
 * TT76 (CA-02) — the link between a Slides presenter console and an audience screen. Original code.
 *
 * The audience screen is the app's own receiver route (/present?show=<sid>) in a second window — dragged or placed
 * on a projector / TV / second display — or a Presentation API receiver. It holds its OWN copy of the deck (the
 * presenter sends the .pptx bytes once) and renders the show locally from small state messages, so a step costs a
 * few bytes rather than a video frame, and the audience never sees the presenter's notes or console.
 *
 * Messages are validated strictly on receipt (a page from another session on the same channel name, a stale
 * window or a hostile frame cannot inject anything but a well-formed state for a deck it already has).
 *   receiver → presenter: hello {rid}, ready {rid, slides}, nav {dir}
 *   presenter → receiver: deck {name, bytes, slides}, state {s}, end
 * Transports: BroadcastChannel (same browser profile; tested), PresentationConnection (JSON text frames with the deck
 * base64-encoded; follows the W3C Presentation API but NOT exercised here — no receiver device in the sandbox).
 */
export interface ShowState { i: number; done: number; animate: boolean; key: number; from: number | null }
export type ShowMsg =
  | { t: "hello"; rid: string } | { t: "ready"; rid: string; slides: number } | { t: "nav"; dir: "next" | "prev" }
  | { t: "deck"; name: string; bytes: Uint8Array; slides: number } | { t: "state"; s: ShowState } | { t: "end" };
export const SHOW_MAX_BYTES = 64 * 1024 * 1024;
const MAX_SLIDES = 2000;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const nat = (v: unknown, hi: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= hi;
const idOk = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{16}$/.test(v);
export const sidOk = idOk;
export function newSid(): string { const b = new Uint8Array(8); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, "0")).join(""); }

/** A message from the wire, or null if it is not exactly one of ShowMsg (unknown keys are ignored, never trusted). */
export function parseShowMsg(raw: unknown): ShowMsg | null {
  if (!isObj(raw) || typeof raw.t !== "string") return null;
  switch (raw.t) {
    case "hello": return idOk(raw.rid) ? { t: "hello", rid: raw.rid } : null;
    case "ready": return idOk(raw.rid) && nat(raw.slides, MAX_SLIDES) ? { t: "ready", rid: raw.rid, slides: raw.slides } : null;
    case "nav": return raw.dir === "next" || raw.dir === "prev" ? { t: "nav", dir: raw.dir } : null;
    case "end": return { t: "end" };
    case "deck": {
      if (typeof raw.name !== "string" || raw.name.length > 260 || !nat(raw.slides, MAX_SLIDES)) return null;
      const b = raw.bytes; if (!(b instanceof Uint8Array) || b.length < 22 || b.length > SHOW_MAX_BYTES) return null;
      if (b[0] !== 0x50 || b[1] !== 0x4b) return null; // a .pptx is a ZIP package
      return { t: "deck", name: raw.name, bytes: b, slides: raw.slides };
    }
    case "state": {
      const s = raw.s; if (!isObj(s)) return null;
      if (!nat(s.i, MAX_SLIDES - 1) || !nat(s.done, 100_000) || typeof s.animate !== "boolean" || !nat(s.key, Number.MAX_SAFE_INTEGER) || !(s.from === null || nat(s.from, MAX_SLIDES - 1))) return null;
      return { t: "state", s: { i: s.i, done: s.done, animate: s.animate, key: s.key, from: s.from } };
    }
  }
  return null;
}

export interface ShowPort { send(m: ShowMsg): void; close(): void; onmsg: ((m: ShowMsg) => void) | null }
/** Same-profile transport: a BroadcastChannel named for the session id. */
export function channelPort(sid: string): ShowPort {
  if (!sidOk(sid)) throw new Error("bad show session id");
  const ch = new BroadcastChannel(`fusion-show-${sid}`);
  const port: ShowPort = { onmsg: null, send: (m) => ch.postMessage(m), close: () => ch.close() };
  ch.onmessage = (e: MessageEvent) => { const m = parseShowMsg(e.data); if (m) port.onmsg?.(m); };
  return port;
}
const b64 = (u: Uint8Array) => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** Encode / decode for text transports (PresentationConnection): the deck travels base64-encoded. */
export function encodeText(m: ShowMsg): string { return JSON.stringify(m.t === "deck" ? { ...m, bytes: b64(m.bytes) } : m); }
export function decodeText(s: string): ShowMsg | null {
  if (typeof s !== "string" || s.length > SHOW_MAX_BYTES * 1.4) return null;
  let v: unknown; try { v = JSON.parse(s); } catch { return null; }
  if (isObj(v) && v.t === "deck" && typeof v.bytes === "string") { try { v = { ...v, bytes: unb64(v.bytes) }; } catch { return null; } }
  return parseShowMsg(v);
}
interface TextConn { send(s: string): void; close?(): void; addEventListener(t: "message", f: (e: { data: unknown }) => void): void }
/** Presentation API transport (W3C PresentationConnection) — same protocol as text frames. Not exercised in the sandbox. */
export function connectionPort(conn: TextConn): ShowPort {
  const port: ShowPort = { onmsg: null, send: (m) => conn.send(encodeText(m)), close: () => conn.close?.() };
  conn.addEventListener("message", (e) => { const m = typeof e.data === "string" ? decodeText(e.data) : null; if (m) port.onmsg?.(m); });
  return port;
}
