# TT49 — Spreadsheet conditional formatting (all rule types) and Writer header/footer editing

Runtime used: bash sandbox, Node 22, tsc, Next 16, Postgres, headless Chromium 143 (Playwright), Python venv with
openpyxl, python-docx, lxml and `formulas` as **test-only** oracles. Not available: theorem provers, parallel agents,
Microsoft Office or LibreOffice. Nothing below claims an Office open check.

Commits: `592ae57` (conditional formatting) and `48528aa` (headers/footers). TT50 carried three header/footer
repairs (§I).

## A. Formal model

- **Conditional formatting** (`src/lib/formula/sheetmeta.ts`, `cficons.ts`).
  - A rule is `{kind, ranges, priority, stopIfTrue, dxf | scale | bar | icons, a?, b?, formula?, …}`. The sheet
    state is an ordered list of rules.
  - Evaluation: `evalCondFormats(wb)` → a per-cell style. Rules are applied in ascending priority. `stopIfTrue`
    blocks later rules on that cell only. Scales, bars and icons are computed over the rule's whole range.
  - **Invariants:**
    - **C1:** a rule never changes a cell value.
    - **C2:** evaluation is bounded at 100,000 cells per rule and 20,000 formula cells.
    - **C3:** export of an unchanged rule keeps its original XML; a deleted data bar also removes its linked x14 rule.
- **Headers and footers** (`src/lib/office/hdrftr.ts`).
  - The final section's `sectPr` holds `headerReference` / `footerReference` (default and first page) and `titlePg`.
  - A part is a list of lines. Each line is either *editable* `{left, centre, right}` text with `{PAGE}` /
    `{NUMPAGES}` tokens, or *locked* (it holds a picture, another field or a link), and locked lines are kept verbatim.
  - **Invariants:**
    - **H1:** an untouched line keeps its exact XML.
    - **H2:** every referenced part exists and has a content type.
    - **H3:** undo restores both the references and the parts.

## B. Hypotheses

- **H+ (supported by evidence):**
  - An independent Python evaluator (openpyxl + Translator + `formulas` over Excel-cached values) agrees on
    124 rules / 7,571 cells in 19 corpus workbooks, with 0 mismatches.
  - Apache POI's TestConditionalFormattingEval assertions hold, including after edits.
  - python-docx reads every edited and added header/footer.
- **H− (would falsify):** any evaluator mismatch, a surviving mutant, or a header edit changing another part. None was observed.
- **H∂ (not decidable here):** whether Excel and Word draw these files pixel-identically.

## C. Frontier

- CF: the x14-only expression/cellIs rules are kept but not drawn. One rule the oracle cannot translate and one file
  it cannot open are excluded from the differential and reported.
- Headers/footers: only the final section is edited, and even-page headers are not authored.

## D. Negative shapes (CF 10 + header/footer 9; modal-shortcut failure tests in both e2e suites)

**Conditional formatting:**
- Blank cells in cellIs (treated as 0).
- Error cells in text rules.
- Top N % with ties.
- Above-average with σ = 0.
- Data bars where min = max.
- Icon sets with `gte="0"`.
- Percentile bounds on an empty range.
- Formula rules referring off-sheet.
- 100k+ cell ranges (skipped and reported).
- Duplicate rules across overlapping ranges.

**Headers and footers:**
- Documents without `xmlns:r`.
- Documents with no `sectPr`.
- Zip directory entries.
- Invalid XML characters.
- Header lines holding pictures or fields.
- Positional-tab three-column headers.
- Removing a header that other sections use.
- More lines than the line cap.
- The header styles part missing.

**Modal shortcuts:** in both e2e suites, Delete, typing and Ctrl+Z inside the panel never reach the grid or body.

## E. Approaches (mechanism-distinct)

1. An independent Python evaluator used as a differential oracle.
2. POI's asserted answers.
3. Documented Excel measurements (data-bar lengths, icon thresholds).
4. Mutation testing: 9/9 CF and 12/12 Writer mutants killed.
5. Real-UI e2e in Chromium.
6. A python-docx structural oracle for headers and footers.
7. Byte-identity checks on the untouched parts.

## F. Artifacts

**Scripts:**
- `scripts/tt49-sheet.mts` (10), `scripts/e2e-tt49.mts` (5) and `scripts/tt49-mutants.py`.
- `scripts/tt49-writer.mts` (9, including the TT50 undo test), `scripts/e2e-tt49-writer.mts` (6) and
  `scripts/tt49-writer-mutants.py` (12).

**Oracles:** `scripts/oracle/xlsx_cf_eval.py` and `scripts/oracle/docx_hf.py`.

**Results:** `docs/test-results/*.json`.

## G. Second-order adversary

**Attacks on the tests:**
- Could the oracle share our bugs? It is a separate language and stack (Translator + `formulas`), and it uses
  Excel's cached values, not ours.
- Could mutants pass because of the wrong `ONLY` filter? Every survivor was traced, and each one was either a wrong
  filter or a missing case, then fixed.

## H. External verification

openpyxl, python-docx, `formulas` and lxml are independent implementations. No Office application was available.

## I. Repair (TT50 carry), with an attack on each patch

1. **Caret regression:** a header/footer undo forced a full re-render (`docGen`) after the caret was restored. The fix
   adds a separate `hfGen` counter that only touches header/footer state when that state actually changed.
   - Attack: `e2e-tt46` (8/8) and the e2e undo test (6/6) type at the caret after the undo.
2. **Dangling relationship after add → undo:** writeWord now writes `dirty ∪ created` parts.
   - Attack: a mutant (killed) and python-docx on the undo-saved file.
3. **In-place `sectPr` mutation:** `editSect` is now copy-on-write and snapshots by reference.
   - Attack: a mutant that restores the in-place write is killed by the undo test.

## J. Stopping

Stopped when the differential reached 0 mismatches, every mutant was killed and the e2e suites were green.

**Disclosed limits:**
- **Headers/footers:**
  - Only the final section is edited, and even-page headers are not authored.
  - Remove leaves an orphan part, and undoing an add leaves an empty part.
  - The ptab view is approximate.
- **CF:** the x14 expression/cellIs rules are not drawn.
