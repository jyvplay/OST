import { F, type SpecRow } from "./row";

/**
 * TT64 register additions + changes. USER-DIRECTED EXTENSION ROWS (Class A Writer + Spreadsheet): the TT63 ledger's standing
 * Writer gap was "tracked column operations are refused"; the Spreadsheet's was "Paste Link writes absolute references only".
 * TT64 records column insert / delete as the schema's own cell revisions (w:cellIns / w:cellDel + w:tblGridChange,
 * ECMA-376 §17.13.5.4 / .5 / .33), reviewed as one change per column, and makes Paste Link follow Excel's rule (one cell
 * absolute, a range relative).
 */
export const tt64Features: SpecRow[] = [
  F("FF-48", "FF", "Writer Track Changes for table columns: a column inserted or deleted while tracking is recorded (w:cellIns / w:cellDel on its cells, the replaced widths in w:tblGridChange) and reviewed as ONE change — accept / reject = the untracked operation / the original table, widths included",
    "A", "P2", "src/lib/office/wordedit.ts (tableColOp tracked path, columnGroups, resolveColumn, settleGrid) + wordml.ts (w:tblGridChange read / write) + Writer Review pane",
    "A whole column = in a table of 2+ rows, every row either has its single-span cell at that grid column marked cellIns (or every one cellDel) by one author, or no cell there at all (its empty gridBefore / gridAfter region). Such a column is listed as \"[Table column]\" (Inserted / Deleted column N, k cells) and resolved like the column operation itself: accepting an insertion / rejecting a deletion removes the markers; rejecting an insertion / accepting a deletion removes the grid column (rows with an empty slot there shrink their gridBefore / gridAfter); the first tracked insert keeps the original widths in w:tblGridChange and Reject restores them exactly once no cell revision is left (Accept All / Reject All also settle a width-only grid change from a file). Deleting the author's own pending inserted column removes it outright. Fixed with it: column operations now address GRID columns on rows with w:gridBefore (they counted from the row's first cell and hit the wrong cell), and the page draws gridBefore / gridAfter slots so such rows line up. Limits: a tracked delete is refused (with a message) where a merged (gridSpan) cell crosses the column or one of its cells already has another pending cell change; one-row tables keep TT61's per-cell semantics (a one-cell \"column\" is a cell); not opened in Word here (none in the sandbox) — the XSDs and the independent lxml oracle are the check.",
    "built", "tt64-writer-trackcols.mts (6 vs the lxml oracle docx_tblrev.py grid views + ECMA-376 XSDs: markers / grid change / one change / reload saves every part identically (core.xml timestamp aside); 48 random tables × left / right / delete — oracle accept/reject views of the tracked file and ours (Accept All, Reject All, the one change both ways) all equal the untracked op / original, text and widths; sequences + mixed orders + own pending column; refusals, 1-row, rows + columns; independent-writer files, mixed authors, reserved / renumbered ids, width-only grid change; gridBefore / gridAfter tables; 20 mutants killed); e2e-tt64.mts FF-48"),
];

const UP: Record<string, { note: string; test: string; route?: string }> = {
  "FF-22": { note: "TT64: columns inserted / deleted while tracking are reviewable changes (FF-48); column operations address grid columns on rows with w:gridBefore.", test: "tt64-writer-trackcols.mts; e2e-tt64.mts" },
  "FF-44": { note: "TT64: a whole tracked column of cellIns / cellDel markers is reviewed as one column change with exact grid handling (FF-48); single cells keep the per-cell semantics.", test: "tt64-writer-trackcols.mts" },
  "FF-28": { note: "TT64: Paste Link follows Excel's rule — a single copied cell links absolutely (=$C$1), a copied range relatively (=A1, =B1, …), so the linked block can be copied on.", test: "tt59-sheet-paste.mts; e2e-tt64.mts" },
};

const OLD_FF40 = "column insert / delete is refused while tracking with a message (Word records no column revision either).";
const NEW_FF40 = "TT64: column insert / delete while tracking is recorded as cell revisions and reviewed as one change (FF-48).";
const OLD_FF28 = "Paste Link writes absolute references to the copied cells (=$C$1, ='Data 2026'!$B$2;";
const NEW_FF28 = "Paste Link writes references to the copied cells — TT64: absolute for a single cell (=$C$1), relative for a range (='Data 2026'!B2…, Excel's rule;";

export function patchTT64(f: SpecRow): SpecRow {
  if (f.code === "FF-40" && f.nuance.includes(OLD_FF40)) f = { ...f, nuance: f.nuance.replace(OLD_FF40, NEW_FF40) };
  if (f.code === "FF-28" && f.nuance.includes(OLD_FF28)) f = { ...f, nuance: f.nuance.replace(OLD_FF28, NEW_FF28) };
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
