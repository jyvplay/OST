# TT65 — Writer Track Changes in every story (FF-49)

## Runtime honesty
- **Used:**
  - bash sandbox, Node 22 + tsc, the Next 16.2.6 production build, Playwright 1.64.1 with headless Chromium 143, embedded Postgres 17.10;
  - Python 3.11 with lxml and python-docx (test-only); the ECMA-376 transitional XSDs (`scripts/oracle/ooxml_xsd.py`);
  - the en_US Hunspell dictionary already shipped (dictionary-en, MIT AND BSD).
- **Not available:** Word, LibreOffice, any Office open / repair check. Nothing here claims Word opened these files. The stand-ins are XSD validity, the independent lxml oracle `scripts/oracle/docx_stories.py` (written this tier; it shares no code with `src/lib/office`) and python-docx.
- **Sources:**
  - ECMA-376 Part 1 §17.13.5 (revision annotations; each annotation id unique), §17.13.5.13 (w:delInstrText inside w:del).
  - bettersolutions.com "Word Paragraphs — Paragraph Marks" (2026): when two paragraphs merge, the first paragraph's mark (formatting) applies.
  - wordarticles.com "Issue with Index Field Updating — A Quirk: Deleting Paragraphs": deleting an *entire* paragraph is not a merge; the following paragraph keeps its settings.
  - Microsoft Q&A / MVP threads (Stefan Blom, Graham Mayor) agreeing that a Backspace merge keeps the first paragraph's style.
  - No word-processing code was read or borrowed.

## A. Formal model
- **Stories.** A document D has the main story B and stories S = headers / footers (one per part) ∪ referenced footnotes / endnotes (unreferenced notes are dropped on save, so their revisions are not listed). `storyDoc(D, s)` is D seen through s: the same styles, ids, author and Track Changes state (`doc.track` is shared, so new revision ids stay unique package-wide) with `blocks` = s's blocks. Every editing / review operation works unchanged on that view; the story's blocks are copied first and committed with `set` (copy-on-write: undo snapshots hold the old arrays).
- **Review.** revisions(D) = mainRevisions(B) ++ [s:⟨story⟩|k for k in mainRevisions(s) for s in S] (headers / footers, then notes). resolveOne routes `s:` keys to the story copy; resolveChanges = main pass + one pass per story (committed only if something changed).
- **Reader view.** view(p) = the paragraph's visible text — tracked deletions left out — with, per unit, its model offset (or ⊥ for field / tab / token text, which an edit may not cut into) and an insertion point. A story's text = views joined by "\n", except after a paragraph whose mark is a pending deletion.
- **viewEdit(want).** hunks = diff(view, want); refuse (no change) if a hunk touches ⊥ units; otherwise apply right-to-left with deleteForReplace / insert / splitParagraph — the ordinary main-text operations, so under tracking each hunk is w:del(old) + w:ins(new) (own pending insertions vanish), untracked a plain edit that leaves other revisions alone. The caller re-reads the view and refuses unless it equals `want` (verified, not assumed).
- **Header Apply (tracked).** For each panel line: same id and changed → viewEdit in place (alignment → w:pPrChange); no id → a fresh paragraph, text w:ins and mark w:ins (separate ids); old paragraph not kept → content and mark w:del (page-field codes included). Tail rule: the story's final mark can be neither inserted nor deleted. In a contiguous tail of removed (R) / fresh (F) paragraphs the order R-vs-F is invisible in both views (R hidden on Accept, F hidden on Reject), so the tail is normalised to R…, F…; with both present, the last R and last F become one final paragraph (R text struck, F text inserted, original final mark, pPr = F's with pPrChange old = R's); otherwise the mark change moves to the paragraph before the tail.
- **Join rule (engine and oracle).** Merging p with its next paragraph keeps p's properties unless p has nothing outside pending revisions (a whole paragraph removed / rejected), then the next paragraph's.
- **Theorem checked by the tests.** For every story edit e: oracle.accept(e_tracked(D)) = oracle(e_untracked(D)), oracle.reject(e_tracked(D)) = oracle(D), and the same for our own Accept All / Reject All and for one-by-one resolution in random orders — per story, text and alignment.
- **Ids.** read: the max-id scan includes header / footer parts. save: one `seen` set across every part written (notes, then headers / footers, then the body); a collision takes `track.next++`; unwritten parts keep their bytes.

