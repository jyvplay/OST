# TT61 — Writer: notes keep formatting, header underlines, cell revisions; Spreadsheet pivot-delete fix

## Runtime honesty
Ran here: bash sandbox, Node 22 + tsc, Next 16.2.6 production build, Playwright 1.64.1 + headless Chromium 143,
embedded Postgres 17.10, Python 3.11 (lxml, python-docx, openpyxl). **Not available:** Word / Excel / LibreOffice (no
Office open check — PR-11 stays partial), theorem provers, other browsers, real devices. Every "verified" claim below
is a test that ran in this sandbox; nothing was checked in Office itself.

## A. Formal model
* **Note edit (FF-43).** A note is exploded into items: one per UTF-16 unit (carrying its run template), opaque tokens
  (width = their text length; the reference mark has width 0), and paragraph breaks (each break carries the props of
  the paragraph that follows it). `diffHunks(cur, want)` returns a minimum insert/delete edit script (Myers O((N+M)·D),
  written from scratch, bounded at 4,000 chars / 400 edits, after which it falls back to one prefix/suffix span). The
  hunks are applied right to left. Formatting rule: a hunk that deletes characters takes the format of the first one
  deleted (Word's replace rule); a pure insertion takes the character before it in the same paragraph, else the next
  one (Word's typing rule); typing `\n` makes a break that copies the host paragraph's props. Postcondition:
  `noteTextOf(result) === want`, otherwise the edit falls back to plain text and **says so**.
* **Cell revisions (FF-44).** ECMA-376 §17.13.5.4/.5: accepting `cellDel` or rejecting `cellIns` removes the cell;
  otherwise only the marker goes. Invariant: gridBefore + Σ gridSpan + gridAfter = |tblGrid| (a removed cell's span
  is added to `w:gridAfter`, placed among the CT_TrPrBase properties, before ins/del/trPrChange). An emptied row is
  removed, and an emptied table is removed.
* **Header underline (FF-42 completion).** Every issue with story `hf:<rId>` gets one Range for each rendered copy of
  that part (`.whdr/.wftr[data-rid]`, one copy per page). Painting is redone after every relayout (`layoutGen`),
  because relayout rebuilds those DOM nodes.
* **Pivot delete (FF-21 fix).** The "unchanged → original bytes" shortcut now also requires `pivKey(orig) === pivKey(wb)`.

## B. Hypotheses
* H+ : formatting outside the edited spans is preserved (randomized differential, 60 edits + 400 Myers pairs vs DP).
* H− : a note containing revisions, or an edit that cuts into a field / content control, must NOT be edited in place
  (it falls back to plain text, and the UI reports it).
* H∂ : notes with no space after the reference mark (common in LibreOffice output) — typed text must still land after
  the mark (a separate test; the mutant that broke this survived until that test was added).

## C. Frontier (what is still not Class A here)
`w:cellMerge` is listed read-only and refused. Tracked column operations are still refused. Spelling fixes in
headers, footers and notes are not tracked. Pivot output is values only (no pivotTable parts). App-added conditional
formatting rules use the 2007 schema. Paste Link uses absolute references only. No Office open check (PR-11).

## D. Negative shapes tested (≥ 15)
Identity edit → false; unknown note → false; note containing a revision → "plain"; edit inside a content-control token
(POI Bug54849, 2 notes) → "plain"; delete everything (the reference mark stays); join across a paragraph break;
split at the end of a paragraph; typing before a mark with no leading space; a replace that spans 3 runs; two
disjoint edits; Myers on empty / identical strings; cellMerge accept and reject both refused; resolving an already
resolved key → false; a spanning cell removed with an existing trPrChange (ordering); a row emptied → row removed; a
1×1 table emptied → table removed; deleting a pivot after its output cells were gone; an untouched save after that
state stays byte-identical. **Modal shortcut failure test:** e2e-tt60's existing "F7 inert behind the modal" still
passes in the regression run.

## E. Mechanism-distinct approaches considered (≥ 6)
1. Prefix/suffix single span (TT61 draft) — **rejected by its own test**: "Smith…Journal → Jones…Annals"
   re-formatted the shared " in ".
2. Myers shortest edit script + per-hunk application (chosen).
3. Word-level diff (tokens) — coarser; a word typo would re-template the whole word.
4. Patience diff — better for long, line-oriented texts; notes are short prose.
5. Editing the note in place in the DOM (contenteditable notes area) — larger UI change; deferred.
6. Keeping the original runs and appending a revision — wrong semantics when tracking is off.
For cell removal: (a) gridAfter (chosen; valid CT_TrPrBase); (b) widen a neighbour cell's gridSpan — changes the
look of other cells; (c) leave the row short — invalid grid (oracle `grid_ok` fails).

## F. Artifacts
* `src/lib/office/wordedit.ts`: `editNoteText`, `applyNoteHunk`, `diffHunks`, `cellMarks`, `removeCell`, revisions /
  resolveOne for `c:` keys.
* `src/components/modules/Writer.tsx`: notes commit status, header/footer painting, `layoutGen`.
  `writer/view.ts`: cell tint.
* `src/lib/formula/xlsx-patch.ts`: pivot-aware shortcut.
* Oracles: `scripts/oracle/docx_noteruns.py` (new), `docx_tblrev.py` (+ cells, grid_ok, tcpr_ok, markcells writer).
* Tests: `tt61-writer-notes-rich` (7), `tt61-writer-cellrev` (4), `tt61-sheet-pivot-delete` (1), `e2e-tt61` (4).
* Screens: `docs/screens/tt61-writer-note-formatting.png`, `tt61-writer-header-underline.png`,
  `tt61-writer-cell-revisions.png`.

## G. Second-order adversary
* The oracle writes the fixtures (lxml), not our writer, so our reader is tested on foreign XML.
* Expected runs and tables are written out by hand in the tests, and the oracle's own accept/reject views are
  checked against the same hand expectations.
* Mutants: notes 5/5 killed (two survived at first: the split-style check looked at the wrong paragraph, and the
  mark-first check was masked by the leading space; both tests were strengthened). Cells 6/6 killed (gridAfter after
  trPrChange survived until a row with trPrChange was added). Pivot fix: removing it makes the suite fail.

## H. External verification
lxml (`docx_noteruns.py`, `docx_notes.py`, `docx_tblrev.py`), python-docx (opens + tables), openpyxl (defined names),
and the Apache POI corpus (6 docx files, 11 notes). Not verified in Word / Excel (unavailable).

## I. Repair + attack on the patch
Repair budget: the pivot shortcut fix only (a few lines). Attack on the patch: if `pivKey` differed spuriously between
the loaded baseline and the reopened workbook, every save would lose the byte-identical shortcut. The test asserts that
an untouched save of the post-fix state is still byte-identical, and tt46-xlsx-patch (8) plus tt58-sheet-pivot (5)
pass.

## J. Stopping
Stopped after: all new suites green, mutants killed, and a regression subset of 13 suites (70 tests) green against the
production build. The full 137-suite gate was not rerun this tier (budget). The suites touching changed code were run.
