/**
 * TT50 — Spreadsheet charts at Class A: Excel charts are READ from .xlsx (bar/column, line, area, pie, doughnut,
 * scatter; 3-D and radar/stock/bubble mapped with a note), DRAWN live from their cell references (stacked and 100 %
 * stacked, axis titles, legend, six trendline types with equation / R²), WRITTEN into new workbooks (chart + drawing
 * parts with caches) and PATCHED losslessly into the original package (targeted edits, add, delete, rename).
 *
 * External evidence:
 *   1. scripts/oracle/xlsx_charts.py — openpyxl's independent chart reader over every corpus workbook with charts AND
 *      over our own outputs (new-workbook writer + patch writer);
 *   2. scripts/oracle/trend_np.py — numpy polyfit / lstsq for all trendline models;
 *   3. documented Excel behaviour (MS Learn / ECMA-376): 100 % stacking, hbar category order, no trendlines on stacked
 *      charts, single-series automatic title.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt50-charts.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeHarness } from "./harness.mts";
import { readXlsxWorkbook, writeXlsxWorkbook, workbookToJson, workbookFromJson } from "../src/lib/formula/xlsx.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { chartDataFor, buildChartSvg, stackSeries, sanitizeCharts, renameChartRefs, trendLegend, type ChartSpec } from "../src/lib/formula/sheetmeta.ts";
import { fitTrend, trendLabel, type TrendSpec } from "../src/lib/formula/trend.ts";
import { parseChartXml, chartFrames, resolvePart } from "../src/lib/formula/chartxml.ts";
import { patchXlsx, loadedBaseline } from "../src/lib/formula/xlsx-patch.ts";
import { openZip, writeZip } from "../src/lib/office/zipkit.ts";

const { test: test0, finish } = makeHarness("tt50-charts");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const CORPUS = "/home/user/tools/corpus/xlsx";
const PY = "/home/user/tools/venv/bin/python";
const haveCorpus = existsSync(CORPUS) && existsSync(PY);
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const COV = { "FF-29": "full" } as const;
/** canonical JSON: keys sorted at every depth */
const canon = (v: unknown): string => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v);
const tmp = mkdtempSync(join(tmpdir(), "tt50-"));
const FILES = ["123233_charts", "45540_classic_Footer", "45540_classic_Header", "45544", "47813", "56557", "57362", "60255_extra_drawingparts", "60509", "64450", "DataTableCities",
  "LIBRE_OFFICE-128382-0", "SimpleScatterChart", "StructuredRefs-lots-with-lookups", "WithChart", "WithChartSheet", "WithThreeCharts", "WithTwoCharts", "chartTitle_noTitle", "chartTitle_withTitle",
  "chartTitle_withTitleFormula", "chart_sheet", "clone_sheet", "dataValidationTableRange", "simple-monthly-budget"].map((f) => join(CORPUS, f + ".xlsx"));
