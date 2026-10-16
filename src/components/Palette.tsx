"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { evaluate } from "@/lib/calc";
import { fuzzyScore } from "@/lib/fuzzy";
import { MODULES } from "@/lib/registry";
import { useShell } from "./shell-context";
import { Badge } from "./ui";

interface Row { id: string; label: string; sub?: string; source: string; run: () => void; rank: number }

/**
 * SR-01. Provenance is rendered on every row (local index, module registry,
 * settings graph, live computation) and local rows always sort above anything
 * remote. There is no bundled web provider, so by default nothing leaves the
 * device when you type.
 */
export default function Palette({ onClose }: { onClose: () => void }) {
  const shell = useShell();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "apps" | "files" | "notes" | "spec" | "settings">("all");
  const [hits, setHits] = useState<{ source: string; ref: string; title: string; snippet: string; how: string }[]>([]);
  const [took, setTook] = useState<number | null>(null);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (!q.trim()) { setHits([]); setTook(null); return; }
    const t = window.setTimeout(() => {
      const src = scope === "files" ? "file" : scope === "notes" ? "note" : scope === "spec" ? "spec" : scope === "settings" ? "setting" : "";
      api<{ hits: typeof hits; tookMs: number }>(`/api/search?q=${encodeURIComponent(q)}${src ? `&source=${src}` : ""}`)
        .then((r) => { setHits(r.hits); setTook(r.tookMs); })
        .catch(() => setHits([]));
    }, 90);
    return () => window.clearTimeout(t);
  }, [q, scope]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = [];
    const needle = q.trim().toLowerCase();

    if (scope === "all" || scope === "apps") {
      for (const m of MODULES) {
        if (!needle || m.title.toLowerCase().includes(needle) || m.summary.toLowerCase().includes(needle) || fuzzyScore(needle, m.title) !== null) {
          out.push({ id: `m_${m.id}`, label: `${m.icon}  ${m.title}`, sub: m.summary, source: "module registry", rank: 100, run: () => { shell.open(m.id); onClose(); } });
        }
      }
    }

    if (needle && (scope === "all")) {
      for (const w of shell.state.windows) {
        if (w.title.toLowerCase().includes(needle)) {
          out.push({ id: `w_${w.id}`, label: `🪟  ${w.title}`, sub: `window · ${w.module}`, source: "open windows", rank: 95, run: () => { shell.dispatch({ t: "restore", id: w.id }); onClose(); } });
        }
      }
    }

    // live computation (same evaluator as the Calculator module)
    if (needle && /[0-9]/.test(needle)) {
      const r = evaluate(q);
      if (r.ok) out.push({ id: "calc", label: `= ${r.text}`, sub: r.detail ?? "calculated locally", source: "evaluator", rank: 120, run: () => { void shell.copy(r.text, "palette"); onClose(); } });
    }

    for (const h of hits) {
      const icon = h.source === "file" ? "📄" : h.source === "note" ? "🗒" : h.source === "spec" ? "📋" : "⚙️";
      out.push({
        id: `${h.source}_${h.ref}`,
        label: `${icon}  ${h.title}`,
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
    if (needle && (shell.settings["search.webResults"] ?? "off") === "on" && webTpl.includes("%s")) {
      out.push({
        id: "web", label: `🌐  Search the web for “${q}”`, sub: webTpl.replace("%s", encodeURIComponent(q)),
        source: "web (opt-in) · sent only on click", rank: -1,
        run: () => { shell.open("browser", { url: webTpl.replace("%s", encodeURIComponent(q)), title: `Web: ${q}` }); onClose(); },
      });
    }

    return out.sort((a, b) => b.rank - a.rank).slice(0, 40);
  }, [q, scope, hits, shell, onClose]);

  useEffect(() => setSel(0), [q, scope]);

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 9600, background: "rgba(4,8,18,.5)" }} onClick={onClose}>
      <div className="fs-panel" role="dialog" aria-label="Command palette"
        style={{ width: "min(720px, 92%)", margin: "6vh auto 0", padding: 10, display: "grid", gap: 8 }}
        onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="fs-input" placeholder="Search modules, files, notes, settings, the spec — or type a calculation"
          value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, rows.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter") { e.preventDefault(); rows[sel]?.run(); }
          }} />

        <div className="fs-row" style={{ gap: 4, flexWrap: "wrap" }}>
          {(["all", "apps", "files", "notes", "spec", "settings"] as const).map((s) => (
            <button key={s} className="fs-btn" data-variant={scope === s ? "primary" : "ghost"}
              style={{ minHeight: 22, padding: "0 8px" }} onClick={() => setScope(s)}>{s}</button>
          ))}
          <div style={{ flex: 1 }} />
          {took !== null ? <Badge tone="info">index {took} ms</Badge> : null}
          <Badge title="No web provider is bundled; nothing leaves the device unless you enable one.">local only</Badge>
        </div>

        <div className="fs-scroll" style={{ maxHeight: "52vh" }}>
          {rows.map((r, i) => (
            <button key={r.id} className="fs-list-item" data-selected={i === sel}
              style={{ width: "100%", textAlign: "left", background: i === sel ? "rgba(91,140,255,.22)" : undefined, border: 0, color: "inherit" }}
              onMouseEnter={() => setSel(i)} onClick={r.run}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5 }}>{r.label}</div>
                {r.sub ? <div className="fs-dim" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.sub}</div> : null}
              </span>
              <Badge>{r.source}</Badge>
            </button>
          ))}
          {q && rows.length === 0 ? <div className="fs-dim" style={{ padding: 12, fontSize: 12 }}>No local matches. Search diagnostics live in Find → Diagnostics.</div> : null}
        </div>
      </div>
    </div>
  );
}
