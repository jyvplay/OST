# DESIGN-TT60: Writer table revisions, proofing in every story, spelling across sheets, battery-aware backups

This tier follows the tier-5 protocol (A–J). Each section names the code and the suite that checks it. The numbers are under "Results".

## Runtime honesty

**What ran:**
- A bash sandbox with 2 cores and 3 GB.
- Node 22 with `--experimental-strip-types`, `tsc`, Next 16.2.6 (`next build` + `next start`).
- Playwright 1.64.1 driving headless Chromium 143 (the @sparticuz build).
- Embedded PostgreSQL 17.10.
- A Python 3.11 venv with lxml, python-docx and openpyxl. These are the independent readers and writers that produce fixtures and judge saved bytes.

**Not available, so nothing here claims them:**
- Theorem provers and parallel agents.
- Microsoft Word / Excel and LibreOffice. Nothing checks that Word shows our tracked rows, or that it accepts or rejects them the same way. That rests on ECMA-376 Part 1 §17.13.5, on lxml parsing, and on python-docx opening the files.
- A real battery. In the browser test (RG-05) the test injects what `navigator.getBattery()` returns. The governor code that reads it is the shipped code.
- Firefox and Safari.

## A. Formal model

**Row revisions (src/lib/office/wordml.ts, wordedit.ts).**
- A row is `Row = { items, rev? }` with `rev ∈ {ins(a,t), del(a,t), del(a,t)∘ins(a',t')}`. The last form is a deletion nested over another reviewer's insertion.
- Serialisation: `trPr` = base properties*, then `ins?`, `del?`, then `trPrChange?` (CT_TrPr). `tr` = `tblPrEx?`, `trPr?`, then cells.
- Views over a document D:
  - `accept(D)` drops rows with `del` and keeps the rest. Run-level `ins` stays and run-level `del` goes.
  - `reject(D)` drops rows with `ins`, including nested ones. Run-level `del` text comes back and run-level `ins` goes.
  - A table with zero rows left is removed.
- Recording, while tracking is on:
  - `insertRow` gives the new row `ins(me)`.
  - `deleteRow(r)`:
    - if `r.rev = ins(me)`, the row is removed physically;
    - if `r.rev = del(·)`, there is no change;
    - otherwise `r.rev := del(me)`, nested over the old `ins` if there was one, and every paragraph of `r` goes through the ordinary tracked text deletion (same author).
  - Column operations are undefined under tracking and are refused.
- Review:
  - `resolve(key = r:k:id, accept)`.
  - The row is kept iff `(k = ins ∧ accept) ∨ (k = del ∧ ¬accept)`. Kept rows lose that mark; other rows are removed.
  - Rejecting a row deletion also rejects the same author's text deletions inside that row.
- Property records:
  - `x:<w:id>` keys for `tblPrChange`, `trPrChange` and `tcPrChange`.
  - Accept: `pr := pr ∖ {change}`.
  - Reject: `pr := change.old` (a row keeps its ins/del marks). Then the derived model fields (style, borders, width, fill, vMerge) are recomputed.
- Invariant on save: every revision-record `w:id` is unique. Collisions are renumbered with `track.next++`.

**Stories (src/lib/office/wordspell.ts).**
- `allIssues(D) = spellIssues(main) ++ ⋃ header/footer parts in relationship order ++ ⋃ notes in document order`.
- Each story issue carries `story` and `where`.
- `fix(i, r)` on a story:
  - copy the story's blocks first;
  - refuse if `proofText(p)[off, off+len) ≠ i.word`;
  - otherwise replace the text inside the runs: the first overlapping run gets `r`, later overlapping runs lose their part;
  - mark the part dirty (`hf.dirty`) or mark the note dirty (`notesTouched`).

**Sheets (src/lib/formula/sheetspell.ts).**
- `workbookSpellIssues(W, from)` = concatenate `sheetSpellIssues(s)` over the tab order rotated to start at `from`. The rotation starts at the first sheet if `from` is unknown. The range is ignored.

