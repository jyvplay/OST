/**
 * TT139 (CT-03) — continue-on-another-device as a *link*, not a sync service.
 *
 * The desktop's window state can be carried to another device with nothing but
 * the URL: a compact, versioned, checksummed fragment. That is genuinely useful
 * (open the same document on a tablet, hand a slide deck to a phone) and it needs
 * no account, no server and no background socket.
 *
 * The design constraints that make it safe rather than clever:
 *   - the fragment (after `#`) is **not sent to the server**, so the payload never
 *     appears in a proxy log;
 *   - a payload is *data*, never code: `parse` returns a validated plain object
 *     with a whitelist of fields, and anything else is dropped with a reason;
 *   - every link carries a version and an FNV-1a checksum over the canonical JSON,
 *     so a truncated paste fails loudly instead of restoring half a desktop;
 *   - a hard 8 KiB budget keeps the link inside what chat apps do not mangle, and
 *     the encoder refuses (rather than silently truncating) when over budget;
 *   - an expiry timestamp is inside the payload; the receiving device can refuse a
 *     stale link without contacting anything.
 *
 * Limits: same-origin only in practice (the URL scheme must resolve to the app),
 * no attachments or file contents — a link names files, it does not carry them.
 */

export const HANDOFF_VERSION = 1;
export const HANDOFF_MAX_BYTES = 8192;
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

export interface HandoffWindow { module: string; title?: string; path?: string; scroll?: number; x?: number; y?: number; w?: number; h?: number }
export interface HandoffState {
  v: number;
  /** creation time, epoch ms */
  t: number;
  /** expiry, epoch ms */
  e: number;
  /** the window being continued */
  focus: string | null;
  windows: HandoffWindow[];
  theme?: string;
  /** free-text note the sender may add ("open at page 4") */
  note?: string;
}

const ALLOWED_MODULES = new Set([
  "editor", "notes", "files", "pdf", "slides", "writer", "spreadsheet", "browser", "archive",
  "clock", "calculator", "planner", "books", "photos", "settings", "messages", "recall",
]);

