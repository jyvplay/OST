"use client";
/**
 * TT25 "Business" layout — a Windows-style taskbar along the bottom edge.
 *  • Start (opens the Start menu above the taskbar), a search box (the command palette), Task view (Overview).
 *  • Pinned apps + running apps in one row, centred like Windows 11. Indicator under each button: a short bar when the
 *    app has windows, a longer accent bar plus a highlight when one of them is focused.
 *  • Click: open → focus; focused single window → minimise; several windows → cycle (src/lib/layout-core.ts
 *    taskbarAction). Middle-click or Shift+click opens a new window. Right-click opens the jump list.
 *  • System tray: privacy / cast status, governor, Quick settings, Blackout, the stacked time/date clock (opens
 *    Planner, the calendar), and the "Show desktop" sliver at the far right (minimise all / put them back).
 */
import { fz } from "@/lib/uiscale";
import { useState } from "react";
import { MODULES, moduleById } from "@/lib/registry";
import { taskbarAction } from "@/lib/layout-core";
import { useShell } from "./shell-context";
import { AppIcon, FusionLogo, UiGlyph } from "./AppIcon";
import { AutoMenu, StatusItems, useClock, type MenuItem } from "./chrome-bits";

export const TASKBAR_PINNED = ["files", "browser", "writer", "sheet", "messages", "planner", "terminal", "settings"];

