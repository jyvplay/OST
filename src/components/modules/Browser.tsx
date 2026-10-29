"use client";
import OrbitTarget from "../OrbitTarget";
import { UiGlyph } from "../AppIcon";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Blocked, Hint } from "../ui";
import ProxyFrame from "./ProxyFrame";
import { exportSession, parseBrowserImport } from "@/lib/browser-io";
import NetworkRoute, { useRoute } from "./NetworkRoute";
import {
  PERMISSION_FEATURES, activate, allowAttribute, batchClose, closeTab, createGroup, hostOf, makeTab, normalizeSession, removeGroup,
  safeBrowserUrl, setGroup, sleepInactive, sleepTab, toggleCollapse, togglePin, visibleTabs, type Session, type Tab,
} from "@/lib/browserSession";

/** Mechanism B4: out-of-process render, shown as a static image (no interaction — declared limit). */
function RenderSnapshot({ url }: { url: string }) {
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [err, setErr] = useState("");
  const src = `/api/render?url=${encodeURIComponent(url)}`;
  return (
    <div style={{ height: "100%", overflow: "auto", background: "#222", display: "grid", placeItems: state === "ok" ? "start center" : "center" }}>
      {state !== "error" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`Snapshot of ${url}`} style={{ maxWidth: "100%" }}
          onLoad={() => setState("ok")}
          onError={async () => { setState("error"); try { const r = await fetch(src); setErr((await r.json()).error ?? "render failed"); } catch { setErr("render failed"); } }} />
      ) : (
        <div style={{ color: "#eee", padding: 20, maxWidth: 420, textAlign: "center", fontSize: fz(12.5) }}>
          Snapshot failed: {err}
        </div>
      )}
      {state === "loading" ? <div style={{ color: "#aaa", fontSize: fz(12), position: "absolute" }}>Rendering out-of-process…</div> : null}
    </div>
  );
}


/**
 * PR-07 + WM-06. The honest part: most sites refuse to be framed. We measure
 * that on the SERVER before offering a window (X-Frame-Options / CSP
 * frame-ancestors), then pick a host: embedded window, split, or handoff tab.
 * The common web-desktop demo skips the probe and shows a blank frame.
 */
/** Inline SVG glyphs — emoji fonts are not guaranteed on every OS (visual inspection showed tofu in TT16). */
function PinIcon() {
  return <svg role="img" aria-label="pinned" width="11" height="11" viewBox="0 0 16 16" style={{ display: "inline-block", marginRight: 4, verticalAlign: "-1px", flex: "none" }}><title>pinned</title><path d="M6 1h4l-.5 5 2.5 2.5v1.5H4V8.5L6.5 6z M7.4 10h1.2L8 15.5z" fill="currentColor" /></svg>;
}
function SleepIcon() {
  return <svg role="img" aria-label="asleep" width="11" height="11" viewBox="0 0 16 16" style={{ display: "inline-block", marginRight: 4, verticalAlign: "-1px", flex: "none", opacity: 0.75 }}><title>asleep</title><path d="M11.5 10.5A6 6 0 0 1 5.5 2a6.5 6.5 0 1 0 8.5 8 6 6 0 0 1-2.5.5z" fill="currentColor" /></svg>;
}

