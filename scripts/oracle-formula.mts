/**
 * Formula-engine oracle generator.
 *
 * METHOD (clean-room, licence-safe): this script shells out to a real, locally
 * installed LibreOffice 7.4.7.2 (`soffice --headless`, LGPLv3/MPL-2.0, installed
 * via `apt-get install libreoffice-calc-nogui` in THIS sandbox only) purely as an
 * external, out-of-process ORACLE. No LibreOffice source code, binary, or string
 * constant is copied, transliterated, or linked into the Fusion codebase; nothing
 * here ships in the Next.js app or the production container. We feed it formula
 * TEXT (which is not copyrightable expression — it is the published OOXML/ODFF
 * function grammar) and record the NUMBERS it computes. The output is a frozen
 * JSON fixture (docs/test-fixtures/formula-oracle.json) checked into the repo so
 * that `scripts/unit.mts` can assert engine-vs-oracle parity in CI/build_and_start
 * environments that do NOT have LibreOffice installed — the oracle only needs to
 * run once, here, to produce ground truth.
 *
 * Run (requires soffice on PATH): node --experimental-strip-types --no-warnings scripts/oracle-formula.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCsv } from "../src/lib/forge.ts";
import { readCentralDirectory, readEntry } from "../src/lib/server/zip.ts";

const soVersion = execFileSync("soffice", ["--version"]).toString().trim();
console.log(`Oracle: ${soVersion}`);

/** Scalar vectors: one formula per row, no cross-cell dependency. */
const SCALAR_VECTORS: string[] = [
  // --- precedence / associativity (the famous Excel quirks, verified not assumed)
  "=1+2*3", "=(1+2)*3", "=2^3^2", "=-2^2", "=2^-2", "=2-3-4", "=2^0.5",
  "=10%", "=50%*200", "=-5%",
  "=2+3&\"x\"", "=\"a\"&\"b\"&\"c\"", "=1&2",
  "=1=1", "=1<>2", "=\"A\"=\"a\"", "=2>1", "=2>=2", "=1<2", "=1<=1",
  "=\"10\"+5", "=TRUE()+1", "=TRUE()+TRUE()", "=FALSE()*5",
  // --- math
  "=SUM(1,2,3)", "=SUM(1,\"x\",2)", "=PRODUCT(2,3,4)", "=ABS(-5)",
  "=ROUND(2.345,2)", "=ROUND(2.5,0)", "=ROUNDUP(2.341,1)", "=ROUNDDOWN(2.349,1)",
  "=INT(-2.5)", "=INT(2.9)", "=TRUNC(-2.7)", "=MOD(7,3)", "=MOD(-7,3)", "=MOD(7,-3)",
  "=POWER(2,10)", "=SQRT(16)", "=EXP(1)", "=LN(EXP(1))", "=LOG10(100)", "=LOG(8,2)",
  "=SIGN(-4)", "=SIGN(0)", "=SIGN(9)",
  // --- stats
  "=AVERAGE(1,2,3)", "=COUNT(1,\"x\",2,TRUE())", "=COUNTA(1,\"\",2)",
  "=MIN(3,1,2)", "=MAX(3,1,2)", "=MEDIAN(1,2,3,4)",
  // --- logical
  "=IF(1>0,\"pos\",\"neg\")", "=IF(1<0,\"pos\",\"neg\")",
  "=IFS(1=2,\"a\",1=1,\"b\")", "=AND(1=1,2=2)", "=AND(1=1,2=3)",
  "=OR(1=2,2=2)", "=OR(1=2,2=3)", "=NOT(1=1)", "=XOR(TRUE(),FALSE())", "=XOR(TRUE(),TRUE())",
  "=IFERROR(1/0,\"err\")", "=IFERROR(5,\"err\")", "=IFERROR(5+5,\"err\")",
  // --- text
  "=CONCATENATE(\"a\",\"b\",\"c\")", "=LEFT(\"hello\",2)", "=RIGHT(\"hello\",2)",
  "=MID(\"hello\",2,3)", "=LEN(\"hello\")", "=UPPER(\"abc\")", "=LOWER(\"ABC\")",
  "=PROPER(\"the quick fox\")", "=TRIM(\"  a   b  \")",
  "=SUBSTITUTE(\"aXbXc\",\"X\",\"-\")", "=SUBSTITUTE(\"aXbXc\",\"X\",\"-\",2)",
  "=REPLACE(\"hello\",2,3,\"ELL\")", "=FIND(\"l\",\"hello\")", "=FIND(\"l\",\"hello\",4)",
  "=SEARCH(\"L\",\"hello\")", "=REPT(\"ab\",3)", "=EXACT(\"A\",\"a\")", "=EXACT(\"A\",\"A\")",
  "=VALUE(\"3.14\")", "=TEXT(1234.5,\"0.00\")", "=TEXT(0.1+0.2,\"0.00\")",
  // --- dates (1900 date system, verified against the oracle, not assumed)
  "=DATE(2024,1,1)", "=DATE(1900,1,1)", "=DATE(1900,2,28)", "=DATE(1900,2,29)", "=DATE(1900,3,1)",
  "=YEAR(DATE(2024,5,6))", "=MONTH(DATE(2024,5,6))", "=DAY(DATE(2024,5,6))",
  "=WEEKDAY(DATE(2024,1,1))", "=WEEKDAY(DATE(2024,1,6))",
  "=EDATE(DATE(2024,1,31),1)", "=EOMONTH(DATE(2024,1,15),0)", "=EOMONTH(DATE(2024,1,15),1)",
  "=DATEDIF(DATE(2024,1,1),DATE(2024,3,15),\"d\")", "=DAYS(DATE(2024,2,1),DATE(2024,1,1))",
  // --- lookup (array literals: comma = column sep, semicolon = row sep)
  "=VLOOKUP(2,{1,\"a\";2,\"b\";3,\"c\"},2,0)", "=VLOOKUP(5,{1,\"a\";2,\"b\";3,\"c\"},2,0)",
  "=VLOOKUP(2,{1,\"a\";2,\"b\";3,\"c\"},2,1)",
  "=HLOOKUP(2,{1,2,3;\"a\",\"b\",\"c\"},2,0)",
  "=INDEX({1,2,3;4,5,6},2,3)", "=INDEX({1,2,3;4,5,6},2,0)",
  "=MATCH(3,{1,2,3,4},0)", "=MATCH(30,{10,20,30,40},1)",
  "=CHOOSE(2,\"a\",\"b\",\"c\")",
  // --- information
  "=ISNUMBER(5)", "=ISNUMBER(\"5\")", "=ISTEXT(\"x\")", "=ISERROR(1/0)", "=ISERROR(5)",
  "=ISNA(NA())", "=ISLOGICAL(TRUE())",
  // --- errors
  "=1/0", "=1/0+1", "=SUM(1,1/0,2)", "=NA()", "=UNDEFINEDFUNCTION(1)",
];

