"use client";
/**
 * TT56 (WM-05) — held-chord switcher overlay with window / app / workspace modes in most-recently-used order.
 *
 * Ctrl+` (hybrid; Meta+` on the Mac preset, Alt+Tab on the Windows preset where the browser lets it through) opens the
 * overlay with the previous item preselected. While the modifier is held: the chord again (or ↓) advances, Shift+chord (or ↑)
 * goes back, ← / → or 1 / 2 / 3 change mode, Enter commits; releasing the modifier commits; Escape (or the page losing focus)
 * cancels. Nothing is focused until the commit, so the MRU order only changes on commit. An open ask dialog is modal: the
 * chord does nothing behind it.
 */
import { useEffect, useRef, useState } from "react";
import type { DesktopState, WindowCommand } from "@/lib/windowing/state";
import { SWITCH_MODES, initialIndex, stepIndex, switchItems, type SwitchMode } from "@/lib/windowing/mru";
import { fz } from "@/lib/uiscale";

interface Props { state: DesktopState; dispatch: (c: WindowCommand) => void; combo: string; appName: (module: string) => string; blocked: () => boolean }
interface Sw { mode: SwitchMode; index: number }
const MODE_LABEL: Record<SwitchMode, string> = { window: "Windows", app: "Apps", workspace: "Workspaces" };

export default function Switcher({ state, dispatch, combo, appName, blocked }: Props) {
  const [sw, setSw] = useState<Sw | null>(null);
  const swRef = useRef<Sw | null>(null);
  const stRef = useRef(state);
  useEffect(() => { stRef.current = state; }, [state]);

  useEffect(() => {
    const parts = combo.split("+"); const key = parts[parts.length - 1];
    const need = (m: string) => parts.includes(m);
    const hold = need("Ctrl") ? "Control" : need("Alt") ? "Alt" : need("Meta") ? "Meta" : null;
    const isChord = (e: KeyboardEvent) => !!combo && e.ctrlKey === need("Ctrl") && e.altKey === need("Alt") && e.metaKey === need("Meta") && (e.code === key || e.key === key);
    const items = (m: SwitchMode) => switchItems(stRef.current, m, appName);
    const set = (v: Sw | null) => { swRef.current = v; setSw(v); };
    const commit = (cur: Sw) => {
      const it = items(cur.mode)[cur.index];
      set(null);
      if (!it) return;
      if (it.workspace !== undefined) { if (it.workspace !== stRef.current.activeWorkspace) dispatch({ t: "switchWorkspace", workspace: it.workspace }); return; }
      if (it.winId) dispatch({ t: "focus", id: it.winId });
    };
    const down = (e: KeyboardEvent) => {
      const cur = swRef.current;
      if (!cur) {
        if (!isChord(e) || blocked()) return;
        e.preventDefault(); e.stopImmediatePropagation();
        const dir = e.shiftKey ? -1 : 1;
        if (!hold) { dispatch({ t: "cycle", dir }); return; } // no modifier to watch: one-shot MRU switch
        const n = items("window").length;
        if (n === 0) return;
        set({ mode: "window", index: initialIndex(n, dir) });
        return;
      }
      e.preventDefault(); e.stopImmediatePropagation();
      const n = items(cur.mode).length;
      const mode = (m: SwitchMode) => set({ mode: m, index: initialIndex(items(m).length) });
      if (e.key === "Escape") set(null);
      else if (e.key === "Enter") commit(cur);
      else if (isChord(e)) set({ ...cur, index: stepIndex(cur.index, n, e.shiftKey ? -1 : 1) });
      else if (e.key === "ArrowDown") set({ ...cur, index: stepIndex(cur.index, n, 1) });
      else if (e.key === "ArrowUp") set({ ...cur, index: stepIndex(cur.index, n, -1) });
      else if (e.key === "ArrowRight" || e.key === "ArrowLeft") mode(SWITCH_MODES[stepIndex(SWITCH_MODES.indexOf(cur.mode), 3, e.key === "ArrowRight" ? 1 : -1)]);
      else if (/^Digit[123]$/.test(e.code)) mode(SWITCH_MODES[Number(e.code.slice(5)) - 1]);
    };
    const up = (e: KeyboardEvent) => { const cur = swRef.current; if (cur && hold && e.key === hold) { e.preventDefault(); commit(cur); } };
    const lost = () => { if (swRef.current) set(null); };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", lost);
    return () => { window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); window.removeEventListener("blur", lost); };
  }, [combo, dispatch, appName, blocked]);

  if (!sw) return null;
  const list = switchItems(state, sw.mode, appName);
  const cur = list[sw.index];
  const pick = (i: number) => { const v = { ...sw, index: i }; swRef.current = v; setSw(v); };
  const commitAt = (i: number) => {
    const it = list[i]; swRef.current = null; setSw(null); if (!it) return;
    if (it.workspace !== undefined) dispatch({ t: "switchWorkspace", workspace: it.workspace }); else if (it.winId) dispatch({ t: "focus", id: it.winId });
  };
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 9650, background: "rgba(4,8,18,.35)", display: "grid", placeItems: "center" }} data-testid="switcher">
      <div className="fs-panel" role="dialog" aria-label="Switcher" style={{ width: "min(560px, 92%)", padding: 12, display: "grid", gap: 8 }}>
        <div className="fs-row" style={{ gap: 4 }} role="group" aria-label="Switcher mode">
          {SWITCH_MODES.map((m, i) => (
            <button key={m} className="fs-btn" data-variant={sw.mode === m ? "primary" : "ghost"} aria-pressed={sw.mode === m}
              style={{ minHeight: 24, padding: "0 10px" }} onMouseDown={(e) => e.preventDefault()} onClick={() => { const v = { mode: m, index: initialIndex(switchItems(state, m, appName).length) }; swRef.current = v; setSw(v); }}>
              {MODE_LABEL[m]}<span className="fs-dim" style={{ fontSize: fz(11), marginLeft: 6 }}>{i + 1}</span>
            </button>
          ))}
        </div>
        <ul role="listbox" aria-label={`${MODE_LABEL[sw.mode]}, most recently used first`} aria-activedescendant={cur ? `sw-${cur.key}` : undefined}
          style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 2, maxHeight: "50vh", overflow: "auto" }} data-testid="switcher-list">
          {list.map((it, i) => (
            <li key={it.key} id={`sw-${it.key}`} role="option" aria-selected={i === sw.index} data-key={it.key}
              className="fs-list-item" onMouseEnter={() => pick(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => commitAt(i)}
              style={{ background: i === sw.index ? "rgba(91,140,255,.22)" : undefined, borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}>
              <div style={{ fontSize: fz(13), fontWeight: i === sw.index ? 700 : 500 }}>{it.label}</div>
              <div className="fs-dim" style={{ fontSize: fz(11) }}>{it.sub}</div>
            </li>
          ))}
          {list.length === 0 && <li role="option" aria-selected={false} aria-disabled className="fs-dim" style={{ padding: 8 }}>Nothing to switch to</li>}
        </ul>
        <div className="fs-dim" style={{ fontSize: fz(11) }}>Keep holding the modifier: press the chord again to advance, Shift to go back, Left / Right arrow keys or 1–3 for mode. Release to switch, Esc to cancel.</div>
        <div aria-live="polite" data-testid="switcher-live" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>
          {cur ? `${cur.label}, ${sw.index + 1} of ${list.length}` : "Nothing to switch to"}
        </div>
      </div>
    </div>
  );
}
