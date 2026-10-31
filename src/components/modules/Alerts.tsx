"use client";
import OrbitTarget from "../OrbitTarget";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, fmtTime, patch, post } from "@/lib/api";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Blocked, Btn, Empty, Section } from "../ui";
import { filterAlerts, unreadCount } from "@/lib/alert-filter";
import { FocusRulesEditor, type FocusStatus } from "./FocusRules";

interface Alert { id: number; app: string; title: string; body: string; priority: string; groupKey: string; read: boolean; pinned: boolean; createdAt: string; heldBy?: string | null; heldReason?: string | null }

/** NC-01/04. First-party alerts; the platform gap is a permanent visible row. */
export default function AlertsModule(_: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Alert[]>([]);
  const [perm, setPerm] = useState<string>(typeof Notification !== "undefined" ? Notification.permission : "unsupported");
  const [group, setGroup] = useState(true);
  const [note, setNote] = useState("");
  const [focus, setFocus] = useState<FocusStatus | null>(null);
  const [showRules, setShowRules] = useState(false);

  const load = () => api<{ rows: Alert[]; platformNote: string; focus: FocusStatus }>("/api/alerts")
    .then((r) => { setRows(r.rows); setNote(r.platformNote); setFocus(r.focus); })
    .catch(() => undefined);
  useEffect(() => { void load(); }, []);

  // TT71 NC-02: alerts held by a focus rule are listed apart, each with the sentence saying why
  const held = rows.filter((r) => r.heldBy);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const shown = filterAlerts(rows.filter((r) => !r.heldBy), { unreadOnly });
  const groups = group
    ? shown.reduce<Record<string, Alert[]>>((acc, a) => { (acc[a.groupKey || a.app] ??= []).push(a); return acc; }, {})
    : { All: shown };

  const alertActions = (a: Alert) => [
    { label: a.read ? "Mark unread" : "Mark read", run: async () => { await patch("/api/alerts", { ids: [a.id], read: !a.read }); await load(); } },
    { label: a.pinned ? "Unpin alert" : "Pin alert", run: async () => { await patch("/api/alerts", { ids: [a.id], pinned: !a.pinned }); await load(); } },
    ...(a.heldBy ? [{ label: "Release held alert", run: async () => { await patch("/api/alerts", { ids: [a.id], deliver: true }); await load(); } }] : [{ label: "Snooze 15 minutes", run: async () => { await patch("/api/alerts", { ids: [a.id], snoozeMinutes: 15 }); await load(); } }]),
    { label: "Copy alert text", run: () => shell.copy(`${a.title}\n${a.body}`, "alerts") },
    { label: "Dismiss alert", run: async () => { await api(`/api/alerts?id=${a.id}`, { method: "DELETE" }); await load(); } },
  ];

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <Btn variant="primary" onClick={async () => {
          const res = await post<{ delivered?: boolean; reason?: string }>("/api/alerts", { app: "Fusion", title: "Test alert", body: `Created at ${new Date().toLocaleTimeString()}`, priority: "normal" });
          if (res.delivered === false) shell.toast(`Held: ${res.reason}`, "info");
          else if (perm === "granted") new Notification("Fusion Shell", { body: "Test alert delivered through the Notification API." });
          await load();
          void navigator.setAppBadge?.(rows.filter((r) => !r.read).length + 1).catch(() => undefined);
        }}>Create test alert</Btn>
        <Btn variant="ghost" aria-expanded={showRules} onClick={() => setShowRules((v) => !v)}>
          Focus rules{focus?.active.length ? ` · ${focus.active.length} active` : ""}
        </Btn>
        <Btn variant="ghost" onClick={() => setGroup((g) => !g)}>{group ? "Ungroup" : "Group"}</Btn>
        <Btn variant="ghost" onClick={async () => { await patch("/api/alerts", { ids: rows.map((r) => r.id), read: true }); await load(); void navigator.clearAppBadge?.().catch(() => undefined); }}>Mark all read</Btn>
        <Btn variant={unreadOnly ? "primary" : "ghost"} aria-pressed={unreadOnly} onClick={() => setUnreadOnly((v) => !v)} data-testid="alerts-unread-filter">Unread only ({unreadCount(rows)})</Btn>
        <Btn variant="danger" onClick={async () => { if (confirm("Clear all alerts?")) { await fetch("/api/alerts", { method: "DELETE" }); await load(); } }}>Clear</Btn>
        <div style={{ flex: 1 }} />
        {perm === "granted" ? <Badge tone="ok">OS delivery granted</Badge> : (
          <Btn variant="ghost" onClick={async () => setPerm(await Notification.requestPermission())}>
            notifications: {perm} — request
          </Btn>
        )}
      </div>

      {showRules && focus ? <FocusRulesEditor status={focus} onSaved={() => void load()} /> : null}
      {!showRules && focus?.active.length ? (
        <div className="fs-dim" data-testid="focus-active-line" style={{ fontSize: fz(12) }}>Focus: {focus.active.join(", ")} — some alerts are being held.</div>
      ) : null}

      {rows.length === 0 ? <Empty title="No alerts" glyph="alarm" /> : null}

      {held.length ? (
        <Section title={`Held by focus rules · ${held.length}`} dense>
          <div data-testid="alerts-held" style={{ display: "grid", gap: 2 }}>
            {held.map((a) => (
              <OrbitTarget key={a.id} label={`Alert: ${a.title}`} actions={alertActions(a)}>
              <div tabIndex={0} role="group" aria-label={`Alert: ${a.title}`} className="fs-list-item" data-testid={`held-${a.id}`}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: fz(12) }}>{a.app}: {a.title}</div>
                  <div className="fs-dim" style={{ fontSize: fz(11) }}>{a.heldReason} · {fmtTime(a.createdAt)}</div>
                </span>
                <Badge tone={a.priority === "high" ? "bad" : a.priority === "low" ? "default" : "info"}>{a.priority}</Badge>
                <Btn variant="ghost" onClick={async () => { await patch("/api/alerts", { ids: [a.id], deliver: true }); await load(); }}>Deliver now</Btn>
                <Btn variant="ghost" onClick={async () => { await fetch(`/api/alerts?id=${a.id}`, { method: "DELETE" }); await load(); }}>Dismiss</Btn>
              </div>
              </OrbitTarget>
            ))}
          </div>
        </Section>
      ) : null}

      {Object.entries(groups).map(([key, list]) => (
        <Section key={key} title={`${key} · ${list.length}`} dense>
          <div style={{ display: "grid", gap: 2 }}>
            {list.map((a) => (
              <OrbitTarget key={a.id} label={`Alert: ${a.title}`} actions={alertActions(a)}>
              <div tabIndex={0} role="group" aria-label={`Alert: ${a.title}`} className="fs-list-item" style={{ opacity: a.read ? .6 : 1 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: fz(12) }}>{a.pinned ? "📌 " : ""}{a.title}</div>
                  <div className="fs-dim" style={{ fontSize: fz(11) }}>{a.body} · {fmtTime(a.createdAt)}</div>
                </span>
                <Badge tone={a.priority === "high" ? "bad" : a.priority === "low" ? "default" : "info"}>{a.priority}</Badge>
                <Btn variant="ghost" onClick={async () => { await patch("/api/alerts", { ids: [a.id], snoozeMinutes: 15 }); await load(); }}>Snooze 15m</Btn>
                <Btn variant="ghost" onClick={async () => { await patch("/api/alerts", { ids: [a.id], pinned: !a.pinned }); await load(); }}>{a.pinned ? "Unpin" : "Pin"}</Btn>
                <Btn variant="ghost" onClick={async () => { await fetch(`/api/alerts?id=${a.id}`, { method: "DELETE" }); await load(); }}>Dismiss</Btn>
              </div>
              </OrbitTarget>
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
