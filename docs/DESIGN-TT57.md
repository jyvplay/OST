# DESIGN-TT57 — Writer format-change tracking, Spreadsheet hyperlinks, Clock and Clipboard to Class A

Tier-5 protocol (A–J). Everything below names the code and the suite that checks it. Results are under "Results".

## Runtime honesty

**What ran:**
- a bash sandbox (2 cores, 3 GB);
- Node 22.22.3 with `--experimental-strip-types`, `tsc`, Next 16.2.6 (`next build` + `next start`);
- Playwright 1.64.1 driving Chromium 143 (the @sparticuz build, headless), including Playwright's **fake clock** (`page.clock`) and clipboard permission grants;
- embedded PostgreSQL 17.10;
- a Python 3.11 venv with lxml and openpyxl (MIT) used as oracles.

**Not available, so nothing here claims them:**
- theorem provers and parallel agents;
- Microsoft Word / Excel and LibreOffice (no "opens in Office" check — PR-11);
- Firefox, Safari and real phones;
- a really hidden browser tab. PR-10 replaces `requestAnimationFrame` with a no-op before the app loads, which is an *emulation* of a hidden tab's suspended frames.
- a second application writing to the OS clipboard.

## A. Formal model

**Format tracking (FF-22).**
- A text run is `r = (text, f, rev?, fc?)`, where `fc = {id, author, date, old: RunFmt, oldRPr?}`.
- With `track.on`, `applyFmt(range, patch)` sets, for each run `r` with no `rev` whose format changes (`f' ≠ f`):
  - `old := r.fc ? r.fc.old : r.f`;
  - if `f' = old`, then `r.fc := ∅`, because going back to the original removes the record;
  - otherwise `r.fc := r.fc ?? {id: next++, author, date, old}`.
- Runs that carry `rev` (insertions or deletions) are not format-tracked. Word treats them the same way: the insertion's own formatting is part of the insertion.
- **Accept** sets `fc := ∅`. **Reject** sets `f := old`, and if the record came from a file it restores `oldRPr` verbatim.
- On serialization, one `w:rPrChange` per `w:r` holds the old `w:rPr`. Ids are unique across the document: when a split run produces copies, the later copies get fresh ids.
- **Invariant:** for every decision vector `D` over the saved revisions, `ours(D)` equals `oracle(D)` as run segments `[text, b, i, u, strike, sz, color]`, using the lxml oracle in `scripts/oracle/docx_track.py`.

**Paragraph-property tracking (FF-22, `w:pPrChange` §17.13.5.29).**
- A paragraph is `P = (p, content, markRev?, pc?)` with `pc = {id, author, date, old: ParaProps, oldPPr?}`.
- `setParaProps`, `toggleList` and `indent` are the only writers of `p`. Each calls `trackPara(before)`: with `track.on`, unless `markRev.kind = ins` (the whole paragraph is new text): `old := pc ? pc.old : before`; if `p = old`, then `pc := ∅`; otherwise `pc := pc ?? {id: next++, old: before}`. `num: null` and no `num` count as equal.
- **Accept** sets `pc := ∅`. **Reject** sets `p := old`; a file record restores `oldPPr` verbatim plus the current mark `rPr` and `sectPr` (CT_PPrBase cannot hold them).
- Serialization: the `w:pPrChange` is the last child of `w:pPr` (schema order), holding the old pPr without `rPr`/`sectPr`. A list that exists only in `old` (bullets removed while recording) is still created in numbering.xml so the record points at a real `numId`.
- **Invariant:** for every decision vector `D`, `ours(D) = oracle(D)` as `[pStyle, jc, numId, ilvl, ind-left]` per paragraph (`*_paras` in docx_track.py).

**Hyperlinks (FF-21).**
- `sheet.links = [{ref: range, target?, location?, tooltip?, display?}]`; the first record covering a cell wins.
- `setLink(range, L)` cuts every existing record into at most 4 rectangles around `range`, then puts `L` first.
- Insert/delete `(axis, at, n)` maps each ref through `adjustRange`. A record whose cells are all deleted is dropped.
- `clearRange(all)` behaves like `setLink(range, null)`.
- `linkAction` decides what happens on click:
  - `http(s)` opens a URL, with `#location` appended as the fragment;
  - `mailto:` opens the OS handler;
  - `Sheet!A1` (or a bare `A1`) moves the selection;
  - anything else does nothing and shows an explanation.