const AUTO = "\u0000auto";
/** openpyxl resolves relationship parts case-sensitively; OPC part names are case-insensitive (ECMA-376-2 §6.2.2.3) */
const ORACLE_BLIND: Record<string, string> = { "123233_charts.xlsx": "rels file sheet1.xml.rels for part Sheet1.xml — openpyxl finds no drawing" };
type OChart = { sheet: string; type: string; barDir: string | null; grouping: string | null; title: string | null; x_axis: string | null; y_axis: string | null; series: { tx: string | null; cat: string | null; val: string | null; trend: string | null; order: number | null; period: number | null }[]; anchor: [number, number] | null };
const oracle = (paths: string[]) => execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_charts.py", ...paths], { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n").map((l) => JSON.parse(l) as { file: string; error?: string; charts?: OChart[] });
const KIND_OF: Record<string, string> = { barChart: "bar", bar3DChart: "bar", lineChart: "line", line3DChart: "line", areaChart: "area", area3DChart: "area", pieChart: "pie", pie3DChart: "pie", ofPieChart: "pie", doughnutChart: "doughnut", scatterChart: "scatter", radarChart: "line", stockChart: "line", bubbleChart: "scatter" };
/** differences between our chart and openpyxl's view of the same chart */
function diff(c: ChartSpec, o: OChart): string[] {
  const d: string[] = [];
  const kind = KIND_OF[o.type] === "bar" && o.barDir === "bar" ? "hbar" : KIND_OF[o.type];
  if (c.kind !== kind) d.push(`kind ${c.kind}≠${kind}`);
  const g = o.grouping === "stacked" ? "stacked" : o.grouping === "percentStacked" ? "percent" : undefined;
  if ((c.grouping ?? undefined) !== g) d.push(`grouping ${c.grouping}≠${g}`);
  const combo = /combo/.test(c.note ?? "");
  if (!combo && (c.series?.length ?? 0) !== o.series.length) d.push(`series ${c.series?.length}≠${o.series.length}`);
  o.series.forEach((s, i) => {
    const m = c.series?.[i]; if (!m) { d.push(`series ${i} missing`); return; }
    if ((m.val || null) !== s.val) d.push(`val[${i}] ${m.val}≠${s.val}`);
    if ((m.cat ?? null) !== s.cat) d.push(`cat[${i}] ${m.cat}≠${s.cat}`);
    if (s.tx !== null && (m.nameRef ?? m.name ?? null) !== s.tx) d.push(`tx[${i}] ${m.nameRef ?? m.name}≠${s.tx}`);
    if ((m.trend?.type ?? null) !== s.trend) d.push(`trend[${i}] ${m.trend?.type}≠${s.trend}`);
    if (s.trend === "poly" && m.trend?.order !== s.order) d.push(`order[${i}]`);
    if (s.trend === "movingAvg" && m.trend?.period !== s.period) d.push(`period[${i}]`);
  });
  if (o.title && o.title !== AUTO) { if (c.title !== o.title) d.push(`title ${JSON.stringify(c.title)}≠${JSON.stringify(o.title)}`); }
  // an axis title element without text shows Excel's placeholder "Axis Title"
  const ax = (t: string | null) => (t === AUTO ? "Axis Title" : t || null);
  if ((c.catTitle ?? null) !== ax(o.x_axis)) d.push(`catTitle ${c.catTitle}≠${o.x_axis}`);
  if ((c.valTitle ?? null) !== ax(o.y_axis)) d.push(`valTitle ${c.valTitle}≠${o.y_axis}`);
  const an = c.anchor ? [c.anchor.c0, c.anchor.r0] : null;
  if (JSON.stringify(an) !== JSON.stringify(o.anchor)) d.push(`anchor ${an}≠${o.anchor}`);
  return d;
}
/** pair our charts with the oracle's per sheet in document order and diff them */
function compareFile(wb: Workbook, charts: OChart[]): { n: number; bad: string[] } {
  const bad: string[] = []; let n = 0;
  const bySheet = (name: string) => wb.charts.filter((c) => c.sheet === name);
  const sheets = [...new Set(charts.map((c) => c.sheet))];
  for (const s of sheets) {
    const os = charts.filter((c) => c.sheet === s && c.series.length), ms = bySheet(s);
    if (os.length !== ms.length) { bad.push(`${s}: ${ms.length} charts ≠ oracle ${os.length}`); continue; }
    // openpyxl lists a sheet's charts in drawing order too; pair by first series value reference, then order
    const used = new Set<number>();
    for (const o of os) {
      let j = ms.findIndex((m, k) => !used.has(k) && (m.series?.[0]?.val || null) === o.series[0]?.val && JSON.stringify(m.anchor ? [m.anchor.c0, m.anchor.r0] : null) === JSON.stringify(o.anchor));
      if (j < 0) j = ms.findIndex((_, k) => !used.has(k)); used.add(j); n++;
      const d = diff(ms[j], o); if (d.length) bad.push(`${s} #${j}: ${d.join("; ")}`);
    }
  }
  const extra = wb.charts.filter((c) => !sheets.includes(c.sheet)); if (extra.length) bad.push(`charts the oracle does not see: ${extra.map((c) => c.sheet).join(",")}`);
  return { n, bad };
}
const memo = new Map<string, Workbook>();
/** parsed corpus workbooks are cached (StructuredRefs-lots-with-lookups alone takes ~25 s to recalculate) — never mutate */
const load = (f: string) => { let w = memo.get(f); if (!w) { w = readXlsxWorkbook(readFileSync(f)); memo.set(f, w); } return w; };
const SLOW = new Set(["StructuredRefs-lots-with-lookups.xlsx"]);
const VOLATILE = new Set(["LIBRE_OFFICE-128382-0.xlsx"]);
const readable = () => FILES.filter((f) => existsSync(f));

// ------------------------------------------------------------------------------------------------ trendlines
await test("trendlines: all six Excel types fit like numpy (polyfit / lstsq) — 120 random datasets incl. fixed intercept and poly orders 2–6; R² on the fitted scale", COV, async () => {
  if (!existsSync(PY)) { console.log("    python missing — skipped"); return; }
  let seed = 50; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const cases: { type: TrendSpec["type"]; xs: number[]; ys: number[]; order?: number; period?: number; intercept?: number }[] = [];
  for (let i = 0; i < 20; i++) {
    const n = 6 + Math.floor(rnd() * 30); const xs = Array.from({ length: n }, (_, k) => k + 1 + rnd() * 0.5);
    const lin = xs.map((x) => 3 * x - 7 + (rnd() - 0.5) * 4), pos = xs.map((x) => 2 * Math.exp(0.11 * x) * (0.8 + rnd() * 0.4));
    cases.push({ type: "linear", xs, ys: lin }, { type: "linear", xs, ys: lin, intercept: -5 }, { type: "exp", xs, ys: pos }, { type: "log", xs, ys: lin }, { type: "power", xs, ys: pos });
    cases.push({ type: "poly", xs, ys: xs.map((x) => 0.3 * x ** 3 - 2 * x * x + x + (rnd() - 0.5) * 10), order: 2 + (i % 5) });
  }
  const np = JSON.parse(execFileSync(PY, ["scripts/oracle/trend_np.py"], { input: JSON.stringify(cases), encoding: "utf8" })) as { coef?: number[]; r2?: number; error?: string }[];
  const bad: string[] = [];
  cases.forEach((c, i) => {
    const f = fitTrend(c, c.xs, c.ys); const o = np[i]; ok(!o.error, `oracle error ${o.error}`);
    const scale = Math.max(1, ...o.coef!.map(Math.abs));
    o.coef!.forEach((v, j) => { if (Math.abs(f.coef[j] - v) > 1e-6 * scale) bad.push(`${i} ${c.type}${c.order ?? ""} coef${j} ${f.coef[j]} vs ${v}`); });
    if (Math.abs(f.r2 - o.r2!) > 1e-9) bad.push(`${i} ${c.type} r2 ${f.r2} vs ${o.r2}`);
  });
  ok(cases.length === 120 && !bad.length, bad.slice(0, 5).join(" | "));
  // moving average against numpy, with blanks skipped like Excel
  const ma = JSON.parse(execFileSync(PY, ["scripts/oracle/trend_np.py"], { input: JSON.stringify([{ type: "movingAvg", xs: [1, 2, 4, 5, 6], ys: [3, 5, 9, 1, 4], period: 3 }]), encoding: "utf8" }))[0].points;
  const mine = fitTrend({ type: "movingAvg", period: 3 }, [1, 2, 3, 4, 5, 6], [3, 5, null, 9, 1, 4]).points;
  ok(JSON.stringify(mine) === JSON.stringify(ma), `movingAvg ${JSON.stringify(mine)} vs ${JSON.stringify(ma)}`);
  // domain refusals match Excel (option greyed out) and labels read like Excel's
  for (const [spec, xs, ys] of [[{ type: "exp" }, [1, 2, 3], [1, -1, 2]], [{ type: "log" }, [0, 1, 2], [1, 2, 3]], [{ type: "power" }, [1, 2, 3], [0, 1, 2]], [{ type: "poly", order: 3 }, [1, 2, 3], [1, 4, 9]], [{ type: "movingAvg", period: 4 }, [1, 2, 3], [1, 2, 3]]] as [TrendSpec, number[], number[]][]) {
    let threw = false; try { fitTrend(spec, xs, ys); } catch { threw = true; } ok(threw, `${spec.type} should refuse ${ys}`);
  }
  const lab = trendLabel(fitTrend({ type: "linear" }, [1, 2, 3, 4], [3, 5, 7, 9]), true, true);
  ok(JSON.stringify(lab) === JSON.stringify(["y = 2x + 1", "R² = 1"]), `label ${lab}`);
  ok(trendLegend({ type: "movingAvg", period: 2 }, "Sales") === "2 per. Mov. Avg. (Sales)" && trendLegend({ type: "linear" }, "X") === "Linear (X)", "legend text");
});