export function checksum(text: string): string {
  // FNV-1a 32-bit, hex. Not a security primitive: it detects a mangled paste.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function canonical(state: HandoffState): string {
  // Field order is fixed so the checksum is reproducible across browsers.
  const windows = state.windows.map((w) => [w.module, w.title ?? "", w.path ?? "", w.scroll ?? 0, w.x ?? 0, w.y ?? 0, w.w ?? 0, w.h ?? 0]);
  return JSON.stringify([state.v, state.t, state.e, state.focus, windows, state.theme ?? "", state.note ?? ""]);
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeHandoff(state: Omit<HandoffState, "v"> & { v?: number }): { link: string | null; bytes: number; error: string | null } {
  const full: HandoffState = { v: HANDOFF_VERSION, ...state } as HandoffState;
  const windows = (full.windows ?? []).slice(0, 24).map((w) => {
    const win: HandoffWindow = { module: w.module };
    if (w.title) win.title = w.title.slice(0, 120);
    if (w.path) win.path = w.path.slice(0, 400);
    if (typeof w.scroll === "number" && w.scroll >= 0) win.scroll = Math.round(w.scroll);
    for (const k of ["x", "y", "w", "h"] as const) if (typeof w[k] === "number" && Number.isFinite(w[k])) win[k] = Math.round(w[k] as number);
    return win;
  });
  const payload = canonical({ ...full, windows });
  const bytes = new TextEncoder().encode(payload).length;
  if (bytes > HANDOFF_MAX_BYTES) return { link: null, bytes, error: `the state is ${bytes} bytes; the link budget is ${HANDOFF_MAX_BYTES}` };
  const token = `${HANDOFF_VERSION}.${checksum(payload)}.${toBase64Url(new TextEncoder().encode(payload))}`;
  return { link: `#h=${token}`, bytes, error: null };
}

export function decodeHandoff(fragment: string, now: number, opts: { allowExpired?: boolean } = {}): { ok: true; state: HandoffState; warnings: string[] } | { ok: false; error: string } {
  const raw = String(fragment ?? "").replace(/^#/, "");
  if (!raw) return { ok: false, error: "the link carries no handoff payload" };
  const m = /^h=(\d+)\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)$/.exec(raw);
  if (!m) return { ok: false, error: "this is not a handoff link (expected h=version.checksum.payload)" };
  const version = Number(m[1]);
  if (version !== HANDOFF_VERSION) return { ok: false, error: `this link was made by handoff version ${version}; this build reads version ${HANDOFF_VERSION}` };
  let payload: string;
  try { payload = new TextDecoder().decode(fromBase64Url(m[3])); } catch { return { ok: false, error: "the payload is not valid base64" }; }
  if (checksum(payload) !== m[2]) return { ok: false, error: "the payload is damaged — the checksum does not match (it was probably cut short when copied)" };
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return { ok: false, error: "the payload is not JSON" }; }
  if (!Array.isArray(parsed) || parsed.length !== 7) return { ok: false, error: "the payload has an unexpected shape" };
  const [v, t, e, focus, windows, theme, note] = parsed as [number, number, number, string | null, unknown[], string, string];
  if (v !== HANDOFF_VERSION) return { ok: false, error: "the payload's own version field disagrees with its header" };
  const warnings: string[] = [];
  if (typeof e === "number" && now > e && !opts.allowExpired) return { ok: false, error: "this handoff link has expired — the state it names is no longer current" };
  if (typeof t === "number" && t > now + 120_000) warnings.push("the sender's clock is ahead by more than two minutes; times may be wrong");
  const good: HandoffWindow[] = [];
  for (const row of Array.isArray(windows) ? windows : []) {
    if (!Array.isArray(row)) { warnings.push("a window entry was not a row and was dropped"); continue; }
    const [module, title, path, scroll, x, y, w, h] = row as [unknown, unknown, unknown, unknown, unknown, unknown, unknown, unknown];
    if (typeof module !== "string" || !ALLOWED_MODULES.has(module)) { warnings.push(`“${String(module)}” is not a module this build can open`); continue; }
    const win: HandoffWindow = { module };
    if (typeof title === "string" && title) win.title = title.slice(0, 120);
    if (typeof path === "string" && path.startsWith("/")) win.path = path.slice(0, 400);
    if (typeof scroll === "number" && scroll >= 0) win.scroll = Math.round(scroll);
    if ([x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n))) Object.assign(win, { x: Math.round(x as number), y: Math.round(y as number), w: Math.round(w as number), h: Math.round(h as number) });
    good.push(win);
  }
  if (!good.length) return { ok: false, error: "the link named no window this build can open" };
  const state: HandoffState = {
    v: HANDOFF_VERSION,
    t: typeof t === "number" ? t : now,
    e: typeof e === "number" ? e : now + HANDOFF_TTL_MS,
    focus: typeof focus === "string" && ALLOWED_MODULES.has(focus) ? focus : (good[0]?.module ?? null),
    windows: good,
    ...(typeof theme === "string" && theme ? { theme: theme.slice(0, 40) } : {}),
    ...(typeof note === "string" && note ? { note: note.slice(0, 280) } : {}),
  };
  return { ok: true, state, warnings };
}

/** A one-line description for the receive dialog, before anything is opened. */
export function describeHandoff(state: HandoffState): string {
  const n = state.windows.length;
  const first = state.windows[0];
  const names = state.windows.slice(0, 3).map((w) => w.title || w.module).join(", ");
  return `${n} window${n === 1 ? "" : "s"}${first ? ` — ${names}${n > 3 ? ", …" : ""}` : ""}${state.note ? ` · “${state.note}”` : ""}`;
}

/** What a handoff link knowingly cannot carry. */
export const HANDOFF_LIMITS: readonly string[] = [
  "File contents do not travel: a link names a path on the sending device.",
  "Nothing is synchronised afterwards; this is a copy, not a session.",
  "Unsaved editor buffers are included only if the sender was asked to include them.",
  "The link is readable by anyone who has it — it is not encrypted.",
];
