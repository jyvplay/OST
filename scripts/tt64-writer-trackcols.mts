/**
 * TT64 Writer: tracked column insert / delete (FF-48). With Track Changes on, inserting a column marks every new cell
 * w:cellIns and records the replaced widths in w:tblGrid/w:tblGridChange (ECMA-376 §17.13.5.4, §17.13.5.33); deleting a
 * column marks every cell of it w:cellDel (§17.13.5.5). Review lists the column as ONE change; accepting / rejecting it
 * (or Accept All / Reject All) gives exactly the untracked column operation / the original table, widths included.
 *
 * Ground truth: the UNTRACKED column operation applied to an independent copy of the same file. Independent oracle:
 * scripts/oracle/docx_tblrev.py (lxml, shares no code with src/lib/office) — its accept-all / reject-all views (text and
 * grid widths, computed from the TRACKED file alone) must equal the ground truth, and so must our own resolution. Every
 * tracked package also passes the ECMA-376 transitional XSDs (scripts/oracle/ooxml_xsd.py) and python-docx opens it.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt64-writer-trackcols.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, rowsOf, cellsOf, type WordDoc, type Table } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { el } from "../src/lib/office/xmltree.ts";

const { test, finish } = makeHarness("tt64-writer-trackcols");
const COV = { "FF-48": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt64c-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 600)} != ${JSON.stringify(b)?.slice(0, 600)}`); };
type Grid = { asis: number[]; change: number[] | null; change_id: string | null; accept: number[]; reject: number[] };
type Oracle = {
  opens: boolean | string; cells: { table: number; row: number; cell: number; kind: string; id: string; author: string; text: string }[];
  grid_ok: boolean; grid_errors: unknown[]; tcpr_ok: boolean; tcpr_errors: string[]; order_ok: boolean; order_errors: string[]; ids_unique: boolean; ids: string[];
  accept: string[][][]; reject: string[][][]; grids: Grid[];
};
let seq = 0;
const put = (b: Uint8Array, tag = "f") => { const f = join(tmp, `${tag}${seq++}.docx`); writeFileSync(f, b); return f; };
const oracle = (b: Uint8Array): Oracle => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_tblrev.py", put(b)], { encoding: "utf8", maxBuffer: 64 << 20 }));
const mark = (b: Uint8Array, specs: string[]) => { const out = join(tmp, `m${seq++}.docx`); execFileSync(PY, ["scripts/oracle/docx_tblrev.py", "markcells", put(b), out, ...specs]); return new Uint8Array(readFileSync(out)); };
type Xsd = { parts: Record<string, string[]>; ok: boolean };
const xsd = (bs: Uint8Array[]): Xsd[] => { const fs = bs.map((b) => put(b, "x")); const out: Record<string, Xsd> = {}; for (let i = 0; i < fs.length; i += 40) Object.assign(out, JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", ...fs.slice(i, i + 40)], { encoding: "utf8", maxBuffer: 256 << 20 }))); return fs.map((f) => out[f]); };
const xsdBad = (r: Xsd) => Object.entries(r.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e.slice(0, 2).join(" | ")}`);
const sound = (o: Oracle, m: string) => { ok(o.opens === true, `${m}: python-docx ${o.opens}`); ok(o.grid_ok, `${m}: grid ${JSON.stringify(o.grid_errors)}`); ok(o.tcpr_ok, `${m}: tcPr ${o.tcpr_errors}`); ok(o.order_ok, `${m}: trPr ${o.order_errors}`); ok(o.ids_unique, `${m}: ids ${o.ids}`); };
/** package equality except docProps/core.xml (every save stamps dcterms:modified with the current second, as Word does) */
const partsOf = (b: Uint8Array) => JSON.parse(execFileSync(PY, ["-c", "import zipfile,sys,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({i.filename: hashlib.sha256(z.read(i.filename)).hexdigest() for i in z.infolist() if i.filename!='docProps/core.xml'}))", put(b, "p")], { encoding: "utf8" })) as Record<string, string>;
const samePkg = (a: Uint8Array, b: Uint8Array, m: string) => eq(partsOf(a), partsOf(b), m);
const firstTable = (d: WordDoc) => d.blocks.find((b): b is Table => b.t === "tbl")!;
const cellPara = (t: Table, r: number, c: number) => allParas(cellsOf(rowsOf(t)[r])[c].blocks)[0];
let s = 0x64c0;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const rand = (n: number) => Math.floor(rnd() * n);

