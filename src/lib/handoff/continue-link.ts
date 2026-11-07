/**
 * TT146 (CT-03) — "continue on another device" as a link, not a sync protocol.
 *
 * The honest version of handoff is smaller than it sounds. There is no account,
 * no server round-trip and no presence channel: the desktop is serialised into
 * the URL fragment, and the fragment is never sent to any server — browsers do
 * not transmit `#…`, so the URL that carries the layout cannot also leak it into
 * an access log. What arrives on the other device is exactly what a person can
 * read in their own address bar.
 *
 * Which forces three decisions:
 *
 *   1. A link has a size. Window *content* (a document, an image) can be
 *      megabytes; the fragment cannot. We carry the layout and refuse the rest,
 *      naming what was left behind, rather than truncating silently.
 *   2. A link is editable. Anyone can paste a different payload into their own
 *      address bar, so decoding validates everything it is about to trust —
 *      modules against the live register, geometry against the desktop, props
 *      against a sensitive-name filter — and clamps rather than trusting.
 *   3. A link is shareable. Window props in this app include file paths,
 *      search queries and, in some modules, tokens. Anything whose key looks
 *      like a credential is dropped on the way *out*, so the link cannot carry
 *      a secret even if the window happened to hold one.
 */

import type { DesktopState, WindowState } from "../windowing/state";

/** Bump only when the payload shape changes incompatibly; older links then fail loudly. */
export const LINK_VERSION = 1;

/**
 * Practical URL ceiling. Chrome accepts far more, but links are also pasted
 * into chat apps, mail clients and terminals, and those are the components that
 * start truncating around 8 KB. A layout that needs more is a layout that needs
 * a different mechanism, and we say so instead of shipping a link that breaks.
 */
export const MAX_LINK_BYTES = 8_000;

/** Beyond this a "desktop" is a data dump, not a handoff. */
export const MAX_WINDOWS = 12;

/** Fragment key. Chosen to survive copy/paste and to be greppable in a bug report. */
export const FRAGMENT_KEY = "handoff";

export interface HandoffWindow {
  module: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  workspace: number;
  props: Record<string, unknown>;
}

export interface HandoffState {
  version: number;
  windows: HandoffWindow[];
  /** Index into `windows`, not a window id: ids are local to the sending device. */
  focus: number | null;
}

export interface EncodeResult {
  ok: boolean;
  url: string | null;
  bytes: number;
  /** What could not be carried, in words a person can act on. */
  dropped: string[];
  reason?: string;
}

export interface DecodeResult {
  ok: boolean;
  state: HandoffState | null;
  /** Modules or fields that were present but not acceptable. */
  ignored: string[];
  reason?: string;
}

/**
 * A prop key that matches this is a credential, a session, or a secret. The
 * names are matched as substrings after lowercasing, because the app's modules
 * grew their prop names independently and `apiToken`, `sessionKey` and
 * `authorization` all occur.
 */
const SECRET_KEY = /(token|secret|password|passwd|credential|authorization|cookie|sessionkey|apikey|privatekey)/i;

/** Longest prop value we will carry. A link is not a file transfer. */
export const MAX_PROP_BYTES = 512;

/** Geometry outside this is not a window on any screen. */
const COORD_LIMIT = 20_000;
const SIZE_MIN = 120;
const SIZE_MAX = 20_000;

const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** JSON-safe copy of a value, or `undefined` when it cannot be carried. */
function plain(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? undefined : value;
  }
  if (typeof value === "string") return value.length <= MAX_PROP_BYTES ? value : undefined;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) {
    const out = value.slice(0, 32).map((v) => plain(v, depth + 1));
    return out.some((v) => v === undefined) ? undefined : out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) continue;
      const p = plain(v, depth + 1);
      if (p === undefined) continue;
      out[k] = p;
    }
    return out;
  }
  return undefined; // functions, symbols, DOM nodes: not link material
}

