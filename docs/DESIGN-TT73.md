# TT73 — Writer, Slides and Charts to class A on measurable whole-corpus gates; number formats, Unicode names, external links

## Runtime honesty

- **Ran:**
  - Node 22 with strip-types, tsc, and the Next 16.2.6 production build.
  - Playwright 1.64.1 with headless Chromium 143.
  - Embedded Postgres 17.10.
  - Python 3.11 oracles: lxml with the ECMA-376 transitional XSDs (`scripts/oracle/ooxml_xsd.py`, now including PresentationML), python-docx, python-pptx, openpyxl and Pillow (input images only).
  - The mutant runner.
- **Did not run:**
  - Word, Excel, PowerPoint or LibreOffice. "Class A" below means *ordinary-app grade on the measurable corpus*, not "verified in Microsoft Office".
  - Excel's chart renderer: the chart gate compares plotted **data** with Excel's caches, not pixels.
  - Firefox, Safari and phones.
- **No theorem prover.**
- **Oracles independent of the app:**
  - Excel's own cached formula values and chart caches (`c:numCache` / `c:strCache`), read with lxml.
  - Apache POI's `TestDataFormatter` dfUS assertions (Apache-2.0 test data, fetched through the GitHub API, used as data only).
  - The ECMA-376 XSDs; python-docx and python-pptx.

## Class A criteria (applied to FF-22, FF-23, FF-29)

A row is raised to class A only when **all** of these pass:

1. **Edited whole-corpus gate.** Every readable corpus file is edited in the app's own engine and saved, and adds no schema error that the input did not already have. Errors are compared per part, ignoring line numbers; a part that is new in the output is compared against all of the input's errors.
2. **Independent reader.** python-docx, python-pptx or Excel's caches see the edit, or the same data.
3. **Existing evidence still holds:** lossless no-edit saves and the feature suites.
4. **Disclosed limits.** Known limits are written in the row's nuance.

| Row | Gate | Result |
|---|---|---|
| FF-22 Writer | W2: 111 readable docx: text typed + header picture → save | 0 new schema errors, 0 python-docx misses, 0 re-read misses (17 damaged / encrypted fuzz files refused) |
| FF-23 Slides | P2: 83 openable decks: text box + shape + picture + notes + duplicate + layout slide → save | 0 new PML schema errors, 0 python-pptx misses (12 fuzz / truncated files refused, as python-pptx refuses them) |
| FF-29 Charts | C1: every corpus chart series vs Excel's caches | values 1,828/1,828; categories and scatter x 183/183; cached names 19/19 (36 charts, 76 series) |

FF-02 (legacy extract/convert, grade D) and FF-03 (PDF) were considered. FF-02 would need a semantic text oracle: python-docx's `.text` treats `w:ins` / `w:del` differently from Word's displayed text. That could not be made honest this turn, so FF-02 and FF-03 stay B.

## Truth check (what changed and why)

- **Spreadsheet formulas.** The held-out probe covers 26,946 Excel-cached formula cells in 330 workbooks. Agreement went from 26,295 (TT72) to **26,869** with **0 newly wrong** cells. The fixes:
  - Number formats: TEXT 300 → **806/806**; POI dfUS 120 → **163/189**.
  - Excel's numeric-argument rule (`xlNums`).
  - MODE, ROUND/TRUNC digits, PRODUCT, and the SUMX* families.
  - External workbook links (ECMA-376 §18.14) read from cached `externalLink` parts.
