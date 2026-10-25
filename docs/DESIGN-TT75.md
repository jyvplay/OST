# TT75 — Spreadsheet tables class A, recalculation memo, FF-10 EPUB reader (Books) class A

## Runtime honesty

**Used:**
- Node 22 (`--experimental-strip-types`), tsc, eslint, and Next 16.2.6 (production build plus `next start`).
- Playwright 1.64.1 driving Chromium 143 (@sparticuz) against that server.
- Embedded PostgreSQL 17.10.
- A Python 3.11 venv with the independent oracles, all test-only and never shipped:
  - openpyxl (MIT);
  - lxml (BSD) driving the ECMA-376 transitional XSDs and the EPUB OPF oracle.

**Corpora** (cloned at test time, not in git):
- Apache POI test-data (Apache-2.0);
- W3C `epub-tests` (W3C licence);
- IDPF `epub3-samples` (CC-BY-SA content, used only as test input).

**Not available:**
- Excel, LibreOffice, EPUBCheck (needs Java), and Apple Books / Thorium / Readium;
- Firefox and Safari, phones, theorem provers, parallel agents.

"Class A" below therefore means ordinary-app grade on these measurable corpora with independent oracles. It does not mean "verified in Excel" or "certified by EPUBCheck".

The sandbox was reset mid-turn. The environment was rebuilt from npm and PyPI, the corpora were re-cloned, and every gate was rerun after the reset.

## A. Formal model

### Excel tables (FF-58)

**The object.** A table is the tuple `(name, sheet, r0..r1, c0..c1, headerRows ∈ {0,1}, totalsRows ∈ {0,1}, columns[], filter?)`. Its structured references `T[...]` resolve against that geometry.

**Structural edit.** `insertDelete(axis, at, count)` either:
- refuses before any mutation (`TableEditError`), or
- maps every table to new geometry and rewrites every formula.

**Rules** (sources: Microsoft support pages and the community reports cited in session notes):
- Inserting at or before `r0` shifts the table. Inserting inside it grows the table, staying above the totals row.
- A column insert inside the table adds the lowest free `ColumnK` name.
- Deleting a band:
  - full coverage removes the table, and its references become `#REF!`;
  - partial coverage clamps the edges, and deleted columns' references become `#REF!`;
  - deleting the totals row sets `totalsRows = 0`.
- Refused: deleting the header row alone, and any edit that changes more than one table's interior.

**Success predicate.** For every corpus table:
- ∀ allowed edits: the probes follow the invariants, and both the new package and the in-place save carry the new geometry (openpyxl reads it back).
- ∀ refused edits: nothing changed.

**Adjacent problems not substituted:** calculated-column auto-fill on insert, slicers, query tables, and evaluation of non-value filters.

### Recalculation memo (FF-59)

**Invariant.** Within one pass every cell goes WHITE → GRAY → BLACK exactly once. So a range materialisation that met no GRAY cell is final for the rest of the pass.

**Mechanism.** The memo key is the resolved `sheet, c0, r0, c1, r1, full shape`. Callers receive copies, never the cached array. Blank masks are memoised the same way.

**Success predicate.** Memo-on ≡ memo-off for every cell of every workbook. The counted resource is wall time per pass.

### EPUB (FF-10, FF-60, FF-61)

**Objects.**
- An OCF container (zip, entries stored or Deflate only);
- the package document (the first rootfile with the OPF media type);
- spine, manifest, nav or NCX.

**Information model.** Only container resources are ever loaded, as blob: URLs. Remote resources are never fetched.

**Success predicate per W3C test:**
- the book opens, or errors where the test requires it;
- the per-test predicate holds.

The three corpus gates are listed under "Class A criteria and results" below. Media overlays and scripting tests are declared n/a.

## B. Outcome space (as decided by evidence)

| Hypothesis | Verdict |
|---|---|
| **H+ tables** | Accepted. T1/T2 corpus gates pass. |
| **H∂ tables** | Calculated columns are not auto-filled into an inserted row (Excel does fill them). Table bodies whose formulas read their own position (INDIRECT / OFFSET / ROW / COLUMN, e.g. a running counter `=INDIRECT("A"&ROW(…)-1)+1`) legitimately change value when a row is inserted, so T2 compares their shape only. |
| **H+ EPUB reading** | Accepted. |
| **H− EPUB** | Media overlays and EPUB scripting are not provided. Book scripts are deliberately never run, a design decision. |

## Class A criteria and results

| Gate | Result |
|---|---|
| tt75-office | 17 / 17: T1–T5, N1–N12 |
| T1 | 29 workbooks, 61 tables, 4,022 structured formulas keep their values after reopening; openpyxl agrees on all 61 tables; 61 parts are XSD-valid |
| T2 | 214 edits, 90 justified refusals, 59 header deletes refused, 162 packages read back by openpyxl. In-place packages of originals openpyxl cannot read even untouched are skipped for the openpyxl check (LIBRE_OFFICE-128382-0, a `Fill` TypeError); they are still XSD-checked |
| tt75-epub | 31 / 31: W1, W2, W3, C1–C6, N1–N22 |
| W1 | 206 W3C tests = 111 predicate, 66 generic, 3 render, 24 n/a, 2 expected error |
| W2 | 45 IDPF books, 2,984 documents, 1,711 rewritten references, 3,316 TOC entries; no handler, no remote src, no live external href |
| W3 | 251 books vs the lxml oracle, 0 disagreements |
| e2e-tt75-books | 16 / 16: real Chromium, B1–B16 including the visual screenshots |
| tt75-mutants.py | 19 / 19 killed |
| unit / integration | 23 / 23 and 25 / 25 |
| Full regression gate | see the PR section; it was run after all changes |

