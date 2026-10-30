"use client";
/**
 * TT72 SC-05: the Privacy dashboard's device-access log — which module asked for the camera, microphone, screen,
 * clipboard or location, when, and what happened; live streams can be stopped from here. The log is this tab's memory
 * only (src/lib/access-log.ts): nothing is sent or stored.
 */
import { useState, useSyncExternalStore } from "react";
import { fz } from "@/lib/uiscale";
import { clearLog, snapshot, stopLive, subscribe, type AccessEntry } from "@/lib/access-log";
import { Badge, Btn, Section } from "../ui";
import { filterAccess } from "@/lib/access-filter";

const EMPTY: readonly AccessEntry[] = [];
const LABEL: Record<string, string> = { camera: "Camera", microphone: "Microphone", screen: "Screen", "clipboard-read": "Clipboard read", location: "Location" };
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const dur = (a: number, b: number) => { const s = Math.max(0, Math.round((b - a) / 1000)); return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`; };

export function AccessLogPanel() {
  const log = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
  const [aq, setAq] = useState("");
  const live = log.filter((e) => e.live);
  const shownLog = filterAccess(log.map((e) => ({ ...e, action: e.kinds.join("+"), result: e.outcome })), aq);
  return (
    <div style={{ display: "grid", gap: 10 }} data-testid="access-log">
      <Section title={`In use now · ${live.length}`} dense>
        {live.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(12) }} data-testid="access-live-none">No camera, microphone or screen is in use by Fusion.</div> : (
          <div style={{ display: "grid", gap: 4 }}>
            {live.map((e) => (
              <div key={e.id} className="fs-list-item" data-testid={`access-live-${e.id}`}>
                <Badge tone="warn">live</Badge>
                <span style={{ flex: 1, fontSize: fz(12) }}>{e.kinds.map((k) => LABEL[k] ?? k).join(" + ")} — {e.app} · since {clock(e.at)}</span>
                <Btn variant="danger" onClick={() => stopLive(e.id)}>Stop</Btn>
              </div>
            ))}
          </div>
        )}
      </Section>
      <input className="fs-input" type="search" placeholder="Filter by module, device or outcome" aria-label="Filter access log" value={aq} onChange={(e) => setAq(e.target.value)} data-testid="access-filter" />
      <Section title={`Access log · ${log.length}`} dense right={<Btn variant="ghost" disabled={log.length === live.length} onClick={clearLog}>Clear</Btn>}>
        {log.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(12) }}>No module has asked for a device in this session.</div> : (
          <table style={{ width: "100%", fontSize: fz(12), borderCollapse: "collapse" }}>
            <thead><tr style={{ textAlign: "left" }}><th>Time</th><th>Module</th><th>Asked for</th><th>Outcome</th><th>Duration</th></tr></thead>
            <tbody>
              {shownLog.map((e) => (
                <tr key={e.id} data-testid="access-row" data-kinds={e.kinds.join(",")} data-outcome={e.outcome} data-app={e.app}>
                  <td className="fs-mono">{clock(e.at)}</td><td>{e.app}</td><td>{e.kinds.map((k) => LABEL[k] ?? k).join(" + ")}</td>
                  <td><Badge tone={e.outcome === "granted" ? "ok" : e.outcome === "denied" ? "warn" : "bad"}>{e.outcome}</Badge>{e.error ? <span className="fs-dim"> {e.error}</span> : null}</td>
                  <td>{e.live ? "live" : e.endedAt ? dur(e.at, e.endedAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <div className="fs-dim" style={{ fontSize: fz(11) }}>
        Kept in this tab&apos;s memory only — never sent to the server or written to storage, and no content is recorded
        (no clipboard text, coordinates or frames). Covers requests made by Fusion modules; a site inside the Browser asks
        the browser directly and appears in the browser&apos;s own site permissions instead.
      </div>
    </div>
  );
}