- **Unicode names (found by the chart gate).** A Russian workbook's `SUBTOTAL(109,Таблица1[[Sum for Q1 ]])` showed #NAME?, because the lexer's identifier classes were ASCII-only. Excel writes `Лист1!A1` and `Таблица1[Col]` unquoted, so this affected any non-Latin workbook with cross-sheet formulas. The lexer, parser and name validation now accept Unicode letters; A1 cell letters stay ASCII.
- **Writer.**
  - New: pictures (logos) in headers and footers. The relationship goes in the part's own `.rels` (OPC).
  - Found by the W2 gate: `w:type="odd"` (the WordprocessingML 2003 name for the default header) was not recognised. TT72 added a 7th header reference, which breaks the schema (maxOccurs 6). Now `odd` reads as `default`, and an edited `odd` header is re-referenced as `default`.
  - Found by the N1 negative test: a NaN picture size would have written `cx="NaN"`. Sizes are now clamped.
- **Slides.** The schema oracle skipped every PresentationML part. It now validates `pml.xsd` parts, and P1 proves that it rejects bad slides.

## A. Formal model

- **Chart gate:** for every chart part C and series s with a value reference, compare `seriesOutFor(wb, spec)[s]` with Excel's cache:
  - **Values:** for every point index k < ptCount, our value equals Excel's cached value within 1e-9 relative, or both are blank (no cached `c:pt` ⇔ null).
  - **Categories:** text-equal (numeric-equal when both parse); scatter compares per-series x values (`xs`).
  - **Names:** compared only where Excel cached them.
- **Edit gate:** for every file f, let E(f) be the schema errors of f, normalised to ignore line numbers. Then E(save(edit(f))) \ E(f) = ∅, per part, and the independent reader finds the edit.
- **Header picture invariant:** every `r:embed` in header/footer part P resolves through `rels(P)`, never `document.xml.rels`, and `xmlns:r` is in scope at the `a:blip`.
- **Excel numeric-argument rule:**
  - Inside refs or arrays, only numbers count.
  - A literal TRUE is 1; literal numeric text is coerced; other literal text is #VALUE!; errors propagate.
  - MODE rejects all literal text.

## B. Hypotheses

- **H+ (confirmed):** the 651 held-out disagreements were dominated by number formats and argument coercion, so fixing those rules would move hundreds of cells without breaking any. Result: 574 fixed, 0 newly wrong.
- **H− (refuted, then fixed):** "the corpus charts already agree". 7 of 1,828 points disagreed, all in the Unicode-table workbook.
- **H∂ (partial):** "the PML schema oracle already validated decks". It validated only rels, themes and properties; slides were skipped.

## C. Frontier

- **77 held-out cells still disagree:**
  - by kind: 30 plain expressions, 9 CELL(), 5 SUBSTITUTE, 3 SUBTOTAL, 3 SUMPRODUCT, and 2 each of ROUND, DATE, LOOKUP, REPLACE and AVERAGEA;
  - by file: mostly FormulaEvalTestData_Copy.xlsx (31), clone_sheet.xlsx (16) and 47804.xlsx (9).
- **26 POI assertions differ.** They are POI-specific behaviours rather than Excel's: `_x` and `*` trimming, serial 0 shown as 1899-12-31, invalid bracket codes, and multi-fraction handling.
- **External link values are not persisted** in the app's own JSON format (xlsx keeps them).
- **No OOXML Strict WML.** An edited canonicalised part is written canonically.

## D. Negative shapes (≥15) + modal shortcut