// ------------------------------------------------------------------------------------------------ reader
await test("reader differential: every chart in 25 corpus workbooks (worksheets + chartsheets, one-cell/two-cell/absolute anchors) matches openpyxl — type, bar direction, grouping, series tx/cat/val refs, trendlines, titles, axis titles, anchor", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  let N = 0; const bad: string[] = [], unreadable: string[] = [];
  for (const o of oracle(readable())) {
    const name = o.file.split("/").pop()!;
    if (o.error) { unreadable.push(`${name}: ${o.error.slice(0, 60)}`); continue; }
    if (ORACLE_BLIND[name]) { const n = load(o.file).charts.length; ok(n === 4 && o.charts!.length === 0, `${name}: ours ${n}`); unreadable.push(`${name}: ${ORACLE_BLIND[name]} (ours: ${n} charts, checked in the semantics test)`); continue; }
    const r = compareFile(load(o.file), o.charts!); N += r.n; bad.push(...r.bad.map((b) => `${name} ${b}`));
  }
  console.log(`    ${N} charts compared field-by-field; oracle could not open: ${unreadable.join(" | ") || "none"}`);
  ok(N >= 30 && !bad.length, `${bad.length} mismatches: ${bad.slice(0, 6).join(" | ")}`);
});

await test("reader semantics: Excel automatic titles, multi-paragraph rich titles, formula titles, combo/3-D notes, cached values when a reference cannot be resolved (defined names), live values otherwise", COV, async () => {
  if (!haveCorpus) return;
  const t = (f: string) => load(join(CORPUS, f + ".xlsx")).charts.map((c) => c.title);
  ok(JSON.stringify(t("chartTitle_withTitleFormula")) === '["Formula Title from Excel 2016"]', "formula title from the strRef cache");
  ok(JSON.stringify(t("chartTitle_noTitle")) === '[""]', "autoTitleDeleted=1 → no title");
  ok(t("StructuredRefs-lots-with-lookups")[0] === "Category 1", "title element without text on a 1-series chart = series name");
  ok(t("57362")[0] === "Chart Title", "title element without text on a multi-series chart = 'Chart Title'");
  const ci = load(join(CORPUS, "123233_charts.xlsx")).charts;
  ok(ci.map((c) => c.kind).join() === "bar,pie,bar,line" && ci.every((c) => c.sheet === "Page1_1" && c.series![0].val.startsWith("data_Page1_1_")) && JSON.stringify(ci.map((c) => [c.anchor!.c0, c.anchor!.r0])) === "[[0,1],[8,1],[0,23],[8,23]]", `case-insensitive part names + oneCellAnchor: ${JSON.stringify(ci.map((c) => [c.kind, c.anchor]))}`);
  // OPC part names: absolute targets are package-rooted, relative ones resolve against the source part's folder
  ok(resolvePart("xl/drawings/drawing1.xml", "/xl/charts/chart1.xml") === "xl/charts/chart1.xml" && resolvePart("xl/drawings/drawing1.xml", "../charts/./chart1.xml") === "xl/charts/chart1.xml"
    && resolvePart("xl/worksheets/sheet1.xml", "../../../x.xml") === "x.xml", "relationship target resolution (absolute, relative, escaping)");
  const combo = load(join(CORPUS, "57362.xlsx")).charts[0]; ok(/combo/.test(combo.note ?? ""), "combo noted");
  const flat = load(join(CORPUS, "45544.xlsx")).charts[0]; ok(/3-D/.test(flat.note ?? "") && flat.kind === "pie", "3-D pie noted");
  const dv = load(join(CORPUS, "dataValidationTableRange.xlsx")); const c = dv.charts[0];
  const d = chartDataFor(dv, c); ok(c.kind === "hbar" && d.categories.length === 38 && d.series[0].values.filter((v) => v !== null).length > 30, `defined-name series fall back to caches (${d.categories.length})`);
  const wb = load(join(CORPUS, "WithChart.xlsx")); const ch = wb.charts[0];
  const before = chartDataFor(wb, ch).series[0].values[0];
  wb.sheets.get("Sheet1")!.setCell(0, 0, "4242"); wb.recalculate();
  ok(chartDataFor(wb, ch).series[0].values[0] === 4242 && before !== 4242, "chart follows a cell edit (live reference)");
});

