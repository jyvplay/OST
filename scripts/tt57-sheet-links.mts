/**
 * TT57 Spreadsheet hyperlinks (FF-21 completion: Insert ▸ Link / Ctrl+K). Ground truth:
 *  - openpyxl (MIT) for what each cell's hyperlink is, and an lxml reading of the raw <hyperlink> elements + sheet
 *    relationships (scripts/oracle/xlsx_links.py) — both independent of our reader/writer;
 *  - Apache POI test-data workbooks with hyperlinks (13 files) for reading, and for lossless-patch editing;
 *  - an independent per-cell reference model (a Map cell → link) for random set/remove sequences, row/column
 *    insert/delete and Clear All.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt57-sheet-links.mts
 */
import { makeHarness } from "./harness.mts";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workbook } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { workbookToJson, workbookFromJson } from "../src/lib/formula/workbook-json.ts";
import { insertDelete, clearRange, sortRange, copyBlock, pasteBlock } from "../src/lib/formula/sheetops.ts";
import { linkAt, setLink, sanitizeLink, parseAddress, linkAction, cellLink, readLinks } from "../src/lib/formula/sheetlinks.ts";
import { parseRef, rangeRef, sanitizeValidation } from "../src/lib/formula/sheetlayout.ts";

const { test, finish } = makeHarness("tt57-sheet-links");
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 600)} != ${JSON.stringify(b)?.slice(0, 600)}`); };
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/xlsx";
const TMP = mkdtempSync(join(tmpdir(), "tt57l-"));
let nf = 0;
type O = { hl_rels: Record<string, number>; opens: boolean; sheets: Record<string, [string, string | null, string | null, string | null][]>; cells: Record<string, [string, string | null, string | null, string | null][]>; rels_ok: boolean; errors: string[] };
const oracle = (bytes: Uint8Array): O => { const f = join(TMP, `f${++nf}.xlsx`); writeFileSync(f, bytes); return JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_links.py", f], { encoding: "utf8", maxBuffer: 64 << 20 })); };
const COV = { "FF-21": "full" };
const A = (c: number, r: number) => rangeRef({ c0: c, r0: r, c1: c, r1: r });
const ours = (wb: Workbook) => Object.fromEntries([...wb.sheets.values()].map((s) => [s.name, s.links.map((l) => [l.ref, l.target ?? null, l.location ?? null, l.tooltip ?? null])]));
/** per-cell view of our model, in openpyxl's shape */
const oursCells = (wb: Workbook) => Object.fromEntries([...wb.sheets.values()].map((s) => {
  const seen = new Map<string, unknown[]>();
  for (const l of s.links) { const r = parseRef(l.ref)!; for (let y = r.r0; y <= r.r1; y++) for (let x = r.c0; x <= r.c1; x++) { const k = A(x, y); if (!seen.has(k)) seen.set(k, [k, l.target ?? null, l.location ?? null, l.tooltip ?? null]); } }
  return [s.name, [...seen.values()].sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1)];
}));
const normRaw = (o: O) => Object.fromEntries(Object.entries(o.sheets).map(([k, v]) => [k, v.map(([r, t, l, tt]) => [rangeRef(parseRef(r)!), t, l, tt])]));
const cellsOnly = (o: O, wb: Workbook) => Object.fromEntries(Object.entries(o.cells).filter(([k]) => wb.sheets.has(k)));
const sortCells = (x: Record<string, unknown[][]>) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, [...v].sort((a, b) => String(a[0]) < String(b[0]) ? -1 : 1)]));
const files = existsSync(CORPUS) ? readdirSync(CORPUS).filter((f) => f.endsWith(".xlsx") && (() => { try { return /<hyperlink /.test(execFileSync("unzip", ["-p", join(CORPUS, f), "xl/worksheets/*.xml"], { encoding: "latin1", maxBuffer: 256 << 20 })); } catch { return false; } })()).sort() : [];

await test("POI corpus: every <hyperlink> read with its relationship target, location and tooltip = lxml raw reading; per-cell = openpyxl", COV, () => {
  ok(files.length >= 10, `only ${files.length} corpus workbooks with hyperlinks`);
  let n = 0;
  for (const f of files) {
    const bytes = new Uint8Array(readFileSync(join(CORPUS, f)));
    const o = oracle(bytes); const wb = readXlsxWorkbook(Buffer.from(bytes));
    const raw = normRaw(o); const mine = ours(wb);
    for (const name of Object.keys(mine)) { eq(mine[name], raw[name] ?? [], `${f} ${name} raw`); n += mine[name].length; }
    if (o.opens) eq(sortCells(oursCells(wb)), sortCells(cellsOnly(o, wb)), `${f} cells vs openpyxl`);
  }
  console.log(`    ${files.length} workbooks, ${n} hyperlink records`);
  ok(n >= 30, "too few hyperlinks read");
});

await test("export: external, mailto, in-workbook, ranged and special-character links → openpyxl reads the same; rels resolve; schema order", COV, () => {
  const wb = new Workbook(); const s = wb.sheet(); wb.addSheet("Data & <More>");
  s.setCell(0, 0, "site"); s.setCell(0, 1, "mail"); s.setCell(0, 2, "jump"); s.setCell(1, 4, "range");
  s.validations.push(sanitizeValidation({ id: "v1", sqref: "D1", type: "whole", operator: "between", formula1: "1", formula2: "9", allowBlank: true, showError: true, inCellDropdown: true }, "v1")!);
  s.merges.push({ c0: 5, r0: 0, c1: 6, r1: 0 });
  setLink(s, parseRef("A1")!, { target: "https://example.com/a?b=1&c=\"2\"", tooltip: "Go <there> & back" });
  setLink(s, parseRef("A2")!, { target: "mailto:someone@example.com?subject=Hi" });
  setLink(s, parseRef("A3")!, { location: "'Data & <More>'!B7" });
  setLink(s, parseRef("B5:C9")!, { target: "https://example.org/", location: "frag" });
  const bytes = new Uint8Array(writeXlsxWorkbook(wb));
  const o = oracle(bytes);
  ok(o.opens && o.rels_ok, `invalid: ${o.errors.join("; ")}`);
  eq(normRaw(o).Sheet1, ours(wb).Sheet1, "raw");
  eq(sortCells(cellsOnly(o, wb)), sortCells(oursCells(wb)), "openpyxl cells");
  const back = readXlsxWorkbook(Buffer.from(bytes)); eq(ours(back), ours(wb), "re-read");
});

await test("lossless patch: add / change / remove links on POI workbooks (existing rels kept, hyperlink rels rebuilt, untouched sheets byte-identical) = openpyxl", COV, async () => {
  let edited = 0;
  const plain = readdirSync(CORPUS).filter((f) => f.endsWith(".xlsx") && !files.includes(f)).sort().slice(0, 6);
  for (const f of [...files, ...plain]) {
    const bytes = new Uint8Array(readFileSync(join(CORPUS, f)));
    let wb: Workbook; try { wb = readXlsxWorkbook(Buffer.from(bytes)); } catch { continue; }
    const s = [...wb.sheets.values()][0]; if (!s) continue;
    const before = s.links.length;
    if (s.links[0]) setLink(s, parseRef(s.links[0].ref)!, null); // remove the first
    if (s.links[0]) setLink(s, parseRef(s.links[0].ref)!, { ...s.links[0], target: "https://changed.example/x", location: undefined }); // retarget the next
    setLink(s, parseRef("Z99")!, { target: "https://new.example/?q=a&b", tooltip: "new" });
    setLink(s, parseRef("Z100")!, { location: `'${s.name.replace(/'/g, "''")}'!A1` });
    let out: Uint8Array;
    try { out = (await patchXlsx(bytes, wb)).bytes; } catch (e) { if (/ambiguous|encrypted|unsupported/i.test(String(e))) continue; throw e; }
    const o = oracle(out);
    ok(o.rels_ok, `${f}: ${o.errors.join("; ")}`);
    eq(normRaw(o)[s.name], ours(wb)[s.name], `${f} raw after patch`);
    eq(o.hl_rels[s.name] ?? 0, s.links.filter((l) => l.target).length, `${f}: one hyperlink relationship per external link (no orphans)`);
    if (o.opens) eq(sortCells(cellsOnly(o, wb))[s.name], sortCells(oursCells(wb))[s.name], `${f} openpyxl after patch`);
    const re = readXlsxWorkbook(Buffer.from(out)); eq(ours(re), ours(wb), `${f} re-read`);
    ok(s.links.length >= Math.max(2, before), `${f}: links lost`);
    edited++;
  }
  console.log(`    ${edited} workbooks patched (${files.length} with links, ${plain.length} without)`);
  ok(edited >= 12, `only ${edited} patched`);
});

