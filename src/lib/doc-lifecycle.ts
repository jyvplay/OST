/**
 * TT69 FF-15 document lifecycle for Writer, Spreadsheet and Editor: open → dirty → save → recover → close-confirm.
 *
 * Pure logic (no React, no fetch) so the Node suites test exactly what the UI runs:
 *  - a registry of open documents (one guard per window) that the shell consults before ANY close;
 *  - planClose: which windows close at once and which must be asked about, in order;
 *  - draftPathFor: where a recovery draft lives — under /Private when the document is private, so the privacy layer
 *    encrypts the draft and its name (a /System/Recovery draft of a /Private file would be plaintext on the host);
 *  - a strict draft codec (anything malformed is "no draft", never a crash or a half-restored document);
 *  - DraftWriter: debounced, one write in flight, newest content wins, and clear() waits for an in-flight write
 *    before deleting, so a late write can never resurrect a draft after Save.
 */
import { PRIVATE_ROOT, isPrivatePath } from "./privacy/pcrypt";

export type DocKind = "writer" | "sheet" | "editor";
export const DOC_KINDS: readonly DocKind[] = ["writer", "sheet", "editor"];

export interface DocGuard {
  winId: string;
  kind: DocKind;
  title(): string;
  dirty(): boolean;
  /** true when the document is now saved; false when it is not (Save As still open, refused, failed) */
  save(): Promise<boolean>;
  /** write the newest draft now (before a "Don't save" close), so the last edits are recoverable */
  flushDraft(): Promise<void>;
  /** false when this document keeps no draft (password-protected: a draft would be plaintext) */
  recoverable?(): boolean;
  /** the random id of an untitled document's draft, so another window never offers it while it is open */
  draftKey?(): string;
}

const guards = new Map<string, DocGuard>();

export function registerDocGuard(g: DocGuard): () => void {
  guards.set(g.winId, g);
  return () => { if (guards.get(g.winId) === g) guards.delete(g.winId); };
}
export function guardFor(winId: string): DocGuard | undefined { return guards.get(winId); }
export function isDocDirty(winId: string): boolean {
  const g = guards.get(winId);
  if (!g) return false;
  try { return g.dirty(); } catch { return true; }
}
export function anyDirtyDoc(): boolean { for (const id of guards.keys()) if (isDocDirty(id)) return true; return false; }
/** untitled ids of documents open in this tab (a new window must not offer another live window's draft) */
export function liveDraftKeys(): Set<string> {
  const s = new Set<string>();
  for (const g of guards.values()) { const k = g.draftKey?.(); if (k) s.add(k); }
  return s;
}

export type CloseCmd = { t: "close"; id: string; force?: boolean } | { t: "closeAll"; force?: boolean };
export interface ClosePlan { closeNow: string[]; ask: string[] }

/**
 * Close semantics: a forced command closes everything it names. Otherwise clean windows close immediately and dirty
 * ones are queued for the Save-changes dialog in window order; ids unknown to the window list are ignored.
 */
export function planClose(cmd: CloseCmd, windowIds: readonly string[], dirty: (id: string) => boolean): ClosePlan {
  const named = cmd.t === "close" ? (windowIds.includes(cmd.id) ? [cmd.id] : []) : [...windowIds];
  if (cmd.force) return { closeNow: named, ask: [] };
  const closeNow: string[] = []; const ask: string[] = [];
  for (const id of named) (dirty(id) ? ask : closeNow).push(id);
  return { closeNow, ask };
}

/** merge a new plan's questions into a queue already being asked (no duplicates, the current head stays first) */
export function enqueueAsk(queue: readonly string[], more: readonly string[]): string[] {
  const out = [...queue];
  for (const id of more) if (!out.includes(id)) out.push(id);
  return out;
}

/**
 * File-name key for a document path. MUST be injective — two documents sharing a key would overwrite each other's
 * recovery data (a readable "/" → "_" mapping sends /a_b and /a/b to the same file). encodeURIComponent is
 * injective and leaves letters, digits and - _ . ! ~ * ' ( ) as they are, so names stay readable.
 */
export function draftKey(docPath: string): string {
  return encodeURIComponent(docPath);
}

export function recoveryRoot(docPath: string): string {
  return docPath && isPrivatePath(docPath) ? `${PRIVATE_ROOT}/.Recovery` : "/System/Recovery";
}

/**
 * Draft location. Path documents: <root>/<kind>-<key>.draft (e.g. /System/Recovery/writer-%2FDocuments%2Fa.docx.draft).
 * Untitled documents: <root>/<kind>_untitled-<id>.draft, id random per window (a counter-based window id repeats
 * after a reload and would overwrite the previous session's draft before it could be recovered).
 */
export function draftPathFor(kind: DocKind, docPath: string, untitledId = ""): string {
  if (!DOC_KINDS.includes(kind)) throw new Error(`unknown document kind ${String(kind)}`);
  if (!docPath && !/^[A-Za-z0-9-]{4,64}$/.test(untitledId)) throw new Error("an untitled draft needs an id");
  const key = docPath ? `-${draftKey(docPath)}` : `_untitled-${untitledId}`;
  return `${recoveryRoot(docPath)}/${kind}${key}.draft`;
}
export const UNTITLED_RE = /^(writer|sheet|editor)_untitled-([A-Za-z0-9-]{4,64})\.draft$/;

