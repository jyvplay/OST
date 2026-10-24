/**
 * Office engine suite (TT15): dynamic arrays, broadcasting, extended library
 * adapter, fill/copy reference shifting, number formats, charts, raster layers,
 * PSD write→read, vector geometry. Pure library code, executed in Node.
 *
 * Expected numbers for financial functions were computed independently in
 * Python from the closed-form annuity formulas (see the comment on each case),
 * not by reading our own output back.
 *
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/office-engine.mts
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { Workbook, isError, type Scalar } from "../src/lib/formula/index.ts";

const { test, finish } = makeHarness("office");
const near = (a: unknown, b: number, eps = 1e-9) => assert.ok(typeof a === "number" && Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${JSON.stringify(a)} ≉ ${b}`);
const colOf = (s: string) => { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
function book(cells: Record<string, string>) {
  const wb = new Workbook();
  const s = wb.sheet();
  for (const [ref, v] of Object.entries(cells)) { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; s.setCell(colOf(m[1]), Number(m[2]) - 1, v); }
  wb.recalculate();
  const get = (ref: string): Scalar | undefined => { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; return wb.valueAt("Sheet1", colOf(m[1]), Number(m[2]) - 1); };
  const set = (ref: string, v: string) => { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; s.setCell(colOf(m[1]), Number(m[2]) - 1, v); wb.recalculate(); };
  return { wb, get, set };
}
const errOf = (v: Scalar | undefined) => (v !== undefined && isError(v) ? v.error : null);

console.log("\nDynamic arrays (modal shortcut detector: assert EVERY spilled cell, not just the anchor)");
await test("SEQUENCE(2,3) spills all six cells with correct values", { "FF-26": "full" }, () => {
  const { get, wb } = book({ A1: "=SEQUENCE(2,3)" });
  assert.deepEqual(["A1", "B1", "C1", "A2", "B2", "C2"].map(get), [1, 2, 3, 4, 5, 6]);
  assert.equal(get("D1"), undefined); assert.equal(get("A3"), undefined);
  assert.equal(wb.spillAnchorOf("Sheet1", 2, 1)?.anchorCol, 0);
  assert.equal(wb.lastRecalc.stable, true);
});
await test("an obstruction blocks the WHOLE array with #SPILL!, and removing it recovers", { "FF-26": "full" }, () => {
  const b = book({ A1: "=SEQUENCE(3)", A3: "x" });
  assert.equal(errOf(b.get("A1")), "#SPILL!");
  assert.equal(b.get("A2"), undefined, "no partial publication");
  assert.equal(b.get("A3"), "x", "user data never overwritten");
  b.set("A3", "");
  assert.deepEqual(["A1", "A2", "A3"].map(b.get), [1, 2, 3]);
});
await test("a formula referencing a spilled child sees the child value (fixed point)", { "FF-26": "full" }, () => {
  // C1 is evaluated BEFORE A1 in row-major order would place it? no: put the dependant above-left.
  const { get, wb } = book({ A1: "=B5*10", B3: "=SEQUENCE(4)" });
  assert.equal(get("B5"), 3);
  assert.equal(get("A1"), 30);
  assert.ok(wb.lastRecalc.passes >= 2 && wb.lastRecalc.stable);
});
await test("two anchors competing for one cell: deterministic row-major winner, loser #SPILL!", { "FF-26": "full" }, () => {
  const { get } = book({ A1: "=SEQUENCE(1,3)", B1: "" , C2: "=1", A2: "=SEQUENCE(1,2)" });
  assert.deepEqual(["A1", "B1", "C1"].map(get), [1, 2, 3]);
  assert.deepEqual(["A2", "B2"].map(get), [1, 2]);
  const c = book({ B1: "=SEQUENCE(2)", A2: "=SEQUENCE(1,2)" });
  assert.equal(c.get("B2"), 2, "earlier anchor (B1, row 1) wins B2");
  assert.equal(errOf(c.get("A2")), "#SPILL!");
});
await test("self-dependent spill size terminates (no hang) with an error value", { "FF-26": "full" }, () => {
  const t0 = Date.now();
  const { get } = book({ A1: "=SEQUENCE(COUNTA(A2:A6)+1)" });
  assert.ok(Date.now() - t0 < 2000);
  const v = get("A1");
  assert.ok(v !== undefined && (isError(v) || typeof v === "number"), JSON.stringify(v));
});
await test("oversized generator is refused (#NUM!), not truncated", { "FF-26": "full" }, () => {
  const { get } = book({ A1: "=SEQUENCE(1000,1000)" });
  assert.equal(errOf(get("A1")), "#NUM!");
  assert.equal(get("A2"), undefined);
});

console.log("\nBroadcasting and array-aware special forms");
await test("A1:A3*2 spills element-wise; range+range aligns; mismatch → #N/A outside overlap", { "FF-26": "full" }, () => {
  const { get } = book({ A1: "1", A2: "2", A3: "3", B1: "=A1:A3*2", C1: "=A1:A3+B1:B2", D1: "=10" });
  assert.deepEqual(["B1", "B2", "B3"].map(get), [2, 4, 6]);
  assert.deepEqual(["C1", "C2"].map(get), [3, 6]);
  assert.equal(errOf(get("C3")), "#N/A");
});
await test("FILTER with a broadcast boolean condition, SORT, UNIQUE, XLOOKUP", { "FF-26": "full", "FF-27": "partial" }, () => {
  const { get } = book({
    A1: "pear", A2: "apple", A3: "fig", A4: "apple", B1: "3", B2: "9", B3: "1", B4: "4",
    D1: "=FILTER(A1:A4,B1:B4>2)", E1: "=SORT(B1:B4)", F1: "=UNIQUE(A1:A4)", G1: "=XLOOKUP(\"fig\",A1:A4,B1:B4)",
  });
  assert.deepEqual(["D1", "D2", "D3"].map(get), ["pear", "apple", "apple"]);
  assert.equal(get("D4"), undefined);
  assert.deepEqual(["E1", "E2", "E3", "E4"].map(get), [1, 3, 4, 9]);
  assert.deepEqual(["F1", "F2", "F3"].map(get), ["pear", "apple", "fig"]);
  assert.equal(get("F4"), undefined);
  assert.equal(get("G1"), 1);
});
await test("IF over an array condition is element-wise; IFERROR over arrays replaces only errors", { "FF-26": "full" }, () => {
  const { get } = book({ A1: "1", A2: "0", A3: "2", B1: "=IF(A1:A3>0,\"y\",\"n\")", C1: "=IFERROR(1/A1:A3,\"z\")" });
  assert.deepEqual(["B1", "B2", "B3"].map(get), ["y", "n", "y"]);
  assert.deepEqual(["C1", "C2", "C3"].map(get), [1, "z", 0.5]);
});
await test("SUM over a computed array (SUMPRODUCT-style) and ROW() with no argument", { "FF-26": "partial" }, () => {
  const { get } = book({ A1: "1", A2: "2", A3: "3", B1: "4", B2: "5", B3: "6", C1: "=SUM(A1:A3*B1:B3)", C2: "=SUMPRODUCT(A1:A3,B1:B3)", C3: "=ROW()" });
  assert.equal(get("C1"), 32); assert.equal(get("C2"), 32); assert.equal(get("C3"), 3);
});

console.log("\nExtended library through the adapter (first-party table keeps precedence)");
await test("first-party verified semantics survive: SUM(1,\"x\",2) is still #VALUE!", { "FF-27": "full", "FF-19": "partial" }, () => {
  const { get } = book({ A1: "=SUM(1,\"x\",2)", A2: "=COUNT(1,\"x\",2,TRUE())" });
  assert.equal(errOf(get("A1")), "#VALUE!"); assert.equal(get("A2"), 3);
});
await test("financial: PMT/NPV/IRR/FV match independent closed-form values", { "FF-27": "full" }, () => {
  // python: -200000*r/(1-(1+r)**-360), r=0.05/12 → -1073.6432460242797
  const { get } = book({ A1: "=PMT(0.05/12,360,200000)", A2: "=NPV(0.1,100,100)", A3: "=IRR(B1:B4)", B1: "-100", B2: "30", B3: "40", B4: "50", A4: "=FV(0.06/12,120,-100)" });
  near(get("A1"), -1073.6432460242797, 1e-12);
  near(get("A2"), 173.55371900826447, 1e-12); // 100/1.1+100/1.21
  near(get("A3"), 0.08896339469335, 1e-9);    // bisection root of the cash-flow polynomial
  near(get("A4"), 16387.9346806458, 1e-11);   // 100*((1+.005)^120-1)/.005
});
await test("text/lookup/stat breadth: TEXTJOIN, COUNTIFS, MAXIFS, LARGE, MEDIAN, STDEV.S, DEC2BIN, ROMAN", { "FF-27": "partial" }, () => {
  const { get } = book({
    A1: "a", A2: "b", A3: "c", B1: "1", B2: "5", B3: "9",
    C1: "=TEXTJOIN(\"-\",TRUE,A1:A3)", C2: "=COUNTIFS(B1:B3,\">1\",A1:A3,\"<>c\")", C3: "=MAXIFS(B1:B3,A1:A3,\"<>c\")",
    C4: "=LARGE(B1:B3,2)", C5: "=STDEV.S(B1:B3)", C6: "=DEC2BIN(10)", C7: "=ROMAN(1999)",
  });
  assert.equal(get("C1"), "a-b-c"); assert.equal(get("C2"), 1); assert.equal(get("C3"), 5);
  assert.equal(get("C4"), 5); near(get("C5"), 4, 1e-12); assert.equal(get("C6"), "1010"); assert.equal(get("C7"), "MCMXCIX");
});
await test("engineering conversions follow Excel: no default padding, two's complement negatives, #NUM! guards", { "FF-27": "full" }, () => {
  // Expected values from Microsoft's documented examples for DEC2BIN/DEC2HEX/HEX2DEC/BIN2DEC.
  const { get } = book({ A1: "=DEC2BIN(9,4)", A2: "=DEC2BIN(-100)", A3: "=DEC2HEX(-54)", A4: "=HEX2DEC(\"FFFFFFFF5B\")", A5: "=BIN2DEC(1111111111)",
    A6: "=DEC2BIN(512)", A7: "=DEC2BIN(9,2)", A8: "=BIN2DEC(\"102\")", A9: "=BITAND(2^40+5,7)", A10: "=BITLSHIFT(4,2)", A11: "=DEC2OCT(-1)" });
  assert.equal(get("A1"), "1001"); assert.equal(get("A2"), "1110011100"); assert.equal(get("A3"), "FFFFFFFFCA");
  assert.equal(get("A4"), -165); assert.equal(get("A5"), -1);
  assert.equal(errOf(get("A6")), "#NUM!"); assert.equal(errOf(get("A7")), "#NUM!"); assert.equal(errOf(get("A8")), "#NUM!");
  assert.equal(get("A9"), 5); assert.equal(get("A10"), 16); assert.equal(get("A11"), "7777777777");
});
await test("unknown function is #NAME?; errors from ext functions map to engine errors", { "FF-27": "full" }, () => {
  const { get } = book({ A1: "=NOPE(1)", A2: "=SQRT(-1)", A3: "=XLOOKUP(\"zz\",B1:B2,B1:B2)", B1: "1", B2: "2" });
  assert.equal(errOf(get("A1")), "#NAME?"); assert.equal(errOf(get("A2")), "#NUM!"); assert.equal(errOf(get("A3")), "#N/A");
});

await (await import("./office-engine-2.mts")).run({ test, book, near, errOf });
finish();