## D. Negative space (result shapes that look right but are not)

1. Tables written, but the structured formulas left in UI form (`[@Col]`). Excel rejects them. Caught by T1's file-form check.
2. Tables written without escaping `_xHHHH_`. Names round-trip wrongly. Caught by T5 and mutant T4.
3. Header-only delete allowed. Mutants T1 and T1b, plus N12, which calls the model directly.
4. Totals row "deleted" but `totalsRows` still 1. Mutant T2.
5. Removed table still referenced by name. Mutant T3.
6. A reference-like table name accepted (`R1C1`, `A1`). N11 and mutant T6.
7. Foreign filter XML kept verbatim, which allows injection. N7 and mutant T7.
8. A memo that freezes a range read mid-cycle. With SUM the error is contagious, so the bug is invisible; only error-ignoring readers (COUNT, AGGREGATE 6) expose it. N9 was strengthened after the first version let mutant R1 survive.
9. A memo keyed without the column. N9 and mutant R2.
10. `ROWS(#REF!) = 1`. N10 and mutant R3.
11. EPUB reader that "works" because the frame runs book scripts. B4 and mutant E2.
12. External link sanitised but kept live (`href=https:`). E5, plus `safe()` over 2,984 documents.
13. Consent prompt that silently auto-cancels. `askForm` with no fields resolved `null` at once. Found in the browser; fixed with `askConfirm`.
14. **The modal shortcut: a consent question that starts focused on OK.** Pressing Enter (or a held key) consents without reading. Detected by B4 step 1: the question must focus Cancel, and Enter right away must open nothing.
15. Book CSP meta left beside ours. Not exploitable (policies only add restrictions), but it breaks blob: images. N21 and mutant E6.
16. Roll layout "stacked", but every part at least one stage tall, because `scrollHeight` is never less than the viewport. B12 measures heights.
17. Spreads that pair pages but put RTL pages on the wrong side. N22 and mutant E8.
18. A file deep link that "opens", but a restored window with the same id swallows it. B14.

## E. Approaches considered (mechanism-distinct)

1. **Engine memo by resolved address with a cycle guard.** Chosen. Proved by differential N9 and kill-checked by mutants.
2. **Incremental dependency graph** (recompute only dirty cells). Larger change, not attempted. An insert/delete still needs a full pass under the current architecture.
3. **Lookup index (hash per column per pass) for VLOOKUP/MATCH.** Would cut the remaining per-lookup scan. Deferred; 0.63 s is already interactive.
4. **Opaque-origin sandbox plus `postMessage` link bridge** for EPUB frames. Rejected: blob subresources from the parent are blocked in opaque origins, and srcdoc HTML parsing breaks XHTML.
5. **`allow-scripts` plus CSP `script-src 'none'`.** Rejected: `allow-scripts` with `allow-same-origin` lets a script that slips through remove the sandbox.
6. **Server-side EPUB → HTML conversion.** Rejected for reading, because it loses fixed layout, spreads and fonts. Kept only for Peek text extraction, which now uses the verified core and falls back to the lenient legacy reader at grade C for non-conformant files.

## Fixed this tier (with the evidence that found them)

| Fix | Evidence |
|---|---|
| Range memo: StructuredRefs-lots-with-lookups.xlsx full recalc 49.9 s → 0.63 s | T2 needed tens of minutes; CPU profile showed range materialisation (`get` 38.6%, `isBlank` 28%) |
| ROWS / COLUMNS propagate a non-reference error | T2 probes after table removal |
| Shell window-id collision after reload swallowed opened files | Screenshot during the Books e2e |
| Contents clicks lost: `TocList` was a component declared inside render, so it remounted on every render | B2 |
| EPUB external links consent never shown (`askForm` with no fields auto-cancels) | B4 |
| External links kept a live href | B4 review |
| Roll heights | B12 |
| Book CSP metas dropped | N21 |
| Books lint: refs written during render | eslint |
| Integration zip fixture: real CRC-32 | The verified core checks CRCs |
| Five TT75 table pre-existing bugs (see the PR section) | T1 |

## Remaining blockers / limits (TT75)

- **Tables:**
  - calculated columns are not auto-filled into inserted rows;
  - slicers and query-table refresh are absent;
  - custom/top-10/dynamic/colour filters are kept but not evaluated.
- **Recalc:** no incremental dependency graph; lookups still scan linearly per call.
- **EPUB:**
  - media overlays and EPUB scripting are n/a by design;
  - remote resources are never loaded, even with consent;
  - vertical writing in paginated mode falls back to scrolled;
  - very wide windows give long lines in paginated mode;
  - EPUBCheck was not run (no Java);
  - no other reading system was compared;
  - W3C roll books (27–30 MB) exceed the VFS store limit, so the roll e2e uses a built book.
- **Never tested here:** Excel, LibreOffice, Firefox, Safari, mobile.
