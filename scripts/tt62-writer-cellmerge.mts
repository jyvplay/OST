/**
 * TT62 Writer vertical-merge revisions — w:cellMerge (ECMA-376 §17.13.5.3) in w:tcPr records that a cell's vertical merge
 * was changed with Track Changes on: w:vMerge = the revised state (rest = starts a merge, cont = continues the merge above,
 * absent = not merged), w:vMergeOrig = the state it replaced. The Changes pane lists it; accepting applies the revised
 * state, rejecting restores the original; the marker goes either way (completes FF-44 — TT61 refused these).
 * Ground truth: markers are written by an INDEPENDENT writer (scripts/oracle/docx_tblrev.py markcells, lxml) and the
 * expected vertical-merge grid after accept / reject is computed by the same oracle from the ORIGINAL file
 * (docx_tblrev.py vmerges IN accept|reject); our output is read back by that oracle (asis) and must match, with no
 * cellMerge left, CT_TcPr order intact (tcpr_ok), python-docx opening it, and the XSD oracle accepting the package.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt62-writer-cellmerge.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, rowsOf, cellsOf, type Table } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";

const { test, finish } = makeHarness("tt62-writer-cellmerge");
const COV = { "FF-44": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt62m-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };
let seq = 0;
const put = (b: Uint8Array) => { const f = join(tmp, `f${seq++}.docx`); writeFileSync(f, b); return f; };
const py = (args: string[]) => execFileSync(PY, args, { encoding: "utf8", maxBuffer: 64 << 20 });
const vm = (b: Uint8Array, mode: "asis" | "accept" | "reject") => JSON.parse(py(["scripts/oracle/docx_tblrev.py", "vmerges", put(b), mode])) as { tables: (string | null)[][][]; cellMerge: number };
const full = (b: Uint8Array) => JSON.parse(py(["scripts/oracle/docx_tblrev.py", put(b)])) as { opens: boolean | string; tcpr_ok: boolean; tcpr_errors: string[] };
const mark = (b: Uint8Array, specs: string[]) => { const out = join(tmp, `m${seq++}.docx`); py(["scripts/oracle/docx_tblrev.py", "markcells", put(b), out, ...specs]); return new Uint8Array(readFileSync(out)); };
const xsdOk = (b: Uint8Array) => { const f = put(b); const r = JSON.parse(py(["scripts/oracle/ooxml_xsd.py", f]))[f]; return r.ok ? "" : JSON.stringify(r.parts).slice(0, 600); };

/** 4×3 table, column 0 of rows 0–1 already vertically merged (restart / continue); every cell has tcW (before vMerge) and shd + vAlign (after it) */
async function base(): Promise<Uint8Array> {
  const d = await blankWord("m"); const p = allParas(d.blocks)[0];
  E.insertText(d, { pid: p.id, off: 0 }, "Merges.");
  const t = E.insertTableAfter(d, p.id, 4, 3)!;
  rowsOf(t).forEach((r, ri) => cellsOf(r).forEach((c, ci) => E.insertText(d, { pid: allParas(c.blocks)[0].id, off: 0 }, `R${ri}C${ci}`)));
  const b = await writeWord(d);
  // the pre-existing merge is written by the oracle too (as an accepted state): rest/none then cont/none, then accept-all via our code would be circular — so use python here
  const out = join(tmp, "base.docx");
  py(["-c", `import zipfile,sys
from lxml import etree
W='http://schemas.openxmlformats.org/wordprocessingml/2006/main'; q=lambda n:'{%s}%s'%(W,n)
zi=zipfile.ZipFile(sys.argv[1]); doc=etree.fromstring(zi.read('word/document.xml'))
rows=doc.find(q('body')).find(q('tbl')).findall(q('tr'))
for ri,val in ((0,'restart'),(1,None)):
    tc=rows[ri].findall(q('tc'))[0]; pr=tc.find(q('tcPr'))
    if pr is None: pr=etree.SubElement(tc,q('tcPr')); tc.insert(0,pr)
    v=etree.Element(q('vMerge'))
    if val: v.set(q('val'),val)
    pos=sum(1 for k in pr if etree.QName(k).localname in ('cnfStyle','tcW','gridSpan','hMerge')); pr.insert(pos,v)
# every cell also carries CT_TcPr children that FOLLOW vMerge (shd, vAlign), so a mis-placed vMerge is detectable
for tr in rows:
    for tc in tr.findall(q('tc')):
        pr=tc.find(q('tcPr'))
        if pr is None: pr=etree.Element(q('tcPr')); tc.insert(0,pr)
        sh=etree.SubElement(pr,q('shd')); sh.set(q('val'),'clear'); sh.set(q('color'),'auto'); sh.set(q('fill'),'EEF5FF')
        va=etree.SubElement(pr,q('vAlign')); va.set(q('val'),'center')
zo=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)
for it in zi.infolist():
    zo.writestr(it, etree.tostring(doc,xml_declaration=True,encoding='UTF-8',standalone=True) if it.filename=='word/document.xml' else zi.read(it.filename))
zo.close()`, put(b), out]);
  return new Uint8Array(readFileSync(out));
}
const BASE = await base();
// every transition: new merge started below (rest←none), continued (cont←none), un-merged (none←cont), restart→cont, cont→rest, none←rest
const SPECS = ["0,2,1,merge:rest:none,701", "0,3,1,merge:cont:none,702", "0,1,0,merge:none:cont,703", "0,2,2,merge:rest:none,704", "0,3,2,merge:cont:none,705", "0,0,0,merge:none:rest,706"];

