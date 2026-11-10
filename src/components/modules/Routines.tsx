"use client";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useState } from "react";
import { api, fmtTime, patch, post, put } from "@/lib/api";
import { parseScript, ROUTINE_COMMANDS, type RoutineAction } from "@/lib/routines";
import { exportRoutines, parseRoutineImport } from "@/lib/routine-io";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty, Section } from "../ui";
import { filterRoutines } from "@/lib/routine-filter";
import { duplicateName } from "@/lib/routine-dup";
import { askText } from "@/lib/ask";
import { parseAutomationRequest, dryRun, issueToken, redeemToken } from "@/lib/automation-entry";
import { validateRoutineTrigger } from "@/lib/routine-trigger";
import { RoutineGuardPanel } from "../tt145-panels";

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
  const [routineQ, setRoutineQ] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [name, setName] = useState("Morning desk");
  const [script, setScript] = useState("closeAll\nopen planner\ntile left\nopen notes\ntile right\ntheme dark");
  const [trigger, setTrigger] = useState("manual");
  const [arg, setArg] = useState("");
  const [dry, setDry] = useState<string[] | null>(null);
  const [reqText, setReqText] = useState('{ "routineId": "morning", "args": {} }');
  const [reqOut, setReqOut] = useState<string[]>([]);
  const [tokenRoutineId, setTokenRoutineId] = useState("");
  const [token, setToken] = useState<{ value: string; routineId: string; expiresAt: number; used: boolean } | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => Promise.all([
    api<{ rows: Routine[] }>("/api/routines").then(r => setRows(r.rows)),
    api<{ rows: Preset[] }>("/api/state?list=preset").then(r => setPresets(r.rows)),
  ]).then(() => undefined).catch(e => setErr(e instanceof Error ? e.message : String(e))), []);
  useEffect(() => { void load(); }, [shell.refreshTick, load]);

  let parsed: RoutineAction[] = [];
  let parseErr = "";
  try { parsed = parseScript(script); } catch (e) { parseErr = String((e as Error).message); }

  let triggerErr = "";
  try { validateRoutineTrigger(trigger, arg); } catch (e) { triggerErr = (e as Error).message; }

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
        <input className="fs-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="Routine name" data-testid="routine-name" />
        <textarea className="fs-textarea" rows={6} value={script} onChange={(e) => setScript(e.target.value)} aria-label="Routine script" data-testid="routine-script" />
        <div className="fs-dim fs-mono" style={{ fontSize: fz(10.5) }}>commands: {ROUTINE_COMMANDS.join(" · ")} — one per line or separated by “;”</div>
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <select className="fs-select" aria-label="Routine trigger" style={{ width: fz(180) }} value={trigger} onChange={(e) => setTrigger(e.target.value)}>
            <option value="manual">manual</option>
            <option value="interval">every N minutes</option>
            <option value="time-of-day">at time of day (HH:MM)</option>
            <option value="display-connected">when a display is connected</option>
          </select>
          {trigger === "interval" || trigger === "time-of-day" ? (
            <input className="fs-input" style={{ width: fz(110) }} placeholder={trigger === "interval" ? "minutes" : "08:30"} aria-label={trigger === "interval" ? "Interval in minutes" : "Time of day"} value={arg} onChange={(e) => setArg(e.target.value)} />
          ) : null}
          <Btn variant="ghost" data-testid="routine-preview" disabled={Boolean(parseErr)} onClick={() => setDry(parsed.map((a, i) => `${i + 1}. ${a.cmd}${a.arg ? ` ${a.arg}` : ""}`))}>Preview</Btn>
          <Btn variant="primary" data-testid="routine-save" disabled={Boolean(parseErr || triggerErr)} onClick={async () => {
            setErr("");
            try {
              await post("/api/routines", { name, trigger, triggerArg: arg, actions: parsed });
              await load();
            } catch (e) { setErr(String((e as Error).message)); }
          }}>Save routine</Btn>
        </div>
        {triggerErr ? <div role="alert">{triggerErr}</div> : null}
        {parseErr ? <Badge tone="bad">{parseErr}</Badge> : <Badge tone="ok">{parsed.length} valid actions</Badge>}
        {err ? <Badge tone="bad">{err}</Badge> : null}
        {dry ? <pre className="fs-mono" style={{ fontSize: fz(11.5), margin: 0 }} data-testid="routine-preview-text">{`Preview — nothing executed yet:\n${dry.join("\n")}`}</pre> : null}
      </Section>

      <RoutineGuardPanel />

      <Section title="Automation entry (AU-03)" icon="keycap">
        <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.5 }}>Local planner only: it does not run requests or authenticate their origin. Server automation tokens are managed below.</div>
        <textarea className="fs-input fs-mono" rows={3} value={reqText} aria-label="Automation request JSON" data-testid="routines-request" onChange={(e) => setReqText(e.target.value)} style={{ resize: "vertical", fontSize: fz(11) }} />
        <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Btn variant="primary" data-testid="routines-validate" onClick={() => {
            const parsedReq = parseAutomationRequest((() => { try { return JSON.parse(reqText); } catch { return null; } })());
            if (!parsedReq.ok) { setReqOut([`refused: ${parsedReq.error}`]); return; }
            const target = rows.find((r) => r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") === parsedReq.request.routineId) ?? rows.find((r) => String(r.id) === parsedReq.request.routineId);
            if (!target) { setReqOut([`refused: no routine named “${parsedReq.request.routineId}”`]); return; }
            const schema: Record<string, { args: string[]; mutates: boolean; required?: string[] }> = {};
            // Every routine command is a shell command taking one optional arg;
            // `open` and `alert` need it, and every command changes shell state.
            for (const cmd of ROUTINE_COMMANDS) {
              const needsArg = cmd === "open" || cmd === "alert" || cmd === "workspace" || cmd === "preset";
              schema[cmd] = { args: ["arg"], mutates: true, required: needsArg ? ["arg"] : [] };
            }
            const plan = dryRun({ id: target.name, name: target.name, trigger: "manual", enabled: target.enabled, actions: target.actions.map((a) => ({ command: a.cmd, args: a.arg ? { arg: a.arg } : {} })) }, schema);
            // A failed plan must not consume the local token. The pasted origin
            // is user-controlled, so this check is never server authorization.
            const tokenCheck = plan.executable && parsedReq.request.origin && parsedReq.request.origin !== location.origin ? redeemToken(token ?? undefined, parsedReq.request.token, String(target.id), Date.now()) : { ok: true, error: null };
            if (token?.used) setToken({ ...token });
            setReqOut([
              plan.executable && tokenCheck.ok ? `executable: ${plan.steps.length} step(s) (local plan only; nothing ran)` : `refused: ${[...plan.problems, tokenCheck.error ?? ""].filter(Boolean).join("; ")}`,
              ...plan.steps.map((st) => `${st.index + 1}. ${st.describe}${st.wouldChange.length ? " · writes" : ""}`),
            ]);
          }}>Plan</Btn>
          <Btn variant="ghost" disabled={!token} onClick={() => setToken(null)}>Clear token</Btn>
          <select className="fs-select" aria-label="Planner token routine" value={tokenRoutineId} onChange={e => setTokenRoutineId(e.target.value)}>
            <option value="">Choose a routine</option>
            {rows.map(r => <option key={r.id} value={String(r.id)}>{r.name} (id {r.id})</option>)}
          </select>
          <Btn variant="ghost" disabled={!rows.some(r => String(r.id) === tokenRoutineId)} data-testid="routines-token" onClick={() => { const selected = rows.find(r => String(r.id) === tokenRoutineId); if (!selected) return; const t = issueToken(String(selected.id), Date.now(), 60_000); setToken(t); setReqOut([`local planner token for “${selected.name}” (id ${selected.id}), valid one minute, single use`]); }}>Issue token</Btn>
        </div>
        {token ? <div className="fs-mono" style={{ fontSize: fz(10.5), wordBreak: "break-all" }} data-testid="routines-token-value">{token.value} · {token.used ? "used" : "unused"} · expires {new Date(token.expiresAt).toLocaleTimeString()}</div> : null}
        {reqOut.map((line, i) => <div key={i} className={i === 0 ? "fs-mono" : "fs-dim"} style={{ fontSize: fz(11) }}>{line}</div>)}
      </Section>

      <Section title="Routines">
        <div className="fs-row" style={{ gap: 6 }}>
          <Btn variant="ghost" disabled={!rows.length} onClick={() => {
            const url = URL.createObjectURL(new Blob([exportRoutines(rows.map((r) => ({ name: r.name, actions: r.actions })))], { type: "application/json" }));
            const a = document.createElement("a"); a.href = url; a.download = "routines.json"; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
          }}>Export routines</Btn>
          <label className="fs-btn" data-variant="ghost" style={{ cursor: "pointer" }}>Import routines
            <input type="file" accept=".json,application/json" hidden aria-label="Import routines" onChange={async (e) => {
              const f = e.target.files?.[0]; if (!f) return;
              try {
                const r = parseRoutineImport(await f.text(), rows.map((x) => x.name));
                for (const rt of r.routines) await post("/api/routines", { name: rt.name, trigger: "manual", triggerArg: "", actions: rt.actions });
                shell.toast(`Routine import: ${r.routines.length} added${r.skipped.length ? `, skipped existing: ${r.skipped.join(", ")}` : ""}`, "ok");
                await load();
              } catch (err) { shell.toast(`Routine import refused: ${String((err as Error).message)}`, "warn"); }
              e.target.value = "";
            }} />
          </label>
        </div>
        {rows.length ? <input className="fs-input" type="search" placeholder="Search routines" aria-label="Search routines" value={routineQ} onChange={(e) => setRoutineQ(e.target.value)} data-testid="routines-search" /> : null}
        {rows.length === 0 ? <Empty title="No routines" glyph="repeat" /> : null}
        {filterRoutines(rows.map((r) => ({ r, name: r.name, actions: JSON.stringify(r.actions) })), routineQ).map(({ r }) => (
          <div key={r.id} className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: fz(12) }}>{r.name}</div>
              {(() => { try { validateRoutineTrigger(r.trigger, r.triggerArg); return null; } catch { return <div role="status">Invalid trigger — automatic execution paused. Recreate this routine with a valid trigger.</div>; } })()}
              <div className="fs-dim fs-mono" style={{ fontSize: fz(10.5) }}>
                {r.trigger}{r.triggerArg ? ` ${r.triggerArg}` : ""} · {r.actions.map((a) => a.cmd).join(" → ")}
                {r.lastRun ? ` · last ${fmtTime(r.lastRun)}` : ""}
              </div>
            </span>
            <Badge tone={r.enabled ? "ok" : "default"}>{r.enabled ? "enabled" : "off"}</Badge>
            <Btn variant="ghost" onClick={async () => { await post("/api/routines", { name: duplicateName(r.name, rows.map((x) => x.name)), trigger: r.trigger, triggerArg: r.triggerArg ?? "", actions: r.actions }); await load(); }} data-testid="routine-dup">Duplicate</Btn>
            <Btn variant="ghost" onClick={async () => { await patch("/api/routines", { id: r.id, enabled: !r.enabled }); await load(); }}>{r.enabled ? "Disable" : "Enable"}</Btn>
            <Btn variant="ghost" data-testid="routine-rehearse" title="Rehearse: record the intent in the audit log and execute nothing"
              onClick={async () => {
                // AU-01: the rehearsal goes through the same server path as a run
                // and is audited as routine.dryrun, so a person can tell later
                // which of the two happened — the executor is simply not called.
                await post("/api/routines", { ranId: r.id, dry: true });
                shell.toast(`Rehearsed "${r.name}": ${r.actions.map((a) => a.cmd).join(", ")} — nothing was executed.`, "info");
                await load();
              }}>Rehearse</Btn>
            <Btn variant="primary" data-testid="routine-run" onClick={async () => { await shell.runActions(r.actions); await post("/api/routines", { ranId: r.id }); await load(); }}>Run</Btn>
            <Btn variant="ghost" onClick={async () => { await fetch(`/api/routines?id=${r.id}`, { method: "DELETE" }); await load(); }}>✕</Btn>
          </div>
        ))}
        <div className="fs-dim" style={{ fontSize: fz(11) }}>
          Triggers run while the shell is open; every run is written to the audit log (Monitor).
        </div>
      </Section>

      <AutomationPanel />
    </div>
  );
}

