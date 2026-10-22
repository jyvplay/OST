/**
 * TT61 Writer cell revisions — w:cellIns / w:cellDel (ECMA-376 §17.13.5.4 / .5) are listed in the Changes pane and can be
 * accepted / rejected one by one or all at once: accepting a deletion or rejecting an insertion removes the cell, and the
 * row keeps filling the table grid through w:trPr/w:gridAfter; an emptied row goes, an emptied table goes. w:cellMerge is
 * listed but refused (disclosed).
 * Ground truth: the markers are written by an INDEPENDENT writer (scripts/oracle/docx_tblrev.py markcells, lxml) and every
 * result is checked by the same independent oracle: its accept-all / reject-all table views (computed from the ORIGINAL
 * file) must equal what our per-change and all-at-once resolution produce; grid_ok (gridBefore + Σ gridSpan + gridAfter =
 * gridCols), tcpr_ok (CT_TcPr order), order_ok (CT_TrPr order), python-docx opens the result.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt61-writer-cellrev.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, rowsOf, cellsOf, type WordDoc, type Table } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { el } from "../src/lib/office/xmltree.ts";

const { test, finish } = makeHarness("tt61-writer-cellrev");
const COV = { "FF-44": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt61c-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
type Oracle = {
  opens: boolean | string; tables: string[][][]; cells: { table: number; row: number; cell: number; kind: string; id: string; author: string; text: string }[];
  grid_ok: boolean; grid_errors: unknown[]; tcpr_ok: boolean; tcpr_errors: string[]; order_ok: boolean; order_errors: string[]; ids_unique: boolean;
  accept: string[][][]; reject: string[][][];
};
let seq = 0;
const put = (b: Uint8Array) => { const f = join(tmp, `f${seq++}.docx`); writeFileSync(f, b); return f; };
const oracle = (b: Uint8Array): Oracle => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_tblrev.py", put(b)], { encoding: "utf8", maxBuffer: 64 << 20 }));
const mark = (b: Uint8Array, specs: string[]) => { const out = join(tmp, `m${seq++}.docx`); execFileSync(PY, ["scripts/oracle/docx_tblrev.py", "markcells", put(b), out, ...specs]); return new Uint8Array(readFileSync(out)); };
const sound = (o: Oracle, m: string) => { ok(o.opens === true, `${m}: python-docx ${o.opens}`); ok(o.grid_ok, `${m}: grid ${JSON.stringify(o.grid_errors)}`); ok(o.tcpr_ok, `${m}: tcPr ${o.tcpr_errors}`); ok(o.order_ok, `${m}: trPr ${o.order_errors}`); ok(o.ids_unique, `${m}: ids`); };
const cellPara = (t: Table, r: number, c: number) => allParas(cellsOf(rowsOf(t)[r])[c].blocks)[0];

/** 3×3 table R{r}C{c}, plus a 1×1 table "Solo" after it */
async function base(): Promise<Uint8Array> {
  const d = await blankWord("Cells");
  const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Before");
  const t = E.insertTableAfter(d, p0.id, 3, 3)!;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) E.insertText(d, { pid: cellPara(t, r, c).id, off: 0 }, `R${r}C${c}`);
  const after = allParas(d.blocks).at(-1)!;
  const t2 = E.insertTableAfter(d, after.id, 1, 1)!;
  E.insertText(d, { pid: cellPara(t2, 0, 0).id, off: 0 }, "Solo");
  return writeWord(d);
}
const BASE = await base();
// R0C2 inserted (id 801), R1C0 deleted (802), R2C1 inserted (803), the solo cell deleted (804)
const SPECS = ["0,0,2,ins,801", "0,1,0,del,802", "0,2,1,ins,803", "1,0,0,del,804"];
const MARKED = mark(BASE, SPECS);
const tables = (d: WordDoc) => d.blocks.filter((b): b is Table => b.t === "tbl").map((t) => rowsOf(t).map((r) => cellsOf(r).map((c) => allParas(c.blocks).map((p) => p.content.map((it) => (it.t === "r" ? it.text : "")).join("")).join("\n"))));