await test("listed: every w:cellMerge shows in the Changes pane as a resolvable cell change with author, and a detail naming both states", COV, async () => {
  const d = await readWord(mark(BASE, SPECS));
  const cs = E.revisions(d).filter((c) => c.key.startsWith("c:"));
  eq(cs.map((c) => c.key).sort(), ["c:701", "c:702", "c:703", "c:704", "c:705", "c:706"], "keys");
  ok(cs.every((c) => c.editable && c.author === "Oracle" && /merge/i.test(c.text)), "resolvable, authored");
  ok(/^starts a vertical merge \(was: not merged\)$/.test(cs.find((c) => c.key === "c:701")!.detail ?? ""), "detail 701: " + cs.find((c) => c.key === "c:701")!.detail);
  ok(/^not merged \(was: continues the merge above\)$/.test(cs.find((c) => c.key === "c:703")!.detail ?? ""), "detail 703: " + cs.find((c) => c.key === "c:703")!.detail);
});

await test("accept all / reject all: our vertical-merge grid equals the oracle's (computed from the original file), no cellMerge left, CT_TcPr order intact, python-docx opens it, XSD-valid", COV, async () => {
  const M = mark(BASE, SPECS);
  ok(!xsdOk(M), "marked fixture is schema-valid: " + xsdOk(M));
  for (const accept of [true, false]) {
    const d = await readWord(M); E.resolveChanges(d, accept);
    ok(!E.revisions(d).some((c) => c.key.startsWith("c:")), "no cell change left");
    const b = await writeWord(d);
    const got = vm(b, "asis"), want = vm(M, accept ? "accept" : "reject");
    eq(got.tables, want.tables, accept ? "accept-all grid" : "reject-all grid"); eq(got.cellMerge, 0, "markers gone");
    const o = full(b); ok(o.opens === true, "python-docx " + o.opens); ok(o.tcpr_ok, "tcPr order " + o.tcpr_errors);
    ok(!xsdOk(b), "XSD: " + xsdOk(b));
    // model in step with the file (the renderer reads Cell.vmerge)
    const t = d.blocks.find((x): x is Table => x.t === "tbl")!;
    eq(rowsOf(t).map((r) => cellsOf(r).map((c) => c.vmerge ?? null)), want.tables[0], "Cell.vmerge model");
  }
});

await test("one by one, alternating accept / reject in two different orders: each order lands on the oracle's mixed expectation", COV, async () => {
  const M = mark(BASE, SPECS);
  const keys = ["c:701", "c:702", "c:703", "c:704", "c:705", "c:706"];
  const acc = new Set(["c:701", "c:703", "c:705"]);
  // the oracle's mixed expectation: accept-view for accepted cells, reject-view for the rest (cells are independent)
  const A = vm(M, "accept").tables[0], R = vm(M, "reject").tables[0];
  const pos: Record<string, [number, number]> = { "c:701": [2, 1], "c:702": [3, 1], "c:703": [1, 0], "c:704": [2, 2], "c:705": [3, 2], "c:706": [0, 0] };
  const want = A.map((row, r) => row.map((v, c) => { const k = Object.keys(pos).find((x) => pos[x][0] === r && pos[x][1] === c); return k ? (acc.has(k) ? v : R[r][c]) : v; }));
  for (const order of [keys, [...keys].reverse()]) {
    const d = await readWord(M);
    for (const k of order) ok(E.resolveOne(d, k, acc.has(k)), `resolve ${k}`);
    const b = await writeWord(d);
    eq(vm(b, "asis").tables[0], want, `order ${order[0]}…`);
    ok(!xsdOk(b), "XSD: " + xsdOk(b));
  }
});

await test("a cellMerge beside cellIns / cellDel and a row revision: all resolve together (accept all) and the result matches the oracle's grid and its table view", COV, async () => {
  const M = mark(BASE, ["0,2,1,merge:rest:none,801", "0,3,1,merge:cont:none,802", "0,0,2,ins,803", "0,1,2,del,804"]);
  const d = await readWord(M); const n = E.resolveChanges(d, true);
  ok(n >= 4, `resolved ${n}`);
  const b = await writeWord(d);
  const o = JSON.parse(py(["scripts/oracle/docx_tblrev.py", put(b)])); const exp = JSON.parse(py(["scripts/oracle/docx_tblrev.py", put(M)]));
  // (python-docx "tables" repeats a merge-restart text into continued cells; the oracle's own per-cell view does not — compare like with like)
  eq(o.accept, exp.accept, "table view after accept-all = oracle accept view");
  // the deleted cell shifts row 1 left; compare only merge states of column 0–1 which the deletion doesn't touch
  const got = vm(b, "asis").tables[0].map((r) => r.slice(0, 2)), want = vm(M, "accept").tables[0].map((r) => r.slice(0, 2));
  eq(got, want, "merge grid cols 0–1");
  ok(!xsdOk(b), "XSD: " + xsdOk(b));
});

await finish();
