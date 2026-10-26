# TT74 — Writer + Spreadsheet class A, FF-02 extract / convert class A

## Runtime honesty

Used: bash sandbox, Node 22 + tsc, Next 16.2.6 production build, Playwright 1.64.1 + headless Chromium 143, embedded
Postgres 17.10, Python 3.11 venv with **test-only oracles**: mammoth 1.13.0 (BSD-2), markdown-it-py (MIT), python-docx,
python-pptx, openpyxl (MIT), lxml + the ECMA-376 transitional XSDs. Corpus: Apache POI test-data (Apache-2.0) — 353 xlsx,
130 docx, 95 pptx — plus 386 Markdown files from npm packages already installed.

Not available, so NOT claimed: Microsoft Excel / Word / PowerPoint, LibreOffice, Safari / Firefox, mobile devices,
theorem provers, parallel agents. "Class A" therefore means *ordinary-app grade on a measurable whole-corpus gate with an
oracle independent of the app*; it does not mean "verified in Office".

## Formal model (hide / filter / SUBTOTAL)

* Sheet state: `hiddenRows: Map<row, "manual" | "filter">`, `hiddenCols: Set<col>`,
  `autoFilter: { ref, cols: Record<offset, string[]>, foreign? } | null`.
* `display(c, r)` = the cell's formatted text. A data row `r` of the filter range is visible under the filter iff for every
  criterion column `c` : `fold(display(c, r)) ∈ fold(criteria[c])` (`fold` = en-US lower case; `""` = blanks).
* Invariants (tested: U4, U8, N11, N13, H6–H14):
  1. `apply` changes only `"filter"` entries; `"manual"` entries are never removed by the filter.
  2. `unhide(range)` removes only `"manual"` entries.
  3. `setAutoFilter(null)` removes every `"filter"` entry.
  4. Foreign criteria are never re-applied (the file's hidden rows stay).
  5. Insert / delete is a monotone index shift of every hidden entry and the filter ref; deleting the whole filter range
     removes the filter and its `"filter"` entries.
  6. Bounds: rows < 1,048,576, columns < 16,384, at most 200,000 hidden entries per sheet from JSON, 64 external books.
* SUBTOTAL(k, refs): row `r` is skipped iff `why(r) = "filter"` (k ≤ 11) or `why(r) ≠ ∅` (k > 100). AGGREGATE options
  1/3/5/7 skip every hidden row. Hidden **columns** never cause a skip. Cells whose formula contains SUBTOTAL / AGGREGATE
  are skipped. All excluded: k = 1, 7, 8, 10, 11 → `#DIV/0!`; 2–6, 9 → 0; AGGREGATE 12 → `#NUM!`, 13 → `#N/A`.
* File mapping (ECMA-376 §18.3.1.73 row@hidden, §18.3.1.2 autoFilter): one hidden flag per row. Reading: a row hidden
  inside an AutoFilter (sheet or table) **with at least one filterColumn** is `"filter"`, otherwise `"manual"`. This
  rule was corrected this tier by Excel's own cached values (POI ConditionalFormattingSamples: "Regional sales2" has a
  table icon filter → SUBTOTAL 9 = 1,469,066; "Regional sales3" has a criteria-less table filter and a hand-hidden row →
  SUBTOTAL 9 = 9,071,953, 109 = 8,171,954). Consequence (declared): a hand-hidden row inside a filter with criteria
  reads back as filtered.

## Class A criteria and results

