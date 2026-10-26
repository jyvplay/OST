"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { useShell } from "./shell-context";
import { Badge, Btn } from "./ui";
import { FusionLogo, UiGlyph } from "./AppIcon";
import { privacy, type PrivacyStatus } from "@/lib/privacy/session";

/**
 * SH-03. When the PWA is installed with display_override:["window-controls-overlay"]
 * this bar *is* the OS title bar, so its geometry must come from
 * env(titlebar-area-*) rather than assuming the full viewport width.
 */
export default function TopBar({ onLauncher, onPalette, onOverview, onQuick, onBlackout }: {
  onLauncher: () => void; onPalette: () => void; onOverview: () => void; onQuick: () => void; onBlackout: () => void;
}) {
  const shell = useShell();
  const [clock, setClock] = useState(() => new Date());
  const [wco, setWco] = useState(false);
  const [priv, setPriv] = useState<PrivacyStatus | null>(null);

  // TT18: amnesic / Persistent Storage state is always visible (Tails shows it in the top bar too)
  useEffect(() => privacy.subscribe((s) => setPriv(s)), []);

  useEffect(() => {
    const t = window.setInterval(() => setClock(new Date()), 10_000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    const nav = navigator as Navigator & { windowControlsOverlay?: { visible: boolean; addEventListener: (t: string, f: () => void) => void } };
    const w = nav.windowControlsOverlay;
    if (!w) return;
    const update = () => setWco(w.visible);
    update();
    w.addEventListener("geometrychange", update);
  }, []);

  const tone = shell.gov.state === "COOL" ? "ok" : shell.gov.state === "WARM" ? "info" : shell.gov.state === "HOT" ? "warn" : "bad";

  return (
    <header
      className="fs-row"
      role="banner"
      style={{
        height: fz(34), padding: "0 8px", gap: fz(5), borderBottom: "1px solid var(--fs-border)",
        background: "var(--fs-panel)", backdropFilter: "blur(14px)",
        WebkitAppRegion: wco ? "drag" : undefined,
        paddingLeft: wco ? "env(titlebar-area-x, 8px)" : 8,
        width: wco ? "env(titlebar-area-width, 100%)" : "100%",
      } as React.CSSProperties}
    >
      <button className="fs-btn" data-variant="primary" onClick={onLauncher} title="Launcher (Meta+A)"
        data-testid="launcher-button" aria-label="Fusion launcher"
        style={{ minHeight: fz(28), padding: `0 ${fz(8)} 0 ${fz(3)}`, gap: fz(5), borderRadius: 999, fontWeight: 800, letterSpacing: ".01em", background: "linear-gradient(180deg, var(--fs-pill-a, #ffe36e), var(--fs-pill-b, #ffb020))", color: "#14213d", ...( { WebkitAppRegion: "no-drag" } as React.CSSProperties) }}>
        <FusionLogo size={22} label="" /> Fusion
      </button>
      <Btn variant="ghost" onClick={onPalette} title="Command palette (Ctrl+Space)" aria-label="Search"><UiGlyph name="search" /><span className="fs-narrow-hide"> Search</span></Btn>
      <Btn variant="ghost" onClick={onOverview} title="Overview (Meta+Q)" aria-label="Overview"><UiGlyph name="overview" /><span className="fs-narrow-hide"> Overview</span></Btn>

      <div className="fs-row fs-narrow-hide" style={{ gap: 4, marginLeft: 6 }}>
        {shell.state.workspaces.map((ws) => (
          <button key={ws.id} className="fs-btn" data-variant={ws.id === shell.state.activeWorkspace ? "primary" : "ghost"}
            style={{ minHeight: fz(24), padding: `0 ${fz(8)}`, borderRadius: 999 }}
            onClick={() => shell.dispatch({ t: "switchWorkspace", workspace: ws.id })}
            title={`Workspace ${ws.name}`}>{ws.name}</button>
        ))}
      </div>

      <div style={{ flex: 1 }} />

      {shell.beam ? (
        <button className="fs-btn" data-variant="danger" onClick={() => shell.beam?.stop()}
          title="A cast session is live — click to stop (UX-23)">
          ⏹ Casting · {shell.beam.transport} → {shell.beam.target}
        </button>
      ) : null}

      {priv?.amnesic ? (
        <button className="fs-btn" data-variant="primary" data-testid="amnesic-badge" onClick={() => shell.open("privacy")}
          title={`Amnesic session: ${priv.ram.files} files in RAM, ${priv.blocked} host writes blocked — nothing new is written to this device`}>AMNESIC</button>
      ) : null}
      {priv && priv.storage === "unlocked" ? (
        <button className="fs-btn" data-variant="ghost" data-testid="storage-badge" onClick={() => { privacy.lock(); shell.bumpRefresh(); }}
          title="Persistent Storage is unlocked — click to lock now">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true" style={{ width: fz(12), height: fz(12), display: "inline-block", verticalAlign: "-1px", marginRight: 4 }}>
            <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 7.5-2" />
          </svg>Private unlocked</button>
      ) : null}
      <span className="fs-narrow-hide" style={{ display: "contents" }}><Badge tone={tone} title={shell.gov.reason}>{shell.gov.state} · {shell.gov.fps} fps</Badge></span>
      {shell.state.focusMode ? <Badge tone="info">focus</Badge> : null}
      <Btn variant="ghost" onClick={onBlackout} title="Blackout this screen (BlackTop)" aria-label="Blackout this screen"><UiGlyph name="contrast" /></Btn>
      <Btn variant="ghost" onClick={onQuick} title="Quick panel (Meta+I)" aria-label="Quick panel"><UiGlyph name="sliders" /></Btn>
      <span className="fs-mono fs-dim" style={{ fontSize: fz(11.5), padding: "0 4px", whiteSpace: "nowrap" }} suppressHydrationWarning>
        {clock.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    </header>
  );
}
