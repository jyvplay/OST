# TT64 — Writer tracked column insert / delete (FF-48) · Spreadsheet Paste Link with Excel's relative-range rule (FF-28)

## Runtime honesty
- **Used:**
  - bash sandbox, Node 22 + tsc, the Next 16.2.6 production build, Playwright 1.64.1 with headless Chromium 143, and embedded Postgres 17.10;
  - Python 3.11 with lxml, python-docx and openpyxl (all test-only);
  - the ECMA-376 transitional XSDs from TT62 (`scripts/oracle/ooxml_xsd.py`).
- **Not available:** Word, Excel, LibreOffice, or any Office open/repair check.
  - Nothing here claims Word or Excel opened these files.
  - The checks that stand in for an Office open are XSD validity, the independent lxml oracle `scripts/oracle/docx_tblrev.py` (it shares no code with `src/lib/office`), python-docx, and openpyxl.
- **Sources:**
  - ECMA-376 Part 1 §17.13.5.4 (cellIns), §17.13.5.5 (cellDel), §17.13.5.33 (tblGridChange) with the CT_TcPr / CT_TrPr element order checked against the XSDs.
  - Microsoft Support, "Change the track changes color": Word has separate *Inserted cells* and *Deleted cells* colours, so it renders cell revisions.
  - excelforum.com thread 679146 (2009): Paste Link of a single cell gives an absolute reference, Paste Link of a range gives relative ones. The TT59 implementation had followed the Mac help page, which only describes the single-cell case.
  - No Word-processing or spreadsheet code was read or borrowed.

## A. Formal model
- **Grid.** A table T has grid widths g[0..n). Each row r has gridBefore b_r, cells c_1..c_k with spans s_i, and gridAfter a_r, with b_r + Σ s_i + a_r = n.
  - colOf(r, c_j) = b_r + Σ_{i<j} s_i, and cellAtCol(r, x) is the cell whose span covers x, or ⊥ inside the empty regions [0, b_r) and [n − a_r, n).
- **Untracked column ops (ground truth).**
  - ins(T, x, side): every row with a cell at x gets a new cell next to it. A row with ⊥ at x widens the empty region holding x. g gets a new width, then everything is scaled to fit the text width.
  - del(T, x): every row's cell at x loses one grid column (span − 1, or the cell goes). A row with ⊥ shrinks its region. g loses x.
- **Tracked ops.**
  - ins_t: same structure as ins, plus every new cell gets ⟨w:cellIns author date id⟩. The *first* tracked grid change keeps the old widths as tblGridChange(id, g_old); later ones never overwrite it.
  - del_t: every cell at x gets ⟨w:cellDel⟩. The structure is unchanged.
- **Column group (review unit).** A set of marks G is one column change iff all of these hold:
  - T has ≥ 2 rows and G has ≥ 2 marks;
  - all marks are of one kind (cellIns or cellDel) by one author, on single-span cells starting at one grid column x;
  - every row either has its G-cell at x, or ⊥ at x.
  - Otherwise the marks are TT61 cell changes, one each.
  - The same predicate is restated independently in the oracle (`grids`, `whole()`).
- **Resolution.**
  - accept(ins) = reject(del) = drop the markers.
  - reject(ins) = accept(del) = del(T, x).
  - settleGrid: once no cell mark is left, a reject restores g_old when |g_old| = n (otherwise the change is dropped). Accept always drops it.
  - Theorem checked by the tests: for every T, x and op, accept_all(op_t(T)) = op(T) and reject_all(op_t(T)) = T, in text **and** widths.
- **Refusals** (with a message):
  - del_t where a gridSpan cell crosses x, or a cell at x already carries a cell mark;
  - any op_t in a ≥2-row table where fewer than 2 rows have a cell at x (it would not be a column group; see I).
- **Paste Link.** For a clipboard of H×W source cells pasted at (r₀, c₀): target (r₀+i, c₀+j) = `=` + sheetPrefix + ref(src + (i, j)). The ref is `$C$R` iff H = W = 1, otherwise `CR`.

