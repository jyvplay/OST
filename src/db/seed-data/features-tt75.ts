import { F, type SpecRow } from "./row";

/**
 * TT75 register additions + changes (user-directed: "turn both the writer and spreadsheet apps to Class A features this
 * turn … complete one other core feature into class A" → FF-10 EPUB reader; "increase the number of features in a
 * testable state" → four new rows, each with a passing headless gate AND a real-browser test where it has a UI).
 * Class A is raised ONLY on a passing, measurable whole-corpus gate whose oracle is independent of the app:
 * openpyxl + the ECMA-376 XSDs for tables, the W3C epub-tests + the IDPF epub3-samples + an lxml OPF oracle for EPUB
 * (docs/DESIGN-TT75.md §Class A). Excel, EPUBCheck (needs Java) and other reading systems are not available in this
 * sandbox; "A" means ordinary-app grade on the measurable corpus, not "verified in Excel / Apple Books / Thorium".
 */
const T75 = "tt75-office.mts";
const E75E = "tt75-epub.mts";
const B75 = "e2e-tt75-books.mts";
export const tt75Features: SpecRow[] = [
  F("FF-58", "FF", "Spreadsheet Excel tables survive Export .xlsx (new package) and structural edits: table parts written (name / ref / header / totals / column names / filter), structured references stay live, insert / delete rows and columns grow, shrink, rename and remove tables with Excel's refusals",
    "A", "P2", "src/lib/formula/sheettables.ts (structural model, refusals, default ColumnK names, #REF! on removal, ST_Xstring names, table part XML) + xlsx.ts (table parts in writeXlsxWorkbook, readTables unescapes _xHHHH_) + xlsx-patch.ts (in-place save: geometry, removed tables lose part / relationship / tablePart / override) + workbook-json.ts (tables, legacy / CSE cells) + sheetops.ts insertDelete + Spreadsheet.tsx (refusal toasts)",
    "Excel's rules from Microsoft support pages and community reports: a header row cannot be deleted alone; deleting every row of a table removes it (its references become #REF!); an insert / delete that would move cells of more than one table is refused. Calculated columns are NOT auto-filled into an inserted row (Excel does); custom / top-10 / dynamic / colour criteria are kept and re-written (allowlist-sanitised) but not evaluated. Excel itself was not run.",
    "built", `${T75} T1 (29 corpus workbooks, 61 tables, 4,022 structured formulas keep their values after reopening; openpyxl agrees on every table; 61 parts schema-valid), T2 (214 structural edits, 90 justified refusals, 59 header deletes refused, 162 packages read back by openpyxl), T3–T5, N1–N8; tt75-mutants.py`),
  F("FF-59", "FF", "Recalculation range memo: within one pass a range / blank mask is materialised once and shared (copied) by every formula that reads it — cycles excluded",
    "A", "P2", "src/lib/formula/engine.ts (pass(): rangeMemo + maskMemo keyed by the resolved address; circHits guard; Workbook.memoRanges switch for differential tests)",
    "Measured on POI StructuredRefs-lots-with-lookups.xlsx (26,593 lookups over a 3,798-row table column): full recalc 49.9 s → 0.63 s (80×) in this sandbox's Node 22; every insert / delete in that workbook went from ~50 s to < 1 s. A range read while one of its cells is still being evaluated (a cycle) is never cached.",
    "built", `${T75} N9 (300 random workbooks, 166,945 cells identical with the memo on and off, 138 with a cycle through a range; kills the no-cycle-guard and column-blind-key mutants), T1 / T2 (corpus values unchanged)`),
  F("FF-60", "FF", "Books: EPUB fixed layout and roll layout — pre-paginated viewports scaled to fit, synthetic two-page spreads (page-spread-left / right / center, first page alone, right-to-left order), spread none / landscape / both, and roll renditions as one gap-free vertical strip",
    "A", "P3", "src/lib/epub/epub-core.ts (layout / spread / page-spread properties, first conflicting property wins, spreadGroups) + epub-content.ts (fxlViewport: first meta, first width / height, tolerant parsing) + Books.tsx (scaled frames, spread pairing, roll strip sized to each document's content height)",
    "EPUB 3.3 + EPUB Reading Systems 3.3 rendition rules as encoded by the W3C epub-tests lay-* / fxl-* books. Media overlays are not supported.",
    "built", `${E75E} W1 (lay-* / fxl-* predicates); ${B75} B6 (900×600 viewport scaled; page-spread-left on the left after the lone first page; spread none = one page), B12 (roll: three parts stacked with no gaps, each as tall as its content), B16 (screenshots)`),
  F("FF-61", "FF", "Books: reading safety — book scripts and event handlers never run, remote resources are never fetched, external / mailto links open only after an in-app question that starts on Cancel, frames are sandboxed without allow-scripts under a CSP, hostile packages are refused with clear errors",
    "A", "P2", "src/lib/epub/epub-content.ts (allowlist rewrite: scripts / handlers / remote URLs dropped, external links kept ONLY as data-epub-ext with href \"#\", CSP meta) + epub-core.ts (OCF method / zip guards, path clamping, XML strict, no external entities) + Books.tsx (consent via askConfirm, sandbox=\"allow-same-origin\") + src/lib/ask.ts askConfirm + AskHost (a field-less question focuses Cancel)",
    "Remote book resources are never loaded (not even with consent); the Browser app opens a consented external link through its own proxy.",
    "built", `${E75E} W2 (45 IDPF books, 2,984 documents: no handler, no remote src, no live external href), N1–N20; ${B75} B4 (no script ran, no allow-scripts, CSP present; Enter on the fresh question and Escape and Cancel open nothing; only OK opens the Browser), B15 (in-book link through the frame listener; the frame never navigates)`),
];

