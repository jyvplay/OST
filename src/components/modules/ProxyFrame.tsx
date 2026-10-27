"use client";
import { useEffect, useRef, useState } from "react";
import { fz } from "@/lib/uiscale";
import { MAX_BROWSER_SAVE_BYTES, readBrowserSave, saveBrowserDownload } from "@/lib/browser-download";
import { privacy } from "@/lib/privacy/session";
import { encodeTarget, type UaKind } from "@/lib/wp-core";
import { useShell } from "../shell-context";
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

interface Stats { requests: number; blocked: number; cookies: number; errors: number; blockedHosts: Record<string, number>; failedHosts?: Record<string, string>; circuit?: number; ua?: UaKind; uaOverride?: UaKind | null }
type UaChoice = "default" | UaKind;
function siteHostOf(url: string): string { try { return new URL(url).host; } catch { return ""; } }

// Keep the existing named export for callers; its implementation is shared with tests.
export { saveName } from "@/lib/browser-download";

/** session creations in flight, per Browser session map → key */
const minting = new WeakMap<Map<string, string>, Map<string, Promise<string>>>();

export default function ProxyFrame({ tabId, url, sessions, onNav, profile = "", profiles = [], onProfile, circuitable = false, via = "" }: ProxyFrameProps) {
  const shell = useShell();
  const transfer = useRef<AbortController | null>(null);
  const [savePhase, setSavePhase] = useState<"fetching" | "saving" | null>(null);
  const [savedPath, setSavedPath] = useState("");
  useEffect(() => () => { transfer.current?.abort(); }, []);
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
  const [uaChoice, setUaChoice] = useState<UaChoice>("default");
  const [stats, setStats] = useState<Stats | null>(null);
  const [q, setQ] = useState("");
  const queryRef = useRef(q);
  useEffect(() => { queryRef.current = q; }, [q]);
  const [found, setFound] = useState<{ n: number; i: number; truncated: boolean } | null>(null);
  const lastUrl = useRef("");
  const [note, setNote] = useState("");
  const currentSite = siteHostOf(hist.list[hist.i] ?? start);

  // TT43 (WP-22): this window's SharedWorker broker — proxied pages of one site and session share their workers
  useEffect(() => { startSharedBroker(); }, []);

  // session: reuse this tab's, or mint one (same-origin POST — a proxied page cannot do this)
  useEffect(() => {
    let live = true;
    (async () => {
      let id = sessions.get(sessionKey) ?? null;
      if (id) {
        const site = siteHostOf(start);
        const r = await fetch(`/api/wp-session?sid=${encodeURIComponent(id)}${site ? `&site=${encodeURIComponent(site)}` : ""}`);
        if (r.ok) {
          const j = (await r.json()) as { ua: UaKind; uaOverride?: UaKind | null };
          if (live) { setUa(j.ua); setUaChoice(j.uaOverride ?? "default"); }
        } else id = null;
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
  }, [tabId, sessionKey, profile, sessions, start]);

  // Identity is host-scoped within the RAM-only proxy session. A navigation to another site falls back to Desktop unless that host has its own override.
  useEffect(() => {
    if (!sid || !currentSite) return;
    let live = true;
    fetch(`/api/wp-session?sid=${encodeURIComponent(sid)}&site=${encodeURIComponent(currentSite)}`)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json() as { ua: UaKind; uaOverride?: UaKind | null }; })
      .then((j) => { if (live) { setUa(j.ua); setUaChoice(j.uaOverride ?? "default"); } })
      .catch(() => undefined);
    return () => { live = false; };
  }, [sid, currentSite]);

  // the page reports its address / title / find results; only THIS frame's window is listened to
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frame.current || e.source !== frame.current.contentWindow) return;
      const d = e.data as { fusionWp?: string; url?: string; title?: string; q?: string; n?: number; i?: number; truncated?: boolean; reader?: boolean };
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
      } else if (d.fusionWp === "found" && String(d.q ?? "") === queryRef.current) {
        const n = Number(d.n), i = Number(d.i);
        setFound({ n: Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0, i: Number.isFinite(i) ? Math.max(0, Math.floor(i)) : 0, truncated: d.truncated === true });
      }
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
  const patch = async (body: Record<string, unknown>): Promise<Stats | null> => {
    if (!sid) return null;
    const r = await fetch(`/api/wp-session?sid=${encodeURIComponent(sid)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const result = await r.json() as Stats;
    setStats(result);
    return result;
  };
  const save = async () => {
    if (transfer.current) return;
    if (!privacy.status().installed || privacy.status().amnesic) { setNote("Not saved: server downloads are unavailable in an amnesic session."); return; }
    if (!sid) { setNote("Not saved: the private proxy session is not ready."); return; }
    const cur = hist.list[hist.i], controller = new AbortController();
    transfer.current = controller; setSavePhase("fetching"); setSavedPath(""); setNote("Fetching original bytes…");
    let committing = false, lastProgress = 0;
    try {
      const r = await fetch(`/api/wp/s/${sid}/__raw?u=${encodeURIComponent(cur)}`, { signal: controller.signal });
      const type = r.headers.get("x-fusion-wp-type") ?? "";
      const bytes = await readBrowserSave(r, controller.signal, (n) => {
        const now = performance.now();
        if (now - lastProgress >= 250) { lastProgress = now; setNote(`Received ${Math.ceil(n / 1024)} KiB (limit ${MAX_BROWSER_SAVE_BYTES / 1048576} MiB)…`); }
      });
      if (controller.signal.aborted) throw new DOMException("Download cancelled", "AbortError");
      // The commit is intentionally not cancellable: an interrupted acknowledgement
      // cannot prove that PostgreSQL did not save the file.
      committing = true; setSavePhase("saving"); setNote("Saving to Fusion Files…");
      const saved = await saveBrowserDownload(cur, type, bytes);
      setSavedPath(saved.path); setNote(`Saved to Files → ${saved.path} (${Math.round(bytes.byteLength / 1024)} KB)`);
    } catch (e) {
      const message = String((e as Error).message ?? e).slice(0, 160);
      setNote(!committing && controller.signal.aborted ? "Cancelled before saving; no file was written." : committing ? `Save not confirmed; check /Downloads before retrying. ${message}` : `Not saved: ${message}`);
    } finally { transfer.current = null; setSavePhase(null); }
  };

  const src = sid ? encodeTarget(start, sid) : null;
  const blockedTitle = stats ? Object.entries(stats.blockedHosts).map(([h, n]) => `${h} ×${n}`).join("\n") || "nothing blocked yet" : "";
  return (
    <div data-testid="wp-tab" data-sid={sid ?? ""} data-url={hist.list[hist.i]} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div data-testid="wp-bar" className="fs-row" style={{ gap: 4, padding: "3px 6px", flexWrap: "wrap", borderBottom: "1px solid var(--fs-border)", fontSize: fz(11) }}>
        <Btn variant="ghost" data-testid="wp-back" aria-label="Back" disabled={hist.i <= 0} onClick={back}>‹ Back</Btn>
        <Btn variant="ghost" data-testid="wp-forward" aria-label="Forward" disabled={hist.i >= hist.list.length - 1} onClick={fwd}>Forward ›</Btn>
        <Btn variant="ghost" data-testid="wp-reload" aria-label="Reload" onClick={reload}>Reload</Btn>
        <input className="fs-input" data-testid="wp-find" aria-label="Find in page" placeholder="Find in page" title="Case-insensitive search in this proxied document; Enter = next, Shift+Enter = previous. Shadow DOM and nested frames are not searched." maxLength={256} value={q} style={{ width: fz(150) }}
          onChange={(e) => { queryRef.current = e.target.value; setQ(e.target.value); setFound(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); send({ fusionWp: "find", q, dir: e.shiftKey ? -1 : 1 }); } }} />
        <span data-testid="wp-find-count" className="fs-dim" aria-live="polite" title={found?.truncated ? "The 512 KiB / 50,000-node safety limit was reached; counts cover only the scanned document prefix." : "Matches in the current proxied document."}>
          {found ? (found.n ? `${found.i}/${found.n}${found.truncated ? "+ · partial scan" : ""}` : found.truncated ? "no matches · partial scan" : "no matches") : ""}
        </span>
        <label className="fs-row" style={{ gap: 3 }}>Identity
          <select className="fs-input" data-testid="wp-ua" data-site={currentSite} data-effective={ua} aria-label="Identity sent to this site" value={uaChoice}
            title={`Desktop is the per-site default; overrides stay in this proxy session's memory for ${currentSite || "this site"}.`}
            onChange={async (e) => {
              const choice = e.target.value as UaChoice;
              if (!currentSite) return;
              const result = await patch(choice === "default" ? { site: currentSite, clearSiteUa: true } : { site: currentSite, ua: choice });
              if (result) { setUa(result.ua ?? "desktop"); setUaChoice(result.uaOverride ?? "default"); reload(); }
            }}>
            <option value="default">Default · Desktop</option><option value="desktop">Desktop override</option><option value="mobile">Mobile override</option>
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
        <Btn variant="ghost" data-testid="wp-save" disabled={!!savePhase} title="Save original bytes to the Fusion server's /Downloads, not /Private; 8 MiB maximum." onClick={() => void save()}>Save to Files</Btn>
        {savePhase === "fetching" ? <Btn variant="ghost" data-testid="wp-save-cancel" onClick={() => transfer.current?.abort()}>Cancel download</Btn> : null}
        {savedPath ? <Btn variant="ghost" data-testid="wp-open-downloads" onClick={() => shell.open("files", { path: "/Downloads" })}>Open Downloads</Btn> : null}
        <span className="fs-dim" title="Requests go through Fusion; proxy sessions and cookies live in memory. Save to Files deliberately writes to server storage." data-testid="wp-via">Private proxy{via ? ` via ${via}` : ""}{title ? ` · ${title.slice(0, 60)}` : ""}</span>
      </div>
      <div className="fs-dim" style={{ fontSize: fz(10.5), padding: "2px 8px" }}>Save to Files copies the original bytes to the Fusion server’s unencrypted /Downloads (up to 8 MiB), not /Private. Page-initiated browser downloads remain in the browser’s own downloads.</div>
      {note ? <div role="status" data-testid="wp-note" data-phase={savePhase ?? "idle"} className="fs-dim" style={{ fontSize: fz(11), padding: "2px 8px" }}>{note}</div> : null}
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
