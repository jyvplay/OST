"use client";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { evaluate } from "@/lib/calc";
import { fuzzyScore } from "@/lib/fuzzy";
import { parsePaletteAction, PALETTE_ACTION_LIMIT } from "@/lib/palette-actions";
import { privacy } from "@/lib/privacy/session";
import { validateActions } from "@/lib/routines";
import { MODULES } from "@/lib/registry";
import { useShell } from "./shell-context";
import { Badge } from "./ui";
import { AppIcon, FileIcon } from "./AppIcon";

interface Row { id: string; label: string; icon?: ReactNode; sub?: string; source: string; run: () => void; rank: number }
interface RoutineRow { id: number; name: string; enabled: boolean; actions: unknown }
interface SearchHit { source: string; ref: string; title: string; snippet: string; how: string }

/**
 * SR-01/SR-06. Search queries go to the configured app backend, not a bundled
 * third-party provider. Actions scope does not send the typed command to the
 * search endpoint; state-changing actions require explicit selection.
 */
export default function Palette({ onClose }: { onClose: () => void }) {
  const shell = useShell();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "apps" | "files" | "notes" | "spec" | "settings" | "actions">("all");
  const [search, setSearch] = useState<{ key: string; hits: SearchHit[]; took: number | null }>({ key: "", hits: [], took: null });
  const [routines, setRoutines] = useState<RoutineRow[]>([]);
  const [routineError, setRoutineError] = useState("");
  const [amnesic, setAmnesic] = useState(false);
  const [selection, setSelection] = useState<{ key: string; index: number }>({ key: "", index: 0 });
  const searchKey = `${scope}\0${q}`;
  const took = search.key === searchKey && scope !== "actions" ? search.took : null;
  const sel = selection.key === searchKey ? selection.index : 0;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const busy = useRef(false), mounted = useRef(false);

  useEffect(() => { mounted.current = true; inputRef.current?.focus(); return () => { mounted.current = false; }; }, []);
  useEffect(() => privacy.subscribe((status) => setAmnesic(status.amnesic)), []);

  useEffect(() => {
    if (!q.trim() || scope === "actions") return;
    const abort = new AbortController(); let active = true;
    const t = window.setTimeout(() => {
      const src = scope === "files" ? "file" : scope === "notes" ? "note" : scope === "spec" ? "spec" : scope === "settings" ? "setting" : "";
      api<{ hits: SearchHit[]; tookMs: number }>(`/api/search?q=${encodeURIComponent(q)}${src ? `&source=${src}` : ""}`, { signal: abort.signal })
        .then((r) => { if (active) setSearch({ key: searchKey, hits: r.hits, took: r.tookMs }); })
        .catch(() => { if (active) setSearch({ key: searchKey, hits: [], took: null }); });
    }, 90);
    return () => { active = false; window.clearTimeout(t); abort.abort(); };
  }, [q, scope, searchKey]);

  const command = scope === "actions" ? parsePaletteAction(q) : null;
  useEffect(() => {
    if (scope !== "actions" || command?.kind !== "routine" || amnesic || !privacy.status().installed || privacy.status().amnesic) return;
    const abort = new AbortController(); let active = true;
    // Only the fixed endpoint is requested; the typed routine filter stays in the tab.
    api<{ rows: RoutineRow[] }>("/api/routines", { signal: abort.signal })
      .then((r) => { if (active) { setRoutines(Array.isArray(r.rows) ? r.rows : []); setRoutineError(""); } })
      .catch(() => { if (active) { setRoutines([]); setRoutineError("Routines could not be loaded."); } });
    return () => { active = false; abort.abort(); };
  }, [scope, command?.kind, amnesic]);

  const createNote = useCallback(async (text: string) => {
    if (busy.current) return;
    if (!privacy.status().installed || privacy.status().amnesic) { shell.toast("Amnesic session: this note was not saved to the host.", "warn"); return; }
    busy.current = true;
    try {
      // Do not use the offline queue: a failed/unknown POST must not silently
      // persist the typed note in unencrypted browser storage or be retried.
      const r = await api<{ row: { id: number } }>("/api/notes", { method: "POST", body: JSON.stringify({ title: text.slice(0, 80) || "Untitled", body: text }) });
      if (!Number.isSafeInteger(r.row?.id) || r.row.id <= 0) throw new Error("missing note id");
      shell.bumpRefresh();
      if (mounted.current) { shell.open("notes", { noteId: r.row.id }); onClose(); }
      else shell.toast("Note created; open Notes to view it.", "ok");
    } catch {
      shell.toast("Could not confirm the note save; it may already have been created. Check Notes before retrying.", "warn");
    } finally { busy.current = false; }
  }, [onClose, shell]);

  const runRoutine = useCallback(async (id: number) => {
    if (busy.current) return;
    if (!privacy.status().installed || privacy.status().amnesic) { shell.toast("Saved routines are unavailable in an amnesic session.", "warn"); return; }
    busy.current = true;
    try {
      // Re-read by id on selection: a stale result cannot run a removed or disabled routine.
      const list = await api<{ rows: RoutineRow[] }>("/api/routines");
      const current = list.rows.find((row) => row.id === id && row.enabled === true);
      if (!current || privacy.status().amnesic) { shell.toast("Routine is no longer available; nothing was run.", "warn"); return; }
      const actions = validateActions(current.actions);
      if (!mounted.current) return;
      onClose();
      try {
        await shell.runActions(actions);
        try {
          await api("/api/routines", { method: "POST", body: JSON.stringify({ ranId: id }) });
          shell.toast("Routine actions issued; individual actions may have been refused.", "info");
        } catch { shell.toast("Routine actions were issued, but the audit record could not be confirmed.", "warn"); }
      } catch { shell.toast("Routine may have partially run; inspect the workspace before retrying.", "warn"); }
    } catch { shell.toast("Routine could not be loaded or validated; nothing was run.", "warn"); }
    finally { busy.current = false; }
  }, [onClose, shell]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const needle = q.trim().toLowerCase();

    if (scope === "all" || scope === "apps") {
      for (const m of MODULES) {
        if (!needle || m.title.toLowerCase().includes(needle) || m.summary.toLowerCase().includes(needle) || fuzzyScore(needle, m.title) !== null) {
          out.push({ id: `m_${m.id}`, label: m.title, icon: <AppIcon id={m.id} size={18} />, sub: m.summary, source: "module registry", rank: 100, run: () => { shell.open(m.id); onClose(); } });
        }
      }
    }

    if (needle && (scope === "all")) {
      for (const w of shell.state.windows) {
        if (w.title.toLowerCase().includes(needle)) {
          out.push({ id: `w_${w.id}`, label: w.title, icon: <AppIcon id={w.module} size={18} />, sub: `window · ${w.module}`, source: "open windows", rank: 95, run: () => { shell.dispatch({ t: "restore", id: w.id }); onClose(); } });
        }
      }
    }

    // live computation (same evaluator as the Calculator module)
    if (needle && /[0-9]/.test(needle)) {
      const r = evaluate(q);
      if (r.ok) out.push({ id: "calc", label: `= ${r.text}`, sub: r.detail ?? "calculated locally", source: "evaluator", rank: 120, run: () => { void shell.copy(r.text, "palette"); onClose(); } });
    }

    if (scope === "actions") {
      if (!needle || command?.kind === "note") {
        const text = command?.kind === "note" ? command.text : "";
        // The callback reads refs only when the user selects the row, never during render.
        // eslint-disable-next-line react-hooks/refs
        out.push({ id: "note", label: text ? `Create note: ${text.slice(0, 100)}` : "Create empty note", sub: amnesic ? "Unavailable in an amnesic session" : "Saves to Notes and its search index only after selection", source: "action · host Notes", rank: 110, run: () => { void createNote(text); } });
      }
      if (!needle || command?.kind === "focus") {
        const mode = command?.kind === "focus" ? command.mode : "toggle";
        const next = mode === "toggle" ? !shell.state.focusMode : mode === "on";
        out.push({ id: "focus", label: `Turn focus mode ${next ? "on" : "off"}`, sub: "Changes this shell's focus mode", source: "action · shell", rank: 105, run: () => { shell.dispatch({ t: "focusMode", on: next }); onClose(); } });
      }
      if (command?.kind === "setting") out.push({ id: "setting", label: `Open settings: ${command.query}`, sub: "Opens the Settings graph with this filter", source: "action · settings", rank: 105, run: () => { shell.open("settings", { focus: command.query }); onClose(); } });
      if (command?.kind === "routine" && !amnesic) {
        for (const routine of routines.filter((r) => r.enabled === true && Number.isSafeInteger(r.id) && typeof r.name === "string" && r.name.toLowerCase().includes(command.query.toLowerCase())).slice(0, 40)) {
          // The callback reads refs only when the user selects the row, never during render.
          // eslint-disable-next-line react-hooks/refs
          out.push({ id: `routine:${routine.id}`, label: `Run routine: ${routine.name}`, sub: "Runs the saved action sequence only when selected", source: "action · routine", rank: 105, run: () => { void runRoutine(routine.id); } });
        }
      }
    }

    for (const h of scope !== "actions" && search.key === searchKey ? search.hits : []) {
      const icon = h.source === "file" ? <FileIcon name={h.title} size={18} /> : <AppIcon id={h.source === "note" ? "notes" : h.source === "spec" ? "spec" : "settings"} size={18} />;
      out.push({
        id: `${h.source}_${h.ref}`,
        label: h.title, icon,
        sub: h.snippet?.slice(0, 110),
        source: `index · ${h.source} · ${h.how}`,
        rank: h.how === "fts" ? 80 : 60,
        run: () => {
          if (h.source === "file") shell.open("editor", { path: h.ref, title: h.title });
          else if (h.source === "note") shell.open("notes", { noteId: Number(h.ref) });
          else if (h.source === "spec") shell.open("spec", { focus: h.ref });
          else shell.open("settings", { focus: h.ref });
          onClose();
        },
      });
    }

    // SR-04: opt-in web search. Off by default; when on, it is a single explicit
    // row ranked BELOW every local result, and nothing is fetched while typing —
    // the query only leaves the device when the user picks this row.
    const webTpl = shell.settings["search.webProvider"] ?? "";
    if (scope !== "actions" && needle && (shell.settings["search.webResults"] ?? "off") === "on" && webTpl.includes("%s")) {
      out.push({
        id: "web", label: `Search the web for “${q}”`, icon: <AppIcon id="browser" size={18} />, sub: webTpl.replace("%s", encodeURIComponent(q)),
        source: "web (opt-in) · sent only on click", rank: -1,
        run: () => { shell.open("browser", { url: webTpl.replace("%s", encodeURIComponent(q)), title: `Web: ${q}` }); onClose(); },
      });
    }

    // SH-01: every registered app stays reachable — the 40-row cap applies to the other sources only (it used to cut
    // the "apps" scope at 40 of 43 modules)
    let others = 0;
    // TT58 (SR-04): the opt-in web row is exempt too — it ranks last, so the cap used to cut it whenever a query had
    // more than 40 local hits, silently hiding the one explicit way to search the web
    return out.sort((a, b) => b.rank - a.rank).filter((r) => r.id.startsWith("m_") || r.id === "web" || ++others <= 40);
  }, [q, scope, search, searchKey, shell, onClose, command, amnesic, routines, createNote, runRoutine]);

  const selected = Math.min(sel, Math.max(0, rows.length - 1));

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 9600, background: "rgba(4,8,18,.5)" }} onClick={onClose}>
      <div className="fs-panel" role="dialog" aria-label="Command palette"
        style={{ width: "min(720px, 92%)", margin: "6vh auto 0", padding: 10, display: "grid", gap: 8 }}
        onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="fs-input" placeholder="Search modules, files, notes, settings, the spec — or type a calculation"
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // IME uses Enter/arrows to commit or navigate a candidate; never run
            // an action for a composition keystroke (229 covers older engines).
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setSelection({ key: searchKey, index: Math.min(selected + 1, Math.max(0, rows.length - 1)) }); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSelection({ key: searchKey, index: Math.max(selected - 1, 0) }); }
            if (e.key === "Enter") { e.preventDefault(); rows[selected]?.run(); }
          }} />

        <div className="fs-row fs-palette-scopes" style={{ gap: 4, flexWrap: "wrap" }}>
          {(["all", "apps", "files", "notes", "spec", "settings", "actions"] as const).map((s) => (
            <button key={s} className="fs-btn" data-variant={scope === s ? "primary" : "ghost"} aria-pressed={scope === s}
              style={{ minHeight: 22, padding: "0 8px" }} onClick={() => setScope(s)}>{s}</button>
          ))}
          <div style={{ flex: 1 }} />
          {took !== null ? <Badge tone="info">index {took} ms</Badge> : null}
          <Badge title="No third-party web provider is bundled. Normal search queries go to the app backend.">no bundled web search</Badge>
        </div>
        {scope === "actions" ? <div className="fs-dim" style={{ fontSize: fz(11) }}>
          Actions do not send typed commands to search. Try “note text”, “focus on”, “focus off”, “setting appearance.theme” or “run name”. Notes are sent to the host only when selected; saved routines load from the host. {amnesic ? "Host notes and routines are unavailable in this amnesic session." : ""} {command?.kind === "routine" ? routineError : ""}
          {q.length > PALETTE_ACTION_LIMIT ? ` Commands are limited to ${PALETTE_ACTION_LIMIT} characters.` : ""}
        </div> : null}

        <div className="fs-scroll" style={{ maxHeight: "52vh" }}>
          {rows.map((r, i) => (
            <button key={r.id} className="fs-list-item" data-palette-action={r.id} data-selected={i === selected}
              style={{ width: "100%", textAlign: "left", background: i === selected ? "rgba(91,140,255,.22)" : undefined, border: 0, color: "inherit" }}
              onMouseEnter={() => setSelection({ key: searchKey, index: i })} onClick={r.run}>
              {r.icon ?? <span aria-hidden style={{ width: fz(18), flex: "0 0 auto", textAlign: "center", fontWeight: 800 }}>=</span>}
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: fz(12.5) }}>{r.label}</div>
                {r.sub ? <div className="fs-dim" style={{ fontSize: fz(11), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</div> : null}
              </span>
              <Badge>{r.source}</Badge>
            </button>
          ))}
          {q && rows.length === 0 ? <div className="fs-dim" style={{ padding: 12, fontSize: fz(12) }}>{scope === "actions" ? "No matching action or enabled routine." : "No local matches. Search diagnostics live in Find → Diagnostics."}</div> : null}
        </div>
      </div>
    </div>
  );
}
