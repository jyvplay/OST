# TT62 — ECMA-376 schema conformance gates for the Writer and Spreadsheet; Writer cell-merge review

## Runtime honesty
- **Used:** bash sandbox, Node 22 + tsc, Next 16.2.6 production build, Playwright 1.64.1 with headless Chromium 143, embedded Postgres 17.10, and Python 3.11 with lxml, python-docx and openpyxl.
- **New this tier:** the ECMA-376 *transitional* XML Schemas.
  - Source: github.com/python-openxml/python-docx `ref/xsd`. The repository is MIT and the schemas are Ecma's.
  - Fetched by `scripts/oracle/fetch-xsd.sh`, pinned to commit e4545460. They are test-only data and not committed.
- **Not available:** Word, Excel, LibreOffice, any Office "open and repair" check, Firefox/Safari, theorem provers.
  - So **PR-11 stays partial**. XSD validity is *necessary, not sufficient*, for Office to open a file.
  - Nothing here claims an Office open was performed.

## A. Formal model
- **Package (OPC, ECMA-376 Part 2):** a set of parts keyed by name. Names are compared **case-insensitively** (§6.2.2.3, part-name equivalence).
  - Each part has a content type from `[Content_Types].xml` (Override, else Default by extension).
  - Relationships for part *P* live in `dir(P)/_rels/basename(P).rels`.
- **Schema-validity predicate V(pkg):** for every part whose content type maps to a schema:
  1. Apply Markup Compatibility (Part 3) as a consumer that understands only the 2006 namespaces:
     - drop mc:Ignorable namespaces with their subtrees;
     - resolve mc:AlternateContent to the first understood Choice, else Fallback;
     - keep any non-ignorable unknown namespace, so it fails.
  2. The result must validate against one combined schema (wml + sml + dml + vml + shared + opc). The `xml:` namespace comes from a from-scratch `_xml.xsd`.
- **Regression predicate:** for a round trip *f(in)*, the errors E(f(in))[part] must be a subset of E(in)[part], with line numbers ignored. We don't repair broken inputs; we must not add breakage.
- **cellMerge (§17.13.5.3):** a tracked change to a cell's vertical merge.
  - Merge states are m ∈ {rest, cont, none}.
  - The marker records the revised state `@w:vMerge` and the replaced state `@w:vMergeOrig`; an absent attribute means none.
  - Accept: tcPr.vMerge := revised. Reject: tcPr.vMerge := orig. The marker is removed in both cases.
  - Where it is present, `w:vMerge` sits after cnfStyle/tcW/gridSpan/hMerge and before tcBorders/shd/…/cellIns/cellDel/cellMerge/tcPrChange (CT_TcPr).

## B. Hypotheses
- **H+ (confirmed):** the Writer's edit operations produce schema-valid packages from a valid start.
  - 144 randomized packages over 26 edit kinds, a kitchen-sink document (also tracked), the cell-revision paths, and a 113-document corpus round trip that added no new errors.
- **H+ (confirmed after fixes):** the Spreadsheet's fresh export and lossless patch produce schema-valid parts for every feature it writes.
- **H− (refuted, i.e. bugs found):**
  1. `setPageSetup` inserted `w:pgSz` at index 0 of a section that had header references but no page size. That broke the CT_SectPr order.
  2. `patchXlsx` looked up `_rels/Sheet1.xml.rels` case-sensitively.
     - POI's 123233_charts.xlsx stores `Sheet1.xml` with `_rels/sheet1.xml.rels`.
     - So adding a hyperlink created a second rels part without the drawing link. The chart patcher then appended a duplicate `<drawing r:id="rId1"/>`.
     - New sheets could be named `sheet1.xml` beside `Sheet1.xml`, a case collision that OPC forbids.