**Battery (src/lib/governor.ts).**
- `refuse(g)` holds iff `(level < 0.2 ∧ charging = false) ∨ saveData`.
- `snapshot`:
  - WARM iff the rAF interval is above 18 ms;
  - a low battery makes the state WARM, with the battery reason, whenever the state is COOL or WARM;
  - `backgroundWork = false` when the battery is low.

## B. Hypotheses

- **H+ (supported if the tests pass):**
  - The saved files have exactly the row marks we model. The independent lxml views `accept` and `reject` equal our accept-all and reject-all, live and after a re-open, over 40 random sessions.
  - Story fixes land in the saved header, footer and footnote. Run bold flags survive.
  - Change All covers every sheet. openpyxl reads the result.
  - Backup refuses below 20 % while discharging, and goes ahead when charging.
- **H− (refuted if any test passes when it should fail):** each mutant listed under "Results" must make a test fail.
- **H∂ (boundaries):**
  - exactly 20 % is allowed;
  - an unknown battery (no API) is allowed;
  - a deleted row that is deleted again is no change;
  - deleting the only row under tracking keeps the table until the deletion is accepted;
  - an unknown start sheet starts at the first sheet;
  - a stale story issue is refused.

## C. Frontier (what is still not done, stated)

- Cell-level `w:cellIns` / `w:cellDel` / `w:cellMerge` are preserved but not reviewable.
- Column changes under tracking are refused. Word records no column revisions either.
- `tblPrExChange` is not listed.
- Header, footer and note fixes are not themselves tracked.
- Header and footer misspellings are not underlined on the page. They appear only in the Spelling pane. Footnotes are underlined.
- Spelling covers en_US only.
- There is no grouped-sheet UI. "All sheets" is a checkbox.
- The browser check of the RG-05 battery path relies on injected values.

## D. Negative shapes (each is asserted by a test)

1. Delete an already-deleted row: no change (tt60-writer-tblrev).
2. Delete your own pending inserted row: it is really removed, with no marks.
3. Another reviewer's inserted row deleted: both marks are written, ins before del (schema order checked by the oracle).
4. Column right / column delete while tracking: refused, grid unchanged, message shown (unit + e2e).
5. Resolve a key that no longer exists: false.
6. Accept the deletion of a table's last row: the table is removed and a paragraph remains.
7. A revision id duplicated across cells (one deletion, two paragraphs): renumbered on save, so `ids_unique` holds.
8. `trPr` absent on a new row: created after `tblPrEx` and before the cells (randomized + order check).
9. Reject a property record: the recorded old properties come back (style, height, fill), not the current ones.
10. A stale story issue (text changed since the check): refused.
11. A word split across two runs in a footer: the replacement is written once, not per run.
12. A file note (not editor-created) fixed: must be written on save. The test exposed a real bug, now fixed.
13. Unknown start sheet: starts at the first sheet. A selection range does not limit "all sheets".
14. An empty workbook gives no issues.
15. Battery exactly 20 %, charging at 10 %, or no Battery API: no refusal.
16. Data Saver on: refusal; the battery reason takes precedence when both apply.
17. A healthy 60 Hz interval (16.7 ms) is COOL, not WARM. This was a real bug: every 60 Hz machine read WARM.

**Modal-shortcut failure test (e2e-tt60 FF-40):**
- With the shell's modal ask dialog open over the Writer, Ctrl+Shift+E (Track Changes) and F7 (Spelling) must not reach the document.
- The test asserts the track chip is still shown and no spelling pane opened.
- A second shortcut-scope test (FF-41) checks that F7 is inert while the Paste Special bar has the keyboard.

## E. Mechanism-distinct approaches considered

