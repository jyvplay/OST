# TT66 — Excel 2010 (x14) conditional formatting on save (FF-50) + the IN-01 mouse / wheel contract made real

## Runtime honesty
- **Used:**
  - bash sandbox, Node 22 + tsc, the Next 16.2.6 production build, Playwright 1.64.1 with headless Chromium 143 (DevTools-protocol input for real mouse Back / Forward presses and wheel notches), embedded Postgres 17.10;
  - Python 3.11 with lxml and openpyxl (test-only); the ECMA-376 transitional XSDs (`scripts/oracle/ooxml_xsd.py`);
  - **new, test-only:** Microsoft's published [MS-XLSX] Appendix A schemas (x14 / xm / x15 …), fetched by `scripts/oracle/fetch-msxlsx-xsd.sh` from the copy in github.com/maxprograms-com/OpenXLIFF at a pinned commit. They are not committed and never shipped.
- **Not available:** Excel, LibreOffice, any Office open or repair check; Firefox (its line-mode wheel was never observed here). Nothing here claims Excel opened these files. The stand-ins are:
  - the MS-XLSX schema plus structural oracle;
  - the ECMA XSDs;
  - openpyxl;
  - our reader's round trip.
- **Sources:**
  - [MS-XLSX] §2.6 (x14 conditional formatting: x14:cfRule / dataBar / iconSet / cfIcon, xm:f, xm:sqref; child order fixed by the Appendix A schema).
  - Wheel deltas:
    - MDN "WheelEvent: deltaMode" (2026): check deltaMode, never assume pixels.
    - normalize-wheel notes: Win Chrome 100 px per notch, Win Firefox 3 lines.
    - Mozilla bug 1057252: Firefox 3 lines vs Chrome 100.
    - Mozilla intent-to-ship / statecraft-israel PR #528: Firefox ≥ 88 reports lines only when deltaMode is read before deltaY.
    - mokuro-reader PR #277: Firefox converted notch ≈ 102.4 px.
    - MultiBlog PR #32: Chromium/Linux ≈ 53 px.
  - Pointer Events spec: cancelling pointerdown suppresses the compatibility mouse events (mousedown / mouseup).
  - No spreadsheet or input code was read or borrowed; the OpenXLIFF repository was used only as a carrier of Microsoft's XSD files.

## A. Formal model
- **Rule placement.** For a rule r, x14(r) = cfX14Xml(r) ∈ {⊥, (xml, id, linked)}; main(r) = cfRuleXml(r) ∈ {"", xml}. Written form:
  - x14 = ⊥ → main only;
  - linked → main with `<extLst><ext {B025F937…}><x14:id>id</x14:id>` plus the x14 rule;
  - ¬linked → x14 only;
  - x14 = ⊥ and main = "" → not written. This cannot happen for a modelled rule.
- **x14 is required when:**
  - a bar carries axis, negative colour, border, solid fill, axis colour, autoMin / autoMax, or a carried x14 id;
  - an icon set is outside MAIN_ICON_SETS, or has custom icons;
  - a formula (af / bf / formula) or, new in TT66, a cfvo value of a bar or icon set contains "!" outside string literals (cross-sheet). Such rules are x14-only, and a bar then carries its own `<x14:fillColor>`, priority, stopIfTrue and showValue.
- **Patch invariants** (worksheet part after patchXlsx):
  1. Every `<x14:conditionalFormattings>` validates against MS-XLSX.
  2. The worksheet extLst is the last child.
  3. Each `<x14:id>` resolves to exactly one x14 rule.
  4. x14 ids are unique (case-blind).
  5. Priorities are unique across both schemas.
  6. No 2007 formula is cross-sheet.
  7. Rules that already exist and are unchanged are byte-identical.
  8. read(patch(O, W)).condFormats ≡ W.condFormats (model fields).
  9. patch(P, read(P)) leaves the sheet part unchanged.
- **Ext reuse.** The CF ext is located by URI, compared case-blind. Its container is found by local name, whatever prefix binds the x14 namespace. New `<x14:conditionalFormatting>` elements declare xmlns:x14 / xmlns:xm themselves, so they are namespace-correct inside any spelling.
- **Ids.** usedIds = every cfRule id plus every `<x14:id>` left after removals. A carried id that is already used (a duplicated rule) is dropped and a fresh stable GUID is minted. A changed rule keeps its id, because its old x14 half was removed first.
- **IN-01.**
  - px(e) = Δ · f(e.deltaMode): f(0) = 1, f(1) = 100/3, f(2) = surface height; deltaMode is read first.
  - Guard: buttons 3 and 4 have their default cancelled on mousedown / mouseup / pointerup / auxclick in the capture phase, with no stopPropagation and no pointerdown.

