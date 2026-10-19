/**
 * Privacy transport layer (TT18) — the single choke point between every module and the host.
 *
 * Installed as a fetch guard in the browser (session.ts) and constructed directly over a real
 * fetch in the Node suites, so tests exercise the same code path the UI uses against the real
 * server. Modules are unchanged: they keep calling /api/fs etc.; this layer decides per request.
 *
 *  Store routing for /api/fs (dm-crypt / overlayfs analogue):
 *    /Private/**            → "private": names and content encrypted here, ciphertext to the host
 *                             (persistent even in an amnesic session — like Tails' Persistent folder)
 *    anything else, amnesic → "ram": a copy-on-write overlay in this tab's memory over a read-only
 *                             view of the host VFS; whiteouts hide deleted host entries
 *    anything else, normal  → "host": passthrough
 *  Cross-store move/copy is done here (read → write → trash), never by the server, so plaintext
 *  never crosses into a store that cannot hold it.
 *
 *  Other endpoints:
 *    - amnesic: DENY BY DEFAULT for any non-GET request, except pure-compute endpoints that write
 *      nothing (verified by grep of each route for db/VFS writes — see COMPUTE below); /api/state
 *      writes are kept in memory only and reads start from a clean desktop (Tails boots clean).
 *    - server-side readers (sheet/office/forge) given a /Private or RAM path: the file is read
 *      through this layer and sent inline as base64 — the host parses it transiently in process
 *      memory and stores nothing (declared: the server process sees plaintext while parsing).
 *    - sheet saveXlsxToVfs to /Private or RAM: rewritten to exportXlsx + a write through this layer.
 *    - desktop state: plaintext /Private paths inside the persisted state are replaced by their
 *      encrypted form (or "/Private/[locked]" when no key is loaded) before leaving the tab.
 */
import {
  CLEAR_PREFIX, ENC_MIME, KEYSLOT_FILE, KEYSLOT_PATH, PRIVATE_ROOT, decryptContent, decryptName, decryptPath, encryptContent,
  encryptName, encryptPath, fromB64, isEncName, isPrivatePath, looksEncryptedB64, toB64, type VolumeKeys,
} from "./pcrypt";
import { guessMime, isTextual } from "../mime";
import { PSEARCH_LIMITS, PrivateIndex, docBody, searchDocs, type PDoc, type PHit } from "./psearch";

