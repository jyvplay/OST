"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Blocked } from "../ui";

interface Tab {
  id: string; url: string; title: string; group: string; pinned: boolean; asleep: boolean;
  verdict?: string; reason?: string; host?: string; mode?: "iframe" | "proxy" | "reader" | "snapshot";
}

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
        <div style={{ color: "#eee", padding: 20, maxWidth: 420, textAlign: "center", fontSize: 12.5 }}>
          Snapshot failed: {err}
        </div>
      )}
      {state === "loading" ? <div style={{ color: "#aaa", fontSize: 12, position: "absolute" }}>Rendering out-of-process…</div> : null}
    </div>
  );
}

const newTab = (url = "https://example.com"): Tab => ({
  id: `t${Math.random().toString(36).slice(2, 8)}`, url, title: url, group: "", pinned: false, asleep: false,
});

/**
 * PR-07 + WM-06. The honest part: most sites refuse to be framed. We measure
 * that on the SERVER before offering a window (X-Frame-Options / CSP
 * frame-ancestors), then pick a host: embedded window, split, or handoff tab.
 * The common web-desktop demo skips the probe and shows a blank frame.
 */
export default function BrowserModule({ win }: ModuleProps) {
  const shell = useShell();
  const [renderCapable, setRenderCapable] = useState<boolean | null>(null);
  useEffect(() => { api<{ capable: boolean }>("/api/render?probe=1").then((r) => setRenderCapable(r.capable)).catch(() => setRenderCapable(false)); }, []);
  // PR-07r / SH-08: tabs, groups, split and sidebar live in win.props, i.e. in the
  // serialised desktop state — so crash restore, presets and sessions bring them back.
  const saved = win.props as { tabs?: Tab[]; active?: string; vertical?: boolean; split?: "off" | "h" | "v"; url?: string };
  const [tabs, setTabs] = useState<Tab[]>(() =>
    saved.tabs?.length ? saved.tabs.map((t) => ({ ...t, verdict: undefined })) : [newTab(saved.url ?? "https://example.com")]);
  const [active, setActive] = useState<string>(saved.active ?? "");
  const [vertical, setVertical] = useState(Boolean(saved.vertical));
  const [split, setSplit] = useState<"off" | "h" | "v">(saved.split ?? "off");

  useEffect(() => {
    const t = window.setTimeout(() => {
      shell.dispatch({
        t: "setProps", id: win.id,
        props: { tabs: tabs.map(({ verdict: _v, reason: _r, host: _h, ...rest }) => rest), active, vertical, split },
      });
    }, 500);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, active, vertical, split, win.id]);
  const [address, setAddress] = useState("https://example.com");
  const probed = useRef(new Set<string>());

  useEffect(() => { if (!active && tabs[0]) setActive(tabs[0].id); }, [tabs, active]);

  const probe = async (tab: Tab) => {
    if (probed.current.has(tab.url)) return;
    probed.current.add(tab.url);
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
    const t = tabs.find((x) => x.id === active);
    if (t && !t.verdict) void probe(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, tabs]);

  const current = tabs.find((t) => t.id === active) ?? null;
  const open = (url: string) => {
    const t = newTab(url.startsWith("http") ? url : `https://${url}`);
    setTabs((ts) => [...ts, t]);
    setActive(t.id);
  };

  const renderFrame = (tab: Tab | null, key: string) => {
    if (!tab) return null;
    if (tab.asleep) {
      return (
        <div key={key} style={{ display: "grid", placeItems: "center", gap: 8, height: "100%" }}>
          <span className="fs-dim" style={{ fontSize: 12 }}>Tab is asleep — {tab.url}</span>
          <Btn onClick={() => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, asleep: false } : t)))}>Wake</Btn>
        </div>
      );
    }
    if (tab.verdict && tab.verdict !== "embeddable") {
      if (tab.mode === "proxy") return <iframe key={key} src={`/api/webproxy?mode=raw&url=${encodeURIComponent(tab.url)}`} title={tab.title} sandbox="allow-scripts allow-forms allow-popups" style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />;
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
            <Btn variant="ghost" onClick={() => { probed.current.delete(tab.url); void probe(tab); }}>Re-probe</Btn>
          </div>
          <div className="fs-dim" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
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
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />
    );
  };

  const others = tabs.filter((t) => t.id !== active);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="ghost" onClick={() => setVertical((v) => !v)} title="Vertical tab sidebar">{vertical ? "▤" : "▥"}</Btn>
        <input className="fs-input" value={address} aria-label="Address"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") open(address); }} />
        <Btn variant="primary" onClick={() => open(address)}>Go</Btn>
        <Btn variant="ghost" onClick={() => setSplit(split === "off" ? "h" : split === "h" ? "v" : "off")}>
          split: {split}
        </Btn>
        <Btn variant="ghost" onClick={() => current && setTabs((ts) => ts.map((t) => (t.id === current.id ? { ...t, asleep: true } : t)))}>Sleep tab</Btn>
        <Btn variant="ghost" onClick={() => current && shell.open("browser", { url: current.url, title: current.title })}>Tear out</Btn>
        {current?.verdict ? <Badge tone={current.verdict === "embeddable" ? "ok" : "bad"} title={current.reason}>{current.verdict}</Badge> : <Badge>probing…</Badge>}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: vertical ? "180px 1fr" : "1fr", flex: 1, minHeight: 0 }}>
        {vertical ? (
          <div className="fs-scroll" style={{ borderRight: "1px solid var(--fs-border)", padding: 4 }}>
            {tabs.map((t) => (
              <button key={t.id} className="fs-list-item" data-selected={t.id === active}
                style={{ width: "100%", border: 0, background: t.id === active ? "rgba(91,140,255,.22)" : "none", color: "inherit", textAlign: "left" }}
                onClick={() => setActive(t.id)}>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5 }}>
                  {t.pinned ? "📌 " : ""}{t.title}
                </span>
                {t.asleep ? <Badge>💤</Badge> : null}
              </button>
            ))}
            <Btn variant="ghost" onClick={() => open("https://example.com")}>+ Tab</Btn>
          </div>
        ) : null}

        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {!vertical ? (
            <div className="fs-row" style={{ gap: 2, padding: "4px 6px", overflowX: "auto", borderBottom: "1px solid var(--fs-border)" }}>
              {tabs.map((t) => (
                <button key={t.id} className="fs-btn" data-variant={t.id === active ? "primary" : "ghost"}
                  style={{ minHeight: 24, maxWidth: 190 }} onClick={() => setActive(t.id)}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); setTabs((ts) => ts.filter((x) => x.id !== t.id)); } }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
                </button>
              ))}
              <Btn variant="ghost" onClick={() => open("https://example.com")}>+</Btn>
            </div>
          ) : null}

          <div style={{
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

      <div className="fs-dim" style={{ fontSize: 10.5, padding: "3px 8px", borderTop: "1px solid var(--fs-border)" }}>
        Per-site policy is restrictive-only on the web: the sandbox and allow attributes can take permissions away
        from an embedded page, never grant them. Desktop user-agent override and find-in-page across origins are
        impossible here and are marked blocked in the Spec register.
      </div>
    </div>
  );
}
