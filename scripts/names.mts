/**
 * TT19 suite "names": Excel defined names in the formula engine, workbook JSON and xlsx, with two independent
 * checks: openpyxl (authoring + reading OOXML <definedNames>) and the PyPI `formulas` calculator evaluating OUR file.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/names.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook, isError, workbookToJson } from "../src/lib/formula/index.ts";
import { workbookFromJson } from "../src/lib/formula/workbook-json.ts";
import { readXlsxWorkbook, writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { insertDelete } from "../src/lib/formula/sheetops.ts";
import { validateName } from "../src/lib/formula/names.ts";

const { test, finish } = makeHarness("names");
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const dir = mkdtempSync(join(tmpdir(), "names-"));
const py = (...a: string[]) => JSON.parse(execFileSync(PY, ["scripts/oracles/names_oracle.py", ...a], { encoding: "utf8", timeout: 120_000 }));
const v = (wb: Workbook, sheet: string, a1: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!; let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return wb.valueAt(sheet, c - 1, Number(m[2]) - 1);
};
const errCode = (x: unknown) => (isError(x as never) ? (x as { error: string }).error : null);
const close = (a: unknown, b: number, m: string) => assert.ok(typeof a === "number" && Math.abs(a - b) < 1e-9, `${m}: ${JSON.stringify(a)} vs ${b}`);

function sample() {
  const wb = new Workbook();
  const d = wb.sheet("Sheet1");
  [10, 20, 30, 40].forEach((x, i) => d.setCell(1, i + 1, String(x))); // B2:B5
  wb.addSheet("Rates").setCell(1, 0, "0.25");
  wb.defineName("Sales", "Sheet1!$B$2:$B$5");
  wb.defineName("Rate", "Rates!$B$1");
  return wb;
}

await test("name syntax follows Excel's rules (web-checked): letters/_ first, no spaces, not A1/R1C1-like, not C/R, ≤255", { "FF-36": "full" }, () => {
  for (const ok of ["Sales", "_tmp", "Tax_Rate", "First.Quarter", "XFE1", "ABCD12", "Sales2026x", "a".repeat(255)]) assert.equal(validateName(ok), null, ok);
  for (const bad of ["A1", "xfd1048576", "B$2".replace("$", ""), "R1C1", "r2c", "R", "c", "TRUE", "Tax Rate", "1abc", "a-b", "\\path", "a".repeat(256), ""]) assert.notEqual(validateName(bad), null, bad);
  const wb = new Workbook();
  assert.throws(() => wb.defineName("A1", "1"), /cell reference/);
  assert.throws(() => wb.defineName("Ok", "SUM("), /./, "definition syntax checked at definition time");
  assert.throws(() => wb.defineName("Ok", "1", "NoSheet"), /no such sheet/);
});

await test("names in formulas: ranges, constants, formula names, chains; case-insensitive; unknown → #NAME? until defined", { "FF-36": "full" }, () => {
  const wb = sample(); const s = wb.sheet("Sheet1");
  s.setCell(3, 0, "=SUM(sales)*RATE"); s.setCell(3, 1, "=Unknown+1"); s.setCell(3, 2, "=ROWS(Sales)+COLUMNS(Sales)");
  s.setCell(3, 3, "=SUM(ROW(Sales))"); s.setCell(3, 4, "=Doubled"); s.setCell(3, 5, "=XLOOKUP(30,Sales,Sales)");
  wb.defineName("Doubled", "SUM(Sales)*2");
  wb.recalculate();
  close(v(wb, "Sheet1", "D1"), 25, "SUM(sales)*RATE");
  assert.equal(errCode(v(wb, "Sheet1", "D2")), "#NAME?");
  close(v(wb, "Sheet1", "D3"), 5, "ROWS+COLUMNS");
  close(v(wb, "Sheet1", "D4"), 2 + 3 + 4 + 5, "ROW(name) sees the reference, not values");
  close(v(wb, "Sheet1", "D5"), 200, "formula name");
  close(v(wb, "Sheet1", "D6"), 30, "ext function with a name range");
  wb.defineName("Unknown", "41"); wb.recalculate();
  close(v(wb, "Sheet1", "D2"), 42, "defining the name later fixes the formula");
  wb.deleteName("unknown"); wb.recalculate();
  assert.equal(errCode(v(wb, "Sheet1", "D2")), "#NAME?", "deleting it breaks it again");
});

await test("scope: a sheet-level name shadows the workbook name on its sheet only; self-reference terminates with #NAME?", { "FF-36": "full" }, () => {
  const wb = sample();
  wb.defineName("Pick", "Sheet1!$B$2");
  wb.defineName("Pick", "Rates!$B$1", "Rates");
  wb.sheet("Sheet1").setCell(4, 0, "=Pick"); wb.sheet("Rates").setCell(4, 0, "=Pick");
  wb.defineName("Loop", "Loop+1"); wb.defineName("PingA", "PingB"); wb.defineName("PingB", "PingA");
  wb.sheet("Sheet1").setCell(4, 1, "=Loop"); wb.sheet("Sheet1").setCell(4, 2, "=PingA");
  const t = performance.now(); wb.recalculate();
  assert.ok(performance.now() - t < 500, "cyclic names must not hang");
  close(v(wb, "Sheet1", "E1"), 10, "workbook Pick"); close(v(wb, "Rates", "E1"), 0.25, "sheet-scoped Pick");
  assert.equal(errCode(v(wb, "Sheet1", "E2")), "#NAME?"); assert.equal(errCode(v(wb, "Sheet1", "E3")), "#NAME?");
  assert.equal(wb.listNames().filter((n) => n.name === "Pick").length, 2);
});

await test("insert/delete rows and columns move names like cell formulas; deleting the whole range gives #REF!", { "FF-36": "full" }, () => {
  const wb = sample(); const s = wb.sheet("Sheet1");
  s.setCell(5, 0, "=SUM(Sales)");
  insertDelete(wb, "Sheet1", "row", 0, 2);
  assert.equal(wb.lookupName("Sales", null)?.ref, "Sheet1!$B$4:$B$7");
  close(v(wb, "Sheet1", "F3"), 100, "sum follows the moved data");
  insertDelete(wb, "Sheet1", "col", 0, 1);
  assert.equal(wb.lookupName("Sales", null)?.ref, "Sheet1!$C$4:$C$7");
  insertDelete(wb, "Rates", "row", 0, 1);
  assert.equal(wb.lookupName("Rate", null)?.ref, "Rates!$B$2", "other-sheet names follow their own sheet");
  insertDelete(wb, "Sheet1", "row", 3, -4);
  assert.match(wb.lookupName("Sales", null)?.ref ?? "", /#REF!/);
  assert.equal(errCode(v(wb, "Sheet1", "G3")), "#REF!");
});

await test("workbook JSON round-trips names; hostile JSON names (invalid syntax, A1-like, oversized) are dropped", { "FF-36": "partial" }, () => {
  const wb = sample(); wb.defineName("Local", "Rates!$B$1", "Rates", "only here");
  const j = workbookToJson(wb);
  const back = workbookFromJson(JSON.parse(JSON.stringify(j)));
  assert.deepEqual(back.listNames(), wb.listNames());
  const hostile = workbookFromJson({ ...j, names: [{ name: "A1", ref: "1" }, { name: "x y", ref: "1" }, { name: "Big", ref: "1+".repeat(5000) + "1" }, { name: "Ok", ref: "SUM(" }, { name: "Fine", ref: "2" }, "junk"] } as never);
  assert.deepEqual(hostile.listNames().map((n) => n.name).filter((n) => !["Sales", "Rate", "Local"].includes(n)), ["Fine"]);
});

await test("openpyxl-authored workbook → our reader: workbook/sheet/formula/constant names evaluate to Python-computed values; hidden and _xlnm names skipped", { "FF-36": "full", "FF-21": "partial" }, () => {
  const f = join(dir, "authored.xlsx");
  const expected = py("make", f) as Record<string, number>;
  const wb = readXlsxWorkbook(readFileSync(f));
  for (const [k, want] of Object.entries(expected)) { const [sh, a1] = k.split("!"); close(v(wb, sh, a1), want, k); }
  const names = wb.listNames().map((n) => `${n.scope ?? ""}|${n.name}`).sort();
  assert.deepEqual(names, ["Data|First", "Rates|First", "|Bonus", "|Grand.Total", "|Sales", "|Tax_Rate"].sort());
  assert.equal(wb.lookupName("Bonus", null)?.comment, "flat bonus");
});

await test("our writer → openpyxl sees the same names/scopes/destinations, and the PyPI `formulas` engine computes the same results from OUR file", { "FF-36": "full", "FF-20": "partial" }, () => {
  const wb = new Workbook(); wb.sheets.clear();
  const d = wb.addSheet("Data"); const r = wb.addSheet("Rates");
  [120, 340, 75.5, 410, 99].forEach((x, i) => d.setCell(1, i + 1, String(x)));
  r.setCell(1, 0, "0.07");
  wb.defineName("Sales", "Data!$B$2:$B$6"); wb.defineName("Tax_Rate", "Rates!$B$1"); wb.defineName("First", "Data!$B$2", "Data");
  wb.defineName("Bonus", "25", null, "flat bonus");
  ["=SUM(Sales)", "=SUM(Sales)*Tax_Rate", "=First*2", "=SUM(Sales)+Bonus", "=COUNT(Sales)", "=INDEX(Sales,3)"].forEach((x, i) => d.setCell(3, i, x));
  wb.recalculate();
  const f = join(dir, "ours.xlsx"); writeFileSync(f, writeXlsxWorkbook(wb));
  const ins = py("inspect", f);
  assert.equal(ins.names.Sales.ref, "Data!$B$2:$B$6"); assert.equal(ins.names.Tax_Rate.ref, "Rates!$B$1");
  assert.equal(ins.names["Data!First"].scope, "Data"); assert.equal(ins.names.Bonus.comment, "flat bonus");
  assert.deepEqual(ins.destinations.Sales, [["Data", "$B$2:$B$6"]]);
  const calc = py("calc", f) as Record<string, number>;
  const ours = ["D1", "D2", "D3", "D4", "D5", "D6"].map((c) => v(wb, "Data", c));
  assert.equal(Object.keys(calc).length, 6, `formulas computed ${JSON.stringify(calc)}`);
  // `formulas` 1.3.4 does not resolve SHEET-scoped names (#REF!) — it does the same on openpyxl's own file, so this is an
  // oracle limitation, asserted symmetrically instead of hidden; D3 is covered by openpyxl's scope check above.
  const authored = join(dir, "authored-for-calc.xlsx"); py("make", authored);
  const refCalc = py("calc", authored) as Record<string, unknown>;
  assert.equal(calc["Data!D3"], "#REF!"); assert.equal(refCalc["Data!D3"], "#REF!", "oracle treats openpyxl's sheet-scoped name the same way");
  close(ours[2], 240, "ours D3 (sheet-scoped First)");
  ["D1", "D2", "D4", "D5", "D6"].forEach((c) => close(calc[`Data!${c}`], ours[["D1", "D2", "D3", "D4", "D5", "D6"].indexOf(c)] as number, `formulas vs ours ${c}`));
});

finish();