| Gate | Oracle (independent) | Result |
|---|---|---|
| D1 docx → Markdown | mammoth 1.13 | 111 / 111 documents, 7 axes (18 damaged / encrypted refused, 1 oracle error) |
| M1 Markdown → docx | markdown-it-py (+ python-docx opens) | 386 / 386, 7 axes; python-docx 386 / 386 |
| M2 Markdown → docx schema | ECMA-376 transitional XSDs via lxml (test-only) | 386 outputs, 0 schema errors |
| K1 pptx → outline | python-pptx | 83 / 83 decks, 551 / 551 slides |
| X1 xlsx → CSV | openpyxl reading Excel's cached values | 446,489 / 446,580 cells; 0 outside the allowlist |
| X2 CSV round trip | self-consistency + Excel typing rules | 783 / 783 raw; 780 / 783 display fixpoints |
| U1–U9, N1–N18 | Microsoft documentation semantics, openpyxl | 27 / 27 |
| Mutants | tt74-mutants.py (incl. P1–P3 aimed at this tier's repairs) | 28 / 28 killed |
| Browser | e2e-tt74-office.mts (Chromium 143 headless, real UI) | 6 / 6 |

### X1 allowlist (77 cells, evidence per file in `scripts/tt74-office.mts`)

TODAY()-based caches (56574, 56688_4); add-in functions (47804, 52575_main, HsGetVal, atp, 49783, 54436, 56502,
customIndexedColors); iterative calculation (57535, bug67784 A9); duplicate part names (duplicate-filename); oracle reads
nothing (sample-beta); stale POI caches (clone_sheet, bug60858); an externalLink without a cache
(link-external-workbook-b — Excel also shows #REF! once it recalculates without the source).

### Open (our bugs, counted, not hidden): 14 POI EverythingTests cells → 4 after TT79

TT74 list: G31 `=E10/D7`, L87 / M87 `=+E7`, `=+L10:N10` (implicit intersection of a text cell), E240 `CHOOSE(#REF!,1)`,
L420 `DOLLAR(range)`, G716 / D872 / E872 approximate HLOOKUP / LOOKUP over mixed types, G732 `IF(D7,#VALUE!,3)` with a
blank condition, G816 `LARGE(TRUE,1)`, M936 `MODE(B9,2,D7)`, G1008 `OFFSET(F7,E7:I7,E7:I7)`, J1180 `ROUND(blank,blank)`,
J1328 `SUMPRODUCT` over a single text cell.

**TT79:** 10 fixed (G31, L87, M87, E240, L420, G732, G816, G1008, J1180, J1328 — see DESIGN-TT79.md); still open:
G716 / D872 / E872 (approximate lookup over mixed types) and M936 (MODE with a blank direct reference). The cap in
`scripts/tt74-office.mts` is now 4.

## Fixed this tier (with the evidence that found them)

* CSE legacy array formulas fill exactly their range (POI MatrixFormulaEvalTestData: 167 cells).
* ROUND on the 15-significant-digit decimal; A-family direct text → #VALUE!; XLOOKUP binary search returns its landing
  position even on a type change (POI xlookup.xlsx Sheet2!F2 = 0.22).
* LEFT / RIGHT / MID / REPLACE / SUBSTITUTE truncate and range-check counts; DATE truncates; YEAR / MONTH / DAY / WEEKDAY of
  a negative serial → #NUM!; SUMPRODUCT returns an error from its arrays (POI EverythingTests, 16 cells).
* **Second-order adversary finding:** a save whose only change was hidden rows / columns / AutoFilter was taken for a
  no-edit save and returned the original bytes. Found by mutant H1 surviving → test U6 extended → fixed in
  `xlsx-patch.ts` (the shortcut compares hidden state and the filter).
* **Modal-shortcut finding:** keys and clipboard events typed in the filter list bubbled into the grid (Delete would
  clear the cell behind it). The list now stops key and clipboard propagation and takes focus on open (e2e 2).
* CSV import cap reported the source row count instead of the imported rows.
* Markdown → docx now reports raw HTML tags kept as literal text as a loss.
* **Reader: phonetic guides.** `<rPh>` (furigana) text in shared strings is no longer appended to the cell value —
  Excel shows 豊田, not 豊田トヨタ. Found by the tt67 whole-corpus differential (50299.xlsx 6 cells, 51519.xlsx 24 cells);
  the differential now has an explained "phonetic" category (kana-only suffix) instead of accepting any change.
* **Attribute quoting (found by tt72-office S1 in the regression run):** the new AutoFilter reader matched `ref="…"`
  only; XML allows single quotes and spaces around `=`. `xmlAttr()` in sheetfilter.ts is used by both the sheet and the
  table AutoFilter readers; N17 + mutant P1 hold it.
* **Hyperlink targets (found by the new M2 schema gate):** a Markdown link like `[x]((https://…))` produced the
  relationship target `(https://…)`, not a valid `xsd:anyURI` (colon in the first relative segment). `uriTarget()` adds
  `./` there and percent-encodes characters URIs forbid (existing `%XX` kept). The M1 probe normalises both sides the same
  way (the mammoth oracle unquotes hrefs). N18 + mutants P2 (schema) / P3 (encoding — not schema-observable, since lxml's
  anyURI accepts IRIs) hold it.
* **Test-harness fix:** the e2e name box shows `Sheet1!A4`; toolbar buttons' accessible names include their title
  (WCAG 2.5.3), so the new Filter / Hide / Unhide buttons carry test ids and `aria-pressed` reflects their state.
* tt49-writer oracle: python-docx ignores legacy `w:type="odd"`; the harness detects legacy-odd before `setHf`.

## Approaches considered (mechanism-distinct)

1. Filter state as a per-row visibility bitmap recomputed on every render (rejected: SUBTOTAL needs *why* a row is hidden).
2. Filter as a derived view (no stored hidden rows) — rejected: the file format stores hidden rows, foreign criteria
   cannot be evaluated.
3. **Chosen:** stored `Map<row, reason>` + pure apply function; the reason is the only thing SUBTOTAL reads.
4. CSV via a streaming state machine vs split-on-regex — chosen state machine (quotes spanning lines, bare CR).
5. Markdown parsing via an imported CommonMark library — rejected (dependency weight); original parser, markdown-it-py
   used only as the test oracle.
6. docx → Markdown through HTML (mammoth-style) vs direct from the Word model — chosen direct (keeps notes, tables,
   list levels; HTML export reuses the editor's sanitised DOM).

## Remaining blockers / limits (TT74)

* Export .xlsx (new package) does not write Excel tables → structured references become #REF! after reopening that
  export, and a table's own AutoFilter is not exported (the in-place Save keeps both).
* Custom / top-10 / dynamic / colour / icon / date-group filter criteria: kept from files, not re-applied or editable.
* Grouping / outline levels not modelled. Excel's 16-row CSV trailing-delimiter quirk not copied.
* 14 open EverythingTests cells (above); 53 held-out number-format cells disagree (26,893 / 26,946; 77 at TT73) — re-checked by tt73-office.
* No OOXML Strict WordprocessingML; whole-column arrays see the used area only; sparse ranges capped at 16 full columns.
* Never run against Excel / Word / LibreOffice.