/** a table of rows×cols with text R{r}C{c} and the given grid widths, saved and re-read (a "file" table) */
async function makeFile(rows: number, cols: number, widths?: number[], extra?: (d: WordDoc, t: Table) => void): Promise<Uint8Array> {
  const d = await blankWord("Cols");
  const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Before");
  const t = E.insertTableAfter(d, p0.id, rows, cols)!;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) E.insertText(d, { pid: cellPara(t, r, c).id, off: 0 }, `R${r}C${c}`);
  if (widths) t.grid = widths.slice();
  extra?.(d, t);
  return writeWord(d);
}
type Op = "left" | "right" | "delete";
async function apply(b: Uint8Array, r: number, c: number, op: Op, tracked: boolean, author = "Ann"): Promise<{ d: WordDoc; ok: boolean; bytes: Uint8Array }> {
  const d = await readWord(b);
  if (tracked) E.setTracking(d, true, author);
  const okk = E.tableColOp(d, cellPara(firstTable(d), r, c).id, op);
  return { d, ok: okk, bytes: await writeWord(d) };
}
/** the same file saved with Track Changes switched on and nothing else (turning tracking on is itself saved: w:trackRevisions) */
async function trackedNoop(b: Uint8Array, author = "Ann"): Promise<Uint8Array> { const d = await readWord(b); E.setTracking(d, true, author); return writeWord(d); }
async function resolved(b: Uint8Array, accept: boolean, how: "all" | "one"): Promise<Uint8Array> {
  const d = await readWord(b);
  if (how === "all") E.resolveChanges(d, accept);
  else { const cs = E.revisions(d).filter((c) => c.key.startsWith("cg:")); eq(cs.length, 1, "exactly one column change"); ok(E.resolveOne(d, cs[0].key, accept), "resolveOne"); }
  return writeWord(d);
}

await test("a tracked column insert: every new cell carries w:cellIns (unique ids, author, date), the old widths go in w:tblGridChange; one '[Table column]' change; schema-valid; the file round-trips the grouping", COV, async () => {
  const B = await makeFile(3, 3, [2000, 3000, 4000]);
  const { d, ok: done, bytes: T } = await apply(B, 1, 1, "right", true);
  ok(done, "tracked insert accepted");
  const o = oracle(T); sound(o, "tracked insert");
  eq(o.cells.map((c) => [c.row, c.cell, c.kind, c.author]), [[0, 2, "cellIns", "Ann"], [1, 2, "cellIns", "Ann"], [2, 2, "cellIns", "Ann"]], "markers at the new column");
  eq(o.grids[0].change, [2000, 3000, 4000], "tblGridChange keeps the original widths");
  eq(o.grids[0].asis.length, 4, "grid has 4 columns");
  const cs = E.revisions(d);
  eq(cs.map((c) => [c.kind, c.text]), [["ins", "[Table column] "]], "one column change listed");
  ok(/Inserted column 3 \(3 cells\)/.test(cs[0].detail ?? ""), `detail: ${cs[0].detail}`);
  const d2 = await readWord(T);
  eq(E.revisions(d2).map((c) => c.key), cs.map((c) => c.key), "the reloaded file lists the same column change (same ids)");
  const [x] = xsd([T]); ok(x.ok, `XSD: ${xsdBad(x).join(" ; ")}`);
  samePkg(await writeWord(d2), T, "an untouched reload saves every part byte-identically");
  return `ids ${o.cells.map((c) => c.id).join(",")} + grid change ${o.grids[0].change_id}`;
});

