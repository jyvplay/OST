import type { SpecRow } from "./row";

/**
 * TT58 register changes. Every upgrade names the code that implements it and the suite that verifies it against ground
 * truth outside the UI (independent oracle, saved bytes, Chromium's own permission state, the network log).
 *
 *  FF-22 Writer footnotes / endnotes: insert at the cursor (Ctrl+Alt+F / Ctrl+Alt+D, Insert ▸ Footnote, Notes panel),
 *        edit the note text, delete (also by deleting the reference mark), undo / redo, footnotes numbered 1 2 3 and
 *        endnotes i ii iii in reference order on the page; saves create / update word/footnotes.xml + endnotes.xml with
 *        Word's separator notes, FootnoteText / FootnoteReference styles, relationship + content type; untouched note
 *        parts stay byte-identical; Track Changes-aware — scripts/tt58-writer-notes.mts (lxml + python-docx oracle
 *        docx_notes.py, POI corpus, 120 random sessions) + e2e-tt58.mts.
 *  FF-21 Spreadsheet PivotTables: Data ▸ PivotTable from the selection / current region; up to 3 row fields, 2 column
 *        fields, 6 value fields with Excel's 11 summary functions; report filter; subtotals and grand totals; Excel
 *        tabular layout written to a new sheet; edit, Refresh (Alt+F5), Refresh All (Ctrl+Alt+F5), delete; overwrite /
 *        overlap protection; definition kept in .fworkbook and undo — scripts/tt58-sheet-pivot.mts (pandas groupby
 *        oracle over 300 random tables, every shown cell) + e2e-tt58.mts (openpyxl reads the saved values).
 *  SR-04 Web results opt-in: e2e-tt58-rows.mts (network log while typing, row ranking, provider URL).
 *  DP-11 Least privilege: e2e-tt58-rows.mts (every app opened, prompting APIs wrapped, permission states).
 */
const ROWS = "e2e-tt58-rows.mts";
const UP: Record<string, { status?: SpecRow["status"]; route?: string; note: string; test: string }> = {
  "FF-22": { note: "TT58 footnotes / endnotes: insert at the cursor (Ctrl+Alt+F footnote, Ctrl+Alt+D endnote, Insert ▸ Footnote, Notes panel buttons), type / edit the note text in the Notes panel, Go to, Delete (deleting the reference mark drops the note on save), undo / redo; footnotes numbered 1, 2, 3 and endnotes i, ii, iii in reference order at the end of the page view. Save creates word/footnotes.xml / endnotes.xml when missing (separator + continuationSeparator notes, relationship, content type override) with FootnoteText / FootnoteReference / EndnoteText / EndnoteReference styles; untouched note parts are byte-identical; notes referenced from inside unknown XML are kept. Limits: an edited note becomes plain text (one paragraph per line, its run formatting is not kept).", test: "tt58-writer-notes.mts; e2e-tt58.mts" },
  "FF-21": { route: "src/lib/formula/pivot.ts + pivotsheet.ts + Spreadsheet.tsx", note: "TT58 PivotTables: Data ▸ PivotTable from the selection or current region (source editable, Sheet!A1:D20); up to 3 row fields, 2 column fields, 6 value fields summarised by Sum / Count / Average / Max / Min / Product / Count Numbers / StdDev / StdDevp / Var / Varp (Excel definitions: text ignored by numeric summaries, #DIV/0! when there is nothing to average, an error in the data shows that error); report filter with an item checklist; subtotals and grand totals on / off; items grouped case-insensitively and sorted numbers < text < logicals < errors < (blank). Written in Excel's tabular form to a new sheet PivotN (filter caption at A1, table at A3); the cursor on a pivot + PivotTable edits it; Refresh (Alt+F5) / Refresh All (Ctrl+Alt+F5) recompute from the source; Delete PivotTable; refuses to overwrite data or overlap its source; definition saved in .fworkbook and undo. In .xlsx the table is saved as values and the definition as hidden sheet-scoped string names (_FusionPivotN_k, ≤255 characters each; fresh export and lossless patch), so Refresh / edit work after reopening here. Limits: no pivotCache / pivotTable parts — Excel shows the values as an ordinary range, not an Excel PivotTable (not verified in Excel: none in the sandbox). Rows / columns inserted or deleted inside the source grow / shrink it and shift its fields (a deleted field leaves the pivot); a pivot moves with its own cells.", test: "tt58-sheet-pivot.mts; e2e-tt58.mts" },
  "SR-04": { note: "TT58 verified in a real browser: off by default — no web row and no outside request while typing; opted in — exactly one row, ranked below every local result, showing the provider URL and 'sent only on click'; still no request while typing.", test: ROWS },
  "DP-11": { note: "TT58 verified in a real browser: loading the desktop and opening every registered app calls none of the prompting permission APIs (notifications, geolocation, camera / microphone / screen, clipboard read, persistent storage, file pickers, MIDI, Bluetooth, USB, HID, serial, contacts, wake lock, idle detection) and Chromium reports every permission still 'prompt'.", test: ROWS },
};

export function patchTT58(f: SpecRow): SpecRow {
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
