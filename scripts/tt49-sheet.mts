/**
 * TT49 — Spreadsheet conditional formatting at Class A: every ECMA-376 cfRule type is DISPLAYED (cellIs ×8 with
 * constant or formula operands, expression, text ×4, blanks/errors ×4, duplicate/unique, top/bottom N and N%,
 * above/below average ± k σ, time periods, colour scales, data bars incl. the x14 negative axis, icon sets incl.
 * x14-only and custom sets, dxf font/fill/numFmt/border) in priority order with stopIfTrue.
 *
 * External evidence:
 *   1. scripts/oracle/xlsx_cf_eval.py — an independent Python evaluator (openpyxl rule parser + Translator,
 *      the `formulas` engine for formula rules, cached cell values written by Excel) over every POI corpus
 *      workbook that has conditional formats;
 *   2. Apache POI's TestConditionalFormattingEval assertions (rule counts / colours per cell, incl. after edits);
 *   3. documented answers: Microsoft's data-bar length formula, W3Schools top/bottom-N% rounding, Ablebits
 *      "blank cells count as zero", MS-XLSX gte semantics.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt49-sheet.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook, writeXlsxWorkbook, workbookToJson, workbookFromJson } from "../src/lib/formula/xlsx.ts";
import { a1, Workbook } from "../src/lib/formula/engine.ts";
import { evalCondFormats, sanitizeCondFormats, parseRanges, type CondRule, type CfStyle } from "../src/lib/formula/sheetmeta.ts";
import { ICON_SETS, iconSvg } from "../src/lib/formula/cficons.ts";
import { patchXlsx, loadedBaseline } from "../src/lib/formula/xlsx-patch.ts";
import { openZip } from "../src/lib/office/zipkit.ts";
import { todaySerial } from "../src/lib/formula/dates.ts";

const { test: test0, finish } = makeHarness("tt49-sheet");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const CORPUS = "/home/user/tools/corpus/xlsx";
const PY = "/home/user/tools/venv/bin/python";
const haveCorpus = existsSync(CORPUS) && existsSync(PY);
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
/** canonical JSON: keys sorted at every depth (a key-array replacer would DROP nested keys such as cfvo.t/v) */
const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const COV = { "FF-29": "full", "FF-21": "full", "FF-20": "full" } as const;
const tmp = mkdtempSync(join(tmpdir(), "tt49-"));
const CF_FILES = ["46535", "48539", "55406_Conditional_formatting_sample", "61060-conditional-number-formatting", "61652", "ConditionalFormattingSamples", "FillWithoutColor",
  "LIBRE_OFFICE-128382-0", "NewStyleConditionalFormattings", "StructuredRefs-lots-with-lookups", "Themes2", "WithConditionalFormatting", "conditional_formatting_cell_is",
  "conditional_formatting_multiple_ranges", "conditional_formatting_with_formula_on_second_sheet", "dataValidationTableRange", "simple-monthly-budget", "test_conditional_formatting", "xssf-enum.xltx"]
  .map((f) => join(CORPUS, f + ".xlsx"));
const load = (f: string) => { const wb = readXlsxWorkbook(readFileSync(f)); wb.recalculate(); return wb; };
const cellsOf = (m: Map<string, CfStyle>) => [...m.keys()].map((k) => { const [c, r] = k.split(",").map(Number); return a1(c, r); }).sort();
const oracle = (paths: string[]) => execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_cf_eval.py"], { input: paths.join("\n"), encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n").map((l) => JSON.parse(l) as { file: string; error?: string; rules?: { sheet: string; idx: string | null; type: string; cells?: Record<string, unknown>; skip?: string }[] });
/** our per-rule result in the oracle's value vocabulary */
const ourValues = (wb: Workbook, rules: CondRule[]) => {
  const m = rules[0]; const out: Record<string, unknown> = {};
  for (const [k, s] of evalCondFormats(wb, m.sheet, rules)) {
    const [c, r] = k.split(",").map(Number);
    out[a1(c, r)] = m.kind === "icons" ? ICON_SETS[m.iconSet!].indexOf(s.icon!) : m.kind === "bar" ? Math.round((s.bar!.to - s.bar!.from) * 1e6) / 1e6 : m.kind === "scale" ? s.fill : true;
  }
  return out;
};
const same = (a: unknown, b: unknown) => typeof a === "number" && typeof b === "number" ? Math.abs(a - b) < 1e-6
  : typeof a === "string" && typeof b === "string" && a.startsWith("#") ? [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 1) : a === b;
function compare(wb: Workbook, o: NonNullable<ReturnType<typeof oracle>[number]["rules"]>) {
  let rules = 0, cells = 0; const bad: string[] = [], missing: string[] = [], skipped: string[] = [], x14: string[] = [];
  for (const r of o) {
    if (r.skip) { skipped.push(`${r.sheet} ${r.idx} ${r.type}: ${r.skip}`); continue; }
    const mine = wb.condFormats.filter((x) => x.sheet === r.sheet && x.src === r.idx);
    if (!mine.length) { missing.push(`${r.sheet} ${r.idx} ${r.type}`); continue; }
    if (mine.some((m) => m.x14)) { x14.push(`${r.sheet} ${r.idx}`); continue; } // openpyxl cannot see the linked x14 part
    rules++;
    const ours = ourValues(wb, mine), keys = new Set([...Object.keys(ours), ...Object.keys(r.cells!)]);
    const d: string[] = []; for (const k of keys) { cells++; if (!same(ours[k], r.cells![k])) d.push(`${k}: ours ${JSON.stringify(ours[k])} oracle ${JSON.stringify(r.cells![k])}`); }
    if (d.length) bad.push(`${r.sheet} ${r.idx} ${r.type} (${d.length}): ${d.slice(0, 3).join(" | ")}`);
  }
  return { rules, cells, bad, missing, skipped, x14 };
}