await test("differential: 48 random tables × random column op (left / right / delete): oracle accept/reject views of the TRACKED file = untracked op / original; ours (Accept All, Reject All, the one column change both ways) = the same; text AND widths", COV, async () => {
  const toXsd: Uint8Array[] = []; let n = 0;
  for (let trial = 0; trial < 48; trial++) {
    const rows = 2 + rand(4), cols = 1 + rand(5);
    const widths = Array.from({ length: cols }, () => 600 + rand(5000));
    const B = await makeFile(rows, cols, widths);
    const r = rand(rows), c = rand(cols); const op = (["left", "right", "delete"] as const)[rand(3)];
    const U = (await apply(B, r, c, op, false)).bytes;
    const t = await apply(B, r, c, op, true);
    ok(t.ok, `trial ${trial}: tracked ${op} refused`);
    const T = t.bytes; toXsd.push(T);
    const oT = oracle(T), oU = oracle(U), oB = oracle(B);
    sound(oT, `trial ${trial} tracked`);
    const m = `trial ${trial} (${rows}×${cols} ${op} at ${r},${c})`;
    const acc = oU, rej = oB; // accept → the untracked op, reject → the original (both kinds)
    // the independent oracle's views of the tracked file
    eq(oT.accept, acc.accept, `${m}: oracle accept-all text = untracked`);
    eq(oT.reject, rej.accept, `${m}: oracle reject-all text = original`);
    if (acc.grids.length) eq(oT.grids[0].accept, acc.grids[0].asis, `${m}: oracle accept-all widths`); else eq(oT.grids.length ? oT.grids[0].accept.length : 0, 0, `${m}: table gone on accept`);
    eq(oT.grids[0].reject, rej.grids[0].asis, `${m}: oracle reject-all widths = original`);
    // ours, four ways
    for (const [accept, how] of [[true, "all"], [false, "all"], [true, "one"], [false, "one"]] as const) {
      const R = await resolved(T, accept, how); const oR = oracle(R); sound(oR, `${m} ${accept ? "accept" : "reject"} ${how}`);
      const want = accept ? acc : rej;
      eq(oR.accept, want.accept, `${m}: ours ${accept ? "accept" : "reject"} ${how} text`);
      eq(oR.grids.map((g) => g.asis), want.grids.map((g) => g.asis), `${m}: ours ${accept ? "accept" : "reject"} ${how} widths`);
      eq(oR.cells.length + oR.grids.filter((g) => g.change).length, 0, `${m}: nothing left pending`);
      n++;
    }
  }
  const bad = xsd(toXsd).map((x, i) => (x.ok ? "" : `#${i}: ${xsdBad(x).join(" ; ")}`)).filter(Boolean);
  ok(!bad.length, `XSD: ${bad.slice(0, 3).join(" | ")}`);
  return `48 trials · ${n} resolutions equal the untracked / original table · 48 tracked packages schema-valid`;
});

await test("sequences: two tracked inserts then a tracked delete; resolving in mixed orders; Reject All returns the ORIGINAL widths exactly; the author's own pending column deletes outright", COV, async () => {
  const B = await makeFile(3, 3, [5000, 2600, 2000]); // 9600 > text width once widened → inserts rescale
  let d = await readWord(B); E.setTracking(d, true, "Ann");
  const t = firstTable(d);
  ok(E.tableColOp(d, cellPara(t, 0, 0).id, "left"), "insert A"); ok(E.tableColOp(d, cellPara(t, 0, 3).id, "right"), "insert B");
  ok(E.tableColOp(d, cellPara(t, 0, 2).id, "delete"), "delete original column 2 (now index 2)");
  const T = await writeWord(d); const oT = oracle(T); sound(oT, "seq");
  eq(oT.grids[0].change, [5000, 2600, 2000], "one grid change, the original widths");
  const ch = E.revisions(d).map((c) => [c.kind, c.text]);
  eq(ch, [["ins", "[Table column] "], ["del", "[Table column] "], ["ins", "[Table column] "]], "three column changes, document order");
  // reject all → the original exactly
  const Rj = oracle(await resolved(T, false, "all")); const oB = oracle(B);
  eq(Rj.accept, oB.accept, "reject all text"); eq(Rj.grids[0].asis, [5000, 2600, 2000], "reject all widths = original");
  eq(oT.grids[0].reject, [5000, 2600, 2000], "the oracle agrees");
  // accept all → the untracked sequence
  let u = await readWord(B); const tu = firstTable(u);
  E.tableColOp(u, cellPara(tu, 0, 0).id, "left"); E.tableColOp(u, cellPara(tu, 0, 3).id, "right"); E.tableColOp(u, cellPara(tu, 0, 2).id, "delete");
  const oU = oracle(await writeWord(u)); const Ac = oracle(await resolved(T, true, "all"));
  eq(Ac.accept, oU.accept, "accept all text = untracked sequence"); eq(Ac.grids[0].asis, oU.grids[0].asis, "accept all widths = untracked sequence");
  eq(oT.grids[0].accept, oU.grids[0].asis, "the oracle agrees (accept)");
  // mixed: accept B, reject A, reject the delete
  d = await readWord(T); const keys = E.revisions(d).map((c) => c.key);
  ok(E.resolveOne(d, keys[2], true), "accept B"); ok(E.resolveOne(d, keys[0], false), "reject A"); ok(E.resolveOne(d, keys[1], false), "reject delete");
  const oM = oracle(await writeWord(d)); sound(oM, "mixed");
  eq(oM.accept[0].map((row) => row.length), [4, 4, 4], "original 3 + B");
  eq(oM.grids[0].change, null, "grid change settled");
  // own pending column: deleting it while tracking removes it outright (no cellDel on a cellIns)
  u = await readWord(B); E.setTracking(u, true, "Ann"); const t2 = firstTable(u);
  E.tableColOp(u, cellPara(t2, 1, 1).id, "right");
  ok(E.tableColOp(u, cellPara(t2, 1, 2).id, "delete"), "own pending column delete");
  const oO = oracle(await writeWord(u)); eq(oO.cells.length, 0, "no marks left"); eq(oO.grids[0].asis, [5000, 2600, 2000], "original widths back"); eq(oO.grids[0].change, null, "no grid change");
  return "3 changes; reject-all = original widths; accept-all = untracked sequence; own pending column removed outright";
});

