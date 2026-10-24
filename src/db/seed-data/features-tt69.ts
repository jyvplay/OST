import type { SpecRow } from "./row";

/**
 * TT69 register changes (no new rows): FF-15 document lifecycle rebuilt for Writer / Spreadsheet / Editor; Spreadsheet
 * carry-overs (Paste Values of empty text, SUMIF / AVERAGEIF sum_range resize, full-column ranges); Editor Ctrl+S scope.
 */
const UP: Record<string, { note: string; test: string; route?: string; status?: SpecRow["status"] }> = {
  "FF-15": {
    note: "TT69: one lifecycle for Writer, Spreadsheet and Editor (src/lib/doc-lifecycle.ts, pure + unit-tested): closing a window, Quit / Close all, Writer New and leaving the page with unsaved work ask Save / Don't save / Cancel in a modal dialog (window chrome inert, keys cannot reach the document; queued one window at a time; Cancel stops the queue; a failed save keeps the dialog open); recovery drafts (Writer .docx bytes, Spreadsheet workbook JSON, Editor text) written 2 s after the last edit (10 s max) to /System/Recovery or /Private/.Recovery for private documents, never version-snapshotted; reopening offers Restore / Discard and flags a draft whose file changed since; Save and Discard delete the draft; Don't save keeps it. Draft names are injective (encodeURIComponent). Limits: password-protected documents get no drafts (a draft would be plaintext); a draft is per document, not per window.",
    test: "tt69-lifecycle.mts (11: planner, registry, draft-name injectivity over 3 000 paths, codec, staleness, writer timing under a fake clock, server snapshot rule, private-root encryption at rest via pg); e2e-tt69-lifecycle.mts (6: modal attacks, contrast in dark+light, Writer draft→Restore→Save with python-docx, New over unsaved work, beforeunload, Editor drafts + Ctrl+S scope, stale Spreadsheet draft)",
    route: "src/lib/doc-lifecycle.ts + src/lib/doc-drafts.ts + src/components/CloseConfirm.tsx + src/components/doc-lifecycle-ui.tsx + Shell.tsx (ask queue) + Writer / Spreadsheet / Editor",
  },
  "FF-20": { note: "TT69: Paste Values of an empty-text value (=\"\" or ') pastes empty text (ISBLANK FALSE, COUNTA counts it), not a blank cell; kept through .xlsx (openpyxl reads '').", test: "tt69-sheet-misc.mts" },
  "FF-19": { note: "TT69: SUMIF / AVERAGEIF resize sum_range from its top-left cell to range's shape (Microsoft); held-out Excel cached values 26 294 → 26 295 (POI E1324). A single range may hold 2^21 cells (a full column at the last row no longer #NUM!; slow: ~1.4 s per full-column formula when data reaches row 1 048 576).", test: "tt69-sheet-misc.mts (brute-force reference, 400 shapes); tt68-heldout.mts" },
  "PR-01": { note: "TT69: Ctrl+S saves only the Editor window that holds focus (it used to save every open Editor from any window); unsaved text has a recovery draft (FF-15).", test: "e2e-tt69-lifecycle.mts" },
  "FF-22": { note: "TT69: Writer asks before New / close discards unsaved work and keeps a recovery draft (FF-15).", test: "e2e-tt69-lifecycle.mts" },
};

export function patchTT69(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, status: u.status ?? f.status, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