## B. Hypotheses
- **H+ (confirmed):**
  1. Tracked header / footer Apply, Notes edits and story spelling fixes give exactly the untracked edit on Accept and the original on Reject (oracle, 8 tests, 73 random sessions verified).
  2. Review one by one in random orders = Accept / Reject All, per story; a mixed review gives that mix.
  3. Revision ids stay unique across parts after re-open + edit, and after a forced collision.
- **H− (refuted, then fixed):**
  1. "The max-id scan covers every part" — it skipped headers / footers (defect 1).
  2. "Renumbering on save covers the package" — it ran on document.xml only (defect 2).
  3. "noteTextOf is the reader's text" — it included struck text (defect 3); hdrftr `lineOf` likewise (defect 4).
  4. "A merged paragraph keeps the first paragraph's props" — wrong for a paragraph deleted as a whole (Accept left the wrong alignment in the oracle comparison).
  5. "Spelling sees words" — struck letters split words ("re~~ci~~ceive" → "re" + "ceive"): false squiggles after every tracked fix (found in the visual check).
  6. "The randomized header differential exercises in-place edits" — it did not (see G).
- **H∂ (partly):** the frozen-character guard in viewEdit is equivalent in every tested shape to the post-edit verification (mutant survives); it is kept as a stricter early refusal.

## C. Frontier (what is still not Class A here)
- Comment text is not a reviewable story.
- While tracking, an edit cutting INTO a page field / tab (header) or a field / content control (note) is refused with a message (edits around them work). A tracked edit can't delete half a field.
- A header emptied while tracking keeps its last line's alignment after Accept (text exact).
- Text boxes inside stories are not separate review stories.
- No Word open check (none in the sandbox).

## D. Negative shapes tested (≥ 15)
1. Tracked header edit cutting `{PAGE}` → HF_TRACK_REFUSAL, no part replaced or marked dirty, save byte-identical.
2. Same in the UI → alert, page header unchanged.
3. **Modal-shortcut test:** Ctrl+Z right after the refused Apply undoes the real previous header edit (no phantom undo step), Ctrl+Y redoes it.
4. Tracked note edit inside a field → "refused", note blocks identical (same array).
5. Tracked note edit around the field → "tracked", field kept.
6. Unknown story keys (`s:hf:rIdNope|…`, `s:note:footnote:99|…`) → false.
7. Random sessions that cut fields (7 of 40) → refused, save byte-identical to no attempt.
8. Untracked edit of a note holding another reviewer's insertion → "kept", revision untouched.
9. Header ids reserved on re-open: a new body revision can't reuse one.
10. Forced cross-part id collision (body / footnote) → renumbered, ids unique.
11. Untouched header part byte-identical after another part's edit.
12. Removed line holding PAGE / NUMPAGES fields → Accept leaves no empty field.
13. Header created while tracking → its own placeholder is not a tracked deletion (tt49 corpus).
14. New last line / removed last line / both → tail normalisation (oracle Accept and Reject exact).
15. Typed `{PAGE}` while tracking → a tracked PAGE field (field codes inside w:ins), not literal braces.
16. A misspelt visible word spanning struck letters → one issue over the whole model span, fixable.
17. Corpus files with w:trackRevisions (tt49): header plumbing still verified (edited untracked there by design).

## E. Mechanism-distinct approaches considered (≥ 6)
1. **Rebuild the story as plain text on edit** (TT58/61 behaviour) — rejected: silently resolves pending revisions.
2. **Character-item diff on the note's own item list** (TT61) — kept for the untracked no-revision path; cannot express tracked deletions.
3. **View + minimal diff through the main-text operations on a story proxy** — chosen: one engine for every story, tracking for free, verification by re-reading.
4. **Story-specific revision engines** (separate code for headers and notes) — rejected: duplicates resolution logic, divergent semantics.
5. **Flatten all stories into the main block list for review** — rejected: ids / pids collide, undo snapshots break, serialization order changes.
6. **Tail: always move the mark change to the previous paragraph** (first draft) — failed the oracle (empty paragraph left on Reject when the last line was both removed and replaced); replaced by the tail normalisation.
7. **Tail: pPrChange on the final mark to force the props** (second draft) — superseded once the join rule was corrected; removed.

