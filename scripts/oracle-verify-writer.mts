/**
 * Writer interoperability check (dev-time only, requires `soffice` on PATH —
 * NOT part of the always-run CI suite, which must work without LibreOffice
 * installed). This script builds a workbook with OUR engine, exports it with
 * OUR from-scratch xlsx writer (src/lib/formula/xlsx.ts), feeds the resulting
 * file into a real, locally installed LibreOffice, and diffs LibreOffice's
 * recomputed values against our own engine's values for the same formulas.
 * A pass here is genuine evidence that our OOXML output is spec-valid and
 * opens correctly in a real, independent implementation — not just that our
 * own reader can parse our own writer's output (which would be circular).
 *
 * Run: node --experimental-strip-types --import ./scripts/register-hook.mjs scripts/oracle-verify-writer.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workbook, Sheet, writeXlsx, isError } from "../src/lib/formula";

const wb = new Workbook();
const sheet = new Sheet("Interop");
wb.sheets.set("Interop", sheet);
const cells: [number, number, string][] = [
  [0, 0, "12"], [0, 1, "30"], [0, 2, "7"],
  [1, 0, "=A1*2"], [1, 1, "=A2/4"], [1, 2, "=A1+A2+A3"],
  [2, 0, "=SUM(A1:A3)"], [2, 1, "=AVERAGE(A1:A3)"], [2, 2, "=IF(A1>A3,\"big\",\"small\")"],
  [3, 0, "=CONCATENATE(\"n=\",A1)"], [3, 1, "=ROUND(A2/A3,2)"], [3, 2, "=VLOOKUP(7,{1,\"a\";7,\"g\";30,\"z\"},2,0)"],
];
for (const [c, r, v] of cells) sheet.setCell(c, r, v);
wb.recalculate();

const engineValues: Record<string, string> = {};
for (const [c, r] of cells) {
  const cell = sheet.get(c, r)!;
  const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
  engineValues[ref] = isError(cell.value) ? cell.value.error : String(cell.value);
}

const buf = writeXlsx(sheet, "Interop test");
const dir = mkdtempSync(join(tmpdir(), "fusion-writer-check-"));
const xlsxPath = join(dir, "out.xlsx");
writeFileSync(xlsxPath, buf);

console.log(`Wrote ${buf.length} bytes via our own writer. Opening with real LibreOffice...`);
execFileSync("soffice", ["--headless", "--convert-to", "csv:Text - txt - csv (StarCalc):44,34,0,1,,0,false,true,false,false,false", "--outdir", dir, xlsxPath], { timeout: 60_000 });
const csv = readFileSync(join(dir, "out.csv"), "utf8");
console.log("--- LibreOffice re-read our file and produced this CSV ---");
console.log(csv);

// Cross-check a few cells by position in the csv grid against our engine values.
const rows = csv.trim().split(/\r?\n/).map((l) => l.split(","));
let pass = 0, fail = 0;
for (const [c, r] of cells) {
  const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
  const loVal = (rows[r]?.[c] ?? "").replace(/^"|"$/g, "");
  const engVal = engineValues[ref];
  const numericMatch = !Number.isNaN(Number(loVal)) && !Number.isNaN(Number(engVal)) && Math.abs(Number(loVal) - Number(engVal)) < 1e-9;
  const ok = loVal === engVal || numericMatch;
  console.log(`${ref}: engine=${engVal}  libreoffice-reread=${loVal}  ${ok ? "MATCH" : "MISMATCH"}`);
  ok ? pass++ : fail++;
}
rmSync(dir, { recursive: true, force: true });
console.log(`\nWriter interoperability: ${pass}/${pass + fail} cells match real LibreOffice's re-read of our .xlsx output.`);
if (fail > 0) process.exit(1);
