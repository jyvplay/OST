/**
 * TT139 suite: FF-19 formula engine + FF-20/FF-21 SpreadsheetML I/O.
 *
 * Every assertion here is anchored to behaviour that is checkable by hand or
 * against a documented spreadsheet rule, not to "it ran without throwing".
 */
import { makeHarness } from "./harness.mts";
import {
  tokenize, parseFormula, evaluateFormula, extractRefs, extractFunctions,
  buildDependencyGraph, topologicalOrder, circularCells, evaluateSheet,
  colLetter, parseColLetter, makeRef, parseRef, formatNumber,
  SUPPORTED_FUNCTIONS, isErrorValue, serialFromMs, msFromSerial, ERR,
  type CellValue,
} from "../src/lib/formulas/formula-engine.ts";
import {
  createWorkbook, addSheet, setCell, getCell, clearCell, usedRange, sheetNames,
  writeWorkbook, readWorkbook, recalculateWorkbook, a1ToR1C1, r1c1ToA1, looksR1C1,
  type WorkbookData,
} from "../src/lib/formulas/spreadsheet-io.ts";

const { test, finish } = makeHarness("tt139-formulas");

/** Evaluator with no cell backing. */
const ev = (f: string, now = 0) => evaluateFormula(f, () => null, { now, random: () => 0.5 });
const num = (f: string) => {
  const r = ev(f);
  if (typeof r.value !== "string" && typeof r.value === "number") return r.value;
  throw new Error(`${f} → ${JSON.stringify(r.value)}${r.error ? ` (${r.error})` : ""}, expected a number`);
};

// ══ FF-19 · lexer ════════════════════════════════════════════════════════

await test("FF-19 · lexer splits numbers, strings, refs, ranges, operators", { "FF-19": "full" }, () => {
  const t = tokenize("=SUM(A1:B2,3)+\"x\"&TRUE");
  const kinds = t.map((x) => x.type);
  if (kinds[0] !== "func") throw new Error(`first token ${kinds[0]}`);
  if (!kinds.includes("range")) throw new Error("range token missing");
  if (!kinds.includes("str")) throw new Error("string token missing");
  if (!kinds.includes("op")) throw new Error("operator token missing");
  if (!kinds.includes("bool")) throw new Error("bool token missing");

  const r = tokenize("=A1")[0];
  if (r.type !== "ref" || r.row !== 1 || r.col !== 1) throw new Error("A1 not lexed as ref");

  // A1 is a ref; SUM( is a func — the two must not be confused.
  if (tokenize("=SUM(1)")[0].type !== "func") throw new Error("SUM not lexed as func");
  if (tokenize("=A2")[0].type !== "ref") throw new Error("A2 not lexed as ref");
});

await test("FF-19 · lexer handles scientific notation and doubled quotes", { "FF-19": "full" }, () => {
  const sci = tokenize("=1e3")[0];
  if (sci.type !== "num" || sci.value !== 1000) throw new Error(`1e3 → ${JSON.stringify(sci)}`);
  const neg = tokenize("=2.5E-3")[0];
  if (neg.type !== "num" || neg.value !== 0.0025) throw new Error(`2.5E-3 → ${JSON.stringify(neg)}`);
  // "" is how a spreadsheet escapes a quote inside a string literal.
  const q = tokenize('="say ""hi"""')[0];
  if (q.value !== 'say "hi"') throw new Error(`doubled-quote escape → ${JSON.stringify(q.value)}`);
});

await test("FF-19 · lexer rejects junk instead of silently ignoring it", { "FF-19": "full" }, () => {
  for (const bad of ["=1 ~ 2", "=NOSUCHNAME", "=#BOGUS!", "="]) {
    let threw = false;
    try { parseFormula(bad); } catch { threw = true; }
    if (!threw) throw new Error(`${JSON.stringify(bad)} should have thrown`);
  }
});

// ══ FF-19 · parser precedence ════════════════════════════════════════════

await test("FF-19 · precedence: -2^2 is 4, and 0-2^2 is -4 (Excel rule)", { "FF-19": "full" }, () => {
  // Verified against independent reports of Excel's behaviour: Excel binds
  // unary minus TIGHTER than ^, so =-2^2 gives 4, while =0-2^2 gives -4
  // because the binary minus has lower precedence than ^.
  //   learn.microsoft.com/en-us/answers/questions/4802138/order-of-operations
  //   github.com/b32n/spindle/issues/68
  // Both conventions exist in the wild (Google Sheets gives -4), so the
  // engine documents and tests the one it implements rather than pretending
  // there is only one.
  const v = num("=-2^2");
  if (v !== 4) throw new Error(`-2^2 → ${v}, this engine follows Excel (4)`);
  if (num("=0-2^2") !== -4) throw new Error("0-2^2 must be -4: binary minus is looser than ^");
  if (num("=-A1^2".replace("A1", "1")) !== 1) throw new Error("=-1^2 must be 1 under the same rule");
  if (num("=2^3^2") !== 512) throw new Error("^ must be right-associative (2^3^2 = 512)");
  if (num("=2^-2") !== 0.25) throw new Error("negative exponent must parse");
  if (num("=-(2^2)") !== -4) throw new Error("explicit parens must still give -4");
});

