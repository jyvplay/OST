/**
 * TT43 — SharedWorker broker for proxied pages (WP-22). Original code.
 *
 * A proxied page is an opaque-origin document, which may not use SharedWorker at all, and two proxied pages can
 * never reach each other. The Fusion window that frames them can: this broker lives there and gives proxied pages
 * the native sharing rule — ONE worker per (script URL, name, type) for all documents of the same site that share a
 * storage partition. Here a partition is a proxy session (one cookie jar: the tabs of one profile, or one tab), and,
 * as in Chromium's third-party storage partitioning, a document whose frame ancestors are cross-site is partitioned
 * further (stricter here: by its own document — it never joins a worker of another embedding).
 *
 * Trust: a page's message names its session id and its document id — both unguessable secrets the server issued to
 * that document. The broker never believes a page about which SITE it is: it asks the server (who()) and keys the
 * worker by the server's answer. Only opaque-origin senders are accepted. The worker itself runs inside a hidden
 * HOST document of that site, served and sandboxed exactly like a proxied page, under the proxy runtime — no
 * site code ever runs with Fusion's origin.
 *
 * Lifetime (HTML "permissible worker"): a worker lives while a document is connected; when the last one leaves
 * (pagehide, or its window is gone) it is terminated after a short grace (the spec allows a short
 * implementation-defined timeout so a same-site navigation can take it over), and a host document with no workers
 * is removed.
 */

