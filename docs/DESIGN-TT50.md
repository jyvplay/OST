# TT50 — real Excel charts in the Spreadsheet (FF-29 → built), TT49 Writer repairs

Runtime used: bash sandbox, Node 22, tsc, Next 16, Postgres, headless Chromium 143 (Playwright), Python venv with
openpyxl, numpy, python-docx and lxml as **test-only** oracles. Not available: theorem provers, parallel agents,
Microsoft Office or LibreOffice, a GPU, or a real display. Nothing below claims an Excel open check or a pixel
comparison with Excel.

## A. Formal model

### Chart specification (`ChartSpec`, `src/lib/formula/sheetmeta.ts`)

`{id, sheet, range, kind, title, headerRow}` plus these optional fields:
- `grouping`, `catTitle`, `valTitle`, `trend`, `legend` and `blanks`;
- `series[]` of `{name?, nameRef?, cat?, val, catCache?, valCache?, color?, trend?}`;
- `anchor {c0,r0,c1,r1}`, `src` (the original chart part) and `note` (what the model cannot represent).

`kind` is one of bar, hbar, line, area, pie, doughnut or scatter. `grouping` is clustered, stacked or percent.

### Four functions over the specification

- **Read:** `readSheetCharts(zip)` → `ChartSpec[]`. It works from drawing relationships to `graphicFrame` to the chart
  part.
- **Data:** `chartDataFor(wb, spec)` → `{categories, series}`.
  - References are resolved live against the workbook.
  - When a reference cannot be resolved (defined names, external workbooks), the stored cache is used instead.
- **Draw:** `buildChartSvg(kind, title, data, w, h, opts)` → an SVG string, shown via `<img src=data:>`, which keeps it
  script-inert.
- **Write:**
  - New workbooks use `chartSpaceXml` and `drawingXml`.
  - Edited originals go through `patchCharts(io, wb, before, after, renames)`.
    - Charts are matched by `src`.
    - The change key is `chartKey` (kind, title, grouping, axis titles, trend, legend, blanks, series).

### Invariants

- **K1, untouched means byte-identical:** if no chart changed, the package bytes equal the original.
  Otherwise only the touched chart and drawing parts, their relationships and `[Content_Types].xml` change.
- **K2, references stay valid:** every chart part is referenced by exactly one drawing relationship, and every
  referenced part exists with an Override.
  - Delete removes the frame, the relationship, the part, the part's own relationships and its Override.
- **K3, rename consistency:** after a sheet rename, every `c:f` that named the old sheet names the new one, matched
  case-insensitively and with quoting.
- **K4, bounded input:** reading is capped at 255 series, 20,000 points, 200 charts and 600-character references.
  An over-long reference is dropped, never truncated.
- **K5, Excel trendline rules:** trendlines exist only on clustered 2-D bar, column, line, area and scatter charts.
  Every fit agrees with least squares (numpy) to 1e-6 relative.

## B. Hypotheses

**H+ (supported by evidence):**
- openpyxl reads the same type, direction, grouping, series references, trendlines, titles, axis titles and anchors
  for 30 charts in 25 corpus workbooks, with 0 mismatches.
- New-workbook export of every corpus chart is read back identically by openpyxl and by our reader.
- The patch writer keeps the unchanged bytes. The edits are visible to openpyxl and the other charts are unchanged
  (24 workbooks, 36 charts).
- All six trendline types match numpy on 120 datasets.

**H− (would falsify):** any reader mismatch, any surviving mutant, any non-chart part changing on a patch, or the UI
reaching the grid from the chart panel. None remains. Two mutants survived at first; see §I.

**H∂ (not decidable here):** whether Excel draws our charts as it draws its own (styles, fonts, exact tick choice).
openpyxl validates the structure, not the rendering.

## C. Frontier

These are the shapes the model cannot represent. Each one is noted in `spec.note` and kept or degraded as stated:
- 3-D charts are drawn flat.
- Combo charts draw only their first type. openpyxl shows the same limit.
- Radar, stock and surface charts are drawn as lines. Bubble charts are drawn as scatter without sizes.
- Only the first trendline per series is kept.
- Multi-level categories use the innermost level.
- Chartsheets reopen as worksheets.
- Zero-series charts are dropped (56557).
- 65016 (`x:`-prefixed workbook.xml) is unreadable.

## D. Negative shapes (22, plus the modal-shortcut failure test)