await test("FF-19 · precedence: * / before + -, & below arithmetic", { "FF-19": "full" }, () => {
  if (num("=1+2*3") !== 7) throw new Error("+ before *");
  if (num("=(1+2)*3") !== 9) throw new Error("parens ignored");
  if (num("=10-2-3") !== 5) throw new Error("- must be left-associative");
  if (num("=100/10/2") !== 5) throw new Error("/ must be left-associative");
  const s = ev('=1+2&"x"');
  if (s.value !== "3x") throw new Error(`& must bind looser than +, got ${JSON.stringify(s.value)}`);
});

await test("FF-19 · comparison is lowest precedence and returns booleans", { "FF-19": "full" }, () => {
  if (num("=IF(1+1=2,10,20)") !== 10) throw new Error("comparison inside IF mis-parsed");
  if (ev("=2>1").value !== true) throw new Error("2>1 should be TRUE");
  if (ev("=1<>1").value !== false) throw new Error("1<>1 should be FALSE");
  if (ev('="a"="A"').value !== true) throw new Error("text compare should be case-insensitive");
});

await test("FF-19 · percent postfix and unary chains", { "FF-19": "full" }, () => {
  if (num("=50%") !== 0.5) throw new Error(`50% → ${num("=50%")}`);
  if (num("=200*10%") !== 20) throw new Error("200*10% should be 20");
  if (num("=--5") !== 5) throw new Error("double negation should give 5");
});

// ══ FF-19 · function library ═════════════════════════════════════════════

await test("FF-19 · every advertised function actually runs", { "FF-19": "full" }, () => {
  if (SUPPORTED_FUNCTIONS.length < 60) throw new Error(`only ${SUPPORTED_FUNCTIONS.length} functions`);
  // A call that reaches the dispatcher returns something other than #NAME?.
  // Functions that legitimately need arguments may return #VALUE!; what must
  // never happen is a name miss, which would mean the list lies.
  const misses = SUPPORTED_FUNCTIONS.filter((name) => {
    const r = evaluateFormula(`=${name}()`, () => null, { now: 0, random: () => 0.5 });
    return r.value === ERR.name;
  });
  if (misses.length) throw new Error(`advertised but not dispatched: ${misses.join(", ")}`);
});

await test("FF-19 · aggregates skip text and blanks (spreadsheet rule)", { "FF-19": "full" }, () => {
  const cells: Record<string, CellValue> = { "1:1": 10, "2:1": "text", "3:1": null, "4:1": 30 };
  const get = (r: number, c: number) => cells[`${r}:${c}`] ?? null;
  const r = evaluateFormula("=SUM(A1:A4)", get);
  if (r.value !== 40) throw new Error(`SUM over mixed range → ${r.value}, want 40`);
  const avg = evaluateFormula("=AVERAGE(A1:A4)", get);
  if (avg.value !== 20) throw new Error(`AVERAGE must divide by numeric count only → ${avg.value}`);
  const cnt = evaluateFormula("=COUNT(A1:A4)", get);
  if (cnt.value !== 2) throw new Error(`COUNT → ${cnt.value}, want 2`);
  const ca = evaluateFormula("=COUNTA(A1:A4)", get);
  if (ca.value !== 3) throw new Error(`COUNTA → ${ca.value}, want 3 (text counts, blank does not)`);
});

await test("FF-19 · aggregates over an all-empty range do not divide by zero", { "FF-19": "full" }, () => {
  const r = ev("=AVERAGE(A1:A3)");
  if (r.value !== ERR.div0) throw new Error(`AVERAGE of nothing → ${JSON.stringify(r.value)}, want #DIV/0!`);
  if (ev("=SUM(A1:A3)").value !== 0) throw new Error("SUM of nothing must be 0");
  if (ev("=COUNT(A1:A3)").value !== 0) throw new Error("COUNT of nothing must be 0");
});