export interface DraftRecord {
  v: 1;
  kind: DocKind;
  /** the document's path when the draft was taken ("" for untitled) */
  path: string;
  title: string;
  savedAt: number;
  /** sha256 of the file as it was opened (null for untitled / new) — tells a stale draft from a fresh one */
  baseSha: string | null;
  encoding: "base64" | "utf8";
  payload: string;
}

export const MAX_DRAFT_CHARS = 12 * 1024 * 1024;

export function encodeDraft(r: DraftRecord): string { return JSON.stringify(r); }

/** strict: returns null for anything that is not exactly a v1 draft of the expected kind */
export function decodeDraft(text: string, kind: DocKind): DraftRecord | null {
  if (typeof text !== "string" || text.length > MAX_DRAFT_CHARS + 4096) return null;
  let o: unknown;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || r.kind !== kind) return null;
  if (typeof r.path !== "string" || typeof r.title !== "string" || typeof r.payload !== "string") return null;
  if (typeof r.savedAt !== "number" || !Number.isFinite(r.savedAt) || r.savedAt <= 0) return null;
  if (r.encoding !== "base64" && r.encoding !== "utf8") return null;
  if (r.baseSha !== null && (typeof r.baseSha !== "string" || !/^[0-9a-f]{64}$/.test(r.baseSha))) return null;
  if (r.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(r.payload)) return null;
  return { v: 1, kind, path: r.path, title: r.title, savedAt: r.savedAt, baseSha: r.baseSha as string | null, encoding: r.encoding, payload: r.payload };
}

export type Offer = { offer: false } | { offer: true; stale: boolean };
/**
 * Should a draft be offered for a document being opened? Only a draft OF THIS document (same path); stale when the
 * file on disk is no longer the one the draft was based on (changed elsewhere since) — still offered, but flagged.
 */
export function draftOffer(d: DraftRecord | null, docPath: string, fileSha: string | null): Offer {
  if (!d || d.path !== docPath) return { offer: false };
  return { offer: true, stale: d.baseSha !== null && fileSha !== null && d.baseSha !== fileSha };
}

/* ------------------------------------------------------------------ the draft writer */

export interface DraftIo {
  write(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export interface Timers { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

/**
 * schedule(make) — make() builds the draft text lazily (serialising a document costs CPU, so it runs once per
 * idle period, not per keystroke). Debounce `idleMs` after the last change, but never more than `maxWaitMs` after
 * the first unsaved change. One write in flight; changes during it schedule exactly one follow-up with the newest
 * content. flush() writes now. clear(path) cancels everything pending, waits for the in-flight write, then
 * deletes the draft — so Save → clear can never be followed by an older draft landing.
 */
export class DraftWriter {
  private timer: unknown = null;
  private firstAt = 0;
  private make: (() => Promise<{ path: string; text: string } | null>) | null = null;
  private inflight: Promise<void> | null = null;
  private epoch = 0;
  written = 0;
  lastError = "";
  private io: DraftIo; private idleMs: number; private maxWaitMs: number; private timers: Timers; private now: () => number;
  constructor(io: DraftIo, idleMs = 2000, maxWaitMs = 10000, timers: Timers = realTimers, now: () => number = Date.now) {
    this.io = io; this.idleMs = idleMs; this.maxWaitMs = maxWaitMs; this.timers = timers; this.now = now;
  }

  schedule(make: () => Promise<{ path: string; text: string } | null>): void {
    this.make = make;
    const t = this.now();
    if (!this.firstAt) this.firstAt = t;
    if (this.timer !== null) this.timers.clear(this.timer);
    const wait = Math.max(0, Math.min(this.idleMs, this.firstAt + this.maxWaitMs - t));
    this.timer = this.timers.set(() => { this.timer = null; void this.flush(); }, wait);
  }

  get pending(): boolean { return this.make !== null; }

  async flush(): Promise<void> {
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    while (this.inflight) await this.inflight;
    const make = this.make; if (!make) return;
    this.make = null; this.firstAt = 0;
    const epoch = this.epoch;
    const run = (async () => {
      try {
        const d = await make();
        if (!d || epoch !== this.epoch) return;
        if (d.text.length > MAX_DRAFT_CHARS) { this.lastError = `draft skipped: ${d.text.length} characters exceeds the ${MAX_DRAFT_CHARS} limit`; return; }
        await this.io.write(d.path, d.text);
        this.written += 1; this.lastError = "";
      } catch (e) { this.lastError = String((e as Error).message ?? e); }
    })();
    this.inflight = run;
    try { await run; } finally { if (this.inflight === run) this.inflight = null; }
  }

  /** cancel pending drafts, wait for the in-flight one, delete `paths` (missing files are fine) */
  async clear(...paths: string[]): Promise<void> {
    this.epoch += 1;
    if (this.timer !== null) { this.timers.clear(this.timer); this.timer = null; }
    this.make = null; this.firstAt = 0;
    while (this.inflight) await this.inflight;
    for (const p of paths) { try { await this.io.remove(p); } catch { /* not there */ } }
  }

  dispose(): void { if (this.timer !== null) this.timers.clear(this.timer); this.timer = null; }
}