## B. Hypotheses
- **H+ (confirmed):**
  1. Every added x14 rule kind (axis bar, 3Stars, 5Boxes reversed and icon-only, custom icons, cross-sheet expression / cellIs, cross-sheet icon and bar thresholds) is written in the form Excel 2010+ uses. Invariants 1–6 hold (oracle) and invariant 8 holds (reader).
  2. On an Excel-written file with an x14 ext, the ext is reused and Excel's own blocks stay byte-identical.
  3. One notch from three input kinds pans the same distance ±10%.
  4. The shell guard keeps the session alive on mouse Back / Forward.
- **H− (refuted, then fixed):**
  1. "The patch writer saves app-added CF faithfully" was false. x14-only icon sets were dropped, x14 bar properties lost, and cross-sheet rules written into the 2007 schema. The pre-TT66 writer scored 0/8 on the new suite.
  2. "The reader models every rule the writers emit" was false for x14-only data bars. They were kept verbatim but invisible, so a cross-sheet-threshold bar vanished on reopen.
  3. "IN-01 is built" was false. src/lib/input.ts was imported by nothing, and a mouse Back press on the desktop navigated the tab away (e2e on the pre-TT66 build: "back over the wallpaper left the page").
  4. "normalizeWheel is right" was false. It used 48 px per line, so a Firefox notch counted 144 px against Chromium's 100.
  5. "Cancelling every navigation-capable event is safe" was false. With pointerdown cancelled, Files' own Back / Forward stopped working (verified with a mutant build; see G).
- **H∂ (partly):** an unset bar axis and "none" draw identically. The x14-only reader canonicalises "none" to unset; linked bars keep "none", so they keep their x14 link on re-save.

## C. Frontier (what is still not Class A here)
- Our reader recognises only the literal x14: / xm: prefixes inside x14 rule content (what Excel writes). The patch writer extends a foreign-prefix container correctly, but the reader would not model rules spelled with another prefix. They are kept verbatim.
- Colour scales with formula thresholds are kept verbatim, not modelled. A scale is never re-emitted with a cross-sheet threshold.
- The panel authors bars with min / max bounds; automatic bounds (autoMin / autoMax) come only from imported files.
- No Excel open check; Firefox's real line-mode wheel was not observed here (constructed WheelEvents only).
- IN-02 (learn my mouse) and IN-03 (layout map) remain unused code. Their rows stay untested.

## D. Negative shapes tested (≥ 15)
1. File with no extLst → the extLst is created as the last child (oracle "extLst last").
2. File with Excel's x14 ext → exactly one CF ext and one container; Excel's blocks are verbatim.
3. Ext URI spelled with lower-case "407d" (Excel) vs the upper-case spelling → still reused (mutant "URI case-sensitive" killed).
4. Foreign prefix `a:conditionalFormattings` → extended in place, never a second container (second-order finding).
5. Prefixed SpreadsheetML (`x:worksheet`) → `x:extLst` / `x:ext` / `x:conditionalFormatting`; x14 names untouched.
6. Changed imported linked bar → same id, no orphan x14 rule, no dangling link.
7. Duplicated rule carrying a used id → fresh id.
8. Unchanged re-save of a patched file → sheet part identical (no duplicate x14 rules).
9. Removing one added x14-only rule → exactly that rule gone.
10. Cross-sheet icon threshold with `gte="0"` → x14 cfvo keeps gte.
11. Cross-sheet bar threshold plus border → x14-only bar with fillColor before borderColor (schema order; the mutant swapping them is killed).
12. Oracle negative controls, each caught: wrong x14 child order, missing xm:sqref, duplicate id, dangling link, cross-sheet 2007 formula, extLst not last.
13. **Modal-shortcut test:** Delete / Backspace / letters / Ctrl+Z / Enter / Escape in the new band-icon select, Icon set select, Bar axis select and colour input never edit or clear the grid cell, and Enter in a select never adds a rule.
14. Mouse Back / Forward over the wallpaper (real CDP presses) → the page stays; without the guard (pre-TT66 build) it navigated away.
15. Positive control: on a page without the shell, a CDP Back press does navigate, so test 14 is not vacuous.
16. Files: Back / Forward still navigate the pane's own history with the guard on.
17. Page-mode wheel on a zero-height surface → never a zero scroll.

## E. Mechanism-distinct approaches considered (≥ 6)
1. **Write only 2007 rules in the patcher and document it** (the TT59–65 state). Rejected: it loses data.
2. **Re-serialise the whole worksheet with the full writer when CF changes.** Rejected: loses everything the full writer doesn't model, which is the opposite of a lossless save.
3. **Splice x14 XML as text into the serialised part.** Rejected: blind to prefixes, existing ext and extLst position.
4. **Tree patch reusing the full writer's `cfX14Xml`.** Chosen: one rule serialiser for both writers, with structural placement in the parsed tree.
5. **A separate `<ext>` per added rule.** Rejected: MS-XLSX has one CF ext per worksheet; Excel merges them, but other readers may read only the first.
6. **Mint ids from Math.random.** Rejected: non-reproducible bytes. Stable FNV GUIDs with a collision loop instead.
7. **Wheel: count notches from the legacy wheelDelta (±120).** Rejected: deprecated, absent in some engines, and still needs the deltaMode path.
8. **Mouse guard per surface (the Files pattern everywhere).** Rejected: every new module would need to remember it. One capture-phase shell guard instead.

