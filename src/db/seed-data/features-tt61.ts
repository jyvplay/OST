import { F, type SpecRow } from "./row";

/**
 * TT61 register additions + changes. USER-DIRECTED EXTENSION ROWS (Class A Writer and Spreadsheet): the gaps the TT60
 * ledger disclosed — edited notes lost their formatting, header / footer misspellings were only listed (not underlined on
 * the page), cell insertions / deletions could not be reviewed — plus a latent Spreadsheet save bug found while auditing.
 * Each is verified against ground truth outside our code (lxml / python-docx / openpyxl reading saved bytes).
 */
export const tt61Features: SpecRow[] = [
  F("FF-43", "FF", "Writer footnote / endnote editing keeps formatting: only the changed text is rewritten (bold / italic / underline and paragraph styles survive)",
    "A", "P2", "src/lib/office/wordedit.ts (editNoteText + diffHunks: from-scratch Myers shortest edit script) + Writer.tsx (Notes panel commit, honest status when it falls back)",
    "Typed text takes the formatting of the character before it in the same paragraph (Word's typing rule); text typed over a selection takes the formatting of its first character (Word's replace rule); a new line splits the paragraph and keeps its style; deleting a line break joins paragraphs; the reference mark always stays first. A note holding tracked changes, or an edit that cuts into a field / content control, falls back to plain text — and the status line says so.",
    "built", "tt61-writer-notes-rich.mts (7: hand-written run expectations, 60-edit randomized differential, 400-pair Myers-vs-DP optimality, 6-file POI corpus — 9 of 11 notes kept formatting, 2 hit a content control and fell back; 5 mutants killed); e2e-tt61.mts FF-43"),
  F("FF-44", "FF", "Writer Track Changes for table cells: inserted / deleted cells (w:cellIns / w:cellDel) listed and accepted / rejected one by one or all at once",
    "A", "P2", "src/lib/office/wordedit.ts (cellMarks, removeCell, revisions(), resolveOne) + Writer Review pane",
    "ECMA-376 §17.13.5.4 / .5: accepting a deletion or rejecting an insertion removes the cell; the row keeps filling the table grid through w:gridAfter (placed among the base row properties, before any w:trPrChange); an emptied row goes and an emptied table goes. w:cellMerge is listed read-only and refused (its vertical-merge semantics are not modelled) — review it in Word.",
    "built", "tt61-writer-cellrev.mts (4 vs the lxml oracle docx_tblrev.py — accept/reject views, grid_ok, tcpr_ok, 12 random decision/order trials; 6 mutants killed); e2e-tt61.mts FF-44"),
];

const UP: Record<string, { note: string; test: string; route?: string }> = {
  "FF-42": { note: "TT61 header / footer misspellings are underlined on the page too (every page that shows the part), not only listed.", test: "e2e-tt61.mts FF-42" },
  "FF-22": { note: "TT61 inserted / deleted table cells are reviewable too (FF-44); notes keep formatting when edited (FF-43).", test: "tt61-writer-cellrev.mts; tt61-writer-notes-rich.mts" },
  "FF-21": { note: "TT61 fix: deleting a PivotTable whose output cells were already deleted now persists (the lossless-save shortcut ignored pivot definitions and returned the old file, so the pivot came back on reopen).", test: "tt61-sheet-pivot-delete.mts" },
};

export function patchTT61(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