await test("set/remove/insert/delete/clear: 300 random operations = an independent per-cell reference model; JSON round trip keeps links", COV, () => {
  let seed = 57; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let trial = 0; trial < 6; trial++) {
    const wb = new Workbook(); const s = wb.sheet(); const ref = new Map<string, string>(); // "c,r" → target
    for (let step = 0; step < 50; step++) {
      const op = rnd(10);
      const c0 = rnd(8), r0 = rnd(8), c1 = c0 + rnd(4), r1 = r0 + rnd(4);
      if (op < 5) { const t = `https://t${step}.example/`; setLink(s, { c0, r0, c1, r1 }, { target: t }); for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) ref.set(`${x},${y}`, t); }
      else if (op < 7) { setLink(s, { c0, r0, c1, r1 }, null); for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) ref.delete(`${x},${y}`); }
      else if (op === 7) { clearRange(s, { c0, r0, c1, r1 }, "all"); for (let y = r0; y <= r1; y++) for (let x = c0; x <= c1; x++) ref.delete(`${x},${y}`); }
      else {
        const axis = rnd(2) ? "row" : "col"; const at = rnd(10); const cnt = rnd(2) ? 1 + rnd(2) : -(1 + rnd(2));
        insertDelete(wb, "Sheet1", axis, at, cnt);
        const next = new Map<string, string>();
        for (const [k, t] of ref) {
          let [x, y] = k.split(",").map(Number); const v = axis === "row" ? y : x;
          let nv = v; if (cnt > 0) { if (v >= at) nv = v + cnt; } else { if (v >= at && v < at - cnt) continue; if (v >= at - cnt) nv = v + cnt; }
          if (axis === "row") y = nv; else x = nv; next.set(`${x},${y}`, t);
        }
        ref.clear(); for (const [k, v] of next) ref.set(k, v);
      }
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) eq(linkAt(s, x, y)?.target, ref.get(`${x},${y}`), `trial ${trial} step ${step} op ${op} cell ${A(x, y)}`);
    }
    const back = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(wb))));
    eq(back.sheet().links, s.links, "json round trip");
  }
});