export default function BrowserModule({ win, onPageChange, embeddedRecall=false }: ModuleProps & {onPageChange?:(url:string,title:string)=>void;embeddedRecall?:boolean}) {
  const shell = useShell();
  const [tools,setTools]=useState(!embeddedRecall);
  const [renderCapable, setRenderCapable] = useState<boolean | null>(null);
  useEffect(() => { api<{ capable: boolean }>("/api/render?probe=1").then((r) => setRenderCapable(r.capable)).catch(() => setRenderCapable(false)); }, []);
  // PR-07r / SH-08: tabs, groups, split and sidebar live in win.props, i.e. in the
  // serialised desktop state — so crash restore, presets and sessions bring them back.
  const saved = win.props as { tabs?: Tab[]; active?: string; vertical?: boolean; split?: "off" | "h" | "v"; url?: string; groups?: unknown; perms?: unknown; proxyAll?: boolean };
  // Saved sessions are untrusted input (presets, imported bundles): normalised + URL-guarded on restore (TT16).
  const [boot] = useState(() => normalizeSession(saved, typeof window === "undefined" ? undefined : window.location.origin, saved.url));
  const [sess, setSess] = useState<Session>(() => ({ tabs: boot.tabs, active: boot.active, groups: boot.groups, perms: boot.perms }));
  const [notice, setNotice] = useState(boot.dropped ? `${boot.dropped} saved tab(s) dropped: unsafe or invalid URL` : "");
  const [query, setQuery] = useState("");
  const [showPerms, setShowPerms] = useState(false);
  const [showRoute, setShowRoute] = useState(false);
  const [route, setRoute] = useRoute();
  const tabs = sess.tabs, active = sess.active;
  const setTabs = (f: (ts: Tab[]) => Tab[]) => setSess((s) => ({ ...s, tabs: f(s.tabs) }));
  const setActive = (id: string) => setSess((s) => activate(s, id));
  const [vertical, setVertical] = useState(Boolean(saved.vertical));
  const [split, setSplit] = useState<"off" | "h" | "v">(saved.split ?? "off");
  // TT35 (WP-05): proxied tabs. Session ids live in RAM per tab (never saved with the desktop); "all tabs" routes every
  // tab through the private proxy, so no site ever sees the user's address and trackers are blocked everywhere.
  const [proxyAll, setProxyAll] = useState(Boolean(saved.proxyAll));
  const [proxySessions] = useState(() => new Map<string, string>());
  // a session lives while some tab uses its key: the tab id, or "p:<profile>" for tabs sharing a named profile
  const sessionKeys = tabs.map((t) => (t.profile ? `p:${t.profile}` : t.id)).join(",");
  const profileNames = [...new Set(tabs.map((t) => t.profile ?? "").filter(Boolean))];
  useEffect(() => {
    const live = new Set(sessionKeys.split(","));
    for (const [key, sid] of proxySessions) if (!live.has(key)) { proxySessions.delete(key); void fetch(`/api/wp-session?sid=${encodeURIComponent(sid)}`, { method: "DELETE" }).catch(() => {}); }
  }, [sessionKeys, proxySessions]);
  useEffect(() => () => { for (const sid of proxySessions.values()) void fetch(`/api/wp-session?sid=${encodeURIComponent(sid)}`, { method: "DELETE", keepalive: true }).catch(() => {}); proxySessions.clear(); }, [proxySessions]);

  useEffect(() => {
    const persist=()=>{
      shell.dispatch({
        t: "setProps", id: win.id,
        props: { tabs: tabs.map(({ verdict: _v, reason: _r, host: _h, ...rest }) => rest), active, vertical, split, groups: sess.groups, perms: sess.perms, proxyAll },
      });
    };
    if(embeddedRecall){persist();return;}
    const t=window.setTimeout(persist,500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, active, vertical, split, sess.groups, sess.perms, win.id, proxyAll,embeddedRecall]);
  // The omnibox opens new tabs (existing behaviour) but, like a desktop browser, shows the active tab's URL.
  const [address, setAddress] = useState(() => tabs.find((t) => t.id === active)?.url ?? "https://example.com");
  const [addressFor, setAddressFor] = useState(active);
  if (addressFor !== active) { setAddressFor(active); setAddress(tabs.find((t) => t.id === active)?.url ?? address); }
  const [probed] = useState(() => new Set<string>());


  const probe = async (tab: Tab) => {
    if (probed.has(tab.url)) return;
    probed.add(tab.url);
    try {
      const r = await api<{ verdict: string; reason: string; host: string; url: string }>(
        `/api/embed-probe?url=${encodeURIComponent(tab.url)}`,
      );
      setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, verdict: r.verdict, reason: r.reason, host: r.host, url: r.url, title: new URL(r.url).host } : t)));
    } catch {
      setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, verdict: "unknown", reason: "probe failed", host: "S3-handoff" } : t)));
    }
  };

  useEffect(() => {
    if(proxyAll)return;
    const t = tabs.find((x) => x.id === active);
    if (!t || t.verdict || probed.has(t.url)) return;
    probed.add(t.url);
    // State changes only in the network completion callbacks, not synchronously in the effect.
    api<{ verdict: string; reason: string; host: string; url: string }>(`/api/embed-probe?url=${encodeURIComponent(t.url)}`)
      .then(r => setTabs(ts => ts.map(x => x.id === t.id ? { ...x, verdict: r.verdict, reason: r.reason, host: r.host, url: r.url, title: new URL(r.url).host } : x)))
      .catch(() => setTabs(ts => ts.map(x => x.id === t.id ? { ...x, verdict: "unknown", reason: "probe failed", host: "S3-handoff" } : x)));
    // tabs are immutable; the lifetime cache deduplicates requests across active changes.
  }, [active, tabs, probed, proxyAll]);


  const current = tabs.find((t) => t.id === active) ?? null;
  useEffect(()=>{if(current)onPageChange?.(current.url,current.title);},[current,onPageChange]);
  const open = (input: string) => {
    const url = safeBrowserUrl(input, window.location.origin);
    if (!url) { setNotice(`Refused "${input.slice(0, 80)}": only absolute http(s) URLs without user:password@, and never this shell's own origin`); return; }
    if (sess.tabs.length >= 100) { setNotice("Tab limit (100) reached — close or sleep tabs first"); return; }
    const t = makeTab(url);
    setSess((s) => ({ ...s, tabs: [...s.tabs, t], active: t.id }));
    setNotice("");
  };
  const splitPartner = split !== "off" ? (tabs.find((t) => t.id !== active)?.id ?? null) : null;
  const runBatch = (target: "others" | "right" | "duplicates") => {
    if (!current) return;
    const r = batchClose(sess, current.id, target); setSess(r.session); setNotice(`closed ${r.closed} tab(s)${target === "others" ? " (pinned kept)" : ""}`);
  };
  const tabActions = (tab: Tab) => [
    { label: "Activate tab", run: () => setActive(tab.id) },
    { label: tab.pinned ? "Unpin tab" : "Pin tab", run: () => setSess(s => togglePin(s, tab.id)) },
    { label: "Duplicate URL in new tab", disabled: tabs.length >= 100, run: () => setSess(s => {
      if (s.tabs.length >= 100 || !s.tabs.some(t => t.id === tab.id)) return s;
      const copy = { ...makeTab(tab.url), mode: tab.mode, profile: tab.profile };
      return { ...s, tabs: [...s.tabs, copy], active: copy.id };
    }) },
    { label: "Sleep tab", disabled: tab.pinned || tab.id === active || tab.id === splitPartner || tab.asleep, run: () => setSess(s => sleepTab(s, tab.id, splitPartner)) },
    { label: "Copy tab URL", run: () => shell.copy(tab.url, "browser") },
    { label: "Close other unpinned tabs", run: () => setSess(s => batchClose(s, tab.id, "others").session) },
    { label: "Close tabs to the right (keep pinned)", run: () => setSess(s => batchClose(s, tab.id, "right").session) },
    { label: "Close this tab", run: () => setSess(s => closeTab(s, tab.id)) },
  ];
  const onKey = (e: React.KeyboardEvent) => {
    // PR-07i: non-reserved chords only. Ctrl+T/W/N/Tab belong to the host browser and cannot be captured by a page.
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const k = e.key.toLowerCase();
    if (k === "t") { e.preventDefault(); open("https://example.com"); }
    else if (k === "w" && current) { e.preventDefault(); setSess((s) => closeTab(s, current.id)); }
    else if (k === "p" && current) { e.preventDefault(); setSess((s) => togglePin(s, current.id)); }
    else if (/^[1-9]$/.test(k)) { const list = visibleTabs(sess); const t = k === "9" ? list[list.length - 1] : list[Number(k) - 1]; if (t) { e.preventDefault(); setActive(t.id); } }
  };

  const proxied = (tab: Tab, key: string) => (
    <ProxyFrame key={`${key}:${tab.id}:${tab.profile ?? ""}`} tabId={tab.id} url={tab.url} sessions={proxySessions}
      embeddedRecall={embeddedRecall} profile={tab.profile ?? ""} profiles={profileNames} circuitable={route?.mode === "socks5"} via={route && route.mode !== "direct" ? route.label : ""}
      onProfile={(p) => setTabs((ts) => ts.map((x) => (x.id === tab.id ? { ...x, profile: p || undefined } : x)))}
      onNav={(u, t) => { setTabs((ts) => ts.map((x) => (x.id === tab.id ? { ...x, url: u, title: t || new URL(u).host } : x))); if (tab.id === active) setAddress(u); }} />
  );
  const renderFrame = (tab: Tab | null, key: string) => {
    if (!tab) return null;
    if (tab.asleep) {
      return (
        <div key={key} style={{ display: "grid", placeItems: "center", gap: 8, height: "100%" }}>
          <span className="fs-dim" style={{ fontSize: fz(12) }}>Tab is asleep — {tab.url}</span>
          <Btn onClick={() => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, asleep: false } : t)))}>Wake</Btn>
        </div>
      );
    }
    if (proxyAll && !tab.asleep) return proxied(tab, key);
    if (tab.verdict && tab.verdict !== "embeddable") {
      if (tab.mode === "proxy") return proxied(tab, key);
      if (tab.mode === "reader") return <iframe key={key} src={`/api/webproxy?mode=reader&url=${encodeURIComponent(tab.url)}`} title={tab.title} sandbox="" style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />;
      if (tab.mode === "snapshot") return <RenderSnapshot key={key} url={tab.url} />;
      return (
        <div key={key} style={{ padding: 12, display: "grid", gap: 10, alignContent: "start" }}>
          <Blocked
            what={`${tab.url} refuses to be embedded`}
            missing={tab.reason ?? "framing policy"}
            workaround="Three mechanism-distinct alternatives below, each with its own declared limits (see Spec → WM-06 / CA-16)."
          />
          <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
            <Btn variant="primary" onClick={() => window.open(tab.url, "_blank", "noopener")}>Open in a tab (handoff)</Btn>
            <Btn variant="ghost" title="Fetched server-side and re-served from our own origin, so the browser never sees the target's framing headers. Breaks logged-in content and client-side XHR back to the real origin." onClick={() => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, mode: "proxy" } : t)))}>Same-origin proxy</Btn>
            <Btn variant="ghost" title="Readability-style extraction: article text/images only, no scripts, works even for sites the proxy can't execute." onClick={() => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, mode: "reader" } : t)))}>Reader mode</Btn>
            <Btn variant="ghost" disabled={renderCapable === false} title={renderCapable === false ? "Server-side rendering is unavailable in this deployment (checked via /api/render?probe=1)" : "A real screenshot of the page, rendered out-of-process on the server. No interaction — you are viewing a picture, not the live page."}
              onClick={() => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, mode: "snapshot" } : t)))}>Snapshot {renderCapable === null ? "(checking…)" : renderCapable === false ? "(unavailable here)" : ""}</Btn>
            <Btn variant="ghost" onClick={() => { probed.delete(tab.url); void probe(tab); }}>Re-probe</Btn>
          </div>
          <div className="fs-dim" style={{ fontSize: fz(11.5), lineHeight: 1.6 }}>
            This is a platform rule, not an app bug: a page that sends
            <span className="fs-mono"> X-Frame-Options: DENY</span> or a restrictive
            <span className="fs-mono"> CSP frame-ancestors</span> cannot be displayed inside another origin by any
            web application via a plain iframe. The three buttons above are genuinely different mechanisms (same-
            origin proxy / content extraction / out-of-process render), not three names for the same workaround —
            each has a different, declared failure mode.
          </div>
        </div>
      );
    }
    return (
      <iframe key={key} src={tab.url} title={tab.title}
        allow={allowAttribute(sess.perms, tab.url)}
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />
    );
  };

  const others = tabs.filter((t) => t.id !== active);
  const shown = visibleTabs(sess, vertical ? query : "");
  const groupOf = (t: Tab) => sess.groups.find((g) => g.id === t.group);
  const curHost = current ? hostOf(current.url) : "";
  const curPerms = sess.perms[curHost] ?? [];

  return (
    <div data-testid="browser" data-tabs={tabs.length} data-active={active} data-pinned={tabs.filter((t) => t.pinned).map((t) => t.id).join(",")} onKeyDown={onKey}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        {tools?<Btn variant="ghost" onClick={() => setVertical((v) => !v)} aria-label="Vertical tab sidebar" title="Vertical tab sidebar" aria-pressed={vertical}><UiGlyph name={vertical ? "tabstrip" : "sidebar"} /></Btn>:null}
        <input className="fs-input" value={address} aria-label="Address" style={embeddedRecall?{flex:"1 1 240px",minWidth:0,width:"auto"}:undefined}
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") open(address); }} />
        <Btn variant="primary" onClick={() => open(address)}>Go</Btn>
        {!embeddedRecall?<Btn aria-label="Recall media" title="Recall media" onClick={() => shell.open("recall", {url: current?.url ?? address, pageTitle: current?.title ?? ""})}><UiGlyph name="snapshot"/></Btn>:null}
        {embeddedRecall?<Btn aria-label="Browser tools" title="Browser tools" aria-expanded={tools} onClick={()=>{setTools(v=>!v);setShowPerms(false);setShowRoute(false);}}><UiGlyph name="sliders"/> Tools</Btn>:null}
        <div style={{display:tools?'contents':'none'}}>
        <Btn variant="ghost" aria-label={`Split view: ${split === "off" ? "off" : split === "h" ? "side by side" : "stacked"}`}
          title={`Split view: ${split === "off" ? "off" : split === "h" ? "side by side" : "stacked"} — click to cycle`}
          onClick={() => setSplit(split === "off" ? "h" : split === "h" ? "v" : "off")}>
          <UiGlyph name={split === "v" ? "splitV" : "splitH"} />{split === "off" ? null : <span style={{ marginLeft: 5, opacity: .8 }}>{split === "h" ? "⇔" : "⇕"}</span>}
        </Btn>
        <Btn variant="ghost" title="Sleep other tabs — discard the frames of every tab that is not visible (pinned tabs stay awake)" onClick={() => { const r = sleepInactive(sess, splitPartner); setSess(r.session); setNotice(`${r.slept} tab(s) put to sleep`); }} aria-label="Sleep other tabs"><UiGlyph name="sleep" /></Btn>
        <Btn variant="ghost" aria-label="Tear out" title="Open this tab in a window of its own" onClick={() => current && shell.open("browser", { url: current.url, title: current.title })}><UiGlyph name="tearout" /></Btn>
        <Btn variant="ghost" aria-label={current?.pinned ? "Unpin tab" : "Pin tab"} title={current?.pinned ? "Unpin tab" : "Pin tab"} onClick={() => current && setSess((s) => togglePin(s, current.id))}><PinIcon /></Btn>
        <select className="fs-input" aria-label="Tab group" style={{ width: fz(120) }} value={current?.group ?? ""}
          onChange={(e) => { if (!current) return; const v = e.target.value; setSess((s) => (v === "+" ? createGroup(s, current.id, `Group ${s.groups.length + 1}`) : setGroup(s, current.id, v))); }}>
          <option value="">No group</option>{sess.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}<option value="+">+ New group</option>
        </select>
        <Btn variant="ghost" onClick={() => runBatch("others")} aria-label="Close others" title="Close others"><UiGlyph name="closeset" /></Btn>
        <Btn variant="ghost" onClick={() => runBatch("right")} aria-label="Close to the right" title="Close to the right"><UiGlyph name="closeset" /></Btn>
        <Btn variant="ghost" onClick={() => runBatch("duplicates")} aria-label="Close duplicates" title="Close duplicates"><UiGlyph name="copy" /></Btn>
        <Btn variant="ghost" aria-pressed={showPerms} onClick={() => setShowPerms((v) => !v)} aria-label="Site permissions" title="Site permissions"><UiGlyph name="shield" /></Btn>
        <Btn variant="ghost" aria-label="Export browser session" title="Export tabs and groups as JSON (no proxy session ids)" onClick={() => {
          const url = URL.createObjectURL(new Blob([exportSession(tabs, sess.groups)], { type: "application/json" }));
          const a = document.createElement("a"); a.href = url; a.download = "browser-session.json"; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }}><UiGlyph name="export" /></Btn>
        <label className="fs-btn" data-variant="ghost" title="Import browser session — import tabs and groups from a Fusion session export; unsafe addresses are dropped and reported" style={{ cursor: "pointer", display: "inline-flex", alignItems: "center" }}><UiGlyph name="download" />
          <input type="file" accept=".json,application/json" hidden aria-label="Import browser session" onChange={async (e) => {
            const f = e.target.files?.[0]; e.target.value = ""; if (!f) return;
            try {
              const r = parseBrowserImport(await f.text(), window.location.origin);
              setSess((prev) => ({ ...prev, tabs: [...prev.tabs, ...r.tabs], groups: [...prev.groups, ...r.groups.filter((g) => !prev.groups.some((x) => x.id === g.id))] }));
              setNotice(`Imported ${r.tabs.length} tab(s)${r.dropped ? `; ${r.dropped} unsafe address(es) dropped` : ""}`);
            } catch (err) { setNotice(`Import refused: ${String((err as Error).message)}`); }
          }} />
        </label>
        <Btn variant="ghost" data-testid="br-proxy-all" aria-pressed={proxyAll} title="Route every tab through Fusion's private proxy: sites never see your address, trackers are blocked, cookies stay in memory per tab, and find in page / desktop-or-mobile identity / Save to Files work on every site" aria-label={`Private proxy: ${proxyAll ? "all tabs" : "off"}`} onClick={() => setProxyAll((v) => !v)}><UiGlyph name="shield"/> {proxyAll ? "all tabs" : "off"}</Btn>
        <Btn variant="ghost" data-testid="br-route" aria-pressed={showRoute} aria-expanded={showRoute} title="Network route — how Fusion's server reaches the web for Private proxy tabs: directly, through Tor, or through another proxy" aria-label={`Network route: ${route?.label ?? "unknown"}`} onClick={() => setShowRoute((v) => !v)}><UiGlyph name="link" /> {route?.label ?? "…"}</Btn>
        {current?.verdict ? <Badge tone={current.verdict === "embeddable" ? "ok" : "bad"} title={current.reason}>{current.verdict}</Badge> : <Badge>{proxyAll?"private proxy":"probing…"}</Badge>}
        </div>
      </div>

      {notice ? <div data-testid="browser-notice" className="fs-dim" style={{ fontSize: fz(11), padding: "3px 8px", borderBottom: "1px solid var(--fs-border)" }}>{notice}</div> : null}
      {showRoute ? <NetworkRoute route={route} onRoute={setRoute} /> : null}
      {showPerms && current ? (
        <div data-testid="site-perms" className="fs-row" style={{ gap: 10, flexWrap: "wrap", padding: "4px 8px", fontSize: fz(11), borderBottom: "1px solid var(--fs-border)" }}>
          <b>{curHost}</b>
          {PERMISSION_FEATURES.map((f) => (
            <label key={f} className="fs-row" style={{ gap: 3 }}>
              <input type="checkbox" aria-label={`Delegate ${f} to ${curHost}`} checked={curPerms.includes(f)}
                onChange={(e) => setSess((s) => ({ ...s, perms: { ...s.perms, [curHost]: e.target.checked ? [...curPerms, f] : curPerms.filter((x) => x !== f) } }))} />{f}
            </label>
          ))}
          <span className="fs-dim">{"Delegation only: an embedded site can use a feature only if this shell itself has it; unchecked = explicitly 'none'."}</span>
        </div>
      ) : null}
      <div style={{ display: "grid", gridTemplateColumns: vertical ? "180px 1fr" : "1fr", flex: 1, minHeight: 0 }}>
        {vertical ? (
          <div className="fs-scroll" style={{ borderRight: "1px solid var(--fs-border)", padding: 4 }}>
            <input className="fs-input" aria-label="Search tabs" placeholder="Search tabs" value={query} onChange={(e) => setQuery(e.target.value)} style={{ width: "100%", marginBottom: 4 }} />
            {sess.groups.map((g) => (
              <div key={g.id} className="fs-row" style={{ gap: 4, fontSize: fz(11), padding: "2px 4px", borderLeft: `3px solid ${g.color}` }}>
                <button className="fs-btn" data-variant="ghost" aria-label={`${g.collapsed ? "Expand" : "Collapse"} ${g.name}`} onClick={() => setSess((s) => toggleCollapse(s, g.id))}>{g.collapsed ? "+" : "−"}</button>
                <input className="fs-input" aria-label={`Group name ${g.id}`} value={g.name} style={{ flex: 1, minWidth: fz(0) }} onChange={(e) => setSess((s) => ({ ...s, groups: s.groups.map((x) => (x.id === g.id ? { ...x, name: e.target.value.slice(0, 60) } : x)) }))} />
                <button className="fs-btn" data-variant="ghost" aria-label={`Ungroup ${g.name}`} onClick={() => setSess((s) => removeGroup(s, g.id))}>×</button>
              </div>
            ))}
            {shown.map((t) => (
              <OrbitTarget key={t.id} label={`Tab: ${t.title}`} actions={tabActions(t)}>
              <button data-tab={t.id} className="fs-list-item" data-selected={t.id === active}
                style={{ width: "100%", border: 0, borderLeft: `3px solid ${groupOf(t)?.color ?? "transparent"}`, background: t.id === active ? "rgba(91,140,255,.22)" : "none", color: "inherit", textAlign: "left" }}
                onClick={() => setActive(t.id)}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fz(11.5) }}>
                  {t.pinned ? <PinIcon /> : null}{t.title}
                </span>
                {t.asleep ? <SleepIcon /> : null}
              </button>
              </OrbitTarget>
            ))}
            <Btn variant="ghost" onClick={() => open("https://example.com")}>+ Tab</Btn>
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {!vertical ? (
            <div className="fs-row" style={{ gap: 2, padding: "4px 6px", overflowX: "auto", borderBottom: "1px solid var(--fs-border)" }}>
              {shown.map((t) => (
                <OrbitTarget key={t.id} label={`Tab: ${t.title}`} actions={tabActions(t)}>
                <button className="fs-btn" data-variant={t.id === active ? "primary" : "ghost"} data-tab={t.id}
                  style={{ minHeight: 24, maxWidth: t.pinned ? 70 : 190, borderBottom: `3px solid ${groupOf(t)?.color ?? "transparent"}` }} onClick={() => setActive(t.id)}
                  title={`${t.title}${groupOf(t) ? ` · ${groupOf(t)!.name}` : ""}${t.profile ? ` · profile ${t.profile}` : ""} (middle-click closes)`}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); setSess((s) => closeTab(s, t.id)); } }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.pinned ? <PinIcon /> : null}{t.asleep ? <SleepIcon /> : null}{t.title}</span>
                  {t.profile ? <span data-tab-profile style={{ marginLeft: 6, flexShrink: 0, fontSize: "0.75em", lineHeight: 1.4, padding: "0 6px", borderRadius: 999, border: "1px solid currentColor", opacity: 0.85 }}>{t.profile}</span> : null}
                </button>
                </OrbitTarget>
              ))}
              <Btn variant="ghost" onClick={() => open("https://example.com")}>+</Btn>
            </div>
          ) : null}

          <div data-testid="br-frames" data-split={split} style={{
            flex: 1, minHeight: 0,
            display: "grid",
            gridTemplateColumns: split === "h" ? "1fr 1fr" : "1fr",
            gridTemplateRows: split === "v" ? "1fr 1fr" : "1fr",
          }}>
            {renderFrame(current, "main")}
            {split !== "off" ? renderFrame(others[0] ?? null, "second") : null}
          </div>
        </div>
      </div>

      <div style={{ padding: "1px 8px 3px", borderTop: "1px solid var(--fs-border)" }}>
        <Hint label="Proxy-only controls">
          Per-site policy is restrictive-only on the web: the sandbox and allow attributes can take permissions away
          from an embedded page, never grant them. For a directly embedded page, user-agent override and find in page
          are impossible; in a private-proxy tab both work, because the page then runs inside Fusion&apos;s own sandbox.
        </Hint>
      </div>
    </div>
  );
}
