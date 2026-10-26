"use client";
import { useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { post } from "@/lib/api";
import { encodeTarget, type UaKind } from "@/lib/wp-core";
import { startSharedBroker } from "@/lib/wp-shared-broker";
import { Btn } from "../ui";

/**
 * TT35 — a proxied browser tab (WP-05). The page runs in an opaque-origin sandbox and reaches the network only
 * through Fusion's proxy (src/app/api/wp/s/…). This component owns the tab's proxy session, keeps its own
 * back / forward list (an iframe's history.back() walks the WHOLE window's joint history and could navigate the
 * desktop away, so it is never used), follows the page's address and title, and offers find in page, a desktop /
 * mobile identity, shields and cookie counters, and Save to Files.
 */
export interface ProxyFrameProps {
  tabId: string;
  url: string;
  /** session key (tab id, or "p:<profile>") → session id, owned by the Browser so a tab keeps its session (and
   *  cookies) across tab switches, and tabs of one named profile share theirs */
  sessions: Map<string, string>;
  onNav: (url: string, title: string) => void;
  /** TT37: the server's upstream route is SOCKS5 (Tor): offer "New circuit" (fresh isolation credentials) */
  circuitable?: boolean;
  /** TT37: label of a non-direct upstream route, shown in the status line */
  via?: string;
  /** named profile of this tab ("" = this tab only) */
  profile?: string;
  /** profile names in use by other tabs (offered in the menu) */
  profiles?: string[];
  onProfile?: (name: string) => void;
}

interface Stats { requests: number; blocked: number; cookies: number; errors: number; blockedHosts: Record<string, number>; failedHosts?: Record<string, string>; circuit?: number }

function b64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf); let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function saveName(url: string, type: string): string {
  let u: URL; try { u = new URL(url); } catch { return "page.html"; }
  let n = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "") || u.hostname;
  n = n.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "page";
  if (/html/i.test(type) && !/\.x?html?$/i.test(n)) n += ".html";
  return n;
}

/** session creations in flight, per Browser session map → key */
const minting = new WeakMap<Map<string, string>, Map<string, Promise<string>>>();

