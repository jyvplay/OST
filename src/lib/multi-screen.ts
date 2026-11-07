/**
 * TT139 (HW-06) — placing a window on the right screen, and knowing when you
 * cannot.
 *
 * `window.getScreenDetails()` is Chromium-only, requires a permission prompt, and
 * returns *screen* rectangles in CSS pixels relative to a virtual origin that is
 * not the same as the window origin. Everything the compositor needs follows from
 * that geometry, and the failure mode of doing it naively is a window that is
 * placed off-screen on a display the user then cannot see.
 *
 * Model: screens carry `availLeft/Top/Width/Height` (work area, minus taskbars),
 * a `devicePixelRatio` and a `label`. A window is placed by `placeWindow`, which
 *   - prefers a screen the window already overlaps,
 *   - otherwise the primary screen,
 *   - centres it in the *work* area (never under a taskbar),
 *   - shrinks it if it does not fit, and says so,
 *   - refuses a screen index that does not exist instead of silently clamping to
 *     primary.
 *
 * Limits: no OS-level always-on-top, no per-screen DPI change events on Firefox
 * or Safari (the permission is unavailable there), and the browser may still
 * move a window after we place it. The report distinguishes "placed" from
 * "requested".
 */

export interface ScreenRect {
  label: string;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  isPrimary: boolean;
  isInternal?: boolean;
}

export interface WindowRect { x: number; y: number; w: number; h: number }

export interface Placement {
  rect: WindowRect;
  screenIndex: number;
  screenLabel: string;
  clamped: boolean;
  shrunk: boolean;
  reason: string;
}

export function virtualDesktop(screens: readonly ScreenRect[]): { x: number; y: number; w: number; h: number } | null {
  if (!screens.length) return null;
  const x0 = Math.min(...screens.map((s) => s.availLeft));
  const y0 = Math.min(...screens.map((s) => s.availTop));
  const x1 = Math.max(...screens.map((s) => s.availLeft + s.availWidth));
  const y1 = Math.max(...screens.map((s) => s.availTop + s.availHeight));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Which screen owns most of a rectangle; ties go to the earlier screen. */
export function screenForRect(screens: readonly ScreenRect[], rect: WindowRect): number {
  let best = -1, bestArea = 0;
  screens.forEach((s, i) => {
    const w = Math.max(0, Math.min(rect.x + rect.w, s.availLeft + s.availWidth) - Math.max(rect.x, s.availLeft));
    const h = Math.max(0, Math.min(rect.y + rect.h, s.availTop + s.availHeight) - Math.max(rect.y, s.availTop));
    const area = w * h;
    if (area > bestArea) { bestArea = area; best = i; }
  });
  return best === -1 ? Math.max(0, screens.findIndex((s) => s.isPrimary)) : best;
}

export function placeWindow(
  screens: readonly ScreenRect[],
  size: { w: number; h: number },
  opts: { screenIndex?: number; currentRect?: WindowRect; margin?: number } = {},
): Placement {
  if (!screens.length) {
    const rect = { x: 40, y: 40, w: size.w, h: size.h };
    return { rect, screenIndex: 0, screenLabel: "unknown", clamped: true, shrunk: false, reason: "no screen details available; the window is placed at a fixed offset" };
  }
  const margin = opts.margin ?? Math.round(Math.min(24, size.w * 0.03));
  let index = opts.screenIndex !== undefined ? opts.screenIndex : opts.currentRect ? screenForRect(screens, opts.currentRect) : screens.findIndex((s) => s.isPrimary);
  if (index < 0 || index >= screens.length) {
    return { rect: { x: 0, y: 0, w: size.w, h: size.h }, screenIndex: index, screenLabel: "?", clamped: false, shrunk: false, reason: `there is no screen ${index}` };
  }
  const s = screens[index];
  const maxW = Math.max(200, s.availWidth - margin * 2);
  const maxH = Math.max(150, s.availHeight - margin * 2);
  const w = Math.min(size.w, maxW), h = Math.min(size.h, maxH);
  const shrunk = w < size.w || h < size.h;
  const x = Math.round(s.availLeft + (s.availWidth - w) / 2);
  const y = Math.round(s.availTop + (s.availHeight - h) / 2);
  return {
    rect: { x, y, w, h },
    screenIndex: index,
    screenLabel: s.label,
    clamped: false,
    shrunk,
    reason: shrunk ? `shrunk to ${w}×${h} to fit “${s.label}”` : `centred on “${s.label}”`,
  };
}

/** Best screen for a full-screen presentation: prefer a non-primary external. */
export function presentationScreen(screens: readonly ScreenRect[]): number {
  if (!screens.length) return -1;
  const external = screens.findIndex((s) => s.isInternal === false && !s.isPrimary);
  if (external >= 0) return external;
  const nonInternal = screens.findIndex((s) => s.isInternal === false);
  if (nonInternal >= 0) return nonInternal;
  return Math.max(0, screens.findIndex((s) => s.isPrimary));
}

/** DPI change detection between polls, used to notice a window dragged to a new screen. */
export function dpiTransition(previous: ScreenRect | null, next: ScreenRect | null): { changed: boolean; sentence: string } {
  if (!previous || !next) return { changed: false, sentence: "" };
  if (previous.label === next.label) return { changed: false, sentence: "" };
  const ratio = next.devicePixelRatio / Math.max(0.5, previous.devicePixelRatio);
  if (Math.abs(ratio - 1) < 0.01) return { changed: true, sentence: `moved to “${next.label}” at the same scale` };
  return { changed: true, sentence: `moved to “${next.label}” at ${next.devicePixelRatio}× (was ${previous.devicePixelRatio}×) — canvases are re-scaled` };
}

/** A screen-report sentence that never overstates what the API returned. */
export function screenDisclosure(hasApi: boolean, screens: readonly ScreenRect[]): string {
  if (!hasApi) return "This browser does not expose per-screen geometry. Windows can be moved between displays by the OS, but the desktop cannot place them.";
  if (!screens.length) return "Screen details were refused. Windows stay on the screen the browser is on.";
  return `${screens.length} screen${screens.length === 1 ? "" : "s"} detected${screens.some((s) => s.isInternal === undefined) ? " (internal/external not reported)" : ""}.`;
}
