"use client";
import { fz } from "@/lib/uiscale";

import { useEffect, useState } from "react";
import { api, fmtTime, patch, post, put } from "@/lib/api";
import { parseScript, ROUTINE_COMMANDS, type RoutineAction } from "@/lib/routines";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";
import { askText } from "@/lib/ask";

interface Routine { id: number; name: string; trigger: string; triggerArg: string; actions: RoutineAction[]; enabled: boolean; lastRun: string | null }
interface Preset { id: string; name: string; windows: number; updatedAt: string }

/**
 * AU-01 routines, AU-02 workspace presets, PR-07r named sessions.
 * Every routine action is a palette command (whitelisted server-side too), and
 * dry-run prints exactly what would execute — no hidden capabilities.
 */
export default function RoutinesModule(_: ModuleProps) {
  const shell = useShell();
  const [rows, setRows] = useState<Routine[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState("Morning desk");
  const [script, setScript] = useState("closeAll\nopen planner\ntile left\nopen notes\ntile right\ntheme dark");
  const [trigger, setTrigger] = useState("manual");
  const [arg, setArg] = useState("");
  const [dry, setDry] = useState<string[] | null>(null);
  const [err, setErr] = useState("");

  const load = async () => {
    const r = await api<{ rows: Routine[] }>("/api/routines");
    setRows(r.rows);
    const p = await api<{ rows: Preset[] }>("/api/state?list=preset");
    setPresets(p.rows);
  };
  useEffect(() => { void load(); }, [shell.refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  let parsed: RoutineAction[] = [];
  let parseErr = "";
  try { parsed = parseScript(script); } catch (e) { parseErr = String((e as Error).message); }

  return (
    <div className="fs-scroll" style={{ padding: 10, display: "grid", gap: 10, alignContent: "start", height: "100%" }}>
      <Section title="Workspace presets & sessions (AU-02 / PR-07r)">
        <div className="fs-row" style={{ gap: 6 }}>
          <Btn variant="primary" onClick={async () => {
            const n = await askText("Preset name", "focus-layout", { okLabel: "Save preset" });
            if (!n) return;
            await put("/api/state", { id: `preset:${n}`, state: shell.state, revision: Date.now() });
            shell.toast(`Saved preset "${n}" with ${shell.state.windows.length} windows (layout + window props, incl. browser tabs).`, "ok");
            await load();
          }}>Save current layout</Btn>
        </div>
        {presets.map((p) => (
          <div key={p.id} className="fs-row" style={{ justifyContent: "space-between" }}>
            <span style={{ fontSize: fz(12) }}>{p.name} <span className="fs-dim">· {p.windows} windows · {fmtTime(p.updatedAt)}</span></span>
            <span className="fs-row" style={{ gap: 4 }}>
              <Btn variant="ghost" onClick={() => void shell.runActions([{ cmd: "preset", arg: p.name }])}>Restore</Btn>
              <Btn variant="ghost" onClick={async () => { await fetch(`/api/state?id=${encodeURIComponent(p.id)}`, { method: "DELETE" }); await load(); }}>✕</Btn>
            </span>
          </div>
        ))}
        {presets.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>No presets yet.</div> : null}
      </Section>

      <Section title="New routine (AU-01)">
        <input className="fs-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Routine name" />
        <textarea className="fs-textarea" rows={6} value={script} onChange={(e) => setScript(e.target.value)} aria-label="Routine script" />
        <div className="fs-dim fs-mono" style={{ fontSize: fz(10.5) }}>commands: {ROUTINE_COMMANDS.join(" · ")} — one per line or separated by “;”</div>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <select className="fs-select" aria-label="Routine trigger" style={{ width: fz(180) }} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            <option value="manual">manual</option>
            <option value="interval">every N minutes</option>
            <option value="time-of-day">at time of day (HH:MM)</option>
            <option value="display-connected">when a display is connected</option>
          </select>
          {trigger === "interval" || trigger === "time-of-day" ? (
            <input className="fs-input" style={{ width: fz(110) }} placeholder={trigger === "interval" ? "minutes" : "08:30"} value={arg} onChange={(e) => setArg(e.target.value)} />
          ) : null}
          <Btn variant="ghost" disabled={Boolean(parseErr)} onClick={() => setDry(parsed.map((a, i) => `${i + 1}. ${a.cmd}${a.arg ? ` ${a.arg}` : ""}`))}>Dry run</Btn>
          <Btn variant="primary" disabled={Boolean(parseErr)} onClick={async () => {
            setErr("");
            try {
              await post("/api/routines", { name, trigger, triggerArg: arg, actions: parsed });
              await load();
            } catch (e) { setErr(String((e as Error).message)); }
          }}>Save routine</Btn>
        </div>
        {parseErr ? <Badge tone="bad">{parseErr}</Badge> : <Badge tone="ok">{parsed.length} valid actions</Badge>}
        {err ? <Badge tone="bad">{err}</Badge> : null}
        {dry ? <pre className="fs-mono" style={{ fontSize: fz(11.5), margin: 0 }}>{`Dry run — nothing executed:\n${dry.join("\n")}`}</pre> : null}
      </Section>

      <Section title="Routines">
        {rows.length === 0 ? <Empty title="No routines" icon="⚡" /> : null}
        {rows.map((r) => (
          <div key={r.id} className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: fz(12) }}>{r.name}</div>
              <div className="fs-dim fs-mono" style={{ fontSize: fz(10.5) }}>
                {r.trigger}{r.triggerArg ? ` ${r.triggerArg}` : ""} · {r.actions.map((a) => a.cmd).join(" → ")}
                {r.lastRun ? ` · last ${fmtTime(r.lastRun)}` : ""}
              </div>
            </span>
            <Badge tone={r.enabled ? "ok" : "default"}>{r.enabled ? "enabled" : "off"}</Badge>
            <Btn variant="ghost" onClick={async () => { await patch("/api/routines", { id: r.id, enabled: !r.enabled }); await load(); }}>{r.enabled ? "Disable" : "Enable"}</Btn>
            <Btn variant="primary" onClick={async () => { await shell.runActions(r.actions); await post("/api/routines", { ranId: r.id }); await load(); }}>Run</Btn>
            <Btn variant="ghost" onClick={async () => { await fetch(`/api/routines?id=${r.id}`, { method: "DELETE" }); await load(); }}>✕</Btn>
          </div>
        ))}
        <div className="fs-dim" style={{ fontSize: fz(11) }}>
          Automatic triggers are evaluated by the shell while it is open. Every run is written to the audit log (Monitor).
        </div>
      </Section>
    </div>
  );
}
