# TT68 — empty cells vs empty text, error constants, *IF criteria (FF-52) + a modal Paste Special

## Runtime honesty

Used: the bash sandbox, Node 22 + tsc, Next 16.2.6 production build, Chromium 143 headless through Playwright 1.64.1,
embedded Postgres 17.10, and the Python 3.11 venv (lxml, openpyxl) as independent oracles. Test corpus: Apache POI
test-data (353 .xlsx, Apache-2.0), used for tests only. Web sources were read with the search tool (Microsoft's
function reference pages; ablebits, exceljet, MrExcel, Stack Overflow as secondary sources).

Not available, so NOT claimed: Excel / LibreOffice. Excel was never run. The strongest Excel evidence here is the
**cached results Excel wrote into the corpus files** (26 946 formula cells), which our code did not produce. The
LibreOffice oracle suite (`oracle-formula.mts`) cannot run because `soffice` is missing; it is not in the gate.
No Firefox / Safari, no theorem provers.

## A. Formal model

A cell position p is in one of three states: **empty** (no input, no spilled value), **empty text** (value `""`:
a formula returning `""`, or the constant input `'`), or **valued**. Values alone cannot tell the first two apart
(both read as `""`), so every argument that comes from a reference carries a mask `blank(p)`:

- `toArg(ref | range)` → `{ value, blank }`, where `blank[i][j] = value[i][j] === "" ∧ isBlank(cell)`. `isBlank` is
  the engine's existing predicate: no input and not covered by a spill.
- Computed arrays and `{…}` constants → `blank ≡ false`, because their `""` elements are values:
  `COUNTA({"",1}) = 2`, `COUNTA(FILTER(…,""))` counts it.
- Reference forms (OFFSET / INDEX / INDIRECT / structured / 3-D) are resolved to a ref / range by `evalCall` before
  `toArg`, so they get the same mask. An unresolved multi-area union keeps the TT67 guess.

Functions (Microsoft definitions):

- `ISBLANK(x) = blank(x)` for a reference, FALSE for any computed value.
- `COUNTA = |{p : ¬blank(p)}|`.
- `ISTEXT(empty) = FALSE`, `ISNONTEXT(empty) = TRUE`, `TYPE(empty) = 1`.
- `COUNTBLANK` counts empty cells AND empty text.

Criteria `c(v, blank)`, one matcher for COUNTIF / SUMIF / AVERAGEIF / SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS / MINIFS:

| criterion | matches |
|---|---|
| error value or error literal (`#N/A`, `=#N/A`) | error cells with that code |
| `<>#N/A` | everything except that error |
| `""` | empty cells and empty text |
| `"="` | empty cells only |
| `"<>"` | every non-empty cell |
| wildcard (`*`, `?`, `~` escapes) with nothing / `=` / `<>` | text values only, never numbers or empty cells |
| numeric comparison | numbers and numeric text; an empty cell, `""` or a boolean is not 0 / 1 |

Two further rules:
- `"<>x"` is TRUE for everything not equal to x, including error cells.
- An error cell matches nothing else, and never makes the function fail.
- A criterion that refers to an empty cell means 0 (Microsoft COUNTIFS remarks); `Z1&""` matches empty cells (exceljet).
- `*IFS` ranges of different sizes → `#VALUE!`.

Constants: `parseLiteral(s) = error(code)` when `upper(trim(s))` is one of ECMA-376 ST_CellError's 7 literals.
`textInput` therefore quotes such text (`'#N/A`), so text still round-trips as text.

File mapping:
- **Reader:** a string cell (`t="s"` with a valid integer index, or `inlineStr` with an `<is>`) whose text is `""` →
  input `'`. Every other shape is unchanged; see D.
- **Writer:** input `'` → shared string `""`.
- **Lossless patcher:** untouched cells keep their original `<c>`; an edited `'` cell → `<c t="inlineStr"><is><t/></is></c>`.

**UI.** While Paste Special is open the grid accepts no keys except Escape (close) and Tab, and focus moves into the
panel when it opens.

## B. Hypotheses

- **H+ (confirmed):** the TT67 engine was wrong on Microsoft's own definitions. The 27-case table, run on the TT67
  tree (git 8646947), gives 13 wrong results: `COUNTA(A1:A4)` 1 instead of 3; `ISBLANK` TRUE for `=""` and for `'`;
  `ISTEXT(empty)` TRUE; `TYPE(="")` 1; `COUNTA({"",1})` 1; and more.