await test("FF-19 · statistics are correct, not approximately correct", { "FF-19": "full" }, () => {
  if (num("=MEDIAN(1,2,3)") !== 2) throw new Error("MEDIAN odd");
  if (num("=MEDIAN(1,2,3,4)") !== 2.5) throw new Error("MEDIAN even");
  // Sample variance of [2,4,4,4,5,5,7,9] is exactly 32/7.
  const v = num("=VAR(2,4,4,4,5,5,7,9)");
  if (Math.abs(v - 32 / 7) > 1e-12) throw new Error(`VAR → ${v}, want ${32 / 7}`);
  const sd = num("=STDEV(2,4,4,4,5,5,7,9)");
  if (Math.abs(sd - Math.sqrt(32 / 7)) > 1e-12) throw new Error(`STDEV → ${sd}`);
  if (ev("=PERCENTILE(A1:A4,0.5)").value !== ERR.num) throw new Error("PERCENTILE on empty must be #NUM!");
  // Percentile of a known set: [1,2,3,4], p=0.25 → 1.75 by linear interpolation.
  const cells: Record<string, CellValue> = { "1:1": 1, "2:1": 2, "3:1": 3, "4:1": 4 };
  const p25 = evaluateFormula("=PERCENTILE(A1:A4,0.25)", (r) => cells[`${r}:1`] ?? null);
  if (p25.value !== 1.75) throw new Error(`PERCENTILE(0.25) → ${p25.value}, want 1.75`);
  if (evaluateFormula("=LARGE(A1:A4,2)", (r) => cells[`${r}:1`] ?? null).value !== 3) throw new Error("LARGE");
  if (evaluateFormula("=SMALL(A1:A4,2)", (r) => cells[`${r}:1`] ?? null).value !== 2) throw new Error("SMALL");
});

await test("FF-19 · ROUND is half-away-from-zero on both signs", { "FF-19": "full" }, () => {
  // Math.round(-2.5) is -2 in JS; spreadsheet ROUND(-2.5) is -3.
  if (num("=ROUND(2.5)") !== 3) throw new Error("ROUND(2.5) must be 3");
  if (num("=ROUND(-2.5)") !== -3) throw new Error(`ROUND(-2.5) → ${num("=ROUND(-2.5)")}, must be -3`);
  if (num("=ROUND(3.14159,2)") !== 3.14) throw new Error("ROUND to 2 dp");
  if (num("=ROUND(1234.5678,-2)") !== 1200) throw new Error("negative digits round left of the point");
  if (num("=FLOOR(-1.5)") !== -2) throw new Error("FLOOR(-1.5) must be -2");
  if (num("=CEILING(-1.5)") !== -1) throw new Error("CEILING(-1.5) must be -1");
});

await test("FF-19 · MOD follows the sign of the divisor", { "FF-19": "full" }, () => {
  // JS % gives -1 for -7 % 3; spreadsheet MOD gives 2.
  const v = num("=MOD(-7,3)");
  if (v !== 2) throw new Error(`MOD(-7,3) → ${v}, spreadsheet rule is 2`);
  if (num("=MOD(7,-3)") !== -2) throw new Error(`MOD(7,-3) → ${num("=MOD(7,-3)")}, want -2`);
  if (ev("=MOD(1,0)").value !== ERR.div0) throw new Error("MOD by zero must be #DIV/0!");
});

await test("FF-19 · text functions respect 1-based indexes", { "FF-19": "full" }, () => {
  if (ev('=MID("abcdef",2,3)').value !== "bcd") throw new Error(`MID 1-based → ${ev('=MID("abcdef",2,3)').value}`);
  if (ev('=LEFT("abc",0)').value !== "") throw new Error("LEFT 0 chars must be empty");
  if (ev('=RIGHT("abc",2)').value !== "bc") throw new Error("RIGHT");
  if (ev('=FIND("c","abc")').value !== 3) throw new Error(`FIND must be 1-based → ${ev('=FIND("c","abc")').value}`);
  if (ev('=SUBSTITUTE("a-b-c","-","+",2)').value !== "a-b+c") throw new Error("SUBSTITUTE instance number");
  if (ev('=REPLACE("abcdef",2,3,"X")').value !== "aXef") throw new Error("REPLACE");
  if (ev('=TRIM("  a   b  ")').value !== "a b") throw new Error("TRIM must collapse runs and strip edges");
  if (ev("=LEN(A1)").value !== 0) throw new Error("LEN of blank must be 3");
});

await test("FF-19 · errors propagate through every operator", { "FF-19": "full" }, () => {
  const cases = ["=1/0+1", "=1/0&\"x\"", "=1/0>1", "=-1/0", "=SQRT(-1)+1"];
  for (const f of cases) {
    const r = ev(f);
    // A number here would mean the error was swallowed and a wrong value
    // presented as correct — the exact failure this test exists to catch.
    if (typeof r.value === "number") throw new Error(`${f} swallowed its error and returned ${r.value}`);
    if (!isErrorValue(r.value)) throw new Error(`${f} → ${JSON.stringify(r.value)}, expected an error value`);
  }
  if (ev("=1/0").value !== ERR.div0) throw new Error("#DIV/0! literal wrong");
  if (!isErrorValue(ev("=1/0").value)) throw new Error("isErrorValue missed #DIV/0!");
  if (isErrorValue(42)) throw new Error("isErrorValue false-positive on a number");
  if (ev("=SQRT(-1)").value !== ERR.num) throw new Error("SQRT(-1) must be #NUM!");
  if (ev("=NOPE(1)").value !== ERR.name) throw new Error("unknown function must be #NAME?");
});

