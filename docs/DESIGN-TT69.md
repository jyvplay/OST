# TT69 — document lifecycle for Writer / Spreadsheet / Editor (FF-15) + Spreadsheet carry-overs

## Runtime honesty

- **Ran:** Node 22 (strip-types), tsc, Next 16.2.6 production build, Playwright 1.64.1 with Chromium 143 (headless,
  @sparticuz), embedded Postgres 17.10, Python 3.11 venv (python-docx, openpyxl, lxml).
- **Did not run:** Word, Excel and LibreOffice (none are available in the sandbox); Firefox and Safari; any real
  desktop OS; a real browser crash. The "killed tab" case is a closed Playwright context, which is the closest available
  stand-in.
- **Excel behaviour:**
  - The SUMIF / AVERAGEIF resize follows Microsoft's documented remark: the top-left cell of sum_range, resized to the
    shape of range. One Excel-computed cached value confirms it (POI corpus E1324, see H).
  - The clipping at the sheet edge is *my* choice. Excel's documentation is silent on it, and it is **unverified**.
  - Paste Values of `=""` keeping empty text is Excel's documented behaviour for pasting a zero-length string. I could
    not run Excel to observe it.
- **No theorem prover was used.** The formal model below is checked only by tests: unit tests, a brute-force
  reference, and mutants.

## A. Formal model

**Document state.** For each window `w` with a document:
- `dirty(w)` is a live predicate (`DocGuard.dirty`). A guard that throws counts as dirty: fail safe, ask the user.
- `path(w)` is the file path, or untitled with a random id `u(w)`. The id rotates on Writer New.

**Close commands.** `close(w)`, `closeAll`, `New` (replace) and `unload`. Each is planned by
`planClose(cmd, windows, dirty)`, which returns `(closeNow, ask)` such that:

- **P1 (completeness):** `closeNow ∪ ask` = the windows the command names (an unknown id names nothing). The two sets
  are disjoint.
- **P2 (safety):** `w ∈ ask` ⇔ `dirty(w)` and not `force`.
- **P3 (queue):** `enqueueAsk(Q, more)` keeps `Q` as a prefix and adds each id once.
- **P4 (modality):** while the queue is non-empty, every other window is `inert`. Key events never reach a document
  behind the dialog, and global shortcuts are ignored (`isAskOpen`).
- **P5 (outcomes):**
  - **Save** writes the file. It closes only if the save resolved true. An untitled Save opens Save As and stops the
    queue; a thrown save keeps the dialog open with the error.
  - **Don't save** flushes the draft, then closes.
  - **Cancel** clears the whole queue.

**Drafts.** `draftPathFor(kind, path, u)`:
- Path documents: `root(path)/kind-encodeURIComponent(path).draft`.
- Untitled documents: `root/kind_untitled-u.draft`.
- `root` is `/Private/.Recovery` for private paths, otherwise `/System/Recovery`.
- **D1 (injective):** distinct (kind, path) pairs give distinct names. encodeURIComponent is injective; TT69 found
  that the readable "/"→"_" scheme collided.
- **D2 (no history):** a write with reason `recovery-draft` under a recovery root takes no version snapshot.
- **D3 (timing):** at most one write is in flight. The newest content is written last. Writes happen 2 s after the
  last change, or within 10 s of the first unsaved change, whichever is sooner.
- **D4 (no resurrection):** after `clear()` resolves, no draft that was scheduled or serialising before it can land.
  This includes the Save As case, where the late draft is for the old path.
- **D5 (offer):** a draft is offered only for its own path. It is flagged stale when its baseSha ≠ the file's current
  sha.
- **D6 (no plaintext):** password-protected documents get no drafts, because a draft would be plaintext. This limit
  is disclosed.

**Spreadsheet changes.**
- **S1 (resize):** `SUMIF(r, c, s)` with shape(s) ≠ shape(r) evaluates over
  `s' = topleft(s) + shape(r)`, clipped at the sheet edge.
- **S2 (empty text):** Paste Values of a source with value `""` and input ≠ `""` gives the input `'` (empty text).
  A source with input `""` gives blank.
