"use client";
import { fz } from "@/lib/uiscale";

import { moduleById } from "@/lib/registry";
import { useShell } from "./shell-context";
import { AppIcon } from "./AppIcon";

/** SH-02. Window previews are the live DOM scaled down, never rasterised. */
export default function Shelf() {
  const shell = useShell();
  const wins = shell.state.windows.filter((w) => w.workspace === shell.state.activeWorkspace);
  const pinned = ["files", "editor", "terminal", "find", "browser", "beam", "lens", "spec", "settings"];

  return (
    <footer className="fs-row" role="toolbar" aria-label="Shelf"
      style={{ height: fz(44), gap: fz(4), padding: "0 8px", borderTop: "1px solid var(--fs-border)", background: "var(--fs-panel)" }}>
      {pinned.map((id) => {
        const m = moduleById(id);
        const running = wins.some((w) => w.module === id);
        return (
          <button key={id} className="fs-btn" data-variant="ghost" title={`${m?.title} — ${m?.summary}`}
            onClick={() => {
              const existing = wins.find((w) => w.module === id);
              if (existing) shell.dispatch({ t: existing.minimized ? "restore" : "focus", id: existing.id });
              else shell.open(id);
            }}
            aria-label={m?.title} data-testid={`shelf-${id}`}
            style={{ position: "relative", minHeight: fz(32), padding: `0 ${fz(5)}` }}>
            <AppIcon id={id} size={24} />
            {running ? (
              <span style={{ position: "absolute", bottom: 1, left: "50%", transform: "translateX(-50%)", width: fz(10), height: fz(2), borderRadius: 4, background: "var(--fs-ok)" }} />
            ) : null}
          </button>
        );
      })}

      <div style={{ width: 1, height: fz(22), background: "var(--fs-border)" }} />

      <div className="fs-row" style={{ gap: 4, overflowX: "auto", flex: 1 }}>
        {wins.map((w) => (
          <button key={w.id} className="fs-btn"
            data-variant={shell.state.focus === w.id ? "primary" : "ghost"}
            onClick={() => shell.dispatch({ t: w.minimized ? "restore" : "focus", id: w.id })}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); shell.dispatch({ t: "close", id: w.id }); } }}
            title={`${w.title} — middle-click to close`}
            style={{ minHeight: fz(30), maxWidth: fz(190), opacity: w.minimized ? .6 : 1 }}>
            <AppIcon id={w.module} size={16} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.title}</span>
          </button>
        ))}
      </div>

      <span className="fs-dim" style={{ fontSize: fz(11) }}>
        {wins.length} window{wins.length === 1 ? "" : "s"} · rev {shell.state.revision}
      </span>
    </footer>
  );
}