- **H+ (confirmed, found by the held-out probe):** an error anywhere in a criteria range made COUNTIF / SUMIF /
  COUNTIFS return that error. The TT67 engine gets 26 of the 30 criteria cases wrong. Excel's cached
  `COUNTIF(AA7:AA13, 1/0) = 1` exposed it.
- **H+ (confirmed, found by the held-out probe):** typed / stored error literals were text, so `ISNA(#N/A cell)` was
  FALSE and `LEN(#NUM! cell)` was 5. Excel's cached values disagree; now they agree.
- **H+ (confirmed):** constant empty-text cells exist in real files. There are 6 190 of them in 8 corpus workbooks,
  per the lxml oracle; TT67 dropped all of them.
- **H− (refuted):** "an inlineStr cell without `<is>` is empty text". 52348.xlsx has 137 `<c t="inlineStr"></c>`
  cells; lxml and the ECMA reading say no value, so the reader now says no value too. My first version kept them and
  the count gate (6 327 vs 6 190) caught it.
- **H− (refuted):** "a constant `t="str"` with `<v></v>` is empty text". Excel writes `str` only with `<f>`; lxml
  reads no value. Reverted to no value.
- **H∂ (open, disclosed):** whether criterion `5` matches the text `"5"`. Not source-confirmed, so left as it was.
- **H+ (confirmed by a UI test):** Paste Special was not modal. Delete / Backspace cleared the selected cell behind it.

## C. Frontier (what is still not Class A here)

- Paste Values of a formula returning `""` still writes nothing. Excel writes empty text; not changed this tier.
- The criterion `5` vs text `"5"` question above.
- Excel itself was never run. The corpus cached values are the oracle, and they cover the functions the POI test
  workbooks use.
- 652 of the 26 946 corpus formula cells still disagree with Excel's cached value (26 294 agree). They predate
  TT68 and are not caused by it (0 regressions). They were NOT triaged this tier, so their causes are unknown.

## D. Negative shapes tested (≥ 15)

Reader, with lxml's verdict on each (tt68-blank "hostile / edge cell shapes", 18 shapes):

