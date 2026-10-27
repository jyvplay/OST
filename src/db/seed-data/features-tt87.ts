import type { SpecRow } from "./row";

/**
 * TT87 — FM-14 Drag & Drop between windows and the OS, Class A completion.
 *
 * The web cannot move real files outside the browser's origin without the
 * user's explicit drop. FM-14 therefore has three layers:
 *  1. Inside Fusion: Fusion paths moved/copied between Files windows and the desktop.
 *  2. From OS: real File objects dropped into any Files pane or the desktop.
 *  3. To OS: single non-private files expose DownloadURL so a drop on the
 *     OS desktop creates a real file; multi-file and /Private drag-out is
 *     refused with a visible reason rather than a silent no-op.
 */
export function patchTT87(row: SpecRow): SpecRow {
  if (row.code !== "FM-14") return row;
  return {
    ...row,
    tier: "A",
    phase: "P2",
    status: "built",
    route:
      "src/lib/dnd-core.ts (DRAG_TYPE application/x-fusion-paths, encode/parse, canDragOut, downloadUrlValue, dropCreatesCycle, classifyDrop); " +
      "src/components/modules/FilesPane.tsx (row dragStart with DownloadURL + text/uri-list, dragOver/drop with cycle guard, desktop-dir + OS File upload, dual-pane & cross-window via shared browsing context); " +
      "src/components/DesktopSurface.tsx (desk drop zone for Fusion paths + OS Files, desktop-icon dragStart with DownloadURL, outline feedback, /Private guard)",
    nuance:
      "TT87 Class A within the web contract: every Fusion file/folder (except /Private) can be dragged between Files windows, between Files windows and the desktop surface, and dropped from the OS into any Files pane or the desktop; a single non-private file dragged out advertises DownloadURL (Chromium) and text/uri-list so the OS receives a real file on drop, multi-file drag-out and /Private files do not advertise DownloadURL and the UI states why instead of pretending. Drops check the private boundary, reject moving a folder into itself, and honour Ctrl/Alt as copy vs move. The desktop drop outline and the Files drop highlight give per-frame affordance; keyboard alternatives (F5 copy / F6 move to other pane, Alt+Arrow for desktop icons) remain. Honest limits: DownloadURL exists only on Chromium (Firefox shows a fallback Download button, never a silent failure), directory trees dropped from the OS are flattened when webkitGetAsEntry is absent, and no drag can escape the page's viewport without the user's pointer leaving it — the web has no global file drop outside the page.",
    test: "dnd-core.mts (8 unit: encode/parse, private guard, canDragOut, DownloadURL sanitising, cycle guard, classifyDrop, dedupe); e2e-tt87.mts (6 Chromium: internal move/copy between panes, desktop drop in/out, OS file drop, single-file DownloadURL, cycle refusal, no private leak)",
  };
}
