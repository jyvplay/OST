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

/** Normalise wheel deltas across input devices into notches and pixels. */
export function normalizeWheel(e: WheelEvent, linesPerNotch = 3) {
  const lineHeight = 16;
  const pageHeight = 800;
  const factor = e.deltaMode === 1 ? lineHeight * linesPerNotch : e.deltaMode === 2 ? pageHeight : 1;
  return { px: e.deltaY * factor, notches: (e.deltaY * factor) / (lineHeight * linesPerNotch) };
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