export default function Taskbar({ onStart, startOpen, onPalette, onOverview, onQuick, onBlackout }: {
  onStart: () => void; startOpen: boolean; onPalette: () => void; onOverview: () => void; onQuick: () => void; onBlackout: () => void;
}) {
  const shell = useShell();
  const now = useClock();
  const [jump, setJump] = useState<{ id: string; x: number } | null>(null);
  const { state } = shell;
  const wins = state.windows.filter((w) => w.workspace === state.activeWorkspace);
  const pinned = TASKBAR_PINNED.filter((id) => MODULES.some((m) => m.id === id));
  const running = [...new Set(wins.map((w) => w.module))].filter((id) => !pinned.includes(id));
  const apps = [...pinned, ...running];
  const tone = shell.gov.state === "COOL" ? "var(--fs-ok)" : shell.gov.state === "WARM" ? "var(--fs-info)" : shell.gov.state === "HOT" ? "var(--fs-warn)" : "var(--fs-bad)";

  const activate = (id: string, fresh: boolean) => {
    const mine = wins.filter((w) => w.module === id).sort((a, b) => a.z - b.z);
    if (fresh) { shell.open(id); return; }
    const a = taskbarAction(mine, state.focus);
    if (a.kind === "open") shell.open(id);
    else if (a.kind === "minimize") shell.dispatch({ t: "minimize", id: a.id });
    else shell.dispatch({ t: "focus", id: a.id });
  };

  const jumpItems = (id: string): MenuItem[] => {
    const m = moduleById(id);
    const mine = wins.filter((w) => w.module === id);
    return [
      ...mine.map((w) => ({ label: w.title, onSelect: () => shell.dispatch({ t: "focus", id: w.id }), checked: state.focus === w.id && !w.minimized })),
      ...(mine.length ? [{ label: "", separator: true }] : []),
      { label: `New ${m?.title ?? id} window`, onSelect: () => shell.open(id), testid: `jump-new-${id}` },
      ...(mine.length ? [{ label: mine.length > 1 ? "Close all windows" : "Close window", onSelect: () => mine.forEach((w) => shell.dispatch({ t: "close", id: w.id })), testid: `jump-close-${id}` }] : []),
    ];
  };

  return (
    <nav aria-label="Taskbar" data-testid="taskbar" className="fs-taskbar"
      style={{ height: fz(48), display: "grid", gridTemplateColumns: "minmax(0,1fr) auto minmax(0,1fr)", alignItems: "center",
        borderTop: "1px solid var(--fs-border)", background: "var(--fs-panel)", backdropFilter: "blur(18px)", position: "relative", zIndex: 50 }}>
      {/* left: virtual desktops (Windows keeps these in Task view; a compact switcher saves a click) */}
      <div className="fs-row" role="group" aria-label="Desktops" style={{ gap: 3, paddingLeft: 8, minWidth: 0, overflow: "hidden" }}>
        {state.workspaces.map((ws) => (
          <button key={ws.id} type="button" className="fs-tb-btn" aria-pressed={ws.id === state.activeWorkspace}
            onClick={() => shell.dispatch({ t: "switchWorkspace", workspace: ws.id })} title={`Desktop: ${ws.name}`}
            style={{ fontSize: fz(11.5), padding: `0 ${fz(8)}`, minWidth: 0 }}>{ws.name}</button>
        ))}
      </div>

      {/* centre: Start, search, Task view, apps */}
      <div className="fs-row" style={{ gap: 3, justifyContent: "center", minWidth: 0 }}>
        <button type="button" className="fs-tb-btn" data-testid="launcher-button" aria-label="Start" aria-expanded={startOpen} aria-haspopup="dialog"
          title="Start (Meta+A)" onClick={onStart} data-active={startOpen || undefined}>
          <FusionLogo size={26} label="" />
        </button>
        <button type="button" className="fs-tb-search" onClick={onPalette} data-testid="taskbar-search" title="Search apps, files and settings (Ctrl+Space)">
          <UiGlyph name="search" size={15} /><span>Search</span>
        </button>
        <button type="button" className="fs-tb-btn" onClick={onOverview} aria-label="Task view" title="Task view (Meta+Q)" data-testid="taskbar-taskview">
          <UiGlyph name="overview" size={20} />
        </button>
        <div className="fs-row" role="group" aria-label="Apps" style={{ gap: 3, minWidth: 0, overflowX: "auto", overflowY: "hidden" }}>
          {apps.map((id) => {
            const m = moduleById(id);
            const mine = wins.filter((w) => w.module === id);
            const focused = mine.some((w) => w.id === state.focus && !w.minimized);
            const n = mine.length;
            return (
              <span key={id} style={{ position: "relative", display: "inline-flex" }}>
                <button type="button" className="fs-tb-btn" data-testid={`taskbar-${id}`} data-running={n > 0 || undefined} data-focused={focused || undefined}
                  aria-label={`${m?.title ?? id}${n ? `, ${n} window${n === 1 ? "" : "s"}${focused ? ", active" : ""}` : ""}`}
                  title={n ? mine.map((w) => w.title).join("\n") : `${m?.title} — ${m?.summary}`}
                  onClick={(e) => activate(id, e.shiftKey)}
                  onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); shell.open(id); } }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    // the app row scrolls (overflow), so the jump list is rendered at taskbar level, not inside it
                    const nav = e.currentTarget.closest("nav")!.getBoundingClientRect(), b = e.currentTarget.getBoundingClientRect();
                    setJump({ id, x: b.left + b.width / 2 - nav.left });
                  }}>
                  <AppIcon id={id} size={24} />
                  {n ? <span aria-hidden="true" className="fs-tb-ind" style={{ width: focused ? fz(16) : fz(6), background: focused ? "var(--fs-accent)" : "var(--fs-muted)" }} /> : null}
                </button>
              </span>
            );
          })}
        </div>
      </div>

      {jump ? <JumpList x={jump.x} label={`${moduleById(jump.id)?.title ?? jump.id} jump list`} items={jumpItems(jump.id)} onClose={() => setJump(null)} /> : null}

      {/* right: system tray, clock, show desktop */}
      <div className="fs-row" style={{ gap: 3, justifyContent: "flex-end", minWidth: 0 }}>
        <StatusItems compact />
        {state.focusMode ? <span className="fs-dim" style={{ fontSize: fz(11) }}>focus</span> : null}
        <span role="img" aria-label={`Performance ${shell.gov.state}, ${shell.gov.fps} fps`} title={`${shell.gov.state} · ${shell.gov.fps} fps — ${shell.gov.reason}`}
          style={{ width: fz(9), height: fz(9), borderRadius: 99, background: tone, display: "inline-block", margin: `0 ${fz(4)}` }} />
        <button type="button" className="fs-tb-btn" onClick={onBlackout} aria-label="Blackout this screen" title="Blackout this screen (BlackTop)"><UiGlyph name="contrast" size={17} /></button>
        <button type="button" className="fs-tb-btn" onClick={onQuick} aria-label="Quick settings" title="Quick settings (Meta+I)" data-testid="taskbar-quick"><UiGlyph name="sliders" size={17} /></button>
        <button type="button" className="fs-tb-btn" data-testid="taskbar-clock" onClick={() => shell.open("planner")}
          title={`${now.toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })} — open Planner`}
          style={{ display: "grid", justifyItems: "end", lineHeight: 1.15, padding: `0 ${fz(8)}`, fontSize: fz(11.5) }} suppressHydrationWarning>
          <span suppressHydrationWarning>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          <span suppressHydrationWarning>{now.toLocaleDateString([], { year: "numeric", month: "numeric", day: "numeric" })}</span>
        </button>
        <button type="button" className="fs-tb-showdesk" data-testid="show-desktop" aria-label="Show desktop" title="Show desktop (click again to bring the windows back)"
          onClick={() => shell.dispatch({ t: "showDesktop" })} />
      </div>
    </nav>
  );
}

/** Right-click jump list, opened above the taskbar button (menu semantics, keyboard + click-outside close). */
function JumpList({ x, label, items, onClose }: { x: number; label: string; items: MenuItem[]; onClose: () => void }) {
  return (
    <div style={{ position: "absolute", left: `clamp(8px, ${x}px - ${fz(110)}, calc(100% - ${fz(230)}))`, bottom: "calc(100% + 6px)", zIndex: 9800 }}>
      <AutoMenu label={label} items={items} onClose={onClose} />
    </div>
  );
}

