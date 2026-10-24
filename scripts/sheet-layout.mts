/**
 * Suite "sheet-layout" (TT17): merged cells, borders, data validation, frozen columns, structural repair,
 * JSON persistence hardening. Pure/headless. Expected behaviour = Microsoft Excel's documented behaviour
 * (see src/lib/formula/sheetlayout.ts header for sources and the declared interpretations).
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/index.ts";
import { workbookFromJson, workbookToJson } from "../src/lib/formula/workbook-json.ts";
import { insertDelete, sortRange } from "../src/lib/formula/sheetops.ts";
import {
  applyBorders, edgeAt, expandToMerges, invalidCells, listFormula, listItems, mergeAcross, mergeCells, parseSqref, partialMergeConflict,
  sanitizeValidation, stepCell, unmergeCells, validateEntry, adjustRange, LIST_LITERAL_MAX,
} from "../src/lib/formula/sheetlayout.ts";
import type { DataValidation } from "../src/lib/formula/engine.ts";

const { test, finish } = makeHarness("sheet-layout");
const R = (c0: number, r0: number, c1: number, r1: number) => ({ c0, r0, c1, r1 });
const dv = (o: Partial<DataValidation>): DataValidation => sanitizeValidation({ allowBlank: true, showError: true, errorStyle: "stop", ...o })!;

await test("merge keeps the upper-left most data (reading order), clears the rest, keeps covered formatting; unmerge leaves value top-left", { "FF-33": "full" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(2, 0, "second"); s.setCell(1, 1, "=1+1"); s.setStyle(2, 1, { fill: "#ff0000" });
  const r = mergeCells(s, R(0, 0, 2, 1));
  assert.ok(r.ok); assert.equal(r.ok && r.kept, "second"); assert.equal(r.ok && r.discarded, 1);
  assert.equal(s.get(0, 0)?.input, "second"); assert.equal(s.get(2, 0), undefined); assert.equal(s.get(1, 1), undefined);
  assert.equal(s.get(2, 1)?.style?.fill, "#ff0000", "covered formatting survives");
  assert.deepEqual(s.merges, [R(0, 0, 2, 1)]);
  assert.equal(mergeCells(s, R(4, 4, 4, 4)).ok, false, "single cell");
  assert.match((mergeCells(s, R(1, 1, 3, 3)) as { error: string }).error, /merged cell/, "partial overlap refused");
  const big = mergeCells(s, R(0, 0, 3, 3)); assert.ok(big.ok); assert.deepEqual(s.merges, [R(0, 0, 3, 3)], "contained merge absorbed");
  assert.equal(unmergeCells(s, R(2, 2, 2, 2)), 1); assert.equal(s.merges.length, 0); assert.equal(s.get(0, 0)?.input, "second");
  const ac = mergeAcross(s, R(0, 5, 2, 7)); assert.equal(ac.merged, 3); assert.equal(s.merges.length, 3);
});

await test("selection expands to whole merged areas (fixed point); arrow keys treat a merge as one cell; partial paste/sort refused", { "FF-33": "full" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  mergeCells(s, R(1, 1, 2, 3)); mergeCells(s, R(3, 3, 4, 4));
  assert.deepEqual(expandToMerges(s, R(0, 1, 1, 1)), R(0, 1, 2, 3));
  assert.deepEqual(expandToMerges(s, R(2, 3, 3, 3)), R(1, 1, 4, 4), "chained merges pull each other in");
  assert.deepEqual(stepCell(s, { col: 1, row: 1 }, 1, 0, 51, 999), { col: 3, row: 1 }, "leave from the right edge");
  assert.deepEqual(stepCell(s, { col: 1, row: 1 }, 0, 1, 51, 999), { col: 1, row: 4 }, "leave from the bottom edge");
  assert.deepEqual(stepCell(s, { col: 0, row: 2 }, 1, 0, 51, 999), { col: 1, row: 1 }, "enter → anchor");
  assert.ok(partialMergeConflict(s, R(2, 2, 5, 2))); assert.equal(partialMergeConflict(s, R(0, 0, 6, 6)), null);
  for (let r = 0; r < 6; r++) s.setCell(0, r, String(6 - r));
  assert.throws(() => sortRange(wb, "Sheet1", R(0, 0, 2, 5), 0, true), /identically sized/);
});

await test("insert/delete rows & cols repair merges, validations and frozen panes", { "FF-33": "full", "FF-35": "partial" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  mergeCells(s, R(1, 2, 3, 4)); mergeCells(s, R(0, 10, 1, 10));
  s.validations = [dv({ id: "a", sqref: "B3:B9 D2", type: "whole", operator: "between", formula1: "1", formula2: "9" })];
  insertDelete(wb, "Sheet1", "row", 3, 2);         // inside the merge → grows; below → shifts
  assert.deepEqual(s.merges, [R(1, 2, 3, 6), R(0, 12, 1, 12)]); assert.equal(s.validations[0].sqref, "B3:B11 D2");
  insertDelete(wb, "Sheet1", "row", 12, -1);       // deleting row 13 kills the 1-row merge
  assert.deepEqual(s.merges, [R(1, 2, 3, 6)]);
  insertDelete(wb, "Sheet1", "col", 1, -2);        // delete B:C → merge B3:D7 shrinks to B3:B7, the B-column rule part vanishes, D2 → B2
  assert.deepEqual(s.merges, [R(1, 2, 1, 6)]); assert.equal(s.validations[0].sqref, "B2");
  insertDelete(wb, "Sheet1", "col", 1, -1);        // and deleting B removes both entirely
  assert.deepEqual(s.merges, []); assert.equal(s.validations.length, 0);
  assert.equal(adjustRange(R(0, 5, 0, 9), "row", 6, -2)?.r1, 7);
  s.freezeRows = 3; insertDelete(wb, "Sheet1", "row", 0, -2); assert.equal(s.freezeRows, 1);
});

await test("borders: presets set the right edges; shared edge shows the heavier side; 'none' clears; per-cell storage", { "FF-34": "full" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  applyBorders(s, R(0, 0, 2, 2), "outside", { style: "thin", color: "#112233" });
  assert.deepEqual(s.get(0, 0)?.style?.border, { top: { style: "thin", color: "#112233" }, left: { style: "thin", color: "#112233" } });
  assert.equal(s.get(1, 1)?.style?.border, undefined, "interior untouched by outside");
  applyBorders(s, R(0, 0, 2, 2), "inside", { style: "dashed" });
  assert.deepEqual(Object.keys(s.get(1, 1)!.style!.border!).sort(), ["bottom", "left", "right", "top"]);
  assert.deepEqual(Object.keys(s.get(0, 0)!.style!.border!).sort(), ["bottom", "left", "right", "top"]);
  applyBorders(s, R(0, 3, 0, 3), "thickOutside"); s.setStyle(0, 2, { border: { bottom: { style: "hair" } } });
  assert.equal(edgeAt(s, 0, 2, "bottom")?.style, "thick", "heavier neighbour wins"); assert.equal(edgeAt(s, 0, 3, "top")?.style, "thick");
  applyBorders(s, R(0, 0, 2, 3), "none"); assert.equal(s.get(1, 1), undefined, "empty styled cell removed"); assert.equal(s.merges.length, 0);
  applyBorders(s, R(4, 4, 5, 4), "bottomDouble"); assert.equal(s.get(5, 4)?.style?.border?.bottom?.style, "double");
});

await test("data validation: list (literal + range, case-insensitive), whole/decimal/date/textLength operators, custom (relative), blanks, rollback", { "FF-35": "full" }, () => {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(5, 0, "Red"); s.setCell(5, 1, "Green"); s.setCell(5, 2, "=\"Bl\"&\"ue\"");
  s.validations = [
    dv({ id: "l1", sqref: "A1:A10", type: "list", formula1: listFormula(["Low", "Medium", "High"]) }),
    dv({ id: "l2", sqref: "B1:B10", type: "list", formula1: "$F$1:$F$3", allowBlank: false }),
    dv({ id: "w", sqref: "C1:C10", type: "whole", operator: "between", formula1: "1", formula2: "$G$1" }),
    dv({ id: "d", sqref: "D1", type: "decimal", operator: "greaterThan", formula1: "0" }),
    dv({ id: "t", sqref: "E1", type: "textLength", operator: "lessThanOrEqual", formula1: "3" }),
    dv({ id: "c", sqref: "H2:H10", type: "custom", formula1: "MOD(H2,2)=0" }),
    dv({ id: "dt", sqref: "I1", type: "date", operator: "greaterThanOrEqual", formula1: "DATE(2026,1,1)" }),
    dv({ id: "off", sqref: "J1", type: "whole", operator: "equal", formula1: "7", showError: false }),
  ];
  s.setCell(6, 0, "10"); wb.recalculate();
  assert.deepEqual(listItems(wb, "Sheet1", s.validations[1]), ["Red", "Green", "Blue"]);
  const ok = (c: number, r: number, v: string) => validateEntry(wb, "Sheet1", c, r, v).ok;
  assert.ok(ok(0, 0, "medium")); assert.ok(!ok(0, 1, "Huge")); assert.equal(s.get(0, 1), undefined, "rejected entry rolled back");
  assert.ok(ok(1, 0, "blue")); assert.ok(!ok(1, 1, "Purple"));
  assert.ok(ok(2, 0, "10")); assert.ok(!ok(2, 1, "11"), "bound read from $G$1"); assert.ok(!ok(2, 2, "2.5"), "whole rejects decimals"); assert.ok(!ok(2, 3, "abc"));
  assert.ok(ok(2, 4, "=2*3"), "formula entries are validated on their result");
  assert.ok(ok(3, 0, "0.01")); assert.ok(!ok(3, 0, "0"));
  assert.ok(ok(4, 0, "abc")); assert.ok(!ok(4, 0, "abcd")); assert.ok(ok(4, 0, "123"), "numbers measured as text length");
  assert.ok(ok(7, 1, "4")); assert.ok(!ok(7, 2, "5")); assert.ok(ok(7, 5, "8"), "custom formula shifts relative to the rule's top-left");
  assert.ok(ok(8, 0, "46100")); assert.ok(!ok(8, 0, "45000"));
  assert.ok(ok(9, 0, "999"), "showError=false never blocks");
  assert.ok(ok(0, 2, ""), "blank allowed"); assert.ok(!validateEntry(wb, "Sheet1", 1, 5, "").ok || s.get(1, 5) === undefined);
  const prev = s.get(1, 0)?.input; assert.ok(!ok(1, 0, "Nope")); assert.equal(s.get(1, 0)?.input, prev, "rollback restores the previous input");
  // circle invalid data: pre-existing bad values (e.g. pasted) are found
  s.setCell(2, 6, "99"); s.setCell(7, 3, "3"); wb.recalculate();
  const bad = invalidCells(wb, "Sheet1").map((p) => `${p.col},${p.row}`);
  assert.ok(bad.includes("2,6") && bad.includes("7,3"), JSON.stringify(bad));
  assert.ok(bad.includes("1,1") || bad.includes("1,2"), "allowBlank=false list flags empty cells");
});

await test("validation hardening: 255-char typed list limit, sqref parsing, hostile JSON; merges/validations/borders persist through JSON", { "FF-35": "full", "FF-33": "full", "FF-34": "full" }, () => {
  assert.throws(() => listFormula(Array.from({ length: 60 }, (_, i) => `item${i}`)), /255/);
  assert.equal(listFormula(["a", "b"]), '"a,b"'); assert.throws(() => listFormula(['x"y']), /commas or quotes/);
  assert.equal(sanitizeValidation({ type: "list", sqref: "A1", formula1: `"${"x".repeat(LIST_LITERAL_MAX + 1)}"` }), null);
  assert.deepEqual(parseSqref("A1:B2 $C$3 junk ZZZZ9"), [{ c0: 0, r0: 0, c1: 1, r1: 1 }, { c0: 2, r0: 2, c1: 2, r1: 2 }]);
  assert.equal(sanitizeValidation({ type: "macro", sqref: "A1", formula1: "1" }), null);
  const v = sanitizeValidation({ type: "whole", sqref: "A1", formula1: "=1", operator: "evil", id: "<x>", error: "e".repeat(999) })!;
  assert.equal(v.formula1, "1"); assert.equal(v.operator, undefined); assert.equal(v.id, "x"); assert.equal(v.error!.length, 255);
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(0, 0, "Title"); mergeCells(s, R(0, 0, 3, 0)); applyBorders(s, R(0, 2, 1, 3), "all", { style: "medium", color: "#ff0000" });
  s.validations = [dv({ id: "l", sqref: "B5:B9", type: "list", formula1: '"x,y"', inCellDropdown: false })]; s.freezeCols = 2;
  const back = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(wb)))).sheet();
  assert.deepEqual(back.merges, s.merges); assert.deepEqual(back.validations, s.validations); assert.equal(back.freezeCols, 2);
  assert.deepEqual(back.get(1, 3)?.style?.border, s.get(1, 3)?.style?.border);
  const hostile = workbookFromJson({ sheets: [{ name: "H", cells: [{ ref: "A1", input: "x", style: { border: { top: { style: "evil" }, left: { style: "thin", color: "red;x" } } } as never }],
    merges: ["A1:B2", "B2:C3", "A1", "nope", 5 as never], validations: [{ type: "list", sqref: "A1", formula1: "" }, "x"], freezeCols: 999 }] }).sheet("H");
  assert.deepEqual(hostile.merges, [R(0, 0, 1, 1)], "overlapping / single / invalid merges dropped");
  assert.deepEqual(hostile.get(0, 0)?.style?.border, { left: { style: "thin" } }); assert.equal(hostile.validations.length, 0); assert.equal(hostile.freezeCols, 0);
});
finish();