await test("corpus differential: every conditional-format rule in 19 real workbooks evaluates cell-for-cell like the independent Python oracle (openpyxl + Translator + `formulas`, Excel-cached values)", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  let R = 0, C = 0; const bad: string[] = [], missing: string[] = [], skipped: string[] = [], x14: string[] = [], unreadable: string[] = [];
  for (const o of oracle(CF_FILES.filter((f) => existsSync(f)))) {
    const name = o.file.split("/").pop()!;
    if (o.error) { unreadable.push(`${name}: ${o.error}`); continue; }
    const res = compare(load(o.file), o.rules!);
    R += res.rules; C += res.cells; bad.push(...res.bad.map((x) => `${name} ${x}`)); missing.push(...res.missing.map((x) => `${name} ${x}`)); skipped.push(...res.skipped.map((x) => `${name} ${x}`)); x14.push(...res.x14.map((x) => `${name} ${x}`));
  }
  console.log(`    ${R} rules / ${C} cells compared; oracle-unsupported ${skipped.length} [${skipped.join("; ")}]; x14-linked ${x14.length} (known-answer test); oracle cannot open ${unreadable.length} [${unreadable.join("; ")}]`);
  ok(!bad.length, `mismatches:\n  ${bad.join("\n  ")}`);
  ok(!missing.length, `rules the oracle evaluates that we do not model:\n  ${missing.join("\n  ")}`);
  ok(R >= 120 && C >= 7000, `coverage too small: ${R} rules / ${C} cells`);
});

await test("Apache POI's asserted answers (TestConditionalFormattingEval): matching-rule counts and first-rule colours per cell, including after editing the rule inputs", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  /** POI semantics: matching rules in priority order, stopping after a matching stopIfTrue rule */
  const matching = (wb: Workbook, sheet: string, ref: string) => {
    const hit: CondRule[] = [];
    for (const r of wb.condFormats.filter((x) => x.sheet === sheet)) {
      const m = evalCondFormats(wb, sheet, [r]); const k = (() => { const mm = /^([A-Z]+)(\d+)$/.exec(ref)!; let c = 0; for (const ch of mm[1]) c = c * 26 + ch.charCodeAt(0) - 64; return `${c - 1},${Number(mm[2]) - 1}`; })();
      if (m.has(k)) { hit.push(r); if (r.stop) break; }
    }
    return hit;
  };
  const f = (n: string) => join(CORPUS, n);
  let wb = load(f("ConditionalFormattingSamples.xlsx")); let checks = 0;
  const expect = (sheet: string, ref: string, n: number, fill?: string, font?: string) => {
    const h = matching(wb, sheet, ref); checks++;
    ok(h.length === n, `${sheet}!${ref}: ${h.length} matching rules, POI asserts ${n} (${h.map((r) => r.kind + ":" + r.src).join(",")})`);
    if (fill) ok(h[0].fill?.toLowerCase() === fill, `${sheet}!${ref} fill ${h[0].fill} ≠ ${fill}`);
    if (font) ok(h[0].color?.toLowerCase() === font, `${sheet}!${ref} font ${h[0].color} ≠ ${font}`);
  };
  expect("Products1", "B13", 1, "#ffeb9c"); expect("Products1", "D17", 1); expect("Products1", "D13", 0);
  expect("Products2", "B16", 1, "#ffeb9c"); expect("Products2", "D21", 0);
  const p2 = wb.sheets.get("Products2")!; p2.setCell(6, 1, "Dairy"); p2.setCell(6, 4, "500"); wb.recalculate();
  expect("Products2", "B16", 0); expect("Products2", "D21", 1); expect("Products2", "B21", 1, "#ffeb9c");
  expect("Book tour", "C9", 1);
  expect("Compare to totals", "C4", 1, undefined, "#ff0000"); expect("Compare to totals", "D4", 0); expect("Compare to totals", "E16", 0); expect("Compare to totals", "B17", 1, undefined, "#ff0000");
  const now = new Date(); wb.sheets.get("Products3")!.setCell(0, 8, String(todaySerial() + (now.getHours() * 3600 + now.getMinutes() * 60) / 86400)); wb.recalculate();
  expect("Products3", "A9", 1); expect("Products3", "D9", 1);
  expect("Customers2", "A4", 0);
  wb = load(f("conditional_formatting_with_formula_on_second_sheet.xlsx"));
  { const h = matching(wb, "Sales Plan", "C10"); checks++; ok(h.length >= 1 && h[0].fill?.toLowerCase() === "#ffff00", `Sales Plan!C10 ${h.length} rules, fill ${h[0]?.fill}`); }
  wb = load(f("test_conditional_formatting.xlsx")); expect([...wb.sheets.keys()][0], "B3", 0);
  wb = load(f("conditional_formatting_cell_is.xlsx")); expect([...wb.sheets.keys()][1], "B4", 1);
  wb = load(f("conditional_formatting_multiple_ranges.xlsx")); const s0 = [...wb.sheets.keys()][0];
  for (const [ref, n] of [["A1", 0], ["A2", 0], ["A3", 0], ["A4", 1], ["B1", 0], ["B2", 0], ["B3", 1], ["B4", 1], ["D1", 1], ["D2", 0], ["D3", 1], ["G1", 0], ["G4", 0], ["G3", 0]] as const) expect(s0, ref, n);
  console.log(`    ${checks} POI-asserted cells agree`);
});

