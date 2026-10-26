/**
 * TT60 Writer table revisions — tracked row insertion / deletion (w:trPr/w:ins, w:trPr/w:del, ECMA-376 §17.13.5.17/.14),
 * nested ins+del rows, per-change accept / reject, table / row / cell property change records (w:tblPrChange,
 * w:trPrChange, w:tcPrChange) and the "columns are not tracked" refusal — verified against an INDEPENDENT oracle
 * (scripts/oracle/docx_tblrev.py: lxml + python-docx; CT_TrPr ordering, id uniqueness, accept-all / reject-all views).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt60-writer-tblrev.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { writeZip } from "../src/lib/office/zipkit.ts";
import { readWord, writeWord, blankWord, allParas, rowsOf, cellsOf, type WordDoc, type Table, type Block } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";

const { test, finish } = makeHarness("tt60-writer-tblrev");
const COV = { "FF-40": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt60t-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
type Mark = { kind: string; id: string; author: string; date: string | null };
type Oracle = {
  opens: boolean | string; tables: string[][][]; rows: { table: number; row: number; marks: Mark[]; text: string[] }[];
  pr_changes: { kind: string; id: string; author: string; old: Record<string, string | null> }[];
  props: { style: string | null; rows: { height: string | null; fills: (string | null)[] }[] }[];
  order_ok: boolean; order_errors: string[]; ids_unique: boolean; ids: string[]; accept: string[][][]; reject: string[][][];
};
let seq = 0;
const oracle = (bytes: Uint8Array): Oracle => {
  const f = join(tmp, `o${seq++}.docx`); writeFileSync(f, bytes);
  return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_tblrev.py", f], { encoding: "utf8", maxBuffer: 64 << 20 }));
};
const te = new TextEncoder();
/** top-level tables as [[cell text]] (our model, no revision processing beyond what is already resolved) */
function ours(d: WordDoc): string[][][] {
  return d.blocks.filter((b): b is Table => b.t === "tbl").map((t) => rowsOf(t).map((r) => cellsOf(r).map((c) => allParas(c.blocks).map((p) => p.content.map((it) => (it.t === "r" && it.rev?.kind !== "del" ? it.text : "")).join("")).join("\n"))));
}
const firstTable = (d: WordDoc) => d.blocks.find((b): b is Table => b.t === "tbl")!;
const cellPara = (t: Table, r: number, c: number) => allParas(cellsOf(rowsOf(t)[r])[c].blocks)[0];
const reopen = async (d: WordDoc) => readWord(await writeWord(d));

/** A 4×2 table filled untracked, then Alice (tracking) inserts a row below row 0 and types into it, deletes row 2. */
async function session(): Promise<WordDoc> {
  const d = await blankWord("Rows");
  const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Before");
  const t = E.insertTableAfter(d, p0.id, 4, 2)!;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) E.insertText(d, { pid: cellPara(t, r, c).id, off: 0 }, `R${r}C${c}`);
  E.setTracking(d, true, "Alice");
  ok(E.tableRowOp(d, cellPara(t, 0, 0).id, "below"), "insert below");
  E.insertText(d, { pid: cellPara(t, 1, 0).id, off: 0 }, "new A");
  E.insertText(d, { pid: cellPara(t, 1, 1).id, off: 0 }, "new B");
  ok(E.tableRowOp(d, cellPara(t, 3, 0).id, "delete"), "tracked delete of R2");
  return d;
}
const ORIGINAL = [[["R0C0", "R0C1"], ["R1C0", "R1C1"], ["R2C0", "R2C1"], ["R3C0", "R3C1"]]];
const FINAL = [[["R0C0", "R0C1"], ["new A", "new B"], ["R1C0", "R1C1"], ["R3C0", "R3C1"]]];

if (!existsSync(PY)) { console.log("python venv missing — run scripts/sandbox/bootstrap.sh"); process.exit(1); }