await test("refusals and boundaries: a merged cell across the column / another reviewer's pending cell → tracked delete refused (document unchanged, message names Track Changes); 1-row tables stay per-cell; tracked rows + columns together", COV, async () => {
  // merged (gridSpan 2) cell in row 0 covering columns 0–1
  const B = await makeFile(2, 3, undefined, (_d, t) => { const r0 = rowsOf(t)[0]; const cs = cellsOf(r0); cs[0].span = 2; r0.items.splice(r0.items.indexOf(cs[1]), 1); });
  const d0 = await readWord(B); const merged = cellsOf(rowsOf(firstTable(d0))[0]).some((c) => c.span > 1);
  {
    const r = await apply(B, 1, 0, "delete", true);
    ok(!r.ok, "delete across a merged cell refused"); samePkg(r.bytes, await trackedNoop(B), "document unchanged");
  }
  ok(E.COLUMN_TRACK_REFUSAL.includes("Track Changes") && E.COLUMN_TRACK_REFUSAL.includes("merged"), "message explains");
  // another reviewer's pending inserted column: Bob's tracked delete of it is refused (Ann's cellIns stays)
  const B2 = await makeFile(2, 2);
  const a = await apply(B2, 0, 0, "right", true, "Ann");
  const bob = await apply(a.bytes, 0, 1, "delete", true, "Bob");
  ok(!bob.ok, "Bob cannot track-delete Ann's pending column"); samePkg(bob.bytes, await trackedNoop(a.bytes, "Bob"), "unchanged");
  // 1-row table: per-cell semantics (TT61): listed as a cell change, reject keeps the row filling the grid (gridAfter)
  const B3 = await makeFile(1, 2);
  const one = await apply(B3, 0, 0, "right", true);
  eq(E.revisions(one.d).map((c) => c.text), ["[Table cell] "], "1-row: a cell change");
  const o1 = oracle(await resolved(one.bytes, false, "all")); sound(o1, "1-row reject"); eq(o1.accept, oracle(B3).accept, "1-row reject text");
  // tracked row insert + tracked column insert: reject all = original, accept all = both untracked
  const B4 = await makeFile(2, 2, [3000, 3000]);
  const d4 = await readWord(B4); E.setTracking(d4, true, "Ann"); const t4 = firstTable(d4);
  E.tableRowOp(d4, cellPara(t4, 0, 0).id, "below"); E.tableColOp(d4, cellPara(t4, 0, 1).id, "right");
  const T4 = await writeWord(d4); sound(oracle(T4), "row+col");
  const r4 = oracle(await resolved(T4, false, "all")); eq(r4.accept, oracle(B4).accept, "row+col reject all text"); eq(r4.grids[0].asis, [3000, 3000], "row+col reject widths");
  const u4 = await readWord(B4); const tu4 = firstTable(u4); E.tableRowOp(u4, cellPara(tu4, 0, 0).id, "below"); E.tableColOp(u4, cellPara(tu4, 0, 1).id, "right");
  const a4 = oracle(await resolved(T4, true, "all")); const ou4 = oracle(await writeWord(u4));
  eq(a4.accept, ou4.accept, "row+col accept all text"); eq(a4.grids[0].asis, ou4.grids[0].asis, "row+col accept widths");
  const [x] = xsd([T4, a.bytes]); ok(x.ok, `XSD ${xsdBad(x)}`);
  ok(merged, "fixture has a merged cell");
  return `merged-cell refusal · cross-reviewer refusal · 1-row per-cell · rows+columns`;
});