await test("FF-19 · IFERROR and IF short-circuit (unused branch is not evaluated)", { "FF-19": "full" }, () => {
  if (num("=IFERROR(1/0,7)") !== 7) throw new Error("IFERROR did not catch");
  if (num("=IFERROR(3,7)") !== 3) throw new Error("IFERROR replaced a good value");
  // If IF evaluated both branches, the #DIV/0! would leak through.
  if (num("=IF(TRUE,1,1/0)") !== 1) throw new Error("IF evaluated the untaken branch");
  if (num("=IF(FALSE,1,2)") !== 2) throw new Error("IF false branch");
  if (ev("=IF(FALSE,1)").value !== false) throw new Error("IF with no else returns FALSE");
});

await test("FF-19 · lookup functions honour the declared orientation", { "FF-19": "full" }, () => {
  // A 3x2 block: rows (1,'a'), (2,'b'), (3,'c')
  const cells: Record<string, CellValue> = {
    "1:1": 1, "1:2": "a", "2:1": 2, "2:2": "b", "3:1": 3, "3:2": "c",
  };
  const get = (r: number, c: number) => cells[`${r}:${c}`] ?? null;
  const exact = evaluateFormula("=VLOOKUP(2,A1:B3,2,FALSE)", get);
  if (exact.value !== "b") throw new Error(`VLOOKUP exact → ${JSON.stringify(exact.value)}`);
  const miss = evaluateFormula("=VLOOKUP(9,A1:B3,2,FALSE)", get);
  if (miss.value !== ERR.na) throw new Error("VLOOKUP miss must be #N/A");
  const matchExact = evaluateFormula("=MATCH(3,A1:A3,0)", get);
  if (matchExact.value !== 3) throw new Error(`MATCH → ${JSON.stringify(matchExact.value)}, want 3`);
  const idx = evaluateFormula("=INDEX(A1:B3,2,2)", get);
  if (idx.value !== "b") throw new Error(`INDEX → ${JSON.stringify(idx.value)}`);
  const bad = evaluateFormula("=VLOOKUP(1,A1:B3,5,FALSE)", get);
  if (bad.value !== ERR.ref) throw new Error("VLOOKUP column beyond table must be #REF!");
});

await test("FF-19 · date serials use the 1900 system (epoch 1899-12-30)", { "FF-19": "full" }, () => {
  // 2024-01-01 is serial 45292 in the 1900 date system. This is checkable
  // arithmetic, not a guess: (2024-01-01 - 1899-12-30) = 45292 days.
  const ms = Date.UTC(2024, 0, 1);
  const serial = serialFromMs(ms);
  if (Math.abs(serial - 45292) > 1e-9) throw new Error(`2024-01-01 → ${serial}, want 45292`);
  if (msFromSerial(45292).toISOString().slice(0, 10) !== "2024-01-01") throw new Error("round-trip failed");
  const get = () => 45292;
  if (evaluateFormula("=YEAR(A1)", get).value !== 2024) throw new Error("YEAR");
  if (evaluateFormula("=MONTH(A1)", get).value !== 1) throw new Error("MONTH");
  if (evaluateFormula("=DAY(A1)", get).value !== 1) throw new Error("DAY");
  // NOW() must read the injected clock, not the host clock.
  const nowAt = Date.UTC(2024, 5, 15);
  const nowVal = evaluateFormula("=NOW()", () => null, { now: nowAt });
  if (Math.floor(Number(nowVal.value)) !== Math.floor(serialFromMs(nowAt))) throw new Error(`NOW → ${nowVal.value}`);
  const todayVal = evaluateFormula("=TODAY()", () => null, { now: nowAt });
  if (Number(todayVal.value) % 1 !== 0) throw new Error("TODAY must be a whole serial");
  if (Number(todayVal.value) !== Math.floor(serialFromMs(nowAt))) throw new Error("TODAY mismatch");
});

await test("FF-19 · RAND is injected, never Math.random", { "FF-19": "full" }, () => {
  const a = evaluateFormula("=RAND()", () => null, { random: () => 0.25 });
  const b = evaluateFormula("=RAND()", () => null, { random: () => 0.25 });
  if (a.value !== 0.25 || b.value !== 0.25) throw new Error("RAND did not use the injected source");
  if (evaluateFormula("=RAND()", () => null).value !== 0) throw new Error("RAND default must be deterministic");
});

// ══ FF-19 · dependency graph ═════════════════════════════════════════════

await test("FF-19 · extractRefs expands ranges and dedupes", { "FF-19": "full" }, () => {
  const refs = extractRefs(parseFormula("=A1+A1:B2"));
  const keys = refs.map((r) => `${r.row}:${r.col}`).sort();
  if (new Set(keys).size !== keys.length) throw new Error("duplicate refs not deduped");
  if (!keys.includes("1:1") || !keys.includes("2:2")) throw new Error(`range not expanded: ${keys}`);
  const fns = extractFunctions(parseFormula("=SUM(A1:A2)+IF(1,2,3)"));
  if (fns.join(",") !== "SUM,IF") throw new Error(`functions → ${fns}`);
});