await test("documented answers: Microsoft's data-bar length (10–90 %), x14 automatic bounds (0–100 %), top/bottom N% rounding, blank-as-zero, gte=\"0\", sample σ", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); const S = sh.name;
  const put = (col: number, vals: (number | string | null)[]) => vals.forEach((v, i) => { if (v !== null) sh.setCell(col, i, String(v)); });
  put(0, [10, 15, 20]);                          // A1:A3
  put(1, [3, 4, 6, 8, 0, 10]);                    // B1:B6
  put(2, Array.from({ length: 30 }, (_, i) => i + 1)); // C1:C30
  put(3, [5, null, 30, 7]);                       // D1:D4 (D2 blank)
  put(4, [10, 20, 30, 40, 50]);                   // E1:E5
  put(5, [0, 5, 8]);                              // F1:F3 — mean 4.33; +1 sample σ = 8.37, +1 population σ = 7.63
  wb.recalculate();
  const bar = (r: Partial<CondRule>) => { const m = evalCondFormats(wb, S, [{ id: "b", sheet: S, kind: "bar", ...r } as CondRule]); return (ref: string) => { const s = [...m].find(([k]) => { const [c, rr] = k.split(",").map(Number); return a1(c, rr) === ref; })?.[1].bar; return s ? Math.round((s.to - s.from) * 1000) / 1000 : null; }; };
  // Microsoft: length = minLength + (v − min)/(max − min) · (maxLength − minLength), 10 % and 90 % by default
  let L = bar({ range: "A1:A3" }); ok(L("A1") === 0.1 && L("A2") === 0.5 && L("A3") === 0.9, `2007 bar ${L("A1")} ${L("A2")} ${L("A3")}`);
  // Excel 365 measured (gridcraft #1304): Automatic 0–100 over 10…20 → 0.5 / 0.75 / 1; Number 3–8 over 0…10 → 3:0, 4:0.2, 6:0.6, 8:1
  L = bar({ range: "A1:A3", cfvo: [{ t: "autoMin" }, { t: "autoMax" }], barMinLen: 0, barMaxLen: 100, barAxis: "auto" }); ok(L("A1") === 0.5 && L("A2") === 0.75 && L("A3") === 1, `auto bar ${L("A1")} ${L("A2")} ${L("A3")}`);
  L = bar({ range: "B1:B6", cfvo: [{ t: "num", v: "3" }, { t: "num", v: "8" }], barMinLen: 0, barMaxLen: 100 }); ok(L("B1") === 0 && L("B2") === 0.2 && L("B3") === 0.6 && L("B4") === 1, `num bar ${L("B1")} ${L("B2")} ${L("B3")} ${L("B4")}`);
  const hits = (r: Partial<CondRule>) => cellsOf(evalCondFormats(wb, S, [{ id: "t", sheet: S, fill: "#ff0000", ...r } as CondRule]));
  // W3Schools: 10 % of 30 cells = 3; 6 % → 1.8 → 1; 7 % → 2.1 → 2 (rounded down)
  ok(hits({ range: "C1:C30", kind: "top", a: "10", pct: true }).join() === "C28,C29,C30", "top 10% of 30");
  ok(hits({ range: "C1:C30", kind: "top", a: "6", pct: true, bottom: true }).join() === "C1", "bottom 6% of 30");
  ok(hits({ range: "C1:C30", kind: "top", a: "7", pct: true }).join() === "C29,C30", "top 7% of 30");
  // Ablebits: a blank cell counts as 0 for "less than 20" (and for "= 0"); text and numbers compare by type
  ok(hits({ range: "D1:D4", kind: "lt", a: "20" }).join() === "D1,D2,D4", `blank as zero ${hits({ range: "D1:D4", kind: "lt", a: "20" })}`);
  ok(hits({ range: "D1:D4", kind: "eq", a: "0" }).join() === "D2", "blank = 0");
  // MS-XLSX CT_Cfvo gte="0": a value exactly on the threshold takes the LOWER icon
  const icon = (gt: boolean) => { const m = evalCondFormats(wb, S, [{ id: "i", sheet: S, range: "E1:E5", kind: "icons", iconSet: "3Arrows", cfvo: [{ t: "num", v: "0" }, { t: "num", v: "20", gt }, { t: "num", v: "40", gt }] }]); return [0, 1, 2, 3, 4].map((r) => ICON_SETS["3Arrows"].indexOf(m.get(`4,${r}`)!.icon!)).join(""); };
  ok(icon(false) === "01122", `≥ thresholds ${icon(false)}`); ok(icon(true) === "00112", `> thresholds ${icon(true)}`);
  // above average + 1 σ uses the SAMPLE standard deviation (POI's evaluator: STDEV): E mean 30, s = 15.81 → > 45.81 only 50
  ok(hits({ range: "E1:E5", kind: "aboveAvg", stdDev: 1 }).join() === "E5", "above avg + 1σ");
  ok(hits({ range: "E1:E5", kind: "aboveAvg", below: true, equal: true }).join() === "E1,E2,E3", "below or equal avg");
  ok(hits({ range: "F1:F3", kind: "aboveAvg", stdDev: 1 }).join() === "", `sample σ: 8 is NOT above mean + 1σ (population σ would highlight it) → ${hits({ range: "F1:F3", kind: "aboveAvg", stdDev: 1 })}`);
});

await test("priority order, format merging and stopIfTrue: the highest-priority rule wins each property, non-conflicting formats combine, stopIfTrue blocks icons and fills below it", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); const S = sh.name;
  [5, 50, "", 500].forEach((v, i) => sh.setCell(0, i, String(v))); wb.recalculate();
  const rules: CondRule[] = [
    { id: "r1", sheet: S, range: "A1:A4", kind: "blanks", stop: true },                      // the "ignore blanks" idiom
    { id: "r2", sheet: S, range: "A1:A4", kind: "gt", a: "10", fill: "#00ff00" },
    { id: "r3", sheet: S, range: "A1:A4", kind: "gt", a: "100", fill: "#ff0000", bold: true, stop: true },
    { id: "r4", sheet: S, range: "A1:A4", kind: "lt", a: "1000", color: "#0000ff", italic: true },
    { id: "r5", sheet: S, range: "A1:A4", kind: "icons", iconSet: "3Flags" },
  ];
  const m = evalCondFormats(wb, S, rules);
  const at = (r: number) => m.get(`0,${r}`) ?? {};
  ok(at(0).fill === undefined && at(0).color === "#0000ff" && at(0).italic && at(0).icon, `A1 ${JSON.stringify(at(0))}`);
  ok(at(1).fill === "#00ff00" && at(1).color === "#0000ff" && !at(1).bold && at(1).icon, `A2 ${JSON.stringify(at(1))}`);
  ok(!at(2).fill && !at(2).color && !at(2).icon, `A3 (blank, stopped) ${JSON.stringify(at(2))}`);
  ok(at(3).fill === "#00ff00" && at(3).bold && !at(3).color && !at(3).icon, `A4 (higher-priority green fill kept, r3 bold added, r3 stops r4/r5) ${JSON.stringify(at(3))}`);
});

