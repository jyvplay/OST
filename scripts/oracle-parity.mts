/**
 * Regression gate: replay EVERY frozen LibreOffice 7.4.7.2 oracle vector
 * (docs/test-fixtures/formula-oracle.json, captured by scripts/oracle-formula.mts)
 * through the CURRENT engine and diff. Before TT15 no suite read this fixture,
 * so the "153/153" claim in docs/OFFICE-ENGINE.md was not re-checked on change.
 *
 * Tolerance: numbers compared at 13 significant digits; LibreOffice's boolean
 * cell type ('b') is compared as 0/1; strings byte-exact; errors by code, with
 * our internal #CIRCULAR! mapped to the #VALUE! token LibreOffice writes.
 *
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/oracle-parity.mts
 */
import { readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { Workbook, isError, type Scalar } from "../src/lib/formula/index.ts";

interface Expect { type: string; value: string }
const fx = JSON.parse(readFileSync("docs/test-fixtures/formula-oracle.json", "utf8")) as {
  scalar: ({ formula: string } & Expect)[];
  grid: { input: string[][]; cells: Record<string, Expect> };
  grid2: { input: string[][]; cells: Record<string, Expect> };
  circular: { input: string[][]; cells: Record<string, Expect> };
};
const { test, finish } = makeHarness("oracle");

const sig = (n: number) => Number(n.toPrecision(13));
function same(got: Scalar | undefined, want: Expect): boolean {
  if (got === undefined) return false;
  if (want.type === "e") return isError(got) && (got.error === want.value || (got.error === "#CIRCULAR!" && want.value === "#VALUE!"));
  if (isError(got)) return false;
  if (want.type === "str") return String(got) === want.value;
  const g = typeof got === "boolean" ? (got ? 1 : 0) : typeof got === "number" ? got : Number.NaN;
  return sig(g) === sig(Number(want.value));
}
const show = (v: Scalar | undefined) => (v === undefined ? "undefined" : isError(v) ? v.error : JSON.stringify(v));

function runGrid(input: string[][]) {
  const wb = new Workbook();
  const s = wb.sheet();
  input.forEach((row, r) => row.forEach((v, c) => { if (v !== "") s.setCell(c, r, v); }));
  wb.recalculate();
  return (ref: string) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    let col = 0; for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
    return wb.valueAt("Sheet1", col - 1, Number(m[2]) - 1);
  };
}

const failures: string[] = [];
/**
 * TT46: vectors where LibreOffice and EXCEL disagree. This engine targets Excel (.xlsx) semantics, so these assert the
 * Excel value, with the evidence that established it. Every other LibreOffice vector remains a strict gate.
 *  - Excel corpus: value Excel itself cached in a real file (Apache POI test-data, scripts/diag/xlsx-corpus.mts).
 *  - formulas: independent PyPI Excel emulator (formulas 1.3.4), run 2026-10-19.
 */
export const EXCEL_DIVERGES_FROM_LO: Record<string, { excel: number | boolean; evidence: string }> = {
  '="A"="a"': { excel: true, evidence: "formulas → TRUE; Excel comparison operators are case-insensitive (EXACT is the case-sensitive test). LO's 'case sensitive' option defaults ON." },
  "=DATE(1900,1,1)": { excel: 1, evidence: "Excel corpus FormulaEvalTestData_Copy.xlsx!D320 cached 1; formulas → 1 (Lotus 1900 leap-year quirk: serial 1 = 1900-01-01)." },
  "=DATE(1900,2,28)": { excel: 59, evidence: "follows from serial 1 = 1900-01-01 (Excel corpus D320) and serial 61 = 1900-03-01 (formulas → 61)." },
  "=DATE(1900,2,29)": { excel: 60, evidence: "Excel corpus FormulaEvalTestData_Copy.xlsx!H320 cached 60 (the non-existent 1900-02-29)." },
};
await test(`oracle: ${fx.scalar.length} scalar vectors match LibreOffice 7.4.7.2 (${Object.keys(EXCEL_DIVERGES_FROM_LO).length} documented Excel divergences asserted as Excel)`, { "FF-19": "full" }, () => {
  const bad: string[] = [];
  for (const v of fx.scalar) {
    const get = runGrid([[v.formula]]);
    const got = get("A1");
    const ex = EXCEL_DIVERGES_FROM_LO[v.formula];
    if (ex) { if (got !== ex.excel) bad.push(`${v.formula}: got ${show(got)} want Excel ${ex.excel}`); continue; }
    if (!same(got, v)) bad.push(`${v.formula}: got ${show(got)} want ${v.type}:${v.value}`);
  }
  if (Object.keys(EXCEL_DIVERGES_FROM_LO).some((f) => !fx.scalar.some((v) => v.formula === f))) bad.push("divergence map names a vector that is not in the frozen fixture");
  failures.push(...bad);
  if (bad.length) throw new Error(`${bad.length} mismatches:\n      ${bad.join("\n      ")}`);
});
for (const [name, g] of [["grid", fx.grid], ["grid2 (range coercion)", fx.grid2], ["circular", fx.circular]] as const) {
  await test(`oracle: ${name} — ${Object.keys(g.cells).length} cells match`, { "FF-19": "full" }, () => {
    const get = runGrid(g.input);
    const bad = Object.entries(g.cells).filter(([ref, want]) => !same(get(ref), want)).map(([ref, want]) => `${ref}: got ${show(get(ref))} want ${want.type}:${want.value}`);
    failures.push(...bad);
    if (bad.length) throw new Error(bad.join("; "));
  });
}