- **S3 (range cap):** a single materialised range may hold up to 2²¹ cells.

**Editor.** Ctrl+S acts only when the key event's target is inside that Editor's own window.

## B. Hypotheses

| | Hypothesis | Result |
|---|---|---|
| H+ | A modal dialog with `inert` on the shell root blocks every key and pointer path to the document | **Confirmed** by e2e test 1. Tried: Delete, typing, Backspace, Ctrl+Z, Ctrl+S, Alt+F4, Meta+W, Ctrl+Shift+V, F7, script `.focus()`, and a raw mouse click on the cell. Tab stays inside the dialog. |
| H+ | Draft bytes are the real document format | **Confirmed.** python-docx reads the Writer draft's .docx bytes. |
| H− | TT68's Writer New silently discarded unsaved work | **Confirmed before the fix** (FF-15 investigation). The e2e now checks the dialog. |
| H− | TT68's Editor drafts leaked private documents | **Confirmed before the fix** by tt69-lifecycle's legacy-leak check (pg shows a plaintext row). |
| H− | Draft writes polluted the version history | **Confirmed before the fix.** The old build made 2 versions for 3 draft writes. |
| H∂ | My dialog is readable in every theme | **Refuted by visual inspection.** The text contrast was 1.06:1, because I guessed CSS variables that don't exist. Fixed, and an e2e contrast assertion now covers dark and light. |
| H∂ | Editor Ctrl+S is only a modal leak | **Refuted.** It saved from *any* focus, including other windows. Scoped and tested. |
| H∂ | A full-column SUMIF works | **Refuted.** A 1,000,000-cell cap made one full column #NUM! once data reached row 1,048,576. Raised to 2²¹. It is slow (see C). |

## C. Frontier (still not Class A, or limited)

- **Password-protected documents have no recovery drafts (D6).** A real fix would encrypt drafts with the document
  key.
- **Drafts are per document, not per window.** Two windows on the same file share one draft (last writer wins).
- **Close all with 2+ dirty windows is unit-tested only.** planClose and enqueueAsk are covered; the e2e opens one
  window per page. The multi-window UI queue is not exercised in a browser.
- **Full-column ranges are slow once data reaches the last row.** About 1.4 s per formula, 290 MB of heap for
  9 formulas. A sparse range iterator is the real fix.
- **Launcher opening by itself: probable cause found and fixed, but the triggering event was never captured.**
  The Launcher covered pages in e2e-tt69 (once) and in e2e-privacy (the Amnesia tab, in 2 standalone runs).
  - Mechanism: the SH-06 hot-corner tracker fired on the *first* pointer event it saw if that event was in the
    corner. A fresh Playwright cursor rests at (0,0), which is in the corner.
  - Fix in `src/lib/hot-corner.ts`: the first sighting only arms the tracker, and zero-movement events never fire but
    still update the position. Chromium's first `pointerrawupdate` reports movement 0, so it must still arm.
    My first version skipped zero-movement events entirely and broke a genuine entry; the real-pointer e2e caught it.
  - Since the fix, e2e-privacy's Amnesia test passes and e2e-tt69 passes. Real hardware is not tested.
- **The resize clipping at the sheet edge is unverified against Excel.**

## D. Negative shapes tested (≥ 15)

1. Delete under the dialog.
2. Typing under the dialog.
3. Backspace.
4. Ctrl+Z.
5. Ctrl+S, which must not save the file (openpyxl confirms).
6. Alt+F4, which must not stack a second dialog.
7. Meta+W.
8. Ctrl+Shift+V.
9. F7.
10. A script calling `.focus()` on the grid (inert).
11. A raw mouse click on a cell, then Delete.
12. Tab ×5, which stays inside the dialog.
13. Escape cancels; the window stays open and unsaved.
14. Writer New → Escape keeps the text.
15. A clean page raises no beforeunload prompt.
16. An Editor draft written to the legacy path (must not happen).
17. Editor Ctrl+S with focus outside the window.
18. Editor Ctrl+S / Meta+S under the dialog.
19. A stale draft is flagged, and Restore does not overwrite the newer file before Save.
20. clear() while make() is serialising (no write at all).
21. Save As: a late draft of the old path.
22. Draft key collisions: `/a_b` vs `/a/b`, `a:b` vs `a?b`, 3,000 random paths.
23. Codec: wrong version or kind, NaN or negative time, bad sha, non-base64 payload.
24. An oversized draft.
25. A failing store.
26. SUMIF resize past the last row.
27. A cross-sheet sum_range.
28. A whole column with a single-cell sum_range.
29. Paste Values + Add of empty text over a number.
30. Skip Blanks with empty text.

