"use client";
/**
 * Files (FM-01 … FM-17). TT55: the single-pane module became a host for FilesPane (./FilesPane.tsx) with
 *   tabs            each tab is a pane with its own folder + back/forward history (kept mounted while hidden)
 *   dual pane       FM-02: a second pane side by side; F5 / F6 and "… to other pane" copy / move across, drag and
 *                   drop works between them
 *   folder tree     a toggle shared by every pane
 *   terminal pane   FM-02: the real Terminal module docked under the panes; it follows the ACTIVE pane's folder
 *                   (the terminal prints the cd and keeps its history)
 * Everything the old module did lives on in FilesPane.
 */
import { useCallback, useMemo, useState } from "react";
import { fz } from "@/lib/uiscale";
import { baseName } from "@/lib/files/model";
import type { ModuleProps } from "../shell-context";
import { useShell } from "../shell-context";
import { UiGlyph } from "../AppIcon";
import FilesPane from "./FilesPane";
import TerminalModule from "./Terminal";

interface Tab { id: string; start: string; trash: boolean }
const MAX_TABS = 8;
let tabSeq = 0;
const newTab = (start: string, trash = false): Tab => ({ id: `t${++tabSeq}`, start, trash });

export default function FilesModule({ win }: ModuleProps) {
  const startPath = (win.props.path as string) ?? "/";
  const shell = useShell();
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab(startPath, win.props.trash === true)]);
  const [activeTab, setActiveTab] = useState(() => tabs[0].id);
  const [where, setWhere] = useState<Record<string, { path: string; trash: boolean }>>({});
  const [dual, setDual] = useState(win.props.dual === true);
  const [paneB] = useState(() => newTab(startPath));
  const [active, setActive] = useState<"tab" | "b">("tab");
  const [tree, setTree] = useState(false);
  const [term, setTerm] = useState(false);

  // one stable callback: panes report (their id, folder, trash view) so tab labels and the terminal can follow
  const report = useCallback((id: string, path: string, trash: boolean) => {
    setWhere((w) => (w[id]?.path === path && w[id]?.trash === trash ? w : { ...w, [id]: { path, trash } }));
  }, []);
  const activateTab = useCallback(() => setActive("tab"), []);
  const activateB = useCallback(() => setActive("b"), []);

  const cwdA = where[activeTab]?.path ?? tabs.find((t) => t.id === activeTab)?.start ?? "/";
  const cwdB = where[paneB.id]?.path ?? paneB.start;
  const activeCwd = dual && active === "b" ? cwdB : cwdA;

  const addTab = (path = cwdA) => {
    if (tabs.length >= MAX_TABS) return;
    const t = newTab(path);
    setTabs((ts) => [...ts, t]); setActiveTab(t.id); setActive("tab");
  };
  const closeTab = (id: string) => {
    if (tabs.length <= 1) return;
    const i = tabs.findIndex((t) => t.id === id);
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (id === activeTab) setActiveTab(rest[Math.max(0, i - 1)].id);
  };
  const tabLabel = (t: Tab) => {
    const w = where[t.id];
    if (w?.trash) return "Trash";
    const p = w?.path ?? t.start;
    return p === "/" ? "Home" : baseName(p);
  };

  const termWin = useMemo(() => ({ ...win, id: `${win.id}-term`, module: "terminal", title: "Terminal", props: { cwd: activeCwd, embedded: true } }), [win, activeCwd]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }} data-testid="files-module">
      {/* tab strip + layout toggles */}
      <div className="fs-row" style={{ gap: 4, padding: "4px 6px 0", borderBottom: "1px solid var(--fs-border)", flexWrap: "nowrap", minHeight: 0 }}>
        <div role="tablist" aria-label="Files tabs" className="fs-row" style={{ gap: 2, flex: 1, minWidth: 0, overflowX: "auto", flexWrap: "nowrap" }}
          onKeyDown={(e) => {
            const i = tabs.findIndex((t) => t.id === activeTab);
            const to = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null;
            if (to === null) return;
            e.preventDefault();
            const t = tabs[(to + tabs.length) % tabs.length];
            setActiveTab(t.id);
            (e.currentTarget.querySelector(`[data-tab="${t.id}"]`) as HTMLElement | null)?.focus();
          }}>
          {tabs.map((t) => (
            <button key={t.id} role="tab" data-tab={t.id} aria-selected={t.id === activeTab} tabIndex={t.id === activeTab ? 0 : -1}
              className="fs-btn" data-variant={t.id === activeTab ? "default" : "ghost"} title={`${where[t.id]?.path ?? t.start} — middle-click closes`}
              style={{ borderBottomLeftRadius: 0, borderBottomRightRadius: 0, maxWidth: fz(180), minWidth: fz(64), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: fz(12) }}
              onClick={() => { setActiveTab(t.id); setActive("tab"); }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}>
              {tabLabel(t)}
            </button>
          ))}
        </div>
        <button className="fs-btn" data-variant="ghost" aria-label="New tab" title={tabs.length >= MAX_TABS ? `At most ${MAX_TABS} tabs` : "New tab (same folder)"} disabled={tabs.length >= MAX_TABS} onClick={() => addTab()}><UiGlyph name="plus" /></button>
        <button className="fs-btn" data-variant="ghost" aria-label="Close tab" title="Close this tab" disabled={tabs.length <= 1} onClick={() => closeTab(activeTab)}><UiGlyph name="close" /></button>
        <span aria-hidden="true" style={{ width: 1, alignSelf: "stretch", background: "var(--fs-border)", margin: "4px 2px" }} />
        <button className="fs-btn" data-variant={tree ? "primary" : "ghost"} aria-pressed={tree} aria-label="Folder tree" title="Folder tree" onClick={() => setTree((v) => !v)}><UiGlyph name="tree" /></button>
        <button className="fs-btn" data-variant={dual ? "primary" : "ghost"} aria-pressed={dual} aria-label="Dual pane" title="Two panes side by side (F5 copy / F6 move across)" onClick={() => setDual((v) => !v)}><UiGlyph name="split" /></button>
        <button className="fs-btn" data-variant={term ? "primary" : "ghost"} aria-pressed={term} aria-label="Terminal pane" title="Terminal docked below, following the active pane's folder" onClick={() => setTerm((v) => !v)}><UiGlyph name="terminal" /></button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: term ? "1 1 62%" : 1, minHeight: 0, display: "flex", gap: 0 }}>
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex" }}>
            {tabs.map((t) => (
              <div key={t.id} role="tabpanel" aria-label={tabLabel(t)} hidden={t.id !== activeTab}
                style={{ flex: 1, minWidth: 0, minHeight: 0, display: t.id === activeTab ? "flex" : "none" }}>
                <FilesPane paneId={dual ? "a" : "single"} initialPath={t.start} initialTrash={t.trash} active={!dual || active === "tab"}
                  onActivate={activateTab} reportId={t.id} onCwd={report} otherCwd={dual ? cwdB : null} showTree={tree} onOpenTab={addTab} />
              </div>
            ))}
          </div>
          {dual ? (
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", borderLeft: "1px solid var(--fs-border)" }}>
              <FilesPane paneId="b" initialPath={paneB.start} active={active === "b"} onActivate={activateB} reportId={paneB.id} onCwd={report}
                otherCwd={cwdA} showTree={tree} onOpenTab={addTab} />
            </div>
          ) : null}
        </div>
        {term ? (
          <section aria-label={`Terminal in ${activeCwd}`} data-testid="files-terminal" style={{ flex: "1 1 38%", minHeight: fz(140), borderTop: "1px solid var(--fs-border)", display: "flex", flexDirection: "column" }}>
            <TerminalModule win={termWin} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