await test("new-file writer: all 25 rule kinds survive our writer → (our reader: identical rules) and (openpyxl + the Python oracle: same cells as our evaluator)", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); const S = sh.name;
  for (let r = 0; r < 12; r++) { sh.setCell(0, r, String((r * 7) % 13)); sh.setCell(1, r, ["apple", "Banana", "cherry", "", " ", "apple pie", "grape", "kiwi", "Apple", "date", "fig", "banana"][r]); sh.setCell(2, r, String(todaySerial() + r - 6)); sh.setCell(3, r, String(r - 5)); }
  sh.setCell(4, 0, "=1/0"); sh.setCell(4, 1, "3"); sh.setCell(5, 0, "6");
  const base = { sheet: S, fill: "#ffc7ce", color: "#9c0006" };
  const rules: CondRule[] = [
    { id: "k1", ...base, range: "A1:A12", kind: "gt", a: "6" }, { id: "k2", ...base, range: "A1:A12", kind: "lt", a: "3" }, { id: "k3", ...base, range: "A1:A12", kind: "ge", af: "$F$1" },
    { id: "k4", ...base, range: "A1:A12", kind: "le", a: "2" }, { id: "k5", ...base, range: "B1:B12", kind: "eq", a: "apple" }, { id: "k6", ...base, range: "A1:A12", kind: "ne", a: "0" },
    { id: "k7", ...base, range: "A1:A12", kind: "between", a: "8", b: "4" }, { id: "k8", ...base, range: "A1:A12", kind: "notBetween", a: "2", bf: "$F$1" },
    { id: "k9", ...base, range: "B1:B12", kind: "contains", a: "an" }, { id: "k10", ...base, range: "B1:B12", kind: "notContains", a: "a" }, { id: "k11", ...base, range: "B1:B12", kind: "begins", a: "app" },
    { id: "k12", ...base, range: "B1:B12", kind: "ends", a: "e" }, { id: "k13", ...base, range: "B1:B12", kind: "blanks" }, { id: "k14", ...base, range: "B1:B12", kind: "noBlanks" },
    { id: "k15", ...base, range: "E1:E2", kind: "errors" }, { id: "k16", ...base, range: "E1:E2", kind: "noErrors" }, { id: "k17", ...base, range: "B1:B12", kind: "duplicate" }, { id: "k18", ...base, range: "B1:B12", kind: "unique" },
    { id: "k19", ...base, range: "A1:A12", kind: "top", a: "25", pct: true, bottom: true }, { id: "k20", ...base, range: "A1:A12", kind: "aboveAvg", below: true, equal: true, stdDev: 1 },
    { id: "k21", ...base, range: "C1:C12", kind: "period", period: "last7Days" }, { id: "k22", ...base, range: "A1:A12 D1:D12", kind: "expr", formula: "MOD(ROW(A1),3)=0", italic: true, strike: true, numFmt: "0.00", border: { bottom: { style: "thin", color: "#ff0000" } } },
    { id: "k23", sheet: S, range: "A1:A12", kind: "scale", scaleMin: "#f8696b", scaleMid: "#ffeb84", scaleMax: "#63be7b", scaleAt: "min|percentile:50|max" },
    { id: "k24", sheet: S, range: "D1:D12", kind: "bar", barColor: "#638ec6", cfvo: [{ t: "num", v: "-2" }, { t: "percentile", v: "90" }], barMinLen: 5, barMaxLen: 95, hideValue: true },
    { id: "k25", sheet: S, range: "A1:A12", kind: "icons", iconSet: "4Rating", cfvo: [{ t: "num", v: "0" }, { t: "num", v: "3", gt: true }, { t: "percent", v: "50" }, { t: "percentile", v: "80" }], reverse: true },
  ];
  wb.condFormats = rules; wb.recalculate();
  const bytes = writeXlsxWorkbook(wb); const f = join(tmp, "cf-all.xlsx"); writeFileSync(f, bytes);
  const back = readXlsxWorkbook(Buffer.from(bytes));
  // a time-period rule is stored with Excel's explicit formula (the reader keeps it, so a patch re-emits it verbatim)
  const key = ({ id: _i, src: _s, ...r }: CondRule) => { if (r.kind === "period") delete r.formula; return canon(r); };
  const A = rules.map(key), B = back.condFormats.map(key);
  ok(back.condFormats.find((r) => r.kind === "period")!.formula === "AND(TODAY()-FLOOR(C1,1)<=6,FLOOR(C1,1)<=TODAY())", "last7Days formula (ECMA-376 §18.3.1.10 / Excel's own text)");
  ok(JSON.stringify(A) === JSON.stringify(B), `reader round-trip (order = priority):\n  wrote ${A.filter((x, i) => x !== B[i]).join("\n  ")}\n  read  ${B.filter((x, i) => x !== A[i]).join("\n  ")}`);
  if (!haveCorpus) return;
  // the oracle needs cached values: let openpyxl see them — our writer stores formula results as <v>
  const [o] = oracle([f]); ok(!o.error, `oracle: ${o.error}`);
  back.recalculate(); const res = compare(back, o.rules!);
  ok(!res.bad.length && !res.missing.length, `differential on our own file:\n  ${[...res.bad, ...res.missing].join("\n  ")}`);
  ok(res.rules >= 24, `compared ${res.rules} rules; skipped ${res.skipped.join("; ")}`);
  console.log(`    ${res.rules} rules / ${res.cells} cells agree with the oracle on our written file; oracle-unsupported: ${res.skipped.join("; ") || "none"}`);
});