await test("recording: an inserted row is w:trPr/w:ins and a deleted row w:trPr/w:del with its text as w:delText (oracle); CT_TrPr order; ids unique; python-docx opens", COV, async () => {
  const d = await session();
  const t = firstTable(d);
  eq(rowsOf(t).length, 5, "a tracked deletion keeps the row in the document");
  const o = oracle(await writeWord(d));
  eq(o.opens, true, "python-docx open");
  ok(o.order_ok, "schema order: " + o.order_errors.join("; "));
  ok(o.ids_unique, "ids not unique: " + o.ids.join(","));
  eq(o.rows.map((r) => [r.row, r.marks.map((m) => `${m.kind}|${m.author}`)]), [[1, ["ins|Alice"]], [3, ["del|Alice"]]], "tracked rows");
  for (const r of o.rows) for (const m of r.marks) ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(m.date ?? ""), "w:date " + m.date);
  eq(o.rows[1].text, ["", ""], "the deleted row's text is struck (w:delText), not plain text");
  eq(o.accept, FINAL, "oracle accept-all");
  eq(o.reject, ORIGINAL, "oracle reject-all");
  // our review list: row insertion, inserted text, row deletion, deleted text (+ the inserted new-row text is one change)
  const kinds = E.revisions(d).map((c) => `${c.kind}:${c.text.startsWith("[Table row]") ? "row" : "text"}`);
  ok(kinds.includes("ins:row") && kinds.includes("del:row"), "revisions() lists the rows: " + kinds.join(","));
});

await test("accept-all / reject-all (ours) equal the oracle's independent views, live and after save → re-open", COV, async () => {
  for (const re of [false, true]) for (const accept of [true, false]) {
    let d = await session();
    if (re) d = await reopen(d);
    const n = E.resolveChanges(d, accept);
    ok(n >= (accept ? 4 : 2), `resolved ${n}`);
    eq(E.revisions(d).length, 0, "nothing left to review");
    eq(ours(d), accept ? FINAL : ORIGINAL, `${re ? "re-opened" : "live"} ${accept ? "accept" : "reject"}`);
    const o = oracle(await writeWord(d));
    eq(o.rows.length, 0, "no tracked rows remain in the file");
    eq(o.accept, o.reject, "a fully resolved file has one view");
    eq(o.accept, accept ? FINAL : ORIGINAL, "oracle agrees after save");
    ok(o.order_ok, o.order_errors.join(";"));
  }
});

await test("per-change review: rejecting the row deletion restores the row AND its struck text in one action; accepting the row insertion keeps it", COV, async () => {
  const d = await session();
  const rows = E.revisions(d).filter((c) => c.text.startsWith("[Table row]"));
  const del = rows.find((c) => c.kind === "del")!, ins = rows.find((c) => c.kind === "ins")!;
  ok(E.resolveOne(d, del.key, false), "reject row deletion");
  ok(!E.revisions(d).some((c) => c.kind === "del"), "the deletion's text went with the row deletion");
  ok(E.resolveOne(d, ins.key, true), "accept row insertion");
  eq(rowsOf(firstTable(d)).every((r) => !r.rev), true, "no row marks remain");
  // the typed text in the inserted row is its own (still pending) insertion
  ok(E.revisions(d).some((c) => c.kind === "ins" && c.text.includes("new A")), "typed text is still reviewable");
  E.resolveChanges(d, true);
  eq(ours(d), [[["R0C0", "R0C1"], ["new A", "new B"], ["R1C0", "R1C1"], ["R2C0", "R2C1"], ["R3C0", "R3C1"]]], "mixed outcome");
  const o = oracle(await writeWord(d));
  eq(o.tables, ours(d)[0] ? [ours(d)[0]] : [], "python-docx sees the same table");
  ok(!E.resolveOne(d, del.key, true), "a resolved key no longer exists");
});

await test("own pending inserted row is deleted outright; another reviewer's inserted row deleted → w:ins + w:del on one row (nested), each reviewable", COV, async () => {
  const d = await session();
  const t = firstTable(d);
  // Alice deletes her own inserted row (row 1): it simply goes, no marks
  ok(E.tableRowOp(d, cellPara(t, 1, 0).id, "delete"), "own row delete");
  eq(rowsOf(t).length, 4, "own inserted row removed physically");
  // Alice inserts another row, Bob deletes it
  ok(E.tableRowOp(d, cellPara(t, 0, 0).id, "above"), "insert above");
  E.insertText(d, { pid: cellPara(t, 0, 0).id, off: 0 }, "alice row");
  E.setTracking(d, true, "Bob");
  ok(E.tableRowOp(d, cellPara(t, 0, 0).id, "delete"), "Bob deletes Alice's row");
  const r0 = rowsOf(t)[0];
  ok(r0.rev?.kind === "del" && r0.rev.author === "Bob" && r0.rev.ins?.author === "Alice", "nested row rev " + JSON.stringify(r0.rev));
  ok(!E.tableRowOp(d, cellPara(t, 0, 0).id, "delete"), "deleting an already-deleted row is no change");
  const o = oracle(await writeWord(d));
  ok(o.order_ok, "ins before del in trPr: " + o.order_errors.join(";"));
  eq(o.rows[0].marks.map((m) => `${m.kind}|${m.author}`), ["ins|Alice", "del|Bob"], "both marks written");
  // re-open keeps the nesting; rejecting Bob's deletion leaves Alice's insertion pending
  const d2 = await reopen(d);
  const r2 = rowsOf(firstTable(d2))[0];
  ok(r2.rev?.kind === "del" && r2.rev.ins?.kind === "ins", "re-read nesting");
  const bobKey = E.revisions(d2).find((c) => c.kind === "del" && c.author === "Bob" && c.text.startsWith("[Table row]"))!.key;
  ok(E.resolveOne(d2, bobKey, false), "reject Bob");
  eq(rowsOf(firstTable(d2))[0].rev?.kind, "ins", "Alice's insertion still pending");
  const aliceKey = E.revisions(d2).find((c) => c.kind === "ins" && c.text.startsWith("[Table row]"))!.key;
  ok(E.resolveOne(d2, aliceKey, false), "reject Alice's row");
  eq(rowsOf(firstTable(d2)).length, 4, "row gone");
});