**Tested in `tt50-charts`:**
1. A ptCount of 10⁹.
2. 400 series, capped at 255.
3. External relationship targets.
4. Targets escaping the package with `../../..`.
5. Malformed chart XML.
6. Drawings without charts.
7. 10 MB caches.
8. Mixed-case rels part names (123233; openpyxl itself sees 0 charts here).
9. Defined-name series, which fall back to the cache.
10. Over-long references in persisted JSON, which are dropped.
11. Unknown chart kinds.
12. Bad `src` paths (absolute or `..`).
13. Polynomial order and moving-average period out of range, which are clamped.
14. All-equal x values in a trend fit (refused with a message).
15. Logarithmic or power trends with x ≤ 0, and exponential trends with y ≤ 0.
16. Mixed-sign 100 % stacking.
17. Blanks as gap, zero or span.
18. Nameless series, which must not become "Series 1".
19. Precision loss when writing caches.
20. Renaming a sheet that charts reference.
21. Clearing a title, which needs `autoTitleDeleted`.
22. Absolute OPC targets.

**Modal-shortcut failure test** (`e2e-tt50-charts`): Delete, Backspace, typing and Ctrl+Z inside the chart panel never
touch the selected grid cell.

## E. Approaches (mechanism-distinct)

1. **Differential reader:** openpyxl, a separate parser written in Python.
2. **Numeric oracle:** numpy polyfit/lstsq for the trendlines.
3. **Round trips:** our writer to openpyxl, and our writer to our reader.
4. **Byte-identity and part-diff checks** on patched packages.
5. **Mutation testing:** 12 mutants across chartxml, chartpatch, sheetmeta, trend and xlsx (`scripts/tt50-mutants.py`).
6. **Real-UI e2e** in Chromium 143: import, edit, save, the openpyxl check and the modal shortcut.
7. **Visual inspection** of the e2e screenshots, which found the layout defect in §I.

## F. Artifacts

**Source:**
- `src/lib/formula/chartxml.ts` (read/write), `xlsx-chartpatch.ts` (surgical patch) and `trend.ts` (fits).
- Changes to `sheetmeta.ts`, `xlsx.ts` and `xlsx-patch.ts`.
- The Charts panel in `Spreadsheet.tsx`.

**Tests:**
- `scripts/tt50-charts.mts` (10) and `scripts/e2e-tt50-charts.mts` (5).
- `scripts/tt50-mutants.py`.
- Oracles: `scripts/oracle/xlsx_charts.py` and `scripts/oracle/trend_np.py`.

**Results:** `docs/test-results/tt50-charts.json` and `e2e-tt50-charts.json`.

## G. Second-order adversary (attacks on the evidence itself)

- **Shared bug with the oracle?**
  - openpyxl has known quirks: it resolves rels case-sensitively and reports only the first type of a combo. Its
    auto-title detection relies on a lone empty run.
  - Where it is blind, those files move to our own semantics test, with explicit expected values from the XML. They
    are not counted as agreement.
- **Is the patch test too weak?**
  - A mutant analysis found two gaps: (a) clearing a title never flipped `autoTitleDeleted`, and (b) absolute targets
    were never exercised.
  - Both tests were added, and both mutants are now killed.
- **Renderer tests checking too little?**
  - The 100 % stacking test used only positive values, so Σv = Σ|v|.
  - The hbar test checked bars but not labels.
  - Both were strengthened, and both mutants are now killed.
- **e2e passing for the wrong reason?**
  - The screenshots were inspected and showed the grid squeezed to 2 rows and the chart clipped.
  - The redesign was verified again by screenshot (6 rows visible, nothing clipped).

## H. External verification

- openpyxl 3.1, numpy and lxml are independent implementations.
- The POI corpus (Apache-2.0) supplies real Excel-written charts.
- No Excel was available, so PR-11 (an Office open check) stays partial.

## I. Repair (≤1/10 budget), with an attack on each patch

1. **Chart panel squeezed the grid (UI v1):** cards are now two columns (a 212 px controls column beside a 420×220
   chart) in a 266 px panel.
   - Attack: screenshots of the import and trend states. 6 grid rows are visible, and the controls and chart are
     unclipped.
2. **e2e-tt49-writer undo test:** `Home` on a wrapped paragraph moves to the visual line start. The test now uses
   `Control+Home`.
   - Attack: a diagnostic run confirmed that typing lands at the caret, so this was not a product bug.
3. **Two mutant survivors:** the tests were strengthened (§G).
   - Attack: each mutant was re-run against the new test and is KILLED.
4. **Carried from TT49:** the caret regression, the dangling relationship and the in-place `sectPr` (see
   DESIGN-TT49 §I).
   - Attack: e2e-tt46 8/8, e2e-tt49-writer 6/6 and the 12 Writer mutants.

## J. Stopping

Stopped when the reader differential reached 0 mismatches, the mutants were all killed, the regression subset was
green and the screenshots were clean.

**Not attempted this tier (disclosed):**
- Chart styling edits (colours and fonts) beyond the series colour read.
- Secondary axes.
- Data labels.
- Pivot charts.
