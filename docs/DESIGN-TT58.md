# DESIGN-TT58: Writer footnotes and endnotes, Spreadsheet PivotTables, SR-04 and DP-11 verified

This tier follows the tier-5 protocol (A–J). Each section below names the code and the suite that checks it. The numbers are under "Results".

## Runtime honesty

**What ran:**
- A bash sandbox with 2 cores and 3 GB.
- Node 22.22.3 with `--experimental-strip-types`, `tsc`, and Next 16.2.6 (`next build` + `next start`).
- Playwright 1.64.1 driving headless Chromium 143 (the @sparticuz build).
- Embedded PostgreSQL 17.10.
- A Python 3.11 venv with **lxml, python-docx, openpyxl and pandas 3.0.6** (BSD-3, installed from PyPI this turn). These are used only as test oracles. pandas is not shipped and not imported by the app.

**Not available, so nothing here claims them:**
- Theorem provers and parallel agents.
- Microsoft Word / Excel and LibreOffice. There is no "opens in Office" check (PR-11), and no check that Excel shows our footnotes or accepts our hidden pivot names. Those claims rest on ECMA-376 plus openpyxl and python-docx parsing the files.
- Firefox, Safari and phones.

## A. Formal model

**Footnotes and endnotes (FF-22, ECMA-376 §17.11).**

*Document model*
- A document holds `refs`, the sequence of note-reference tokens `k(kind, id)` in reading order. This includes refs inside tables, text boxes, and opaque (unknown) XML, plus headers and footers.
- It also holds `notes = {(kind, id) → (blocks, src?, dirty)}`.
- The view numbers footnotes 1, 2, 3… and endnotes i, ii, iii… by first appearance in `refs`.

*Edit operations*
- `insertNote(pos, kind, text)` takes a fresh id: `max(id) + 1` per kind, never 0 or −1. It then:
  - adds `notes[(kind, id)] = noteBlocks(text)` with `dirty = true`;
  - inserts `k(kind, id)` at `pos`. Under Track Changes, the token is inside a `w:ins`.
- `setNoteText` replaces the blocks and sets `dirty`.
- `deleteNote` removes the token. Under Track Changes it marks the token deleted instead.

*Save rule (writeWord)*
- Let `R` be the refs at save time and `R0` the refs at open time. A part is rewritten only if some note is dirty or some `(k, id) ∈ R0 \ R`. Otherwise its bytes are copied.
- A rewritten part:
  - keeps the separator notes (`w:type` = separator, continuationSeparator, continuationNotice) verbatim;
  - keeps clean notes as their original XML;
  - re-serializes dirty notes;
  - drops a note only if it is unreferenced AND (dirty or referenced at open). Orphans that were already in the file are kept.
- A missing part is created with Word's two separator notes (ids −1 and 0), a relationship, and a content-type Override.

*Invariants*
- `dangling = ∅`: every ref has a note.
- Ids are unique per part.
- Every note starts with `w:footnoteRef` / `w:endnoteRef`.
- Untouched parts are byte-identical.
- Each of these is checked by the lxml / python-docx oracle `scripts/oracle/docx_notes.py`.

**PivotTables (FF-21).**

*Inputs*
- A source table `T` with a heading row `H` (no blank heading) and records `r ∈ T[1..]`. All-blank rows are ignored.
- A spec `S = (rows ≤ 3, cols ≤ 2, values ≤ 6 (field, fn), filters, subtotals, grandRows, grandCols)`. A field may sit on at most one axis.

*Pivot cache*
- One item per field and per key, where `key(v)` is:
  - `n:<number>` for numbers;
  - `s:<lowercase text>` for text;
  - `l:TRUE` / `l:FALSE` for logicals;
  - `e:<code>` for errors;
  - `b:` for blank.
- An item's caption is the first occurrence of its value in the source, taken before filtering.

*Filtering, ordering and summaries*
- A filter keeps a record when the caption of `r[f]` is in its include list.
- Items sort as numbers < text (case-insensitive) < FALSE < TRUE < errors < "(blank)".
- For every row-path prefix `p`, column-path prefix `q`, and value `v`: `cell(p, q, v) = fn_v(records matching p and q)`.
- Excel's summary-function definitions apply:
  - Every function except Count reads numbers only.
  - Sum, Product, Max and Min of no numbers give 0.
  - Average / Varp / StdDevp of no numbers give #DIV/0!. Var / StdDev give #DIV/0! with fewer than 2 numbers.
  - Any error in the values gives that error, for every function except Count.
  - An empty intersection shows nothing.

