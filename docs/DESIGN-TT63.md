# TT63 — Spreadsheet PivotTables saved as real Excel PivotTables (pivotTable / pivotCache / records parts)

## Runtime honesty
- **Used:**
  - bash sandbox, Node 22 + tsc, the Next 16.2.6 production build, Playwright 1.64.1 with headless Chromium 143, and embedded Postgres 17.10;
  - Python 3.11 with lxml, openpyxl and pandas (all test-only);
  - the ECMA-376 transitional XSDs from TT62;
  - the Apache POI test corpus. Seven of its workbooks contain native PivotTables; 5 are used here: 54436, 64450, DataTableCities, ExcelPivotTableSample and WithChartSheet (43 native tables kept byte-identical).
- **Not available:** Excel, LibreOffice, or any Office open/repair check.
  - Nothing here claims Excel opened these files.
  - Verification uses three independent substitutes: XSD validity, a pandas recomputation, and openpyxl's own pivot parser.
- **Sources:**
  - ISO/IEC 29500-1 §18.10 (pivotTableDefinition / pivotCacheDefinition / pivotCacheRecords), read via Microsoft Learn's Open XML SDK class pages. These carry the normative text.
  - MS-XLSX §2.2.4: the x14 pivotField extension `{2946ED86-A175-432A-8AC1-64E0C546D7DE}` with `fillDownLabels`.
  - No pivot-writer code was read or borrowed. ClosedXML, EPPlus and POI were seen only as forum snippets that confirm the extension URI.

## A. Formal model
- **Source.** A table T has a header h[0..n) and records r[0..m), including all-blank rows (Excel caches every row of the source range).
- **Cache C(T).**
  - There is one cacheField per column. Fields used on an axis or as a filter (set F) get sharedItems S_f.
  - S_f holds the distinct values of column f under the key κ: blank, error code, number, boolean, or **lower-cased** text. The order is first occurrence, and each item keeps the caption of its first occurrence. This is the same identity the engine's cache uses (`keyOf`).
  - Records: r_i ↦ ⟨x(S_f, κ(r_i[f])) for f ∈ F, otherwise the literal value⟩.
- **View V(def).**
  - Field roles: rows R (≤3), columns K (≤2), values D (≤6; an empty D means Count of R[0] or K[0]), filters Φ: f ↦ include-set.
  - Page fields are P = dom Φ ∖ (R ∪ K).
  - Item visibility: vis_f(s) = label(s) ∈ Φ(f), and not (s = blank ∧ blank occurs only in all-blank rows).
  - Displayed records are those with vis_f for every f in dom Φ, after dropping all-blank rows. Excel keeps those rows, but every one of their items is hidden unless the blank also occurs elsewhere.
- **Totals (§18.10.1.73, normative).**
  - `rowGrandTotals` = the Grand Total **column**, shown only when K ≠ ∅. `colGrandTotals` = the Grand Total **row**, shown only when R ≠ ∅.
  - Column subtotals exist only with |K| ≥ 2, so every K field gets `defaultSubtotal="0"` because the engine draws none.
  - R fields get `defaultSubtotal = spec.subtotals`.
- **Layout (tabular).**
  - location.ref is the computed grid at the anchor.
  - firstDataCol = max(|R|, 1); firstDataRow = header rows.
  - firstHeaderRow = colHeaderStart when K ≠ ∅, else 0 when |D| > 1, else 1.
  - Σ Values is field −2 at the end of colFields when |D| > 1.
- **Page area.** Rows anchor−|P|−1 … anchor−2 in columns c₀ and c₀+1, plus one blank row. Every cell there must be empty or hold exactly "field | item / (Multiple Items)". Otherwise the result is ⊥, meaning the pivot is saved values-only and the reason is reported.
- **Lossless ownership predicate.** Ours(t) holds iff a definition d loaded from this file has the same (sheet, name) as t, and t still has rowFields = d.R, colFields∖{−2} = d.K, dataFields.fld = d.D and worksheetSource.ref = d.ref.
  - The tables that are Ours are regenerated in place, keeping their part names and cacheId when the cache's reference count is 1.
  - ¬Ours tables are never written to.
  - A deleted Ours table drops its table part, its rels, its sheet rel and its override. Its cache goes when the reference count reaches 0: the records, the cache rels, the overrides, the `<pivotCache>` element and the workbook rel.

