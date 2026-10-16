"use client";
/**
 * Browser privacy session (TT18): owns the single PrivacyLayer, installs it as a global fetch guard
 * BEFORE any module runs, and manages the Tails-like lifecycle:
 *   - Encrypted Persistent Storage: create / unlock / lock / change passphrase / rotate recovery key;
 *     keys live only as non-extractable CryptoKeys in this tab's memory; idle auto-lock.
 *   - Amnesic session (chosen at boot: ?amnesia=1 or the "always start amnesic" preference): host
 *     writes are denied by default, the VFS gets a RAM overlay, desktop state stays in memory, and
 *     localStorage is shadowed in memory so nothing new lands in the browser profile.
 *   - Emergency shutdown (Ctrl+Alt+Shift+Backspace or the Privacy button): drop keys, wipe the RAM
 *     overlay and shadows, clear the page and leave via location.replace (not kept in history).
 */
import { PrivacyLayer } from "./layer";
import {
  ARGON2_DEFAULT, KEYSLOT_PATH, PRIVATE_ROOT, changePassphrase, createVolume, decryptContent, encryptContent,
  parseHeader, rotateRecoveryKey, unlockVolume, type KeyHeader, type KdfParams, type VolumeKeys,
} from "./pcrypt";

export interface PrivacyStatus {
  installed: boolean;
  amnesic: boolean;
  bootAmnesic: boolean;
  storage: "absent" | "locked" | "unlocked" | "unknown";
  fingerprint: string | null;
  slots: { id: string; kind: string; kdf: string; created: string }[];
  autoLockMin: number;
  ram: { files: number; dirs: number; bytes: number; whiteouts: number };
  blocked: number;
  shadowKeys: number;
  lastError: string | null;
}

const PREF_BOOT = "fusion.privacy.bootAmnesic";
const PREF_LOCK = "fusion.privacy.autoLockMin";
export const EMERGENCY_CHORD = "Ctrl+Alt+Shift+Backspace";

type Listener = (s: PrivacyStatus) => void;

class PrivacySession {
  layer: PrivacyLayer | null = null;
  private rawFetch: typeof fetch | null = null;
  private header: KeyHeader | null = null;
  private storage: PrivacyStatus["storage"] = "unknown";
  private listeners = new Set<Listener>();
  private idleTimer: number | null = null;
  private lastError: string | null = null;
  private shadow = new Map<string, string | null>(); // amnesic localStorage shadow (null = removed)
  bootAmnesic = false;