## B. Hypotheses
- **H+ (confirmed):** the accept/reject theorem holds.
  - Evidence: 48 random tables, each with a random op, checked through the oracle's views of the tracked file *and* through our Accept All, Reject All, and resolving the one column change both ways. Also hand sequences (two inserts and a delete, resolved in mixed orders) and every column of a gridBefore/gridAfter table in both modes.
- **H+ (confirmed):** tracked packages are XSD-valid, and python-docx opens them. A reload groups the same change, and saving it again leaves every part identical (docProps/core.xml aside, whose dcterms:modified is stamped on each save).
- **H− (refuted, i.e. real defects found and fixed):**
  1. **gridBefore rows (pre-existing since TT46).** colOf/cellAtCol counted from a row's first cell, ignoring w:gridBefore. On a row with gridBefore = 1, deleting the second column removed the wrong cell, giving [["R0C1","R0C2"],["R1C2"]] instead of [["R0C0","R0C2"],["R1C2"]]. The G-adversary found this in both modes.
     - Fix: colOf/cellAtCol start at gridBefore, and empty-region rows widen or shrink gridBefore/gridAfter. view.ts now draws `wgrid-pad` cells so these rows line up on the page.
  2. **Reject ordering.** The first draft called settleGrid before the grid column was removed, so widths were never restored. The `reject` flag now goes into `untrackedColDelete`, and the restore happens after the splice.
  3. **Lone-cell grouping (found by the regression e2e-tt61).** TT64's first rule had no "≥ 2 marks" clause. After an accepted cellDel left row 0 with a gridAfter slot, the lone cellIns R1C2 counted as a whole "column", which relabelled TT61's "[Table cell]" change.
     - Fix: a column group needs ≥ 2 marks, in both the engine and the oracle. Our own tracked op is refused where it would record a lone cell, so we never create an unreviewable state.
  4. **Redundant id reservation.** The first draft reserved per-cell ids in parseCell, and a mutant showed that code was equivalent. readWord already scans every w:id in document, comments, footnotes and endnotes, so the redundant code was removed. Separately, cellIns/cellDel/cellMerge/tblGridChange ids now join the duplicate-id renumbering set (`REC`), which a duplicate-id test checks.
- **H∂ (not decidable here):** whether Word shows the tblGridChange widths exactly as we restore them. Only Word can answer that, so it is disclosed.

## C. Frontier (what is still not Class A here)
- **Writer:**
  - spelling fixes in stories (headers, notes) are applied untracked;
  - spelling is en_US only;
  - inserts next to gridSpan cells are not grouped;
  - a tracked delete across merged cells, or over another reviewer's pending cells, is refused;
  - 1-row tables keep per-cell semantics;
  - resolving several pending inserts in mixed accept/reject orders leaves the current widths;
  - an insert into an empty gridBefore/gridAfter region widens that region.
- **Spreadsheet:**
  - conditional formats added in the app use the 2007 schema (no x14 output for new rules);
  - pivots have one cache per table, no rowItems/colItems, and no dataField number formats;
  - pivots with several value fields and a column field are 1 row taller after Excel refreshes them;
  - a filter caption is written for axis fields.
- PR-11 stays partial: no Office open check.

## D. Negative shapes tested (≥ 15)
1. Tracked delete across a gridSpan cell: refused, and the document equals a tracked no-op.
2. Tracked delete over another reviewer's pending inserted column: refused, and the other author's cellIns stays.
3. Tracked delete of the author's *own* pending inserted column: removed outright, with no cellDel-on-cellIns.
4. A 1-row table: stays per-cell (TT61), with no column grouping.
5. Mixed authors in one column (lxml-written): per-cell, not grouped.
6. A lone marked cell next to an empty gridAfter slot: a cell change, with no column group (the repair 3 regression).
7. A tracked op where only one row has a cell at the column: refused for left, right and delete, the document is unchanged, and the untracked op still works.
8. File revision ids lower than ours (written by lxml): reserved, so no collision.
9. Duplicate cell-revision ids in a file: renumbered, so all ids are unique on save.
10. A width-only tblGridChange from a file (no cell marks): settles on Accept All (dropped) and Reject All (restored).
11. Two tracked inserts: the second never overwrites the first's tblGridChange.
12. Tracked rows and tracked columns in the same table: both review and resolve.
13. gridBefore rows: every grid column × delete/left/right, tracked and untracked, against hand-derived tables.
14. gridAfter rows: the same.
15. Kept columns (accept insert / reject delete): every marker gone; the mutant "kept column keeps markers" is killed. (A cell whose only property was the marker keeps an empty self-closing `<w:tcPr/>`, which is schema-valid.)
16. Paste Link of a single cell onto a sheet whose name needs quoting: `='Q1'!$A$1` (openpyxl).
17. A Paste Link range copied on 5 rows: shifts to B7/C7, while a single-cell link stays `$A$1`.
18. **Modal-shortcut failure test:** e2e-tt60's existing case still passes. With the shell's modal ask dialog open, Ctrl+Shift+E (Track Changes) and F7 reach no Writer behind it.
    - A "refuse every tracked column op" shortcut, which was TT60's behaviour, fails tests 1–3 and 5–6 and the e2e.
    - An "apply the column op untracked" shortcut fails every oracle reject view. Its closest run mutant, "insert: no cellIns", is killed by 5 of the 6 tests.
    - A "reject = accept" shortcut in resolution is the mutant "reject-insert as accept-delete", which is killed.

