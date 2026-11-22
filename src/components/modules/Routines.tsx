"use client";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, fmtTime, patch, post } from "@/lib/api";
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
  const [presetError, setPresetError] = useState("");
  const [savingPreset, setSavingPreset] = useState(false);
  const presetLock = useRef(false);
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
          <Btn variant="primary" disabled={savingPreset} onClick={async () => {
            if (presetLock.current) return;
            presetLock.current = true; setSavingPreset(true); setPresetError("");
            try {
              const n = await askText("Preset name", "focus-layout", { okLabel: "Save preset" });
              if (!n) return;
              const snapshot = shell.state;
              try {
                await post("/api/state", { op: "createPreset", name: n, state: snapshot });
                shell.toast(`Saved preset "${n}" with ${snapshot.windows.length} windows (layout + window props, incl. browser tabs).`, "ok");
              } catch (e) {
                const status = (e as { status?: number }).status;
                setPresetError(status === 409 ? `Preset "${n}" already exists. Choose another name; it was not overwritten.` : `Save not confirmed for "${n}". Check the preset list before retrying; it may have been saved.`);
              }
              await load();
            } finally { presetLock.current = false; setSavingPreset(false); }
          }}>Save current layout</Btn>
        </div>
        {presetError ? <div role="alert">{presetError}</div> : null}
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
        <div className="fs-dim" style={{ fontSize: fz(11), lineHeight: 1.5 }}>Local planner: no requests run or origins authenticated. Manage server tokens below.</div>
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
          Triggers run while the shell is open; every run is logged in Monitor.
        </div>
      </Section>

      <AutomationPanel />
    </div>
  );
}

interface AutomationToken { id: string; name: string; scopes: string[]; createdAt: string; lastUsedAt: string | null; revoked: boolean }

// IDs only, never bearer secrets. A separate key avoids lost updates when two
// panels revoke different tokens in the same tab. Entries expire with the tab.
const revokeMarkerKey = (id: string) => `fusion.revoke-uncertain.${id}`;