- **Package:** `<hyperlinks>` sits after `dataValidations` and before `printOptions`, `pageMargins` and `drawing`. Each external target gets one `Relationship` (Type …/hyperlink, `TargetMode="External"`) in the sheet's rels part. A lossless patch removes the old hyperlink relationships and writes fresh ones, so none is left orphaned.

**Clock (PR-10).**
- `display = acc + (running ? now − start : 0)`, where `now = performance.now()` at the last frame.
- A timer fires when `end − now ≤ 0`.
- `now` is sampled by rAF and also by one `setTimeout(end − now)`. Elapsed time therefore never depends on how many ticks ran.

**Clipboard history (PR-12).**
- The list is ordered by most recent use.
- `add(e)`: a non-sensitive entry with the same text is removed first, and its pin is carried over. The oldest unpinned entries are then evicted down to `max − |pinned|`.
- `pin` does not apply to sensitive entries. `clear` keeps pinned entries.

## B. Hypotheses

**H+ (expected to hold, tested):**
- Our accept/reject equals the oracle for:
  - one bold change;
  - 40 random sessions (bold, italic, underline, size, colour, repeated, reverted);
  - Word-written `rPrChange` from the POI corpus;
  - a formatted run split by a tracked insertion.
- Every `<hyperlink>` in 13 POI workbooks (108 records) reads equal to an lxml reading of the raw parts. Each cell's link equals openpyxl's.
- Export and lossless patch round-trip through openpyxl.
- 300 random set / remove / insert / delete / clear operations match a per-cell reference model.
- A 10-minute clock jump in which timers fire at most once still shows 10:00.
- History operations match an independent reference model.

**H− (expected to fail, tested as negative shapes):**
- `javascript:` / `vbscript:` typed as an address must NOT become a link.
- A `file:` / UNC / script target read from a file must NOT open.
- An untracked format change must NOT create a record.
- Formatting back to the original must NOT leave a record.
- A timer must NOT fire early, and a 0:00 timer must NOT start.
- A sensitive entry must NOT be pinned or deduplicated.

**H∂ (partly true, disclosed):**
- Paragraph-property changes are tracked for alignment, style, lists, indent and spacing set through the editor; table / row / cell property revisions are still not tracked.
- An `rPrChange` inside content the editor keeps opaque (fields, content controls, moves, revision containers it cannot edit) is decided together with that opaque item, not listed on its own. The test accounts for every one of these records.
- Hyperlinks move with Sort and copy/paste (tt57-sheet-links), but Paste Special does not carry them.
- The 30 s clipboard auto-clear is implemented but no test exercises it.
- Global clipboard history is impossible on the web.

## C. Frontier

**Writer:** table revisions, footnote editing and spell check are still missing.

**Spreadsheet:**
- pivot depth;
- drawing the x14 conditional-format extensions;
- hyperlinks under Paste Special.

**Clipboard:** other-app history is not possible on the web.

## D. Negative shapes (≥ 15) + modal shortcut

1. `javascript:alert(1)` typed in the Link panel is refused, the panel stays open and no link is set (e2e-tt57).
2. `vbscript:` typed is refused (tt57-sheet-links).
3. A `javascript://` target read from a file (POI 53734.xlsx) is kept for a lossless save, but `linkAction` returns `none`.
4. A `file:///…notepad.exe` target is never opened.
5. A UNC `\\server\share` target is never opened.
6. A place link to a missing sheet explains itself and does nothing.
7. An address-less (tooltip-only) Excel record is kept, not dropped (POI 52716.xlsx).
8. Removing part of a ranged link keeps the rest of the range linked (reference model).
9. Deleting every row of a link drops it, while Clear Contents keeps it, as in Excel (reference model).
10. Formatting while tracking is off adds no record (tt57-writer-fmt).
11. Bold then un-bold while tracking leaves no record (tt57-writer-fmt).
12. Formatting inside a tracked insertion adds no extra record (random sessions).
13. A duplicate rPrChange id after a split is renumbered. The mutant without renumbering is caught.
14. A timer does not fire at 2.5 s of a 3 s run (e2e-tt57-rows).
15. A 0:00 timer cannot start (e2e-tt57-rows).
16. A paused stopwatch does not advance over 5 s (e2e-tt57-rows).
17. Sensitive entries are not pinned or deduplicated (tt57-units).
18. Paragraph edits while recording is off add no record; toggling bullets on then off leaves no record (tt57-writer-para).
19. A paragraph whose mark is a pending insertion gets no separate paragraph record (tt57-writer-para).
20. **Modal shortcut failure test:** Escape inside the Link panel closes only the panel. The Spreadsheet window stays open and nothing is linked (e2e-tt57).