## F. Artifacts
- `src/lib/office/wordedit.ts` — `stories`, `storyDoc`, story routing in `revisions` / `resolveOne` / `resolveChanges`, `ParaView`, `noteParaView`, `viewText`, `viewEdit`, tracked `editNoteText`, join rule, `trackParaProps`.
- `src/lib/office/hdrftr.ts` — `lineView`, tracked `setHf` (in-place lines, fresh / removed lines, tail normalisation, `putHf`), tracked `removeHf`, `HF_TRACK_REFUSAL`.
- `src/lib/office/wordspell.ts` — tracked `fixStoryIssue`; `visibleProof` / `visibleSlice` (spelling on the visible text).
- `src/lib/office/wordml.ts` — id reservation over header / footer parts; `renumberRecords` across all written parts.
- `src/components/modules/Writer.tsx` — Review place labels (`writer-change-where`), Next / Previous over stories, story refresh after resolve, Notes "tracked" / "refused" statuses, header / footer refusal alert with undo-step rollback.
- `scripts/oracle/docx_stories.py` — independent lxml oracle (per-story revisions, Accept / Reject views, cross-part id uniqueness).
- `scripts/tt65-writer-stories.mts` (8 tests), `scripts/e2e-tt65.mts` (2), `scripts/tt65-writer-mutants.py` (20 mutants).
- `src/db/seed-data/features-tt65.ts` (FF-49; FF-22 / FF-42 / FF-43 notes updated), SEED 3.51.0.
- `docs/screens/tt65-writer-story-review.png`.
- Contract updates: tt61 "fallback is explicit" → "kept, revision survives"; tt49 corpus loader edits untracked.

## G. Second-order adversary
- **The first randomized header differential was hollow.** It planned edits against a third `readWord` copy; paragraph ids differ between reads, so no line id matched and every session became "remove all + insert" — valid tracked output, so it passed, but in-place edits and the refusal path were never exercised (0 refusals in 40). Fixed: plans name source lines by index and are mapped onto each document's own ids; the test now asserts ≥ 1 refusal (7 occur) and ≥ 20 verified sessions (33).
- **PRNG check.** The suspicion that the shared LCG (`(s * 1103515245 + 12345) & 0x7fffffff` in doubles) degenerates was measured: 2000 distinct values in 2000 steps, only low bits erode; `rnd()` uses high bits. Not the cause; this suite now uses `Math.imul` anyway. Older suites unchanged (no evidence of harm).
- **Mutation:** 20 mutants; 19 killed; 1 equivalent (frozen-character guard — the verification refuses the same edits).

## H. External verification
- Independent oracle `docx_stories.py` (lxml) on every tracked / resolved file; ECMA-376 transitional XSDs on the tracked packages; python-docx opens every package.
- Real browser: Playwright + Chromium 143 against the production build; saved bytes read back via /api/fs and checked by the oracle and XSDs.
- Visual check of `docs/screens/tt65-writer-story-review.png` (it found defect H−5).

## I. Repair + attack on the patch
- **Repairs:** defects 1–4 (planned), join rule (H−4), tail normalisation, separate ids for a new line's text and mark (the save-time renumber had split them, so the list differed before / after save), `dirty` on new lines, field codes struck with a removed line, a created part's placeholder not tracked, spelling on the visible text.
- **Attacks on the patches:**
  - join rule → main-text suites tt56 / tt57 / tt58 / tt60 / tt61 / tt62 / tt64 re-run: all pass; the mutant "join keeps first paragraph's props even for a whole deleted paragraph" is killed.
  - spelling patch → tt59 / tt60 spelling suites pass; mutant "struck letters split words again" is killed; a misspelt visible word across struck letters is still reported once and fixable.
  - refusal rollback → the UI modal-shortcut test (Ctrl+Z / Ctrl+Y after a refusal).

## J. Stopping
- Stopped when: the theorem in A held for all 8 tests and 73 verified random sessions (7 refused unchanged), 19/20 mutants killed (1 equivalent, explained), e2e-tt65 2/2, and the full gate: 1163 passed / 1 failed (e2e-tabletop toggle timing, known flake) / 1 crashed (e2e-tt41: EADDRINUSE on its fixed port 41892 during the gate run); both re-run green (15/15, 4/4). Ledger: 380 features, tests 1178/1178, failingTouch 0.
- Not pursued this tier (budget): x14 conditional-format output for the Spreadsheet and tests for the built-but-untested rows — carried to TT66.
