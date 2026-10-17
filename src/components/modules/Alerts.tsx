"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, fmtTime, patch, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Empty, Section } from "../ui";

interface Alert { id: number; app: string; title: string; body: string; priority: string; groupKey: string; read: boolean; pinned: boolean; createdAt: string }

/** NC-01/04. First-party alerts; the platform gap is a permanent visible row. */
export default function AlertsModule(_: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Alert[]>([]);
  const [perm, setPerm] = useState<string>(typeof Notification !== "undefined" ? Notification.permission : "unsupported");
  const [group, setGroup] = useState(true);
  const [note, setNote] = useState("");

  const load = () => api<{ rows: Alert[]; platformNote: string }>("/api/alerts")
    .then((r) => { setRows(r.rows); setNote(r.platformNote); })
    .catch(() => undefined);
  useEffect(() => { void load(); }, []);

  const groups = group
    ? rows.reduce<Record<string, Alert[]>>((acc, a) => { (acc[a.groupKey || a.app] ??= []).push(a); return acc; }, {})
    : { All: rows };

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn variant="primary" onClick={async () => {
          await post("/api/alerts", { app: "Fusion", title: "Test alert", body: `Created at ${new Date().toLocaleTimeString()}`, priority: "normal" });
          if (perm === "granted") new Notification("Fusion Shell", { body: "Test alert delivered through the Notification API." });
          await load();
          void navigator.setAppBadge?.(rows.filter((r) => !r.read).length + 1).catch(() => undefined);
        }}>Create test alert</Btn>
        <Btn variant="ghost" onClick={() => setGroup((g) => !g)}>{group ? "Ungroup" : "Group"}</Btn>
        <Btn variant="ghost" onClick={async () => { await patch("/api/alerts", { ids: rows.map((r) => r.id), read: true }); await load(); void navigator.clearAppBadge?.().catch(() => undefined); }}>Mark all read</Btn>
        <Btn variant="danger" onClick={async () => { if (confirm("Clear all alerts?")) { await fetch("/api/alerts", { method: "DELETE" }); await load(); } }}>Clear</Btn>
        <div style={{ flex: 1 }} />
        {perm === "granted" ? <Badge tone="ok">OS delivery granted</Badge> : (
          <Btn variant="ghost" onClick={async () => setPerm(await Notification.requestPermission())}>
            notifications: {perm} — request
          </Btn>
        )}
      </div>

      {rows.length === 0 ? <Empty title="No alerts" icon="🔔" /> : null}

      {Object.entries(groups).map(([key, list]) => (
        <Section key={key} title={`${key} · ${list.length}`} dense>
          <div style={{ display: "grid", gap: 2 }}>
            {list.map((a) => (
              <div key={a.id} className="fs-list-item" style={{ opacity: a.read ? .6 : 1 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: fz(12) }}>{a.pinned ? "📌 " : ""}{a.title}</div>
                  <div className="fs-dim" style={{ fontSize: fz(11) }}>{a.body} · {fmtTime(a.createdAt)}</div>
                </span>
                <Badge tone={a.priority === "high" ? "bad" : a.priority === "low" ? "default" : "info"}>{a.priority}</Badge>
                <Btn variant="ghost" onClick={async () => { await patch("/api/alerts", { ids: [a.id], snoozeMinutes: 15 }); await load(); }}>Snooze 15m</Btn>
                <Btn variant="ghost" onClick={async () => { await patch("/api/alerts", { ids: [a.id], pinned: !a.pinned }); await load(); }}>{a.pinned ? "Unpin" : "Pin"}</Btn>
                <Btn variant="ghost" onClick={async () => { await fetch(`/api/alerts?id=${a.id}`, { method: "DELETE" }); await load(); }}>Dismiss</Btn>
              </div>
            ))}
          </div>
        </Section>
      ))}

      <Blocked what="Reading other applications' notifications"
        missing="no NotificationListenerService analog exists for web content; origins are isolated"
        workaround="Fusion's own alerts, OS delivery through the Notification API, and app badging." />
      {note ? <div className="fs-dim" style={{ fontSize: fz(11) }}>{note}</div> : null}
      <div className="fs-dim" style={{ fontSize: fz(11) }}>
        Diagnostics: permission <span className="fs-mono">{perm}</span> · badging{" "}
        <span className="fs-mono">{"setAppBadge" in navigator ? "available" : "unavailable"}</span> · alerts are stored
        in Postgres with a visible retention policy, never in a hidden cache.
      </div>
    </div>
  );
}