await test("new-file writer, Excel 2010 parts: x14 data bars (auto bounds, negative colour, middle axis, border, solid) and x14-only / custom icon sets round-trip and are well-formed for lxml and openpyxl", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); const S = sh.name;
  for (let r = 0; r < 10; r++) { sh.setCell(0, r, String(r * 4 - 15)); sh.setCell(1, r, String(r)); }
  const rules: CondRule[] = [
    { id: "x1", sheet: S, range: "A1:A10", kind: "bar", barColor: "#5b9bd5", cfvo: [{ t: "autoMin" }, { t: "autoMax" }], barMinLen: 0, barMaxLen: 100, barNeg: "#ff0000", barAxis: "middle", barAxisColor: "#000000", barBorder: "#2e75b6", barSolid: true },
    { id: "x2", sheet: S, range: "A1:A10", kind: "bar", barColor: "#63be7b", cfvo: [{ t: "num", v: "-5" }, { t: "formula", v: "MAX($A$1:$A$10)" }], barAxis: "auto" },
    { id: "x3", sheet: S, range: "B1:B10", kind: "icons", iconSet: "3Stars", cfvo: [{ t: "percent", v: "0" }, { t: "num", v: "3", gt: true }, { t: "percentile", v: "70" }] },
    { id: "x4", sheet: S, range: "B1:B10", kind: "icons", iconSet: "5Boxes", reverse: true, hideValue: true, cfvo: [0, 20, 40, 60, 80].map((v) => ({ t: "percent" as const, v: String(v) })) },
    { id: "x5", sheet: S, range: "B1:B10 A1:A3", kind: "icons", iconSet: "3TrafficLights1", icons: ["3Signs:0", "NoIcons:0", "3Symbols2:2"], cfvo: [{ t: "percent", v: "0" }, { t: "num", v: "0" }, { t: "num", v: "5" }] },
  ];
  wb.condFormats = rules; wb.recalculate();
  const bytes = writeXlsxWorkbook(wb); ok(Buffer.compare(Buffer.from(bytes), Buffer.from(writeXlsxWorkbook(wb))) === 0, "x14 output is deterministic");
  const back = readXlsxWorkbook(Buffer.from(bytes)); back.recalculate();
  const key = ({ id: _i, src: _s, x14: _x, ...r }: CondRule) => canon(r);
  ok(JSON.stringify(back.condFormats.map(key)) === JSON.stringify(rules.map(key)), `x14 round trip:\n  ${back.condFormats.map((r, i) => key(r) === key(rules[i]) ? "" : `read ${key(r)}\n  want ${key(rules[i])}`).filter(Boolean).join("\n  ")}`);
  ok(back.condFormats.filter((r) => r.kind === "bar").every((r) => r.x14 && /^\{[0-9A-F-]{36}\}$/.test(r.x14)), "bars carry their x14 link");
  // the read-back workbook draws exactly what the original draws
  ok(JSON.stringify([...evalCondFormats(back, S, back.condFormats)]) === JSON.stringify([...evalCondFormats(wb, S, rules)]), "evaluation differs after the round trip");
  if (!haveCorpus) return;
  const f = join(tmp, "x14.xlsx"); writeFileSync(f, bytes);
  const r = JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", `import zipfile,sys,json,openpyxl
from lxml import etree
x=zipfile.ZipFile(sys.argv[1]).read('xl/worksheets/sheet1.xml'); t=etree.fromstring(x)
ns={'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','x14':'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main','xm':'http://schemas.microsoft.com/office/excel/2006/main'}
assert t[-1].tag=='{%s}extLst'%ns['m'], 'extLst must be the last worksheet child'
ids=[e.text for e in t.iterfind('.//m:cfRule/m:extLst/m:ext/x14:id',ns)]
x14=[(e.get('type'),e.get('id'),[c.tag.split('}')[1] for c in e[0]]) for e in t.iterfind('.//x14:conditionalFormatting/x14:cfRule',ns)]
sq=[e.text for e in t.iterfind('.//x14:conditionalFormatting/xm:sqref',ns)]
wb=openpyxl.load_workbook(sys.argv[1]); ws=wb.worksheets[0]
print(json.dumps({'ids':ids,'x14':x14,'sqref':sq,'openpyxl':sorted(r.type for cf in ws.conditional_formatting for r in cf.rules)}))`, f], { encoding: "utf8" }));
  ok(r.ids.length === 2 && r.ids.every((id: string) => r.x14.some((x: [string, string]) => x[0] === "dataBar" && x[1] === id)), `every main data bar links an x14 part: ${JSON.stringify(r)}`);
  ok(JSON.stringify(r.x14[0][2]) === JSON.stringify(["cfvo", "cfvo", "borderColor", "negativeFillColor", "axisColor"]), `CT_DataBar (x14) child order: ${r.x14[0][2]}`);
  ok(r.x14.filter((x: [string]) => x[0] === "iconSet").length === 3 && JSON.stringify(r.sqref) === JSON.stringify(["A1:A10", "A1:A10", "B1:B10", "B1:B10", "B1:B10 A1:A3"]), `x14 icon parts / sqrefs: ${JSON.stringify(r)}`);
  ok(JSON.stringify(r.openpyxl) === JSON.stringify(["dataBar", "dataBar"]), `openpyxl sees the 2007 fallback bars only (x14 parts are an extension it skips): ${r.openpyxl}`);
});

await test("lossless save: unedited CF corpus files stay byte-identical; deleting a data bar also deletes its linked x14 rule; deleting an x14-only icon set removes it from the extLst; openpyxl reads every result", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  let identical = 0;
  for (const f of CF_FILES) {
    const bytes = new Uint8Array(readFileSync(f)); let base;
    try { base = loadedBaseline(bytes); } catch { continue; }
    const wb = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(readXlsxWorkbook(Buffer.from(bytes)))))); wb.recalculate();
    const out = (await patchXlsx(bytes, wb, {}, base)).bytes;
    ok(Buffer.compare(Buffer.from(out), Buffer.from(bytes)) === 0, `${f}: no-edit save is not byte-identical`); identical++;
  }
  ok(identical >= 18, `only ${identical} files checked`);
  const probe = (p: string) => JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", `import openpyxl,json,sys