*Layout and sheet integration*
- The layout is Excel's tabular form:
  - with one value field and column fields, a caption row ("Sum of Units | Product") above the column items;
  - a row-field heading row;
  - item rows with repeated labels;
  - "X Total" subtotal rows for every outer row level;
  - a "Grand Total" row and column. With several value fields there is one "Total Sum of …" column per value.
- `writePivot` writes the grid at `anchor` and clears what the previous refresh wrote. It refuses to:
  - overwrite non-pivot data (unless forced);
  - overlap its own source (always refused);
  - overlap another pivot.
- `insertDelete` maps the source reference through the same function used for formula references. A column inserted or deleted inside the source shifts the field indexes (a deleted field leaves the spec). The pivot's anchor and output move with its own cells.

*Persistence*
- `.fworkbook`: `sheet.pivots` holds the JSON definition.
- `.xlsx`: the definition JSON is stored as hidden sheet-scoped names `_FusionPivot<i>_<j>`, each a string constant of at most 120 characters (Excel's limit for string constants in names is 255). This works in the fresh writer and in the lossless patch writer.

**SR-04 web results.**
- A palette row for the web exists only when `search.webResults = on` and the template contains `%s`. It ranks below every local result (`rank = −1`).
- Typing sends nothing anywhere. Only picking the row opens the URL.

**DP-11 least privilege.**
- The set `P` of prompting web APIs must not be called before a user action asks for that capability.
- Chromium's permission state for each must stay `prompt`.

## B. Hypotheses

**H+ (expected to hold; each has a check):**
1. Saved notes parts satisfy every invariant in §A for blank documents, POI corpus documents with notes (Bug54849 with an sdt in the note, bug65649 with breaks, endnotes, footnotes, form_footnotes, table_footnotes), and 120 random sessions. Check: tt58-writer-notes tests 1, 3 and 5.
2. Corpus note parts we did not touch stay byte-identical. Check: test 3.
3. Under Track Changes, an inserted note is an insertion: reject removes it, and accept keeps it plain. Check: test 4.
4. Every pivot cell equals the pandas groupby oracle, and we show no cell the oracle has no group for. This holds over 300 random tables mixing blanks, errors, logicals, case variants, filters and totals options. Check: tt58-sheet-pivot test 3.
5. Refresh follows source edits, formula results and structural edits. Check: test 4.
6. The `.xlsx` definition survives both writers, and openpyxl sees the names as hidden with each string ≤ 255 characters. Check: test 5.
7. In the browser, typed notes reach footnotes.xml, and a typed pivot reaches the saved .xlsx and refreshes after reopening. Check: e2e-tt58.
8. Typing in the palette sends no outside request, and opening every app calls no prompting API. Check: e2e-tt58-rows.

**H− (expected to fail if the code were wrong; each is killed by a mutant):**
- **Notes:**
  - not scanning opaque XML for refs drops a live note;
  - not dropping orphans leaves a stale note;
  - not keeping separators breaks Word's layout;
  - not re-serializing dirty notes loses the edit.
- **Pivot:**
  - StdDev with n instead of n−1;
  - case-sensitive keys;
  - errors propagated only by Sum;
  - captions not taken from the first occurrence.

**H∂ (partly true or unverifiable):**
- Word renders our notes like its own. Only the schema shape and python-docx are checked.
- Excel keeps the `_FusionPivot` names. Hidden names are standard, but this is not verified in Excel.
- Excel's exact item order for mixed-type fields. Ours follows the documented sort order; numbers vs dates are not distinguished, because dates are numbers here.

## C. Frontier

- **Notes:**
  - An edited note becomes plain text: one paragraph per line, and run formatting inside it is not kept.
  - Text inside opaque tokens (for example, an sdt) is shown in the editor, but editing replaces it.
  - New empty notes are hidden in the page view, though listed in the panel.
- **Pivot:**
  - The output is values, not an Excel PivotTable. There are no pivotCache / pivotTable parts, so Excel shows a range.
  - There is no Compact or Outline form, no "Show Values As", no calculated fields, no date grouping, and no slicers.
  - The source must be a range: tables and names are not accepted as sources.
- **Standing Writer and Spreadsheet gaps:**
  - Writer: no table-row revisions, no spell check.
  - Spreadsheet: x14 CF rules are not drawn; Paste Special does not carry links.

## D. Negative shapes (≥ 15) + modal shortcut

1. A pivot spec with a field on both Rows and Columns is refused.
2. A field index outside the source is refused.
3. More than 3 row fields is refused.
4. More than 2 column fields is refused.
5. An unknown summary function is refused.
6. A spec with no fields is refused.
7. A source with a blank heading is refused, including after a column is inserted inside the source.
8. More than 500 output columns is refused.
9. A pivot over user data is refused, and the data is untouched.
10. A pivot overlapping its own source is refused, even with force.
11. Refreshing when the source sheet was deleted reports the reason and does not crash.
12. A damaged `.xlsx` definition (missing chunk) is dropped, never misread.
13. An invalid source typed in the panel is flagged (role=alert). Create is refused, and no sheet is left behind.
14. A note reference wrapped in unknown XML is not treated as an orphan.
15. Deleting the reference mark drops the note on save, with no dangling reference.
16. The web row never appears while the setting is off.
17. No prompting permission API is called during app start-up.
18. **Modal shortcut:** Escape in the PivotTable panel closes only the panel; the Spreadsheet window stays open. Escape inside a note's text box does not close Writer. Both are checked in e2e-tt58.

## E. Mechanism-distinct approaches (≥ 6)

1. **Independent oracles in another language:**
   - lxml / python-docx read the saved docx.
   - pandas groupby recomputes every pivot aggregate from the definitions.
   - openpyxl reads the saved xlsx values and the hidden names.
2. **Byte identity:** untouched notes parts are compared byte for byte.
3. **Randomized differential:** 120 notes sessions and 300 pivot tables.
4. **Mutation testing:** 4 + 4 mutants, all killed.
5. **Real-browser e2e on the production build:** keyboard shortcuts, panel controls and saved bytes.
6. **Instrumentation of the platform itself:**
   - DP-11 wraps every prompting API in an init script and reads Chromium's own permission state.
   - SR-04 reads Playwright's network log.

## F. Artifacts

| Artifact | Contents |
|---|---|
| `src/lib/office/wordml.ts`, `wordedit.ts` | notes parse/serialize/save rule; `listNotes`, `insertNote`, `setNoteText`, `deleteNote`, `noteTextOf` |
| `src/components/modules/Writer.tsx` | Notes panel, Insert ▸ Footnote, Ctrl+Alt+F / Ctrl+Alt+D, note numbering in the page view |
| `src/lib/formula/pivot.ts` | the pivot engine |
| `src/lib/formula/pivotsheet.ts` | read source, write / refresh / delete, hidden-name persistence, sanitizer |
| `src/lib/formula/{engine,workbook-json,sheetops,xlsx,xlsx-patch}.ts` | `sheet.pivots`, `.fworkbook`, structural edits, `.xlsx` names |
| `src/components/modules/Spreadsheet.tsx` | PivotTable panel, Refresh All, Alt+F5 / Ctrl+Alt+F5 |
| `scripts/oracle/docx_notes.py`, `scripts/oracle/pivot_pandas.py` | oracles |
| `scripts/tt58-writer-notes.mts`, `tt58-sheet-pivot.mts`, `e2e-tt58.mts`, `e2e-tt58-rows.mts` | suites |
| `docs/screens/tt58-writer-notes.png`, `tt58-pivot.png`, `tt58-pivot-panel.png` | screenshots |

## G. Second-order adversary

- **"The oracle shares the engine's assumptions."**
  - pandas groups by its own key tuples and aggregates with `Series.var(ddof=…)` and similar functions. It shares no code with pivot.ts.
  - Captions and filters are computed separately in Python.
  - The test reads OUR grid back through the documented layout only. So a layout bug (a wrong subtotal label or a missing column) fails the comparison as well as a value bug.
- **"Comparisons skip cells."**
  - The test also requires that every non-empty cell we show has an oracle group, so nothing extra slips through.
  - It requires more than 20,000 compared cells.
- **"Mutation of one aggregate hides behind another."**
  - M1 (StdDev with n instead of n−1) was killed by the random cases alone.
- **"The e2e test checks the UI's own state."**
  - Notes are read from the saved bytes by lxml.
  - Pivot values are read by openpyxl from the saved file.
  - Refresh after reopening uses a fresh browser context, so the definition can only come from the file.
- **"Permission wrapping misses APIs installed later."**
  - The init script runs before any app code on every navigation.
  - The test also reads `navigator.permissions` states at the end. Those cannot be changed without a prompt.

## H. External verification

- The ECMA-376 element order was checked against the schema order used by the code: `definedNames` before `calcPr`, and footnotes/endnotes parts with separator types. This was not checked by Office.
- python-docx and openpyxl open every saved file in the suites.
- Not done: opening the files in Word or Excel (none in the sandbox).

## I. Repairs, and a new attack on each patch

1. **Footnote reference inside `w:ins` became an opaque token.**
   - Patch: `parseRevision` accepts footnote/endnote references, and `referencedNotes` scans opaque XML.
   - New attack: a reference wrapped in `w:customXml`. Test 2 keeps that note.
2. **Bug54849's sdt text was missing from the note text.**
   - Patch: `noteTextOf` includes `w:t` text inside opaque tokens.
   - New attack: an untouched corpus note must stay byte-identical (test 3).
3. **Pivot item captions came from the first record of each intersection (oracle) vs. the first record after filtering (engine).**
   - Patch: both now use the first occurrence in the whole source, as Excel's cache does.
   - New attack: mutant M4 (raw values instead of canonical captions) is killed.
4. **The lossless patch writer ignored a pivot-only change.** Deleting a pivot left its names.
   - Patch: the definitions are compared with the baseline.
   - New attack: delete → patch → openpyxl sees no `_FusionPivot` names (test 5).

## J. Stopping

The tier stops when:
- every TT58 suite passes on the final build;
- the regression subset passes;
- the full run-all gate on the TT57 build has been triaged;
- the ledger is regenerated and the remaining blockers are listed.

## Results

**Gate on the TT57 build:** full run-all from a `git archive` snapshot, 123 suites, 1032 passed / 10 failed. Every failing suite was re-run alone and passed:
- e2e-a11y 9/0, tt42-proxy 2/0, e2e-tt48-sync 4/0, e2e-tt55-shell 3/0, e2e-tt56 10/0, tt46-xlsx-patch 8/0.
- tt44-vt 12/0 when run in the git checkout. Its `git log` step cannot work in a git-archive snapshot.
- The failures came from CPU contention with this tier's unit runs and from suite order. They are disclosed as flakes.

**TT58 suites on the final build:**

| Suite | Result | Notes |
|---|---|---|
| tt58-writer-notes | 5/5 | mutants 4/4 killed |
| tt58-sheet-pivot | 5/5 | more than 20,000 oracle-compared cells over 300 random tables; mutants 4/4 killed |
| e2e-tt58 | 3/3 | |
| e2e-tt58-rows | 3/3 | |

**Regression subset on the final build:** all passed.

| Suite | Result |
|---|---|
| tt56-writer-track | 6 |
| tt57-writer-fmt | 5 |
| tt57-writer-para | 5 |
| tt46-writer | 12 |
| tt49-writer | 9 |
| office-engine | 35 |
| tt46-xlsx-patch | 8 |
| oracle-xlsx | 5 |
| sheet-layout | 6 |
| names | 7 |
| tt57-sheet-links | 6 |
| tt47-sheet | 8 |
| tt49-sheet | 10 |
| tt50-charts | 10 |
| tt56-sheet-paste | 4 |
| e2e-office | 11 |
| e2e-sheet-layout | 7 |
| e2e-tt56 | 10 |
| e2e-tt57 | 3 |
| e2e-tt55-shell | 3 |
| e2e-a11y | 9 |

**Bug found by the new SR-04 test and fixed:** the palette's 40-row cap cut the opt-in web row whenever a query had more than 40 local hits. The row ranks last, so it was the one removed. It is now exempt from the cap like app rows. The test checks a query with few hits ("Calculator") and one with many ("Settings").

**Visual check:** the screenshots were inspected. The footnote number in the page's Notes area was too small and was shifted up into the heading. It now has its own baseline-aligned style. The pivot shows Excel's tabular layout with bold totals.

**Ledger:** 368 features; built full 292 / partial 54 / blocked 21 / none 1. Tested full **205** (was 203) / partial 72 / untested 91. Tests 1067/1067.
