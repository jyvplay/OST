/**
 * TT60 Spreadsheet spelling across ALL sheets (src/lib/formula/sheetspell.ts workbookSpellIssues / changeAllWorkbook).
 * Ground truth: a 3-sheet .xlsx written by openpyxl (independent writer) is opened with Fusion's reader, checked in tab
 * order starting at a chosen sheet (wrapping), fixed with Change All across sheets, saved with the lossless patcher and
 * read back by openpyxl. Word verdicts come from the engine verified against spylls (tt59-writer-spell); expected issue
 * lists are written out by hand.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt60-sheet-spell-all.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { Speller } from "../src/lib/spell/hunspell.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { patchXlsx } from "../src/lib/formula/xlsx-patch.ts";
import { changeAllWorkbook, fixCellIssue, sheetSpellIssues, workbookSpellIssues } from "../src/lib/formula/sheetspell.ts";

const { test, finish } = makeHarness("tt60-sheet-spell-all");
const COV = { "FF-41": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
const sp = new Speller(readFileSync("public/dict/en_US.aff", "utf8"), readFileSync("public/dict/en_US.dic", "utf8"));
const dir = "/tmp/tt60sheet"; mkdirSync(dir, { recursive: true });
const brief = (l: { sheet: string; kind: string; col: number; row: number; word: string }[]) => l.map((i) => `${i.sheet}!${String.fromCharCode(65 + i.col)}${i.row + 1}:${i.kind}:${i.word}`);

await test("all sheets: tab order from the starting sheet, wrapping; a selection range is ignored; single sheet unchanged", COV, () => {
  const wb = new Workbook(); wb.sheets.clear(); // (a new Workbook starts with a default sheet)
  const a = wb.addSheet("Alpha"), b = wb.addSheet("Beta"), c = wb.addSheet("Gamma");
  a.setCell(0, 0, "Teh start"); a.setCell(1, 1, "fine");
  b.setCell(0, 1, "recieve it"); b.setCell(0, 0, "=\"Teh\"");
  c.setCell(2, 0, "the the end"); c.setCell(0, 3, "Anuther");
  wb.recalculate();
  eq(brief(workbookSpellIssues(wb, sp)), ["Alpha!A1:spell:Teh", "Beta!A2:spell:recieve", "Gamma!C1:repeat: the", "Gamma!A4:spell:Anuther"], "from the first sheet");
  eq(brief(workbookSpellIssues(wb, sp, {}, "Beta")), ["Beta!A2:spell:recieve", "Gamma!C1:repeat: the", "Gamma!A4:spell:Anuther", "Alpha!A1:spell:Teh"], "from Beta, wrapping to Alpha");
  eq(brief(workbookSpellIssues(wb, sp, { range: { c0: 5, r0: 5, c1: 6, r1: 6 } }, "Gamma")).length, 4, "range ignored");
  eq(brief(workbookSpellIssues(wb, sp, {}, "Nope"))[0], "Alpha!A1:spell:Teh", "unknown start sheet = first sheet");
  eq(brief(sheetSpellIssues(b, sp)), ["Beta!A2:spell:recieve"], "single-sheet check unchanged");
  eq(workbookSpellIssues(wb, sp, { ignoreAll: new Set(["teh"]) }).length, 3, "Ignore All applies to every sheet");
  const empty = new Workbook(); empty.addSheet("S");
  eq(workbookSpellIssues(empty, sp), [], "empty workbook");
});

await test("openpyxl 3-sheet .xlsx: Change All across sheets, a fix on a non-active sheet, saved losslessly, openpyxl reads every sheet back", COV, async () => {
  execFileSync(PY, ["-c", `
import openpyxl
wb = openpyxl.Workbook(); ws = wb.active; ws.title = "Jan"
ws["A1"] = "Recieved"; ws["B1"] = '=CONCATENATE("Recieved", "!")'; ws["A2"] = 5
s2 = wb.create_sheet("Feb"); s2["A1"] = "Recieved twice"; s2["C3"] = "Recieved"
s3 = wb.create_sheet("Mar summary"); s3["B2"] = "Quartely total"
wb.save("${dir}/in3.xlsx")`]);
  const orig = new Uint8Array(readFileSync(`${dir}/in3.xlsx`));
  const wb = readXlsxWorkbook(Buffer.from(orig));
  eq(brief(workbookSpellIssues(wb, sp, {}, "Feb")), ["Feb!A1:spell:Recieved", "Feb!C3:spell:Recieved", "Mar summary!B2:spell:Quartely", "Jan!A1:spell:Recieved"], "issues in order");
  eq(changeAllWorkbook(wb, sp, "Recieved", "Received"), 3, "Change All across sheets");
  const q = workbookSpellIssues(wb, sp, {}, "Feb");
  eq(brief(q), ["Mar summary!B2:spell:Quartely"], "remaining");
  ok(fixCellIssue(wb, q[0], "Quarterly"), "fix on another sheet");
  wb.recalculate();
  const r = await patchXlsx(orig, wb); writeFileSync(`${dir}/out3.xlsx`, r.bytes);
  const back = JSON.parse(execFileSync(PY, ["-c", `
import openpyxl, json
wb = openpyxl.load_workbook("${dir}/out3.xlsx")
print(json.dumps([wb.sheetnames, wb["Jan"]["A1"].value, wb["Jan"]["B1"].value, wb["Jan"]["A2"].value, wb["Feb"]["A1"].value, wb["Feb"]["C3"].value, wb["Mar summary"]["B2"].value]))`], { encoding: "utf8" }));
  eq(back, [["Jan", "Feb", "Mar summary"], "Received", '=CONCATENATE("Recieved", "!")', 5, "Received twice", "Received", "Quarterly total"], "openpyxl read-back (formula text untouched)");
  eq(workbookSpellIssues(readXlsxWorkbook(Buffer.from(r.bytes)), sp), [], "re-opened workbook is clean");
});

await finish();