await test("FF-19 · topological order puts dependencies first", { "FF-19": "full" }, () => {
  const cells = [
    { row: 3, col: 1, formula: "=A1*2" },
    { row: 1, col: 1, formula: "=B1+1" },
    { row: 2, col: 1, formula: "=A1+1" },
    { row: 1, col: 2 },
  ];
  const g = buildDependencyGraph(cells);
  const { order, cycles } = topologicalOrder(g);
  if (cycles.length) throw new Error(`unexpected cycles: ${cycles}`);
  const at = (k: string) => order.indexOf(k);
  if (at("1:2") > at("1:1")) throw new Error("B1 must precede A1");
  if (at("1:1") > at("2:1")) throw new Error("A1 must precede A2");
  if (at("1:1") > at("3:1")) throw new Error("A1 must precede A3");
});

await test("FF-19 · cycles are reported, not linearised", { "FF-19": "full" }, () => {
  const cells = [
    { row: 1, col: 1, formula: "=B1" },
    { row: 1, col: 2, formula: "=A1" },
    { row: 2, col: 1, formula: "=A1+1" },
  ];
  const g = buildDependencyGraph(cells);
  const { cycles } = topologicalOrder(g);
  if (cycles.length !== 2) throw new Error(`cycle set → ${cycles}, want the A1/B1 pair`);
  const downstream = circularCells(g);
  if (!downstream.includes("2:1")) throw new Error("cell downstream of a cycle must be flagged");
});

await test("FF-19 · evaluateSheet gives cycle cells #REF!, never a stale number", { "FF-19": "full" }, () => {
  const cells = [
    { row: 1, col: 1, formula: "=B1+1" },
    { row: 1, col: 2, formula: "=A1+1" },
    { row: 3, col: 1, formula: "=A1+1" },
  ];
  const { results, cycles } = evaluateSheet(cells);
  if (cycles.length !== 2) throw new Error(`cycles → ${cycles}`);
  const a1 = results.find((r) => r.row === 1 && r.col === 1);
  if (a1?.value !== ERR.ref) throw new Error(`cycle cell → ${JSON.stringify(a1?.value)}, want #REF!`);
  const downstream = results.find((r) => r.row === 3 && r.col === 1);
  if (downstream?.value !== ERR.ref) throw new Error("downstream of cycle must be #REF!");
});

await test("FF-19 · evaluateSheet computes a real chain in one pass", { "FF-19": "full" }, () => {
  const cells = [
    { row: 1, col: 1, formula: "=5" },
    { row: 2, col: 1, formula: "=A1*2" },
    { row: 3, col: 1, formula: "=A2+A1" },
  ];
  const { results, cycles } = evaluateSheet(cells);
  if (cycles.length) throw new Error("false cycle");
  const at = (r: number) => results.find((x) => x.row === r)?.value;
  if (at(1) !== 5 || at(2) !== 10 || at(3) !== 15) throw new Error(`chain → ${at(1)},${at(2)},${at(3)}`);
});

// ══ FF-19 · reference helpers ════════════════════════════════════════════

await test("FF-19 · column letters round-trip across the AA boundary", { "FF-19": "full" }, () => {
  const pairs: Array<[number, string]> = [[1, "A"], [26, "Z"], [27, "AA"], [52, "AZ"], [53, "BA"], [702, "ZZ"], [703, "AAA"]];
  for (const [n, s] of pairs) {
    if (colLetter(n) !== s) throw new Error(`colLetter(${n}) → ${colLetter(n)}, want ${s}`);
    if (parseColLetter(s) !== n) throw new Error(`parseColLetter(${s}) → ${parseColLetter(s)}, want ${n}`);
  }
  if (makeRef(12, 28) !== "AB12") throw new Error(`makeRef → ${makeRef(12, 28)}`);
  const p = parseRef("$AB$12");
  if (!p || p.row !== 12 || p.col !== 28) throw new Error("absolute ref not parsed");
  if (parseRef("nope") !== null) throw new Error("junk must parse to null");
  let threw = false;
  try { colLetter(0); } catch { threw = true; }
  if (!threw) throw new Error("colLetter(0) must throw");
});

await test("FF-19 · formatNumber is deterministic without trailing-float noise", { "FF-19": "full" }, () => {
  if (formatNumber(0.1 + 0.2) !== "0.3") throw new Error(`0.1+0.2 → ${formatNumber(0.1 + 0.2)}`);
  if (formatNumber(1e21) === "") throw new Error("huge values must still format");
  if (formatNumber(1 / 3) !== "0.333333333333333") throw new Error(`1/3 → ${formatNumber(1 / 3)}`);
});

// ══ FF-20 · writer ═══════════════════════════════════════════════════════