**Modal-shortcut test:** shapes 1–12 and 18.

## E. Mechanism-distinct approaches considered (≥ 6)

1. **`window.confirm()` on close.** Rejected: it can't offer three choices, it's unstyled, and some embedded contexts
   block it.
2. **Per-module dialogs.** Rejected: every module would duplicate the logic, and Close all couldn't queue across
   modules.
3. **A shell-level dispatch intercept with a guard registry and one modal queue.** **Chosen.**
4. **Saving to localStorage or IndexedDB.** Rejected: it would bypass the VFS's privacy layer. Private drafts must be
   encrypted at rest like their documents.
5. **Drafts as VFS versions of the file itself.** Rejected: it would pollute the history (H−) and blur "saved" vs
   "unsaved".
6. **A separate draft table in Postgres.** Rejected: the VFS write path (privacy layer, trash, purge) already exists
   and is tested. The draft files reuse it, using `snapshot:false` only for the recovery roots.
7. **Blocking keys in a capture listener instead of `inert`.** This is used *in addition*, but on its own it misses
   script focus and pointer paths (shape 10).
8. **For SUMIF: rewriting the AST at evalCall versus passing addresses into `Arg`.** The AST rewrite was chosen
   because `Arg` deliberately carries no address.

## F. Artifacts

**Code:**
- `src/lib/doc-lifecycle.ts`, `src/lib/doc-drafts.ts`, `src/components/CloseConfirm.tsx`,
  `src/components/doc-lifecycle-ui.tsx`.
- Changes in Shell, Writer, Spreadsheet and Editor; route `isDraftWrite`; `engine.ts`; `sheetops.ts`; `registry.ts`
  (stale Writer summary corrected).

**Tests:** `scripts/tt69-lifecycle.mts` (11), `scripts/e2e-tt69-lifecycle.mts` (6), `scripts/tt69-sheet-misc.mts`
(5), and `scripts/tt69-mutants.py` (24).

**Results:**
- `docs/test-results/{tt69-lifecycle,e2e-tt69-lifecycle,tt69-sheet-misc}.json`
- `docs/heldout/tt69-heldout.jsonl`
- `docs/heldout/tt69-mutants.txt`

**Screens:** `docs/screens/tt69-close-confirm-{dark,light}.png`.

**Seed:** `src/db/seed-data/features-tt69.ts`; SEED 3.55.0.

## G. Second-order adversary

- **Mutants:** 24 bugs re-introduced in doc-lifecycle, the engine resize/cap, the sheetops paste, and the hot corner.
  - First run: 20/21 killed. The survivor, "clear does not cancel a serialising draft", lived because the test only
    checked the end state, and write-then-delete hid the late write.
  - Fix: the test now asserts no write at all, and covers the Save As orphan case.
  - Re-run: 21/21 killed. With the 3 hot-corner mutants added later: **24/24 killed.**
- **Visual inspection as the adversary on the e2e suite.** The first 5/5 green run had an unreadable dialog
  (contrast 1.06:1), so a contrast assertion was added. On the old build it fails at 1.06:1.
  - The first version of that assertion treated rgba backgrounds as opaque and failed the danger button falsely
    (1.60:1). It now composites alpha.

## H. External verification

- **python-docx** reads the Writer draft bytes and the saved file.
- **openpyxl** reads the saved Spreadsheet edit, the unsaved file under the dialog, the untouched newer file in the
  stale-draft case, and the empty-text cell (`''`, not None).