- **N1 (19 shapes):**
  - Header-picture MIME types: SVG, WebP, empty and text are refused.
  - Sizes 0, negative, NaN and ±∞ are clamped.
  - Markup and 10,000-character descriptions are sanitised; an empty description defaults.
  - External references: a missing book (#REF!), a missing sheet (#REF!), a missing `[0]!` name (#NAME?), and a string literal that looks like a reference (unchanged).
  - Unicode: `×Sheet!A1`, `÷1` and `😀!A1` are refused as references.
  - Names refused: one starting with an Arabic-Indic digit, `A1`, `R1C1`, and `Лист 1` (contains a space).
- **e2e-tt73-writer 2 (refusals):** an SVG and a PNG over 5 MB through the real file input each show a visible reason and change nothing.
- **Modal shortcut (e2e-tt73-writer 3):** while a header line input has focus, Ctrl+Z stays inside the input. The document's header picture stays on every page and focus stays in the panel.

## E. Mechanism-distinct approaches

1. Excel caches as the oracle for formulas (held-out probe) and charts (chart gate).
2. POI's assertion table as an outside formatter oracle.
3. XSD validation with lxml for docx and pptx edits.
4. Independent object models: python-docx and python-pptx.
5. A real-browser UI path: Playwright with file input, Undo/Redo and save.
6. Mutation testing: 15 mutants aimed at each TT73 change — 15 / 15 killed (W4 survived the first run: W1 checked the picture only after a save + re-read, not in the live session the page view draws; W1 now asserts the in-session bytes).

## F. Artifacts

- **Suites:** `scripts/tt73-office.mts` (S1–S5, C1, H1, W1, W2, N1, P1, P2) and `scripts/e2e-tt73-writer.mts` (4).
- **Probes:** `scripts/tt73-chartcache.mts` with `scripts/oracle/chart_cache.py`; `scripts/tt73-triage.mts`; `scripts/tt73-textfix.mts`.
- **Fixtures:** `docs/heldout/tt73-text-oracle.json` (806 rows) and `docs/heldout/tt73-poi-dataformatter.json` (189 rows).
- **Mutants:** `scripts/tt73-mutants.py`.
- **Register:** `src/db/seed-data/features-tt73.ts` (SEED_VERSION 3.59.0).

## G. Second-order adversary (attacks on the patch)

- **Could the Unicode classes accept things Excel rejects?**
  - The ranges are explicit letter blocks. × (U+00D7) and ÷ (U+00F7) are excluded, as are emoji and Arabic-Indic digits (N1).
  - A1 cell letters stay ASCII, so `ДА1` is not a cell reference.
- **Could normalising `odd` → `default` lose an even/first header?**
  - Only an edited default slot is rewritten; even and first references are untouched.
  - The W2 gate covers 60293.docx, which has even, odd and first header references.
- **Could the header picture break documents whose header root lacks `xmlns:r`?** W1 strips the declaration and validates the result; `xmlns:r` is declared on the `a:blip` itself.
- **Could the chart gate pass vacuously?**
  - It requires ≥36 charts and ≥1,800 points.
  - Charts with no data are excluded explicitly and counted.
  - Mutant X4 (scatter x values lost) must fail it.

## H. External verification

- No Microsoft Office.
- **External oracles:** Excel's caches written by Excel itself, POI's assertions, and the Ecma XSDs read by lxml, python-docx and python-pptx.
- The POI corpus files come from Apache POI's test-data (Apache-2.0).

## I. Repair (+ new attack aimed at the patch)

- **I1:** W2 found the legacy `odd` header reference. Repaired: read as `default`, and re-referenced when edited.
  - The new attack is mutants W5 and W6: either half reverted must fail W2.
- **I2:** N1 found NaN picture sizes. Repaired by clamping; mutant W7 attacks the repair.
- **I3:** the chart gate found Unicode table names. Repaired in the lexer, parser and names; mutants U1–U4 attack it.

- **I4 (from visual inspection, not a test):** a screenshot of a header logo showed the body heading drawn over the picture. The page view kept the body at the fixed top margin.
  - Repaired with Word's rule: the body starts at max(top margin, header distance + rendered header height), and likewise for footers (Writer relayout measures, then paginates a second time).
  - The new attack is e2e-tt73-writer 1, which asserts that page 1's body top is not above the header's bottom edge. e2e-tt49-writer (header layout) still passes 6/6.

## J. Stopping

- Stopped when every class-A gate passed with no exceptions.
- The mutants were run, the targeted suites and the full gate passed, and the ledger was regenerated (results in the PR's "## TT73" section).
- Still open:
  - the 77 held-out cells and the 26 POI-specific rows;
  - FF-02 and FF-03 at B;
  - no Strict WML;
  - no Microsoft Office verification.
