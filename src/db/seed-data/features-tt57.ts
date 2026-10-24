import type { SpecRow } from "./row";

/**
 * TT57 register changes. Every upgrade names the code that implements it and the suite that verifies it against ground
 * truth outside the UI (independent oracle, saved bytes, the system clipboard, a fake clock).
 *
 *  FF-22 Writer format-change tracking (w:rPrChange): Bold / Italic / size / colour … made while recording are kept as
 *        revisions with the original formatting, listed "Formatted: <what>", accepted / rejected one by one — and
 *        Word-written rPrChange records are read and resolved too — scripts/tt57-writer-fmt.mts (lxml oracle
 *        docx_track.py, 40 random sessions, POI corpus) + e2e-tt57.mts. Also fixes a schema bug found by the oracle:
 *        a run inside a field lost its rPr into the field-code token (two w:rPr in one regenerated run).
 *        Paragraph-property tracking (w:pPrChange: align / style / list / indent) — scripts/tt57-writer-para.mts
 *        (oracle *_paras, 120 random sessions, a Word-shaped record) + e2e-tt57.mts.
 *  FF-21 Spreadsheet hyperlinks: Ctrl+K / Link button, ScreenTip, text to display, in-workbook places, Ctrl+click to
 *        follow, =HYPERLINK() cells followable, read / export / lossless-patch of <hyperlinks> + sheet relationships —
 *        scripts/tt57-sheet-links.mts (openpyxl + lxml, 13 POI workbooks, reference model) + e2e-tt57.mts.
 *  PR-10 Clock: timer fires when requestAnimationFrame is suspended (hidden tab), seconds-level timers, testable
 *        display — e2e-tt57-rows.mts (Playwright fake clock).
 *  PR-12 Clipboard history: dedupe-to-top, pin, remove, clear, search, sensitive auto-clear — tt57-units.mts +
 *        e2e-tt57-rows.mts (system clipboard read back with granted permission).
 */
const ROWS = "e2e-tt57-rows.mts";
const UP: Record<string, { status?: SpecRow["status"]; route?: string; note: string; test: string }> = {
  "FF-22": { note: "TT57 format tracking: with recording on, formatting a run (Bold, Italic, Underline, Strike, size, font, colour, highlight, super/subscript) stores w:rPrChange with the run's ORIGINAL formatting (first original kept across repeated changes; returning to it drops the record); the review panel lists 'Formatted: Bold, Font size 14 pt'; reject restores the old rPr (verbatim for Word-written records), accept keeps the new one. Paragraph-property tracking (w:pPrChange): alignment, style, list and indent edits while recording keep the paragraph's original properties (change bar in the margin, 'Paragraph: Centered' in the panel); reject restores them (a Word-written record verbatim, keeping the mark's rPr / sectPr), accept keeps the new ones; a paragraph whose mark is itself a pending insertion is not tracked separately (Word). Not tracked: table / cell property revisions and an rPrChange inside an opaque token (decided with the token).", test: "tt57-writer-fmt.mts; tt57-writer-para.mts; e2e-tt57.mts" },
  "FF-21": { route: "src/lib/formula/sheetlinks.ts + xlsx.ts / xlsx-patch.ts + Spreadsheet.tsx", note: "TT57 hyperlinks: Insert ▸ Link (Ctrl+K) with address (web, e-mail, Sheet!A1 places), text to display and ScreenTip; Ctrl+click follows (web → Browser module, mailto → OS handler, places → selection); =HYPERLINK cells are followable; links survive insert/delete rows/cols and move with Sort and copy/paste (not Paste Special), Clear All removes them, undo / .fworkbook keep them; xlsx read, export and lossless patch write <hyperlinks> + External hyperlink relationships (openpyxl-verified). Script / file / UNC targets in a file are kept but never opened.", test: "tt57-sheet-links.mts; e2e-tt57.mts" },
  "PR-10": { note: "TT57: a running timer also arms one timeout at its end time, so it fires while requestAnimationFrame is suspended (hidden tab); minutes + seconds; zero-length timers cannot start. e2e under Playwright's fake clock: a 10-minute jump with timers firing at most once still shows 10:00 (anchor-based, no tick counting), laps / pause exact to a frame, timer fires at 3 s with rAF disabled.", test: ROWS },
  "PR-12": { route: "src/lib/cliphistory.ts + Shell.tsx copy() + Clipboard.tsx", note: "TT57: copying text already in the history moves it to the top (no duplicates); entries can be pinned (never evicted, survive Clear), removed and searched; sensitive (Vault) copies stay masked and the system clipboard is cleared after 30 s if it still holds the secret. Global (other-app) history remains impossible on the web and is stated in the UI. The 30 s auto-clear itself is not exercised by a test.", test: "tt57-units.mts; " + ROWS },
};

export function patchTT57(f: SpecRow): SpecRow {
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