1. sst index `<v></v>` → no value (TT67: string #0 via `Number("")`)
2. negative index `-1` → no value (openpyxl's Python `sst[-1]` would return the LAST string; the oracle guards it)
3. out-of-range index → no value
4. fractional index `0.5` → no value
5. `inlineStr` without `<is>` → no value
6. constant `str` with `<v></v>` → no value
7. constant `str` without `<v>` → no value
8. styled `<c s="0"/>` → blank
9. formula with cached `""` → formula, not a constant
10. `t="e"` constant → error value
11. sst text `#N/A` → TEXT `'#N/A`, not an error
12. rich-run sst entry with all-empty runs → empty text
13. index with surrounding spaces → empty text
14. `<is/>` → empty text
15. `<is><t/></is>` → empty text
16. empty rich run inside `<is>` → empty text

Engine:

17. `#bogus` / `#SPILL!` typed stay text
18. `" #NUM! "` with spaces → error
19. `#n/a` lowercase → `#N/A`
20. `ISBLANK("")` literal → FALSE
21. `COUNTIFS` with mismatched ranges → `#VALUE!`
22. `SUMIFS` target / criteria size mismatch → `#VALUE!`
23. `a~*b` matches only the literal asterisk
24. criterion referring to an empty cell → 0, not blank

**Modal-shortcut test (e2e-tt68-sheet):** with Paste Special open, typing `zz`, Delete and Backspace never edit the
grid behind it. This holds with focus inside the panel AND with the grid re-focused programmatically (the backstop).
Escape closes only the panel, and the Spreadsheet stays open.

## E. Mechanism-distinct approaches considered (≥ 6)

1. **Per-element blank mask on arguments (chosen):** no change to the value type; computed arrays are explicit.
2. A distinct BLANK sentinel value flowing through the evaluator. It exists internally for spills, but propagating it
   into ~339 functions would change every arithmetic path (`A2+0` must stay 0). Rejected as too wide.
3. Evaluate ISBLANK / COUNTA lazily on the AST (inspect the reference node). Works for direct refs, misses
   OFFSET / INDEX results and ranges inside other functions. Rejected.
4. Store empty text as a special input marker other than `'`. Rejected: `'` is already Excel's quote prefix and the
   engine's existing "literal text" input, so no new state.
5. Keep two criteria implementations (core + extension library) and patch both. Rejected: they had already diverged
   (the extension one turned error objects into `"[object Object]"`). One matcher now serves all eight functions.
6. Make Paste Special a real `role="dialog"` overlay with a focus trap. Deferred: the inline panel layout is the
   current UI/UX (kept per the standing constraint). The grid guard plus focus-in gives the modal behaviour without
   a redesign.
7. Infer Excel behaviour from the PyPI `formulas` oracle. Rejected for these semantics: it evaluates array constants,
   not grid cells, so it cannot tell empty cells from empty text.

## F. Artifacts

- Code:
  - `src/lib/formula/engine.ts` (blankMask, toArg, callExt mapping, parseLiteral error constants)
  - `src/lib/formula/functions.ts` (blankAt, COUNTA / ISBLANK / ISTEXT, makeCriteria + critOf + cellsOf;
    AVERAGEIFS / MAXIFS / MINIFS in the core table)
  - `src/lib/formula/xlsx.ts` (keepText, inlineStr / sst guards, writer)
  - `src/lib/formula/xlsx-patch.ts` (empty inline string)
  - `src/components/modules/Spreadsheet.tsx` (modal Paste Special)
- Tests:
  - `scripts/tt68-blank.mts` (8 tests)
  - `scripts/tt68-heldout.mts` (held-out probe)
  - `scripts/tt68-blank-mutants.py` (29 mutants)
  - `scripts/e2e-tt68-sheet.mts` (3 UI tests)
- Oracle: `scripts/oracle/xlsx_values_lxml.py --empty-text` (new mode; index guard).
- Register: `src/db/seed-data/features-tt68.ts` (FF-52 new; FF-19 / 20 / 21 / 27 / 28 patched), SEED 3.54.0.
- Screenshot: `docs/screens/tt68-sheet-blank.png`.

## G. Second-order adversary

`tt68-blank-mutants.py`: 29 plausible bugs, each re-introduced in turn.
- The first run of 28 killed 26.
- Survivor 1, "reference forms not resolved before masking", was an equivalent mutant. `evalCall` already resolves
  them, so the line in `toArg` was dead code; it was removed, and the mutant now targets the real resolution (killed).
- Survivor 2, "numeric criteria see an empty cell as 0", had no guarding case. I sourced the semantics
  (`COUNTIF(range,"<>0")` counts blank cells: MrExcel MVP thread, excelinsider) and added `"<>0"` and `"<=0"` cases
  (killed).
- A 29th mutant guards the empty-criterion-cell rule.
- Final: **29/29 killed**.

## H. External verification

| Oracle | Result |
|---|---|
| Excel's cached results, 26 946 corpus formula cells | TT67 26 287 agree, TT68 26 294, **0 regressions**. All 7 changed cells now equal Excel: `COUNTIF(AA7:AA13,1/0)`, `IF(AA11,1)`, `ISBLANK(E7)`, `ISNA(AA13)`, `ISTEXT(B34)`, `LEN(AA12)`, `LOWER(AA8)` |
| lxml (`--empty-text`) | the exact set of constant empty-text cells in the 8 corpus workbooks (6 190), in our writer's output, and in the patched file |
| openpyxl | reads the writer's `''` cell as a string, and the saved error cell as data type `e` |
| Whole-corpus differential vs the TT66 reader (tt67-sheet-ns) | the only new difference is the kept empty-text cells in exactly the 8 listed workbooks |

## I. Repair + attack on the patch

Repairs (within the ~1/10 budget):
- the modal Paste Special key leak, found by this tier's modal-shortcut test;
- error cells failing *IF functions, found by the held-out probe.

Attacks aimed at the patches:
- **Modal fix:** the e2e re-focuses the grid while the panel is open and sends Delete / Backspace / a character
  (the backstop path), then checks Escape still closes the panel only. e2e-tt59 (Paste Link through the same panel)
  still passes, 4/4.
- **Criteria rewrite:**
  - the held-out probe was rerun after each change (0 regressions each time);
  - 17 spreadsheet suites were rerun (all pass);
  - the 7 hostile `<v>` index shapes target the reader guard added with it.
- **Test-environment slip:** overwriting `/tmp/tt67-before` with the wrong baseline made tt67-sheet-ns fail 4 tests.
  It was diagnosed as the test environment, not the code, and the baseline was restored before any test was changed.

## J. Stopping

Stopped after FF-52 reached its acceptance criteria with external oracles (Microsoft definitions, Excel cached
values, lxml, openpyxl), 29/29 mutants, and a UI e2e. Paste Values of `""` and criterion `5` vs `"5"` are listed in
C rather than guessed. The full gate result and ledger are recorded in docs/LEDGER.md and the PR section.