1. **Row revision as a property on the row model (chosen).** It serialises into `trPr` and leaves cell content to the existing run-level tracking.
2. **Synthesize row revisions from run-level revisions only.** A row counts as "deleted" when all of its text is deleted. Rejected: Word distinguishes a deleted row from emptied cells, and the file would lose the row mark.
3. **Opaque passthrough of `trPr/w:ins|del` (status quo before TT60).** It preserved the marks but made them unreviewable. Rejected as the gap being closed.
4. **Shared Rev object between the row and its text (single change).** Rejected: the ids collide on save (§17.13.5 wants them unique). The linkage is instead made semantic: rejecting the row restores the same author's text deletions in it.
5. **Per-story spell with editing through the main editor (`locate`) extended to headers.** Rejected: `locate` and every edit op assume the main block tree. Chose story-local run surgery on a copied block list instead (undo-safe).
6. **Rewrite stories through the plain-text note / header editors (`setNoteText` / `setHf`).** Rejected: it loses run formatting, the TT58 limit we are moving away from.
7. **Grouped-sheet selection (Excel's model) vs an explicit "All sheets" option.** The option was chosen because there is no sheet-grouping UI. The list order is fixed at the start so navigation can't reorder it.
8. **Battery gate inside the server backup route vs the client.** Client was chosen: only the browser knows the battery. The server stays stateless.

## F. Artifacts

- Code:
  - src/lib/office/wordml.ts (row rev parse / serialize, id renumbering)
  - src/lib/office/wordedit.ts (tableRowOp, COLUMN_TRACK_REFUSAL, rowParas, revisions, resolveOne, tablePrChanges)
  - src/components/modules/writer/view.ts (row change bars)
  - src/lib/office/wordspell.ts (storyIssues, allIssues, issuePara, story fixes)
  - writer/SpellPanel.tsx and Writer.tsx
  - src/lib/formula/sheetspell.ts (workbookSpellIssues, changeAllWorkbook), sheet-spell.tsx and Spreadsheet.tsx
  - src/lib/governor.ts (heavyWorkRefusal, 60 Hz threshold) and Backup.tsx
- Oracle: scripts/oracle/docx_tblrev.py (lxml + python-docx; CT_TrPr order, id uniqueness, accept / reject views).
- Tests:
  - scripts/tt60-writer-tblrev.mts
  - tt60-sheet-spell-all.mts
  - tt60-writer-spell-stories.mts
  - tt60-units.mts
  - e2e-tt60.mts
- Screens: docs/screens/tt60-*.png.
- Register: src/db/seed-data/features-tt60.ts (FF-40, FF-41, FF-42; FF-22 / FF-38 / FF-39 / RG-05 updated), SEED_VERSION 3.46.0.

## G. Second-order adversary (attacks on the tests themselves)

- **"The oracle shares our assumptions."** docx_tblrev.py is written against the schema text, not against our code. It reads `trPr` children by local name and computes its views with its own rules. The fixtures for property records are hand-written XML in the spec's shape, not output of our writer.
- **"Random sessions only test what the generator makes."** The generator mixes two authors, inserts above and below, deletes at double weight (own-inserted rows, other-inserted rows, deleted rows) and types into new rows. The order and id checks run on every trial.
- **"Mutants were weak."** A surviving mutant (sheet rotation `max(1, …)`) showed a test that passed only because a new Workbook has a hidden default sheet. The fixture now clears it, and the mutant is caught. The story-run `put` mutant survived until a word split across runs was added. The note-dirty mutant survived until the notes became file notes, which exposed a real bug.
- **"The e2e checks the UI against itself."** The verdicts come from the saved bytes read by lxml, python-docx and openpyxl.

## H. External verification

- lxml: tracked rows, CT_TrPr order, id uniqueness, accept / reject views, header run bold flags.
- python-docx: the package opens, table cell texts, header text (docx_hf.py), body text.
- docx_notes.py (lxml): footnote texts, no dangling references.
- openpyxl: authors the multi-sheet fixtures and reads back the saved workbooks, including formula text left untouched.

## I. Repair, and the new attack aimed at the patch

- **Repair 1 (critical, found by the mutant G-3):** fixing a word in a footnote that came from a file was not saved. `dirty` alone does not make the notes part rewrite; `notesTouched` is needed. Patched in storyBlocks.
  - **Attack on the patch:** re-open the saved file and check that the main-text issues are unchanged and the story is clean ("re-opened" assertion). Also check that the untouched endnote keeps its text.
- **Repair 2:** the governor's 14 ms WARM threshold made every 60 Hz display WARM and hid the battery reason.
  - **Attack:** a 20 ms interval must still read WARM; under WARM a low battery must still pause background work and show the battery reason (unit, plus the "COOL || WARM" mutant).
- **Repair 3:** a duplicate `w:id` across paragraphs written by one tracked deletion. Renumbering was extended from rPrChange / pPrChange to every revision record.
  - **Attack:** the TT56 / TT57 track-change suites rerun unchanged (6 + 5 + 5 pass). The oracle's `ids_unique` holds in all 40 random sessions.

## J. Stopping

The tier stops here because:
- every new row (FF-40, FF-41, FF-42) and the promoted RG-05 has unit tests with killed mutants and an e2e on the production build;
- the full regression gate was run, and its failures were re-run from the repository (see Results);
- the remaining items are listed under C and in the PR's blocker list.

## Results

- tt60-writer-tblrev: 7/7. Includes 40 randomized sessions. 13/13 mutants killed.
- tt60-sheet-spell-all: 2/2. 4/4 mutants killed (one after a fixture fix).
- tt60-writer-spell-stories: 3/3. 10/10 mutants killed (two after test strengthening; one revealed a bug).
- tt60-units: 2/2. 5/5 mutants killed.
- Regression, rerun unchanged: tt46-writer 12, tt49-writer 9, tt56-writer-track 6, tt57-writer-fmt 5, tt57-writer-para 5, tt58-writer-notes 5, tt59-writer-spell 8, tt59-sheet-spell 5.
- e2e-tt60: 5/5 on the TT60 production build (build 7), including the modal-shortcut failure test.
- Full run-all gate (133 suites) on a git-archive snapshot of 939dabe against build 6.
  - Every suite passed except ones that cannot run from an archive: the second-server suites e2e-tt37…43 and e2e-tt56-rows need `.next`, and tt44-vt is a known archive failure.
  - Also failed in that run: two e2e-tabletop timing checks, one e2e-tt51-slides pick, and tt39-pac.
  - All of these were re-run from the repository and pass: e2e-tabletop 15, e2e-tt37 5, e2e-tt38 7, e2e-tt39 7, e2e-tt40 3, e2e-tt41 4, e2e-tt42 3, e2e-tt43 3, tt44-vt 12, e2e-tt51-slides 6, e2e-tt56-rows 7.
  - tt39-pac failed because its PyPAC oracle hit a 60 s timeout: each unresolvable host costs about 10 s in this sandbox's resolver. The timeout was raised to 300 s, after which it passes 8/8. No verdict changed.
- Post-build regression subset (23 suites): all pass.
  - e2e-tt56 failed 2 tests at first. An earlier suite had left the Tabletop desktop on, so the classic right-click menu was missing. e2e-tt56 now selects the classic desktop at start, and passes 10/10.
  - e2e-a11y 9, e2e-beauty 6, e2e-tt49-writer 6, e2e-tt57 3, e2e-tt58 3, e2e-tt59 4.
- Ledger: 373 features. Built: full 297 / partial 54 / blocked 21 / none 1. Tested: full 212 / partial 72 / untested 89. Tests 1114/1114, failingTouch 0.
- Visual inspection (docs/screens/tt60-*.png):
  - Row change bars: blue solid for insertion, pink dashed with struck text for deletion.
  - The pane labels "in Header" / "in Footnote 1".
  - Footnote misspellings are underlined in place. **Header and footer misspellings are listed in the pane but not underlined on the page** (stated limit).
