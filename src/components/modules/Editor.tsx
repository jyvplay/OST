"use client";
import { AppBanner, BannerGroup } from "@/components/AppBanner";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, fmtTime, post } from "@/lib/api";
import { formatFor, lossReport, parseCsv, sanitizeSvg } from "@/lib/forge";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";
import { askText } from "@/lib/ask";
import { RecoveryBanner, useDocLifecycle, useRecoveryOffer } from "../doc-lifecycle-ui";

interface Version { id: number; version: number; size: number; sha256: string; createdAt: string; content: string }

/**
 * PR-01 + FF-15 document lifecycle.
 * Autosave writes through the journal and snapshots a version, so "autosave"
 * never means "irreversibly overwrote". Recovery drafts (TT69: the shared FF-15 lifecycle) go to
 * /System/Recovery/editor_<path>.draft — /Private/.Recovery for private files, so the privacy layer encrypts them —
 * on a debounce, survive a tab death even if you later discard changes, and are offered back on the next open.
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

  const savedHook = useRef<(p: string) => Promise<void>>(async () => undefined);
  const save = useCallback(async (): Promise<boolean> => {
    if (!path) { shell.toast("This buffer has no path. Use Save as…", "warn"); return false; }
    try {
      const r = await post<{ sha256: string; size: number }>("/api/fs", { op: "write", path, content: text, reason: "editor" });
      setDirty(false);
      await savedHook.current(path).catch(() => undefined);
      setStatus(`saved · sha ${r.sha256.slice(0, 10)} · ${r.size} B`);
      const v = await api<{ versions: Version[] }>(`/api/fs?op=versions&path=${encodeURIComponent(path)}`);
      setVersions(v.versions.reverse());
      shell.bumpRefresh();
      return true;
    } catch (e) {
      shell.toast(`Save failed: ${String((e as Error).message)} — the original file is untouched.`, "bad");
      return false;
    }
  }, [path, text, shell]);
  const life = useDocLifecycle({
    winId: win.id, kind: "editor", path, dirty, version: text, title: path.split("/").pop() || "Untitled",
    recoverable: true, save, makeDraft: async () => ({ encoding: "utf8", payload: text }),
  });
  useEffect(() => { savedHook.current = life.saved; }, [life.saved]);
  const recovery = useRecoveryOffer("editor", path, loaded && !!path);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // TT69: scoped to THIS window (was every window: Ctrl+S in a Spreadsheet, another Editor, or under the Save dialog saved it)
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.(`[data-editor-win="${win.id}"]`)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); void save(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, win.id]);

  /** TT80: the banner is present in every state, so an empty buffer still offers Keep commands */
  const banner = (
  <AppBanner label="Editor" status={<>
      {fmt ? <Badge tone={fmt.grade === "A" ? "ok" : "info"} title={fmt.boundary}>{fmt.label} · grade {fmt.grade}</Badge> : null}
      {dirty ? <Badge tone="warn">unsaved</Badge> : <Badge tone="ok">saved</Badge>}
      <span className="fs-dim" style={{ fontSize: fz(11) }}>{status}</span>
  </>}>
    <BannerGroup name="Keep">
      <Btn variant="ghost" onClick={() => shell.open("files", { path: "/Documents" })} title="Open a text, Markdown, HTML, SVG or CSV file">Open in Files…</Btn>
      <Btn variant="primary" onClick={() => void save()} disabled={!dirty}>Save</Btn>
      <Btn variant="ghost" onClick={async () => {
      const name = await askText("Save a copy as (path)", path, { okLabel: "Save copy", validate: (v) => (v.trim().startsWith("/") ? null : "Use a full path that starts with /") });
      if (!name) return;
      const rep = lossReport(path, name.split(".").pop() ?? "");
      if (!rep.safe && !confirm(`Converting ${rep.from} → ${rep.to} drops:\n\n• ${rep.drops.join("\n• ")}\n\nContinue?`)) return;
      await post("/api/fs", { op: "write", path: name, content: text, reason: "save-as" });
      shell.toast(`Saved a copy to ${name}`, "ok");
      shell.bumpRefresh();
      }}>Save as…</Btn>
      <Btn variant={preview ? "primary" : "ghost"} aria-pressed={preview} onClick={() => setPreview((p) => !p)}>Preview</Btn>
      <Btn variant="ghost" onClick={() => shell.open("peek", { path, title: win.title })}>Peek</Btn>
    </BannerGroup>
  </AppBanner>
  );
  const wrap = (body: ReactNode) => <div data-editor-win={win.id} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>{banner}{body}</div>;
  if (!loaded) return wrap(<Empty title="Loading…" icon="⏳" />);
  if (!path) return wrap(<Empty title="No document" icon="📝" hint="Open a file from Files, or use the palette." />);

  const svg = fmt?.ext.includes("svg") ? sanitizeSvg(text) : null;
  const csv = fmt?.ext.includes("csv") ? parseCsv(text).slice(0, 60) : null;

  return (
    <div data-editor-win={win.id} style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* the banner is rendered by `wrap`; the document area follows */}
      <RecoveryBanner offer={recovery.offer} onDiscard={() => void recovery.discard()} onRestore={() => {
        const o = recovery.take(); if (!o) return;
        setText(o.draft.payload); setDirty(true);
        setStatus(`restored the recovery draft from ${o.at} — not saved yet${o.stale ? " (the file had changed since the draft)" : ""}`);
      }} />


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
