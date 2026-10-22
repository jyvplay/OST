/**
 * TT59 Spreadsheet spelling (src/lib/formula/sheetspell.ts) over the workbook model.
 * Ground truth: an .xlsx written by openpyxl (independent writer) is opened with Fusion's reader, checked, fixed, saved
 * with the lossless patcher and read back by openpyxl; verdicts on words come from the engine already verified against
 * spylls in tt59-writer-spell.mts, and every expected issue list here is written out by hand.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt59-sheet-spell.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { Speller } from "../src/lib/spell/hunspell.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { cellText, changeAllCells, fixCellIssue, sheetSpellIssues } from "../src/lib/formula/sheetspell.ts";

const { test, finish } = makeHarness("tt59-sheet-spell");
const COV = { "FF-39": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
const sp = new Speller(readFileSync("public/dict/en_US.aff", "utf8"), readFileSync("public/dict/en_US.dic", "utf8"));
const dir = "/tmp/tt59sheet"; mkdirSync(dir, { recursive: true });
const brief = (l: { kind: string; col: number; row: number; word: string }[]) => l.map((i) => `${i.kind}:${String.fromCharCode(65 + i.col)}${i.row + 1}:${i.word}`);

await test("only text constants are checked (formulas, numbers, logicals, errors skipped); quote prefix offsets; row-major order; repeated words", COV, () => {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(0, 0, "Revenu forecast"); s.setCell(1, 0, '="Teh"&" total"'); s.setCell(2, 0, "123"); s.setCell(3, 0, "TRUE");
  s.setCell(0, 1, "'0012 recieve"); s.setCell(1, 1, "the the end"); s.setCell(2, 1, "fine words only"); s.setCell(3, 1, "=1/0");
  s.setCell(0, 2, "NASA XYZZY"); s.setCell(1, 2, "visit www.exampel.com"); s.setCell(2, 2, "it’s Tuesday");
  wb.recalculate();
  eq(brief(sheetSpellIssues(s, sp, { skipUpper: true })), ["spell:A1:Revenu", "spell:A2:recieve", "repeat:B2: the"], "issues");
  const q = sheetSpellIssues(s, sp, { skipUpper: true })[1];
  eq([q.off, q.len, s.grid.get("0,1")!.input.slice(q.off, q.off + q.len)], [6, 7, "recieve"], "offset in the input past the quote prefix");
  eq(brief(sheetSpellIssues(s, sp, { skipUpper: false })).includes("spell:A3:XYZZY"), true, "UPPERCASE option");
  eq([cellText("=A1"), cellText("12.5"), cellText("FALSE"), cellText(""), cellText("'=A1")], [null, null, null, null, { text: "=A1", base: 1 }], "cellText");
});

await test("selection scope, Ignore All / Ignore Once, user dictionary", COV, () => {
  const wb = new Workbook(); const s = wb.sheet();
  ["Teh", "speling", "Teh again", "mispell"].forEach((t, i) => s.setCell(0, i, t)); s.setCell(1, 1, "speling");
  eq(brief(sheetSpellIssues(s, sp, { range: { c0: 0, r0: 1, c1: 0, r1: 2 } })), ["spell:A2:speling", "spell:A3:Teh"], "range only");
  eq(brief(sheetSpellIssues(s, sp, { ignoreAll: new Set(["Teh"]) })), ["spell:A2:speling", "spell:B2:speling", "spell:A4:mispell"], "ignore all");
  const first = sheetSpellIssues(s, sp)[0];
  eq(brief(sheetSpellIssues(s, sp, { ignoreOnce: new Set([`${first.sheet}!0,0:0:Teh`]) }))[0], "spell:A2:speling", "ignore once");
  const s2 = new Speller(readFileSync("public/dict/en_US.aff", "utf8"), readFileSync("public/dict/en_US.dic", "utf8")); s2.setUserWords(["mispell"]);
  ok(!brief(sheetSpellIssues(s, s2)).includes("spell:A4:mispell"), "user word");
});

await test("Change / Change All / Delete repeated word; a stale issue is refused; a fix never turns text into a number or formula", COV, () => {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(0, 0, "Teh cat and teh dog"); s.setCell(0, 1, "Teh end"); s.setCell(0, 2, "go go now"); s.setCell(0, 3, "zzqx"); s.setCell(1, 0, '=A1&"!"');
  wb.recalculate();
  let l = sheetSpellIssues(s, sp);
  ok(fixCellIssue(wb, l.find((i) => i.word === "teh")!, "the"), "fix");
  ok(!fixCellIssue(wb, l.find((i) => i.word === "teh")!, "the"), "stale (already fixed) refused");
  eq(changeAllCells(wb, s, sp, "Teh", "The"), 2, "change all (exact case, two cells)");
  // two hits in ONE cell with a longer replacement: fixed right-to-left so the second offset is still valid
  s.setCell(2, 0, "jumpd high, jumpd far"); wb.recalculate();
  eq(changeAllCells(wb, s, sp, "jumpd", "jumped"), 2, "change all, two hits in one cell");
  eq(s.grid.get("2,0")!.input, "jumped high, jumped far", "both replaced");
  l = sheetSpellIssues(s, sp);
  ok(fixCellIssue(wb, l.find((i) => i.kind === "repeat")!, ""), "delete repeat");
  ok(fixCellIssue(wb, sheetSpellIssues(s, sp).find((i) => i.word === "zzqx")!, "=1+1"), "fix to formula-looking text");
  wb.recalculate();
  eq([0, 1, 2, 3].map((r) => s.grid.get(`0,${r}`)!.input), ["The cat and the dog", "The end", "go now", "'=1+1"], "inputs");
  eq(s.grid.get("0,3")!.value, "=1+1", "stays text");
  eq(s.grid.get("1,0")!.value, "The cat and the dog!", "dependent formula recalculated");
  ok(fixCellIssue(wb, { kind: "spell", sheet: s.name, col: 0, row: 1, off: 0, len: 7, word: "The end" }, "42"), "numeric replacement");
  eq(s.grid.get("0,1")!.input, "'42", "kept as text");
});

await test("openpyxl-written .xlsx: issues found, fixed, saved losslessly and read back by openpyxl (values + untouched formula)", COV, async () => {
  execFileSync(PY, ["-c", `
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Budget"
ws["A1"] = "Quartely report"; ws["B1"] = '=CONCATENATE("Teh", " sum")'; ws["C1"] = 42
ws["A2"] = "Recieved payments"; ws["B2"] = "fine"
wb.create_sheet("Other")["A1"] = "Anuther sheet"
wb.save("${dir}/in.xlsx")`]);
  const orig = new Uint8Array(readFileSync(`${dir}/in.xlsx`));
  const wb = readXlsxWorkbook(Buffer.from(orig));
  const s = wb.sheets.get("Budget")!;
  eq(brief(sheetSpellIssues(s, sp)), ["spell:A1:Quartely", "spell:A2:Recieved"], "issues on the active sheet only (formula text skipped)");
  ok(sp.suggest("Quartely").includes("Quarterly"), `suggest: ${sp.suggest("Quartely")}`);
  for (const i of sheetSpellIssues(s, sp)) fixCellIssue(wb, i, i.word === "Quartely" ? "Quarterly" : "Received");
  wb.recalculate();
  const r = await patchXlsx(orig, wb); writeFileSync(`${dir}/out.xlsx`, r.bytes);
  const back = JSON.parse(execFileSync(PY, ["-c", `
import openpyxl, json
wb = openpyxl.load_workbook("${dir}/out.xlsx")
print(json.dumps({"A1": wb["Budget"]["A1"].value, "A2": wb["Budget"]["A2"].value, "B1": wb["Budget"]["B1"].value, "C1": wb["Budget"]["C1"].value, "O": wb["Other"]["A1"].value}))`], { encoding: "utf8" }));
  eq(back, { A1: "Quarterly report", A2: "Received payments", B1: '=CONCATENATE("Teh", " sum")', C1: 42, O: "Anuther sheet" }, "openpyxl read-back");
  // fresh export too
  writeFileSync(`${dir}/fresh.xlsx`, writeXlsxWorkbook(wb));
  const f = JSON.parse(execFileSync(PY, ["-c", `import openpyxl, json; wb = openpyxl.load_workbook("${dir}/fresh.xlsx"); print(json.dumps(wb["Budget"]["A2"].value))`], { encoding: "utf8" }));
  eq(f, "Received payments", "fresh export");
});

await test("robustness: 20,000 text cells checked < 4 s; hostile cell text never throws", COV, () => {
  const wb = new Workbook(); const s = wb.sheet();
  for (let r = 0; r < 4000; r++) for (let c = 0; c < 5; c++) s.setCell(c, r, r % 7 === 0 ? "quick brwn fox" : "the quick brown fox jumps");
  for (const t of ["\u0000\u0000", "x".repeat(4000), "'", "''", "'=", "😀 日本語", "a\u0301b"]) s.setCell(6, 0, t), sheetSpellIssues(s, sp);
  const t0 = performance.now(); const l = sheetSpellIssues(s, sp); const ms = performance.now() - t0;
  console.log(`    ${l.length} issues over 20,000 cells in ${ms.toFixed(0)} ms`);
  ok(ms < 4000, `slow: ${ms}`); ok(l.filter((i) => i.word === "brwn").length === Math.ceil(4000 / 7) * 5, "every brwn found");
});

finish();
