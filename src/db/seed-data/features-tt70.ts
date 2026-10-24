import type { SpecRow } from "./row";

/**
 * TT70 register changes (no new rows): sealed recovery drafts for password-protected documents, Close all over several
 * dirty windows, sparse whole-column ranges + workbook-wide clamp, WM-13 edge-hold (was registered "built" but absent),
 * share-target and density rows tested.
 */
const UP: Record<string, { note: string; test: string; route?: string; status?: SpecRow["status"] }> = {
  "FF-15": {
    note: "TT70: password-protected Writer / Spreadsheet documents now keep recovery drafts too (TT69 kept none): the draft is sealed with the document's own password in an MS-OFFCRYPTO Agile container (encryptOffice; the Spreadsheet JSON travels as a one-entry ZIP inside it), so msoffcrypto-tool / Word open it with the password and the server never holds plaintext. Restore tries the window's password silently and asks only if it was changed since (wrong password: inline alert; Cancel keeps the offer). Restoring never weakens protection: the file's current password wins; an unprotected file adopts the draft's. Also fixed: restoring a plain draft over a since-protected file used to drop the protection (the next Save would have written plaintext). Close all windows over several dirty documents asks about each in window order (Save / Don't save per document, Cancel stops the queue; clean windows close at once).",
    test: "tt70-seal.mts (8: round trip, wrong/case/empty password, damage incl. 48 single-bit flips never yielding different plaintext, no password/plaintext in the sealed bytes, restoredProtection table, codec, ZIP packing, msoffcrypto + python-docx + zipfile oracle); e2e-tt70-seal.mts (2: Writer sealed draft → Restore without prompt → Save still encrypted; Spreadsheet password changed P1→P2 adversary); e2e-tt70-closeall.mts (3); tt70-mutants.py (10/10 killed)",
    route: "src/lib/office/draft-seal.ts + doc-lifecycle-ui.tsx openSealedWithPrompt + Writer / Spreadsheet makeDraft / restoreDraft",
  },
  "FF-19": {
    note: "TT70: whole-column / very large ranges are SPARSE (rows without input or spill share one frozen empty row, never evaluated cell by cell; their blank mask is shared too): =SUM(A:C) with data in row 1 048 576 is 113 (TT69: #NUM!), ~10x faster (SUM(A:A) ~1 060 → ~100 ms) and ~8x less memory. Whole columns are clamped to the WORKBOOK's used area along the oversized axis only, so Sheet1!A:A and Data!A:A keep one shape: cross-sheet COUNTIFS / SUMIFS / SUMPRODUCT were #VALUE! and now match Excel. The cells cut off are added back as blanks for COUNTBLANK / COUNTIF / COUNTIFS (COUNTBLANK(A:A) counts all 1 048 576 rows); SUMIFS / COUNTIFS compare FULL sizes (A:A vs A1:A20 stays #VALUE!). Limits: array expressions over a whole column's blank tail (SUMPRODUCT(--(A:A=\"\")), FILTER) still see the used area only; a sparse range may present at most 16 full columns (17+ is #NUM!; Excel has no such cap).",
    test: "tt70-range.mts (6: Excel results with bottom-row data, spill-only rows adversary, 40-sheet differential oracle, evalFormulaAt path, cross-sheet + full-size checks, cap + speed); tt70-mutants.py (9/9 range mutants killed); 22 formula/sheet suites rerun green",
  },
  "WM-13": {
    note: "TT70: the edge-hold was registered as built but did not exist (only Overview's → workspace button). Now built: holding a dragged window within 8 px of the left / right desktop edge for 600 ms moves it to the neighbouring workspace and switches there; leaving the edge, releasing, cancelling or losing pointer capture disarms the timer; after a hop the edge latches (one hold = one workspace) and the half-screen snap — preview and the geometric fallback — is suppressed until the pointer leaves the edge. No hop past the first / last workspace. Meta+Shift+arrows remains the 16 px keyboard move (WM-09); the keyboard path across workspaces is Overview.",
    test: "tt70-edge.mts (5, incl. exhaustive 54-input check of the state machine); e2e-tt70-rows.mts (real mouse drag: hop + no tile on release, refused at the last workspace with half-snap intact, 300 ms touch ignored, hop back)",
    route: "src/lib/windowing/edge-hold.ts + WindowFrame.tsx (title-bar drag)",
  },
  "CT-01": { note: "TT70 test: manifest share_target (GET title/text/url → /) verified; ?url= opens a Browser tab on the shared URL and cleans the query; a javascript: URL never runs (safeBrowserUrl). Send: Notes' Share passes title + body to navigator.share — verified with an injected recorder only (headless Linux Chromium has no OS share sheet), hence partial.", test: "e2e-tt70-rows.mts" },
  "DP-13": { note: "TT70 test: compact < balanced < touch for the title bar and --fs-target, the same controls (by accessible name) in every density, none below 24 px. Measured limit: the Files toolbar buttons are text-scaled, not density-scaled.", test: "e2e-tt70-rows.mts" },
};

export function patchTT70(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, status: u.status ?? f.status, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