  /* ---------------------------------------------------------------- install */
  install() {
    if (typeof window === "undefined" || this.layer) return;
    const original = window.fetch.bind(window);
    this.rawFetch = original;
    this.layer = new PrivacyLayer((url, init) => original(url, init), { onBlocked: () => this.emit(), onPrivateTouch: () => this.touch() });
    let amnesic = false;
    try { amnesic = new URLSearchParams(window.location.search).get("amnesia") === "1" || window.localStorage.getItem(PREF_BOOT) === "1"; } catch { /* storage disabled */ }
    this.bootAmnesic = amnesic;
    if (amnesic) this.enterAmnesia();
    const self = this;
    const guarded: typeof fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const same = url.startsWith("/") || url.startsWith(window.location.origin);
      const rel = url.startsWith(window.location.origin) ? url.slice(window.location.origin.length) : url;
      if (same && rel.startsWith("/api/") && self.layer) {
        const merged: RequestInit = input instanceof Request && !init ? { method: input.method, headers: input.headers } : (init ?? {});
        if (input instanceof Request && !init && input.method !== "GET" && input.method !== "HEAD") {
          // Request objects with bodies: read the body, then route (rare in this codebase)
          return input.clone().text().then((body) => self.layer!.handle(rel, { ...merged, body }));
        }
        return self.layer.handle(rel, merged);
      }
      return original(input as RequestInfo, init);
    };
    window.fetch = guarded;
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.altKey && e.shiftKey && (e.code === "Backspace" || e.key === "Backspace")) { e.preventDefault(); e.stopPropagation(); void this.emergencyShutdown(); }
    }, { capture: true });
    for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, () => this.touch(), { capture: true, passive: true });
    void this.refreshHeader();
  }

  /* ------------------------------------------------------------- amnesia */
  private enterAmnesia() {
    if (!this.layer) return;
    this.layer.amnesic = true;
    // localStorage shadow: reads see real values overlaid by this session's writes; writes never land.
    const proto = Storage.prototype;
    const real = { get: proto.getItem, set: proto.setItem, remove: proto.removeItem, clear: proto.clear };
    const shadow = this.shadow;
    const isLocal = (s: Storage) => { try { return s === window.localStorage; } catch { return false; } };
    proto.getItem = function (this: Storage, k: string) { if (isLocal(this) && shadow.has(k)) return shadow.get(k) ?? null; return real.get.call(this, k); };
    proto.setItem = function (this: Storage, k: string, v: string) { if (isLocal(this)) { shadow.set(k, String(v)); return; } real.set.call(this, k, v); };
    proto.removeItem = function (this: Storage, k: string) { if (isLocal(this)) { shadow.set(k, null); return; } real.remove.call(this, k); };
    proto.clear = function (this: Storage) { if (isLocal(this)) { for (let i = 0; i < this.length; i++) shadow.set(String(this.key(i)), null); return; } real.clear.call(this); };
    // IndexedDB would persist handles/blobs in the profile: refuse new databases this session.
    try {
      const idb = window.indexedDB;
      idb.open = ((name: string) => {
        throw new DOMException(`amnesic session: IndexedDB "${name}" refused (would persist in the browser profile)`, "SecurityError");
      }) as typeof idb.open;
    } catch { /* no IDB */ }
  }

  setBootAmnesic(on: boolean) {
    // the ONE deliberate trace of an amnesic user: a preference flag (stored only when outside amnesia)
    if (this.layer?.amnesic) { this.lastError = "change this preference from a normal session"; this.emit(); return; }
    try { if (on) window.localStorage.setItem(PREF_BOOT, "1"); else window.localStorage.removeItem(PREF_BOOT); } catch { /* storage disabled */ }
    this.emit();
  }
  restart(amnesic: boolean) {
    this.wipeMemory();
    window.location.replace(amnesic ? "/?amnesia=1" : "/");
  }

  /* ----------------------------------------------------- persistent storage */
  private raw() { if (!this.rawFetch) throw new Error("privacy session not installed"); return this.rawFetch; }
  async refreshHeader() {
    try {
      const r = await this.raw()(`/api/fs?op=read&path=${encodeURIComponent(KEYSLOT_PATH)}`, { cache: "no-store" });
      if (r.status === 404) { this.header = null; this.storage = "absent"; }
      else {
        const b = (await r.json()) as { ok: boolean; node?: { content: string } };
        if (!b.ok || !b.node) { this.header = null; this.storage = "absent"; }
        else { this.header = parseHeader(b.node.content); this.storage = this.layer?.keys ? "unlocked" : "locked"; }
      }
    } catch (e) { this.storage = "unknown"; this.lastError = String((e as Error).message); }
    this.emit();
  }
  private async writeHeader(h: KeyHeader) {
    const r = await this.raw()("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: KEYSLOT_PATH, content: JSON.stringify(h, null, 1), mime: "application/json", reason: "privacy-header" }) });
    const b = (await r.json()) as { ok: boolean; error?: string };
    if (!b.ok) throw new Error(b.error ?? "could not write the keyslot header");
    this.header = h;
  }
  async create(passphrase: string, kdf: KdfParams = ARGON2_DEFAULT) {
    if (this.header) throw new Error("Persistent Storage already exists — unlock it instead");
    const { header, keys, recoveryKey } = await createVolume(passphrase, { kdf });
    await this.writeHeader(header);
    this.setKeys(keys);
    return recoveryKey;
  }
  async unlock(secret: string) {
    if (!this.header) await this.refreshHeader();
    if (!this.header) throw new Error("no Persistent Storage on this host yet");
    const { keys, slot } = await unlockVolume(this.header, secret);
    this.setKeys(keys);
    return slot.kind;
  }
  async changePassphrase(current: string, next: string) {
    if (!this.header) throw new Error("no Persistent Storage");
    await this.writeHeader(await changePassphrase(this.header, current, next));
    this.emit();
  }
  async rotateRecovery(passphrase: string) {
    if (!this.header) throw new Error("no Persistent Storage");
    const { header, recoveryKey } = await rotateRecoveryKey(this.header, passphrase);
    await this.writeHeader(header);
    this.emit();
    return recoveryKey;
  }
  private setKeys(keys: VolumeKeys) {
    if (!this.layer) throw new Error("privacy session not installed");
    this.layer.keys = keys;
    this.storage = "unlocked";
    this.touch();
    this.emit();
  }
  lock(reason = "manual") {
    if (this.layer) this.layer.keys = null;
    if (this.storage === "unlocked") this.storage = "locked";
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    this.lastError = reason === "manual" ? null : `locked (${reason})`;
    this.emit();
    try { window.dispatchEvent(new CustomEvent("fusion:privacy-locked", { detail: { reason } })); } catch { /* noop */ }
  }
  get autoLockMin() { try { return Number(window.localStorage.getItem(PREF_LOCK) ?? "15") || 0; } catch { return 15; } }
  setAutoLock(min: number) { try { window.localStorage.setItem(PREF_LOCK, String(Math.max(0, Math.min(240, Math.round(min))))); } catch { /* noop */ } this.touch(); this.emit(); }
  private touch() {
    if (!this.layer?.keys || typeof window === "undefined") return;
    if (this.idleTimer) window.clearTimeout(this.idleTimer);
    const m = this.autoLockMin;
    if (m > 0) this.idleTimer = window.setTimeout(() => this.lock(`idle ${m} min`), m * 60_000);
  }

  /* -------------------------------------------------------------- emergency */
  private wipeMemory() {
    if (this.layer) { this.layer.keys = null; this.layer.ram.wipe(); this.layer.ramState.clear(); this.layer.blocked.length = 0; }
    this.shadow.clear();
    this.header = null;
  }
  async emergencyShutdown() {
    this.wipeMemory();
    try { document.title = ""; document.body.replaceChildren(); document.documentElement.style.background = "#000"; } catch { /* noop */ }
    try { window.sessionStorage.clear(); } catch { /* noop */ }
    // replace(), not assign(): the page is not kept as a history entry to go "back" to
    window.location.replace("about:blank");
  }

  /* ------------------------------------------------------------- benchmark */
  /** Real in-browser AES-GCM throughput with the unlocked volume key (or a throwaway key). */
  async benchmark(bytes = 4 * 1024 * 1024, rounds = 5) {
    let keys = this.layer?.keys ?? null;
    if (!keys) keys = (await createVolume("benchmark-only-key", { kdf: { kdf: "pbkdf2-sha256", iterations: 600_000 }, withRecovery: false })).keys;
    const data = new Uint8Array(bytes);
    for (let o = 0; o < bytes; o += 65536) globalThis.crypto.getRandomValues(data.subarray(o, Math.min(bytes, o + 65536)));
    const enc: number[] = []; const dec: number[] = [];
    for (let i = 0; i < rounds; i++) {
      let t = performance.now();
      const blob = await encryptContent(keys, { data, mime: "application/octet-stream", encoding: "base64" });
      enc.push(performance.now() - t);
      t = performance.now();
      await decryptContent(keys, blob);
      dec.push(performance.now() - t);
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const mbps = (ms: number) => Math.round((bytes / 1048576) / (ms / 1000));
    return { bytes, rounds, encryptMs: med(enc), decryptMs: med(dec), encryptMBps: mbps(med(enc)), decryptMBps: mbps(med(dec)) };
  }

  /* ----------------------------------------------------------------- status */
  status(): PrivacyStatus {
    const l = this.layer;
    return {
      installed: !!l, amnesic: !!l?.amnesic, bootAmnesic: this.bootAmnesic, storage: this.storage,
      fingerprint: l?.keys?.fingerprint ?? null,
      slots: (this.header?.slots ?? []).map((s) => ({ id: s.id, kind: s.kind, kdf: s.kdf.kdf === "argon2id" ? `Argon2id m=${s.kdf.m / 1024} MiB t=${s.kdf.t}` : `PBKDF2 ${s.kdf.iterations}`, created: s.created })),
      autoLockMin: typeof window === "undefined" ? 15 : this.autoLockMin,
      ram: l?.ram.stats() ?? { files: 0, dirs: 0, bytes: 0, whiteouts: 0 },
      blocked: l?.blocked.length ?? 0, shadowKeys: this.shadow.size, lastError: this.lastError,
    };
  }
  subscribe(f: Listener) { this.listeners.add(f); f(this.status()); return () => { this.listeners.delete(f); }; }
  private emit() { const s = this.status(); for (const f of this.listeners) f(s); }
  blockedLog() { return [...(this.layer?.blocked ?? [])]; }
  async audit() { if (!this.layer) throw new Error("not installed"); return this.layer.audit(); }
}

export const privacy = new PrivacySession();
export { PRIVATE_ROOT };
