"use client";

import { useCallback, useEffect, useRef } from "react";

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

/* ------------------------------------------------------------------------------------------------ IN-02 */
/**
 * TT67 IN-02 "Learn my mouse". Settings keys hold the button index the user's device actually reports for Back and
 * Forward (W3C UI Events: 3 = "browser back", 4 = "browser forward" by convention, but vendor drivers and OS
 * remappings differ, e.g. a left-handed driver profile that swaps the side buttons). Rules:
 *  - 0 (main) and 2 (secondary) can never be learned: binding Back to the main button would make the desktop unusable;
 *  - Back ≠ Forward: learning the index the other action already uses swaps them;
 *  - a stored pair that breaks either rule (hand-edited settings) falls back to 3 / 4.
 * The browser itself still navigates on 3 / 4 whatever the user learned, so the guard cancels the UNION of
 * {3, 4} and the learned indices — learning only decides which action OUR surfaces take.
 */
export const MOUSE_BACK_KEY = "input.mouseBack";
export const MOUSE_FORWARD_KEY = "input.mouseForward";
export const LEARNABLE = (b: number) => Number.isInteger(b) && b >= 0 && b <= 31 && b !== 0 && b !== 2;
/** Canonical decimal only ("03", " 3", "3.0" refused) — the exact rule the settings server applies (settings-validate.ts). */
export function validMouseButtonSetting(v: string): boolean { return /^(?:1|[3-9]|[12][0-9]|3[01])$/.test(v) && LEARNABLE(Number(v)); }

export function mouseConfigFrom(settings: Record<string, string | undefined>): MouseConfig {
  const read = (k: string, d: number) => { const v = settings[k]; return v !== undefined && validMouseButtonSetting(v) ? Number(v) : d; };
  const back = read(MOUSE_BACK_KEY, DEFAULT_MOUSE.back);
  const forward = read(MOUSE_FORWARD_KEY, DEFAULT_MOUSE.forward);
  if (back === forward) return { ...DEFAULT_MOUSE };
  return { ...DEFAULT_MOUSE, back, forward };
}

export type LearnResult = { ok: true; cfg: MouseConfig; swapped: boolean } | { ok: false; reason: string };
export function learnButton(cfg: MouseConfig, which: "back" | "forward", button: number): LearnResult {
  if (button === 0) return { ok: false, reason: "That is the main (left) button — press the side button you use for this instead." };
  if (button === 2) return { ok: false, reason: "That is the secondary (right) button — press the side button you use for this instead." };
  if (!LEARNABLE(button)) return { ok: false, reason: `Button index ${button} can't be used.` };
  const other = which === "back" ? "forward" : "back";
  const next: MouseConfig = { ...cfg, [which]: button };
  let swapped = false;
  if (cfg[other] === button && cfg[which] !== button) { next[other] = cfg[which]; swapped = true; }
  return { ok: true, cfg: next, swapped };
}

/** What a press of `button` means to a surface with its own history (Files), under the learned mapping. */
export function navActionFor(cfg: MouseConfig, button: number): "back" | "forward" | null {
  return button === cfg.back ? "back" : button === cfg.forward ? "forward" : null;
}
/** Buttons whose default action the shell guard cancels: the browser's own 3 / 4 plus whatever was learned. */
export function guardedButtons(cfg: MouseConfig): number[] {
  return [...new Set([3, 4, cfg.back, cfg.forward])].sort((a, b) => a - b);
}

/**
 * Capture mouse presses anywhere on the page (window capture phase) until `onPress` accepts one (returns true). Every press is consumed:
 * its pointerdown / mousedown are stopped, and the trailing mouseup / auxclick / click / contextmenu of the SAME press
 * are swallowed for 800 ms so the learning press can't also navigate Files, open a context menu or click a button.
 * Escape cancels. Returns a disposer (idempotent) that stops capturing presses but lets an active trail finish.
 */
export function captureNextButton(onPress: (button: number, e: MouseEvent) => boolean, onCancel: () => void, target: Window = window): () => void {
  let done = false;
  let trail: ReturnType<typeof setTimeout> | null = null;
  const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const trailing = ["mouseup", "pointerup", "auxclick", "click", "contextmenu"] as const;
  const endTrail = () => { for (const t of trailing) target.removeEventListener(t, stop, { capture: true }); if (trail) clearTimeout(trail); trail = null; };
  const startTrail = () => {
    if (trail) clearTimeout(trail);
    else for (const t of trailing) target.addEventListener(t, stop, { capture: true });
    trail = setTimeout(endTrail, 800);
  };
  let lastDown = -1;
  const onDown = (e: Event) => {
    if (done) return;
    stop(e);
    startTrail(); // even a refused press (right button) must not open a context menu or click what is under it
    const me = e as MouseEvent;
    // one physical press may arrive as pointerdown AND mousedown (engines that don't suppress the compatibility event)
    if (e.type === "mousedown" && lastDown === me.button) { lastDown = -1; return; }
    lastDown = e.type === "pointerdown" ? me.button : -1;
    if (onPress(me.button, me)) finish();
  };
  const onKey = (e: KeyboardEvent) => {
    if (done) return;
    stop(e);
    if (e.key === "Escape") { finish(); onCancel(); }
  };
  const finish = () => {
    if (done) return;
    done = true;
    target.removeEventListener("pointerdown", onDown, { capture: true });
    target.removeEventListener("mousedown", onDown, { capture: true });
    target.removeEventListener("keydown", onKey as EventListener, { capture: true });
  };
  target.addEventListener("pointerdown", onDown, { capture: true });
  target.addEventListener("mousedown", onDown, { capture: true });
  target.addEventListener("keydown", onKey as EventListener, { capture: true });
  // NOT endTrail(): React disposes the capture in the effect cleanup right after the accepted press — BEFORE that press's
  // mouseup / auxclick arrive. Ending the trail here let them through (found by the real-browser suite, TT67); an
  // active trail removes itself after 800 ms.
  return () => { finish(); };
}

/**
 * TT66: shell-wide guard for mouse buttons 3/4 (browser Back / Forward). Without it, pressing a mouse's Back button
 * anywhere on the desktop navigates the tab away and unmounts the whole session. Capture-phase listeners cancel the
 * default action of the events that can trigger the navigation (mousedown / mouseup / pointerup / auxclick); they do
 * NOT stop propagation, so a surface with its own history (Files) still receives the press and goes back / forward.
 */
export function useMouseNavGuard(cfg: MouseConfig = DEFAULT_MOUSE) {
  useEffect(() => {
    const guarded = guardedButtons(cfg);
    const swallow = (e: MouseEvent) => { if (guarded.includes(e.button)) e.preventDefault(); };
    // NOT pointerdown: cancelling it suppresses the compatibility mouseup (Pointer Events §11), which is exactly where Files
    // listens for buttons 3/4 — that variant broke Files' own Back / Forward (TT66 second-order finding)
    const types = ["mousedown", "mouseup", "pointerup", "auxclick"] as const;
    for (const t of types) window.addEventListener(t, swallow as EventListener, { capture: true });
    return () => { for (const t of types) window.removeEventListener(t, swallow as EventListener, { capture: true }); };
  }, [cfg.back, cfg.forward]);
}