await test("listing: the 4 cell markers written by the independent writer appear in the Changes list at their cell, kind / author / id from the file, in document order", COV, async () => {
  const o = oracle(MARKED); sound(o, "fixture");
  eq(o.cells.map((c) => [c.kind, c.id, c.text]), [["cellIns", "801", "R0C2"], ["cellDel", "802", "R1C0"], ["cellIns", "803", "R2C1"], ["cellDel", "804", "Solo"]], "oracle sees the fixture markers");
  const d = await readWord(MARKED);
  const cs = E.revisions(d).filter((c) => c.key.startsWith("c:"));
  eq(cs.map((c) => [c.key, c.kind, c.author, c.text, c.editable]), [["c:801", "ins", "Oracle", "[Table cell] ", true], ["c:802", "del", "Oracle", "[Table cell] ", true], ["c:803", "ins", "Oracle", "[Table cell] ", true], ["c:804", "del", "Oracle", "[Table cell] ", true]], "listed");
  const t = d.blocks.find((b): b is Table => b.t === "tbl")!;
  eq(cs[0].pid, cellPara(t, 0, 2).id, "listed at its own cell");
  // untouched round trip keeps the markers
  eq(oracle(await writeWord(d)).cells.map((c) => c.id), ["801", "802", "803", "804"], "round trip keeps markers");
});

await test("accept all / reject all equal the oracle's §17.13.5.4/.5 views of the original file; rows keep filling the grid (gridAfter); the emptied 1×1 table disappears on accept", COV, async () => {
  const o0 = oracle(MARKED);
  // hand-written expectations (independent of both implementations)
  const ACC = [[["R0C0", "R0C1", "R0C2"], ["R1C1", "R1C2"], ["R2C0", "R2C1", "R2C2"]]];
  const REJ = [[["R0C0", "R0C1"], ["R1C0", "R1C1", "R1C2"], ["R2C0", "R2C2"]], [["Solo"]]];
  eq(o0.accept, ACC, "oracle accept view = hand expectation");
  eq(o0.reject, REJ, "oracle reject view = hand expectation");
  for (const accept of [true, false]) {
    const d = await readWord(MARKED);
    const n = E.resolveChanges(d, accept);
    ok(n >= 4, `resolved ${n}`);
    eq(tables(d), accept ? ACC : REJ, `${accept ? "accept" : "reject"} all, our model`);
    const o = oracle(await writeWord(d)); sound(o, accept ? "accept" : "reject");
    eq(o.tables, accept ? ACC : REJ, "python-docx view after save");
    eq(o.cells, [], "no markers remain");
    eq(E.revisions(await readWord(await writeWord(d))).filter((c) => c.key.startsWith("c:")), [], "none listed after re-open");
  }
});

await test("one at a time: each marker resolved alone (both directions) then the rest by the oracle = the oracle's all-at-once view; 12 random mixed decision / order trials equal hand-applied expectations", COV, async () => {
  for (const accept of [true, false]) {
    for (const key of ["c:801", "c:802", "c:803", "c:804"]) {
      const d = await readWord(MARKED);
      ok(E.resolveOne(d, key, accept), `${key} ${accept}`);
      ok(!E.resolveOne(d, key, accept), `${key} is gone after resolving`);
      const left = E.revisions(d).filter((c) => c.key.startsWith("c:")).map((c) => c.key);
      eq(left, ["c:801", "c:802", "c:803", "c:804"].filter((k) => k !== key), "the others stay listed");
      // the oracle resolving the remaining markers (of OUR saved file) the same way must give its all-at-once view of the original
      const o = oracle(await writeWord(d)); sound(o, key);
      eq(o[accept ? "accept" : "reject"], oracle(MARKED)[accept ? "accept" : "reject"], `${key}: ours-one-then-oracle-rest = oracle all at once`);
    }
  }
  // a random order of single resolutions with mixed decisions equals the oracle with those decisions applied to fresh markers
  let rnd = 0xce11;
  const rand = (n: number) => { rnd = (rnd * 1103515245 + 12345) >>> 0; return Math.floor((rnd / 2 ** 32) * n); };
  for (let t = 0; t < 12; t++) {
    const d = await readWord(MARKED);
    const keys = ["c:801", "c:802", "c:803", "c:804"]; const dec: Record<string, boolean> = {};
    for (const k of keys) dec[k] = rand(2) === 1;
    const order = [...keys].sort(() => rand(3) - 1);
    for (const k of order) ok(E.resolveOne(d, k, dec[k]), `${k}`);
    // expectation: start from the original 3×3 + Solo and apply each decision by hand
    const grid = [["R0C0", "R0C1", "R0C2"], ["R1C0", "R1C1", "R1C2"], ["R2C0", "R2C1", "R2C2"]];
    const gone = (k: string) => (k === "c:801" || k === "c:803" ? !dec[k] : dec[k]);
    const exp: string[][][] = [grid.map((row, r) => row.filter((_, c) => !((r === 0 && c === 2 && gone("c:801")) || (r === 1 && c === 0 && gone("c:802")) || (r === 2 && c === 1 && gone("c:803")))))];
    if (!gone("c:804")) exp.push([["Solo"]]);
    eq(tables(d), exp, `trial ${t} ${JSON.stringify(dec)} order ${order}`);
    sound(oracle(await writeWord(d)), `trial ${t}`);
  }
});

