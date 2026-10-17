"use client";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtTime, post } from "@/lib/api";
import { formatFor, lossReport, parseCsv, sanitizeSvg } from "@/lib/forge";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";

interface Version { id: number; version: number; size: number; sha256: string; createdAt: string; content: string }

/**
 * PR-01 + FF-15 document lifecycle.
 * Autosave writes through the journal and snapshots a version, so "autosave"
 * never means "irreversibly overwrote". Recovery drafts go to /System/Recovery
 * on a debounce and survive a tab death even if you later discard changes.
 */
export default function EditorModule({ win }: ModuleProps) {
  const shell = useShell();
  const path = (win.props.path as string) ?? "";
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [versions, setVersions] = useState<Version[]>([]);
  const [preview, setPreview] = useState(false);
  const [status, setStatus] = useState("");
  const draftTimer = useRef<number | null>(null);
  const fmt = formatFor(path);

  useEffect(() => {
    if (!path) { setLoaded(true); return; }
    api<{ node: { content: string; encoding: string } }>(`/api/fs?op=read&path=${encodeURIComponent(path)}`)
      .then((r) => {
        setText(r.node.encoding === "base64" ? "[binary file — open it in Peek]" : r.node.content);
        setLoaded(true);
      })
      .catch((e) => { setStatus(String((e as Error).message)); setLoaded(true); });
    api<{ versions: Version[] }>(`/api/fs?op=versions&path=${encodeURIComponent(path)}`)
      .then((r) => setVersions(r.versions.reverse()))
      .catch(() => undefined);
  }, [path]);

  // recovery draft (FF-15)
  useEffect(() => {
    if (!dirty || !path) return;
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      void post("/api/fs", {
        op: "write", path: `/System/Recovery${path.replace(/\//g, "_")}.draft`, content: text, reason: "recovery-draft",
      }).catch(() => undefined);
    }, 2000);
  }, [text, dirty, path]);

  const save = useCallback(async () => {
    if (!path) { shell.toast("This buffer has no path. Use Save as…", "warn"); return; }
    try {
      const r = await post<{ sha256: string; size: number }>("/api/fs", { op: "write", path, content: text, reason: "editor" });
      setDirty(false);
      setStatus(`saved · sha ${r.sha256.slice(0, 10)} · ${r.size} B`);
      const v = await api<{ versions: Version[] }>(`/api/fs?op=versions&path=${encodeURIComponent(path)}`);
      setVersions(v.versions.reverse());
      shell.bumpRefresh();
    } catch (e) {
      shell.toast(`Save failed: ${String((e as Error).message)} — the original file is untouched.`, "bad");
    }
  }, [path, text, shell]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  if (!loaded) return <Empty title="Loading…" icon="⏳" />;
  if (!path) return <Empty title="No document" icon="📝" hint="Open a file from Files, or use the palette." />;

  const svg = fmt?.ext.includes("svg") ? sanitizeSvg(text) : null;
  const csv = fmt?.ext.includes("csv") ? parseCsv(text).slice(0, 60) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="fs-row" style={{ padding: 6, gap: 4, borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }}>
        <Btn variant="primary" onClick={() => void save()} disabled={!dirty}>Save</Btn>
        <Btn variant="ghost" onClick={async () => {
          const name = prompt("Save as (path)", path);
          if (!name) return;
          const rep = lossReport(path, name.split(".").pop() ?? "");
          if (!rep.safe && !confirm(`Converting ${rep.from} → ${rep.to} drops:\n\n• ${rep.drops.join("\n• ")}\n\nContinue?`)) return;
          await post("/api/fs", { op: "write", path: name, content: text, reason: "save-as" });
          shell.toast(`Saved a copy to ${name}`, "ok");
          shell.bumpRefresh();
        }}>Save as…</Btn>
        <Btn variant={preview ? "primary" : "ghost"} onClick={() => setPreview((p) => !p)}>Preview</Btn>
        <Btn variant="ghost" onClick={() => shell.open("peek", { path, title: win.title })}>Peek</Btn>
        <div style={{ flex: 1 }} />
        {fmt ? <Badge tone={fmt.grade === "A" ? "ok" : "info"} title={fmt.boundary}>{fmt.label} · grade {fmt.grade}</Badge> : null}
        {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
        <span className="fs-dim" style={{ fontSize: fz(11) }}>{status}</span>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: preview ? "1fr 1fr" : "1fr" }}>
        <textarea className="fs-textarea" value={text} spellCheck={false}
          onChange={(e) => { setText(e.target.value); setDirty(true); }}
          style={{ border: 0, borderRadius: 0, height: "100%", resize: "none", padding: 10 }}
          aria-label={`Editing ${path}`} />
        {preview ? (
          <div className="fs-scroll" style={{ borderLeft: "1px solid var(--fs-border)", padding: 10, fontSize: fz(12.5), lineHeight: 1.6 }}>
            {svg ? (
              <>
                {svg.removed.length ? <Badge tone="warn" title={svg.removed.join(", ")}>sanitised: {svg.removed.join(", ")}</Badge> : <Badge tone="ok">sanitised</Badge>}
                <div dangerouslySetInnerHTML={{ __html: svg.svg }} />
              </>
            ) : csv ? (
              <table style={{ borderCollapse: "collapse", fontSize: fz(11.5) }}>
                <tbody>
                  {csv.map((row, i) => (
                    <tr key={i}>{row.map((cell, j) => (
                      <td key={j} style={{ border: "1px solid var(--fs-border)", padding: "2px 6px" }}>{cell}</td>
                    ))}</tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{renderMarkdown(text)}</pre>
            )}
          </div>
        ) : null}
      </div>

      <details style={{ borderTop: "1px solid var(--fs-border)", padding: "4px 8px" }}>
        <summary style={{ fontSize: fz(11.5), cursor: "pointer" }}>History — {versions.length} version(s)</summary>
        <div className="fs-scroll" style={{ maxHeight: 140, display: "grid", gap: 2, paddingTop: 6 }}>
          {versions.map((v) => (
            <div key={v.id} className="fs-row" style={{ justifyContent: "space-between" }}>
              <span className="fs-mono" style={{ fontSize: fz(11) }}>v{v.version} · {v.size} B · {v.sha256.slice(0, 10)}</span>
              <span className="fs-row" style={{ gap: 4 }}>
                <span className="fs-dim" style={{ fontSize: fz(11) }}>{fmtTime(v.createdAt)}</span>
                <Btn variant="ghost" onClick={() => { setText(v.content); setDirty(true); shell.toast(`Loaded v${v.version} into the buffer — save to apply.`, "info"); }}>Load</Btn>
              </span>
            </div>
          ))}
          {versions.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(11) }}>No previous versions yet.</span> : null}
        </div>
      </details>
    </div>
  );
}

/** Deliberately tiny: headings, bullets and code fences only, no HTML injection. */
function renderMarkdown(src: string): string {
  return src
    .split("\n")
    .map((line) => line.replace(/^### (.*)/, "▸ $1").replace(/^## (.*)/, "■ $1").replace(/^# (.*)/, "█ $1"))
    .join("\n");
}
