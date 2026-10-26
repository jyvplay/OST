"use client";
/**
 * TT71 NC-02 — Focus rules editor (inside Alerts). Edits the setting alerts.focusRules (validated on the server by
 * the same pure parser) and alerts.timeZone. Every field is a real control with a label; nothing is hidden behind JSON.
 */
import { useState } from "react";
import { put } from "@/lib/api";
import { fz } from "@/lib/uiscale";
import { daysText, MAX_RULES, parseRules, PRIORITIES, type FocusRule, type Priority } from "@/lib/focus-rules";
import { Badge, Btn, Section } from "../ui";

export interface FocusStatus { rules: FocusRule[]; active: string[]; timeZone: string; activeWorkspace: number; focusMode: boolean; problem: string }

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const listOf = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const deviceZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };

/** One line, in words, of what a rule does — shown in the list and read by screen readers. */
export function ruleSummary(r: FocusRule): string {
  const when: string[] = [];
  if (r.schedule) when.push(`${daysText(r.schedule.days)} ${r.schedule.from}–${r.schedule.to}`);
  if (r.workspaces) when.push(`on workspace ${r.workspaces.join(", ")}`);
  if (r.focusMode !== undefined) when.push(`while focus mode is ${r.focusMode ? "on" : "off"}`);
  const lets = [...(r.allowApps.length ? [r.allowApps.join(", ")] : []), ...(r.allowPriorities.length ? [`${r.allowPriorities.join("/")} priority`] : [])];
  return `${when.length ? when.join(", ") : "always"} · lets through: ${lets.length ? lets.join("; ") : "nothing"}`;
}