## F. Artifacts
- **Code:**
  - src/lib/formula/xlsx-patch.ts: CF block, x14 emission and ext placement;
  - src/lib/formula/xlsx.ts: cfX14Xml cross-sheet thresholds and x14-only bars; reader `x14Bar` plus the x14-only data bar loop; exports;
  - src/components/modules/Spreadsheet.tsx: CF panel x14 options; bar label fix;
  - src/lib/input.ts: wheelPx, PX_PER_LINE, normalizeWheel fix, useMouseNavGuard;
  - Shell.tsx, Whiteboard.tsx, Tabletop.tsx.
- **Oracles:** scripts/oracle/xlsx_x14.py, scripts/oracle/fetch-msxlsx-xsd.sh.
- **Tests:** scripts/tt66-sheet-x14-patch.mts (9), scripts/tt66-sheet-mutants.py (18), scripts/e2e-tt66.mts (3), scripts/tt66-input.mts (2), scripts/e2e-tt66-input.mts (4).
- **Register:** src/db/seed-data/features-tt66.ts (FF-50, FF-29 note, IN-01 correction); SEED 3.52.0.
- **Gate:** scripts/run-all.sh now includes the TT65 suites, which TT65 forgot to register, and the TT66 suites.
- **Screenshot:** docs/screens/tt66-sheet-x14-cf.png.

## G. Second-order adversary
- **Attack on the x14 patch:** an existing CF ext whose container is bound to a different prefix. The first version looked up `x14:conditionalFormattings` literally and would have added a second container to the same ext. Fixed with a local-name lookup; a test and a mutant (killed) cover it.
- **Attack on the IN-01 guard:** the obvious guard cancels every event that can navigate, pointerdown included. Per the Pointer Events spec that suppresses the compatibility mouseup, and Files navigates on mouseup. A mutant build with pointerdown cancelled was run in the real browser: the tab stayed, but Files stayed in Documents after Back. The shipped guard leaves pointerdown alone.
- **Attack on the oracle:** six injected defects, all caught (D12). The positive control on Excel-written x14 blocks gives zero problems, so the oracle is neither hollow nor over-strict.

## H. External verification
- **x14 blocks:** Microsoft's own schemas, run by lxml, not by our code. Only two basic types are aliased in a shim (ST_Xstring, ST_Guid, which ECMA keeps in the sharedTypes namespace).
- **Whole worksheet:** ECMA-376 XSDs. openpyxl opens every written file.
- **Mouse buttons:** real presses through Chromium's input pipeline (CDP), with a positive control.
- **Not verified:** Excel opening the files; Firefox's wheel.

## I. Repair + attack on the patch
- **Repairs:**
  - the patch writer's x14 output;
  - the reader's x14-only bars;
  - the cross-sheet thresholds in both writers;
  - the bar label that said "(negative axis)" for axis "none";
  - normalizeWheel's line size;
  - the IN-01 wiring;
  - the missing TT65 gate registration.
- **New attacks aimed at these patches:** G1 (prefix), G2 (pointerdown) and the 18 mutants, all killed after one test gap was closed. The gap: the fillColor-order mutant survived until the x14-only bar in the test got a border.

## J. Stopping
- Stopped when:
  - all invariants in A held in 9/9 unit tests;
  - 18/18 mutants were killed;
  - e2e-tt66 passed 3/3, tt66-input 2/2 and e2e-tt66-input 4/4;
  - the regression suites stayed green (tt59-x14-cf, tt49, tt47, tt46-patch, tt62-schema, tt57, tt58, tt63-pivotparts; e2e-tt47 / 49 / 59);
  - the full gate (156 suites, now including the TT65 suites) scored 1195 passed / 1 failed, 0 crashed.
    - The failure: e2e-tt28 "embed control (SM-04)" timed out waiting for the Spotify frame, a known flake. Rerun alone: 7/7.
- Ledger: 381 features; tested full 221 (was 219), untested 88 (was 89); tests 1196/1196; failingTouch 0. Tails unchanged (full 9 / partial 10 / none 20).
- Not pursued this tier (budget):
  - wiring IN-02 / IN-03;
  - the remaining built-but-untested rows (WM-11, SH-06, WM-13, LN-04, SC-05 …);
  - wheel mutants;
  - oracle handling of malformed XML (it currently raises instead of reporting).