// ------------------------------------------------------------------------------------------------ new-workbook writer
await test("new-workbook writer: every corpus chart written by writeXlsxWorkbook is read back identically by openpyxl AND by our reader (refs, caches, titles, axis titles, grouping, anchors)", COV, async () => {
  if (!haveCorpus) return;
  const outs: string[] = []; const models = new Map<string, Workbook>();
  for (const f of readable()) {
    let wb: Workbook; try { wb = load(f); } catch { continue; }
    if (!wb.charts.length) continue;
    const p = join(tmp, "w-" + f.split("/").pop()!); writeFileSync(p, writeXlsxWorkbook(wb)); outs.push(p); models.set(p, wb);
  }
  let N = 0; const bad: string[] = [];
  for (const o of oracle(outs)) {
    const wb = models.get(o.file)!; const name = o.file.split("/").pop()!;
    if (o.error) { bad.push(`${name}: oracle cannot open our file: ${o.error}`); continue; }
    // our writer flattens combos/3-D (noted) and gives chartsheet charts a default anchor
    const expect = wb.charts.filter((c) => !/combo/.test(c.note ?? "")).length;
    const back = readXlsxWorkbook(readFileSync(o.file));
    if (o.charts!.length !== wb.charts.length) bad.push(`${name}: wrote ${wb.charts.length}, oracle sees ${o.charts!.length}`);
    for (const [i, c] of wb.charts.entries()) {
      const b = back.charts[i]; if (!b) { bad.push(`${name} #${i} not read back`); continue; }
      N++;
      const kv = (x: ChartSpec) => JSON.stringify([x.kind, x.title, x.grouping ?? null, x.catTitle ?? null, x.valTitle ?? null, (x.series ?? []).map((s) => [s.val, s.cat ?? null, s.nameRef ?? null])]);
      if (kv(b) !== kv(c)) bad.push(`${name} #${i}: ${kv(c)} → ${kv(b)}`);
      const live = chartDataFor(wb, c).series.map((s) => s.values), cached = (b.series ?? []).map((s) => s.valCache);
      if (JSON.stringify(live) !== JSON.stringify(cached)) bad.push(`${name} #${i}: caches ≠ values`);
      const oc = o.charts![i]; const ex = { ...c, note: undefined, anchor: c.anchor ?? b.anchor };
      const d = diff(ex, oc).filter((x) => !x.startsWith("title")); if (d.length && !/combo/.test(c.note ?? "")) bad.push(`${name} #${i} oracle: ${d.join("; ")}`);
    }
    void expect;
  }
  console.log(`    ${outs.length} workbooks / ${N} charts re-read`);
  ok(N >= 30 && !bad.length, `${bad.length}: ${bad.slice(0, 5).join(" | ")}`);
});

const demo = () => {
  const wb = new Workbook(); const s = wb.sheets.get("Sheet1")!;
  [["Month", "North", "South", "West"], ["Jan", 10, 4, 7], ["Feb", 12, 6, 3], ["Mar", 9, 8, 5], ["Apr", 15, 3, 9], ["May", 18, 7, 11]].forEach((row, r) => row.forEach((v, c) => s.setCell(c, r, String(v))));
  wb.recalculate(); return wb;
};
await test("new charts made in Fusion export as real Excel charts: stacked / 100 % / hbar / doughnut / area / scatter, axis titles, poly + moving-average trendlines, legend — openpyxl reads every property back", COV, async () => {
  if (!existsSync(PY)) return;
  const wb = demo();
  const base = { sheet: "Sheet1", range: "A1:D6", headerRow: true };
  wb.charts = [
    { id: "a", ...base, kind: "bar", title: "Percent", grouping: "percent", catTitle: "Month", valTitle: "Share" },
    { id: "b", ...base, kind: "line", title: "Trend", trend: { type: "poly", order: 3, dispEq: true, dispRSqr: true } },
    { id: "c", ...base, kind: "hbar", title: "Stacked", grouping: "stacked" },
    { id: "d", sheet: "Sheet1", range: "A1:B6", headerRow: true, kind: "doughnut", title: "North" },
    { id: "e", ...base, kind: "area", title: "Area", grouping: "stacked", legend: false },
    { id: "f", sheet: "Sheet1", range: "B1:C6", headerRow: true, kind: "scatter", title: "XY", trend: { type: "movingAvg", period: 3 } },
  ];
  const p = join(tmp, "new.xlsx"); writeFileSync(p, writeXlsxWorkbook(wb));
  const [o] = oracle([p]); ok(!o.error, o.error!); const cs = o.charts!;
  ok(cs.length === 6, `count ${cs.length}`);
  ok(cs[0].type === "barChart" && cs[0].barDir === "col" && cs[0].grouping === "percentStacked" && cs[0].x_axis === "Month" && cs[0].y_axis === "Share" && cs[0].series.length === 3, `percent ${JSON.stringify(cs[0])}`);
  ok(cs[0].series[0].val === "Sheet1!$B$2:$B$6" && cs[0].series[0].cat === "Sheet1!$A$2:$A$6" && cs[0].series[0].tx === "Sheet1!$B$1", `refs ${JSON.stringify(cs[0].series[0])}`);
  ok(cs[1].series.every((s) => s.trend === "poly" && s.order === 3), "poly trend on each line series");
  ok(cs[2].barDir === "bar" && cs[2].grouping === "stacked", "hbar stacked");
  ok(cs[3].type === "doughnutChart" && cs[4].type === "areaChart" && cs[4].grouping === "stacked", "doughnut + stacked area");
  ok(cs[5].type === "scatterChart" && cs[5].series[0].trend === "movingAvg" && cs[5].series[0].period === 3 && cs[5].series[0].cat === "Sheet1!$B$2:$B$6", `scatter ${JSON.stringify(cs[5].series[0])}`);
  ok(JSON.stringify(cs[0].anchor) === "[5,0]", `default anchor two columns right of the data ${cs[0].anchor}`);
  // our own reader: the same model comes back (types, grouping, trend, titles) with Excel-style explicit series
  const back = readXlsxWorkbook(readFileSync(p));
  ok(back.charts.map((c) => `${c.kind}/${c.grouping ?? "-"}/${c.title}`).join(",") === "bar/percent/Percent,line/-/Trend,hbar/stacked/Stacked,doughnut/-/North,area/stacked/Area,scatter/-/XY", back.charts.map((c) => `${c.kind}/${c.grouping ?? "-"}/${c.title}`).join(","));
  ok(back.charts[1].series!.every((s) => s.trend?.type === "poly" && s.trend.order === 3 && s.trend.dispEq && s.trend.dispRSqr), "trend flags round-trip");
  ok(back.charts[4].legend === false && back.charts[0].legend === true, "legend flag");
  // the rendering of the re-read chart equals the rendering of the original (same data, same options)
  for (const [i, c] of wb.charts.entries()) {
    const b = back.charts[i];
    const s1 = buildChartSvg(c.kind, c.title, chartDataFor(wb, c), 520, 300, c), s2 = buildChartSvg(b.kind, b.title, chartDataFor(back, b), 520, 300, b);
    ok(s1 === s2, `render differs after round trip: ${c.id}`);
  }
});