- **H∂ (partly decidable):**
  - The transitional schema makes run properties (`EG_RPrBase`) an unordered `xsd:choice`, so rPr child order cannot be judged by this oracle. The rPr-order mutant survives as an *equivalent mutant*.
  - `sml.xsd` types `<t>` as `ST_Xstring`, which forbids `xml:space`, but Excel writes it. 37 Excel-authored corpus files do so, as do LibreOffice and ONLYOFFICE files.
  - This one erratum is tolerated and counted; nothing else is relaxed.

## C. Frontier (what is still not Class A here)
- **PR-11:** there is no Office open check. The XSD gate is the substitute.
- **Writer:**
  - header/footer/note spelling fixes are not tracked;
  - tracked column operations are refused;
  - spelling is en_US only;
  - rPr order is not schema-checked (transitional choice).
- **Spreadsheet:**
  - pivots are values-only (no pivotTable/pivotCache parts);
  - app-added CF rules use the 2007 schema;
  - Paste Link uses absolute references only.
- **Oracle:** core.xml (Dublin Core) and customXml parts are not schema-checked (no schemas). lxml's entity-amplification guard rejects 54764-2.xlsx, which is not compared.

## D. Negative shapes tested (≥ 15)
1. w:pPr after a run.
2. Unknown element `w:bogus`.
3. Bad enumeration `w:jc="banana"`.
4. A non-ignorable foreign namespace.
5. A w14 attribute that is ignorable: accepted.
6. AlternateContent Fallback: accepted.
7. SpreadsheetML `mergeCells` before `sheetData`.
8. `c@t="banana"`.
9. `<bogus/>` in sheetData.
10. Sections with a header reference but no pgSz/pgMar.
11. A package with `Sheet1.xml` plus lower-case rels.
12. A package holding both `sheet1.xml` and `Sheet1.xml` (POI duplicate-filename-case-insensitive): the exact spelling must win.
13. python-docx's invalid `w:zoom` template is preserved, not counted as ours.
14. cellMerge with an absent vMerge (un-merge).
15. cellMerge with an absent vMergeOrig.
16. cellMerge beside cellIns/cellDel in the same table.
17. Mixed accept/reject decisions in forward and reverse order.
18. 17 damaged corpus .docx files are refused rather than "saved".

**Modal-shortcut failure test:** the first M2 mutant (wrong `PPR_ORDER`) **survived** the random-session test. The random sessions rarely put two paragraph properties on one paragraph, so "it's green" was a modal shortcut. The kitchen-sink test was added and now kills it. Likewise the cellMerge MM2 mutant (vMerge at the end of tcPr) survived until the fixture gave cells `shd` and `vAlign`.

## E. Mechanism-distinct approaches considered (≥ 6)
1. **XSD validation with lxml (chosen):** independent of our code, mechanical, and covers all parts.
2. Office "open and repair": unavailable here.
3. LibreOffice headless conversion: unavailable here, and it is lenient anyway.
4. Re-reading with python-docx/openpyxl: already used in earlier tiers. It is lenient, so it misses order errors.
5. A hand-written order checker per element (docx_tblrev tcpr_ok/order_ok): kept for the tables, but limited in scope.
6. Open XML SDK validator: .NET, not available in the sandbox.
7. Differential comparison of corpus input against output, both validated: used as the regression predicate.

## F. Artifacts
- **Oracles:**
  - `scripts/oracle/ooxml_xsd.py`: MCE processing, combined schema, the documented erratum, JSON CLI.
  - `scripts/oracle/fetch-xsd.sh`: pinned fetch.
  - `scripts/oracle/docx_tblrev.py`: gains `markcells … merge:NEW:ORIG` and `vmerges IN asis|accept|reject`.
- **Suites:**
  - `scripts/tt62-writer-schema.mts`: 5 tests.
  - `scripts/tt62-sheet-schema.mts`: 5 tests.
  - `scripts/tt62-writer-cellmerge.mts`: 4 tests.
  - `scripts/e2e-tt62.mts`: 3 tests.
  - `scripts/tt61-writer-cellrev.mts`: its "cellMerge refused" assertion is upgraded to "resolvable".