## E. Mechanism-distinct approaches considered (≥ 6)
1. **Keep refusing** tracked column ops (TT60). Rejected: Word records them as cell revisions, which the Microsoft colour options show.
2. **Track each cell independently** (TT61 cell semantics only). Rejected: per-cell reject pads rows with gridAfter and never removes the grid column, so the original table can't come back.
3. **A custom marker or bookmark** recording "column op". Rejected: not ECMA-376, invisible to Word and to every other consumer.
4. **Snapshot the whole table in a tblPrChange.** Rejected: tblPrChange holds table properties only, not structure.
5. **Group by pending-op journal** (in-memory list of ops). Rejected: lost on save; a reloaded file must group the same way.
6. **Group by the file's marks (chosen):** a pure predicate over the saved XML, so the same change comes back after reload, and the independent oracle can restate it.
7. **Widths:** recompute them on reject (proportional) vs record them in tblGridChange (chosen, the schema's own mechanism). Recomputing drifts by rounding, which the differential test detects.
8. **Paste Link:** always absolute (TT59) vs Excel's rule (chosen). Relative refs for ranges let a linked block be copied on, as Excel does.

## F. Artifacts
- `src/lib/office/wordedit.ts`:
  - tracked `tableColOp`; `columnGroups`, `resolveColumn`, `untrackedColDelete(t, col, host, reject)`, `settleGrid`;
  - gridBefore-aware `colOf`/`cellAtCol`, plus `emptyRegion`/`setTrGrid`;
  - `COLUMN_TRACK_REFUSAL`.
- `src/lib/office/wordml.ts`: `Table.gridChange`, tblGridChange read/write, `gridSig`, and cell-revision ids in the renumbering set.
- `src/components/modules/Writer.tsx`: status line and refusal toast. `writer/view.ts`: gridBefore/gridAfter pad cells.
- `src/lib/formula/sheetops.ts` `pasteLink`; `Spreadsheet.tsx` button title.
- `scripts/oracle/docx_tblrev.py`: `grids` views (asis / change / accept / reject) with the whole-column rule.
- Tests:
  - `scripts/tt64-writer-trackcols.mts` (6 tests) and `scripts/e2e-tt64.mts` (3 tests);
  - updated tt59-sheet-paste, tt60-writer-tblrev, tt62-writer-schema and e2e-tt60. The TT60 refusal is superseded: Column right is now tracked and then rejected.
- Screenshot `docs/screens/tt64-writer-tracked-columns.png`: deleted column 1 is tinted with a dashed border, inserted column 3 is blue, two "[Table column]" changes are listed, and a gridBefore row is aligned.
- `src/db/seed-data/features-tt64.ts`: FF-48. FF-40's "refused" text and FF-28's "absolute" text are replaced, and FF-22 and FF-44 get notes. SEED 3.50.0.

## G. Second-order adversary
- Could the oracle share the engine's mistakes? It computes accept/reject views from the tracked XML alone, using its own restatement of the column rule. The ground truth is the *untracked* op applied to an independent copy.
- The adversary built tables the random generator never makes: gridBefore/gridAfter rows. That found defect H−1, which predates TT64.
- The adversary also attacked the grouping rule with files from the independent writer (mixed authors, lone cells). That found H−3, through the e2e-tt61 regression rather than this tier's own tests, so I added the lone-cell case to test 6.
- Equivalent mutant: "no per-cell id reservation" survived because the code was redundant (H−4). The code was removed, and the mutant was replaced by a duplicate-id renumbering test, which kills its own mutant.
- Second equivalent mutant (after repair 3): "1-row tables grouped" survived the full run (23/24) because the new "≥ 2 marks, one per row" rule already implies ≥ 2 rows. The redundant row-count guard in `columnGroups` was removed; one-row behaviour stays pinned by test 4 (1-row tables per-cell) and by the tracked-op guard, which keeps its row check because 1-row tables may still mark a lone cell.

## H. External verification
- ECMA-376 XSDs pass for every tracked package.
- lxml oracle views match, python-docx opens every file, and openpyxl reads the Paste Link formulas.
- Real Chromium e2e: the UI flow; Save → oracle + XSD; gridBefore alignment measured on the page.
- **Not available:** Word, Excel.

## I. Repair + attack on the patch
- **Repair 1 (gridBefore):** the attack is test 6, covering every grid column × 3 ops × tracked/untracked against hand-derived tables. The colOf, cellAtCol, emptyRegion and empty-region-rows mutants are all killed.
- **Repair 3 (lone cell):** the attack is "a lone mark + a tracked op at that column".
  - The lone mark stays a cell change, and Reject All gives the per-cell result with the grid kept.
  - Tracked left, right and delete there are refused and leave the document unchanged.
  - Mutants "lone marked cell grouped as a column" and "tracked op at a one-cell column allowed" are both killed.
- **Paste Link:** mutants "range absolute too" and "single cell relative" are both killed by tt59-sheet-paste.
- **Repair 5 (gate, test hygiene):** the full gate's first pass failed e2e-tabletop (3), e2e-beauty (1), e2e-tt29 (1) and e2e-privacy (1). A plain rerun failed again, so they were *not* treated as flakes.
  - Measured cause: /Documents held 56 files, 43 of them uploads left by e2e-tt60–64, which I ran repeatedly this turn. The Tabletop floor lays out /Documents, so the test's own cards landed past the documented ~46-card layout (e2e-beauty: cards #47–53 only 24.6 px tall).
  - Fix: e2e-tt60 … e2e-tt64 now trash and purge their own `RUN`-prefixed files before closing, the pattern e2e-tabletop already used. The existing leftovers were purged once through the same API; only `t60…`–`t64…` test files were touched.
  - Attack on the patch: all five e2e suites rerun 17/17, /Documents is still 13 files afterwards, and the purged files are not in the trash. e2e-tabletop 15/15, e2e-beauty 6/6, e2e-tt29 4/4 and e2e-privacy 14/14 then pass.
  - The underlying Tabletop limit (cards beyond ~46 files) stays a disclosed blocker.
- **Mutation total:** 23/23 killed (24 run; the one survivor was equivalent and its code removed, see G). That is 21 Writer mutants on tt64-writer-trackcols plus 2 Paste Link mutants on tt59-sheet-paste.

## J. Stopping
- Suites: tt64-writer-trackcols 6/6; e2e-tt64 3/3.
- Writer regressions re-run, all passing: office-engine, tt46-writer, tt49-writer, tt56-writer-track, tt57-writer-fmt, tt57-writer-para, tt58-writer-notes, tt59-writer-spell, tt60-writer-tblrev, tt60-writer-spell-stories, tt61-writer-cellrev, tt61-writer-notes-rich, tt62-writer-schema, tt62-writer-cellmerge.
- e2e re-runs: e2e-tt59, e2e-tt60, e2e-tt61, e2e-tt62 and e2e-office.
- Full gate: 150 suites, 1162/1168 on the first pass. The 6 failures were all repair 5, test leftovers crowding the Tabletop; after the fix the 4 suites pass 39/39.
- Stopped at "tracked columns + Paste Link parity". The next Writer gap (tracked story spelling) needs revision marks inside header/note parts. That is a separate story-level change model, too large to finish and verify in the rest of this turn.