await test("deleting the last remaining rows tracked then accepting removes the table (an empty paragraph remains); TT64: a tracked column insert is a reviewable change", COV, async () => {
  const d = await blankWord("T");
  const p0 = allParas(d.blocks)[0];
  const t = E.insertTableAfter(d, p0.id, 1, 2)!;
  E.insertText(d, { pid: cellPara(t, 0, 0).id, off: 0 }, "only");
  E.setTracking(d, true, "Ann");
  // TT64 (supersedes the TT60 refusal): the insert is recorded with w:cellIns and listed as one column change; rejecting it restores the grid
  {
    const d3 = await blankWord("C"); const t3 = E.insertTableAfter(d3, allParas(d3.blocks)[0].id, 2, 2)!; E.setTracking(d3, true, "Ann");
    ok(E.tableColOp(d3, cellPara(t3, 0, 0).id, "right"), "tracked column insert");
    eq(t3.grid.length, 3, "grid grew");
    const colCh = E.revisions(d3).find((c) => c.key.startsWith("cg:"));
    ok(colCh && colCh.kind === "ins" && colCh.text.includes("column"), `one column change listed: ${JSON.stringify(E.revisions(d3).map((c) => c.key))}`);
    ok(E.resolveOne(d3, colCh!.key, false), "reject the column");
    eq(t3.grid.length, 2, "grid back to 2 columns");
  }
  ok(E.COLUMN_TRACK_REFUSAL.includes("Track Changes"), "the remaining refusal message names the setting");
  ok(E.tableRowOp(d, cellPara(t, 0, 0).id, "delete"), "tracked delete of the only row keeps the table");
  ok(d.blocks.includes(t), "table still there (pending)");
  E.resolveChanges(d, true);
  ok(!d.blocks.some((b: Block) => b.t === "tbl"), "table removed on accept");
  ok(d.blocks.some((b) => b.t === "p"), "a paragraph remains");
  E.setTracking(d, false);
  const t2 = E.insertTableAfter(d, allParas(d.blocks)[0].id, 1, 2)!;
  ok(E.tableColOp(d, cellPara(t2, 0, 0).id, "right"), "untracked column insert works");
  eq(t2.grid.length, 3, "3 columns");
});

