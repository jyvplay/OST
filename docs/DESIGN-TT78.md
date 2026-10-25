# TT78: Spreadsheet outlines + Subtotal (FF-64), table calculated columns + auto-expansion (FF-65), Photoshop documents to class A (FF-08)

## Runtime honesty

**Used:**
- Node 22, tsc, eslint, Next 16.2.6 (production build), Playwright 1.64.1 with Chromium 143, embedded PostgreSQL 17.10.
- Test-only Python oracles:
  - openpyxl (MIT), as both an independent **reader** and an independent **writer**;
  - pandas (BSD) for groupby;
  - lxml with the ECMA-376 transitional XSDs.

**Corpus:** Apache POI test-data xlsx (353 files). Not in git.

**Not available:** Excel and LibreOffice. Microsoft's documented behaviour is used as the specification, cited where it applies.

## A. Formal model

### Outlines (`src/lib/formula/sheetoutline.ts`)

The model is per axis:
- **Levels:** λ: line → 1..7.
- **Collapsed set:** K, a set of summary lines.
- **Summary placement:** σ ∈ {after, before}, from `outlinePr summaryBelow` / `summaryRight`.

A **group** at level L is a maximal run [s, e] with λ ≥ L. Its summary line is e+1 (σ = after) or s−1 (σ = before). The file stores exactly λ, K and `hidden`, so every operation is defined on those:

| Operation | Effect |
|---|---|
| `collapse(G)` | Hide G's lines; add the summary to K. |
| `expand(G)` | Remove the summary from K. Show G's lines **except** those inside a nested group whose summary is in K (Excel keeps nested collapsed groups collapsed). Never show rows the AutoFilter hid. |
| `level(n)` | λ ≥ n hidden, λ < n shown; groups at level ≥ n are collapsed. |
| `group` | λ += 1, refused past 7 (Excel's eight levels include the summary level). |
| `ungroup` | λ −= 1. Hidden lines stay hidden (Microsoft: "detail rows or columns may remain hidden"). K entries that no longer head a group are dropped. |
| Insert / delete | Levels and K move with their lines. Inserted lines take min(λ(at−1), λ(at)), so inserting inside a group joins it and inserting at its edge does not. |

**Subtotal** inserts, bottom-up, one row per run of equal keys (compared case-insensitively):
- the label is "<key> Total" (or Count, Average, …), set in bold;
- each chosen column gets `=SUBTOTAL(fn, range)`;
- then a "Grand Total" row over the whole list, which ignores nested SUBTOTAL cells;
- outline: detail rows level 2, subtotal rows level 1, grand total level 0.

**Remove All** deletes the rows holding SUBTOTAL formulas inside the list and clears its outline.

**Auto Outline** is a declared heuristic: a formula aggregating an adjacent single-column (or single-row) block forms a group, and nested spans nest.

### Calculated columns (`src/lib/formula/sheettablecalc.ts`)

`TableDef.calc[column]` is the formula of the **first body row**. Every corpus file agrees with this, e.g. table A3:G9 stores `AVERAGE(B4:F4)`. Body row R holds `calc` shifted by R − firstBody.

After one typed entry, in the same undo step:

| Rule | Behaviour |
|---|---|
| F1 | A formula typed into an otherwise-empty column fills the column. |
| F2 | A formula typed into a consistent calculated column refills it. |
| F3 | A formula typed over existing data fills nothing (a status note stands in for Excel's AutoCorrect offer). |
| E1 | A constant typed into a calculated column is an exception; `calc` is kept. Clearing the last value drops `calc`. |
| X1 | Typing directly below a table (no totals row, not inside another table) grows the table and fills the new row. |
| X2 | Typing directly to the right grows it by a column named from the header text, or ColumnK. |
| S1 | Structural edits re-anchor `calc` through a body row that survives the edit. Inserted body rows are filled. |

### File and UI

- **xlsx:**
  - row and col `outlineLevel` / `collapsed`;
  - `sheetPr/outlinePr`;
  - `sheetFormatPr outlineLevelRow` / `outlineLevelCol`;
  - `<calculatedColumnFormula>` (array formulas are kept verbatim and not modelled).
  - This holds in both the new-package writer and the in-place patcher, which keeps bytes for anything unchanged.
- **UI:**
  - gutter bars, plus ± buttons on summary lines;
  - level buttons in the corner;
  - toolbar: Group, Ungroup, Show/Hide detail, Subtotal, Remove subtotals, Auto outline, Clear outline;
  - Alt+Shift+→/← to group/ungroup;
  - a Rows/Columns question when the selection is not whole rows or whole columns.

The small outline buttons have full-size toolbar equivalents (Show/Hide detail), which falls under the WCAG 2.5.8 "equivalent control" exception.

## B. Hypotheses

- **H+:** files written by Excel and openpyxl read identically; our writes read identically in openpyxl.
- **H−:** expanding a parent must not reveal nested collapsed groups or filter-hidden rows; Subtotal must not count nested subtotals.
- **H∂:**
  - corpus `outlineLevelRow="0"` matches carry no levels (only 4 corpus sheets have real levels, hence O3);
  - hostile attribute values;
  - 16384-column `<col>` spans.

## C. Frontier

The sheet engine has no incremental dependency graph, and all of this sits on top of the existing table model.

## D. Negative shapes (`tt78-sheet.mts` N1–N18) plus the modal-shortcut test

- **N1–N18:**
  - the 8th level is refused;
  - every outline command fails cleanly with no outline;
  - hostile `outlineLevel` / `collapsed` values are ignored;
  - a 16384-column `<col>` is bounded;
  - untrusted JSON outline and calc input is filtered;
  - an array `calculatedColumnFormula` is not modelled;
  - expand never shows filter-hidden rows;
  - Subtotal is refused inside a table;
  - Subtotal argument errors leave the sheet unchanged;
  - no growth under a totals row or into another table;
  - unrelated entries change nothing;
  - F3 leaves every other cell alone;
  - Auto Outline ignores non-adjacent references;
  - out-of-range level buttons clamp;
  - Remove All without subtotals does nothing;
  - deleting outlined rows drops their levels and flags;
  - inserting at a group edge does not extend it;
  - deleting all but one body row keeps `calc`.
- **Modal shortcut (`e2e-tt78-sheet` 2):** while the Rows/Columns question is open, Alt+Shift+→ neither groups nor opens a second question. Escape groups nothing.

## E. Approaches (mechanism-distinct)

1. Excel-written corpus files read against openpyxl's reading (O1, O2).
2. openpyxl-**written** files read by Fusion, and Fusion's patch read back by openpyxl (O3).
3. pandas recomputation of Subtotal (M2).
4. Hand-derived Excel behaviour tables (M1, M3).
5. ECMA-376 XSD validation of both writers (R1, R2, O3).
6. The JSON/undo round trip (R3).
7. A real browser driving real clicks and keys, with the saved file checked by openpyxl (`e2e-tt78-sheet`).

## F. Artifacts

- `docs/test-results/tt78-sheet.json` and `e2e-tt78-sheet.json`
- `docs/screens/tt78-sheet-outline.png` and `tt78-sheet-calc.png`
- `scripts/tt78-mutants.py`
- `docs/tt78-render-differential.json` (full PDFium differential summary)

## G. Second-order adversary

`scripts/tt78-mutants.py` applies 17 plausible wrong implementations. **All 17 are killed.** The first run had two survivors:

1. Case-sensitive Subtotal keys survived because the data never had adjacent keys differing only in case. The data now does ("North", "north").
2. One mutant was syntactically invalid and crashed the suite. The runner now reports crashes as INVALID instead of counting them as kills.

## H. External verification

| Check | Result |
|---|---|
| O1 | 28 corpus files contain `outlineLevel`; every sheet Fusion opens agrees with openpyxl. Files Fusion refuses under its hostile-input limits are listed separately in the test detail rather than counted as agreeing. |
| O2 | 8 files with calculated columns: every corpus calculated column reproduces every cell formula Excel wrote. |
| O3 | The openpyxl writer and Fusion agree in both directions. |

## I. Repair, and an attack on the patch

Repairs this turn:
- the TT77 page-clip regression (see DESIGN-TT77 §G), now covered by C17 and its mutant;
- e2e expectations that were wrong in the test, not the app (grand-total row 12; the North group is level 2).

## J. Stopping and remaining gaps

- Subtotal: summary-below only, no page breaks.
- Auto Outline is heuristic.
- Renaming a table header drops its `calc`.
- Paste and fill do not trigger calculated columns (Excel's AutoCorrect doesn't either).
- No slicers and no query refresh.

---

# Part 2: Photoshop documents (FF-08) to class A, the "one other core feature"

## Runtime honesty

- **Oracles:**
  - psd-tools 1.26 (MIT): its numpy compositor, reader and writer;
  - Chromium 143's Skia `globalCompositeOperation` for the 16 modes canvas implements.
- **Not available:** Photoshop. Where psd-tools comments cite Photoshop-verified behaviour (vivid light, hard-mix ties), we follow psd-tools; we did not observe it ourselves.

## A. Model

### Clipping masks

- A layer with `clip` paints only through its **base**, the nearest non-clipped layer below it.
- The clipped layers composite onto the base's own colour, seeded with the base's pixel coverage a₀.
- The base keeps its coverage and then composites with its own mask, opacity and blend.
- A hidden base, or one at 0 opacity, hides the whole clipping group. A clipped layer with no base paints as an ordinary layer.

### Groups (`Layer.groups`, outermost first)

Adjacent layers sharing a group id form the group:

| Group type | Compositing |
|---|---|
| **Pass-through** | Children paint onto a copy of the backdrop; the result is A + (B − A) × opacity. |
| **Isolated** (any other blend) | Children paint onto transparent; the result composites as one layer with the group's blend and opacity. |

A hidden group paints nothing. Nesting is up to 16 levels, matching the reader's cap.

### Blend modes: 26 of Photoshop's 27

- 12 W3C separable modes.
- 4 non-separable modes: W3C §10.2 SetLum / ClipColor / SetSat, Lum = 0.3R + 0.59G + 0.11B.
- 10 Photoshop-only modes, using Photoshop's edge cases:
  - vivid light: the **source** extremes win;
  - hard mix: a tie at Cb + Cs = 1 resolves by Cb > ½;
  - darker / lighter colour: choose the whole pixel by Lum.
- Dissolve is shown as normal and reported, because its output is random noise by definition.

### PSD

- Section dividers (`lsct`; 3 below the children, then folder 1 = open / 2 = closed above them) carry the group's name, opacity, visibility and blend (`pass` = pass-through).
- The clipping byte is read and written.
- A clipped layer above an empty or skipped base is hidden, since it has nothing to clip to. A clipped layer whose base would be a group is drawn unclipped and reported.

### UI and performance

- **UI:**
  - a "Clip to layer below" checkbox, disabled on the bottom layer;
  - a `clip` badge;
  - a group badge, which says "(hidden)" when the group is hidden;
  - all 26 modes in the blend select.
- **Performance:** the blend function is resolved once per layer and normal mode is inlined. On a 3000×2000, four-layer document the compositor takes 557–578 ms against 527–533 ms before.

## D. Negative shapes

- a clip with no base;
- a hidden base;
- an empty base (reader);
- clipping to a group;
- groups nested deeper than 16;
- invalid group opacity;
- an unknown group blend;
- an unsupported group blend key, composited as pass-through and reported.

## E. Mechanism-distinct checks

1. psd-tools reads our files and composites them independently (A raw / rle / zip).
2. We read files psd-tools wrote, including groups, clipping and all 26 modes, and match its composite (B).
3. Skia's `globalCompositeOperation` (e2e-image, 16 modes, |Δ| ≤ 1 opaque).
4. Hand-computed pins (image-engine).
5. Real-browser UI: clip toggle, colour mode, undo.
6. A fixture self-check that clipping actually changes the composite.

## G. Second-order adversary

The first mutant run had **two survivors**: the random fixtures put every clipped layer outside its base, so clipping was never exercised.

- The fixtures now anchor clipped layers on their bases.
- A new test asserts that clipping changes at least 50 pixels, in both psd-tools' and our composite.

`scripts/tt78-mutants.py` covers PSD with 16 mutants:
- the clipping model;
- group opacity, isolation and visibility;
- hue and saturation swapped;
- Rec.709 Lum weights;
- ClipColor;
- vivid-light edges, darker colour, linear light;
- writer clipping and pass-through;
- reader lsct and nesting.

**All 33 mutants in the file are killed** (17 sheet + 16 PSD).

## H. Results

| Check | Result |
|---|---|
| oracle-psd | 11/11; composite Δ ≤ 1/255 in α and RGB, both directions, all 26 modes plus groups and clipping |
| image-engine | 16/16 |
| e2e-image | 11/11 (Skia: hue / saturation / color / luminosity Δ ≤ 1) |
| Screenshot | `docs/screens/tt78-image-clip.png`, viewed |

## J. Remaining gaps (in the forge boundary and reported on open)

- layer effects and vector masks are not rendered;
- adjustment, fill, type and smart-object layers render from their stored pixels;
- dissolve;
- clipping to a group;
- PSB, 16/32-bit, CMYK, Lab and Indexed are refused;
- group editing in the UI is limited to keeping groups (no create or ungroup commands yet).