await test("files from the independent writer: a whole column marked cellDel / cellIns by markcells (lxml) is listed as one column change and resolves to the oracle's views; mixed authors in one column stay per-cell; file revision ids are reserved; a width-only w:tblGridChange settles on Accept / Reject All", COV, async () => {
  const B = await makeFile(3, 3, [1500, 2500, 3500]);
  const M = mark(B, ["0,0,1,del,901", "0,1,1,del,902", "0,2,1,del,903"]);
  const d = await readWord(M); const cs = E.revisions(d);
  eq(cs.map((c) => [c.key, c.kind, c.text]), [["cg:901,902,903", "del", "[Table column] "]], "one column change from the file");
  const oM = oracle(M);
  const A = oracle(await resolved(M, true, "one")); eq(A.accept, oM.accept, "accept text = oracle"); eq(A.grids[0].asis, oM.grids[0].accept, "accept widths = oracle");
  eq(A.grids[0].asis, [1500, 3500], "column 2 gone with its width");
  const R = oracle(await resolved(M, false, "all")); eq(R.accept, oM.reject, "reject text = oracle"); eq(R.grids[0].asis, [1500, 2500, 3500], "reject widths");
  // a column whose cells were marked by different authors is not one operation: cell semantics
  const M2 = mark(B, ["0,0,2,ins,911", "0,1,2,ins,912", "0,2,2,ins,913"]);
  const x = execFileSync(PY, ["-c", `import zipfile,sys
src,dst=sys.argv[1],sys.argv[2]
z=zipfile.ZipFile(src); out=zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED)
for i in z.infolist():
    b=z.read(i.filename)
    if i.filename=='word/document.xml': b=b.replace(b'w:id="912" w:author="Oracle"', b'w:id="912" w:author="Other"')
    out.writestr(i,b)
out.close()`, put(M2), join(tmp, "mixed.docx")]);
  void x;
  const M3 = new Uint8Array(readFileSync(join(tmp, "mixed.docx")));
  const d3 = await readWord(M3);
  eq(E.revisions(d3).map((c) => c.text), ["[Table cell] ", "[Table cell] ", "[Table cell] "], "mixed authors: three cell changes");
  eq(oracle(M3).grids[0].reject, [1500, 2500, 3500], "oracle: no whole column either (widths as is)");
  // existing cell-revision ids from a file are reserved: low ids (1, 2) from another tool never collide with the new marks
  const L = mark(B, ["0,0,0,del,1", "0,2,2,ins,2"]);
  const dl = await readWord(L); E.setTracking(dl, true, "Ann");
  ok(E.tableColOp(dl, cellPara(firstTable(dl), 1, 1).id, "right"), "tracked insert next to file revisions");
  const oL = oracle(await writeWord(dl)); sound(oL, "low ids"); ok(oL.ids_unique, `ids unique: ${oL.ids}`);
  // another tool's duplicate cell-marker ids are renumbered on save (§17.13.5: annotation ids are unique); both stay reviewable
  const Dup = mark(B, ["0,0,0,del,5", "0,1,2,ins,5"]); ok(!oracle(Dup).ids_unique, "fixture has a duplicate id");
  const dd = await readWord(Dup); const oD = oracle(await writeWord(dd)); ok(oD.ids_unique, `renumbered: ${oD.ids}`); eq(oD.cells.length, 2, "both markers kept");
  // a tracked grid change with no cell revision (a width-only change, as Word writes it) settles on Accept All / Reject All
  const inject = (b: Uint8Array, name: string) => {
    execFileSync(PY, ["-c", `import zipfile,sys
src,dst=sys.argv[1],sys.argv[2]
z=zipfile.ZipFile(src); out=zipfile.ZipFile(dst,'w',zipfile.ZIP_DEFLATED)
for i in z.infolist():
    b=z.read(i.filename)
    if i.filename=='word/document.xml': b=b.replace(b'</w:tblGrid>', b'<w:tblGridChange w:id="77"><w:tblGrid><w:gridCol w:w="1000"/><w:gridCol w:w="1100"/><w:gridCol w:w="1200"/></w:tblGrid></w:tblGridChange></w:tblGrid>',1)
    out.writestr(i,b)
out.close()`, put(b), join(tmp, name)]);
    return new Uint8Array(readFileSync(join(tmp, name)));
  };
  const G = inject(B, "gridonly.docx"); const oG = oracle(G); sound(oG, "grid-only");
  eq(oG.grids[0].change, [1000, 1100, 1200], "fixture carries the grid change"); eq((await readWord(G)).blocks.some((b) => b.t === "tbl" && !!b.gridChange), true, "parsed");
  const [xg] = xsd([G]); ok(xg.ok, `fixture XSD ${xsdBad(xg)}`);
  const GA = oracle(await resolved(G, true, "all")); eq(GA.grids[0].change, null, "accept all: grid change gone"); eq(GA.grids[0].asis, oG.grids[0].accept, "accept all widths = oracle");
  const GR = oracle(await resolved(G, false, "all")); eq(GR.grids[0].change, null, "reject all: grid change gone"); eq(GR.grids[0].asis, oG.grids[0].reject, "reject all widths = oracle (recorded widths)");
  eq(GR.grids[0].asis, [1000, 1100, 1200], "reject = recorded widths");
  return "markcells column → one change; mixed authors → per-cell; file ids reserved; width-only grid change settles both ways (ours = oracle)";
});