/** A spec-built document (ECMA-376 Part 1 §17.13.5.34–.37 examples): property change records on a table, a row and a cell. */
function specDoc(): Promise<Uint8Array> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const tc = (t: string, pr = "") => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/>${pr}</w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const body = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="4000" w:type="dxa"/><w:tblPrChange w:id="21" w:author="Rex" w:date="2026-01-02T03:04:05Z"><w:tblPr><w:tblStyle w:val="LightList"/><w:tblW w:w="4000" w:type="dxa"/></w:tblPr></w:tblPrChange></w:tblPr>`
    + `<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>`
    + `<w:tr><w:trPr><w:trHeight w:val="600"/><w:trPrChange w:id="22" w:author="Rex" w:date="2026-01-02T03:04:05Z"><w:trPr><w:trHeight w:val="300"/></w:trPr></w:trPrChange></w:trPr>${tc("a1")}${tc("b1", '<w:shd w:val="clear" w:color="auto" w:fill="FFFF00"/><w:tcPrChange w:id="23" w:author="Rex" w:date="2026-01-02T03:04:05Z"><w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="00FF00"/></w:tcPr></w:tcPrChange>')}</w:tr>`
    + `<w:tr><w:trPr><w:cantSplit/><w:ins w:id="24" w:author="Rex" w:date="2026-01-02T03:04:05Z"/></w:trPr>${tc("a2")}${tc("b2")}</w:tr>`
    + `</w:tbl><w:p/><w:sectPr/>`;
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": te.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    "_rels/.rels": te.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/document.xml": te.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
  };
  return writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}

await test("spec-built file: table / row / cell property changes and a row insertion are listed; untouched save keeps them; accept drops the record; reject restores the recorded properties (oracle)", COV, async () => {
  const src = await specDoc();
  const o0 = oracle(src);
  eq(o0.pr_changes.map((p) => p.kind), ["tblPrChange", "trPrChange", "tcPrChange"], "fixture sanity (oracle)");
  const d = await readWord(src);
  const rv = E.revisions(d);
  eq(rv.filter((c) => c.key.startsWith("x:")).map((c) => c.detail), ["Table properties", "Row properties", "Cell properties"], "property changes listed in document order");
  ok(rv.some((c) => c.kind === "ins" && c.text.startsWith("[Table row]") && c.author === "Rex"), "row insertion listed");
  // untouched round trip
  const o1 = oracle(await writeWord(await readWord(src)));
  eq(o1.pr_changes, o0.pr_changes, "records survive an untouched save");
  eq(o1.rows.map((r) => r.marks.map((m) => `${m.kind}:${m.id}`)), [["ins:24"]], "row mark survives");
  ok(o1.order_ok, o1.order_errors.join(";"));
  // accept all
  const da = await readWord(src); E.resolveChanges(da, true);
  const oa = oracle(await writeWord(da));
  eq(oa.pr_changes.length, 0, "accept removes the records");
  eq([oa.props[0].style, oa.props[0].rows[0].height, oa.props[0].rows[0].fills[1]], ["TableGrid", "600", "FFFF00"], "accepted = current properties");
  eq(oa.rows.length, 0, "row insertion accepted"); eq(oa.tables[0].length, 2, "2 rows");
  // reject all
  const dr = await readWord(src); E.resolveChanges(dr, false);
  const or = oracle(await writeWord(dr));
  eq(or.pr_changes.length, 0, "reject removes the records");
  eq([or.props[0].style, or.props[0].rows[0].height, or.props[0].rows[0].fills[1]], ["LightList", "300", "00FF00"], "rejected = recorded properties");
  eq(or.tables[0].length, 1, "inserted row rejected");
  ok(or.order_ok, or.order_errors.join(";"));
  eq(firstTable(dr).style, "LightList", "the model's table style follows the rejection");
  eq(cellsOf(rowsOf(firstTable(dr))[0])[1].fill, "00FF00", "the model's cell fill follows the rejection");
});

await test("randomized: 40 tracked row edit sessions — our accept-all / reject-all equal the oracle's views of the saved file; order and ids always valid", COV, async () => {
  let rnd = 0x60ab1e;
  const rand = (n: number) => { rnd = (rnd * 1103515245 + 12345) >>> 0; return Math.floor((rnd / 2 ** 32) * n); };
  for (let trial = 0; trial < 40; trial++) {
    const d = await blankWord("R");
    const p0 = allParas(d.blocks)[0];
    const t = E.insertTableAfter(d, p0.id, 2 + rand(3), 2 + rand(2))!;
    rowsOf(t).forEach((r, ri) => cellsOf(r).forEach((c, ci) => E.insertText(d, { pid: allParas(c.blocks)[0].id, off: 0 }, `t${ri}.${ci}`)));
    const authors = ["Ann", "Ben"];
    for (let step = 0; step < 6; step++) {
      E.setTracking(d, true, authors[rand(2)]);
      const rows = rowsOf(t); const r = rand(rows.length); const pid = allParas(cellsOf(rows[r])[0].blocks)[0].id;
      const op = (["above", "below", "delete", "delete"] as const)[rand(4)];
      E.tableRowOp(d, pid, op);
      if (op !== "delete" && rand(2)) { const nr = rowsOf(t)[op === "above" ? r : r + 1]; E.insertText(d, { pid: allParas(cellsOf(nr)[0].blocks)[0].id, off: 0 }, `n${trial}.${step}`); }
    }
    const bytes = await writeWord(d);
    const o = oracle(bytes);
    ok(o.order_ok && o.ids_unique && o.opens === true, `trial ${trial}: ${o.order_errors.join(";")} ids ${o.ids.join(",")}`);
    for (const accept of [true, false]) {
      const x = await readWord(bytes); E.resolveChanges(x, accept);
      eq(ours(x), accept ? o.accept : o.reject, `trial ${trial} ${accept ? "accept" : "reject"}`);
    }
  }
});

await finish();