// All Routines windows in this document share a monotone, ID-only snapshot.
// Storage extends it across reloads; it is not a cross-tab operation journal.
const emptyRevokeMarkers: readonly string[] = [];
let revokeMarkers: readonly string[] = emptyRevokeMarkers;
const revokeMarkerListeners = new Set<() => void>();
function subscribeRevokeMarkers(listener: () => void) {
  revokeMarkerListeners.add(listener);
  return () => { revokeMarkerListeners.delete(listener); };
}
function addRevokeMarkers(ids: readonly string[]) {
  const next = Array.from(new Set([...revokeMarkers, ...ids]));
  if (next.length === revokeMarkers.length) return;
  revokeMarkers = next;
  for (const listener of revokeMarkerListeners) listener();
}
const getRevokeMarkers = () => revokeMarkers;
const getServerRevokeMarkers = () => emptyRevokeMarkers;
function broadcastRevokeMarkers(channel: BroadcastChannel | null, ids: readonly string[]) {
  if (!channel) return;
  for (let i = 0; i < ids.length; i += 100) {
    try { channel.postMessage({ type: "markers", ids: ids.slice(i, i + 100) }); }
    catch { return; } // Advisory: other tabs can still be stale.
  }
}

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
  const [minting, setMinting] = useState(false);
  // Synchronous guard: two activations can arrive before React renders disabled.
  // A successful mint stays locked until the user dismisses its one-time secret.
  const mintLock = useRef(false);
  const [err, setErr] = useState("");
  const [revokeErrors, setRevokeErrors] = useState<Record<string, string>>({});
  // A list read can precede an already-sent revoke's commit. Dismissing the
  // warning does not make a formerly live row authoritative again.
  const uncertainRevokes = useSyncExternalStore(subscribeRevokeMarkers, getRevokeMarkers, getServerRevokeMarkers);
  const [markerStorageError, setMarkerStorageError] = useState(false);
  const revokeChannel = useRef<BroadcastChannel | null>(null);
  const [revoking, setRevoking] = useState<string[]>([]);
  const revokeLocks = useRef(new Set<string>());
  const [listError, setListError] = useState("");
  const [listLoaded, setListLoaded] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const requestVersion = useRef(0);
  const interactionVersion = useRef(0);

  const load = useCallback(async (focusId?: string, focusVersion?: number) => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    setListLoading(true);
    try {
      const result = await api<{ rows: AutomationToken[] }>("/api/automation/tokens", { signal: controller.signal });
      // An older or timed-out response must not replace a newer list or its page selection.
      if (controller.signal.aborted) throw new Error("Token list request timed out. Retry when the connection is available.");
      if (version !== requestVersion.current) return;
      // Read before rendering rows: a reload must not briefly paint a formerly
      // uncertain token as unqualified live. A live list cannot clear a marker.
      try {
        const marked = result.rows.filter(row => sessionStorage.getItem(revokeMarkerKey(row.id)) === "1").map(row => row.id);
        addRevokeMarkers(marked);
        // A peer may have asked before this list rehydrated our tab's markers.
        broadcastRevokeMarkers(revokeChannel.current, marked);
      } catch { setMarkerStorageError(true); }
      setRows(result.rows);
      setListLoaded(true);
      setListError("");
      setListLoading(false);
      if (focusId && focusVersion === interactionVersion.current) {
        const index = result.rows.findIndex((row) => row.id === focusId);
        if (index >= 0) setPage(Math.floor(index / 8));
      }
    } catch (e) {
      if (version === requestVersion.current) {
        setListLoading(false);
        setListError(controller.signal.aborted ? "Token list request timed out. Retry when the connection is available." : String((e as Error).message));
      }
    } finally {
      clearTimeout(timer);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    // Advisory only: BroadcastChannel is not durable or guaranteed delivery.
    // A late panel asks currently listening peers for their existing markers.
    let channel: BroadcastChannel;
    try { channel = new BroadcastChannel("fusion.revoke-uncertain.v1"); }
    catch { return; }
    revokeChannel.current = channel;
    const send = (message: unknown) => { try { channel.postMessage(message); } catch { /* other tabs may be stale */ } };
    channel.onmessage = event => {
      const value = event.data as { type?: unknown; ids?: unknown } | null;
      if (!value || typeof value !== "object") return;
      if (value.type === "request") {
        broadcastRevokeMarkers(channel, getRevokeMarkers());
      } else if (value.type === "markers" && Array.isArray(value.ids) && value.ids.length <= 100) {
        const ids = value.ids.filter((id: unknown): id is string => typeof id === "string" && /^[0-9a-z]{8}$/.test(id));
        addRevokeMarkers(ids);
        try { for (const id of ids) sessionStorage.setItem(revokeMarkerKey(id), "1"); }
        catch { setMarkerStorageError(true); }
      }
    };
    send({ type: "request" });
    // Cover rehydration that completed before this channel was installed.
    broadcastRevokeMarkers(channel, getRevokeMarkers());
    return () => { if (revokeChannel.current === channel) revokeChannel.current = null; channel.close(); };
  }, []);

  const wanted = [scopes.run ? "run" : null, scopes.read ? "read" : null].filter(Boolean) as string[];
  const needle = query.trim().toLowerCase();
  const matching = needle ? rows.filter((t) => `${t.id} ${t.name} ${t.scopes.join(" ")} ${t.revoked ? "revoked" : "live"}`.toLowerCase().includes(needle)) : rows;
  const pageSize = 8;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matching.length / pageSize) - 1));
  const visible = matching.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const uncertainLiveCount = rows.filter(r => !r.revoked && uncertainRevokes.includes(r.id)).length;
  return (
    <Section title="External entry points (AU-03)" icon="sliders" right={<Badge tone={uncertainLiveCount ? "warn" : listLoaded && !listError && rows.some((r) => !r.revoked) ? "ok" : "default"}>{listLoaded ? `${rows.filter((r) => !r.revoked).length} live${uncertainLiveCount ? ` · ${uncertainLiveCount} uncertain` : ""}${listError ? " · stale" : listLoading ? " · updating" : ""}` : listLoading ? "Loading" : "Unavailable"}</Badge>}>
      <div className="fs-dim" style={{ fontSize: fz(11) }}>
        A script POSTs commands to <span className="fs-mono">/api/automation</span> with a bearer token; this window executes them. Other tabs may be out of date.
      </div>
      <div className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <input className="fs-input" style={{ width: fz(160) }} value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" />
        <label className="fs-row" style={{ gap: 4, fontSize: fz(11.5) }}>
          <input type="checkbox" checked={scopes.run} onChange={(e) => setScopes({ ...scopes, run: e.target.checked })} /> run
        </label>
        <label className="fs-row" style={{ gap: 4, fontSize: fz(11.5) }}>
          <input type="checkbox" checked={scopes.read} onChange={(e) => setScopes({ ...scopes, read: e.target.checked })} /> read
        </label>
        <Btn variant="primary" disabled={!wanted.length || minting || Boolean(fresh)} data-testid="automation-mint" onClick={async () => {
          if (mintLock.current) return;
          mintLock.current = true; setMinting(true); setErr("");
          let created = false;
          const focusVersion = interactionVersion.current;
          const controller = new AbortController();
          let timedOut = false;
          const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 12000);
          try {
            let r: { id: string; token: string; example: string };
            try {
              r = await api("/api/automation/tokens", { method: "POST", body: JSON.stringify({ name, scopes: wanted }), signal: controller.signal });
              if (controller.signal.aborted) throw new Error("Creation request timed out.");
            } finally { clearTimeout(timer); }
            created = true;
            setFresh({ token: r.token, example: r.example });
            if (focusVersion === interactionVersion.current) setQuery("");
            await load(r.id, focusVersion);
          } catch (e) {
            setErr(`Creation failed or the response was lost; a token may have been created. Check the token list before retrying. ${timedOut ? "Creation request timed out." : String((e as Error).message)}`);
            await load();
          } finally { if (!created) mintLock.current = false; setMinting(false); }
        }}>Create token</Btn>
      </div>
      {fresh ? (
        <div className="fs-panel" style={{ padding: 8, display: "grid", gap: 6, borderColor: "rgba(255,196,83,.4)" }}>
          <div style={{ fontSize: fz(11.5) }}>Copy it now — only a hash is stored, so it cannot be shown again.</div>
          <code className="fs-mono" style={{ fontSize: fz(10.5), wordBreak: "break-all" }} data-testid="automation-token">{fresh.token}</code>
          <div className="fs-row" style={{ gap: 6 }}>
            <Btn variant="ghost" onClick={() => shell.copy(fresh.token, "Routines", true)}>Copy token</Btn>
            <Btn variant="ghost" onClick={() => shell.copy(fresh.example, "Routines", true)}>Copy curl example</Btn>
            <Btn variant="ghost" onClick={() => { setFresh(null); mintLock.current = false; }}>Done with token</Btn>
          </div>
        </div>
      ) : null}
      {err ? <Badge tone="bad">{err}</Badge> : null}
      {minting && err ? <div role="status" data-testid="automation-mint-refresh" className="fs-dim">Checking the token list before retry is available…</div> : null}
      {Object.entries(revokeErrors).map(([id, message]) => <div key={id} role="alert" data-testid={`automation-revoke-error-${id}`} className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span>{message}</span>
        <Btn variant="ghost" aria-label={`Dismiss revocation warning for ${id}`} onClick={() => setRevokeErrors(previous => { const next = { ...previous }; delete next[id]; return next; })}>Dismiss</Btn>
      </div>)}
      {markerStorageError ? <div role="alert" data-testid="automation-marker-storage-error">Token uncertainty cannot be saved in this tab; reloading may lose it.</div> : null}
      {listError ? <div role="alert" data-testid="automation-list-error" className="fs-row" style={{ gap: 6, flexWrap: "wrap" }}>
        <span>{listLoaded ? "Token list may be out of date." : "Token list unavailable."} {listError}</span>
        <Btn variant="ghost" aria-label="Retry token list" disabled={listLoading} onClick={() => void load()}>Retry</Btn>
      </div> : null}
      {listLoaded && !listLoading && !listError && rows.length === 0 ? <div className="fs-dim" style={{ fontSize: fz(11.5) }}>No tokens. Nothing outside this window can run a command.</div> : null}
      {rows.length ? <input className="fs-input" type="search" aria-label="Search automation tokens" placeholder="Search tokens" value={query} onChange={e => { interactionVersion.current++; setQuery(e.target.value); setPage(0); }} /> : null}
      {matching.length ? <div className="fs-row" style={{ gap: 6 }}>
        <Btn variant="ghost" aria-label="Previous token page" disabled={currentPage === 0} onClick={() => { interactionVersion.current++; setPage(currentPage - 1); }}>Previous</Btn>
        <span role="status" className="fs-dim">{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, matching.length)} of {matching.length}</span>
        <Btn variant="ghost" aria-label="Next token page" disabled={(currentPage + 1) * pageSize >= matching.length} onClick={() => { interactionVersion.current++; setPage(currentPage + 1); }}>Next</Btn>
      </div> : rows.length ? <div className="fs-dim">No matching tokens</div> : null}
      <div data-testid="automation-token-list">
      {visible.map((t) => (
        <div key={t.id} data-token-id={t.id} className="fs-row" style={{ justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontSize: fz(11.5), minWidth: 0 }}>
            <span className="fs-mono">{t.id}</span> {t.name} <span className="fs-dim">· {t.scopes.join(", ")}{t.lastUsedAt ? ` · used ${fmtTime(t.lastUsedAt)}` : ""}</span>
          </span>
          <Badge data-testid="automation-token-state" tone={t.revoked ? "bad" : uncertainRevokes.includes(t.id) ? "warn" : "ok"} title={!t.revoked && uncertainRevokes.includes(t.id) ? "Last seen live; the revocation may still complete." : undefined}>{t.revoked ? "revoked" : uncertainRevokes.includes(t.id) ? <>last seen <span>live</span> · uncertain</> : "live"}</Badge>
          {t.revoked ? null : (
            <Btn variant="ghost" disabled={revoking.includes(t.id)} onClick={async () => {
              if (revokeLocks.current.has(t.id)) return;
              revokeLocks.current.add(t.id); setRevoking(previous => [...previous, t.id]);
              addRevokeMarkers([t.id]);
              try { revokeChannel.current?.postMessage({ type: "markers", ids: [t.id] }); } catch { /* other tabs may be stale */ }
              // Persist synchronously before sending; a reload can happen while
              // the DELETE is still in flight, including before its timeout.
              try { sessionStorage.setItem(revokeMarkerKey(t.id), "1"); }
              catch { setMarkerStorageError(true); }
              setRevokeErrors(previous => { const next = { ...previous }; delete next[t.id]; return next; });
              const controller = new AbortController();
              const timer = setTimeout(() => controller.abort(), 12000);
              try {
                const response = await fetch(`/api/automation/tokens?id=${encodeURIComponent(t.id)}`, { method: "DELETE", signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const result = await response.json() as { ok?: boolean };
                if (controller.signal.aborted || result.ok !== true) throw new Error("invalid or timed-out revocation response");
              } catch {
                // Aborting the client does not roll back a request the server received.
                setRevokeErrors(previous => ({ ...previous, [t.id]: `Revocation not confirmed for token ${t.id}. Check its current status before retrying.${controller.signal.aborted ? " Request timed out." : ""}` }));
              } finally {
                clearTimeout(timer);
                await load();
                revokeLocks.current.delete(t.id); setRevoking(previous => previous.filter(id => id !== t.id));
              }
            }}>Revoke</Btn>
          )}
        </div>
      ))}
      </div>
    </Section>
  );
}
