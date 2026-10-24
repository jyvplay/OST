/**
 * TT59 Spreadsheet Paste Special with links: hyperlinks travel with Paste Special ▸ All (incl. Transpose / Skip blanks)
 * and stay put under Values / Formulas / Formats; Paste Link writes absolute references to the source cells.
 * Ground truth: openpyxl (independent reader) reads the saved .xlsx — cell.hyperlink targets and the formula strings —
 * and the formula engine's recalculated values after the source changes. Expected results are written out by hand.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt59-sheet-paste.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { copyBlock, pasteSpecial, pasteLink, pasteBlock } from "../src/lib/formula/sheetops.ts";
import { linkAt, setLink } from "../src/lib/formula/sheetlinks.ts";
import { writeXlsxWorkbook } from "../src/lib/formula/xlsx.ts";

const { test, finish } = makeHarness("tt59-sheet-paste");
const COV = { "FF-28": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const dir = "/tmp/tt59paste"; mkdirSync(dir, { recursive: true });
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
const pyRead = (file: string, sheet: string, cells: string[]) => JSON.parse(execFileSync(PY, ["-c", `
import openpyxl, json
wb = openpyxl.load_workbook("${file}"); ws = wb["${sheet}"]
print(json.dumps({c: [ws[c].value, ws[c].hyperlink.target if ws[c].hyperlink and ws[c].hyperlink.target else (("#" + ws[c].hyperlink.location) if ws[c].hyperlink and ws[c].hyperlink.location else None)] for c in ${JSON.stringify(cells)}}))`], { encoding: "utf8" }));

function base() {
  const wb = new Workbook(); const s = wb.sheet();
  s.setCell(0, 0, "Docs"); s.setCell(1, 0, "Mail"); s.setCell(0, 1, ""); s.setCell(1, 1, "Home");
  setLink(s, { c0: 0, r0: 0, c1: 0, r1: 0 }, { target: "https://example.org/docs" });
  setLink(s, { c0: 1, r0: 0, c1: 1, r1: 0 }, { target: "mailto:team@example.org" });
  setLink(s, { c0: 1, r0: 1, c1: 1, r1: 1 }, { location: "Sheet1!A1" });
  return { wb, s };
}
const tgt = (s: ReturnType<typeof base>["s"], c: number, r: number) => { const l = linkAt(s, c, r); return l ? l.target ?? `#${l.location}` : null; };

await test("Paste Special ▸ All carries hyperlinks (plain, transposed, skip blanks keeps a target link under a blank source); openpyxl reads them", COV, () => {
  let { wb, s } = base();
  const clip = copyBlock(s, { c0: 0, r0: 0, c1: 1, r1: 1 });
  pasteSpecial(s, clip, undefined, 4, 0, { what: "all" });
  eq([tgt(s, 4, 0), tgt(s, 5, 0), tgt(s, 4, 1), tgt(s, 5, 1)], ["https://example.org/docs", "mailto:team@example.org", null, "#Sheet1!A1"], "plain");
  pasteSpecial(s, clip, undefined, 0, 5, { what: "all", transpose: true });
  eq([tgt(s, 0, 5), tgt(s, 1, 5), tgt(s, 0, 6), tgt(s, 1, 6)], ["https://example.org/docs", null, "mailto:team@example.org", "#Sheet1!A1"], "transposed (B1 → A7, A2 → B6)");
  // a target link under a BLANK source: skip blanks keeps it, plain All removes it
  setLink(s, { c0: 8, r0: 1, c1: 8, r1: 1 }, { target: "https://keep.example/" });
  pasteSpecial(s, clip, undefined, 8, 0, { what: "all", skipBlanks: true });
  eq(tgt(s, 8, 1), "https://keep.example/", "skip blanks keeps");
  pasteSpecial(s, clip, undefined, 8, 0, { what: "all" });
  eq(tgt(s, 8, 1), null, "All replaces with the source's (no) link");
  wb.recalculate();
  writeFileSync(`${dir}/a.xlsx`, writeXlsxWorkbook(wb));
  const o = pyRead(`${dir}/a.xlsx`, "Sheet1", ["E1", "F1", "F2", "A6", "A7", "B7"]);
  eq(o, { E1: ["Docs", "https://example.org/docs"], F1: ["Mail", "mailto:team@example.org"], F2: ["Home", "#Sheet1!A1"], A6: ["Docs", "https://example.org/docs"], A7: ["Mail", "mailto:team@example.org"], B7: ["Home", "#Sheet1!A1"] }, "openpyxl");
  ({ wb, s } = base()); void wb;
});

await test("Values / Formulas / Formats leave the target's links alone (Excel keeps a link under pasted values) and never copy source links", COV, () => {
  const { s } = base();
  setLink(s, { c0: 4, r0: 0, c1: 4, r1: 0 }, { target: "https://target.example/" });
  const clip = copyBlock(s, { c0: 0, r0: 0, c1: 1, r1: 0 });
  for (const what of ["values", "formulas", "formats"] as const) {
    pasteSpecial(s, clip, [["Docs", "Mail"]], 4, 0, { what });
    eq([tgt(s, 4, 0), tgt(s, 5, 0)], ["https://target.example/", null], `${what}`);
  }
  eq(s.grid.get("4,0")!.input, "Docs", "values pasted over the kept link");
});

await test("Paste Link: a single cell links absolutely, a range relatively (TT64, as Excel); same sheet, other sheet, quoted names; follows source edits, blank source shows 0; openpyxl reads the formulas", COV, () => {
  const wb = new Workbook(); wb.sheets.clear(); const s1 = wb.addSheet("Data 2026"); const s2 = wb.addSheet("Q1"); const s3 = wb.addSheet("Report");
  s1.setCell(1, 1, "10"); s1.setCell(2, 1, "=B2*2"); s1.setCell(1, 2, "text"); /* C3 blank */
  s2.setCell(0, 0, "7");
  const clip = copyBlock(s1, { c0: 1, r0: 1, c1: 2, r1: 2 });
  eq(pasteLink(s3, clip, "Data 2026", 0, 0), { c0: 0, r0: 0, c1: 1, r1: 1 }, "range");
  eq([s3.grid.get("0,0")!.input, s3.grid.get("1,0")!.input, s3.grid.get("0,1")!.input, s3.grid.get("1,1")!.input], ["='Data 2026'!B2", "='Data 2026'!C2", "='Data 2026'!B3", "='Data 2026'!C3"], "quoted other-sheet refs, relative for a range (TT64)");
  pasteLink(s3, copyBlock(s2, { c0: 0, r0: 0, c1: 0, r1: 0 }), "Q1", 3, 0);
  eq(s3.grid.get("3,0")!.input, "='Q1'!$A$1", "a sheet name that looks like a cell is quoted");
  pasteLink(s1, copyBlock(s1, { c0: 1, r0: 1, c1: 1, r1: 1 }), "Data 2026", 5, 5);
  eq(s1.grid.get("5,5")!.input, "=$B$2", "same sheet: no prefix");
  wb.recalculate();
  eq([wb.valueAt("Report", 0, 0), wb.valueAt("Report", 1, 0), wb.valueAt("Report", 0, 1), wb.valueAt("Report", 1, 1), wb.valueAt("Report", 3, 0)], [10, 20, "text", 0, 7], "values (blank → 0)");
  s1.setCell(1, 1, "21"); wb.recalculate();
  eq([wb.valueAt("Report", 0, 0), wb.valueAt("Report", 1, 0), wb.valueAt("Data 2026", 5, 5)], [21, 42, 21], "follows the source");
  // TT64: the linked RANGE is relative — copying it one row down shifts its references (the single-cell link would not)
  const moved = copyBlock(s3, { c0: 0, r0: 0, c1: 1, r1: 0 }); pasteBlock(s3, moved, 0, 5);
  eq([s3.grid.get("0,5")!.input, s3.grid.get("1,5")!.input], ["='Data 2026'!B7", "='Data 2026'!C7"], "a copied linked range shifts like Excel's");
  const one = copyBlock(s3, { c0: 3, r0: 0, c1: 3, r1: 0 }); pasteBlock(s3, one, 3, 5);
  eq(s3.grid.get("3,5")!.input, "='Q1'!$A$1", "a copied single-cell link stays put");
  for (const k of ["0,5", "1,5", "3,5"]) s3.setCell(Number(k.split(",")[0]), 5, "");
  writeFileSync(`${dir}/b.xlsx`, writeXlsxWorkbook(wb));
  const o = pyRead(`${dir}/b.xlsx`, "Report", ["A1", "B2", "D1"]);
  eq(o, { A1: ["='Data 2026'!B2", null], B2: ["='Data 2026'!C3", null], D1: ["='Q1'!$A$1", null] }, "openpyxl formulas");
  ok(true, "");
});

finish();