## E. Mechanism-distinct approaches (≥ 6)

1. **Model-level revision record.** `fc` on the run is serialized as `w:rPrChange`. This is the chosen approach.
2. **Shadow-document diff at save time.** Rejected: it cannot tell a deliberate re-format from the original, and it loses authorship.
3. **Store the old rPr XML only.** Rejected: editor-made changes have no XML, so `fc.old` is used for those and `oldRPr` only for file records.
4. **Hyperlinks as cell-style attributes.** Rejected: ranged `<hyperlink ref>` records would be exploded and could not round-trip.
5. **Hyperlinks as range records with rectangle splitting.** Chosen. It is lossless for ranged records.
6. **Timer driven by `setInterval` tick counting.** Rejected: it drifts when throttled, which is the PR-10 design point.
7. **rAF plus one end-time timeout.** Chosen.
8. **pPrChange as a diff against the file's original pPr (`p0`)** — rejected: an editor-made paragraph has no `p0`, and a second edit would lose the first original. The record keeps the properties from before the first tracked change, like Word.
9. **Clipboard dedupe by recency list, compared with a Set plus timestamps.** The recency list was chosen; the reference model in the tests is written the other way, with an explicit eviction loop.

## F. Artifacts

**Code:**
- `src/lib/office/wordml.ts`: FmtChange parse/serialize, one run per original `w:r`, unique ids, and the fix for a field run's rPr.
- `src/lib/office/wordedit.ts`: tracked `applyFmt`, fmt revisions, resolve; `trackPara` / `paraDiff` and `p:fmt:<id>` paragraph revisions.
- `src/components/modules/Writer.tsx` and `writer/view.ts`.
- `src/lib/formula/sheetlinks.ts`, plus links support in `engine.ts`, `xlsx.ts`, `xlsx-patch.ts`, `workbook-json.ts`, `sheetlayout.ts`, `sheetops.ts` and `Spreadsheet.tsx`.
- `src/components/modules/Clock.tsx`.
- `src/lib/cliphistory.ts`, `Shell.tsx` and `Clipboard.tsx`.

**Oracles:** `scripts/oracle/docx_track.py` (extended for rPrChange and pPrChange) and `scripts/oracle/xlsx_links.py` (new).

**Suites:** `tt57-writer-fmt`, `tt57-writer-para`, `tt57-sheet-links`, `tt57-units`, `e2e-tt57`, `e2e-tt57-rows`.

**Screens:** `docs/screens/tt57-writer-fmt.png`, `docs/screens/tt57-sheet-link.png`, `docs/screens/tt57-writer-para.png`.

## G. Second-order adversary

**"The test lists only what the parser finds."** The corpus test counts every `w:rPrChange` in the file. Each one must be either listed or inside an opaque token. This invariant exposed:
- the field-run rPr bug: a run's own `w:rPr` became a field-code token, so a regenerated run had two `w:rPr` elements and a duplicated record;
- tokens that carry their run's rPr.

**"The oracle shares our assumptions."** The oracle is lxml over the raw XML with its own accept/reject transform. openpyxl is a separate reader for links.

**"Mutants survive."** Every mutant below was killed. One mutant survived at first and led to a stronger test:

| Mutant | Caught by |
|---|---|
| Reject without restoring the format | the new in-memory test (it survived the corpus-only test) |
| No tracking in `applyFmt` | existing tests |
| Not stripping resolved records | existing tests |
| Not restoring a file's `oldRPr` | existing tests |
| Field rPr captured as a token | tt56-writer-track |
| No id renumbering | split test |
| No link shift on insert/delete | reference model |
| No rectangle split | reference model |
| No reader | tt57-sheet-links |
| pPrChange reject keeps the new props | tt57-writer-para (2 tests) |
| pPrChange recorded inside a pending inserted paragraph | tt57-writer-para |
| A list only in `pc.old` not created in numbering.xml | tt57-writer-para (2 tests) |
| Reject of a file record drops the mark rPr | tt57-writer-para (Word-shaped record) |
| Not removing old hyperlink relationships | the new orphan-count assertion (it survived until that assertion was added) |

## H. External verification

