"use client";

import { moduleById } from "@/lib/registry";
import { useShell } from "./shell-context";
import { Badge, Btn, Empty } from "./ui";

/** WM-04: live-node overview. No snapshots, so nothing can be stale. */
export default function Overview({ onClose }: { onClose: () => void }) {
  const shell = useShell();
  const wins = shell.state.windows;

  return (
    <div role="dialog" aria-label="Overview"
      style={{ position: "absolute", inset: 0, zIndex: 9400, background: "rgba(4,8,18,.72)", backdropFilter: "blur(6px)", padding: 16, overflow: "auto" }}
      onClick={onClose}>
      <div className="fs-row" style={{ justifyContent: "space-between", marginBottom: 12 }} onClick={(e) => e.stopPropagation()}>
        <strong>Overview</strong>
        <div className="fs-row">
          {shell.state.workspaces.map((ws) => (
            <Btn key={ws.id} variant={ws.id === shell.state.activeWorkspace ? "primary" : "ghost"}
              onClick={() => shell.dispatch({ t: "switchWorkspace", workspace: ws.id })}>
              {ws.name} <span className="fs-dim">{wins.filter((w) => w.workspace === ws.id).length}</span>
            </Btn>
          ))}
          <Btn variant="ghost" onClick={onClose}>✕</Btn>
        </div>
      </div>

      {wins.length === 0 ? <Empty title="No windows" hint="Open a module from the launcher or press Ctrl+Space." icon="🪟" /> : null}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 10 }} onClick={(e) => e.stopPropagation()}>
        {wins.map((w) => (
          <div key={w.id} className="fs-panel" style={{ padding: 8, display: "grid", gap: 6 }}>
            <div className="fs-row" style={{ justifyContent: "space-between" }}>
              <span className="fs-row" style={{ gap: 6 }}>{moduleById(w.module)?.icon}<strong style={{ fontSize: 12 }}>{w.title}</strong></span>
              {w.minimized ? <Badge>minimised</Badge> : null}
            </div>
            <div className="fs-dim fs-mono" style={{ fontSize: 10.5 }}>
              {Math.round(w.w)}×{Math.round(w.h)} @ {Math.round(w.x)},{Math.round(w.y)} · z{w.z} · {w.host}
            </div>
            <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
              <Btn variant="primary" onClick={() => { shell.dispatch({ t: "restore", id: w.id }); onClose(); }}>Show</Btn>
              {shell.state.workspaces.filter((ws) => ws.id !== w.workspace).map((ws) => (
                <Btn key={ws.id} variant="ghost" onClick={() => shell.dispatch({ t: "toWorkspace", id: w.id, workspace: ws.id })}>→ {ws.name}</Btn>
              ))}
              <Btn variant="danger" onClick={() => shell.dispatch({ t: "close", id: w.id })}>Close</Btn>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