const UP: Record<string, { note: string; test: string; tier?: SpecRow["tier"]; status?: SpecRow["status"]; route?: string }> = {
  "FF-10": {
    tier: "A", status: "built", route: "Books app: first-party EPUB 3.3 reader (src/lib/epub) — OCF, package, nav / NCX, reflowable / fixed / roll renditions",
    note: "TT75 class A: Books reads EPUB 2 and 3 — container → first rootfile → package (titles, creators, identifiers, direction, rendition properties) → spine in order with linear=\"no\" reachable by link → manifest fallbacks → nav or NCX contents and page list → chapters rewritten into sandboxed XHTML frames (images / fonts / CSS from the book as blob URLs, -epub- properties mapped, obfuscated fonts de-obfuscated, vertical writing in scrolled mode). Pages (CSS columns) or scrolling, contents, search with highlighted hits, themes, font size, spreads, right-to-left keys, saved position. Gate: 206 W3C epub-tests (111 predicates, 66 generic, 3 rendered, 24 n/a — media overlays and scripting, 2 expected errors), 45 IDPF books / 2,984 documents rewritten safely, 251 books compared with an lxml OPF oracle with 0 disagreements. Peek / forge text extraction now uses the same core (grade B, falls back to the old lenient reader for non-conformant files at grade C). Not available here: EPUBCheck (Java), other reading systems.",
    test: `${E75E} W1 W2 W3 C1–C6 N1–N20; ${B75} B1–B16; integration.mts FF-10`,
  },
  "FF-19": {
    note: "TT75: Excel tables are carried by Export .xlsx (new package) and follow insert / delete (FF-58); recalculation shares range reads within a pass (FF-59).",
    test: `${T75}`,
  },
  "FF-21": {
    note: "TT75: the TT74 blocker \"Export .xlsx drops tables, so structured references become #REF! after reopening\" is closed — table parts are written and validated (FF-58); ROWS / COLUMNS of a non-reference error now propagate it as Excel does.",
    test: `${T75} T1 T2 N10`,
  },
  "SH-13": {
    note: "TT75 fix: a file opened by deep link / Open with after a reload could be swallowed — new window ids restarted at w1 and collided with a restored window, which the window manager focused instead (the file never loaded). Ids now continue after the restored ones.",
    test: `${B75} B14`,
  },
};
export function patchTT75(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, tier: u.tier ?? f.tier, status: u.status ?? f.status, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