export function FocusRulesEditor({ status, onSaved }: { status: FocusStatus; onSaved: () => void }) {
  const [rules, setRules] = useState<FocusRule[]>(status.rules);
  const [zone, setZone] = useState(status.timeZone === "UTC" && !status.rules.length ? deviceZone() : status.timeZone);
  const [err, setErr] = useState("");
  const [dirty, setDirty] = useState(false);
  const edit = (i: number, patch: Partial<FocusRule>) => { setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))); setDirty(true); };
  const strip = (r: FocusRule) => {
    const o: Partial<FocusRule> = { ...r };
    if (!o.workspaces?.length) delete o.workspaces;
    return o;
  };

  const save = async () => {
    const json = JSON.stringify(rules.map(strip));
    const v = parseRules(json);
    if ("error" in v) { setErr(v.error); return; }
    try {
      await put("/api/settings", { key: "alerts.timeZone", value: zone });
      await put("/api/settings", { key: "alerts.focusRules", value: json });
      setErr(""); setDirty(false); onSaved();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const add = () => {
    const n = rules.length + 1;
    let id = `rule-${n}`; while (rules.some((r) => r.id === id)) id += "x";
    setRules((rs) => [...rs, { id, name: n === 1 ? "Evenings" : `Rule ${n}`, enabled: true, schedule: { days: [1, 2, 3, 4, 5], from: "18:00", to: "08:00" }, allowApps: [], allowPriorities: ["high"] }]);
    setDirty(true);
  };

  return (
    <Section title="Focus rules" dense>
      <div data-testid="focus-rules" style={{ display: "grid", gap: 8 }}>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap", fontSize: fz(12) }} data-testid="focus-status" aria-live="polite">
          {status.active.length
            ? <><Badge tone="warn">holding alerts</Badge> active now: {status.active.join(", ")}</>
            : <><Badge tone="ok">delivering</Badge> no rule is active right now</>}
          <span className="fs-dim">· workspace {status.activeWorkspace} · focus mode {status.focusMode ? "on" : "off"} · {status.timeZone}</span>
        </div>
        {status.problem ? <div role="alert" className="fs-dim">{status.problem}</div> : null}
        <label className="fs-row" style={{ gap: 6, fontSize: fz(12) }}>
          Time zone
          <input className="fs-input" aria-label="Focus time zone" value={zone} onChange={(e) => { setZone(e.target.value); setDirty(true); }} style={{ width: 200 }} />
          <Btn variant="ghost" onClick={() => { setZone(deviceZone()); setDirty(true); }}>Use this device ({deviceZone()})</Btn>
        </label>
        {rules.map((r, i) => (
          <fieldset key={r.id} data-testid={`focus-rule-${r.id}`} style={{ border: "1px solid var(--fs-border)", borderRadius: 8, padding: 8, display: "grid", gap: 6 }}>
            <legend style={{ fontSize: fz(12) }}>{r.name || r.id}</legend>
            <div className="fs-row" style={{ gap: 8, flexWrap: "wrap", fontSize: fz(12) }}>
              <label>Name <input className="fs-input" aria-label={`Rule ${i + 1} name`} value={r.name} onChange={(e) => edit(i, { name: e.target.value })} style={{ width: 140 }} /></label>
              <label><input type="checkbox" checked={r.enabled} onChange={(e) => edit(i, { enabled: e.target.checked })} /> Enabled</label>
              <label><input type="checkbox" aria-label={`Rule ${i + 1} has schedule`} checked={!!r.schedule}
                onChange={(e) => edit(i, { schedule: e.target.checked ? { days: [1, 2, 3, 4, 5], from: "18:00", to: "08:00" } : undefined })} /> Schedule</label>
              <Btn variant="ghost" onClick={() => { setRules((rs) => rs.filter((_, j) => j !== i)); setDirty(true); }}>Remove</Btn>
            </div>
            {r.schedule ? (
              <div className="fs-row" style={{ gap: 6, flexWrap: "wrap", fontSize: fz(12) }}>
                {DAYS.map((d, k) => (
                  <label key={d}><input type="checkbox" aria-label={`Rule ${i + 1} ${d}`} checked={r.schedule!.days.includes(k)}
                    onChange={(e) => edit(i, { schedule: { ...r.schedule!, days: e.target.checked ? [...r.schedule!.days, k].sort() : r.schedule!.days.filter((x) => x !== k) } })} /> {d}</label>
                ))}
                <label>from <input type="time" className="fs-input" aria-label={`Rule ${i + 1} from`} value={r.schedule.from} onChange={(e) => edit(i, { schedule: { ...r.schedule!, from: e.target.value } })} /></label>
                <label>to <input type="time" className="fs-input" aria-label={`Rule ${i + 1} to`} value={r.schedule.to} onChange={(e) => edit(i, { schedule: { ...r.schedule!, to: e.target.value } })} /></label>
              </div>
            ) : null}
            <div className="fs-row" style={{ gap: 8, flexWrap: "wrap", fontSize: fz(12) }}>
              <label>Workspaces <input className="fs-input" aria-label={`Rule ${i + 1} workspaces`} placeholder="any" value={(r.workspaces ?? []).join(", ")}
                onChange={(e) => edit(i, { workspaces: listOf(e.target.value).map(Number) })} style={{ width: 80 }} /></label>
              <label>Focus mode <select className="fs-input" aria-label={`Rule ${i + 1} focus mode`} value={r.focusMode === undefined ? "any" : r.focusMode ? "on" : "off"}
                onChange={(e) => edit(i, { focusMode: e.target.value === "any" ? undefined : e.target.value === "on" })}>
                <option value="any">any</option><option value="on">on</option><option value="off">off</option></select></label>
              <label>Let through apps <input className="fs-input" aria-label={`Rule ${i + 1} allowed apps`} placeholder="e.g. Planner, Calls" value={r.allowApps.join(", ")}
                onChange={(e) => edit(i, { allowApps: listOf(e.target.value) })} style={{ width: 160 }} /></label>
              {PRIORITIES.map((p) => (
                <label key={p}><input type="checkbox" aria-label={`Rule ${i + 1} lets ${p} priority through`} checked={r.allowPriorities.includes(p)}
                  onChange={(e) => edit(i, { allowPriorities: e.target.checked ? [...r.allowPriorities, p as Priority] : r.allowPriorities.filter((x) => x !== p) })} /> {p}</label>
              ))}
            </div>
            <div className="fs-dim" style={{ fontSize: fz(11) }}>{ruleSummary(r)}</div>
          </fieldset>
        ))}
        <div className="fs-row" style={{ gap: 6 }}>
          <Btn variant="ghost" disabled={rules.length >= MAX_RULES} onClick={add}>Add rule</Btn>
          <Btn variant="primary" disabled={!dirty} onClick={() => void save()}>Save focus rules</Btn>
          {err ? <span role="alert" style={{ fontSize: fz(12), color: "var(--fs-bad, #c0392b)" }}>{err}</span> : null}
        </div>
      </div>
    </Section>
  );
}