await test("links travel with cells: sort moves each row's link with the row; copy/paste carries links; pasting unlinked cells clears links; values-only paste leaves links", COV, () => {
  const wb = new Workbook(); const s = wb.sheet();
  const names = ["pear", "apple", "fig", "banana"];
  names.forEach((n, i) => { s.setCell(0, i, n); s.setCell(1, i, String(i)); });
  setLink(s, parseRef("A1")!, { target: "https://pear.example/" }); setLink(s, parseRef("A3")!, { target: "https://fig.example/" });
  sortRange(wb, "Sheet1", parseRef("A1:B4")!, 0, true);
  const col = () => [0, 1, 2, 3].map((r) => [wb.valueAt("Sheet1", 0, r), linkAt(s, 0, r)?.target ?? null]);
  eq(col(), [["apple", null], ["banana", null], ["fig", "https://fig.example/"], ["pear", "https://pear.example/"]], "links followed their rows");
  const clip = copyBlock(s, parseRef("A3:B4")!);
  pasteBlock(s, clip, 4, 0);
  eq([linkAt(s, 4, 0)?.target, linkAt(s, 4, 1)?.target, linkAt(s, 5, 0)?.target], ["https://fig.example/", "https://pear.example/", undefined], "pasted links");
  pasteBlock(s, copyBlock(s, parseRef("A1:A2")!), 4, 0);
  eq([linkAt(s, 4, 0), linkAt(s, 4, 1)], [undefined, undefined], "unlinked cells pasted over links clear them");
  setLink(s, parseRef("G1")!, { target: "https://keep.example/" });
  pasteBlock(s, copyBlock(s, parseRef("A1")!), 6, 0, { valuesOnly: true });
  eq(linkAt(s, 6, 0)?.target, "https://keep.example/", "values-only paste keeps the target's link");
});

