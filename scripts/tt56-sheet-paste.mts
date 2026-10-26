/**
 * TT56 Spreadsheet Paste Special (FF-20). Ground truth:
 *  - hand-computed Excel cases (values of formulas, transposed relationships, operations, skip blanks, formats only);
 *  - an INDEPENDENT reference model for random blocks: values/op/skip/transpose computed cell-by-cell from the source and
 *    target grids without the implementation, compared with the engine's recomputed values after the paste;
 *  - algebraic laws: transpose ∘ transpose = identity on inputs; paste "formulas" then evaluate = evaluated source shifted.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt56-sheet-paste.mts
 */
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { copyBlock, pasteSpecial, transposeFormula, type PasteOp } from "../src/lib/formula/sheetops.ts";
import type { Scalar } from "../src/lib/formula/types.ts";

const { test, finish } = makeHarness("tt56-sheet-paste");
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const R = (c0: number, r0: number, c1: number, r1: number) => ({ c0, r0, c1, r1 });
function setup(cells: Record<string, string>) {
  const wb = new Workbook(); const s = wb.sheet(); const name = "Sheet1";
  for (const [a, v] of Object.entries(cells)) { const m = /^([A-Z]+)(\d+)$/.exec(a)!; s.setCell(m[1].charCodeAt(0) - 65, Number(m[2]) - 1, v); }
  wb.recalculate();
  const val = (a: string) => { const m = /^([A-Z]+)(\d+)$/.exec(a)!; return wb.valueAt(name, m[1].charCodeAt(0) - 65, Number(m[2]) - 1); };
  const inp = (a: string) => { const m = /^([A-Z]+)(\d+)$/.exec(a)!; return s.get(m[1].charCodeAt(0) - 65, Number(m[2]) - 1)?.input ?? ""; };
  const valuesOf = (r: { c0: number; r0: number; c1: number; r1: number }) => { const out: Scalar[][] = []; for (let y = r.r0; y <= r.r1; y++) { const row: Scalar[] = []; for (let x = r.c0; x <= r.c1; x++) row.push(wb.valueAt(name, x, y) ?? ""); out.push(row); } return out; };
  return { wb, s, name, val, inp, valuesOf, recalc: () => wb.recalculate() };
}

await test("hand cases: values of formulas, formulas keep target format, formats only, skip blanks, quote-prefixed text", { "FF-20": "full" }, () => {
  const t = setup({ A1: "2", A2: "3", A3: "=A1*A2", B1: "'0012", B2: "", B3: "TRUE" });
  t.s.setStyle(0, 2, { bold: true });
  const clip = copyBlock(t.s, R(0, 0, 1, 2)); const vals = t.valuesOf(R(0, 0, 1, 2));
  pasteSpecial(t.s, clip, vals, 3, 0, { what: "values" });               // D1
  eq([t.inp("D1"), t.inp("D2"), t.inp("D3"), t.inp("E1"), t.inp("E3")], ["2", "3", "6", "'0012", "TRUE"], "values inputs");
  eq(t.s.get(3, 2)?.style ?? null, null, "values do not carry formats");
  t.s.setStyle(6, 2, { italic: true });
  pasteSpecial(t.s, clip, vals, 6, 0, { what: "formulas" });             // G1
  eq(t.inp("G3"), "=G1*G2", "formula shifted"); eq(t.s.get(6, 2)?.style, { italic: true }, "target format kept");
  pasteSpecial(t.s, clip, vals, 9, 0, { what: "formats" });              // J1
  eq([t.inp("J3"), t.s.get(9, 2)?.style], ["", { bold: true }], "formats only");
  t.s.setCell(4, 6, "keep"); // E7
  pasteSpecial(t.s, clip, vals, 3, 5, { what: "all", skipBlanks: true }); // D6: B2 (blank) → E7 untouched
  eq(t.inp("E7"), "keep", "skip blanks leaves target");
  pasteSpecial(t.s, clip, vals, 3, 5, { what: "all" });
  eq(t.inp("E7"), "", "without skip blanks the blank overwrites");
});

await test("transpose: in-range relationships follow the transposed cells; mixed and absolute refs; out-of-sheet → #REF!", { "FF-20": "full" }, () => {
  const t = setup({ A1: "1", A2: "=A1+1", A3: "=A2+1", B1: "=$A$1*10", B2: "=$A2", B3: "=A$1" });
  const clip = copyBlock(t.s, R(0, 0, 1, 2)); const vals = t.valuesOf(R(0, 0, 1, 2));
  pasteSpecial(t.s, clip, vals, 3, 4, { what: "all", transpose: true });  // D5: source rows become columns
  eq([t.inp("D5"), t.inp("E5"), t.inp("F5")], ["1", "=D5+1", "=E5+1"], "chain transposed");
  eq(t.inp("D6"), "=$A$1*10", "absolute kept");
  eq(t.inp("E6"), "=$A6", "mixed: relative row shifted by displacement");
  eq(t.inp("F6"), "=E$1", "mixed: relative col shifted by the displacement (+4 columns)");
  t.recalc(); eq([t.val("D5"), t.val("E5"), t.val("F5")], [1, 2, 3], "transposed values");
  eq(transposeFormula("=B1", { col: 1, row: 0 }, { col: 0, row: 1 }), "=A2", "self ref follows");
  eq(transposeFormula("=A1:C1", { col: 0, row: 1 }, { col: 1, row: 0 }), "=A1:A3", "range offsets swapped");
  ok(transposeFormula("=A1", { col: 3, row: 0 }, { col: 0, row: 0 }).includes("#REF!"), "offset beyond the sheet → #REF!");
});