await test("grid bookkeeping: removing a spanning cell adds its full span to an existing gridAfter; removing every cell of a row removes the row; cellMerge is listed read-only and refused", COV, async () => {
  // build: row 1 gets its first two cells merged (span 2) and row 1 already has gridAfter 0 → after deleting the merged cell,
  // gridAfter = 2; then delete both remaining cells of row 2 → row 2 disappears
  const d0 = await readWord(BASE);
  const t0 = d0.blocks.find((b): b is Table => b.t === "tbl")!;
  const r1 = rowsOf(t0)[1]; const cs = cellsOf(r1);
  cs[0].span = 2; r1.items.splice(r1.items.indexOf(cs[1]), 1); // R1C0 spans two grid columns (R1C1's text is dropped)
  // row 1 also carries a row-property change record: gridAfter must land among the base properties, before w:trPrChange
  const trPr = el("w:trPr", {}, [el("w:trHeight", { "w:val": "400" }), el("w:trPrChange", { "w:id": "960", "w:author": "X" }, [el("w:trPr", {}, [el("w:trHeight", { "w:val": "300" })])])]);
  r1.items = r1.items.filter((it) => !((it as { name?: string }).name === "w:trPr"));
  r1.items.unshift(trPr as never);
  const merged = await writeWord(d0);
  const m2 = mark(merged, ["0,1,0,del,901", "0,2,0,del,902", "0,2,1,del,903", "0,2,2,del,904"]);
  const o0 = oracle(m2); sound(o0, "fixture 2");
  const d = await readWord(m2);
  ok(E.resolveOne(d, "c:901", true), "accept spanning deletion");
  const o1 = oracle(await writeWord(d)); sound(o1, "after spanning removal");
  ok(JSON.stringify(o1.order_errors) === "[]", "CT_TrPr order with gridAfter + trPrChange");
  ok((o1 as unknown as { pr_changes: { id: string }[] }).pr_changes.some((x) => x.id === "960"), "the row's property change record survives");
  for (const k of ["c:902", "c:903", "c:904"]) ok(E.resolveOne(d, k, true), k);
  const o2 = oracle(await writeWord(d)); sound(o2, "after row emptied");
  eq(o2.tables, [[["R0C0", "R0C1", "R0C2"], ["R1C2"]], [["Solo"]]], "row 2 removed; row 1 keeps R1C2");
  eq(o2.tables, o0.accept, "= oracle accept view of the original");
  // cellMerge: written by hand into tcPr, listed read-only, refused
  const d3 = await readWord(BASE);
  const t3 = d3.blocks.find((b): b is Table => b.t === "tbl")!;
  const c3 = cellsOf(rowsOf(t3)[0])[0];
  c3.tcPr = el("w:tcPr", {}, [el("w:cellMerge", { "w:id": "950", "w:author": "X", "w:vMerge": "rest" })]);
  const cm = E.revisions(d3).find((c) => c.key === "c:950");
  ok(cm && !cm.editable && /merge/i.test(cm.text), "cellMerge listed read-only");
  ok(!E.resolveOne(d3, "c:950", true) && !E.resolveOne(d3, "c:950", false), "cellMerge refused both ways");
});

await finish();
