import type { SpecRow } from "./row";

/**
 * TT55 register changes.
 *
 * 1. The Files module rebuilt as a two-level component (Files.tsx host: tabs, dual pane, folder tree, docked terminal;
 *    FilesPane.tsx: one pane) on pure models (src/lib/files/model.ts) — FM-01/02/03/06/09/13/15/16/17, SH-09, DP-03,
 *    plus WM-08 remembered geometry in the window reducer. Evidence: scripts/tt55-files-unit.mts (independent reference
 *    models, random sequences), scripts/tt55-mutants.py (19/19), scripts/e2e-tt55-files.mts (real Chromium, every
 *    operation verified against the server; archives by Python zipfile).
 *
 * 2. Modal-shortcut audit (DESIGN-TT55 §B): rows that were "built" but have NO feature code (only the register row, a
 *    capability probe, or a manifest entry) are downgraded to what the code actually is. Nothing here was removed from
 *    the product — these rows never had the behaviour their text describes.
 */
const SUITES = "tt55-files-unit.mts; tt55-mutants.py; e2e-tt55-files.mts";
const SHELL_SUITE = "e2e-tt55-shell.mts";
const FILES = "src/components/modules/Files.tsx + FilesPane.tsx, src/lib/files/{model,clipboard}.ts";
const NOTE: Record<string, string> = {
  "FM-01": "TT55: list / grid / true column (Miller) views, sortable Name / Size / Modified headers (folders first, numeric-aware), clickable breadcrumbs (deep paths collapse to Home › … › last three) + editable path (Ctrl+L), folder tree from op=tree, tabs (≤ 8, each with its own history; middle-click closes, 'Open in new tab').",
  "FM-02": "TT55: dual pane (F5 copy / F6 move / '… to other pane', drag and drop between panes and onto folder rows, tree entries and breadcrumbs; Ctrl or Alt held = copy) and a docked terminal pane — the real Terminal module, following the active pane's folder (the cd is printed, history kept).",
  "FM-03": "TT55: Copy / Cut / Paste across panes and Files windows (session clipboard of paths, never contents); the server never overwrites, so the client picks conflict-free names ('a copy.txt', 'a copy 2.txt'; copies of copies do not grow).",
  "FM-06": "TT55: one context-menu model for rows and the folder background: a concise set with 'More actions (N)…', type-to-search over labels + keywords (every word, case- and accent-folded) from the search box or by typing on any item, arrow keys / Home / End / Enter, Esc or a press outside closes.",
  "FM-09": "TT55: honest origin badges — 'server' (bytes in this Fusion server's VFS), 'encrypted' (Persistent Storage, sealed in the browser), and 'queued' ghost rows for writes waiting in the offline queue (SH-14) that turn into server rows after replay. There are no cloud mounts, so no cloud / online-only states are shown.",
  "FM-13": "TT55: 'From template' and the background menu list /System/Templates live from the server; a new file is a byte copy of the template with a free name ('note 2.md'); 'Manage templates…' opens the folder.",
  "FM-15": "TT55: selection toolbar (count · total size incl. folder subtrees · Copy / Cut / to other pane / Move to… / Compress (one archive of the selection) / Tag… / Move to trash; Restore / Delete permanently in Trash), click / Ctrl-toggle / Shift-range / Ctrl+Shift-add / Ctrl+A / Esc, keyboard Shift+arrows, Delete, Shift+Delete or Delete in Trash = purge (typed confirmation), F2, batch rename of just the selection.",
  "FM-16": "TT55: quick filter (this folder) + 'Subfolders' = server-side deep name search (op=find: LIKE-escaped so % and _ are literal, trash and dotfiles excluded, /System only when searching inside it, first 200 matches with a notice).",
  "FM-17": "TT55: folder sizes computed server-side (one SUM over the subtree; files and folders counted separately) in the background, two at a time, cached per refresh tick so a write anywhere invalidates them; shown in the row (tooltip: N files · M folders) and added to the selection total.",
  "SH-09": "TT55 (Files): Back / Forward history per pane (toolbar SVG buttons — the old text arrow rendered as tofu —, Alt+← / Alt+→, Backspace, Alt+↑ up) and mouse buttons 4 / 5, which are handled and swallowed so the browser tab never navigates.",
  "SH-01": "TT55: one registry (src/lib/registry.ts) feeds the launcher, the palette, Start and Launchpad; e2e asserts launcher tiles = palette app rows = the registry source (same dynamic count and titles) and that a tile / a palette Enter opens the module (persisted state). The test caught a real defect: the palette's 40-row cap hid 3 apps — the cap now applies to non-app rows only.",
  "SH-02": "TT55: e2e asserts one shelf button per window of the active workspace, equal to the persisted desktop state, through middle-click close, a pinned-button open and a focus-not-duplicate click; windows on another workspace are not on this shelf.",
  "SH-04": "TT55: desktop icons re-read the file system on every journalled change made in this browser — the refresh bump is broadcast to other tabs of the same profile (BroadcastChannel, no payload) and a hidden tab re-reads when it becomes visible. e2e: a folder trashed in Files leaves the desktop in the same tab and in a second tab with no reload (≈ 0.2 s after the server confirmed), and the icon set equals the server listing before and after. Not covered: changes made on another device / browser profile appear on the next visibility change or refresh, not live (no server push channel).",
  "DP-03": "TT55: Files rows carry where-the-bytes-live badges (server / encrypted / queued) — see FM-09.",
  "WM-08": "TT55: the window reducer records each window's normal geometry (the restore rect when maximized) per module|host on close / closeAll and reuses it on the next open; registry sizes are only defaults, an explicit rect (deep link, session) wins, a second window of the same app is offset, the rect is fitted to a smaller desktop, memory bounded to 64 entries. (Before TT55 Shell.open passed the registry size as an explicit rect, which would have disabled any remembered geometry — caught by a surviving mutant.)",
};
const DOWN: Record<string, { status: SpecRow["status"]; why: string }> = {
  "NC-06": { status: "skeleton", why: "TT55 audit: no on-screen-display layer exists in the code; the row described a design, not built behaviour." },
  "AP-02": { status: "skeleton", why: "TT55 audit: no uninstall assistant exists (no per-bucket preview / purge flow); Privacy's wipe and Settings' resets are separate features." },
  "WM-16": { status: "probe", why: "TT55 audit: only a capability probe (requestPointerLock present) exists; window drags do not use pointer lock." },
  "ST-09": { status: "probe", why: "TT55 audit: only capability probes (pointer: coarse) exist; there are no per-context profiles and no screenschange listener." },
  "SH-13": { status: "partial", why: "TT55 audit: the manifest declares launch_handler, file_handlers and protocol_handlers, but beforeinstallprompt is never captured and LaunchQueue is only probed, so the single-instance file-open path is not implemented." },
  "WM-05": { status: "partial", why: "TT55 audit: the switcher chord (Ctrl+`) cycles windows in z-order; there is no MRU ring buffer, no switcher overlay and no app / workspace modes." },
  "IN-08": { status: "partial", why: "TT55 audit: pinch / two-finger gestures exist on the Tabletop only, not on windows." },
};

export function patchTT55(f: SpecRow): SpecRow {
  const n = NOTE[f.code];
  if (n) {
    if (f.code.startsWith("SH-0") && f.code !== "SH-09") return { ...f, status: f.status === "blocked" ? f.status : "built", nuance: `${f.nuance ? f.nuance + " " : ""}${n}`, test: `${f.test ? f.test + "; " : ""}${SHELL_SUITE}` };
    const route = f.code === "WM-08" ? "window reducer (src/lib/windowing/state.ts) + Shell.open defaults" : f.code === "SH-09" ? `${f.route} · Files: ${FILES}` : FILES;
    return { ...f, status: f.status === "blocked" ? f.status : "built", route, nuance: `${f.nuance ? f.nuance + " " : ""}${n}`, test: `${f.test ? f.test + "; " : ""}${SUITES}` };
  }
  const d = DOWN[f.code];
  if (d) return { ...f, status: d.status, nuance: `${f.nuance ? f.nuance + " " : ""}${d.why}` };
  return f;
}