export type RawFetch = (url: string, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;

/** Non-GET endpoints that persist nothing (grep-verified: no db.insert/update/delete/writeFile). */
export const COMPUTE = new Set(["/api/forge", "/api/office", "/api/search", "/api/sheet"]);
/** Endpoints that accept {path} OR {base64} and parse server-side. */
const INLINE_READERS = new Set(["/api/forge", "/api/office", "/api/sheet"]);

const enc = new TextEncoder();
const dec = new TextDecoder();
const norm = (p: string) => {
  const out: string[] = [];
  for (const part of String(p ?? "/").split("/").filter(Boolean)) {
    if (part === ".") continue;
    if (part === "..") { out.pop(); continue; }
    out.push(part.replace(/\u0000/g, ""));
  }
  return "/" + out.join("/");
};
const parentOf = (p: string) => { const n = norm(p); const i = n.lastIndexOf("/"); return i <= 0 ? "/" : n.slice(0, i); };
const baseOf = (p: string) => norm(p).split("/").filter(Boolean).pop() ?? "/";
const join = (dir: string, name: string) => `${dir === "/" ? "" : dir}/${name}`;
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "x-fusion-privacy": "layer" } });
const fail = (status: number, error: string, extra: Json = {}) => json({ ok: false, error, ...extra }, status);
async function sha256Hex(s: string) {
  const d = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", enc.encode(s) as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

class HttpError extends Error {
  status: number; extra: Json;
  constructor(status: number, msg: string, extra: Json = {}) { super(msg); this.status = status; this.extra = extra; }
}

/* ------------------------------------------------------------- RAM overlay */
export interface RamNode {
  path: string; parent: string; name: string; kind: "file" | "dir"; mime: string; encoding: "utf8" | "base64";
  content: string; size: number; sha256: string; version: number; tags: string; trashed: false;
  createdAt: string; updatedAt: string;
}
export class RamOverlay {
  nodes = new Map<string, RamNode>();
  white = new Set<string>();
  /** True when a host (lower) entry at p is hidden by a whiteout on p or an ancestor. */
  lowerHidden(p: string) {
    for (let a = norm(p); ; a = parentOf(a)) {
      if (this.white.has(a)) return true;
      if (a === "/") return false;
    }
  }
  private mk(path: string, kind: "file" | "dir", extra: Partial<RamNode> = {}): RamNode {
    const now = new Date().toISOString();
    return { path, parent: parentOf(path), name: baseOf(path), kind, mime: kind === "dir" ? "inode/directory" : "application/octet-stream", encoding: "utf8", content: "", size: 0, sha256: "", version: 1, tags: "", trashed: false, createdAt: now, updatedAt: now, ...extra };
  }
  ensureDirs(p: string) {
    for (let a = parentOf(p); a !== "/"; a = parentOf(a)) if (!this.nodes.has(a)) this.nodes.set(a, this.mk(a, "dir"));
  }
  mkdir(p: string) { const n = norm(p); this.ensureDirs(n); if (!this.nodes.has(n)) this.nodes.set(n, this.mk(n, "dir")); return n; }
  async write(p: string, content: string, encoding: "utf8" | "base64", mime: string | undefined, lowerVersion = 0) {
    const n = norm(p);
    const prev = this.nodes.get(n);
    if (prev?.kind === "dir") throw new HttpError(400, `${n} is a directory`);
    this.ensureDirs(n);
    const size = encoding === "base64" ? fromB64(content).length : enc.encode(content).length;
    const node = this.mk(n, "file", {
      mime: mime ?? guessMime(baseOf(n)), encoding, content, size, sha256: await sha256Hex(content),
      version: (prev?.version ?? lowerVersion) + 1, createdAt: prev?.createdAt,
    });
    this.nodes.set(n, node);
    return node;
  }
  remove(p: string) {
    const n = norm(p);
    for (const k of [...this.nodes.keys()]) if (k === n || k.startsWith(`${n}/`)) this.nodes.delete(k);
    this.white.add(n);
  }
  children(dir: string) { const d = norm(dir); return [...this.nodes.values()].filter((x) => x.parent === d); }
  /** Session end / emergency: drop every reference (JS strings cannot be overwritten — declared). */
  wipe() { this.nodes.clear(); this.white.clear(); }
  stats() {
    let bytes = 0; let files = 0;
    for (const n of this.nodes.values()) if (n.kind === "file") { files += 1; bytes += n.size; }
    return { files, dirs: this.nodes.size - files, bytes, whiteouts: this.white.size };
  }
}
const listShape = (n: RamNode) => { const { content, ...rest } = n; return { ...rest, id: -1, trashedFrom: null, hasContent: content.length > 0, base: n.name, ram: true }; };

/* ------------------------------------------------------------------ layer */
export interface LayerEvents { onBlocked?: (what: string) => void; onPrivateTouch?: () => void }

export class PrivacyLayer {
  keys: VolumeKeys | null = null;
  amnesic = false;
  /** TT20: called after every RAM-overlay mutation (drives the "unsaved work" list) */
  onRamChange: (() => void) | null = null;
  ram = new RamOverlay();
  /** amnesic desktop state lives here, never on the host */
  ramState = new Map<string, { state: unknown; revision: number }>();
  blocked: { at: number; what: string }[] = [];
  private raw: RawFetch;
  private events: LayerEvents;
  constructor(raw: RawFetch, events: LayerEvents = {}) { this.raw = raw; this.events = events; }

  get active() { return this.amnesic || this.keys !== null; }

  /* ------------------------------------------------- TT19 private search (in-tab, memory only) */
  private pidx: PrivateIndex | null = null;
  private pidxKeys: VolumeKeys | null = null;
  private pidxBuilding: Promise<PrivateIndex> | null = null;
  /** Drop the decrypted search index (lock, key change, emergency wipe). */
  dropPrivateIndex() { this.pidx?.clear(); this.pidx = null; this.pidxKeys = null; this.pidxBuilding = null; }
  /** The index only while the SAME unlocked key object is live; any lock/unlock/rekey invalidates it. */
  private livePidx(): PrivateIndex | null {
    if (this.pidx && this.keys && this.pidxKeys === this.keys) return this.pidx;
    if (this.pidx) this.dropPrivateIndex();
    return null;
  }
  async privateIndex(): Promise<PrivateIndex> {
    const k = this.needKeys();
    const live = this.livePidx(); if (live) return live;
    if (this.pidxBuilding && this.pidxKeys === k) return this.pidxBuilding;
    this.pidxKeys = k;
    const build = (async () => {
      const t0 = performance.now(); const idx = new PrivateIndex(k.fingerprint);
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 32 || idx.docs.size >= PSEARCH_LIMITS.files || this.keys !== k) return;
        const nodes = ((await this.fsList(dir)).nodes as Json[]) ?? [];
        const files = nodes.filter((n) => n.kind === "file" && !n.undecryptable && !n.trashed);
        for (let i = 0; i < files.length; i += 6) {
          await Promise.all(files.slice(i, i + 6).map(async (n) => {
            const path = String(n.path); const name = baseOf(path); const mime = guessMime(name);
            let body = "";
            if (isTextual(mime) && Number(n.size ?? 0) <= PSEARCH_LIMITS.bytesPerFile * 1.4) {
              try { const r = (await this.fsRead(path)).node as Json; body = docBody(String(r.content ?? ""), String(r.encoding ?? "utf8"), mime); } catch { body = ""; }
            }
            idx.put(path, name, body);
          }));
        }
        for (const d of nodes.filter((n) => n.kind === "dir" && !n.undecryptable)) await walk(String(d.path), depth + 1);
      };
      await walk(PRIVATE_ROOT, 0);
      if (this.keys !== k) { idx.clear(); throw new HttpError(423, "Persistent Storage was locked while indexing"); }
      idx.builtAt = Date.now(); idx.buildMs = Math.round(performance.now() - t0);
      this.pidx = idx;
      return idx;
    })();
    this.pidxBuilding = build;
    try { return await build; } finally { if (this.pidxBuilding === build) this.pidxBuilding = null; }
  }
  /**
   * GET /api/search interception. /Private hits come from the in-tab index; amnesic RAM files are searched in
   * place; the host is asked only when the scope is NOT inside /Private (the host never sees /Private queries).
   */
  private async search(u: URL, url: string, init: RequestInit): Promise<Response | null> {
    const q = (u.searchParams.get("q") ?? "").trim();
    const rawScope = (u.searchParams.get("scope") ?? "").trim();
    const scope = rawScope ? norm(rawScope) : "";
    const source = u.searchParams.get("source") ?? "";
    const privScope = !!scope && isPrivatePath(scope);
    if (!q || (!this.active && !privScope)) return null;
    const t0 = performance.now();
    const wantFiles = !source || source === "file";
    let priv: PHit[] = []; let pinfo: Json | null = null;
    if (wantFiles && this.keys && (!scope || privScope || PRIVATE_ROOT.startsWith(`${scope}/`) || scope === "/")) {
      const idx = await this.privateIndex();
      priv = idx.search(q, privScope ? scope : "");
      pinfo = { indexed: idx.docs.size, truncated: idx.truncated, buildMs: idx.buildMs, local: true };
    } else if (privScope && !this.keys) {
      return json({ ok: true, hits: [], coverage: [], tookMs: 0, locked: true, hostQueried: false, private: { indexed: 0, local: true } });
    }
    let ram: PHit[] = [];
    if (wantFiles && this.amnesic && !privScope) {
      const docs: PDoc[] = [...this.ram.nodes.values()].filter((n) => n.kind === "file").map((n) => {
        const body = docBody(n.content, n.encoding, n.mime);
        return { path: n.path, name: n.name, body, lower: `${n.name}\n${body}`.toLowerCase() };
      });
      ram = searchDocs(docs, q, scope === "/" ? "" : scope, 40, "amnesic-ram");
    }
    let host: Json = { ok: true, hits: [], coverage: [] };
    if (!privScope) {
      const r = await this.raw(url, init);
      if (!r.ok) return r;
      host = (await r.json()) as Json;
    }
    const hostHits = ((host.hits as PHit[] | undefined) ?? []).filter((h) => !(h.source === "file" && this.amnesic && (this.ram.lowerHidden(h.ref) || this.ram.nodes.has(h.ref))));
    const seen = new Set<string>(); const hits: unknown[] = [];
    for (const h of [...priv, ...ram, ...hostHits].sort((a, b) => Number(b.rank) - Number(a.rank))) {
      const key = `${h.source}:${h.ref}`; if (seen.has(key)) continue; seen.add(key); hits.push(h);
    }
    return json({ ...host, ok: true, hits, tookMs: Math.round(performance.now() - t0), hostQueried: !privScope, private: pinfo, amnesicHits: ram.length });
  }
  private note(what: string) { this.blocked.push({ at: Date.now(), what }); if (this.blocked.length > 200) this.blocked.shift(); this.events.onBlocked?.(what); }

  private storeOf(p: string): "private" | "ram" | "host" { return isPrivatePath(norm(p)) ? "private" : this.amnesic ? "ram" : "host"; }

  /* ---------------------------------------------------------- raw helpers */
  private async rawJson(url: string, init?: RequestInit): Promise<{ status: number; body: Json }> {
    const r = await this.raw(url, init);
    const t = await r.text();
    let body: Json;
    try { body = t ? (JSON.parse(t) as Json) : {}; } catch { body = { ok: false, error: t.slice(0, 200) }; }
    return { status: r.status, body };
  }
  private rawGet(op: string, path: string) { return this.rawJson(`/api/fs?op=${op}&path=${encodeURIComponent(path)}`, { cache: "no-store" }); }
  private rawPost(body: Json) { return this.rawJson("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
  private ensure(r: { status: number; body: Json }) { if (r.status >= 400 || r.body.ok === false) throw new HttpError(r.status >= 400 ? r.status : 400, String(r.body.error ?? `host error ${r.status}`), r.body); return r.body; }
  private needKeys() { if (!this.keys) throw new HttpError(423, "Persistent Storage is locked — unlock it in Privacy to use /Private"); this.events.onPrivateTouch?.(); return this.keys; }

  /* ----------------------------------------------------- private mapping */
  private async plainNode(n: Json): Promise<Json> {
    const out: Json = { ...n, encrypted: true };
    if (this.keys && typeof n.path === "string") {
      const { path, ok } = await decryptPath(this.keys, n.path);
      out.path = path; out.name = baseOf(path); out.base = baseOf(path); out.parent = parentOf(path);
      if (!ok) out.undecryptable = true;
      if (typeof n.trashedFrom === "string") out.trashedFrom = (await decryptPath(this.keys, n.trashedFrom)).path;
    }
    return out;
  }
  private async decryptBody(node: Json): Promise<Json> {
    const k = this.needKeys();
    const out = await this.plainNode(node);
    const content = String(node.content ?? "");
    if (node.kind === "file" && node.encoding === "base64" && looksEncryptedB64(content)) {
      const p = await decryptContent(k, fromB64(content));
      out.content = p.encoding === "base64" ? toB64(p.data) : dec.decode(p.data);
      out.encoding = p.encoding; out.mime = p.mime; out.size = p.data.length; out.storedSize = node.size;
    } else if (node.kind === "file" && content.length > 0) {
      out.encrypted = false; out.plaintextInPrivate = true; // audit flags these
    }
    return out;
  }
  private async sealBody(path: string, content: string, encoding: "utf8" | "base64", mime?: string) {
    const k = this.needKeys();
    const data = encoding === "base64" ? fromB64(content) : enc.encode(content);
    const blob = await encryptContent(k, { data, encoding, mime: mime ?? guessMime(baseOf(path)) });
    return { content: toB64(blob), encoding: "base64" as const, mime: ENC_MIME, plainSize: data.length };
  }

  /** "[clear] x" addresses an entry the host already holds in clear; creating a NEW one would leak its name. */
  private async refuseNewClear(p: string) {
    if (!p.split("/").some((seg) => seg.startsWith(CLEAR_PREFIX))) return;
    const st = await this.rawGet("stat", await encryptPath(this.needKeys(), p));
    if (!(st.body.node as Json | null)) throw new HttpError(422, `names starting with "${CLEAR_PREFIX}" are reserved inside Persistent Storage (they would be stored unencrypted)`);
  }

  /* ------------------------------------------------------- fs: reads */
  async fsRead(path: string): Promise<Json> {
    const p = norm(path);
    const store = this.storeOf(p);
    if (store === "private") {
      this.needKeys();
      const b = this.ensure(await this.rawGet("read", await encryptPath(this.keys!, p)));
      return { ...b, node: await this.decryptBody(b.node as Json) };
    }
    if (store === "ram") {
      const n = this.ram.nodes.get(p);
      if (n) return { ok: true, node: { ...n, id: -1, ram: true } };
      if (this.ram.lowerHidden(p)) throw new HttpError(404, "not found");
    }
    return this.ensure(await this.rawGet("read", p));
  }

  async fsList(path: string): Promise<Json> {
    const p = norm(path);
    const store = this.storeOf(p);
    if (store === "private") {
      if (!this.keys) {
        if (p !== PRIVATE_ROOT) throw new HttpError(423, "Persistent Storage is locked — unlock it in Privacy to use /Private");
        const r = await this.rawGet("list", p);
        const b = r.status === 400 || r.status === 404 ? { ok: true, nodes: [] } : this.ensure(r);
        return { ...b, path: p, locked: true, nodes: ((b.nodes as Json[]) ?? []).filter((n) => n.name !== KEYSLOT_FILE).map((n) => ({ ...n, encrypted: true, locked: true })) };
      }
      const r = await this.rawGet("list", await encryptPath(this.keys, p));
      const b = r.status === 400 && p === PRIVATE_ROOT ? { ok: true, nodes: [] } : this.ensure(r);
      const nodes = await Promise.all(((b.nodes as Json[]) ?? []).filter((n) => !(p === PRIVATE_ROOT && n.name === KEYSLOT_FILE)).map((n) => this.plainNode(n)));
      nodes.sort((a, c) => (a.kind === c.kind ? String(a.name).localeCompare(String(c.name)) : a.kind === "dir" ? -1 : 1));
      return { ...b, path: p, nodes };
    }
    if (store === "ram") {
      if (this.ram.lowerHidden(p) && !this.ram.nodes.has(p)) throw new HttpError(404, "not found");
      let lower: Json[] = [];
      if (!this.ram.lowerHidden(p)) {
        const r = await this.rawGet("list", p);
        if (r.status < 400 && r.body.ok !== false) lower = (r.body.nodes as Json[]) ?? [];
        else if (!this.ram.nodes.has(p) && p !== "/") this.ensure(r);
      }
      const mine = this.ram.children(p);
      const mineSet = new Set(mine.map((m) => m.path));
      const merged = [...lower.filter((n) => !this.ram.lowerHidden(String(n.path)) && !mineSet.has(String(n.path))), ...mine.map(listShape)];
      merged.sort((a, c) => (a.kind === c.kind ? String(a.name).localeCompare(String(c.name)) : a.kind === "dir" ? -1 : 1));
      return { ok: true, path: p, nodes: merged, amnesic: true };
    }
    return this.ensure(await this.rawGet("list", p));
  }

  private async fsStat(path: string): Promise<Json> {
    const p = norm(path);
    const store = this.storeOf(p);
    if (store === "private") {
      if (!this.keys && p === PRIVATE_ROOT) return this.ensure(await this.rawGet("stat", p));
      const b = this.ensure(await this.rawGet("stat", await encryptPath(this.needKeys(), p)));
      return { ...b, node: b.node ? await this.plainNode(b.node as Json) : null };
    }
    if (store === "ram") {
      const n = this.ram.nodes.get(p);
      if (n) {
        const kids = [...this.ram.nodes.values()].filter((x) => x.kind === "file" && x.path.startsWith(`${p}/`));
        return { ok: true, node: listShape(n), folder: n.kind === "dir" ? { bytes: kids.reduce((a, x) => a + x.size, 0), files: kids.length } : null };
      }
      if (this.ram.lowerHidden(p)) return { ok: true, node: null, folder: null };
    }
    return this.ensure(await this.rawGet("stat", p));
  }

  /* ------------------------------------------------------ fs: writes */
  async fsWrite(path: string, content: string, encoding: "utf8" | "base64", mime: string | undefined, reason: string): Promise<Json> {
    const p = norm(path);
    const store = this.storeOf(p);
    if (store === "private") {
      if (p === KEYSLOT_PATH) throw new HttpError(403, "the keyslot header is managed by Privacy, not writable as a file");
      await this.refuseNewClear(p);
      const sealed = await this.sealBody(p, content, encoding, mime);
      const b = this.ensure(await this.rawPost({ op: "write", path: await encryptPath(this.keys!, p), content: sealed.content, encoding: "base64", mime: ENC_MIME, reason }));
      this.livePidx()?.put(p, baseOf(p), docBody(content, encoding, mime ?? guessMime(baseOf(p))));
      return { ...b, path: p, size: sealed.plainSize, storedSize: b.size, encrypted: true };
    }
    if (store === "ram") {
      let lowerVersion = 0;
      if (!this.ram.nodes.has(p) && !this.ram.lowerHidden(p)) {
        const s = await this.rawGet("stat", p);
        lowerVersion = Number((s.body.node as Json | null)?.version ?? 0);
      }
      const n = await this.ram.write(p, content, encoding, mime, lowerVersion);
      this.ram.white.delete(p);
      this.onRamChange?.();
      return { ok: true, path: p, size: n.size, sha256: n.sha256, opId: -1, amnesic: true };
    }
    return this.ensure(await this.rawPost({ op: "write", path: p, content, encoding, mime, reason }));
  }

  private async fsMkdir(path: string): Promise<Json> {
    const p = norm(path);
    const store = this.storeOf(p);
    if (store === "private") {
      await this.refuseNewClear(p);
      const b = this.ensure(await this.rawPost({ op: "mkdir", path: await encryptPath(this.needKeys(), p) }));
      return { ...b, path: p };
    }
    if (store === "ram") { this.ram.mkdir(p); this.ram.white.delete(p); this.onRamChange?.(); return { ok: true, path: p, amnesic: true }; }
    return this.ensure(await this.rawPost({ op: "mkdir", path: p }));
  }

  private async fsSimple(op: "trash" | "restore" | "purge", path: string): Promise<Json> {
    const p = norm(path);
    const store = this.storeOf(p);
    if (store === "private") {
      if (p === PRIVATE_ROOT || p === KEYSLOT_PATH) throw new HttpError(403, "the Persistent Storage root and header cannot be trashed here — use Privacy › Delete Persistent Storage");
      const r = this.ensure(await this.rawPost({ op, path: await encryptPath(this.needKeys(), p) }));
      if (op === "restore") this.dropPrivateIndex(); else this.livePidx()?.dropPrefix(p);
      return r;
    }
    if (store === "ram") {
      if (op === "restore") { this.ram.white.delete(p); return { ok: true, amnesic: true }; }
      this.ram.remove(p);
      this.onRamChange?.();
      return { ok: true, amnesic: true, note: "hidden for this amnesic session; the host copy is untouched" };
    }
    return this.ensure(await this.rawPost({ op, path: p }));
  }

  /** Move/copy. Same-store host/private go to the server (encrypted names); everything else here. */
  async fsTransfer(src: string, dst: string, mode: "move" | "copy", depth = 0): Promise<Json> {
    const from = norm(src); const to = norm(dst);
    if (from === "/" || to === from) throw new HttpError(400, "invalid transfer");
    if (to.startsWith(`${from}/`)) throw new HttpError(400, "refusing to move a directory into itself");
    if (from === KEYSLOT_PATH || from === PRIVATE_ROOT) throw new HttpError(403, "the Persistent Storage root/header cannot be moved");
    const a = this.storeOf(from); const b = this.storeOf(to);
    if (a === b && a === "host") return this.ensure(await this.rawPost({ op: mode, src: from, dst: to }));
    // A source holding a host-cleartext ("[clear] …") segment must NOT be renamed server-side: that would
    // give plaintext content an encrypted-looking name and hide it from audit(). Re-seal it instead.
    const clearSrc = from.split("/").some((seg) => seg.startsWith(CLEAR_PREFIX));
    if (a === b && a === "private" && !clearSrc) {
      const k = this.needKeys();
      await this.refuseNewClear(to);
      const r = this.ensure(await this.rawPost({ op: mode, src: await encryptPath(k, from), dst: await encryptPath(k, to) }));
      if (mode === "move") this.livePidx()?.movePrefix(from, to); else this.dropPrivateIndex();
      return { ...r, from, to };
    }
    // cross-store (or RAM): explicit read → write (→ trash) through this layer
    if (depth > 32) throw new HttpError(400, "directory nesting too deep for a cross-store transfer");
    const st = await this.fsStat(from);
    const node = st.node as Json | null;
    if (!node) throw new HttpError(404, `not found: ${from}`);
    let count = 0;
    if (node.kind === "dir") {
      await this.fsMkdir(to);
      const kids = (await this.fsList(from)).nodes as Json[];
      if (kids.length > 2000) throw new HttpError(400, "more than 2 000 entries — refusing a cross-store transfer that large");
      for (const kid of kids) { await this.fsTransfer(String(kid.path), join(to, String(kid.name)), "copy", depth + 1); count += 1; }
    } else {
      const r = (await this.fsRead(from)).node as Json;
      await this.fsWrite(to, String(r.content ?? ""), (r.encoding as "utf8" | "base64") ?? "utf8", r.mime ? String(r.mime) : undefined, `${mode}-cross-store`);
      count = 1;
    }
    if (mode === "move") await this.fsSimple("trash", from);
    return { ok: true, opId: -1, from, to, crossStore: `${a}→${b}`, entries: count };
  }

  /* ----------------------------------------------------- /api/fs dispatch */
  async fs(method: string, q: URLSearchParams, body: Json | null): Promise<Response> {
    try {
      if (method === "GET") {
        const op = q.get("op") ?? "list";
        const path = q.get("path") ?? "/";
        switch (op) {
          case "list": return json(await this.fsList(path));
          case "read": return json(await this.fsRead(path));
          case "stat": return json(await this.fsStat(path));
          case "versions": {
            const p = norm(path);
            if (this.storeOf(p) === "private") {
              const b = this.ensure(await this.rawGet("versions", await encryptPath(this.needKeys(), p)));
              const versions = await Promise.all(((b.versions as Json[]) ?? []).map(async (v) => {
                const d = await this.decryptBody({ ...v, kind: "file" });
                return { ...v, path: p, content: d.content, encoding: d.encoding, size: d.size };
              }));
              return json({ ...b, versions });
            }
            if (this.storeOf(p) === "ram" && this.ram.nodes.has(p)) return json({ ok: true, versions: [], amnesic: true });
            return json(this.ensure(await this.rawGet("versions", p)));
          }
          case "trash": {
            const b = this.ensure(await this.rawGet("trash", "/"));
            const nodes = await Promise.all(((b.nodes as Json[]) ?? []).map((n) => (isPrivatePath(String(n.path)) ? this.plainNode(n) : n)));
            return json({ ...b, nodes });
          }
          case "tree": {
            const b = this.ensure(await this.rawGet("tree", "/"));
            let dirs = (b.dirs as string[]) ?? [];
            if (this.keys) dirs = await Promise.all(dirs.map(async (d) => (isPrivatePath(d) ? (await decryptPath(this.keys!, d)).path : d)));
            else dirs = dirs.filter((d) => !isPrivatePath(d) || d === PRIVATE_ROOT);
            if (this.amnesic) dirs = [...new Set([...dirs.filter((d) => !this.ram.lowerHidden(d)), ...[...this.ram.nodes.values()].filter((n) => n.kind === "dir").map((n) => n.path)])].sort();
            return json({ ...b, dirs });
          }
          default: return json(this.ensure(await this.rawGet(op, path)));
        }
      }
      const op = String(body?.op ?? "");
      const path = String(body?.path ?? "");
      switch (op) {
        case "write":
          return json(await this.fsWrite(path, String(body?.content ?? ""), (body?.encoding as "utf8" | "base64") ?? "utf8", body?.mime ? String(body.mime) : undefined, String(body?.reason ?? "write")));
        case "upload":
          return json(await this.fsWrite(path, String(body?.content ?? ""), "base64", body?.mime ? String(body.mime) : undefined, "upload"));
        case "mkdir": return json(await this.fsMkdir(path));
        case "move": case "copy": return json(await this.fsTransfer(String(body?.src), String(body?.dst), op));
        case "rename": {
          const name = String(body?.name ?? "");
          if (!name || name.includes("/")) throw new HttpError(400, "invalid name");
          return json(await this.fsTransfer(path, join(parentOf(path), name), "move"));
        }
        case "trash": case "restore": case "purge": return json(await this.fsSimple(op, path));
        case "dropVersions": {
          const st = this.storeOf(path);
          if (st === "ram") return json({ ok: true, dropped: 0, amnesic: true }); // RAM files keep no history
          return json(this.ensure(await this.rawPost({ op, path: st === "private" ? await encryptPath(this.needKeys(), norm(path)) : norm(path) })));
        }
        case "tag": {
          if (this.storeOf(path) === "private") throw new HttpError(422, "tags are stored in clear on the host — not allowed on Persistent Storage files");
          if (this.storeOf(path) === "ram") {
            const n = this.ram.nodes.get(norm(path));
            if (!n) throw new HttpError(422, "amnesic session: tags on host files would be written to the host");
            n.tags = String(body?.tags ?? ""); return json({ ok: true, amnesic: true });
          }
          return json(this.ensure(await this.rawPost(body ?? {})));
        }
        case "batchRename": case "compress": case "extract": {
          const touched = [path, String(body?.dst ?? "")].filter(Boolean);
          if (touched.some((t) => this.storeOf(t) === "private")) throw new HttpError(422, `${op} runs on the host and would need plaintext names/content — not available inside Persistent Storage`);
          if (this.amnesic) { this.note(`fs.${op}`); throw new HttpError(423, `amnesic session: ${op} writes on the host — not available`); }
          return json(this.ensure(await this.rawPost(body ?? {})));
        }
        default: return json(this.ensure(await this.rawPost(body ?? {})));
      }
    } catch (e) {
      if (e instanceof HttpError) return fail(e.status, e.message, e.extra);
      return fail(500, String((e as Error).message ?? e));
    }
  }

  /* -------------------------------------------------------- desktop state */
  private async mapStrings(v: unknown, f: (s: string) => Promise<string>): Promise<unknown> {
    if (typeof v === "string") return f(v);
    if (Array.isArray(v)) return Promise.all(v.map((x) => this.mapStrings(x, f)));
    if (v && typeof v === "object") {
      const out: Json = {};
      for (const [k, x] of Object.entries(v as Json)) out[k] = await this.mapStrings(x, f);
      return out;
    }
    return v;
  }
  /** Replaces plaintext /Private paths with ciphertext paths (or a locked marker). Exposed for tests. */
  async sealState(state: unknown) {
    return this.mapStrings(state, async (s) => {
      if (!(s === PRIVATE_ROOT || s.startsWith(`${PRIVATE_ROOT}/`)) || s.length > 4096) return s;
      const segs = s.slice(PRIVATE_ROOT.length).split("/").filter(Boolean);
      if (segs.every(isEncName)) return s;
      if (!this.keys) return `${PRIVATE_ROOT}/[locked]`;
      try { return await encryptPath(this.keys, s); } catch { return `${PRIVATE_ROOT}/[locked]`; }
    });
  }
  async openState(state: unknown) {
    if (!this.keys) return state;
    return this.mapStrings(state, async (s) => (s.startsWith(`${PRIVATE_ROOT}/~`) ? (await decryptPath(this.keys!, s)).path : s));
  }

  private async stateReq(method: string, q: URLSearchParams, body: Json | null, url: string, init: RequestInit): Promise<Response> {
    const id = q.get("id") ?? String(body?.id ?? "default");
    if (this.amnesic) {
      if (method === "GET") { const r = this.ramState.get(id); return json({ ok: true, row: r ? { id, state: r.state, revision: r.revision } : null, amnesic: true }); }
      if (method === "PUT") { const rev = Number(body?.revision ?? 0); this.ramState.set(id, { state: body?.state, revision: rev }); return json({ ok: true, revision: rev, amnesic: true }); }
      this.note(`state.${method}`);
      return fail(423, "amnesic session: desktop presets are not written to the host");
    }
    if (method === "PUT" && body) {
      return this.raw(url, { ...init, body: JSON.stringify({ ...body, state: await this.sealState(body.state) }) });
    }
    if (method === "GET" && this.keys) {
      const r = await this.rawJson(url, init);
      const row = r.body.row as Json | null;
      if (row?.state) row.state = await this.openState(row.state);
      return json(r.body, r.status);
    }
    return this.raw(url, init);
  }

  /* --------------------------------------------- inline server readers */
  private async inlineRead(path: string) {
    const n = (await this.fsRead(path)).node as Json;
    const content = String(n.content ?? "");
    return n.encoding === "base64" ? content : toB64(enc.encode(content));
  }

  private async reader(pathname: string, body: Json, url: string, init: RequestInit): Promise<Response | null> {
    const p = typeof body.path === "string" ? norm(body.path) : null;
    const viaLayer = (x: string | null) => !!x && (this.storeOf(x) === "private" || (this.storeOf(x) === "ram" && (this.ram.nodes.has(x) || this.ram.lowerHidden(x))));
    // sheet export straight into /Private or the RAM overlay
    if (pathname === "/api/sheet" && body.op === "saveXlsxToVfs" && typeof body.dest === "string" && this.storeOf(body.dest) !== "host") {
      const r = await this.rawJson(url, { ...init, body: JSON.stringify({ ...body, op: "exportXlsx", dest: undefined }) });
      if (r.status >= 400 || r.body.ok === false) return json(r.body, r.status);
      try {
        const w = await this.fsWrite(String(body.dest), String(r.body.base64), "base64", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "sheet-export");
        return json({ ...w, bytes: r.body.bytes, sheets: r.body.sheets });
      } catch (e) { return e instanceof HttpError ? fail(e.status, e.message) : fail(500, String(e)); }
    }
    if (!body.base64 && viaLayer(p)) {
      try {
        const base64 = await this.inlineRead(p!);
        return this.raw(url, { ...init, body: JSON.stringify({ ...body, path: baseOf(p!), base64 }) });
      } catch (e) { return e instanceof HttpError ? fail(e.status, e.message) : fail(500, String(e)); }
    }
    return null;
  }

  /* ---------------------------------------------------------------- entry */
  async handle(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.pidx && this.pidxKeys !== this.keys) this.dropPrivateIndex(); // keys gone/changed by any path → plaintext index gone
    const u = new URL(url, "http://fusion.invalid");
    const method = String(init.method ?? "GET").toUpperCase();
    let body: Json | null = null;
    if (typeof init.body === "string" && init.body) { try { body = JSON.parse(init.body) as Json; } catch { body = null; } }
    if (u.pathname === "/api/fs") {
      if (!this.active && !isPrivatePath(norm(u.searchParams.get("path") ?? String(body?.path ?? "")))
        && !isPrivatePath(norm(String(body?.src ?? ""))) && !isPrivatePath(norm(String(body?.dst ?? "")))) {
        return this.raw(url, init);
      }
      return this.fs(method, u.searchParams, body);
    }
    if (u.pathname === "/api/state") return this.stateReq(method, u.searchParams, body, url, init);
    if (u.pathname === "/api/search" && method === "GET") {
      try { const r = await this.search(u, url, init); if (r) return r; }
      catch (e) { if (e instanceof HttpError) return fail(e.status, e.message); throw e; }
    }
    if (body && INLINE_READERS.has(u.pathname)) {
      const r = await this.reader(u.pathname, body, url, init);
      if (r) return r;
    }
    // TT44 (TD-03): SSH talks to a remote machine, not to the host's store. In an amnesic session it still works, but
    // the request is tagged so the server refuses every host write it could cause (known_hosts) — a host key can be
    // accepted for this session only. SFTP file content reaches the store only through /api/fs (this layer).
    if (u.pathname === "/api/ssh" || u.pathname.startsWith("/api/ssh/")) {
      if (!this.amnesic) return this.raw(url, init);
      const h = new Headers(init.headers); h.set("x-fusion-amnesic", "1");
      return this.raw(url, { ...init, headers: h });
    }
    if (this.amnesic && method !== "GET" && method !== "HEAD" && !COMPUTE.has(u.pathname)) {
      this.note(`${method} ${u.pathname}`);
      return fail(423, `amnesic session: ${u.pathname} would be written to the host — nothing was saved`, { amnesic: true });
    }
    return this.raw(url, init);
  }

  /* ------------------------------------------- TT20 amnesic "unsaved work" rescue */
  /**
   * Tails pain point: files saved anywhere but the Persistent folder vanish at shutdown, and users only find out
   * afterwards. In an amnesic session these are the files that exist ONLY in this tab's RAM.
   */
  ramFiles(): { path: string; size: number }[] {
    return [...this.ram.nodes.values()].filter((n) => n.kind === "file").map((n) => ({ path: n.path, size: n.size })).sort((a, b) => a.path.localeCompare(b.path));
  }
  /** Move RAM-only files into Persistent Storage (encrypted), keeping their relative path under `root`. */
  async rescue(paths: string[], root = `${PRIVATE_ROOT}/Rescued`): Promise<{ moved: { from: string; to: string }[]; failed: { path: string; error: string }[] }> {
    this.needKeys();
    if (!isPrivatePath(norm(root))) throw new HttpError(400, "rescue target must be inside /Private");
    const out = { moved: [] as { from: string; to: string }[], failed: [] as { path: string; error: string }[] };
    for (const p of paths) {
      const from = norm(p);
      const n = this.ram.nodes.get(from);
      if (!n || n.kind !== "file") { out.failed.push({ path: from, error: "not a RAM-only file" }); continue; }
      const to = norm(`${root}${from}`);
      try { await this.fsTransfer(from, to, "move"); out.moved.push({ from, to }); }
      catch (e) { out.failed.push({ path: from, error: (e as Error).message }); }
    }
    return out;
  }

  /* ----------------------------------------------------------- utilities */
  /** Walks /Private and reports any entry the host holds in clear (names or content). */
  async audit(maxEntries = 5000) {
    const k = this.needKeys();
    const report = { files: 0, dirs: 0, encryptedNames: 0, plainNames: [] as string[], encryptedContent: 0, plainContent: [] as string[], undecryptable: [] as string[] };
    const walk = async (encDir: string, depth: number) => {
      if (depth > 32 || report.files + report.dirs > maxEntries) return;
      const r = await this.rawGet("list", encDir);
      if (r.status >= 400) return;
      for (const n of (r.body.nodes as Json[]) ?? []) {
        const name = String(n.name);
        if (encDir === PRIVATE_ROOT && name === KEYSLOT_FILE) continue;
        if (isEncName(name)) {
          report.encryptedNames += 1;
          try { await decryptName(k, name); } catch { report.undecryptable.push(String(n.path)); }
        } else report.plainNames.push(String(n.path));
        if (n.kind === "dir") { report.dirs += 1; await walk(String(n.path), depth + 1); continue; }
        report.files += 1;
        const full = this.ensure(await this.rawGet("read", String(n.path))).node as Json;
        if (full.encoding === "base64" && looksEncryptedB64(String(full.content))) report.encryptedContent += 1;
        else if (String(full.content ?? "").length > 0) report.plainContent.push(String(n.path));
      }
    };
    await walk(PRIVATE_ROOT, 0);
    return report;
  }

  /** Encrypts an existing plaintext file in place under /Private (used to migrate). */
  async encryptName(name: string) { return encryptName(this.needKeys(), name); }
}