wb=openpyxl.load_workbook(sys.argv[1]); out={}
for ws in wb.worksheets:
  out[ws.title]=sorted([r.type for cf in ws.conditional_formatting for r in cf.rules])
print(json.dumps(out))`, p], { encoding: "utf8" }));
  for (const [file, pick, what] of [["NewStyleConditionalFormattings.xlsx", (r: CondRule) => r.kind === "bar" && !!r.x14, "linked data bar"], ["simple-monthly-budget.xlsx", (r: CondRule) => r.kind === "bar" && !!r.x14, "linked data bar (defined-name max)"], ["NewStyleConditionalFormattings.xlsx", (r: CondRule) => r.kind === "icons" && r.iconSet === "3Stars", "x14-only 3Stars icon set"]] as const) {
    const src = join(CORPUS, file); const bytes = new Uint8Array(readFileSync(src)); const base = loadedBaseline(bytes);
    const wb = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(readXlsxWorkbook(Buffer.from(bytes)))))); wb.recalculate();
    const victim = wb.condFormats.find(pick); ok(victim, `${file}: no ${what}`);
    wb.condFormats = wb.condFormats.filter((r) => r !== victim);
    const out = (await patchXlsx(bytes, wb, {}, base)).bytes; const p = join(tmp, `del-${what.replace(/\W+/g, "-")}.xlsx`); writeFileSync(p, out);
    const z = openZip(out); const part = z.entries.find((e) => /worksheets\/sheet1\.xml$/.test(e.name))!.name; const xml = (await z.readText(part))!;
    if (victim.x14) ok(!xml.includes(victim.x14), `${what}: x14 rule ${victim.x14} still present`);
    if (victim.src?.startsWith("x")) ok(!/iconSet="3Stars"/.test(xml), `${what}: x14 3Stars rule still present`);
    const after = readXlsxWorkbook(Buffer.from(out)); const k = ({ id: _i, src: _s, ...r }: CondRule) => canon(r);
    ok(JSON.stringify(after.condFormats.map(k).sort()) === JSON.stringify(wb.condFormats.map(k).sort()), `${what}: re-read rule set differs`);
    const pr = probe(p); ok(Object.keys(pr).length > 0, `${what}: openpyxl failed`);
    if (/<extLst\b/.test(xml)) ok(/<\/extLst>/.test(xml) && !/<x14:conditionalFormattings>\s*<\/x14:conditionalFormattings>/.test(xml), `${what}: empty x14 container left behind`);
  }
  console.log(`    ${identical} CF workbooks byte-identical when unedited; 3 deletions verified (x14 link removed, openpyxl reads all)`);
});

await test("known answers for x14-only parts openpyxl cannot see: automatic-bound bars with border, defined-name bar maximum, 3Stars, custom icon mix", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  const vals = (f: string, sheet: string, rng: string) => JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", `import openpyxl,json,sys
wb=openpyxl.load_workbook(sys.argv[1],data_only=True); ws=wb[sys.argv[2]]
print(json.dumps({c.coordinate:c.value for row in ws[sys.argv[3]] for c in row}))`, f, sheet, rng], { encoding: "utf8" })) as Record<string, number | null>;
  const f = join(CORPUS, "NewStyleConditionalFormattings.xlsx"); const wb = load(f);
  const rule = (p: (r: CondRule) => boolean) => wb.condFormats.find(p)!;
  // E2:E17 — autoMin/autoMax, lengths 0–100, border, axis automatic
  const e = vals(f, "CF", "E2:E17"); const nums = Object.values(e).filter((v): v is number => typeof v === "number");
  const lo = Math.min(0, ...nums), hi = Math.max(0, ...nums);
  const bars = evalCondFormats(wb, "CF", [rule((r) => r.kind === "bar" && r.range === "E2:E17")]);
  for (const [ref, v] of Object.entries(e)) {
    if (typeof v !== "number") continue; const m = /^E(\d+)$/.exec(ref)!; const b = bars.get(`4,${Number(m[1]) - 1}`)!.bar!;
    const want = lo < 0 ? Math.abs(v) / (hi - lo) : (v - 0) / (hi - 0);
    ok(Math.abs((b.to - b.from) - want) < 1e-9 && b.border === "#63c384", `${ref}=${v}: bar ${b.from}-${b.to} want ${want}, border ${b.border}`);
  }
  // Q2:Q17 — x14-only 3Stars with percent 0/33/67
  const q = vals(f, "CF", "Q2:Q17"); const qn = Object.values(q).filter((v): v is number => typeof v === "number"); const qlo = Math.min(...qn), qhi = Math.max(...qn);
  const stars = evalCondFormats(wb, "CF", [rule((r) => r.iconSet === "3Stars")]);
  for (const [ref, v] of Object.entries(q)) { if (typeof v !== "number") continue; const want = v >= qlo + (qhi - qlo) * 0.67 ? 2 : v >= qlo + (qhi - qlo) * 0.33 ? 1 : 0;
    const g = stars.get(`16,${Number(ref.slice(1)) - 1}`)!.icon!; ok(g === ICON_SETS["3Stars"][want], `${ref}=${v}: ${g} want star index ${want}`); }
  // U2:U17 — custom: below 0 → 3Signs[0], 0..30 → 3Flags[1], ≥ 30 → 3Symbols2[2]
  const u = vals(f, "CF", "U2:U17"); const custom = evalCondFormats(wb, "CF", [rule((r) => !!r.icons)]);
  for (const [ref, v] of Object.entries(u)) { if (typeof v !== "number") continue; const want = v >= 30 ? ICON_SETS["3Symbols2"][2] : v >= 0 ? ICON_SETS["3Flags"][1] : ICON_SETS["3Signs"][0];
    ok(custom.get(`20,${Number(ref.slice(1)) - 1}`)!.icon === want, `${ref}=${v}: custom icon`); }
  // simple-monthly-budget E4 — num 0 … TotalMonthlyIncome (a defined name), solid, lengths 0–100
  const g = join(CORPUS, "simple-monthly-budget.xlsx"); const wb2 = load(g);
  const ws = wb2.condFormats.find((r) => r.kind === "bar")!; const sheet = ws.sheet;
  const ans = JSON.parse(execFileSync(PY, ["-W", "ignore", "-c", `import openpyxl,json,sys