export interface BrokerSource { postMessage(message: unknown, targetOrigin: string): void; readonly closed?: boolean }
export interface BrokerHost { post(message: unknown, transfer?: Transferable[]): void; remove(): void }
export interface WhoAnswer { origin: string; xs: boolean }
export interface BrokerDeps {
  /** the server's answer for (session, document): the document's real origin, or null (unknown / forged) */
  who(sid: string, doc: string): Promise<WhoAnswer | null>;
  /** frame a host document for the site of `doc`; its messages must be passed to broker.fromHost(hostKey, …) */
  makeHost(sid: string, doc: string, hostKey: string): BrokerHost;
  /** grace before an unused worker is terminated (ms) */
  graceMs?: number;
  setTimer?: (f: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Host { h: BrokerHost; ready: boolean; queue: (() => void)[]; workers: Map<string, number>; timers: Map<string, unknown> }
interface Conn { id: string; src: BrokerSource; hostKey: string; wkey: string }

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const isStr = (x: unknown, max: number): x is string => typeof x === "string" && x.length > 0 && x.length <= max;

export class SharedBroker {
  private hosts = new Map<string, Host>();
  private conns = new Map<number, Conn>();
  private seq = 0;
  private who = new Map<string, Promise<WhoAnswer | null>>();
  private early = new WeakMap<object, Set<string>>();
  private pings = new Map<BrokerSource, { nonce: string; missed: number; outstanding: boolean }>();
  private deps: BrokerDeps;
  constructor(deps: BrokerDeps) { this.deps = deps; }

  /** live state, for diagnostics and tests */
  stats() {
    return { hosts: this.hosts.size, connections: this.conns.size, workers: [...this.hosts.values()].reduce((n, h) => n + h.workers.size, 0) };
  }

  /** a message from any window: only opaque-origin documents (proxied pages) are served */
  onMessage(data: unknown, origin: string, src: BrokerSource | null, ports: readonly MessagePort[]): void {
    const d = data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || typeof d.fusionWpShared !== "string" || origin !== "null" || !src) return;
    if (d.fusionWpShared === "hello") { src.postMessage({ fusionWpShared: "here" }, "*"); return; }
    if (d.fusionWpShared === "alive") {
      // the document NOW in that window lists the connections it owns: any other connection of the window belonged
      // to a document that is gone (a navigation replaces the document but keeps the window)
      const st = this.pings.get(src);
      if (!st || d.nonce !== st.nonce || !Array.isArray(d.ids)) return;
      st.outstanding = false; st.missed = 0;
      const live = new Set(d.ids.filter((x): x is string => typeof x === "string"));
      for (const [k, c] of [...this.conns]) if (c.src === src && !live.has(c.id)) this.release(k);
      return;
    }
    if (d.fusionWpShared === "bye" && Array.isArray(d.ids)) {
      for (const id of d.ids.slice(0, 256)) {
        if (typeof id !== "string") continue;
        let found = false;
        for (const [k, c] of this.conns) if (c.id === id && c.src === src) { this.release(k); found = true; }
        if (!found) { let s = this.early.get(src); if (!s) this.early.set(src, (s = new Set())); s.add(id); }
      }
      return;
    }
    if (d.fusionWpShared !== "connect") return;
    const port = ports[0];
    if (!port) return;
    const { id, sid, doc, url, name, type } = d;
    const fail = () => { try { port.close(); } catch { /* closed */ } if (typeof id === "string" && ID.test(id)) src.postMessage({ fusionWpShared: "error", id }, "*"); };
    if (!isStr(id, 64) || !ID.test(id) || !isStr(sid, 128) || !isStr(doc, 128) || !isStr(url, 8192) || typeof name !== "string" || name.length > 1024 || (type !== "classic" && type !== "module")) { fail(); return; }
    const wk = `${sid}\n${doc}`;
    let p = this.who.get(wk);
    if (!p) { p = this.deps.who(sid, doc).catch(() => null); this.who.set(wk, p); if (this.who.size > 4096) this.who.delete(this.who.keys().next().value as string); }
    void p.then((w) => {
      if (!w) { this.who.delete(wk); fail(); return; }
      let u: URL;
      try { u = new URL(url); } catch { fail(); return; }
      // the script must be the document's own site (the page checked it natively; a forged message is refused here)
      if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== w.origin) { fail(); return; }
      const early = this.early.get(src);
      if (early?.delete(id)) { try { port.close(); } catch { /* closed */ } return; }
      const hostKey = `${sid}\n${w.origin}\n${w.xs ? `d:${doc}` : ""}`, wkey = `${u.href}\n${name}\n${type}`;
      let host = this.hosts.get(hostKey);
      if (!host) { host = { h: this.deps.makeHost(sid, doc, hostKey), ready: false, queue: [], workers: new Map(), timers: new Map() }; this.hosts.set(hostKey, host); }
      const t = host.timers.get(wkey);
      if (t !== undefined) { (this.deps.clearTimer ?? clearTimeout)(t as ReturnType<typeof setTimeout>); host.timers.delete(wkey); }
      host.workers.set(wkey, (host.workers.get(wkey) ?? 0) + 1);
      this.conns.set(++this.seq, { id, src, hostKey, wkey });
      const h = host;
      const send = () => h.h.post({ fusionWpShared: "attach", key: wkey, url: u.href, name, type }, [port]);
      if (h.ready) send(); else h.queue.push(send);
    });
  }

  /** a message from a host document this broker framed */
  fromHost(hostKey: string, data: unknown): void {
    const host = this.hosts.get(hostKey), d = data as Record<string, unknown> | null;
    if (!host || !d || typeof d !== "object") return;
    if (d.fusionWpShared === "host-ready") { host.ready = true; host.queue.splice(0).forEach((f) => f()); }
    else if (d.fusionWpShared === "error" && typeof d.key === "string") {
      for (const c of this.conns.values()) if (c.hostKey === hostKey && c.wkey === d.key) try { c.src.postMessage({ fusionWpShared: "error", id: c.id }, "*"); } catch { /* gone */ }
    }
  }