## B. Hypotheses
- **H+ (confirmed):** for every engine-valid def whose page area fits, the parts are XSD-valid, and pandas, given only (XML, source cells), recomputes exactly the saved cells.
  - Evidence: 13 hand shapes and 58 random tables, 8,750 cells in all; openpyxl load → save → load keeps the fields.
- **H+ (confirmed):** lossless save keeps native pivots byte-identical (5 POI workbooks, 43 native tables) and regenerates ours in place.
- **H− (refuted, i.e. real defects found and fixed):**
  1. **Page area vs. the UI caption.** The Spreadsheet UI already writes Excel's caption "Flag | (Multiple Items)" at anchor−2. The first page-area rule called that cell "user data" and refused every UI pivot that had a report filter. The e2e found it.
     - Fix: a cell is accepted when it equals the expected caption. A wrong caption is still refused, and both cases are tested.
- **Defensive (not a defect observed in practice):** a part name that an existing relationship points at, even a dangling one, must never be chosen for new parts.
  - Every rel target seen in sheet, table and cache rels is claimed. Test 10 and a mutant cover it.
- **H∂ (not decidable here):** whether Excel renders our location attributes without a "repair" prompt before refreshOnLoad runs. Only Excel can answer that, so it is disclosed.

## C. Frontier (what is still not Class A here)
- No Excel open check; PR-11 stays partial.
- rowItems/colItems are omitted. They are optional, and Excel rebuilds them on refresh.
- With several value fields **and** column fields, our grid has no "Column Labels" caption row, so Excel's refreshed layout is one row taller.
- No number formats on dataFields.
- A filter on an *axis* field is written as hidden items, but the UI also writes a caption for it at anchor−2, which Excel would not show. It's harmless text.
- Still open from earlier tiers:
  - **Spreadsheet:** conditional formats added in the app use the 2007 schema; Paste Link writes absolute references only.
  - **Writer:** spelling fixes in stories are not tracked; tracked column operations are refused.

## D. Negative shapes tested (≥ 15)
1. Report filter with no room above (anchor row 0): values-only, with the reason.
2. A page area holding user data: values-only.
3. A page area holding the *wrong* caption: values-only.
4. A filter that hides every item: values-only.
5. A "(blank)" item that only comes from all-blank rows: hidden (mutant killed).
6. Case twins "Apple" and "apple": one shared item.
7. Duplicate headings "Key" and "key": cacheField names become "Key" and "key2".
8. Mixed-type field (number, text, blank): `containsMixedTypes`.
9. Error values (=NA()) in the data and as items.
10. Text longer than 255 characters: `longText`.
11. Native table with the same name on the same sheet: ours becomes "Name (2)".
12. A table re-pivoted outside the app: treated as native and never overwritten.
13. A cache shared with another table: not rewritten; ours moves to a new cache.
14. A dangling records relationship: its target is never reused.
15. Deleting a pivot: no part, rel, override or `<pivotCache>` left behind.
16. An unchanged save stays byte-identical even with pivot parts present.
17. **Modal-shortcut failure test** (argued from the existing assertions; no separate run): a "pivot = values only" shortcut, i.e. not writing parts, fails every oracle assertion on table counts. A "pivot = copy the cells into the cache" shortcut is killed by the pandas recomputation, which uses only the XML semantics.