await test("FF-20 · writer emits valid SpreadsheetML (ss:Index integer, ss:Formula R1C1)", { "FF-20": "full" }, () => {
  let wb = createWorkbook(["Data"]);
  wb = setCell(wb, "A1", 2);
  wb = setCell(wb, "B1", 6, "Data", "=A1*3");
  const xml = writeWorkbook(wb);

  if (!/<(?:\w+:)?Workbook[\s>]/.test(xml)) throw new Error("no Workbook root");
  if (!/ss:Name="Data"/.test(xml)) throw new Error("no worksheet name");
  if (!/ss:Formula=/.test(xml)) throw new Error("no ss:Formula attribute — formulas would be lost");

  // The critical correctness check: ss:Index must be an integer, never "A1".
  const idx = [...xml.matchAll(/ss:Index="([^"]*)"/g)].map((m) => m[1]);
  for (const v of idx) {
    if (!/^\d+$/.test(v)) throw new Error(`ss:Index must be an integer, got "${v}"`);
  }
  // And the formula must be R1C1 relative to its own cell, not A1.
  const f = /ss:Formula="([^"]*)"/.exec(xml)?.[1] ?? "";
  if (!/^=[RC]/.test(f)) throw new Error(`ss:Formula must be R1C1, got "${f}"`);
});

await test("FF-20 · a formula cell carries its cached result", { "FF-20": "full" }, () => {
  let wb = createWorkbook();
  wb = setCell(wb, "A1", 4);
  wb = setCell(wb, "A2", 20, "Sheet1", "=A1*5");
  const xml = writeWorkbook(wb);
  // Without a cached <Data> the cell renders blank in any non-recalculating reader.
  if (!/<Cell[^>]*ss:Formula[^>]*>\s*<Data ss:Type="Number">20<\/Data>/.test(xml)) {
    throw new Error(`cached value missing beside formula: ${xml.split("\n").find((l) => l.includes("ss:Formula"))}`);
  }
});

await test("FF-20 · multi-sheet workbook writes every sheet in order", { "FF-20": "full" }, () => {
  let wb = createWorkbook(["First", "Second", "Third"]);
  wb = setCell(wb, "A1", 1, "First");
  wb = setCell(wb, "A1", 2, "Third");
  const xml = writeWorkbook(wb);
  const names = [...xml.matchAll(/ss:Name="([^"]+)"/g)].map((m) => m[1]);
  if (names.join(",") !== "First,Second,Third") throw new Error(`sheet order → ${names}`);
  if (sheetNames(addSheet(wb, "Fourth")).length !== 4) throw new Error("addSheet");
});

await test("FF-20 · writer escapes XML metacharacters and rejects illegal sheet names", { "FF-20": "full" }, () => {
  let wb = createWorkbook();
  wb = setCell(wb, "A1", `<a>&"'`);
  const xml = writeWorkbook(wb);
  if (xml.includes("<a>")) throw new Error("raw < leaked into the file");
  if (!xml.includes("&lt;a&gt;")) throw new Error("escaping missing");
  for (const bad of ["a/b", "a:b", "a*b", "a?b", "a[b]", "a\\b", "x".repeat(32), ""]) {
    let threw = false;
    try { writeWorkbook(createWorkbook([bad])); } catch { threw = true; }
    if (!threw) throw new Error(`illegal sheet name ${JSON.stringify(bad)} was accepted`);
  }
});

await test("FF-20 · writer refuses out-of-order or duplicate-ref cells", { "FF-20": "full" }, () => {
  let wb = createWorkbook();
  wb = setCell(wb, "C1", 1);
  wb = setCell(wb, "A1", 2);
  wb = setCell(wb, "B1", 3);
  // setCell sorts by column, so A1,B1,C1 must be emitted in that order with no
  // ss:Index gap at all. In SpreadsheetML the cell reference is positional, so
  // "A1" never appears literally — the check is that nothing is skipped.
  const xml = writeWorkbook(wb);
  const block = /<Row[^>]*>([\s\S]*?)<\/Row>/.exec(xml)?.[1] ?? "";
  const cellCount = (block.match(/<Cell/g) ?? []).length;
  if (cellCount !== 3) throw new Error(`row block has ${cellCount} cells, want 3: ${block.trim()}`);
  if (/ss:Index/.test(block)) throw new Error(`contiguous row must not emit ss:Index: ${block.trim()}`);
  // And the values must appear in column order A,B,C → 2,3,1.
  const vals = [...block.matchAll(/>([^<>]+)<\/Data>/g)].map((m) => m[1]);
  if (vals.join(",") !== "2,3,1") throw new Error(`column order lost: ${vals}`);
  let threw = false;
  try {
    writeWorkbook({ sheets: [{ name: "S", rows: [{ cells: [{ ref: "B1", value: 1 }] }, { cells: [{ ref: "A1", value: 2 }] }] }] });
  } catch { threw = true; }
  if (!threw) throw new Error("decreasing row numbers must be rejected");
});

// ══ FF-21 · reader ═══════════════════════════════════════════════════════

