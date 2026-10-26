"use client";
/**
 * TT28 Snap UI (rendered inside the desk, above every window). Original code:
 *   - drag preview: the translucent rect a title-bar drag will snap into (corners → quarters, sides → halves, top → max)
 *   - snap layouts flyout: hover the Business maximise button (or press the "Snap layouts" chord) → pick a zone
 *   - Snap Assist: after a snap, the zones still empty offer the other open windows, one zone at a time
 * Geometry comes from src/lib/snap-core.ts; window placement goes through the reducer's "place"/"tile" commands.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useShell } from "./shell-context";
import { AppIcon } from "./AppIcon";
import { assistPlan, layoutsFor, thumbZones, zoneRect, type AssistPlan, type Rect } from "@/lib/snap-core";

interface SnapUi {
  preview: (Rect & { key: string }) | null;
  flyout: { id: string; x: number; y: number; viaKeyboard: boolean } | null;
  assist: { plan: AssistPlan; step: number; placed: string[] } | null;
}
let ui: SnapUi = { preview: null, flyout: null, assist: null };
const subs = new Set<() => void>();
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;

export const snapUi = {
  get: () => ui,
  set(patch: Partial<SnapUi>) { ui = { ...ui, ...patch }; for (const f of [...subs]) f(); },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  /** Hover intent: open after `delay` ms unless cancelled (pointer left first). */
  hoverOpen(id: string, x: number, y: number, delay = 450) {
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(() => { openTimer = null; snapUi.set({ flyout: { id, x, y, viaKeyboard: false } }); }, delay);
  },
  hoverLeave(delay = 350) {
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { closeTimer = null; if (ui.flyout && !ui.flyout.viaKeyboard) snapUi.set({ flyout: null }); }, delay);
  },
  keepOpen() { if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; } },
};

const NAMES: Record<string, string> = {
  left: "left half", right: "right half", major: "left two thirds", minor: "right third", "third-l": "left third", "third-c": "centre third",
  "third-r": "right third", tl: "top-left quarter", tr: "top-right quarter", bl: "bottom-left quarter", br: "bottom-right quarter",
  "q-l": "left quarter", centre: "centre half", "q-r": "right quarter", full: "full screen",
};
const THUMB_W = 88, THUMB_H = 56;

