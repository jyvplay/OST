/**
 * TT56 (AX-04, WCAG 2.4.11 Focus Not Obscured): when KEYBOARD navigation (Tab / Shift+Tab / F6) moves focus into a window
 * that is not the focused window, the compositor raises that window first, so the focused control is never hidden under
 * another window. Programmatic focus (autoFocus on mount, a background module focusing its own input) does not raise —
 * otherwise restoring a desktop would reshuffle the z-order.
 */
let lastNav = 0;
let installed = false;
export const NAV_WINDOW_MS = 800;
function install() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("keydown", (e) => { if (e.key === "Tab" || e.key === "F6") lastNav = performance.now(); }, true);
}
export function keyboardNavRecent(now = typeof performance !== "undefined" ? performance.now() : 0): boolean { install(); return now - lastNav < NAV_WINDOW_MS; }
export function armFocusRaise() { install(); }