## E. Mechanism-distinct approaches considered (≥ 6)
1. **Values plus hidden names only** (TT58). Rejected: Excel sees no pivot.
2. **One shared cache per source range** (Excel's default). Rejected for now: it needs union sharedItems and cross-table ownership in the patch writer. One cache per table is valid per ECMA.
3. **Compact form** (Excel's default). Rejected: the engine's grid is tabular, so compact would change the cells under the table.
4. **Writing rowItems/colItems.** Deferred: they are optional, Excel rebuilds them, and more state means more drift.
5. **Regenerating every pivot part on every save.** Rejected: churn, and it would destroy native and edited tables.
6. **Ownership by name only.** Rejected: an Excel re-pivot would be silently reverted. The field-signature check is mutant-tested.
7. **Writing page fields wherever the filter is**, ignoring geometry. Rejected: Excel would draw over user data.

## F. Artifacts
- `src/lib/formula/pivotxml.ts`: parts from a PivotDef, `pageAreaProblem`, `uniquePivotName`, `relTarget`.
- `src/lib/formula/xlsx-pivotpatch.ts`: the lossless pivot patcher.
- Wiring:
  - `xlsx.ts`: fresh export, with a report argument;
  - `xlsx-patch.ts`: the `<pivotCaches>` book and the rels flag;
  - `route.ts`: returns `pivots`;
  - `Spreadsheet.tsx`: status and values-only warning, plus the panel hint.
- `pivot.ts`: `keyOf` is now exported.
- `scripts/oracle/xlsx_pivot.py`: the pandas semantic oracle (`--fusion-only`), with three documented openpyxl workarounds:
  1. value-equality cache de-duplication;
  2. the records `_id` being set after its rel is written;
  3. `localSheetId` numbered over worksheets only.
- `scripts/tt63-sheet-pivotparts.mts` (10 tests) and `scripts/e2e-tt63.mts` (2 tests); screenshot `docs/screens/tt63-pivot-parts.png`.
- `src/db/seed-data/features-tt63.ts`: FF-47; FF-21's stale "no pivot parts" limit is replaced; SEED 3.49.0.

## G. Second-order adversary
- Could the oracle share the writer's mistakes? It reads only the XML semantics and the source cells, and recomputes with pandas groupby. It never reads our records to compute values; records are only cross-checked against the source.
- Four survivors in early mutant runs were oracle blind spots, and each got a new check:
  1. a visible blank-row item: the oracle had dropped all-blank rows itself;
  2. Σ field −2 missing;
  3. column subtotals;
  4. item order.
- openpyxl as a second parser exposed two of its own writer bugs. I patched those in the *oracle*, not by bending our output. No output was changed to suit openpyxl.

## H. External verification
- ECMA-376 XSDs pass for all three pivot content types.
- The pandas recomputation passes.
- openpyxl's pivot model (`openpyxl.pivot`) round-trips the files.
- Native POI pivots are byte-identical after our save.
- **Not available:** Excel.

## I. Repair + attack on the patch
- **Repair 1 (page area):** a new attack, "a wrong caption must still be refused", is the WrongCaption case; it passes. The mutants "any caption accepted" and "captions never accepted" are both killed.
- **Repair 2 (dangling targets):** the attack is test 10, a dangling rel to records2. The new records parts are named records3 and records4; records2 is skipped. The "not claimed" mutant is killed.
- **Mutation total:** 22/22 killed.

## J. Stopping
- Suites: tt63-sheet-pivotparts 10/10; e2e-tt63 2/2.
- 13 regression suites were re-run and all pass: names, oracle-xlsx, tt46-xlsx-patch (309 openpyxl sessions), tt47-sheet, tt49-sheet, tt50-charts, tt57-sheet-links, tt58-sheet-pivot, tt59-sheet-paste, tt59-x14-cf, tt61-sheet-pivot-delete, tt62-sheet-schema and unit.
- Full gate: see the PR body (TT63 section).
- Stopped at "pivots values-only → real parts" because the remaining pivot gaps (shared caches, compact form, number formats) need either Excel to verify or an engine layout change.