/** Grid vectors: real dependency chains, relative/absolute refs, range aggregates. */
const GRID = [
  ["1", "=A1*2", "=SUM(A1:A5)", "=AVERAGE(A1:A5)", "=A1+B1"],
  ["2", "=A2*2", "=COUNT(A1:A5)", "=MAX(A1:A5)", "=$A$1+A2"],
  ["3", "=A3*2", "=MIN(A1:A5)", "=SUMIF(A1:A5,\">2\")", "=SUM(A1:C1)"],
  ["4", "=A4*2", "=COUNTIF(A1:A5,\">2\")", "=AVERAGEIF(A1:A5,\">2\")", ""],
  ["5", "=A5*2", "", "", ""],
];
const CIRCULAR = [["=B1+1", "=A1+1"]];
/** Does a RANGE aggregate skip non-numeric cells, unlike a literal non-numeric argument? */
const GRID2 = [
  ["1", "=SUM(A1:A3)", "=COUNT(A1:A3)", "=COUNTA(A1:A3)", "=AVERAGE(A1:A3)"],
  ["x", "", "", "", ""],
  ["3", "", "", "", ""],
];

function runOracle(rows: string[][], label: string): Record<string, { type: string; value: string }> {
  const dir = mkdtempSync(join(tmpdir(), "fusion-oracle-"));
  const csvPath = join(dir, "in.csv");
  const xlsxPath = join(dir, "in.xlsx");
  writeFileSync(csvPath, toCsv(rows));
  execFileSync("soffice", ["--headless", "--convert-to", "xlsx", "--outdir", dir, csvPath], { timeout: 60_000 });
  const buf = readFileSync(xlsxPath);
  const entries = readCentralDirectory(buf);
  const sheetXml = readEntry(buf, entries.find((e) => e.name === "xl/worksheets/sheet1.xml")!).toString("utf8");
  const sstEntry = entries.find((e) => e.name === "xl/sharedStrings.xml");
  const sst = sstEntry
    ? [...readEntry(buf, sstEntry).toString("utf8").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]))
    : [];
  const out: Record<string, { type: string; value: string }> = {};
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"[^>]*t="(\w+)"[^>]*>(?:<f[^>]*>[^<]*<\/f>)?<v>([^<]*)<\/v><\/c>|<c r="([A-Z]+\d+)"[^>]*t="(\w+)"[^>]*\/>|<c r="([A-Z]+\d+)"[^>]*><f[^>]*>[^<]*<\/f><v>([^<]*)<\/v><\/c>/g)) {
    const ref = m[1] ?? m[4] ?? m[6];
    const type = m[2] ?? m[5] ?? "n";
    const raw = m[3] ?? m[7] ?? "";
    out[ref] = type === "s" ? { type: "str", value: sst[Number(raw)] ?? "" } : { type, value: decodeXml(raw) };
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ${label}: ${Object.keys(out).length} cells captured`);
  return out;
}
const decodeXml = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

console.log("Running scalar vectors through the oracle...");
const scalarCells = runOracle(SCALAR_VECTORS.map((f) => [f]), "scalar");
const scalarResults = SCALAR_VECTORS.map((formula, i) => ({ formula, ...scalarCells[`A${i + 1}`] }));

console.log("Running grid (dependency/range) vectors through the oracle...");
const gridCells = runOracle(GRID, "grid");

console.log("Running circular-reference vector through the oracle...");
const circCells = runOracle(CIRCULAR, "circular");

console.log("Running range-vs-literal text-coercion vector through the oracle...");
const grid2Cells = runOracle(GRID2, "grid2");

mkdirSync("docs/test-fixtures", { recursive: true });
writeFileSync("docs/test-fixtures/formula-oracle.json", JSON.stringify({
  oracle: soVersion,
  capturedAt: new Date().toISOString(),
  method: "soffice --headless --convert-to xlsx on a CSV of formulas; cell type+value read back from the produced OOXML. Used as a build-time/dev-time oracle only — NOT a runtime dependency.",
  scalar: scalarResults,
  grid: { input: GRID, cells: gridCells },
  circular: { input: CIRCULAR, cells: circCells },
  grid2: { input: GRID2, cells: grid2Cells },
}, null, 2));
console.log(`\nWrote docs/test-fixtures/formula-oracle.json (${scalarResults.length} scalar + ${Object.keys(gridCells).length} grid + ${Object.keys(circCells).length} circular cells)`);