wb=openpyxl.load_workbook(sys.argv[1],data_only=True); assert wb.defined_names['TotalMonthlyIncome'].attr_text == 'SUM(tblIncome[Amount])'
ws=wb[sys.argv[2]]; t=next(w.tables['tblIncome'] for w in wb.worksheets if 'tblIncome' in w.tables)
rows=list(ws[t.ref]); col=[c.value for c in rows[0]].index('Amount'); body=rows[1:len(rows)-(t.totalsRowCount or 0)]
print(json.dumps([ws['E4'].value, sum(r[col].value or 0 for r in body)]))`, g, sheet], { encoding: "utf8" })) as [number, number];
  const b = evalCondFormats(wb2, sheet, [ws]).get("4,3")!;
  const want = Math.max(0, Math.min(1, ans[0] / ans[1]));
  ok(Math.abs((b.bar!.to - b.bar!.from) - want) < 1e-9 && b.bar!.solid && b.hideValue, `E4 bar ${JSON.stringify(b)} want ${want} (E4=${ans[0]}, income=${ans[1]})`);
  console.log(`    E2:E17 ${nums.length} bars, Q 3Stars ${qn.length}, U custom ${Object.keys(u).length}, budget E4 ${want.toFixed(4)} — all agree`);
});

await test("JSON boundary: every corpus rule survives workbookToJson → workbookFromJson unchanged; 18 hostile shapes are rejected or neutralised", COV, async () => {
  if (haveCorpus) {
    let n = 0;
    for (const f of CF_FILES) { let wb; try { wb = readXlsxWorkbook(readFileSync(f)); } catch { continue; }
      const k = ({ id: _i, ...r }: CondRule) => canon(r);
      const again = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(wb))));
      ok(JSON.stringify(again.condFormats.map(k)) === JSON.stringify(wb.condFormats.map(k)), `${f}: JSON round trip changed rules`); n += wb.condFormats.length; }
    ok(n >= 130, `only ${n} rules`); console.log(`    ${n} corpus rules round-trip exactly`);
  }
  const S = "Sheet1"; const base = { id: "h", sheet: S, range: "A1:A3" };
  const shapes: [string, unknown, (r: CondRule[]) => boolean][] = [
    ["not an array", { kind: "gt" }, (r) => r.length === 0],
    ["unknown kind", [{ ...base, kind: "rainbow" }], (r) => r.length === 0],
    ["bad id", [{ ...base, id: "a b<script>", kind: "gt", a: "1" }], (r) => r.length === 0],
    ["bad range", [{ ...base, range: "A1:ZZZZ9", kind: "gt" }], (r) => r.length === 0],
    ["one bad range in a sqref", [{ ...base, range: "A1:A3 B1:B", kind: "gt" }], (r) => r.length === 0],
    ["4097 ranges", [{ ...base, range: Array.from({ length: 4097 }, (_, i) => `A${i + 1}`).join(" "), kind: "gt" }], (r) => r.length === 0],
    ["over-long formula is rejected, not truncated", [{ ...base, kind: "expr", formula: "1+".repeat(2001) + "1" }], (r) => r.length === 0],
    ["over-long cellIs operand formula", [{ ...base, kind: "gt", af: "A1+".repeat(700) + "1" }], (r) => r.length === 0],
    ["non-hex colours dropped", [{ ...base, kind: "gt", a: "1", fill: "red;background:url(x)", color: "#12345" }], (r) => r.length === 1 && !r[0].fill && !r[0].color],
    ["unknown cfvo type dropped", [{ ...base, kind: "bar", cfvo: [{ t: "evil" }, { t: "max" }] }], (r) => r[0].cfvo?.length === 1 && r[0].cfvo[0].t === "max"],
    ["cfvo list capped at 5", [{ ...base, kind: "icons", cfvo: Array.from({ length: 9 }, () => ({ t: "num", v: "1" })) }], (r) => r[0].cfvo?.length === 5],
    ["unknown icon set dropped", [{ ...base, kind: "icons", iconSet: "__proto__" }], (r) => r[0].iconSet === undefined],
    ["custom icon must be set:digit", [{ ...base, kind: "icons", icons: ["3Flags:1", "x:../../a", 7] }], (r) => JSON.stringify(r[0].icons) === '["3Flags:1"]'],
    ["bar lengths outside 0–100 dropped", [{ ...base, kind: "bar", barMinLen: -5, barMaxLen: 1e9 }], (r) => r[0].barMinLen === undefined && r[0].barMaxLen === undefined],
    ["stdDev outside 1–3 dropped", [{ ...base, kind: "aboveAvg", stdDev: 99 }], (r) => r[0].stdDev === undefined],
    ["unknown time period dropped", [{ ...base, kind: "period", period: "constructor" }], (r) => r[0].period === undefined],
    ["x14 id must be a GUID", [{ ...base, kind: "bar", x14: "{zz}" }], (r) => r[0].x14 === undefined],
    ["border side with unknown style dropped", [{ ...base, kind: "gt", a: "1", border: { top: { style: "url(x)" }, left: { style: "thin", color: "#00ff00" } } }], (r) => JSON.stringify(r[0].border) === '{"left":{"style":"thin","color":"#00ff00"}}'],
  ];
  for (const [name, raw, check] of shapes) { const r = sanitizeCondFormats(raw); ok(check(r), `${name}: ${JSON.stringify(r).slice(0, 200)}`); }
  console.log(`    ${shapes.length} hostile shapes handled`);
});

await test("adversarial evaluation: degenerate distributions, errors, #REF! after shifting, whole-column formulas, caps, no mutation, no recursion", COV, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); const S = sh.name;
  ["7", "7", "7", "=1/0", "text", "=NA()"].forEach((v, i) => sh.setCell(0, i, v)); sh.setCell(1, 0, "=SUM(A:A)"); wb.recalculate();
  const run = (r: Partial<CondRule>) => evalCondFormats(wb, S, [{ id: "z", sheet: S, range: "A1:A6", fill: "#ff0000", ...r } as CondRule]);
  // all-equal values: scale → min colour, bar → full, icons → top band (every value ≥ every threshold)
  ok([...run({ kind: "bar" }).values()].every((s) => Math.abs(s.bar!.to - 0.9) < 1e-12), "equal bars");
  ok([...run({ kind: "icons", iconSet: "3Arrows" }).values()].every((s) => s.icon === ICON_SETS["3Arrows"][2]), "equal icons");
  ok(run({ kind: "scale" }).size === 3, "scale only on the 3 numbers");
  // max threshold below min threshold: clamped, never NaN
  ok([...run({ kind: "bar", cfvo: [{ t: "num", v: "10" }, { t: "num", v: "1" }] }).values()].every((s) => Number.isFinite(s.bar!.to)), "inverted cfvo");
  // non-numeric / unresolvable cfvo formula → falls back to min/max, never throws
  ok(run({ kind: "bar", cfvo: [{ t: "formula", v: "NOSUCHNAME" }, { t: "num", v: "abc" }] }).size === 3, "bad cfvo formula");
  // errors: never 'contains', always 'not contains', not blank and not non-blank, and errors()
  ok(cellsOf(run({ kind: "notContains", a: "zzz" })).join() === "A1,A2,A3,A4,A5,A6" && cellsOf(run({ kind: "errors" })).join() === "A4,A6" && cellsOf(run({ kind: "noBlanks" })).join() === "A1,A2,A3,A5", "error cells");
  // formula shifted above row 1 → #REF! → false, no throw
  ok(run({ kind: "expr", formula: "A1048576>0", range: "A2:A6" }).size === 0, "#REF! after shift");
  ok(run({ kind: "expr", formula: "A0", range: "A1:A6" }).size === 0, "unparseable formula");
  // whole-column reference inside a CF formula is clamped to the used area (fast, correct)
  const t0 = Date.now(); ok(cellsOf(run({ kind: "expr", formula: "COUNTIF($A:$A,A1)>1" })).join() === "A1,A2,A3", "COUNTIF whole column"); ok(Date.now() - t0 < 2000, "whole column slow");
  // self-reference does not recurse: the rule reads the last computed value
  ok(cellsOf(run({ kind: "expr", formula: "A1=7" })).join() === "A1,A2,A3", "self reference");
  // caps: > 100,000 cells skipped; formula rules over > 20,000 cells skipped (bounded work)
  ok(evalCondFormats(wb, S, [{ id: "big", sheet: S, range: "A1:Z5000", kind: "gt", a: "0", fill: "#ff0000" }]).size === 0, "100k cap");
  const t1 = Date.now(); ok(evalCondFormats(wb, S, [{ id: "f", sheet: S, range: "C1:C20001", kind: "expr", formula: "TRUE", fill: "#ff0000" }]).size === 0 && Date.now() - t1 < 1000, "20k formula cap");
  const t2 = Date.now(); const m = evalCondFormats(wb, S, [{ id: "f2", sheet: S, range: "C1:C20000", kind: "expr", formula: "ROW()>19990", fill: "#ff0000" }]); const dt = Date.now() - t2;
  ok(m.size === 10, `20k formula cells → ${m.size} hits`); console.log(`    20,000 formula-rule cells evaluated in ${dt} ms`);
  // evaluation never writes cells
  const before = JSON.stringify(workbookToJson(wb)); run({ kind: "expr", formula: "SUM(A1:A3)+B1>0" }); run({ kind: "period", period: "today" }); ok(JSON.stringify(workbookToJson(wb)) === before, "evaluation mutated the workbook");
  // parseRanges: overlap counted once
  ok(cellsOf(evalCondFormats(wb, S, [{ id: "o", sheet: S, range: "A1:A3 A2:A4", kind: "duplicate", fill: "#ff0000" }])).join() === "A1,A2,A3", "overlapping sqref counted once");
  ok(parseRanges("A1:B2  C3") !== null && parseRanges("A1 junk") === null, "parseRanges");
  // every icon glyph renders to a well-formed standalone SVG
  for (const set of Object.values(ICON_SETS)) for (const gl of set) { const svg = iconSvg(gl); ok(/^<svg [^>]*viewBox="0 0 16 16">[\s\S]*<\/svg>$/.test(svg) && !/NaN|undefined/.test(svg), `glyph ${gl}`); }
});

await finish();