- python-docx-free lxml oracle for docx revisions.
- openpyxl for cell hyperlinks.
- The system clipboard read back through `navigator.clipboard.readText()` with a granted permission. This is independent of the history list.
- Playwright's fake clock for time.

## I. Repairs, and a new attack on each patch

**1. Field run rPr (wordml `parseRun`).**
- *Repair:* skip `w:rPr` before the field-code check.
- *Attack:* re-serialize the whole POI corpus with every paragraph dirty. tt56-writer-track checks that revisions are unchanged, 74 = 74 on delins.docx.

**2. Duplicate rPrChange ids after a split.**
- *Repair:* renumber later copies at write time.
- *Attack:* save twice, and check that ids stay unique and accept/reject equals the oracle.

**3. `errorStyle="undefined"` written for a validation without a style** (found by openpyxl refusing the export).
- *Repair:* write only `warning` or `information`.

**5. Bullets could not be toggled off after a save** (found by the pPrChange list test): `writeWord` remapped `~bullet` to a real `numId` but the live model's numbering map did not learn it, so `listKind` returned none and the button turned bullets on again.
- *Repair:* register the new list definition in `doc.numbering` at write time.
- *Attack:* tt57-writer-para saves, then toggles off and expects no record and no list.

**6. Ctrl+S did nothing after Accept/Reject in the review panel** (found by e2e-tt57): the pressed button was removed, focus fell to the page body, and Ctrl+S was only handled in the editing surface.
- *Repair:* Writer's root handles Ctrl+S; after a decision focus moves to the next change or the page.
- *Attack:* e2e-tt57 rejects, then accepts, then saves with Ctrl+S each time and reads the bytes back.

**7. Status messages drew `→` as tofu** (visual check of tt57-sheet-link.png): replaced with words in Spreadsheet status texts.

**4. Clock timer stalls without rAF.**
- *Repair:* add a one-shot timeout.
- *Attack:* the rAF-disabled e2e.

## J. Stopping

The tier stops when:
- the new suites pass;
- every mutant listed is caught;
- the targeted subset passes on the TT57 build;
- the ledger is regenerated.

Remaining gaps are listed under C and in the PR blockers.

## Results

**Last turn's task (TT56 gate):** full `run-all.sh` on the TT56 build — 117 suites, 1021 passed / 5 failed, all 5 in `e2e-layout` (known order flake). `e2e-layout` re-run alone: 12/12. `e2e-privacy` passed its perf gate on this run.

**TT57 suites (TT57 build, Chromium 143 headless, Python 3.11 oracles):**

| Suite | Result |
|---|---|
| tt57-writer-fmt | 5/5 |
| tt57-writer-para | 5/5 (120 random sessions vs the oracle) |
| tt57-sheet-links | 6/6 |
| tt57-units | 2/2 |
| e2e-tt57 | 3/3 |
| e2e-tt57-rows | 4/4 |

**Regression subset on TT57 source/build:** office-engine 35, oracle-xlsx 5, sheet-layout 6, privacy-crypto 9, tt46-writer 12, tt46-xlsx-patch 8, tt47-sheet 8, tt47-crypto 5, tt48-office 6, tt49-sheet 10, tt49-writer 9, tt56-writer-track 6, tt56-sheet-paste 4, e2e-office 11, e2e-sheet-layout 7, e2e-a11y 9 (alone; 8/9 once in a batch — the known order flake on the Large-text shelf icon), e2e-tt46 8, e2e-tt47 5, e2e-tt48 6, e2e-tt48-sync 4, e2e-tt49 5, e2e-tt49-writer 6, e2e-tt56 10, e2e-tt56-rows 7 — all passing.

Patch #7 attacked its own tests: changing the export status text broke the regexes in e2e-office and e2e-sheet-layout (`→ path`); they now accept `to` as well and pass.

**Ledger:** 368 features; built full 292 / partial 54 / blocked 21 / none 1; tested full **203** (+2: PR-10, PR-12) / partial 72 / untested 93; tests 1051/1051 recorded. A full 123-suite run on the TT57 build was **not** made this turn; the counts combine the TT56 full run with the TT57 subset above.

**Visual check:** tt57-writer-fmt.png, tt57-writer-para.png, tt57-sheet-link.png inspected. Found and fixed: arrow tofu in Spreadsheet status. Seen, not fixed: in a narrow Writer window with the review panel open the page is scrolled sideways so the left page margin (and Word-style margin room for the change bar) is out of view; the change bar is drawn inside the paragraph edge.