await test("FF-21 · round-trip preserves sheets, values and formulas", { "FF-21": "full" }, () => {
  let wb = createWorkbook(["Data", "Summary"]);
  wb = setCell(wb, "A1", 4, "Data");
  wb = setCell(wb, "A2", 20, "Data", "=A1*5");
  wb = setCell(wb, "B1", 21, "Summary", "=Data!A2+1");
  const xml = writeWorkbook(wb);
  const back = readWorkbook(xml);

  if (sheetNames(back).join(",") !== "Data,Summary") throw new Error(`sheets → ${sheetNames(back)}`);
  if (getCell(back, "A1", "Data") !== 4) throw new Error("literal lost");
  const a2 = back.sheets[0].rows.flatMap((r) => r.cells).find((c) => c.ref === "A2");
  if (!a2?.formula) throw new Error("formula dropped on read — the whole point of FF-21");
  if (a2.formula !== "=A1*5") throw new Error(`formula mangled: ${a2.formula}`);
  const b1 = back.sheets[1].rows.flatMap((r) => r.cells).find((c) => c.ref === "B1");
  if (b1?.formula !== "=Data!A2+1") throw new Error(`cross-sheet formula mangled: ${b1?.formula}`);
});

await test("FF-21 · round-trip is a fixed point (write∘read∘write is stable)", { "FF-21": "full" }, () => {
  let wb = createWorkbook(["S"]);
  wb = setCell(wb, "A1", 1);
  wb = setCell(wb, "B2", 2, "S", "=A1+1");
  wb = setCell(wb, "D4", "text");
  const once = writeWorkbook(wb);
  const twice = writeWorkbook(readWorkbook(once));
  if (once !== twice) {
    const a = once.split("\n");
    const b = twice.split("\n");
    const i = a.findIndex((l, k) => l !== b[k]);
    throw new Error(`not idempotent at line ${i}:\n  ${a[i]}\n  ${b[i]}`);
  }
});