// ------------------------------------------------------------------------------------------------ renderer
await test("renderer: Excel stacking semantics (negatives below zero, 100 % by Σ|v|, blanks), hbar first category at the bottom, trendline + equation + R² only on clustered charts, axis titles and doughnut hole drawn", COV, async () => {
  const S = (vals: (number | null)[][]) => vals.map((v, i) => ({ name: `s${i}`, values: v }));
  const st = stackSeries(S([[3, -2, null], [4, -1, 5]]), "stacked", false);
  ok(JSON.stringify(st) === JSON.stringify([[[0, 3], [0, -2], null], [[3, 7], [-2, -3], [0, 5]]]), `stacked ${JSON.stringify(st)}`);
  const pc = stackSeries(S([[1, 0], [3, 0]]), "percent", false);
  ok(JSON.stringify(pc) === JSON.stringify([[[0, 25], [0, 0]], [[25, 100], [0, 0]]]), `percent ${JSON.stringify(pc)}`);
  ok(JSON.stringify(stackSeries(S([[null], [2]]), "stacked", true)[0]) === "[[0,0]]", "blanks as zero");
  const mixed = stackSeries(S([[3], [-1]]), "percent", false); // Excel: 100 % of Σ|v| (signed sum would give 150 / -50)
  ok(JSON.stringify(mixed) === JSON.stringify([[[0, 75]], [[0, -25]]]), `mixed-sign percent ${JSON.stringify(mixed)}`);
  const lin = { type: "linear" as const, dispEq: true, dispRSqr: true };
  const data = { categories: ["A", "B", "C", "D"], series: [{ name: "Sales", values: [2, 4, 6, 8], trend: lin }, { name: "Cost", values: [1, 2, 2, 3], trend: lin }] };
  const stk = buildChartSvg("bar", "t", data, 520, 300, { grouping: "stacked" });
  ok((stk.match(/data-stack=/g) ?? []).length === 8 && !/data-trend=/.test(stk), "stacked: 8 stacked rects, no trendline (Excel disallows)");
  const cl = buildChartSvg("line", "t", data, 520, 300, { catTitle: "Quarter", valTitle: "USD" });
  ok((cl.match(/data-trend="linear"/g) ?? []).length === 2 && /y = 2x \+ 0/.test(cl) === false && /y = 2x/.test(cl) && /R² = 1/.test(cl), "trend lines + labels");
  ok(/data-axis-title="cat">Quarter</.test(cl) && /data-axis-title="val">USD</.test(cl) && /Linear \(Sales\)/.test(cl), "axis titles + trend legend");
  const hb = buildChartSvg("hbar", "t", { categories: ["first", "second"], series: [{ name: "x", values: [1, 2] }] }, 520, 300, { valTitle: "Value" });
  const ys = [...hb.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="[\d.]+" fill/g)].map((m) => Number(m[1])).slice(1); // [0] = background
  ok(ys.length === 2 && ys[0] > ys[1], `hbar: first category drawn lowest (${ys})`);
  const ly = (t: string) => Number(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${t}</text>`).exec(hb)?.[1] ?? NaN);
  const mids = [...hb.matchAll(/<rect x="[\d.]+" y="([\d.]+)" width="[\d.]+" height="([\d.]+)" fill/g)].slice(1).map((m) => Number(m[1]) + Number(m[2]) / 2);
  ok(ly("first") > ly("second") && Math.abs(ly("first") - 3 - mids[0]) < 3 && Math.abs(ly("second") - 3 - mids[1]) < 3, `hbar: category labels sit beside their own bars (labels ${ly("first")}, ${ly("second")}; bar centres ${mids})`);
  ok(/data-axis-title="val">Value</.test(hb), "hbar value-axis title at the bottom");
  ok(/data-hole="1"/.test(buildChartSvg("doughnut", "d", data, 520, 300)), "doughnut hole");
});

// ------------------------------------------------------------------------------------------------ patch writer
const entries = async (b: Uint8Array) => { const z = openZip(b); const m = new Map<string, string>(); for (const e of z.entries) if (!e.name.endsWith("/")) m.set(e.name, Buffer.from((await z.read(e.name))!).toString("base64")); return m; };
await test("patch writer: unchanged → original bytes; title / axis-title / grouping / anchor edits touch ONLY that chart (and drawing) part; openpyxl sees the edit and every other chart unchanged", COV, async () => {
  if (!haveCorpus) return;
  const bad: string[] = []; const jobs: { name: string; p: string; wb: Workbook; w2: Workbook; target: number; out: Uint8Array }[] = [];
  for (const f of readable()) {
    const name = f.split("/").pop()!; if (SLOW.has(name)) continue; // covered by the reader/writer tests; ~25 s per parse
    const bytes = new Uint8Array(readFileSync(f)); let wb: Workbook; try { wb = loadedBaseline(bytes); } catch { continue; }
    const target = wb.charts.findIndex((c) => c.series?.length); if (target < 0) continue;
    const same = await patchXlsx(bytes, wb, {}, loadedBaseline(bytes)); if (same.bytes !== bytes) bad.push(`${name}: unchanged save not identical`);
    const w2 = loadedBaseline(bytes); const c = w2.charts[target];
    const axes = c.kind !== "pie" && c.kind !== "doughnut";
    c.title = "TT50 edited ✓ & <ok>"; if (axes) c.valTitle = "Value axis"; if (c.kind === "bar" || c.kind === "line") c.grouping = c.grouping ? undefined : "stacked";
    if (c.anchor) c.anchor = { c0: c.anchor.c0 + 1, r0: c.anchor.r0 + 2, c1: c.anchor.c1 + 1, r1: c.anchor.r1 + 2 };
    const { bytes: out, report } = await patchXlsx(bytes, w2, {}, wb);
    if (report.charts?.regenerated.length) bad.push(`${name}: regenerated instead of targeted edit`);
    const a = await entries(bytes), b = await entries(out);
    const changed = [...b.keys()].filter((k) => a.get(k) !== b.get(k));
    // NOW()/TODAY() workbooks: any non-identical save refreshes cached cell values (pre-existing patch-writer rule)
    const extra = changed.filter((k) => k.toLowerCase() !== c.src!.toLowerCase() && !/drawings\/drawing\d+\.xml$/.test(k) && !(VOLATILE.has(name) && /^xl\/(workbook|worksheets\/sheet\d+)\.xml$/.test(k))); if (extra.length) bad.push(`${name}: also changed ${extra.join(",")}`);
    if (!changed.some((k) => k.toLowerCase() === c.src!.toLowerCase())) bad.push(`${name}: chart part not edited`);
    if ([...a.keys()].some((k) => !b.has(k))) bad.push(`${name}: parts lost`);
    const p = join(tmp, "p-" + name); writeFileSync(p, out); jobs.push({ name, p, wb, w2, target, out });
  }
  const verdicts = new Map(oracle(jobs.map((j) => j.p)).map((o) => [o.file, o]));
  for (const { name, p, wb, w2, target, out } of jobs) {
    const back = readXlsxWorkbook(Buffer.from(out)); const c = w2.charts[target], cb = back.charts[target];
    if (cb.title !== c.title || cb.valTitle !== c.valTitle || (cb.grouping ?? undefined) !== (c.grouping ?? undefined)) bad.push(`${name}: edit not read back ${JSON.stringify([cb.title, cb.valTitle, cb.grouping])}`);
    if (c.anchor && JSON.stringify(cb.anchor) !== JSON.stringify(c.anchor)) bad.push(`${name}: anchor ${JSON.stringify(cb.anchor)}`);
    for (const [i, x] of back.charts.entries()) if (i !== target && canon({ ...x, id: 0 }) !== canon({ ...wb.charts[i], id: 0 })) bad.push(`${name}: chart ${i} changed`);
    const o = verdicts.get(p)!;
    if (o.error) { if (name !== "LIBRE_OFFICE-128382-0.xlsx") bad.push(`${name}: oracle cannot open patched file: ${o.error}`); continue; }
    if (ORACLE_BLIND[name]) continue;
    const r = compareFile(back, o.charts!); if (r.bad.length) bad.push(`${name}: ${r.bad.slice(0, 2).join(" | ")}`);
  }
  console.log(`    ${jobs.length} workbooks patched (oracle-checked: ${jobs.filter((j) => !ORACLE_BLIND[j.name]).length - 1})`);
  ok(jobs.length >= 20 && !bad.length, `${bad.length}: ${bad.slice(0, 5).join(" | ")}`);
});

await test("patch writer: delete a chart (frame + rel + part + Override go, siblings stay), add a chart to a sheet WITH and WITHOUT a drawing, add a trendline, change the type (regenerated, reported), rename a referenced sheet (refs follow)", COV, async () => {
  if (!haveCorpus) return;
  const bad: string[] = [];
  // delete one of three charts
  { const f = join(CORPUS, "WithThreeCharts.xlsx"); const bytes = new Uint8Array(readFileSync(f)); const wb = loadedBaseline(bytes); const gone = wb.charts[1];
    wb.charts = wb.charts.filter((c) => c !== gone); const { bytes: out } = await patchXlsx(bytes, wb); const p = join(tmp, "del.xlsx"); writeFileSync(p, out);
    const [o] = oracle([p]); const z = openZip(out);
    if (o.error || o.charts!.length !== 2) bad.push(`delete: oracle ${o.error ?? o.charts!.length}`);
    if (z.has(gone.src!)) bad.push("delete: chart part kept");
    const ct = (await z.readText("[Content_Types].xml"))!; if (ct.includes(gone.src!)) bad.push("delete: Override kept");
    const back = readXlsxWorkbook(Buffer.from(out)); if (back.charts.map((c) => c.title).join("|") !== wb.charts.map((c) => c.title).join("|")) bad.push("delete: siblings changed"); }
  // clear a title: Excel would otherwise draw its automatic title, so autoTitleDeleted must flip to 1
  { const f = join(CORPUS, "WithThreeCharts.xlsx"); const bytes = new Uint8Array(readFileSync(f)); const wb = loadedBaseline(bytes);
    const i = wb.charts.findIndex((c) => c.title === "Pie Chart Title Thingy"); wb.charts[i].title = "";
    const { bytes: out } = await patchXlsx(bytes, wb); const xml = (await openZip(out).readText(wb.charts[i].src!))!;
    if (!/<c:autoTitleDeleted val="1"\/>/.test(xml) || /<c:title>/.test(xml)) bad.push("clear title: autoTitleDeleted not set / title kept");
    const back = readXlsxWorkbook(Buffer.from(out)); if (back.charts[i].title !== "") bad.push(`clear title: re-read as ${JSON.stringify(back.charts[i].title)}`); }
  // add a chart to a sheet that already has a drawing, and to one that has none
  { const f = join(CORPUS, "WithTwoCharts.xlsx"); const bytes = new Uint8Array(readFileSync(f)); const wb = loadedBaseline(bytes);
    const sheets = [...wb.sheets.keys()]; const bare = sheets.find((s) => !wb.charts.some((c) => c.sheet === s))!;
    wb.charts.push({ id: "n1", sheet: "Sheet2", range: "A1:B6", headerRow: false, kind: "bar", title: "Added on drawing" });
    wb.charts.push({ id: "n2", sheet: bare, range: "A1:B6", headerRow: false, kind: "pie", title: "Added fresh", anchor: { c0: 3, r0: 3, c1: 9, r1: 15 } });
    const { bytes: out } = await patchXlsx(bytes, wb); const p = join(tmp, "add.xlsx"); writeFileSync(p, out);
    const [o] = oracle([p]); if (o.error) bad.push(`add: ${o.error}`);
    else { const t = o.charts!.map((c) => `${c.sheet}:${c.title ?? ""}`); if (!t.includes("Sheet2:Added on drawing") || !t.includes(`${bare}:Added fresh`) || o.charts!.length !== 4) bad.push(`add: ${t}`);
      const fresh = o.charts!.find((c) => c.title === "Added fresh")!; if (JSON.stringify(fresh.anchor) !== "[3,3]") bad.push(`add anchor ${fresh.anchor}`); }
    const back = readXlsxWorkbook(Buffer.from(out)); if (back.charts.length !== 4) bad.push(`add: our reader sees ${back.charts.length}`); }
  // trendline on an imported clustered line chart; type change bar→line regenerates and is reported
  { const f = join(CORPUS, "clone_sheet.xlsx"); const bytes = new Uint8Array(readFileSync(f)); const wb = loadedBaseline(bytes);
    wb.charts[0].series![0].trend = { type: "poly", order: 4, dispEq: true }; wb.charts[1].kind = "bar";
    const { bytes: out, report } = await patchXlsx(bytes, wb); const p = join(tmp, "trend.xlsx"); writeFileSync(p, out);
    const [o] = oracle([p]); if (o.error) bad.push(`trend: ${o.error}`);
    else { if (o.charts![0].series[0].trend !== "poly" || o.charts![0].series[0].order !== 4) bad.push(`trend ${JSON.stringify(o.charts![0].series[0])}`); if (o.charts![1].type !== "barChart") bad.push("type change"); }
    if (report.charts?.regenerated.length !== 1) bad.push(`regenerated report ${JSON.stringify(report.charts)}`); }
  // rename the data sheet: chart references follow in the patched file
  { const f = join(CORPUS, "WithChart.xlsx"); const bytes = new Uint8Array(readFileSync(f)); const wb = loadedBaseline(bytes);
    const s = wb.sheets.get("Sheet1")!; wb.sheets.delete("Sheet1"); s.name = "Data 2026"; const m = new Map<string, typeof s>(); for (const [k, v] of [["Data 2026", s] as const, ...wb.sheets]) m.set(k, v); wb.sheets = m as typeof wb.sheets;
    wb.charts = wb.charts.map((c) => renameChartRefs(c, "Sheet1", "Data 2026"));
    const { bytes: out } = await patchXlsx(bytes, wb, { "Data 2026": "Sheet1" }); const p = join(tmp, "ren.xlsx"); writeFileSync(p, out);
    const [o] = oracle([p]); if (o.error) bad.push(`rename: ${o.error}`); else if (o.charts![0].series[0].val !== "'Data 2026'!$A$1:$A$6") bad.push(`rename ref ${o.charts![0].series[0].val}`);
    const back = readXlsxWorkbook(Buffer.from(out)); const d = chartDataFor(back, back.charts[0]); if (d.series[0].values.some((v) => v === null)) bad.push("rename: live refs broken"); }
  ok(!bad.length, bad.join(" | "));
});

// ------------------------------------------------------------------------------------------------ adversarial + persistence
await test("hostile packages: huge ptCount, 400 series, external / escaping relationship targets, malformed chart XML, chart-less drawings and 10 MB caches never crash the reader and stay bounded", COV, async () => {
  const head = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea>`;
  const ser = (i: number) => `<c:ser><c:idx val="${i}"/><c:val><c:numRef><c:f>Sheet1!$A$1:$A$3</c:f><c:numCache><c:ptCount val="999999999"/><c:pt idx="2"><c:v>5</c:v></c:pt><c:pt idx="99999999"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>`;
  const big = parseChartXml(`${head}<c:barChart>${Array.from({ length: 400 }, (_, i) => ser(i)).join("")}</c:barChart></c:plotArea></c:chart></c:chartSpace>`, { id: "x", sheet: "S", src: "x.xml" })!;
  ok(big.series!.length === 255 && big.series![0].valCache!.length === 20000 && big.series![0].valCache![2] === 5, `caps ${big.series!.length} ${big.series![0].valCache!.length}`);
  ok(parseChartXml(`${head}</c:plotArea></c:chart></c:chartSpace>`, { id: "x", sheet: "S", src: "x.xml" }) === null, "no chart type → null");
  let threw = false; try { parseChartXml("<c:chartSpace><c:chart>", { id: "x", sheet: "S", src: "x" }); } catch { threw = true; } ok(threw, "malformed XML throws (caller skips)");
  // a package whose drawing points outside / external and whose second chart is malformed still opens with the good chart
  const wb = demo(); wb.charts = [{ id: "a", sheet: "Sheet1", range: "A1:B6", headerRow: true, kind: "bar", title: "Good" }];
  const z = openZip(writeXlsxWorkbook(wb)); const files: { name: string; data: Uint8Array | string }[] = [];
  for (const e of z.entries) files.push({ name: e.name, data: (await z.read(e.name))! });
  const dr = files.find((f) => f.name === "xl/drawings/_rels/drawing1.xml.rels")!;
  dr.data = Buffer.from(dr.data as Uint8Array).toString().replace("</Relationships>", `<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../../../../etc/passwd"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="https://evil.example/c.xml" TargetMode="External"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/bad.xml"/></Relationships>`);
  const d = files.find((f) => f.name === "xl/drawings/drawing1.xml")!; const anchor = /<xdr:twoCellAnchor[\s\S]*<\/xdr:twoCellAnchor>/.exec(Buffer.from(d.data as Uint8Array).toString())![0];
  d.data = Buffer.from(d.data as Uint8Array).toString().replace("</xdr:wsDr>", ["rId8", "rId9", "rId10"].map((r) => anchor.replace(/r:id="rId\d+"/, `r:id="${r}"`)).join("") + "</xdr:wsDr>");
  files.push({ name: "xl/charts/bad.xml", data: "<c:chartSpace><unclosed>" });
  const back = readXlsxWorkbook(Buffer.from(await writeZip(files)));
  ok(back.charts.length === 1 && back.charts[0].title === "Good", `hostile drawing: ${back.charts.map((c) => c.title)}`);
  ok(chartFrames(`<xdr:wsDr xmlns:xdr="x"><xdr:twoCellAnchor><xdr:sp/></xdr:twoCellAnchor></xdr:wsDr>`).length === 0, "shape-only drawing has no chart frames");
  const t0 = performance.now(); const pts = Array.from({ length: 20000 }, (_, i) => `<c:pt idx="${i}"><c:v>${i}.5</c:v></c:pt>`).join("");
  const huge = parseChartXml(`${head}<c:lineChart>${`<c:ser><c:idx val="0"/><c:val><c:numRef><c:f>S!A1</c:f><c:numCache><c:ptCount val="20000"/>${pts}</c:numCache></c:numRef></c:val></c:ser>`.repeat(20)}</c:lineChart></c:plotArea></c:chart></c:chartSpace>`, { id: "x", sheet: "S", src: "x.xml" })!;
  const ms = performance.now() - t0; ok(huge.series!.length === 20 && ms < 4000, `400k cached points parsed in ${ms.toFixed(0)} ms`);
});

