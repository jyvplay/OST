"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useRef, useState } from "react";
import { api, put } from "@/lib/api";
import { useShell } from "./shell-context";
import { Badge } from "./ui";
import { WorkerWidgetHost, type WidgetTree, type WidgetStatus } from "@/lib/widgetWorker";

interface Note { id: number; title: string; body: string; tags: string }

/**
 * SH-05 widget host + PR-13 sticky notes.
 *
 * User widgets are HTML files in /Widgets, rendered in iframes with
 * sandbox="allow-scripts" ONLY (no same-origin, no forms, no popups, no top
 * navigation). Liveness is a heartbeat script injected into the widget's own
 * main thread: if the widget's code spins, the heartbeat stops and after 2 s the
 * widget is greyed — the shell's frame rate is unaffected because cross-origin
 * sandboxed frames run out of process in site-isolated browsers.
 */
const HEARTBEAT = `<script>setInterval(function(){parent.postMessage({fusionWidget:"alive",id:WIDGET_ID},"*")},500)</script>`;

export default function DesktopWidgets() {
  const shell = useShell();
  const enabled = (shell.settings["shell.widgets"] ?? "clock,stickies,system,user").split(",");
  const [stickies, setStickies] = useState<Note[]>([]);
  const [userWidgets, setUserWidgets] = useState<{ name: string; html: string }[]>([]);
  const [workerWidgets, setWorkerWidgets] = useState<{ name: string; code: string }[]>([]);
  const [alive, setAlive] = useState<Record<string, number>>({});
  const [now, setNow] = useState(() => Date.now());
  const saveTimers = useRef<Record<number, number>>({});

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    if (enabled.includes("stickies")) {
      api<{ rows: Note[] }>("/api/notes").then((r) => setStickies(r.rows.filter((n) => n.tags.split(",").map((s) => s.trim()).includes("sticky")))).catch(() => undefined);
    }
    if (enabled.includes("user")) {
      (async () => {
        const list = await api<{ nodes: { path: string; name: string }[] }>("/api/fs?op=list&path=/Widgets");
        const out: { name: string; html: string }[] = [];
        for (const n of list.nodes.filter((x) => x.name.endsWith(".html")).slice(0, 4)) {
          const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(n.path)}`);
          out.push({ name: n.name, html: r.node.content });
        }
        setUserWidgets(out);
      })().catch(() => setUserWidgets([]));
    }
    // worker-isolated widgets (S1): safe by construction, so no opt-in gate needed —
    // the whole point of the mechanism is that it cannot freeze the shell.
    (async () => {
      const list = await api<{ nodes: { path: string; name: string }[] }>("/api/fs?op=list&path=/Widgets").catch(() => ({ nodes: [] }));
      const out: { name: string; code: string }[] = [];
      for (const n of list.nodes.filter((x) => x.name.endsWith(".worker.js")).slice(0, 6)) {
        const r = await api<{ node: { content: string } }>(`/api/fs?op=read&path=${encodeURIComponent(n.path)}`);
        out.push({ name: n.name, code: r.node.content });
      }
      setWorkerWidgets(out);
    })().catch(() => undefined);
  }, [shell.refreshTick, enabled.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as { fusionWidget?: string; id?: string };
      if (d?.fusionWidget === "alive" && d.id) setAlive((a) => ({ ...a, [d.id!]: Date.now() }));
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  return (
    <div className="fs-desk-widgets" style={{ position: "absolute", top: 10, right: 10, width: `min(${fz(230)}, 42vw)`, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 8, zIndex: 1 }}>
      {enabled.includes("clock") ? (
        <div className="fs-panel" style={{ padding: 10, textAlign: "center" }}>
          <div className="fs-mono" style={{ fontSize: fz(26) }} suppressHydrationWarning>{new Date(now).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
          <div className="fs-dim" style={{ fontSize: fz(11) }} suppressHydrationWarning>{new Date(now).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
        </div>
      ) : null}

      {enabled.includes("system") ? (
        <div className="fs-panel" style={{ padding: 8, display: "flex", gap: 4, flexWrap: "wrap" }}>
          <Badge tone={shell.gov.state === "COOL" ? "ok" : "warn"}>{shell.gov.state}</Badge>
          <Badge>{shell.gov.fps} fps</Badge>
          <Badge>{shell.state.windows.length} windows</Badge>
          {shell.gov.batteryLevel !== null ? <Badge>{Math.round(shell.gov.batteryLevel * 100)}%</Badge> : null}
        </div>
      ) : null}

      {enabled.includes("stickies") ? stickies.map((n) => (
        <div key={n.id} style={{ background: "#fff3a6", color: "#3b3200", borderRadius: 8, padding: 8, boxShadow: "0 6px 18px rgba(0,0,0,.35)" }}>
          <div style={{ fontWeight: 700, fontSize: fz(12) }}>{n.title}</div>
          <textarea defaultValue={n.body} aria-label={`Sticky note ${n.title}`}
            style={{ width: "100%", background: "transparent", border: 0, color: "inherit", fontSize: fz(12), resize: "vertical", minHeight: 50, fontFamily: "inherit" }}
            onChange={(e) => {
              const body = e.target.value;
              window.clearTimeout(saveTimers.current[n.id]);
              saveTimers.current[n.id] = window.setTimeout(() => void put("/api/notes", { id: n.id, body }), 800);
            }} />
        </div>
      )) : null}

      {workerWidgets.map((w) => <WorkerWidgetCard key={w.name} name={w.name} code={w.code} />)}

      {enabled.includes("user") ? userWidgets.map((w) => {
        const id = w.name.replace(/[^a-z0-9]/gi, "_");
        const ok = alive[id] && now - alive[id] < 2000;
        return (
          <div key={w.name} className="fs-panel" style={{ padding: 4, opacity: ok ? 1 : 0.45 }}>
            <div className="fs-row" style={{ justifyContent: "space-between", padding: "0 4px" }}>
              <span className="fs-dim" style={{ fontSize: fz(10.5) }} title="Measured: a hung widget is isolated only when the browser runs full site isolation (desktop Chrome default). Elsewhere it can freeze the shell.">{w.name} ⚠</span>
              <Badge tone={ok ? "ok" : "bad"}>{ok ? "live" : "not responding"}</Badge>
            </div>
            <iframe title={w.name} sandbox="allow-scripts"
              srcDoc={HEARTBEAT.replace("WIDGET_ID", JSON.stringify(id)) + w.html}
              style={{ width: "100%", height: 110, border: 0, borderRadius: 6, background: "transparent" }} />
          </div>
        );
      }) : null}
    </div>
  );
}

/** S1: ticks a worker-isolated widget every second; a hang shows "unresponsive"
 *  (never freezes the shell, verified in scripts/e2e.mts under DEFAULT Chromium,
 *  not just --site-per-process — that is the whole point of this mechanism). */
function WorkerWidgetCard({ name, code }: { name: string; code: string }) {
  const hostRef = useRef<WorkerWidgetHost | null>(null);
  const [tree, setTree] = useState<WidgetTree | null>(null);
  const [status, setStatus] = useState<WidgetStatus>("starting");

  useEffect(() => {
    const host = new WorkerWidgetHost(code);
    hostRef.current = host;
    let alive = true;
    const loop = async () => {
      if (!alive) return;
      const t = await host.tick({ now: Date.now() });
      if (!alive) return;
      setStatus(host.status);
      if (t) setTree(t);
    };
    void loop();
    const timer = window.setInterval(loop, 1000);
    return () => { alive = false; window.clearInterval(timer); host.dispose(); };
  }, [code]);

  return (
    <div className="fs-panel" style={{ padding: 10, textAlign: "center" }} title={`worker-isolated widget: ${name}`}>
      <div className="fs-row" style={{ justifyContent: "space-between" }}>
        <span className="fs-dim" style={{ fontSize: fz(10) }}>{name}</span>
        <Badge tone={status === "live" || status === "starting" ? "ok" : status === "unresponsive" ? "bad" : "warn"}>
          {status === "live" ? "worker-isolated" : status}
        </Badge>
      </div>
      <div style={{ fontSize: fz(24), color: tree?.color ?? "var(--fs-text)", background: tree?.bg }}>{tree?.text ?? "…"}</div>
      {tree?.sub ? <div className="fs-dim" style={{ fontSize: fz(10.5) }}>{tree.sub}</div> : null}
    </div>
  );
}
