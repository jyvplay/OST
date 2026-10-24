import { F, type SpecRow } from "./row";

/**
 * TT66 register additions + changes. USER-DIRECTED EXTENSION ROW (Class A Spreadsheet): the TT65 ledger's Spreadsheet gap
 * was that conditional formats ADDED in the app were saved in the Excel 2007 schema only — on a lossless save x14-only icon
 * sets (3Stars, 3Triangles, 5Boxes, custom icon mixes) were dropped, data bars lost their Excel 2010 properties and
 * cross-sheet rules were written where the 2007 schema cannot carry them. TT66 also corrects IN-01, whose register entry
 * said "one hook consumed by every surface" while src/lib/input.ts was imported by nothing.
 */
export const tt66Features: SpecRow[] = [
  F("FF-50", "FF", "Spreadsheet Excel 2010 (x14) conditional formatting is authored and saved: the panel adds data bars with a negative axis / negative colour / solid fill / border, all 20 icon sets incl. 3Stars / 3Triangles / 5Boxes, custom icon mixes and icon-only display; lossless save and export write the x14 half (linked or x14-only) into the worksheet extLst, cross-sheet rules and thresholds included",
    "A", "P2", "src/lib/formula/xlsx-patch.ts (CF block: added rules get X.cfX14Xml; the worksheet extLst / CF ext / x14:conditionalFormattings are reused or created, prefix-aware) + xlsx.ts (cfX14Xml: cross-sheet cfvo → x14-only bars / icon sets, x14 fillColor, stopIfTrue; reader: x14-only data bars) + Spreadsheet CF panel",
    "A rule is written exactly as Excel 2010+ writes it: a data bar with x14 properties keeps a 2007 <cfRule> fallback that links to its <x14:cfRule> by <x14:id>; x14-only icon sets, custom icons and any rule whose formula or threshold refers to another sheet live only in the worksheet extLst. The existing CF ext is reused (its URI compared case-blind, the container found by local name whatever prefix binds the x14 namespace), Excel's own x14 rules stay byte-identical, a changed rule keeps its x14 id, a duplicated one gets a fresh id, priorities stay unique across both schemas and the extLst stays the worksheet's last child. Disclosed: the reader still recognises only the literal x14: / xm: prefixes for x14 rule CONTENT (what Excel writes); colour scales with formula thresholds are kept verbatim but not modelled.",
    "built", "tt66-sheet-x14-patch.mts (9 vs the independent lxml oracle xlsx_x14.py — Microsoft's published MS-XLSX Appendix A schemas for every x14 block + structural rules — plus the ECMA-376 XSDs and openpyxl; positive control: Excel-written x14 blocks in two corpus files validate; 6 negative controls caught; 0/8 against the pre-TT66 writer); tt66-sheet-mutants.py 18/18; e2e-tt66.mts (panel → drawn → Save → both oracles → reopen draws the same; modal-shortcut test)"),
];

const UP: Record<string, { note: string; test: string; route?: string }> = {
  "FF-29": { note: "TT66: Excel 2010 rules added in the app are saved with their x14 half on lossless save and export (FF-50).", test: "tt66-sheet-x14-patch.mts; e2e-tt66.mts" },
  "IN-01": {
    route: "src/lib/input.ts: useMouseNavGuard (Shell, every page) + wheelPx / normalizeWheel (Whiteboard pan, Tabletop wall pan); FilesPane keeps its own Back / Forward history",
    note: "TT66 correction: until TT66 this file was imported by nothing (the row was 'built' on paper only). Now the shell cancels the navigation default of mouse buttons 3/4 in the capture phase (mousedown / mouseup / pointerup / auxclick — never pointerdown, which would suppress the mouseup Files navigates on), and wheel deltas are converted by deltaMode (read first) with a line = 100/3 px so one notch is ~100 px in Chromium and Firefox alike.",
    test: "tt66-input.mts; e2e-tt66-input.mts (real CDP Back / Forward presses: positive control navigates a plain page; desktop stays, Files still goes back / forward; Whiteboard wheel: pixel notch = 3 lines ±10%, page mode = canvas height)",
  },
};

export function patchTT66(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