export default function ProxyFrame({ tabId, url, sessions, onNav, profile = "", profiles = [], onProfile, circuitable = false, via = "" }: ProxyFrameProps) {
  // TT36 (PR-07o): tabs sharing a named profile share one proxy session (one cookie jar); "" = this tab only
  const sessionKey = profile ? `p:${profile}` : tabId;
  const [reader, setReader] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const [start] = useState(url);
  const [sid, setSid] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [hist, setHist] = useState<{ list: string[]; i: number }>({ list: [url], i: 0 });
  const [title, setTitle] = useState("");
  const [ua, setUa] = useState<UaKind>("desktop");
  const [stats, setStats] = useState<Stats | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ n: number; i: number } | null>(null);
  const lastUrl = useRef("");
  const [note, setNote] = useState("");

  // TT43 (WP-22): this window's SharedWorker broker — proxied pages of one site and session share their workers
  useEffect(() => { startSharedBroker(); }, []);

  // session: reuse this tab's, or mint one (same-origin POST — a proxied page cannot do this)
  useEffect(() => {
    let live = true;
    (async () => {
      let id = sessions.get(sessionKey) ?? null;
      if (id) {
        const r = await fetch(`/api/wp-session?sid=${encodeURIComponent(id)}`);
        if (r.ok) { const j = (await r.json()) as { ua: UaKind }; if (live) setUa(j.ua); } else id = null;
      }
      if (!id) {
        // TT43: ONE creation per key in flight — two tabs of a profile mounting together (split view, a restored
        // window) each minted their own session before, silently splitting the profile's cookie jar in two
        let inflight = minting.get(sessions);
        if (!inflight) minting.set(sessions, (inflight = new Map()));
        let p = inflight.get(sessionKey);
        if (!p) {
          p = (async () => {
            const r = await fetch("/api/wp-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ua: "desktop", profile: profile || tabId }) });
            if (!r.ok) throw new Error(`could not start a proxy session (HTTP ${r.status})`);
            const sid = ((await r.json()) as { sid: string }).sid;
            sessions.set(sessionKey, sid);
            return sid;
          })().finally(() => inflight!.delete(sessionKey));
          inflight.set(sessionKey, p);
        }
        id = await p;
      }
      if (live) setSid(id);
    })().catch((e) => { if (live) setErr(String((e as Error).message ?? e)); });
    return () => { live = false; };
  }, [tabId, sessionKey, profile, sessions]);

  // the page reports its address / title / find results; only THIS frame's window is listened to
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { fusionWp?: string; url?: string; title?: string; n?: number; i?: number; reader?: boolean };
      if (!d || typeof d.fusionWp !== "string") return;
      if (d.fusionWp === "nav" && typeof d.url === "string" && /^https?:\/\//.test(d.url)) {
        const u = d.url, t = String(d.title ?? "").slice(0, 200);
        setHist((h) => {
          if (h.list[h.i] === u) return h;
          const list = [...h.list.slice(0, h.i + 1), u].slice(-100);
          return { list, i: list.length - 1 };
        });
        setTitle(t);
        // the page reports on DOMContentLoaded, load and title changes, and a find may already have been answered
        // before its first report: the first report only records the address; a DIFFERENT address later resets find
        if (lastUrl.current && lastUrl.current !== u) setFound(null);
        lastUrl.current = u;
        setReader(d.reader === true); // the page says which view it is (an "Original page" link leaves the reader)
        onNav(u, t);
      } else if (d.fusionWp === "found") setFound({ n: Number(d.n) || 0, i: Number(d.i) || 0 });
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onNav]);

  // live shields / cookies counters
  useEffect(() => {
    if (!sid) return;
    let live = true;
    const tick = () => { fetch(`/api/wp-session?sid=${encodeURIComponent(sid)}`).then((r) => (r.ok ? r.json() : null)).then((j) => { if (live && j) setStats(j as Stats); }).catch(() => {}); };
    tick();
    const t = window.setInterval(tick, 2500);
    return () => { live = false; window.clearInterval(t); };
  }, [sid]);

  const frameUrl = (target: string, asReader: boolean) => (!sid ? null : asReader ? `/api/wp/s/${sid}/__reader?u=${encodeURIComponent(target)}` : encodeTarget(target, sid));
  const go = (target: string, asReader = reader) => { setFound(null); if (frame.current && sid) frame.current.src = frameUrl(target, asReader) ?? "about:blank"; };
  const toggleReader = () => { const r = !reader; setReader(r); go(hist.list[hist.i], r); };
  // TT37: reload by navigating the frame to the current address — works on Fusion's own error pages too (they carry
  // no runtime to receive a "reload" message; found when a dead network route was fixed and Reload did nothing)
  const reload = () => { setFound(null); const cur = hist.list[hist.i]; if (cur && frame.current && sid) go(cur); else send({ fusionWp: "reload" }); };
  const send = (m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(m, "*"); // an opaque origin can only be addressed as "*"
  const back = () => { if (hist.i > 0) { const t = hist.list[hist.i - 1]; setHist({ ...hist, i: hist.i - 1 }); go(t); } };
  const fwd = () => { if (hist.i < hist.list.length - 1) { const t = hist.list[hist.i + 1]; setHist({ ...hist, i: hist.i + 1 }); go(t); } };
  const patch = async (body: Record<string, unknown>) => {
    if (!sid) return;
    const r = await fetch(`/api/wp-session?sid=${encodeURIComponent(sid)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) setStats((await r.json()) as Stats);
  };
  const save = async () => {
    if (!sid) return;
    const cur = hist.list[hist.i];
    setNote("Saving…");
    try {
      const r = await fetch(`/api/wp/s/${sid}/__raw?u=${encodeURIComponent(cur)}`);
      if (!r.ok) throw new Error(await r.text());
      const type = r.headers.get("x-fusion-wp-type") ?? "";
      const buf = await r.arrayBuffer();
      const name = saveName(cur, type);
      await post("/api/fs", { op: "mkdir", path: "/Downloads" }).catch(() => undefined);
      await post("/api/fs", { op: "write", path: `/Downloads/${name}`, content: b64(buf), encoding: "base64", mime: type.split(";")[0] || "application/octet-stream", reason: "browser-save" });
      setNote(`Saved to Files → /Downloads/${name} (${Math.round(buf.byteLength / 1024)} KB)`);
    } catch (e) { setNote(`Not saved: ${String((e as Error).message ?? e).slice(0, 160)}`); }
  };

  const src = sid ? encodeTarget(start, sid) : null;
  const blockedTitle = stats ? Object.entries(stats.blockedHosts).map(([h, n]) => `${h} ×${n}`).join("\n") || "nothing blocked yet" : "";
  return (
    <div data-testid="wp-tab" data-sid={sid ?? ""} data-url={hist.list[hist.i]} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div data-testid="wp-bar" className="fs-row" style={{ gap: 4, padding: "3px 6px", flexWrap: "wrap", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11) }}>
        <Btn variant="ghost" data-testid="wp-back" aria-label="Back" disabled={hist.i <= 0} onClick={back}>‹ Back</Btn>
        <Btn variant="ghost" data-testid="wp-forward" aria-label="Forward" disabled={hist.i >= hist.list.length - 1} onClick={fwd}>Forward ›</Btn>
        <Btn variant="ghost" data-testid="wp-reload" aria-label="Reload" onClick={reload}>Reload</Btn>
        <input className="fs-input" data-testid="wp-find" aria-label="Find in page" placeholder="Find in page" value={q} style={{ width: fz(130) }}
          onChange={(e) => { setQ(e.target.value); setFound(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send({ fusionWp: "find", q, dir: e.shiftKey ? -1 : 1 }); } }} />
        <span data-testid="wp-find-count" className="fs-dim" aria-live="polite">{found ? (found.n ? `${found.i}/${found.n}` : "no matches") : ""}</span>
        <label className="fs-row" style={{ gap: 3 }}>Identity
          <select className="fs-input" data-testid="wp-ua" aria-label="Identity sent to sites" value={ua}
            onChange={async (e) => { const v = e.target.value as UaKind; setUa(v); await patch({ ua: v }); reload(); }}>
            <option value="desktop">Desktop</option><option value="mobile">Mobile</option>
          </select>
        </label>
        <span data-testid="wp-shields" title={blockedTitle} className="fs-dim">Shields: {stats ? `${stats.blocked} blocked` : "…"}</span>
        {stats && stats.failedHosts && Object.keys(stats.failedHosts).length ? (
          <span data-testid="wp-unreachable" className="fs-dim" data-hosts={Object.keys(stats.failedHosts).join(" ")}
            title={`These hosts could not be reached from the Fusion server, so parts of the page (styles, images, scripts) may be missing:\n${Object.entries(stats.failedHosts).map(([h, k]) => `${h} — ${k === "reset" ? "connection cut (firewall / egress policy)" : k}`).join("\n")}`}>
            Unreachable: {Object.keys(stats.failedHosts).length}
          </span>
        ) : null}
        <span data-testid="wp-cookies" className="fs-dim" title="Cookies live in this tab's proxy session, in memory only">Cookies: {stats ? stats.cookies : "…"}</span>
        <Btn variant="ghost" data-testid="wp-clear" onClick={async () => { await patch({ clearCookies: true }); reload(); }}>Clear cookies</Btn>
        {circuitable ? <Btn variant="ghost" data-testid="wp-circuit" title="New circuit: this tab (or profile) gets fresh Tor credentials, so Tor builds a new circuit and the page reloads from a different exit" onClick={async () => { await patch({ newCircuit: true }); reload(); }}>New circuit{stats?.circuit ? ` (${stats.circuit})` : ""}</Btn> : null}
        <Btn variant="ghost" data-testid="wp-reader" aria-pressed={reader} data-variant={reader ? "primary" : "ghost"} title="Reader view: the article text and images only, in Fusion's typography; links stay in the reader" onClick={toggleReader}>Reader</Btn>
        <label className="fs-dim" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>Profile
          <select className="fs-input" data-testid="wp-profile" aria-label="Profile" value={profile} title="Tabs with the same profile share cookies (signed in together); 'This tab only' keeps a tab on its own. Profiles live in memory and end when no tab uses them."
            onChange={(e) => onProfile?.(e.target.value)}>
            <option value="">This tab only</option>
            {[...new Set(["Personal", "Work", ...profiles])].filter(Boolean).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <Btn variant="ghost" data-testid="wp-save" onClick={() => void save()}>Save to Files</Btn>
        <span className="fs-dim" title="Every request goes through Fusion: the site never sees your address, trackers are blocked, nothing is cached or stored on disk." data-testid="wp-via">Private proxy{via ? ` via ${via}` : ""}{title ? ` · ${title.slice(0, 60)}` : ""}</span>
      </div>
      {note ? <div data-testid="wp-note" className="fs-dim" style={{ fontSize: fz(11), padding: "2px 8px" }}>{note}</div> : null}
      {err ? <div data-testid="wp-error" style={{ padding: 12 }}>{err}</div> : null}
      {src ? (
        <iframe ref={frame} data-testid="wp-frame" src={src} title={title || hist.list[hist.i]}
          sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"
          referrerPolicy="no-referrer"
          style={{ flex: 1, minHeight: 0, width: "100%", border: 0, background: "#fff" }} />
      ) : !err ? <div className="fs-dim" style={{ padding: 12 }}>Starting a private proxy session…</div> : null}
    </div>
  );
}