await test("TT64 fix — rows with w:gridBefore / w:gridAfter: column operations address GRID columns (they used to count from the row's first cell); untracked and tracked, every column, both directions, vs hand-derived tables and the oracle", COV, async () => {
  // 3 grid columns; row 1 starts with one empty grid column (gridBefore 1: cells R1C1, R1C2), row 2 ends with one (gridAfter 1: R2C0, R2C1)
  const B = await makeFile(3, 3, [2000, 2400, 2800], (_d, t) => {
    const [, r1, r2] = rowsOf(t);
    r1.items.splice(r1.items.indexOf(cellsOf(r1)[0]), 1); r1.items.unshift(el("w:trPr", {}, [el("w:gridBefore", { "w:val": "1" })]));
    r2.items.splice(r2.items.indexOf(cellsOf(r2)[2]), 1); r2.items.unshift(el("w:trPr", {}, [el("w:gridAfter", { "w:val": "1" })]));
  });
  const oB = oracle(B); sound(oB, "fixture");
  eq(oB.accept, [[["R0C0", "R0C1", "R0C2"], ["R1C1", "R1C2"], ["R2C0", "R2C1"]]], "fixture shape");
  // deleting grid column g: hand-derived expectation
  const del: Record<number, string[][]> = { 0: [["R0C1", "R0C2"], ["R1C1", "R1C2"], ["R2C1"]], 1: [["R0C0", "R0C2"], ["R1C2"], ["R2C0"]], 2: [["R0C0", "R0C1"], ["R1C1"], ["R2C0", "R2C1"]] };
  const at: Record<number, [number, number]> = { 0: [0, 0], 1: [1, 0], 2: [1, 1] }; // a cell in grid column g: (row, cell index)
  let n = 0;
  for (const g of [0, 1, 2]) {
    const [r, c] = at[g];
    const U = await apply(B, r, c, "delete", false); ok(U.ok, `untracked delete ${g}`);
    const oU = oracle(U.bytes); sound(oU, `untracked delete ${g}`);
    eq(oU.accept, [del[g]], `untracked delete of grid column ${g}`);
    eq(oU.grids[0].asis, [2000, 2400, 2800].filter((_, i) => i !== g), `widths after deleting ${g}`);
    // tracked: rows with an empty grid slot at the column are part of it (nothing to mark there) → = untracked on accept, original on reject
    const T = await apply(B, r, c, "delete", true);
    ok(T.ok, `tracked delete of column ${g}`); const oT = oracle(T.bytes); sound(oT, `tracked delete ${g}`);
    eq(E.revisions(await readWord(T.bytes)).map((x) => x.text), ["[Table column] "], `column ${g}: one column change`);
    eq(oT.accept, oU.accept, "oracle accept = untracked"); eq(oT.grids[0].accept, oU.grids[0].asis, "oracle accept widths");
    for (const how of ["all", "one"] as const) {
      const R = oracle(await resolved(T.bytes, true, how)); sound(R, "accept del"); eq(R.accept, oU.accept, `ours accept (${how}) = untracked`); eq(R.grids[0].asis, oU.grids[0].asis, "ours accept widths");
      const J = oracle(await resolved(T.bytes, false, how)); sound(J, "reject del"); eq(J.accept, oB.accept, `ours reject (${how}) = original`); eq(J.grids[0].asis, [2000, 2400, 2800], "reject widths");
    }
    // inserts on both sides: every row still fills the grid, tracked reject = original, tracked accept = untracked
    for (const op of ["left", "right"] as const) {
      const Ui = await apply(B, r, c, op, false); const oUi = oracle(Ui.bytes); sound(oUi, `untracked ${op} ${g}`);
      const Ti = await apply(B, r, c, op, true); ok(Ti.ok, `tracked ${op}`); const oTi = oracle(Ti.bytes); sound(oTi, `tracked ${op} ${g}`);
      eq(oTi.grids[0].reject, [2000, 2400, 2800], `oracle reject widths (${op} at ${g})`); eq(oTi.grids[0].accept, oUi.grids[0].asis, `oracle accept widths (${op} at ${g})`);
      const Rr = oracle(await resolved(Ti.bytes, false, "all")); sound(Rr, "reject"); eq(Rr.accept, oB.accept, `tracked ${op} at ${g} rejected = original`); eq(Rr.grids[0].asis, [2000, 2400, 2800], "original widths again");
      const Ra = oracle(await resolved(Ti.bytes, true, "all")); sound(Ra, "accept"); eq(Ra.accept, oUi.accept, `tracked ${op} at ${g} accepted = untracked`); eq(Ra.grids[0].asis, oUi.grids[0].asis, "accept widths");
      n += 2;
    }
  }
  // TT64 repair (found by e2e-tt61): a LONE marked cell next to other rows' empty gridAfter slot is a cell change (TT61), not a
  // column — row 0 = R0C0, R0C1 + gridAfter 1; row 1 = R1C0, R1C1, R1C2 with R1C2 cellIns (independent writer)
  const G = await makeFile(2, 3, [2000, 2400, 2800], (_d, t) => {
    const [r0] = rowsOf(t); r0.items.splice(r0.items.indexOf(cellsOf(r0)[2]), 1); r0.items.unshift(el("w:trPr", {}, [el("w:gridAfter", { "w:val": "1" })]));
  });
  const L1 = mark(G, ["0,1,2,ins,921"]);
  eq(E.revisions(await readWord(L1)).map((x) => x.text), ["[Table cell] "], "a lone cellIns beside an empty gridAfter slot stays ONE cell change");
  eq(E.columnGroups(await readWord(L1)).length, 0, "no column group for one marked cell");
  const oL = oracle(L1); eq(oL.grids[0].reject, [2000, 2400, 2800], "oracle: a lone cell keeps its grid column on reject");
  const LR = oracle(await resolved(L1, false, "all")); sound(LR, "lone cell reject");
  eq(LR.accept, [[["R0C0", "R0C1"], ["R1C0", "R1C1"]]], "Reject All removes the cell (per-cell, gridAfter pads)"); eq(LR.grids[0].asis, [2000, 2400, 2800], "grid kept");
  // ...and OUR tracked op at such a column is refused (it would record a lone cell, whose per-cell reject leaves the column behind)
  for (const op of ["left", "right", "delete"] as const) {
    const T = await apply(G, 1, 2, op, true); ok(!T.ok, `tracked ${op} where only one row has a cell is refused`);
    samePkg(T.bytes, await trackedNoop(G), `refused ${op}: document unchanged`);
    ok((await apply(G, 1, 2, op, false)).ok, `untracked ${op} still works`);
  }
  ok(E.COLUMN_TRACK_REFUSAL.includes("only one row"), "the message names the reason");
  return `3 grid columns × delete / left / right · ${n} tracked resolutions vs untracked · rows keep filling the grid · lone marked cell stays a cell; tracked op there refused`;
});

await finish();
