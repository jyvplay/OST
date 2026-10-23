"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * IN-01 desktopMouse contract.
 *
 * Two things that the obvious implementation gets wrong and that cost you the
 * whole application if you get them wrong in a shell:
 *  1. Buttons 3/4 are browser Back/Forward. You must preventDefault on
 *     pointerdown AND pointerup AND auxclick, or the tab navigates away and the
 *     desktop unmounts mid-session.
 *  2. Wheel deltaMode varies (0 px, 1 line, 2 page). Reading deltaY raw makes a
 *     mouse and a trackpad scroll by wildly different amounts.
 */

export interface MouseConfig { back: number; forward: number; linesPerNotch: number }
export const DEFAULT_MOUSE: MouseConfig = { back: 3, forward: 4, linesPerNotch: 3 };

export interface DesktopMouseHandlers {
  onPrimary?: (e: React.PointerEvent) => void;
  onSecondary?: (e: React.PointerEvent) => void;
  onTertiary?: (e: React.PointerEvent) => void;
  onBack?: () => void;
  onForward?: () => void;
}

export function useDesktopMouse(handlers: DesktopMouseHandlers, cfg: MouseConfig = DEFAULT_MOUSE) {
  const ref = useRef(handlers);
  ref.current = handlers;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button === cfg.back || e.button === cfg.forward) {
      e.preventDefault();
      e.stopPropagation();
      if (e.button === cfg.back) ref.current.onBack?.();
      else ref.current.onForward?.();
      return;
    }
    if (e.button === 0) ref.current.onPrimary?.(e);
    if (e.button === 2) ref.current.onSecondary?.(e);
    if (e.button === 1) { e.preventDefault(); ref.current.onTertiary?.(e); }
  }, [cfg.back, cfg.forward]);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (e.button === cfg.back || e.button === cfg.forward) { e.preventDefault(); e.stopPropagation(); }
  }, [cfg.back, cfg.forward]);

  const onAuxClick = useCallback((e: React.MouseEvent) => {
    if (e.button === cfg.back || e.button === cfg.forward || e.button === 1) e.preventDefault();
  }, [cfg.back, cfg.forward]);

  return { onPointerDown, onPointerUp, onAuxClick };
}

/**
 * TT66: one wheel notch of an ordinary mouse is 100 px in Chromium on Windows (pixel mode), 3 LINES in Firefox's line
 * mode, ~102.4 px when Firefox converts lines itself (Firefox ≥ 88 does so unless deltaMode is read before deltaY) and
 * ~53 px in Chromium on Linux. A line is therefore taken as 100/3 px, so a notch is ~100 px in both browsers (±3%),
 * and deltaMode is ALWAYS read first. A page is the scrolled surface's height.
 */
export const PX_PER_LINE = 100 / 3;
export const PX_PER_NOTCH = 100;
type WheelLike = { readonly deltaMode: number; readonly deltaX: number; readonly deltaY: number };
/** Wheel deltas in CSS pixels whatever the deltaMode (0 px, 1 line, 2 page). */
export function wheelPx(e: WheelLike, pageHeight = 800): { dx: number; dy: number } {
  const mode = e.deltaMode; // read before the deltas (see above)
  const f = mode === 1 ? PX_PER_LINE : mode === 2 ? Math.max(1, pageHeight) : 1;
  return { dx: e.deltaX * f, dy: e.deltaY * f };
}
/** Normalise wheel deltas across input devices into notches and pixels. */
export function normalizeWheel(e: WheelLike, pageHeight = 800) {
  const { dy } = wheelPx(e, pageHeight);
  return { px: dy, notches: dy / PX_PER_NOTCH };
}

/**
 * TT66: shell-wide guard for mouse buttons 3/4 (browser Back / Forward). Without it, pressing a mouse's Back button
 * anywhere on the desktop navigates the tab away and unmounts the whole session. Capture-phase listeners cancel the
 * default action of the events that can trigger the navigation (mousedown / mouseup / pointerup / auxclick); they do
 * NOT stop propagation, so a surface with its own history (Files) still receives the press and goes back / forward.
 */
export function useMouseNavGuard(cfg: MouseConfig = DEFAULT_MOUSE) {
  useEffect(() => {
    const swallow = (e: MouseEvent) => { if (e.button === cfg.back || e.button === cfg.forward) e.preventDefault(); };
    // NOT pointerdown: cancelling it suppresses the compatibility mouseup (Pointer Events §11), which is exactly where Files
    // listens for buttons 3/4 — that variant broke Files' own Back / Forward (TT66 second-order finding)
    const types = ["mousedown", "mouseup", "pointerup", "auxclick"] as const;
    for (const t of types) window.addEventListener(t, swallow as EventListener, { capture: true });
    return () => { for (const t of types) window.removeEventListener(t, swallow as EventListener, { capture: true }); };
  }, [cfg.back, cfg.forward]);
}

/** IN-02 "Learn my mouse": record which indices this device actually reports. */
export function useButtonLearner() {
  const [learning, setLearning] = useState<null | "back" | "forward">(null);
  const [learned, setLearned] = useState<MouseConfig>(DEFAULT_MOUSE);

  useEffect(() => {
    if (!learning) return;
    const onDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setLearned((c) => ({ ...c, [learning]: e.button }) as MouseConfig);
      setLearning(null);
    };
    window.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("auxclick", (e) => e.preventDefault(), { capture: true });
    return () => window.removeEventListener("pointerdown", onDown, { capture: true } as EventListenerOptions);
  }, [learning]);

  return { learning, setLearning, learned, setLearned };
}

/** IN-03: label chords with the physical key's layout character where possible. */
export function useLayoutMap() {
  const [map, setMap] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    const kb = (navigator as Navigator & { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    kb?.getLayoutMap?.().then(setMap).catch(() => undefined);
  }, []);
  return map;
}