await test("operations: add / subtract / multiply / divide against the target, blank = 0, text pasted as-is, ÷0 → #DIV/0!, formula source → combined formula", { "FF-20": "full" }, () => {
  const t = setup({ A1: "2", A2: "5", A3: "x", A4: "0", A5: "=A1+A2", D1: "10", D2: "", D3: "7", D4: "4", D5: "3" });
  const clip = copyBlock(t.s, R(0, 0, 0, 4)); const vals = t.valuesOf(R(0, 0, 0, 4));
  for (const op of ["add", "subtract", "multiply", "divide"] as PasteOp[]) {
    const u = setup({ A1: "2", A2: "5", A3: "x", A4: "0", A5: "=A1+A2", D1: "10", D2: "", D3: "7", D4: "4", D5: "3" });
    pasteSpecial(u.s, copyBlock(u.s, R(0, 0, 0, 4)), u.valuesOf(R(0, 0, 0, 4)), 3, 0, { what: "values", op }, (c, r) => u.wb.valueAt(u.name, c, r));
    u.recalc();
    const got = ["D1", "D2", "D3", "D4", "D5"].map((a) => u.val(a));
    const f = (a: number, b: number) => op === "add" ? a + b : op === "subtract" ? a - b : op === "multiply" ? a * b : a / b;
    // reference: [10,blank,7,4,3] (op) [2,5,"x",0,7]
    const want: unknown[] = [f(10, 2), f(0, 5), "x", op === "divide" ? { error: "#DIV/0!" } : f(4, 0), f(3, 7)];
    eq(got, want, `op ${op}`);
  }
  pasteSpecial(t.s, clip, vals, 3, 0, { what: "formulas", op: "add" }, (c, r) => t.wb.valueAt(t.name, c, r));
  eq(t.inp("D5"), "=(3)+(D1+D2)", "formula source combined with the target value (refs shifted)");
});

await test("random blocks vs an independent reference model (values + op + skip blanks + transpose) and transpose∘transpose = id", { "FF-20": "full" }, () => {
  let seed = 56; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const ops: PasteOp[] = ["none", "add", "subtract", "multiply", "divide"];
  let trials = 0;
  for (let t = 0; t < 300; t++) {
    const h = 1 + Math.floor(rnd() * 4), w = 1 + Math.floor(rnd() * 4);
    const cell = () => { const k = rnd(); return k < 0.2 ? "" : k < 0.3 ? "txt" : String(Math.floor(rnd() * 21) - 10); };
    const src: string[][] = Array.from({ length: h }, () => Array.from({ length: w }, cell));
    const tgt: string[][] = Array.from({ length: 4 }, () => Array.from({ length: 4 }, cell));
    const op = ops[Math.floor(rnd() * ops.length)], skip = rnd() < 0.5, tr = rnd() < 0.5;
    const u = setup({}); for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) u.s.setCell(j, i, src[i][j]);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) u.s.setCell(10 + j, 10 + i, tgt[i][j]);
    u.recalc();
    pasteSpecial(u.s, copyBlock(u.s, R(0, 0, w - 1, h - 1)), u.valuesOf(R(0, 0, w - 1, h - 1)), 10, 10, { what: "values", op, skipBlanks: skip, transpose: tr }, (c, r) => u.wb.valueAt(u.name, c, r));
    u.recalc();
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      // reference: which source cell (if any) lands on target (i, j)?
      const si = tr ? j : i, sj = tr ? i : j;
      const tv = tgt[i][j]; const tvS: unknown = tv === "" ? "" : tv === "txt" ? "txt" : Number(tv);
      let want: unknown = tvS;
      if (si < h && sj < w) {
        const sv = src[si][sj];
        if (sv === "" && skip) want = tvS;
        else if (sv === "") want = "";
        else if (op === "none" || sv === "txt" || tv === "txt") want = sv === "txt" ? "txt" : Number(sv);
        else { const a = tv === "" ? 0 : Number(tv), b = Number(sv); want = op === "add" ? a + b : op === "subtract" ? a - b : op === "multiply" ? a * b : b === 0 ? { error: "#DIV/0!" } : a / b; }
      }
      const got = u.wb.valueAt(u.name, 10 + j, 10 + i) ?? "";
      eq(got, want, `trial ${t} cell (${i},${j}) op=${op} skip=${skip} tr=${tr}`);
    }
    // transpose twice at the origin = identity on inputs (formulas too)
    const v = setup({}); for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) v.s.setCell(j, i, src[i][j] === "txt" ? `=${String.fromCharCode(65 + j)}${i + 1}*0+1` : src[i][j]);
    const once = copyBlock(v.s, R(0, 0, w - 1, h - 1));
    pasteSpecial(v.s, once, undefined, 20, 20, { what: "all", transpose: true });
    pasteSpecial(v.s, copyBlock(v.s, R(20, 20, 20 + h - 1, 20 + w - 1)), undefined, 0, 30, { what: "all", transpose: true });
    const back = copyBlock(v.s, R(0, 30, w - 1, 30 + h - 1)).inputs.map((r) => r.map((x) => x.replace(/\d+/g, (d) => d)));
    const expect = once.inputs.map((r, i) => r.map((x) => (x.startsWith("=") ? x.replace(/(\d+)/, (d) => String(Number(d) + 30)) : x)).map((x, j) => (x.startsWith("=") ? x : once.inputs[i][j])));
    eq(back, expect, `transpose twice trial ${t}`);
    trials++;
  }
  ok(trials === 300, "300 trials");
});

await finish();