await test("persistence: charts with explicit series, trendlines, grouping, anchors survive Fusion workbook JSON; sanitizeCharts drops hostile fields (bad src paths, unknown kinds, oversize refs) and clamps trend order/period", COV, async () => {
  const wb = demo();
  wb.charts = [{ id: "k", sheet: "Sheet1", range: "Sheet1!$B$2:$B$6", headerRow: false, kind: "line", title: "T", grouping: "stacked", catTitle: "c", valTitle: "v", legend: true, blanks: "zero", anchor: { c0: 1, r0: 2, c1: 9, r1: 17 }, src: "xl/charts/chart1.xml", numFmt: "0.0",
    series: [{ name: "N", nameRef: "Sheet1!$B$1", cat: "Sheet1!$A$2:$A$6", val: "Sheet1!$B$2:$B$6", valCache: [1, null, 3], catCache: ["a", "b", "c"], color: "#ff0000", trend: { type: "poly", order: 5, dispEq: true } }] }];
  const back = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(wb))));
  ok(canon(back.charts) === canon(wb.charts), `json round trip ${JSON.stringify(back.charts)}`);
  const s = sanitizeCharts([{ id: "1", sheet: "S", range: "A1:B2", kind: "bar", title: "t", headerRow: true, src: "../../etc/passwd.xml", trend: { type: "poly", order: 99 } },
    { id: "2", sheet: "S", range: "A1:B2", kind: "radar", title: "t", headerRow: true }, { id: "3", sheet: "S", range: "A1:B2", kind: "line", title: "t", headerRow: true, series: [{ val: "x".repeat(5000) }], trend: { type: "movingAvg", period: 1 } }]);
  ok(s.length === 2 && s[0].src === undefined && s[0].trend?.order === 6, `sanitize ${JSON.stringify(s)}`);
  ok(!s[1].series?.length && s[1].trend?.period === 2, `sanitize series/period ${JSON.stringify(s[1])}`);
});

finish();