/* ---- second, independent oracle: PyPI `formulas` (scripts/oracle-formulas-py.mts) ---- */
interface PyVec { formula: string; ok: boolean; value?: unknown; reason?: string }
const py = JSON.parse(readFileSync("docs/test-fixtures/formula-oracle-py.json", "utf8")) as { oracle: string; vectors: PyVec[] };
/** Declared, reviewed divergences where the ORACLE is wrong vs Microsoft's documentation (each has a reason). */
export const PY_ORACLE_KNOWN_WRONG: Record<string, string> = {
  '=TEXTJOIN("-",TRUE,{"a","","c"})': 'Microsoft: ignore_empty=TRUE ignores empty cells/strings → "a-c"; the oracle returns "a--c".',
  "=N(TRUE)": "Microsoft N(): TRUE → 1 (a number); the oracle returns the boolean itself.",
  "=ROWS({1,2;3,4;5,6})": "Microsoft ROWS accepts an array constant (3 rows); the oracle errors.",
  "=COLUMNS({1,2;3,4;5,6})": "Microsoft COLUMNS accepts an array constant (2 columns); the oracle errors.",
  "=CEILING.MATH(-4.3)": "Microsoft example: CEILING.MATH(-8.1,2) = -8 (rounds toward +inf for negatives by default) → -4; the oracle returns +5.",
  "=FLOOR.MATH(-4.3)": "Microsoft example: FLOOR.MATH(-8.1,2) = -10 (rounds toward -inf) → -5; the oracle returns +4.",
};
/** Disputed: no authoritative ground truth (Microsoft documents the function as unreliable). */
export const PY_ORACLE_DISPUTED: Record<string, string> = {
  '=DATEDIF(DATE(2020,1,15),DATE(2024,3,10),"MD")': 'Microsoft: "The MD argument may result in a negative number, a zero, or an inaccurate result." We borrow the month before the end date (24); the oracle borrows 31 days (26).',
};
function samePy(got: Scalar | undefined, want: unknown): boolean {
  if (got === undefined) return false;
  if (want && typeof want === "object" && !Array.isArray(want) && "error" in (want as object)) return isError(got) && got.error === (want as { error: string }).error;
  if (isError(got)) return false;
  if (typeof want === "number") return typeof got === "number" && Math.abs(got - want) <= 1e-9 * Math.max(1, Math.abs(want));
  if (typeof want === "boolean") return got === want;
  return String(got) === String(want);
}
const pyResults = { agree: 0, disagree: [] as string[], oracleUnsupported: 0, knownWrong: 0 };
await test(`oracle 2 (${py.oracle}): extended-library vectors agree with an independent Excel interpreter`, { "FF-27": "full" }, () => {
  for (const v of py.vectors) {
    if (!v.ok) { pyResults.oracleUnsupported++; continue; }
    if (Array.isArray(v.value)) { pyResults.oracleUnsupported++; continue; }
    const got = runGrid([[v.formula]])("A1");
    if (samePy(got, v.value)) pyResults.agree++;
    else if (PY_ORACLE_KNOWN_WRONG[v.formula] || PY_ORACLE_DISPUTED[v.formula]) pyResults.knownWrong++;
    else pyResults.disagree.push(`${v.formula}: ours ${show(got)} oracle ${JSON.stringify(v.value)}`);
  }
  console.log(`    agree ${pyResults.agree}, disagree ${pyResults.disagree.length}, oracle-unsupported ${pyResults.oracleUnsupported}, oracle-known-wrong ${pyResults.knownWrong}`);
  if (pyResults.disagree.length) throw new Error(`${pyResults.disagree.length} disagreements:\n      ${pyResults.disagree.join("\n      ")}`);
});
finish();
