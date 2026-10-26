import type { SpecRow } from "./row";

/**
 * TT56 register changes. Every upgrade names the code that implements it and the suite that verifies it against ground
 * truth outside the UI (independent oracle, persisted server state, computed styles, saved bytes).
 *
 *  FF-22 Writer Track Changes: own edits recorded as w:ins / w:del (text, run objects, paragraph marks, nested deletion of
 *        another reviewer's insertion), settings.xml w:trackRevisions, per-change accept / reject / next / previous —
 *        scripts/tt56-writer-track.mts (lxml oracle scripts/oracle/docx_track.py, 40 random decision sets, POI corpus) and
 *        e2e-tt56.mts.
 *  WM-05 MRU switcher (held chord, window / app / workspace modes) — tt56-shell-unit.mts + e2e-tt56.mts.
 *  NC-06 on-screen display — tt56-shell-unit.mts + e2e-tt56.mts.   WM-10 / ST-05 / ST-07 — e2e-tt56.mts.
 *  DP-01 DP-02 RG-03 RG-07 SC-03 AX-04 — e2e-tt56-rows.mts.
 */
const UNIT = "tt56-shell-unit.mts; e2e-tt56.mts";
const ROWS = "e2e-tt56-rows.mts";
const UP: Record<string, { status?: SpecRow["status"]; route?: string; note: string; test: string }> = {
  "FF-22": { note: "TT56 Track Changes: with recording on (Review panel toggle, status-bar chip, Ctrl+Shift+E) typing, deleting, pictures/breaks and Enter / Backspace across paragraphs are written as w:ins / w:del (deleted text as w:delText, paragraph marks in w:pPr/w:rPr, a deletion of another reviewer's pending insertion nested inside it, the author's own pending insertion simply removed); the flag is saved as w:trackRevisions; file revisions made only of runs re-open as editable revisions; Review lists every change in document order with per-change Accept / Reject, Next / Previous, Accept all / Reject all. Not tracked (disclosed): formatting changes (w:rPrChange), table structure, moves.", test: "tt56-writer-track.mts; e2e-tt56.mts" },
  "WM-05": { status: "built", route: "src/lib/windowing/mru.ts + state.ts (mru / wsMru) + src/components/Switcher.tsx", note: "TT56: windows and workspaces are kept in most-recently-used order by the reducer; holding the switcher chord (Ctrl+` hybrid, Meta+` Mac, Alt+Tab Windows preset where the browser passes it) opens an overlay in window / app / workspace mode with the previous item preselected; the chord again advances, Shift reverses, ← → / 1 2 3 change mode, releasing commits, Esc cancels; an open ask dialog blocks it. Alt+Tab / Meta+Tab themselves are OS-reserved outside Keyboard Lock (blocked row WM-15 unchanged).", test: UNIT },
  "NC-06": { status: "built", route: "src/lib/osd.ts + src/components/OsdLayer.tsx", note: "TT56: one OSD layer: an aria-hidden pill that follows every step (media volume from any <audio>/<video> in the shell incl. native controls, the Streams volume slider, text size, layout, theme, focus mode, workspace) and a role=status aria-live=polite region that announces the settled value once per burst (600 ms); the Quick panel's own live text was removed so the change is announced exactly once. System volume / brightness are not readable by a web page (NC-03 absent tiles).", test: UNIT },
  "WM-10": { status: "built", note: "TT56: focus mode is one parent CSS variable (--fs-focus-dim on :root, data-focus-mode) that every unfocused window reads; e2e toggles it with Meta+Shift+F and checks computed opacities and the persisted flag.", test: UNIT, route: "Shell.tsx + WindowFrame.tsx" },
  "ST-05": { status: "built", note: "TT56: motion is a token (--fs-motion) that prefers-reduced-motion zeroes at :root; a 'Match system' theme follows prefers-color-scheme live (the house default stays Dark, the TT22 palette choice). e2e emulates both media features.", test: UNIT, route: "globals.css tokens + Shell.tsx + DisplaySettings.tsx" },
  "ST-07": { status: "built", note: "TT56: the UI scale is the app's own root token (--fs-ts × rem); e2e shows identical CSS text sizes at device scale factor 1 and 2 and under a CDP zoom emulation, while the app's A+/A− changes it. Real Ctrl+± page zoom cannot be pressed in headless Chromium (emulated instead).", test: UNIT, route: "src/lib/uiscale.ts" },
  "DP-01": { note: "TT56 e2e: 11 login/auth paths answer 404, no auth route directory, no auth dependency, no auth code in the client bundle.", test: ROWS },
  "DP-02": { note: "TT56 e2e: zero ad / promo / upsell components, file names or strings in src/ (the shields block list is the one allowed mention), zero ad-SDK markers in the client bundle.", test: ROWS },
  "RG-03": { note: "TT56 e2e: requestAnimationFrame is counted from an init script; a static desktop runs zero callbacks over 3 s.", test: ROWS },
  "RG-07": { note: "TT56 e2e: Settings → Capabilities shows ≥ 40 probed APIs, each with detail / degrade text; sampled rows equal independent feature detection.", test: ROWS },
  "SC-03": { route: "src/lib/permissions.ts + Settings → Capabilities", note: "TT56: the audit now covers the full permission-name list (31 names incl. ones Fusion never requests, marked 'never requested'); e2e compares every state with an independent permissions.query.", test: ROWS },
  "AX-04": { route: "src/lib/focus-raise.ts + WindowFrame.tsx", note: "TT56: keyboard navigation (Tab / Shift+Tab / F6) into a covered window raises it before the control is shown focused; programmatic focus (autoFocus) does not reshuffle windows. e2e checks server focus / z and that the focused control is topmost at its centre.", test: ROWS },
};

export function patchTT56(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return {
    ...f,
    status: f.status === "blocked" ? f.status : (u.status ?? (f.status === "skeleton" || f.status === "probe" ? "built" : f.status)),
    route: u.route ?? f.route,
    nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`,
    test: `${f.test ? f.test + "; " : ""}${u.test}`,
  };
}