interface AutomationToken { id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revoked: boolean }

/**
 * AU-03 external entry points. The token is shown once; the panel never offers
 * to show it again because the server cannot — it stores only a hash.
 */
function AutomationPanel() {
  const shell = useShell();
  const [rows, setRows] = useState<AutomationToken[]>([]);
  const [name, setName] = useState("Shortcut");
  const [scopes, setScopes] = useState<{ run: boolean; read: boolean }>({ run: true, read: true });
  const [fresh, setFresh] = useState<{ token: string; example: string } | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(() => api<{ rows: AutomationToken[] }>("/api/automation/tokens")
    .then((r) => setRows(r.rows)).catch((e) => setErr(String((e as Error).message))), []);
  useEffect(() => { void load(); }, [load]);

  const wanted = [scopes.run ? "run" : null, scopes.read ? "read" : null].filter(Boolean) as string[];
  return (
    <Section title="External entry points (AU-03)" icon="sliders" right={<Badge tone={rows.some((r) => !r.revoked) ? "ok" : "default"}>{rows.filter((r) => !r.revoked).length} live</Badge>}>
      <div className="fs-dim" style={{ fontSize: fz(11) }}>
        A script POSTs commands to <span className="fs-mono">/api/automation</span> with a bearer token; this window executes them.
      </div>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" style={{ width: fz(160) }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" />
        <label className="fs-row" style={{ gap: 4, fontSize: fz(11.5) }}>
          <input type="checkbox" checked={scopes.run} onChange={(e) => setScopes({ ...scopes, run: e.target.checked })} /> run
        </label>
        <label className="fs-row" style={{ gap: 4, fontSize: fz(11.5) }}>
          <input type="checkbox" checked={scopes.read} onChange={(e) => setScopes({ ...scopes, read: e.target.checked })} /> read
        </label>
        <Btn variant="primary" disabled={!wanted.length} data-testid="automation-mint" onClick={async () => {
          setErr(""); setFresh(null);
          try {
            const r = await post<{ token: string; example: string }>("/api/automation/tokens", { name, scopes: wanted });
            setFresh({ token: r.token, example: r.example });
            await load();
          } catch (e) { setErr(String((e as Error).message)); }
        }}>Create token</Btn>
      </div>
      {fresh ? (
        <div className="fs-panel" style={{ padding: 8, display: "grid", gap: 6, borderColor: "rgba(255,196,83,.4)" }}>
          <div style={{ fontSize: fz(11.5) }}>Copy it now — only a hash is stored, so it cannot be shown again.</div>
          <code className="fs-mono" style={{ fontSize: fz(10.5), wordBreak: "break-all" }} data-testid="automation-token">{fresh.token}</code>
          <div className="fs-row" style={{ gap: 6 }}>
            <Btn variant="ghost" onClick={() => shell.copy(fresh.token, "Routines", true)}>Copy token</Btn>
            <Btn variant="ghost" onClick={() => shell.copy(fresh.example, "Routines", false)}>Copy curl example</Btn>
          </div>
        </div>
      ) : null}
      {err ? <Badge tone="bad">{err}</Badge> : null}
      {rows.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>No tokens. Nothing outside this window can run a command.</div> : null}
      {rows.map((t) => (
        <div key={t.id} className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: fz(11.5), minWidth: 0 }}>
            <span className="fs-mono">{t.id}</span> {t.name} <span className="fs-dim">· {t.scopes.join(", ")}{t.lastUsedAt ? ` · used ${fmtTime(t.lastUsedAt)}` : ""}</span>
          </span>
          <Badge tone={t.revoked ? "bad" : "ok"}>{t.revoked ? "revoked" : "live"}</Badge>
          {t.revoked ? null : (
            <Btn variant="ghost" onClick={async () => { await fetch(`/api/automation/tokens?id=${t.id}`, { method: "DELETE" }); await load(); }}>Revoke</Btn>
          )}
        </div>
      ))}
    </Section>
  );
}