/** Props that survive the trip: JSON-safe, small, and not credential-named. */
export function linkableProps(props: Record<string, unknown> | undefined): Record<string, unknown> {
  const p = plain(props ?? {});
  return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  // Strict: only the URL-safe alphabet, no padded or whitespace variants. A
  // hand-edited link with a stray character is rejected, not guessed at.
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Serialise a desktop into a link.
 *
 * `known` is the live module register: a window whose module is not installed on
 * the receiving device would open as an empty frame, so it is dropped here and
 * reported. Windows are ranked by z (the visible stack order), because if the
 * link cannot carry all of them the ones a person is actually looking at are the
 * ones worth carrying.
 */
export function encodeHandoff(
  state: Pick<DesktopState, "windows" | "focus" | "activeWorkspace">,
  origin: string,
  known: (module: string) => boolean,
): EncodeResult {
  const dropped: string[] = [];
  const ranked = [...state.windows].sort((a, b) => b.z - a.z);
  const kept: { win: WindowState; index: number }[] = [];
  for (const win of ranked) {
    if (kept.length >= MAX_WINDOWS) { dropped.push(`window "${win.title}" beyond the ${MAX_WINDOWS}-window limit`); continue; }
    if (!known(win.module)) { dropped.push(`"${win.title}" (module ${win.module} is not installed there)`); continue; }
    kept.push({ win, index: kept.length });
  }
  const focusIndex = kept.findIndex((k) => k.win.id === state.focus);
  const payload: HandoffState = {
    version: LINK_VERSION,
    focus: focusIndex >= 0 ? focusIndex : kept.length ? 0 : null,
    windows: kept.map(({ win }) => ({
      module: win.module,
      title: win.title.slice(0, 80),
      x: clampInt(win.x, 0, COORD_LIMIT, 0),
      y: clampInt(win.y, 0, COORD_LIMIT, 0),
      w: clampInt(win.w, SIZE_MIN, SIZE_MAX, 960),
      h: clampInt(win.h, SIZE_MIN, SIZE_MAX, 640),
      workspace: clampInt(win.workspace, 1, 99, 1),
      props: linkableProps(win.props),
    })),
  };
  const encoded = toBase64Url(JSON.stringify(payload));
  const url = `${origin.replace(/\/+$/, "")}/#${FRAGMENT_KEY}=${encoded}`;
  const bytes = new TextEncoder().encode(url).length;
  if (!payload.windows.length) {
    return { ok: false, url: null, bytes, dropped, reason: "there is nothing open to carry" };
  }
  if (bytes > MAX_LINK_BYTES) {
    return { ok: false, url: null, bytes, dropped, reason: `this layout needs ${bytes} bytes; a link is limited to ${MAX_LINK_BYTES}` };
  }
  return { ok: true, url, bytes, dropped };
}

/**
 * Parse a link back into a desktop.
 *
 * Everything in here is attacker-controlled on the receiving side — that is the
 * whole point of a link — so the decoder treats the payload as untrusted input:
 * it re-clamps geometry, re-filters props, and checks modules against the
 * register it is given. A payload that fails a structural check is refused as a
 * whole rather than partially applied.
 */
export function decodeHandoff(url: string, known: (module: string) => boolean): DecodeResult {
  let fragment: string;
  try {
    fragment = new URL(url).hash.replace(/^#/, "");
  } catch {
    return { ok: false, state: null, ignored: [], reason: "that is not a URL" };
  }
  if (!fragment) return { ok: false, state: null, ignored: [], reason: "the link has no handoff fragment" };
  const eq = fragment.indexOf("=");
  if (eq < 0 || fragment.slice(0, eq) !== FRAGMENT_KEY) {
    return { ok: false, state: null, ignored: [], reason: `the link has no ${FRAGMENT_KEY}= fragment` };
  }
  const text = fromBase64Url(fragment.slice(eq + 1));
  if (text === null) return { ok: false, state: null, ignored: [], reason: "the payload is not base64url text" };
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, state: null, ignored: [], reason: "the payload is not JSON" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, state: null, ignored: [], reason: "the payload is not an object" };
  const obj = raw as Record<string, unknown>;
  if (obj.version !== LINK_VERSION) {
    return { ok: false, state: null, ignored: [], reason: `link version ${String(obj.version)} is not supported (expected ${LINK_VERSION})` };
  }
  if (!Array.isArray(obj.windows)) return { ok: false, state: null, ignored: [], reason: "the payload has no windows array" };
  if (obj.windows.length > MAX_WINDOWS) {
    return { ok: false, state: null, ignored: [], reason: `the payload claims ${obj.windows.length} windows; the limit is ${MAX_WINDOWS}` };
  }
  const ignored: string[] = [];
  const windows: HandoffWindow[] = [];
  for (const item of obj.windows) {
    if (!item || typeof item !== "object") { ignored.push("a window entry that is not an object"); continue; }
    const w = item as Record<string, unknown>;
    const module = typeof w.module === "string" ? w.module : "";
    if (!module || !known(module)) { ignored.push(`module ${module || "(missing)"} is not installed`); continue; }
    windows.push({
      module,
      title: typeof w.title === "string" ? w.title.slice(0, 80) : module,
      x: clampInt(w.x, 0, COORD_LIMIT, 0),
      y: clampInt(w.y, 0, COORD_LIMIT, 0),
      w: clampInt(w.w, SIZE_MIN, SIZE_MAX, 960),
      h: clampInt(w.h, SIZE_MIN, SIZE_MAX, 640),
      workspace: clampInt(w.workspace, 1, 99, 1),
      props: linkableProps(w.props as Record<string, unknown> | undefined),
    });
  }
  if (!windows.length) return { ok: false, state: null, ignored, reason: "no window in the link is usable on this device" };
  const focus = typeof obj.focus === "number" && Number.isInteger(obj.focus) && obj.focus >= 0 && obj.focus < windows.length
    ? obj.focus : 0;
  return { ok: true, state: { version: LINK_VERSION, windows, focus }, ignored };
}

/** One line for the UI: how big, how many, and what the link will not carry. */
export function describeHandoff(result: EncodeResult): string {
  if (!result.ok) return result.reason ?? "no link";
  const n = result.url ? result.url.length : 0;
  const parts = [`${n} characters`, "layout only, never sent to a server"];
  if (result.dropped.length) parts.push(`${result.dropped.length} left behind`);
  return parts.join(" · ");
}

/** The URI a receiver should be sent to, without the fragment (for a QR code field, etc.). */
export function originOf(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return ""; }
}
