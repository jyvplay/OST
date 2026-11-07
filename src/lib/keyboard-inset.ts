/**
 * TT139 (IN-06) — virtual-keyboard insets and what to do with the windows.
 *
 * A software keyboard does not resize the layout viewport, it shrinks the
 * *visual* viewport. Two consequences the shell must handle or the user types
 * into a field they cannot see:
 *   1. the focused control has to be scrolled into the visible band, and
 *   2. floating windows under the keyboard have to be re-tiled, not merely
 *      covered.
 *
 * `navigator.virtualKeyboard.overlaysContent = true` plus `env(keyboard-inset-*)`
 * gives the geometry on Chromium; elsewhere `visualViewport` gives the height
 * indirectly. Both paths are modelled here as pure functions so the fallback is
 * testable without a keyboard. Limits: no browser reports *which* corner the
 * keyboard occupies, so a floating keyboard (tablet) is treated as bottom-docked
 * and the caller is told the inset is an estimate.
 */

export interface Viewport { width: number; height: number; offsetTop: number; offsetLeft: number; scale: number }
export interface Inset { top: number; right: number; bottom: number; left: number }
export interface Usable { x: number; y: number; w: number; h: number }

export const KEYBOARD_MAX_FRACTION = 0.7;

/** The band that is not covered by the keyboard, in layout-viewport coordinates. */
export function usableArea(viewport: Viewport, inset: Inset): Usable {
  const top = Math.max(0, inset.top);
  const left = Math.max(0, inset.left);
  const w = Math.max(0, viewport.width - left - Math.max(0, inset.right));
  const h = Math.max(0, viewport.height - top - Math.max(0, inset.bottom));
  return { x: left, y: top, w, h };
}

/**
 * Derive an inset from `visualViewport` alone (the fallback for browsers without
 * the VirtualKeyboard API). The visual viewport shrinks from the bottom when a
 * keyboard opens, and `offsetTop` tells us how far the layout has been scrolled.
 */
export function insetFromVisualViewport(layoutHeight: number, vv: { height: number; offsetTop: number; width: number }, layoutWidth: number): { inset: Inset; estimated: boolean } {
  const bottom = Math.max(0, layoutHeight - vv.height - Math.max(0, vv.offsetTop));
  const right = Math.max(0, layoutWidth - vv.width);
  return { inset: { top: Math.max(0, vv.offsetTop), right, bottom, left: 0 }, estimated: bottom > 0 };
}

/** Refuse to believe an inset that would leave no usable space (a glitch, not a keyboard). */
export function sanitiseInset(viewport: Viewport, inset: Inset): { inset: Inset; rejected: string | null } {
  const maxBottom = viewport.height * KEYBOARD_MAX_FRACTION;
  if (inset.bottom > maxBottom) return { inset: { ...inset, bottom: maxBottom }, rejected: `an inset of ${Math.round(inset.bottom)} px is more than ${Math.round(KEYBOARD_MAX_FRACTION * 100)}% of the window — clamped` };
  if (inset.bottom < 0 || inset.top < 0 || inset.left < 0 || inset.right < 0) return { inset: { top: Math.max(0, inset.top), right: Math.max(0, inset.right), bottom: Math.max(0, inset.bottom), left: Math.max(0, inset.left) }, rejected: "negative inset ignored" };
  return { inset, rejected: null };
}

/**
 * How far to scroll so `target` sits fully inside `area`, with a margin.
 * The result is a *scroll delta*: `scrollTop += dy`, `scrollLeft += dx`. So a
 * control below the band needs a positive dy (scroll down), and one past the right
 * edge needs a positive dx. Reading these as "move the content" inverts both.
 */
export function scrollIntoView(target: { x: number; y: number; w: number; h: number }, area: Usable, margin = 8): { dx: number; dy: number } {
  let dx = 0, dy = 0;
  if (target.y < area.y + margin) dy = target.y - (area.y + margin);
  else if (target.y + target.h > area.y + area.h - margin) dy = target.y + target.h - (area.y + area.h - margin);
  if (target.x < area.x + margin) dx = target.x - (area.x + margin);
  else if (target.x + target.w > area.x + area.w - margin) dx = target.x + target.w - (area.x + area.w - margin);
  return { dx: Math.round(dx), dy: Math.round(dy) };
}

export interface FloatingWindow { id: string; x: number; y: number; w: number; h: number; focused: boolean }

/**
 * Re-tile floating windows into the usable band. The focused window keeps its
 * size and is moved first (never resized under the user's finger); the others
 * keep their relative order and are compacted upwards. Windows taller than the
 * band are shrunk only as a last resort and the report says so.
 */
export function reflowWindows(windows: readonly FloatingWindow[], area: Usable, gap = 8): { windows: FloatingWindow[]; moved: number; shrunk: string[] } {
  const order = [...windows].sort((a, b) => Number(b.focused) - Number(a.focused) || a.y - b.y || a.x - b.x);
  const out: FloatingWindow[] = [];
  const shrunk: string[] = [];
  let cursorY = area.y;
  let moved = 0;
  for (const w of order) {
    const maxH = Math.max(0, area.y + area.h - cursorY);
    let h = w.h, y = w.y;
    const x = Math.min(Math.max(w.x, area.x), Math.max(area.x, area.x + area.w - w.w));
    if (w.focused) {
      // keep it where the user left it, but inside the band
      y = Math.min(Math.max(w.y, area.y), Math.max(area.y, area.y + area.h - Math.min(w.h, area.h)));
      h = Math.min(w.h, area.h);
      if (h < w.h) shrunk.push(w.id);
    } else if (y < cursorY || y + h > area.y + area.h) {
      y = cursorY;
      if (h > maxH) { h = maxH; shrunk.push(w.id); }
    }
    if (x !== w.x || y !== w.y || h !== w.h) moved++;
    out.push({ ...w, x, y, h });
    cursorY = Math.max(cursorY, y + h + gap);
  }
  return { windows: out.sort((a, b) => Number(b.focused) - Number(a.focused)), moved, shrunk };
}

/** What the shell should tell the user when the keyboard covers most of the screen. */
export function keyboardNotice(area: Usable, viewport: Viewport, keyboardOpen: boolean): string | null {
  if (!keyboardOpen) return null;
  const fraction = 1 - area.h / Math.max(1, viewport.height);
  if (fraction <= 0.001) return null;
  if (area.h < 160) return "The keyboard is covering almost everything — collapse the sidebar or rotate the device.";
  return `Keyboard uses ${Math.round(fraction * 100)}% of the screen; windows moved into the remaining space.`;
}

/** Raw CSS custom properties the shell writes once per resize (`env()` has no JS reader). */
export function insetVariables(inset: Inset): Record<string, string> {
  return {
    "--kb-inset-top": `${Math.round(inset.top)}px`,
    "--kb-inset-right": `${Math.round(inset.right)}px`,
    "--kb-inset-bottom": `${Math.round(inset.bottom)}px`,
    "--kb-inset-left": `${Math.round(inset.left)}px`,
  };
}