- **Code:**
  - `wordedit.ts`: sectPr pgSz placement; cellMerge accept/reject; pane detail.
  - `xlsx-patch.ts`: `storedName`/`realName` case-insensitive part lookup, canonical rels naming, collision-free new parts.
  - `Writer.tsx`: "Cell merge" label and detail shown for every kind.
- **Rows:** `src/db/seed-data/features-tt62.ts` adds FF-45 and FF-46, patches FF-44 (cellMerge) and adds notes to PR-11, FF-21 and FF-22. SEED 3.48.0.
- **Screenshot:** `docs/screens/tt62-writer-cell-merge.png`.

## G. Second-order adversary
- *"The oracle is green because it checks nothing."* It rejects 4 known-bad WordprocessingML and 3 known-bad SpreadsheetML shapes, and the mutants below fail it.
- *"The erratum hides real errors."* Only `xml:space` on SpreadsheetML `<t>` is removed. The count is reported, and the corpus evidence comes from Excel itself.
- *"Subtracting input errors hides regressions."* Subtraction is per part and per message. Fresh exports and blank-document sessions subtract nothing except the documented python-docx zoom defect.
- *"The case-insensitive fix breaks packages holding both spellings."* The POI fixture for exactly that case is in tt46-xlsx-patch. The exact spelling wins, and that suite is green again (309/309 openpyxl edit sessions).
- *"The cellMerge expectation is circular."* The expected grid is computed by the lxml oracle from the original file. Our output is read back by the same oracle in `asis` mode.

## H. External verification
- **Validators and readers:** lxml XMLSchema with Ecma's XSDs; python-docx opens the results; openpyxl loads the case-fixed workbook and sees all sheets.
- **Corpus:** Apache POI test data, 113 docx and 4 xlsx files patched with every feature.
- **Browser:** Chromium renders the merge as `rowspan=2` before the review, and with no span after Reject. Saved bytes are read through `/api/fs` and checked by both oracles.

## I. Repair + attack on the patch
- **Mutants killed:**
  - Writer: pPr order (after the kitchen sink was added); tcPr placed after the paragraphs; the pgSz fix reverted.
  - Spreadsheet: mergeCells after CF; dxf with fill before font; chart title with overlay before tx; the case fix reverted (2 tests fail).
  - cellMerge: accept/reject swapped; vMerge at the end of tcPr; model `Cell.vmerge` left stale.
  - **Equivalent mutant (disclosed):** rPr order.
- **Attack aimed at the patch:** the case-insensitive lookup first ran into POI `duplicate-filename-case-insensitive.xlsx`, which holds both spellings, and broke an edit session there. That led to the rule that an exact spelling wins. A second attack: openpyxl, a case-sensitive reader, could not see the hyperlink relationship. That led to rewriting the rels part under its canonical name and dropping the odd-cased original.

## J. Stopping
- Stopped after:
  - both schema gates are green, with mutants killed and the equivalent mutant explained;
  - FF-44 is complete in the model, the oracle and the browser;
  - the full gate has run (the first since TT60): 146 suites, 1131 passed and 8 failed. The failures, rerun singly:
  - **e2e-privacy:** perf flake; 14/14 on rerun.
  - **e2e-tt57:** 3/3 on rerun.
  - **tt54-meta:** the metadata corpus had been fetched one directory too deep after the sandbox reset (`fetch-meta.py` takes `…/corpus`, not `…/corpus/meta`). Fixed with links; 6/6.
  - **e2e-tabletop:** a different timing test failed on each of 3 runs, then 15/15 on the 4th.
- Ledger after TT62: 377 features. Built: full 301 / partial 54 / blocked 21 / none 1. Tested: full 216 / partial 72 / untested 89. Tests 1147/1147, failingTouch 0.
- Next candidates:
  - real pivotTable/pivotCache parts;
  - CF rules written to the x14 schema when needed;
  - tracked story spelling fixes;
  - Paste Link relative references.