await test("addresses and safety: typed address parsing, javascript:/data: refused everywhere, only http(s)/mailto open, places resolve sheets", COV, () => {
  eq(parseAddress("example.com/x"), { target: "https://example.com/x" }, "bare domain");
  eq(parseAddress("me@example.com"), { target: "mailto:me@example.com" }, "e-mail");
  eq(parseAddress("Sheet2!B4"), { location: "Sheet2!B4" }, "place");
  eq(parseAddress("#'My Sheet'!A1"), { location: "'My Sheet'!A1" }, "hash place");
  eq(parseAddress("javascript:alert(1)"), null, "javascript typed");
  eq(parseAddress(" vbscript:x"), null, "vbscript typed");
  eq(parseAddress("  "), null, "blank");
  eq(linkAction(sanitizeLink({ ref: "A1", target: "JavaScript:alert(1)" })!, ["Sheet1"]).kind, "none", "javascript kept but never opened");
  eq(linkAction(sanitizeLink({ ref: "A1", target: " data:text/html,x" })!, ["Sheet1"]).kind, "none", "data kept but never opened");
  eq(sanitizeLink({ ref: "nope", target: "https://x" }), null, "bad ref");
  const names = ["Sheet1", "My Sheet"];
  eq(linkAction({ target: "https://a.example/p", location: "x" }, names), { kind: "url", url: "https://a.example/p#x" }, "url+fragment");
  eq(linkAction({ target: "mailto:a@b.c" }, names), { kind: "url", url: "mailto:a@b.c" }, "mailto");
  eq(linkAction({ target: "file:///C:/Windows/notepad.exe" }, names).kind, "none", "file not opened");
  eq(linkAction({ target: "\\\\server\\share\\x.xlsx" }, names).kind, "none", "UNC not opened");
  eq(linkAction({ location: "'my sheet'!$b$4" }, names), { kind: "place", sheet: "My Sheet", ref: "B4" }, "place, case-insensitive sheet");
  eq(linkAction({ location: "Nope!A1" }, names).kind, "none", "missing sheet");
  eq(linkAction({ location: "C3:D4" }, names), { kind: "place", ref: "C3:D4" }, "same-sheet range");
  // a read file with script targets keeps them (lossless) but none of them is ever followed
  const sx = '<worksheet xmlns:r="R"><hyperlinks><hyperlink ref="A1" r:id="rId1"/><hyperlink ref="A2" r:id="rId2" tooltip="t"/><hyperlink ref="A3" r:id="rId3"/></hyperlinks></worksheet>';
  const rx = '<Relationships><Relationship Id="rId1" Type="x/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="rId2" Type="x/hyperlink" Target="vbscript:x" TargetMode="External"/><Relationship Id="rId3" Type="x/hyperlink" Target="https://ok.example/?a=1&amp;b=2" TargetMode="External"/></Relationships>';
  const rl = readLinks(sx, rx);
  eq(rl.map((l) => [l.ref, l.target]), [["A1", "javascript:alert(1)"], ["A2", "vbscript:x"], ["A3", "https://ok.example/?a=1&b=2"]], "raw read");
  eq(rl.map((l) => linkAction(l, ["Sheet1"]).kind), ["none", "none", "url"], "only the web link opens");
  const wb = new Workbook(); const s = wb.sheet(); s.setCell(0, 0, "x");
  setLink(s, parseRef("A1")!, { target: "https://ok.example/" });
  // =HYPERLINK(...) formulas are links too, with the address evaluated
  s.setCell(1, 0, "https://cell.example/"); s.setCell(2, 0, '=HYPERLINK(B1,"label")'); s.setCell(3, 0, '=HYPERLINK("#Sheet1!A9")'); s.setCell(4, 0, "=HYPERLINK(\"javascript:x\")"); wb.recalculate();
  eq(wb.valueAt("Sheet1", 2, 0), "label", "HYPERLINK shows its label");
  eq(cellLink(wb, "Sheet1", 2, 0), { target: "https://cell.example/", formula: true }, "formula link follows B1");
  eq(cellLink(wb, "Sheet1", 3, 0), { location: "Sheet1!A9", formula: true }, "formula place");
  eq(cellLink(wb, "Sheet1", 4, 0), undefined, "formula javascript refused");
  eq(cellLink(wb, "Sheet1", 0, 0)?.target, "https://ok.example/", "record link");
});

await finish();
process.exit(0);