  /** Liveness: connections whose window is gone (a closed tab, a removed frame) are dropped; every other window is
   *  pinged and its current document answers with the connections it owns (see onMessage "alive"). A window that
   *  stops answering (a document without the proxy runtime) is dropped after MISSED pings in a row — a busy page
   *  that answers late once keeps its worker. */
  sweep(): void {
    const bySrc = new Map<BrokerSource, number[]>();
    for (const [k, c] of this.conns) { const l = bySrc.get(c.src); if (l) l.push(k); else bySrc.set(c.src, [k]); }
    for (const src of [...this.pings.keys()]) if (!bySrc.has(src)) this.pings.delete(src);
    for (const [src, ks] of bySrc) {
      let closed = false; try { closed = !!src.closed; } catch { closed = true; }
      const st = this.pings.get(src);
      if (!closed && st?.outstanding && ++st.missed >= SharedBroker.MISSED) closed = true;
      if (closed) { for (const k of ks) this.release(k); this.pings.delete(src); continue; }
      const nonce = Math.random().toString(36).slice(2);
      this.pings.set(src, { nonce, missed: st?.missed ?? 0, outstanding: true });
      try { src.postMessage({ fusionWpShared: "ping", nonce }, "*"); } catch { /* gone: next sweep */ }
    }
  }
  static MISSED = 3;

  private release(k: number): void {
    const c = this.conns.get(k);
    if (!c) return;
    this.conns.delete(k);
    const host = this.hosts.get(c.hostKey);
    if (!host) return;
    const n = (host.workers.get(c.wkey) ?? 1) - 1;
    if (n > 0) { host.workers.set(c.wkey, n); return; }
    host.workers.set(c.wkey, 0);
    const end = () => {
      host.timers.delete(c.wkey);
      if ((host.workers.get(c.wkey) ?? 0) > 0) return;
      host.workers.delete(c.wkey);
      const msg = () => host.h.post({ fusionWpShared: "release", key: c.wkey });
      if (host.ready) msg(); else host.queue.push(msg);
      if (host.workers.size === 0 && this.hosts.get(c.hostKey) === host) { host.h.remove(); this.hosts.delete(c.hostKey); }
    };
    host.timers.set(c.wkey, (this.deps.setTimer ?? setTimeout)(end, this.deps.graceMs ?? 1000));
  }
}

let started: SharedBroker | null = null;
/** The window's broker (idempotent): frames hosts in this document, asks this server who a document is. */
export function startSharedBroker(): SharedBroker | null {
  if (typeof window === "undefined") return null;
  if (started) return started;
  const frames = new Map<string, HTMLIFrameElement>();
  const broker = new SharedBroker({
    who: async (sid, doc) => {
      const r = await fetch(`/api/wp/s/${encodeURIComponent(sid)}/__shared-who?d=${encodeURIComponent(doc)}`, { cache: "no-store" });
      if (!r.ok) return null;
      const j = (await r.json()) as { origin?: unknown; xs?: unknown };
      return typeof j.origin === "string" ? { origin: j.origin, xs: j.xs === true } : null;
    },
    makeHost: (sid, doc, hostKey) => {
      const f = document.createElement("iframe");
      f.src = `/api/wp/s/${encodeURIComponent(sid)}/__shared-host?d=${encodeURIComponent(doc)}`;
      f.title = "Shared worker host"; f.tabIndex = -1;
      f.setAttribute("aria-hidden", "true"); f.setAttribute("data-fusion-shared-host", hostKey.split("\n")[1] ?? "");
      f.style.cssText = "position:fixed;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
      document.body.appendChild(f);
      frames.set(hostKey, f);
      return {
        post: (m, transfer) => f.contentWindow?.postMessage(m, "*", transfer ?? []), // the host is opaque: "*" only
        remove: () => { f.remove(); frames.delete(hostKey); },
      };
    },
  });
  window.addEventListener("message", (e) => {
    for (const [k, f] of frames) if (e.source && e.source === f.contentWindow) { broker.fromHost(k, e.data); return; }
    broker.onMessage(e.data, e.origin, e.source as BrokerSource | null, e.ports);
  });
  window.setInterval(() => broker.sweep(), 1500);
  (window as unknown as { __fusionSharedBroker?: SharedBroker }).__fusionSharedBroker = broker;
  started = broker;
  return broker;
}
