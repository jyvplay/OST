import { F, type SpecRow } from "./row";

/**
 * TT60 register additions + changes. USER-DIRECTED EXTENSION ROWS (Class A Writer and Spreadsheet): the three gaps the
 * TT59 ledger disclosed against Word / Excel — table revisions, proofing outside the main text, spelling across sheets —
 * each verified against ground truth outside our code (lxml / python-docx / openpyxl reading saved bytes).
 */
export const tt60Features: SpecRow[] = [
  F("FF-40", "FF", "Writer Track Changes for tables: inserted / deleted rows (change bars), per-change accept / reject, table / row / cell property change records",
    "A", "P2", "src/lib/office/wordml.ts (w:trPr/w:ins + w:del read / written in CT_TrPr order) + wordedit.ts (tableRowOp under tracking, revisions() rows + tblPrChange / trPrChange / tcPrChange, resolveOne) + writer/view.ts (row change bars) + Writer.tsx",
    "ECMA-376 §17.13.5: a tracked row deletion keeps the row (dashed bar) and strikes its text; the author's own pending inserted row is simply removed; another reviewer's inserted row deleted carries both marks (ins then del) and each is reviewable; rejecting a row deletion restores its struck text in the same action; accepting the deletion of a table's last row removes the table. Property change records from files are listed (Table / Row / Cell properties) — accept drops the record, reject restores the recorded properties (style, borders, shading, width). Revision ids are made unique on save (one deletion over several cells writes one w:del per paragraph). Not done: cell-level w:cellIns / w:cellDel / w:cellMerge (preserved, not reviewable); column insert / delete is refused while tracking with a message (Word records no column revision either).",
    "built", "tt60-writer-tblrev.mts (7 incl. 40 randomized sessions vs the lxml oracle docx_tblrev.py; 13 mutants killed); e2e-tt60.mts FF-40"),
  F("FF-41", "FF", "Spreadsheet spelling in all sheets: tab order from the active sheet (wrapping), Change All across sheets",
    "A", "P2", "src/lib/formula/sheetspell.ts (workbookSpellIssues, changeAllWorkbook) + sheet-spell.tsx (All sheets option) + Spreadsheet.tsx",
    "Excel checks the sheets of the selected group; with no sheet grouping UI here, \"All sheets\" is the explicit equivalent. The order is fixed when the check starts, so jumping to an issue on another sheet never reorders the list; a selection range limits only the single-sheet check. Verified with an openpyxl-authored 3-sheet workbook saved by the lossless patcher and read back by openpyxl.",
    "built", "tt60-sheet-spell-all.mts (2, 4 mutants killed); e2e-tt60.mts FF-41"),
  F("FF-42", "FF", "Writer spelling in headers, footers, footnotes and endnotes (listed after the main text, with their place)",
    "A", "P2", "src/lib/office/wordspell.ts (storyIssues, allIssues, issuePara, story fixes) + writer/SpellPanel.tsx (\"in Header\", \"in Footnote 2\") + Writer.tsx",
    "A fix outside the main text replaces the word inside its runs, so run formatting survives (unlike the TT58 note editor, which rewrites a note as plain text); the story's blocks are copied before the change so undo restores them; a stale issue is refused. Header / footer / note fixes are not recorded as tracked changes (main-text fixes are). Verified with python-docx-authored headers (docx_hf.py) and lxml (docx_notes.py, run bold flags).",
    "built", "tt60-writer-spell-stories.mts (3, 10 mutants killed — found a real bug: fixed file notes were not written); e2e-tt60.mts FF-42"),
];

const UP: Record<string, { note: string; test: string; route?: string }> = {
  "FF-22": { note: "TT60 tables: row insertions / deletions are tracked and reviewable, and table property change records from files can be accepted / rejected (FF-40).", test: "tt60-writer-tblrev.mts" },
  "FF-38": { note: "TT60 headers, footers and notes are proofed too (FF-42).", test: "tt60-writer-spell-stories.mts" },
  "FF-39": { note: "TT60 optional check of all sheets (FF-41).", test: "tt60-sheet-spell-all.mts" },
  "RG-05": { route: "src/lib/governor.ts (snapshot + heavyWorkRefusal) + Backup.tsx", note: "TT60 completed the stated behaviour: Backup refuses to build a bundle on a discharging battery below 20 % or with Data Saver on, says why, and offers Build anyway; background loops pause on low battery. Fixed the governor reading every healthy 60 Hz display as WARM (threshold was 14 ms against a 16.7 ms rAF interval), which also hid the battery reason. The browser test injects navigator.getBattery() answers (no battery in the sandbox).", test: "tt60-units.mts; e2e-tt60.mts RG-05" },
};

export function patchTT60(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