export function SnapHost() {
  const shell = useShell();
  const s = useSyncExternalStore(snapUi.subscribe, snapUi.get, snapUi.get);
  const fly = useRef<HTMLDivElement>(null);
  const vp = shell.state.viewport;
  const ws = shell.state.activeWorkspace;

  // keyboard: Escape closes the flyout / assist; the flyout takes focus when opened from the keyboard
  useEffect(() => {
    if (!s.flyout && !s.assist) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      const id = ui.flyout?.id;
      snapUi.set({ flyout: null, assist: null });
      if (id) document.querySelector<HTMLElement>(`[data-win-id="${CSS.escape(id)}"] .fs-cap-maximize`)?.focus();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [s.flyout, s.assist]);
  useEffect(() => { if (s.flyout?.viaKeyboard) fly.current?.querySelector<HTMLElement>("button")?.focus(); }, [s.flyout]);

  const others = (exclude: string[]) => shell.state.windows.filter((w) => !exclude.includes(w.id) && (w.workspace ?? 1) === ws && w.host !== "pip");

  const pick = (winId: string, layoutId: string, zoneKey: string, rect: Rect) => {
    shell.dispatch({ t: "place", id: winId, rect });
    const plan = assistPlan(layoutId, zoneKey, vp, others([winId]).length);
    snapUi.set({ flyout: null, assist: plan ? { plan, step: 0, placed: [winId] } : null });
  };

  const assist = s.assist;
  const zone = assist ? assist.plan.zones[assist.step] : null;
  const candidates = assist ? others(assist.placed) : [];
  if (assist && (!zone || !candidates.length)) queueMicrotask(() => { if (ui.assist === assist) snapUi.set({ assist: null }); });

  return (
    <>
      {s.preview ? (
        <div className="fs-snap-preview" data-testid="snap-preview" data-key={s.preview.key} aria-hidden="true"
          style={{ left: s.preview.x + 6, top: s.preview.y + 6, width: Math.max(0, s.preview.w - 12), height: Math.max(0, s.preview.h - 12) }} />
      ) : null}

      {s.flyout ? (
        <div ref={fly} className="fs-panel fs-snap-flyout" role="dialog" aria-label="Snap layouts" data-testid="snap-flyout"
          style={{ left: Math.max(8, Math.min(s.flyout.x, vp.w - 8 - 3 * (THUMB_W + 20))), top: Math.max(8, Math.min(s.flyout.y, vp.h - 200)) }}
          onPointerEnter={() => snapUi.keepOpen()} onPointerLeave={() => snapUi.hoverLeave()} onPointerDown={(e) => e.stopPropagation()}>
          {layoutsFor(vp.w).map((l) => (
            <div key={l.id} role="group" aria-label={l.label} className="fs-snap-thumb" data-layout={l.id} style={{ width: THUMB_W, height: THUMB_H }}>
              {thumbZones(l, THUMB_W, THUMB_H).map((q) => (
                <button key={q.key} type="button" className="fs-snap-zone" data-testid="snap-zone" data-layout={l.id} data-zone={q.key}
                  aria-label={`${l.label}: ${NAMES[q.key] ?? q.key}`} title={NAMES[q.key] ?? q.key}
                  style={{ left: q.x, top: q.y, width: q.w, height: q.h }}
                  onClick={() => { const fl = ui.flyout; if (!fl) return; const zn = l.zones.find((x) => x.key === q.key)!; pick(fl.id, l.id, q.key, zoneRect(zn, vp)); }} />
              ))}
            </div>
          ))}
        </div>
      ) : null}

      {assist && zone && candidates.length ? (
        <div className="fs-snap-assist-layer" data-testid="snap-assist" data-layout={assist.plan.layout} data-zone={zone.key}
          onPointerDown={(e) => { if (e.target === e.currentTarget) snapUi.set({ assist: null }); }}>
          {assist.plan.zones.slice(assist.step + 1).map((q) => (
            <div key={q.key} className="fs-snap-assist-later" style={{ left: q.rect.x, top: q.rect.y, width: q.rect.w, height: q.rect.h }} aria-hidden="true" />
          ))}
          <div className="fs-panel fs-snap-assist" role="dialog" aria-label={`Snap Assist: choose a window for the ${NAMES[zone.key] ?? zone.key}`}
            style={{ left: zone.rect.x + 6, top: zone.rect.y + 6, width: Math.max(0, zone.rect.w - 12), height: Math.max(0, zone.rect.h - 12) }}>
            <p className="fs-snap-assist-title">Choose a window for the {NAMES[zone.key] ?? zone.key}</p>
            <div className="fs-snap-assist-grid">
              {candidates.slice(0, 12).map((w) => (
                <button key={w.id} type="button" className="fs-snap-cand" data-testid="snap-candidate" data-win={w.id}
                  onClick={() => {
                    shell.dispatch({ t: "place", id: w.id, rect: zone.rect });
                    const next = { ...assist, step: assist.step + 1, placed: [...assist.placed, w.id] };
                    snapUi.set({ assist: next.step < next.plan.zones.length ? next : null });
                  }}>
                  <AppIcon id={w.module} size={28} /><span>{w.title}</span>
                </button>
              ))}
            </div>
            <button type="button" className="fs-btn" data-variant="ghost" data-testid="snap-assist-skip" onClick={() => snapUi.set({ assist: null })}>Not now</button>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** Used by WindowFrame after a drag-snap and by the keyboard chord. */
export function startAssist(plan: AssistPlan | null, placed: string) { snapUi.set({ assist: plan ? { plan, step: 0, placed: [placed] } : null }); }