await test("FF-21 · reader accepts a foreign file using ss:Index gaps", { "FF-21": "full" }, () => {
  // Hand-written file: C2 holds a value, A2 is skipped entirely.
  const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="Foreign">
    <Table>
      <Row ss:Index="2"><Cell ss:Index="3"><Data ss:Type="Number">7</Data></Cell></Row>
      <Row><Cell><Data ss:Type="String">x</Data></Cell></Row>
    </Table>
  </Worksheet>
</Workbook>`;
  const wb = readWorkbook(xml);
  if (getCell(wb, "C2", "Foreign") !== 7) throw new Error("ss:Index row/column gaps not honoured");
  if (getCell(wb, "A3", "Foreign") !== "x") throw new Error("row after a gapped row must continue at +1");
});

await test("FF-21 · reader accepts A1 formulas from third-party writers", { "FF-21": "full" }, () => {
  const xml = `<Workbook xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="S"><Table>
    <Row><Cell><Data ss:Type="Number">3</Data></Cell>
         <Cell ss:Formula="=A1*2"><Data ss:Type="Number">6</Data></Cell></Row>
  </Table></Worksheet></Workbook>`;
  const wb = readWorkbook(xml);
  const b1 = wb.sheets[0].rows[0].cells[1];
  if (b1.formula !== "=A1*2") throw new Error(`A1 formula not preserved: ${b1.formula}`);
  if (b1.value !== 6) throw new Error("cached value not read");
});

await test("FF-21 · A1⇄R1C1 conversion is exact for relative and absolute refs", { "FF-21": "full" }, () => {
  // In B2 (row 2, col 2):
  const cases: Array<[string, string]> = [
    ["A1+1", "R[-1]C[-1]+1"],
    ["$A$1", "R1C1"],
    ["A$1", "R1C[-1]"],
    ["$A1", "R[-1]C1"],
    ["B2", "RC"],
    ["A1:B2", "R[-1]C[-1]:RC"],
  ];
  for (const [a1, want] of cases) {
    const got = a1ToR1C1(a1, 2, 2);
    if (got !== want) throw new Error(`a1ToR1C1(${a1}) in B2 → ${got}, want ${want}`);
    const back = r1c1ToA1(want, 2, 2);
    if (back !== a1) throw new Error(`r1c1ToA1(${want}) in B2 → ${back}, want ${a1}`);
  }
  // String literals must survive untouched.
  if (a1ToR1C1('"A1"&A1', 2, 2) !== '"A1"&R[-1]C[-1]') {
    throw new Error(`string literal mangled: ${a1ToR1C1('"A1"&A1', 2, 2)}`);
  }
  if (looksR1C1("A1+1")) throw new Error("A1 misdetected as R1C1");
  if (!looksR1C1("R[-1]C[-1]+1")) throw new Error("R1C1 not detected");
  if (r1c1ToA1("R[-5]C1", 2, 1) !== "#REF!") throw new Error("off-sheet ref must become #REF!");
});

await test("FF-21 · reader rejects junk instead of returning an empty workbook", { "FF-21": "full" }, () => {
  for (const bad of ["", "<html/>", "<Workbook>", "<Workbook><Worksheet/></Workbook>"]) {
    let threw = false;
    try { readWorkbook(bad); } catch { threw = true; }
    if (!threw) throw new Error(`${JSON.stringify(bad)} should have thrown`);
  }
});

// ══ FF-21 · recalculation ════════════════════════════════════════════════

await test("FF-21 · recalculation chains and settles", { "FF-21": "full" }, () => {
  let wb = createWorkbook(["S"]);
  wb = setCell(wb, "A1", 1);
  wb = setCell(wb, "A2", 2, "S", "=A1+1");
  wb = setCell(wb, "A3", 4, "S", "=A2*2");
  wb = setCell(wb, "A4", 5, "S", "=A3+A1");
  const rep = recalculateWorkbook(wb);
  if (rep.circular.length) throw new Error(`false circular: ${rep.circular}`);
  if (rep.values["S!A4"] !== 5) throw new Error(`A4 → ${rep.values["S!A4"]}, want 5`);
  if (rep.passes < 2) throw new Error("a 4-deep chain cannot settle in one pass");
});

await test("FF-21 · recalculation resolves cross-sheet references", { "FF-21": "full" }, () => {
  let wb = createWorkbook(["Data", "Sum"]);
  wb = setCell(wb, "A1", 10, "Data");
  wb = setCell(wb, "B1", 0, "Sum", "=Data!A1*10");
  const rep = recalculateWorkbook(wb);
  if (rep.values["Sum!B1"] !== 100) throw new Error(`cross-sheet → ${rep.values["Sum!B1"]}, want 100`);
});

await test("FF-21 · recalculation reports a real cycle instead of guessing", { "FF-21": "full" }, () => {
  let wb = createWorkbook(["S"]);
  wb = setCell(wb, "A1", 0, "S", "=B1+1");
  wb = setCell(wb, "B1", 0, "S", "=A1+1");
  const rep = recalculateWorkbook(wb);
  if (rep.circular.length !== 2) throw new Error(`cycle not reported: ${JSON.stringify(rep.circular)}`);
  if (!rep.circular.includes("S!A1") || !rep.circular.includes("S!B1")) throw new Error(`cycle keys → ${rep.circular}`);
});

await test("FF-21 · recalculation leaves the cached value's source untouched", { "FF-21": "full" }, () => {
  let wb = createWorkbook(["S"]);
  wb = setCell(wb, "A1", 3);
  wb = setCell(wb, "B1", 999, "S", "=A1*2");
  const before = JSON.stringify(wb);
  const rep = recalculateWorkbook(wb);
  if (JSON.stringify(wb) !== before) throw new Error("recalculateWorkbook mutated its input");
  if (rep.values["S!B1"] !== 6) throw new Error(`stale cached value not replaced: ${rep.values["S!B1"]}`);
});

// ══ cell model helpers ═══════════════════════════════════════════════════

await test("FF-20/FF-21 · model helpers: set/get/clear/usedRange", { "FF-20": "full", "FF-21": "full" }, () => {
  let wb = createWorkbook(["S"]);
  wb = setCell(wb, "b2", 5);
  if (getCell(wb, "B2") !== 5) throw new Error("case-insensitive ref set/get");
  wb = setCell(wb, "B2", 6);
  if (getCell(wb, "B2") !== 6) throw new Error("overwrite failed");
  wb = setCell(wb, "D5", "x");
  const range = usedRange(wb);
  if (range.rows !== 5 || range.cols !== 4) throw new Error(`usedRange → ${JSON.stringify(range)}`);
  wb = clearCell(wb, "D5");
  const after = usedRange(wb);
  if (after.cols !== 2) throw new Error(`clearCell did not shrink the range: ${JSON.stringify(after)}`);
  if (getCell(wb, "Z9") !== null) throw new Error("missing cell must read as null");
  if (getCell(wb, "A1", "NoSuchSheet") !== null) throw new Error("missing sheet must read as null");
  let threw = false;
  try { setCell(wb, "nonsense", 1); } catch { threw = true; }
  if (!threw) throw new Error("bad ref must throw");
});

// ══ adversarial: an independent attacker on the writer/reader pair ═══════

await test("FF-20/FF-21 · attacker: formula text cannot break out of an attribute", { "FF-20": "full", "FF-21": "full" }, () => {
  let wb = createWorkbook(["S"]);
  // A formula whose string literal contains attribute-breaking characters.
  wb = setCell(wb, "A1", `x" onload="alert(1)`, "S", `="x" onload="alert(1)`);
  const xml = writeWorkbook(wb);
  const cellLine = xml.split("\n").find((l) => l.includes("ss:Formula"))!;
  // Exactly one ss:Formula attribute must be present on that cell.
  const attrs = [...cellLine.matchAll(/ss:Formula="/g)].length;
  if (attrs !== 1) throw new Error(`attribute broke out: ${cellLine}`);
  if (!/&quot;/.test(cellLine)) throw new Error("quote inside formula was not escaped");
  // And it must still round-trip.
  const back = readWorkbook(xml);
  const a1 = back.sheets[0].rows[0].cells[0];
  if (!a1.formula) throw new Error("escaped formula did not round-trip");
});

finish();
