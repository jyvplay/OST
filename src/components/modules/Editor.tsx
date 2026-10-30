"use client";
import { AppBanner, BannerGroup } from "@/components/AppBanner";
import { UiGlyph } from "../AppIcon";
import { fz } from "@/lib/uiscale";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, fmtTime, post } from "@/lib/api";
import { formatFor, lossReport, parseCsv, sanitizeSvg } from "@/lib/forge";
import { useShell, type ModuleProps } from "../shell-context";
import { Badge, Btn, Empty } from "../ui";
import { diffLines, diffStats } from "@/lib/diff-core";
import { findMatches, replaceAll, replaceOne } from "@/lib/editor-find";
import { clampLine, offsetAtLine, docStats } from "@/lib/line-nav";
import { transformLines } from "@/lib/line-ops";
import { wrapStyle, readWrap, WRAP_KEY } from "@/lib/editor-wrap";
import { nextMatch } from "@/lib/match-nav";
import { indentSelection } from "@/lib/editor-indent";
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
  const [diffOf, setDiffOf] = useState<Version | null>(null);
  const [preview, setPreview] = useState(false);
  const [wrapOn, setWrapOn] = useState<boolean>(() => { try { return readWrap(window.localStorage); } catch { return false; } });
  const [status, setStatus] = useState("");
  const [findQ, setFindQ] = useState("");
  const [replQ, setReplQ] = useState("");
  const [caseSens, setCaseSens] = useState(false);
  const [findMsg, setFindMsg] = useState("");
  const [gotoLine, setGotoLine] = useState("");
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
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
      {banner}
      <RecoveryBanner offer={recovery.offer} onDiscard={() => void recovery.discard()} onRestore={() => {
        const o = recovery.take(); if (!o) return;
        setText(o.draft.payload); setDirty(true);
        setStatus(`restored the recovery draft from ${o.at} — not saved yet${o.stale ? " (the file had changed since the draft)" : ""}`);
      }} />


      <div className="fs-row" style={{ gap: 6, padding: "6px 8px", borderBottom: "1px solid var(--fs-border)", flexWrap: "wrap" }} data-testid="editor-findbar">
        <input className="fs-input" style={{ width: fz(150) }} placeholder="Find" aria-label="Find text" value={findQ} onChange={(e) => setFindQ(e.target.value)} />
        <input className="fs-input" style={{ width: fz(150) }} placeholder="Replace with" aria-label="Replace with" value={replQ} onChange={(e) => setReplQ(e.target.value)} />
        <Btn variant="ghost" aria-pressed={caseSens} onClick={() => setCaseSens((v) => !v)} title="Match case">Aa</Btn>
        <Btn variant="ghost" onClick={() => { try { const m = findMatches(text, findQ, caseSens); setFindMsg(m.length ? `${m.length} match${m.length === 1 ? "" : "es"} · first at line ${m[0].line}` : "no matches"); } catch (e) { setFindMsg(String((e as Error).message)); } }}>Count</Btn>
        <Btn variant="ghost" aria-label="Previous match" onClick={() => { try { const m = findMatches(text, findQ, caseSens); const ta = areaRef.current; const nav = nextMatch(m.map((x) => x.index), (ta?.selectionStart ?? 0) - 1, -1); if (nav) { const hit = m[nav.index]; ta?.focus(); ta?.setSelectionRange(hit.index, hit.index + findQ.length); setFindMsg(`match ${nav.index + 1} of ${m.length}${nav.wrapped ? " (wrapped)" : ""}`); } } catch (e) { setFindMsg(String((e as Error).message)); } }}><UiGlyph name="caret-up" size={13} /></Btn>
        <Btn variant="ghost" aria-label="Next match" onClick={() => { try { const m = findMatches(text, findQ, caseSens); const ta = areaRef.current; const nav = nextMatch(m.map((x) => x.index), ta?.selectionStart ?? -1, 1); if (nav) { const hit = m[nav.index]; ta?.focus(); ta?.setSelectionRange(hit.index, hit.index + findQ.length); setFindMsg(`match ${nav.index + 1} of ${m.length}${nav.wrapped ? " (wrapped)" : ""}`); } } catch (e) { setFindMsg(String((e as Error).message)); } }}><UiGlyph name="caret-down" size={13} /></Btn>
        <Btn variant="ghost" onClick={() => { try { const r = replaceOne(text, findQ, replQ, 1, caseSens); if (r.count) { setText(r.text); setDirty(true); } setFindMsg(r.count ? `replaced the first of ${r.count}` : "no matches"); } catch (e) { setFindMsg(String((e as Error).message)); } }}>Replace</Btn>
        <Btn variant="primary" onClick={() => { try { const r = replaceAll(text, findQ, replQ, caseSens); if (r.count) { setText(r.text); setDirty(true); } setFindMsg(r.count ? `replaced ${r.count}` : "no matches"); } catch (e) { setFindMsg(String((e as Error).message)); } }}>Replace all</Btn>
        <Btn variant="ghost" onClick={() => { setText((t) => transformLines(t, {})); setDirty(true); }} title="Sort all lines A to Z">Sort lines</Btn>
        <Btn variant="ghost" onClick={() => { setText((t) => transformLines(t, { desc: true })); setDirty(true); }} title="Sort all lines Z to A">Reverse sort</Btn>
        <Btn variant="ghost" onClick={() => { setText((t) => transformLines(t, { dedupe: true })); setDirty(true); }} title="Remove duplicate lines">Dedupe lines</Btn>
        <Btn variant={wrapOn ? "primary" : "ghost"} aria-pressed={wrapOn} onClick={() => { const next = !wrapOn; setWrapOn(next); try { window.localStorage.setItem(WRAP_KEY, next ? "1" : "0"); } catch { /* preference only */ } }} title="Soft-wrap long lines"><UiGlyph name="wrap" size={13} /> Wrap</Btn>
        <Btn variant="ghost" title="Indent the selected lines" onClick={() => { const ta = areaRef.current; if (!ta) return; const r = indentSelection(text, ta.selectionStart, ta.selectionEnd, 1); setText(r.text); setDirty(true); requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.selStart, r.selEnd); }); }} data-testid="editor-indent"><UiGlyph name="indent" size={13} /> Indent</Btn>
        <Btn variant="ghost" title="Dedent the selected lines" onClick={() => { const ta = areaRef.current; if (!ta) return; const r = indentSelection(text, ta.selectionStart, ta.selectionEnd, -1); setText(r.text); setDirty(true); requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(r.selStart, r.selEnd); }); }} data-testid="editor-dedent"><span style={{ display: "inline-flex", transform: "scaleX(-1)" }}><UiGlyph name="indent" size={13} /></span> Dedent</Btn>
        {findMsg ? <span className="fs-dim" style={{ fontSize: fz(11.5) }} role="status">{findMsg}</span> : null}
        <span style={{ flex: 1 }} />
        <input className="fs-input" style={{ width: fz(76) }} inputMode="numeric" placeholder="Line #" aria-label="Go to line" value={gotoLine}
          onChange={(e) => setGotoLine(e.target.value)}
          onKeyDown={(e) => { if (e.key !== "Enter") return; e.preventDefault(); const n = clampLine(Number(gotoLine), text); const off = offsetAtLine(text, n); const el = areaRef.current; if (el) { el.focus(); el.setSelectionRange(off, off); const lh = 18; el.scrollTop = Math.max(0, (n - 3) * lh); } setFindMsg(`line ${n} of ${docStats(text).lines}`); }} />
        {(() => { const st = docStats(text); return <span className="fs-dim fs-mono" style={{ fontSize: fz(11) }} data-testid="editor-stats">{st.lines} lines · {st.words} words · {st.chars} chars · ~{st.readingMinutes} min read</span>; })()}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: preview ? "1fr 1fr" : "1fr" }}>
        <textarea ref={areaRef} className="fs-textarea" value={text} spellCheck={false}
          onChange={(e) => { setText(e.target.value); setDirty(true); }}
          style={{ border: 0, borderRadius: 0, height: "100%", resize: "none", padding: 10, ...wrapStyle(wrapOn) }}
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
                <Btn variant="ghost" aria-pressed={diffOf?.id === v.id} onClick={() => setDiffOf(diffOf?.id === v.id ? null : v)}>Diff</Btn>
                <Btn variant="ghost" onClick={() => { setText(v.content); setDirty(true); shell.toast(`Loaded v${v.version} into the buffer — save to apply.`, "info"); }}>Load</Btn>
              </span>
            </div>
          ))}
          {versions.length === 0 ? <span className="fs-dim" style={{ fontSize: fz(11) }}>No previous versions yet.</span> : null}
          {diffOf ? (() => { try { const ops = diffLines(diffOf.content, text); const st = diffStats(ops); return (
            <div data-testid="editor-diff" style={{ display: "grid", gap: 4 }}>
              <div className="fs-row" style={{ gap: 6 }}><Badge tone="ok">+{st.added}</Badge><Badge tone="bad">−{st.removed}</Badge><Badge>{st.unchanged} unchanged</Badge><span className="fs-dim" style={{ fontSize: fz(11) }}>v{diffOf.version} → current buffer</span></div>
              <pre className="fs-mono" style={{ fontSize: fz(11), margin: 0, whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>{ops.slice(0, 400).map((o, i) => <div key={i} style={{ color: o.kind === "add" ? "var(--fs-ok, #4caf7d)" : o.kind === "del" ? "var(--fs-bad, #e5534b)" : undefined, opacity: o.kind === "same" ? 0.65 : 1 }}>{o.kind === "add" ? "+ " : o.kind === "del" ? "− " : "  "}{o.text}</div>)}</pre>
              {ops.length > 400 ? <span className="fs-dim" style={{ fontSize: fz(11) }}>first 400 of {ops.length} lines shown</span> : null}
            </div> ); } catch (e) { return <Badge tone="warn">{String((e as Error).message)}</Badge>; } })() : null}
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