- **Postgres:** private drafts are ciphertext at rest (tt69-lifecycle).
- **Excel-computed cached values, POI corpus held-out probe:** 26,294 → **26,295** of 26,946.
  - The new match is `=SUMIF(AA7:AA13,C10:D10, C7)` with a cached value of 1.1.
  - Compared with the TT67 tree there are 8 flips, all improvements and none worse.
  - 651 cells still disagree.
- **Brute-force reference:** 400 random SUMIF/AVERAGEIF shapes.

## I. Repair + attack on the patch

| Patch | Before | After | Attack on the patch |
|---|---|---|---|
| Close-confirm surface/text variables | contrast 1.06:1 | ≥ 4.5:1 in dark and light | rgba compositing; dialog surface must be opaque |
| Editor Ctrl+S scope | saved from outside (`v1+x`) | only from inside | under the dialog; blur; inside the window still saves |
| SUMIF/AVERAGEIF resize | tt69-sheet-misc 1/4 on HEAD | 5/5 | sheet edge; cross-sheet; whole column; larger sum_range shrinks |
| Paste Values of empty text | blank | `'` | Skip Blanks; Add over a number; xlsx round trip |
| 2²¹ range cap | #NUM! | correct | timing measured (slow; disclosed) |
| Hot corner first sighting + zero movement | Launcher opened with no user motion (3 suites) | first event arms; zero-movement never fires | my first patch (skip zero-movement entirely) broke real entry — caught by the real-pointer e2e; unit case + mutant added |

## Gate and test repairs

**Full run-all, 164 suites:** 1251 passed, 7 failed. No TT69 suite failed. All 7 failures were analysed:

- **e2e-tt36 (2), tt36-unit (1), tt37-unit (1), e2e-tt37 (1): live-site drift.** pypi.org/help/ now 301-redirects to
  docs.pypi.org, which is outside the sandbox. These are repairs to the *tests*, not the app:
  - The proxy and route tests now use pypi.org/sponsors/.
  - The reader test now uses github `nodejs/node/blob/main/CONTRIBUTING.md`. No reachable pypi.org page has a
    followable in-article link.
  - tt36-unit swaps in github `first-contributions.md`. pypi.org/sponsors/ is a link grid, where the reader keeps only
    42% of what readability-lxml keeps. That is a real reader disagreement on link-grid pages and is disclosed, not
    hidden.
  - Re-runs: e2e-tt36 3/3, tt36-unit 5/5, tt37-unit 9/9, e2e-tt37 5/5.
- **e2e-privacy (2): perf (a known flake) and backup.**
  - Backup passed on the next standalone run.
  - Amnesia then failed twice standalone because of the Launcher overlay. Fixed (hot corner, see C); it now passes.
  - The perf test (/Private save vs host save timing) still fails in most runs: a known flaky gate.
- **Post-gate state pollution.** An interrupted run left `appearance.desktopView = tabletop`. e2e-tt55-shell (SH-04)
  and e2e-tt67-input (SH-06) failed with no app change. Both suites now force the classic view and restore the
  previous value, which I verified by starting them in tabletop: 3/3 and 5/5.

**Ledger after TT69:**
- 383 features. Built: full 306 / partial 55 / blocked 21 / none 1.
- Tested: full **227** (was 225) / partial **71** (was 72) / untested **85** (was 86).
- Tests 1257/1258; the 1 failure is the e2e-privacy perf flake.
- Tails: 39 rows (9 / 10 / 20).

**Mutants:** 24/24 killed (`docs/heldout/tt69-mutants.txt`), including 3 hot-corner mutants. TT67's 3 hot-corner
mutants are re-anchored and killed.

## J. Stopping

FF-15 meets its acceptance tests: unit 11/11, e2e 6/6, mutants 24/24. It is graded **A** for Writer, Spreadsheet
and Editor, with the limits in C. The full gate result is recorded in the PR body.

I stopped before encrypted drafts and a sparse range iterator. Each is a multi-hour change that would not fit this
turn honestly.
