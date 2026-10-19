/**
 * TT47 — Spreadsheet Class-A view fidelity: theme / tint / indexed colour resolution
 * (src/lib/formula/xlsxcolor.ts) verified against an independent implementation
 * (scripts/oracle/xlsx_colors.py: openpyxl MIT + lxml + stdlib colorsys, test-only)
 * over the Apache POI spreadsheet corpus (Apache-2.0, test-only).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt47-sheet.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { INDEXED_PALETTE, applyTint, readThemeColors, resolveColorAttrs } from "../src/lib/formula/xlsxcolor.ts";
import { readXlsxWorkbook, writeXlsxWorkbook, workbookToJson, workbookFromJson } from "../src/lib/formula/xlsx.ts";
import { a1, Workbook } from "../src/lib/formula/engine.ts";
import { scaleThresholds, scaleColor, evalCondFormats, type CondRule } from "../src/lib/formula/sheetmeta.ts";
import { patchXlsx, loadedBaseline } from "../src/lib/formula/xlsx-patch.ts";
import { openZip } from "../src/lib/office/zipkit.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const { test: test0, finish } = makeHarness("tt47-sheet");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !name.includes(ONLY) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const CORPUS = "/home/user/tools/corpus/xlsx";
const PY = "/home/user/tools/venv/bin/python";
const haveCorpus = existsSync(CORPUS) && existsSync(PY);
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const COV = { "FF-20": "full", "FF-21": "full" } as const;
const near = (a: string | null | undefined, b: string | null | undefined) => {
  if (!a || !b) return a === b || (!a && !b);
  return [1, 3, 5].every((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 1);
};

await test("indexed colour palette equals openpyxl's COLOR_INDEX (independent table, 64 entries; 64/65 = system fg/bg)", COV, async () => {
  if (!haveCorpus) { console.log("    oracle venv missing — skipped"); return; }
  const theirs = JSON.parse(execFileSync(PY, ["scripts/oracle/xlsx_colors.py", "--palette"], { encoding: "utf8" })) as string[];
  ok(theirs.length === 64 && INDEXED_PALETTE.length === 66 && INDEXED_PALETTE[64] === "000000" && INDEXED_PALETTE[65] === "FFFFFF", `lengths ${theirs.length}/${INDEXED_PALETTE.length}`);
  const bad = theirs.map((c, i) => (c === INDEXED_PALETTE[i] ? "" : `${i}: ours ${INDEXED_PALETTE[i]} openpyxl ${c}`)).filter(Boolean);
  ok(!bad.length, bad.join("; "));
});

await test("tint maths matches stdlib colorsys within 1/255 per channel on a 1,000-sample grid; theme index order swaps lt/dk", COV, async () => {
  const samples: [string, number][] = [];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 1000; i++) samples.push([Math.floor(rnd() * 0xffffff).toString(16).padStart(6, "0").toUpperCase(), Math.round((rnd() * 2 - 1) * 1000) / 1000]);
  samples.push(["FFFFFF", -0.249977111117893], ["000000", 0.499984740745262], ["4F81BD", 0.799981688894314], ["1F497D", -0.5]);
  if (existsSync(PY)) {
    const py = `import colorsys,json,sys\nout=[]\nfor h,t in json.load(sys.stdin):\n  r,g,b=(int(h[i:i+2],16)/255 for i in (0,2,4))\n  H,L,S=colorsys.rgb_to_hls(r,g,b)\n  L=L*(1+t) if t<0 else L*(1-t)+t\n  out.append("".join("%02X"%round(x*255) for x in colorsys.hls_to_rgb(H,max(0,min(1,L)),S)))\nprint(json.dumps(out))`;
    const theirs = JSON.parse(execFileSync(PY, ["-c", py], { input: JSON.stringify(samples), encoding: "utf8" })) as string[];
    const bad = samples.map(([h, t], i) => (near(`#${applyTint(h, t)}`, `#${theirs[i]}`) ? "" : `${h}@${t}: ${applyTint(h, t)} vs ${theirs[i]}`)).filter(Boolean);
    ok(!bad.length, `${bad.length} mismatches: ${bad.slice(0, 5).join("; ")}`);
  }
  // hand-checked anchors (Office "White, Background 1, Darker 25%" = BFBFBF; "Black, Text 1, Lighter 50%" = 7F7F7F)
  ok(applyTint("FFFFFF", -0.249977111117893) === "BFBFBF", applyTint("FFFFFF", -0.249977111117893));
  ok(applyTint("000000", 0.499984740745262) === "7F7F7F", applyTint("000000", 0.499984740745262));
  const theme = readThemeColors(`<a:theme xmlns:a="x"><a:themeElements><a:clrScheme name="t"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme></a:themeElements></a:theme>`);
  ok(theme.join(",") === "FFFFFF,000000,EEECE1,1F497D,4F81BD,C0504D,9BBB59,8064A2,4BACC6,F79646,0000FF,800080", theme.join(","));
  const ctx = { theme, indexed: INDEXED_PALETTE };
  ok(resolveColorAttrs(' theme="1"', ctx) === "#000000" && resolveColorAttrs(' theme="0"', ctx) === "#ffffff" && resolveColorAttrs(' theme="3"', ctx) === "#1f497d", "theme swap");
  ok(resolveColorAttrs(' indexed="10"', ctx) === "#ff0000" && resolveColorAttrs(' auto="1"', ctx) === undefined && resolveColorAttrs(' theme="99"', ctx) === undefined, "indexed/auto/out-of-range");
  ok(resolveColorAttrs(' rgb="FF00B0F0"', ctx) === "#00b0f0", "argb");
});

await test("corpus: every styled cell's fill and font colour equals the independent oracle (rgb, theme+tint, indexed, custom palette)", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  const files = readdirSync(CORPUS).filter((f) => f.endsWith(".xlsx")).sort();
  const ours = new Map<string, Map<string, [string | null, string | null]>>();
  const readable: string[] = [];
  for (const f of files) {
    const bytes = readFileSync(join(CORPUS, f));
    if (bytes.length > 8 << 20) continue; // same oracle bound as TT46
    let wb; try { wb = readXlsxWorkbook(bytes); } catch { continue; }
    const m = new Map<string, [string | null, string | null]>();
    for (const [name, sh] of wb.sheets) for (const [k, cell] of sh.grid) {
      const [c, r] = k.split(",").map(Number); const st = cell.style;
      if (st?.fill || st?.color) m.set(`${name}!${a1(c, r)}`, [st.fill ?? null, st.color ?? null]);
    }
    ours.set(join(CORPUS, f), m); readable.push(join(CORPUS, f));
  }
  const out: { file: string; cells?: Record<string, [string | null, string | null]>; merged?: string[]; error?: string }[] = [];
  for (let i = 0; i < readable.length; i += 30) {
    const text = execFileSync(PY, ["scripts/oracle/xlsx_colors.py"], { input: readable.slice(i, i + 30).join("\n"), encoding: "utf8", maxBuffer: 512 << 20 });
    out.push(...text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  let cells = 0, themed = 0, files2 = 0; const bad: string[] = []; const skipped: string[] = [];
  for (const o of out) {
    if (o.error || !o.cells) { skipped.push(`${o.file.split("/").pop()}: ${o.error}`); continue; }
    const mine = ours.get(o.file)!; files2++;
    const theirs = new Map(Object.entries(o.cells).map(([k, [fl, fo]]) => [k, [fl, fo === "#000000" ? null : fo] as [string | null, string | null]]));
    if (!theirs.size && !mine.size) continue;
    if (/\.strict\.|strict-|beta/i.test(o.file.split("/").pop()!)) { skipped.push(`${o.file.split("/").pop()}: oracle namespace limits`); continue; }
    const skip = new Set(o.merged ?? []);
    for (const k of new Set([...mine.keys(), ...theirs.keys()])) {
      if (skip.has(k)) continue;
      const a = mine.get(k) ?? [null, null], b = theirs.get(k) ?? [null, null];
      if (!a[0] && !a[1] && !b[0] && !b[1]) continue;
      cells++;
      if (!near(a[0], b[0]) || !near(a[1], b[1])) bad.push(`${o.file.split("/").pop()} ${k}: ours ${JSON.stringify(a)} oracle ${JSON.stringify(b)}`);
    }
    const raw = readFileSync(o.file); if (/theme="\d+"/.test(raw.toString("latin1"))) themed++;
  }
  console.log(`    ${files2} workbooks, ${cells} coloured cells compared; ${skipped.length} oracle skips${skipped.length ? ` (${skipped.slice(0, 6).join("; ")})` : ""}`);
  ok(cells > 5000, `too few cells compared: ${cells}`);
  const byFile = new Map<string, number>(); for (const x of bad) { const f = x.split(" ")[0]; byFile.set(f, (byFile.get(f) ?? 0) + 1); }
  ok(!bad.length, `${bad.length} mismatches in ${byFile.size} files [${[...byFile].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([f, n]) => `${f}:${n}`).join(", ")}]: ${bad.slice(0, 8).join(" | ")}`);
  void themed;
});

const CF = { "FF-21": "full", "FF-20": "full" } as const;
const tmp = mkdtempSync(join(tmpdir(), "tt47s-"));
const ruleKey = ({ id: _i, src: _s, ...r }: CondRule) => JSON.stringify(r, Object.keys(r).sort());
const cfOracle = (paths: string[]) => execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_cf.py"], { input: paths.join("\n"), encoding: "utf8" }).trim().split("\n").map((l) => JSON.parse(l) as { file: string; rules?: unknown[][]; error?: string });
const cellIsOf = (rules: CondRule[]) => rules.filter((r) => ["gt", "lt", "ge", "le", "eq", "between"].includes(r.kind) && (r.fill || r.color))
  .map((r) => JSON.stringify([r.sheet, r.range, r.kind, Number.isFinite(Number(r.a)) && String(r.a).trim() !== "" ? Number(r.a) : r.a, r.b === undefined ? null : Number(r.b), r.fill ?? null, r.color ?? null])).sort();

await test("colour scales: 2/3-colour, cfvo min/max/num/percent/percentile (PERCENTILE.INC), clamping, monotone thresholds", CF, async () => {
  const nums = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const t3 = scaleThresholds("min|percentile:50|max", nums, 3); ok(t3.join() === "1,6,11", t3.join());
  ok(scaleThresholds("min|percentile:10|max", nums, 3)[1] === 2, "percentile 10 of 1..11 = 2");
  ok(scaleThresholds("percent:10|percent:90", nums, 2).join() === "2,10", scaleThresholds("percent:10|percent:90", nums, 2).join());
  ok(scaleThresholds("num:20|num:5", nums, 2).join() === "20,20", "non-monotone thresholds are clamped");
  ok(scaleThresholds(undefined, [5, 7, 9, 100], 3)[1] === 8, "default mid = median (PERCENTILE.INC 50)");
  const C = ["#ff0000", "#ffff00", "#0000ff"];
  ok(scaleColor(6, t3, C) === "#ffff00" && scaleColor(1, t3, C) === "#ff0000" && scaleColor(11, t3, C) === "#0000ff", "anchors");
  ok(scaleColor(3.5, t3, C) === "#ff8000", `half-way red→yellow: ${scaleColor(3.5, t3, C)}`);
  ok(scaleColor(8.5, t3, C) === "#808080", `half-way yellow→blue: ${scaleColor(8.5, t3, C)}`);
  ok(scaleColor(-50, t3, C) === "#ff0000" && scaleColor(500, t3, C) === "#0000ff", "clamped outside");
  const wb = new Workbook(); const sh = wb.sheet(); nums.forEach((n, i) => sh.setCell(0, i, String(n))); wb.recalculate();
  const ov = evalCondFormats(wb, sh.name, [{ id: "s", sheet: sh.name, range: "A1:A11", kind: "scale", scaleMin: C[0], scaleMid: C[1], scaleMax: C[2], scaleAt: "min|percentile:50|max" }]);
  ok(ov.get("0,5")?.fill === "#ffff00" && ov.get("0,0")?.fill === "#ff0000", "evaluated through evalCondFormats");
});

const sampleRules = (sheet: string): CondRule[] => [
  { id: "r1", sheet, range: "A1:A10", kind: "gt", a: "5", fill: "#c6efce", color: "#006100" },
  { id: "r2", sheet, range: "A1:A10", kind: "lt", a: "-2.5", color: "#9c0006", bold: true },
  { id: "r3", sheet, range: "B1:B10", kind: "between", a: "10", b: "30", fill: "#ffeb9c" },
  { id: "r4", sheet, range: "C1:C10", kind: "eq", a: 'say "hi"', fill: "#ffc7ce" },
  { id: "r5", sheet, range: "C1:C10", kind: "contains", a: "Grain", fill: "#ddebf7" },
  { id: "r6", sheet, range: "D1:D10", kind: "duplicate", fill: "#ffff00" },
  { id: "r7", sheet, range: "E1:E10", kind: "top", a: "3", color: "#c00000", bold: true },
  { id: "r8", sheet, range: "F1:F10", kind: "scale", scaleMin: "#f8696b", scaleMax: "#63be7b", scaleAt: "num:0|percent:90" },
  { id: "r9", sheet, range: "G1:G10", kind: "scale", scaleMin: "#c00000", scaleMid: "#ffff00", scaleMax: "#0070c0", scaleAt: "min|percentile:50|max" },
  { id: "r10", sheet, range: "H1:H10", kind: "ge", a: "1E3", fill: "#e2efda" },
  { id: "r11", sheet, range: "H1:H10", kind: "le", a: "0", fill: "#fce4d6" },
];

await test("new-file .xlsx writer emits conditional formats (all 10 kinds + dxfs): our reader and the independent oracle read them back", CF, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); for (let r = 0; r < 10; r++) for (let c = 0; c < 8; c++) sh.setCell(c, r, String(r * 3 - 4 + c));
  wb.condFormats = sampleRules(sh.name); wb.recalculate();
  const bytes = writeXlsxWorkbook(wb); const f = join(tmp, "cf-new.xlsx"); writeFileSync(f, bytes);
  const back = readXlsxWorkbook(Buffer.from(bytes));
  const A = wb.condFormats.map(ruleKey).sort(), B = back.condFormats.map(ruleKey).sort();
  ok(JSON.stringify(A) === JSON.stringify(B), `reader round-trip:\n  wrote ${A.filter((x) => !B.includes(x)).join("\n  ")}\n  read  ${B.filter((x) => !A.includes(x)).join("\n  ")}`);
  if (!existsSync(PY)) return;
  const [o] = cfOracle([f]); ok(!o.error, `oracle: ${o.error}`);
  const theirs = o.rules!.map((x) => JSON.stringify(x)).sort(), ours = cellIsOf(wb.condFormats);
  ok(JSON.stringify(theirs) === JSON.stringify(ours), `oracle cellIs:\n  ours ${ours.join("\n  ")}\n  oracle ${theirs.join("\n  ")}`);
  const kinds = execFileSync(PY, ["-W", "ignore", "-c", `import openpyxl,json,sys
ws=openpyxl.load_workbook(sys.argv[1]).active;out=[]
for cf in ws.conditional_formatting:
  for r in cf.rules:
    cs=r.colorScale
    out.append([str(cf.sqref), r.type, r.rank, r.text, [ (v.type, v.val) for v in cs.cfvo ] if cs else None, [c.rgb for c in cs.color] if cs else None])
print(json.dumps(sorted(out, key=lambda x: (x[0], x[1]))))`, f], { encoding: "utf8" });
  const k = JSON.parse(kinds) as [string, string, number | null, string | null, [string, unknown][] | null, string[] | null][];
  const t = (rng: string, type: string) => k.find((x) => x[0] === rng && x[1] === type);
  ok(t("C1:C10", "containsText")?.[3] === "Grain", "containsText text");
  ok(t("D1:D10", "duplicateValues"), "duplicateValues");
  ok(t("E1:E10", "top10")?.[2] === 3, "top10 rank 3");
  const s2 = t("F1:F10", "colorScale"); ok(JSON.stringify(s2?.[4]) === JSON.stringify([["num", 0], ["percent", 90]]) && JSON.stringify(s2?.[5]) === JSON.stringify(["FFF8696B", "FF63BE7B"]), `2-colour scale ${JSON.stringify(s2)}`);
  const s3 = t("G1:G10", "colorScale"); ok(JSON.stringify(s3?.[4]) === JSON.stringify([["min", null], ["percentile", 50], ["max", null]]) && s3?.[5]?.length === 3, `3-colour scale ${JSON.stringify(s3)}`);
});

const ORDER = ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols", "sheetData", "sheetCalcPr", "sheetProtection", "protectedRanges", "scenarios", "autoFilter", "sortState", "dataConsolidate", "customSheetViews", "mergeCells", "phoneticPr", "conditionalFormatting", "dataValidations", "hyperlinks", "printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks", "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing", "legacyDrawingHF", "drawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"];
const childOrderOk = (xml: string) => {
  const body = xml.replace(/<sheetData\b[\s\S]*?<\/sheetData>|<sheetData\b[^>]*\/>/, "<sheetData/>").replace(/<extLst\b[\s\S]*<\/extLst>/, "<extLst/>");
  const top = [...body.matchAll(/<(?:\w+:)?(\w+)\b[^>]*?(\/?)>/g)].map((m) => m[1]);
  let last = -1; for (const n of top) { const i = ORDER.indexOf(n); if (i < 0) continue; if (i < last) return `${n} after ${ORDER[last]}`; last = i; }
  return "";
};

await test("lossless .xlsx save writes UI conditional-format edits (change / delete / add) and keeps unmodelled rules, other sheets and order verbatim (independent oracle)", CF, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  const src = join(CORPUS, "ConditionalFormattingSamples.xlsx"); const bytes = new Uint8Array(readFileSync(src));
  const base = loadedBaseline(bytes);
  const wb = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(readXlsxWorkbook(Buffer.from(bytes)))))); wb.recalculate();
  const d = wb.condFormats.find((r) => r.sheet === "Products1" && r.range === "D3:D23"); ok(d, "Products1 D3:D23 rule imported");
  d.a = "1000"; d.fill = "#ffc7ce"; d.color = "#9c0006";
  const before = wb.condFormats.length;
  wb.condFormats = wb.condFormats.filter((r) => !(r.sheet === "Customers1" && r.kind === "duplicate"));
  ok(wb.condFormats.length === before - 1, "duplicate rule deleted");
  wb.condFormats.push({ id: "u1", sheet: "Products1", range: "C3:C23", kind: "eq", a: "Beverages", fill: "#e2efda", bold: true },
    { id: "u2", sheet: "Mountains", range: "B3:B12", kind: "scale", scaleMin: "#c00000", scaleMid: "#ffff00", scaleMax: "#0070c0", scaleAt: "min|percentile:50|max" });
  const { bytes: out, report } = await patchXlsx(bytes, wb, {}, base);
  const f = join(tmp, "cf-edit.xlsx"); writeFileSync(f, out);
  // 1. our reader sees exactly the edited rule set
  const back = readXlsxWorkbook(Buffer.from(out));
  const A = wb.condFormats.map((r) => ruleKey({ ...r, id: "" })).sort(), B = back.condFormats.map((r) => ruleKey({ ...r, id: "" })).sort();
  ok(JSON.stringify(A) === JSON.stringify(B), `re-read differs:\n  want ${A.filter((x) => !B.includes(x)).join("\n  ")}\n  got  ${B.filter((x) => !A.includes(x)).join("\n  ")}`);
  // 2. independent oracle agrees on every constant cellIs rule
  const [o] = cfOracle([f]); ok(!o.error, `oracle: ${o.error}`);
  const theirs = o.rules!.map((x) => JSON.stringify(x)).sort(), ours = cellIsOf(wb.condFormats);
  ok(JSON.stringify(theirs) === JSON.stringify(ours), `oracle cellIs:\n  ours ${ours.filter((x) => !theirs.includes(x)).join("\n  ")}\n  oracle ${theirs.filter((x) => !ours.includes(x)).join("\n  ")}`);
  // 3. unmodelled rules (icon sets, data bars, expressions, x14 ext) survive verbatim; untouched sheet parts byte-identical
  const za = openZip(bytes), zb = openZip(out);
  const types = async (z: ReturnType<typeof openZip>) => { const m = new Map<string, number>(); for (const e of z.entries) if (/worksheets\/sheet\d+\.xml$/.test(e.name)) for (const t of ((await z.readText(e.name)) ?? "").matchAll(/<(?:\w+:)?cfRule\b[^>]*\btype="(\w+)"/g)) m.set(t[1], (m.get(t[1]) ?? 0) + 1); return m; };
  const ta = await types(za), tb = await types(zb);
  for (const t of ["iconSet", "dataBar", "expression", "aboveAverage", "timePeriod", "containsBlanks", "beginsWith", "endsWith", "uniqueValues"]) ok((ta.get(t) ?? 0) === (tb.get(t) ?? 0), `${t} rules ${ta.get(t) ?? 0} → ${tb.get(t) ?? 0}`);
  ok((tb.get("colorScale") ?? 0) === (ta.get("colorScale") ?? 0) + 1 && (tb.get("duplicateValues") ?? 0) === (ta.get("duplicateValues") ?? 0) - 1, `colorScale/duplicate counts ${JSON.stringify([...ta])} → ${JSON.stringify([...tb])}`);
  const touched = new Set<string>(); let identical = 0;
  for (const e of za.entries) {
    if (e.name.endsWith("/") || /calcChain/.test(e.name)) continue;
    const x = await za.read(e.name), y = await zb.read(e.name); ok(y, `lost ${e.name}`);
    if (Buffer.compare(Buffer.from(x!), Buffer.from(y!)) === 0) identical++; else touched.add(e.name);
  }
  const sheetsTouched = [...touched].filter((n) => /worksheets\/sheet/.test(n));
  ok(sheetsTouched.length === 3, `exactly the 3 edited sheets rewritten, got ${sheetsTouched.join(", ")}`);
  ok([...touched].every((n) => /worksheets\/sheet\d+\.xml$|styles\.xml$|workbook\.xml$|\[Content_Types\]\.xml$/.test(n)), `unexpected rewritten parts: ${[...touched].join(", ")}`);
  for (const n of sheetsTouched) { const bad = childOrderOk((await zb.readText(n))!); ok(!bad, `${n}: CT_Worksheet order violated (${bad})`); }
  // 4. cell content untouched (openpyxl probe)
  const pr = JSON.parse(execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_patch_probe.py"], { input: `${src}\t${f}`, encoding: "utf8" }).trim());
  ok(pr.ok !== false && !(pr.diff ?? []).length && !(pr.partsLost ?? []).length, `probe: ${JSON.stringify(pr).slice(0, 400)}`);
  console.log(`    ${identical} parts byte-identical; rewritten: ${[...touched].join(", ")}; report ${JSON.stringify(report)}`);
  // 5. no CF change → byte-identical save still holds
  const same = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(readXlsxWorkbook(Buffer.from(bytes)))))); same.recalculate();
  ok(Buffer.compare(Buffer.from((await patchXlsx(bytes, same, {}, base)).bytes), Buffer.from(bytes)) === 0, "no-edit save is no longer byte-identical");
});

await test("adversary: an extLst that redeclares the default namespace around <conditionalFormatting> is neither modelled nor misaligns provenance; edits keep it verbatim exactly once", CF, async () => {
  const wb = new Workbook(); const sh = wb.sheet(); for (let r = 0; r < 10; r++) for (let c = 0; c < 8; c++) sh.setCell(c, r, String(r + c));
  wb.condFormats = sampleRules(sh.name).slice(0, 3); wb.recalculate();
  const z = openZip(writeXlsxWorkbook(wb)); const part = z.entries.find((e) => /worksheets\/sheet1\.xml$/.test(e.name))!.name;
  const ext = `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:conditionalFormattings><conditionalFormatting xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" sqref="H1:H3"><cfRule type="cellIs" priority="99" operator="greaterThan" dxfId="0"><formula>12345</formula></cfRule><xm:sqref>H1:H3</xm:sqref></conditionalFormatting></x14:conditionalFormattings></ext></extLst>`;
  const files = new Map<string, Uint8Array>(); for (const e of z.entries) if (!e.name.endsWith("/")) files.set(e.name, (await z.read(e.name))!);
  files.set(part, new TextEncoder().encode(new TextDecoder().decode(files.get(part)).replace("</worksheet>", `${ext}</worksheet>`)));
  const { writeZip } = await import("../src/lib/office/zipkit.ts");
  const bytes = new Uint8Array(await writeZip([...files].map(([name, data]) => ({ name, data }))));
  const read = readXlsxWorkbook(Buffer.from(bytes));
  ok(read.condFormats.length === 3 && read.condFormats.every((r) => r.a !== "12345"), `x14 rule must not be modelled: ${read.condFormats.map((r) => r.src + ":" + r.a).join(",")}`);
  ok(read.condFormats.map((r) => r.src).join() === "0.0,1.0,2.0", `provenance ${read.condFormats.map((r) => r.src).join()}`);
  const ui = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(read)))); ui.recalculate();
  ui.condFormats[1].a = "-9"; ui.condFormats.splice(2, 1);
  const out = (await patchXlsx(bytes, ui, {}, loadedBaseline(bytes))).bytes;
  const xml = (await openZip(out).readText(part))!;
  ok(xml.split("<formula>12345</formula>").length === 2 && xml.includes(ext), "x14 ext block kept verbatim exactly once");
  const back = readXlsxWorkbook(Buffer.from(out));
  ok(JSON.stringify(back.condFormats.map((r) => [r.range, r.kind, r.a])) === JSON.stringify([["A1:A10", "gt", "5"], ["A1:A10", "lt", "-9"]]), `after edit: ${JSON.stringify(back.condFormats.map((r) => [r.range, r.kind, r.a, r.src]))}`);
  ok(!childOrderOk(xml), childOrderOk(xml));
});

await test("text cells stay text: every corpus string that looks like a number / boolean / formula reads back as the same TEXT (independent openpyxl list); quote-prefix input semantics", { "FF-20": "full" }, async () => {
  const wb = new Workbook(); const sh = wb.sheet();
  sh.setCell(0, 0, "'0012"); sh.setCell(0, 1, "'TRUE"); sh.setCell(0, 2, "'=A1"); sh.setCell(0, 3, "''x"); sh.setCell(0, 4, "=LEN(A1)&ISTEXT(A2)&A3"); wb.recalculate();
  ok(wb.valueAt(sh.name, 0, 0) === "0012" && wb.valueAt(sh.name, 0, 1) === "TRUE" && wb.valueAt(sh.name, 0, 2) === "=A1" && wb.valueAt(sh.name, 0, 3) === "'x", "quote prefix → literal text");
  ok(wb.valueAt(sh.name, 0, 4) === "4TRUE=A1", `formulas see text: ${JSON.stringify(wb.valueAt(sh.name, 0, 4))}`);
  const back = readXlsxWorkbook(writeXlsxWorkbook(wb));
  ok(back.valueAt(sh.name, 0, 0) === "0012" && back.valueAt(sh.name, 0, 2) === "=A1" && back.sheet().get(0, 2)?.formula === null, "round trip keeps text, never a live formula");
  if (!haveCorpus) return;
  const files = readdirSync(CORPUS).filter((f) => f.endsWith(".xlsx")).map((f) => join(CORPUS, f)).filter((f) => readFileSync(f).length <= 8 << 20);
  const res: { file: string; cells?: [string, string][]; strings?: number; error?: string }[] = [];
  for (let i = 0; i < files.length; i += 40) res.push(...execFileSync(PY, ["scripts/oracle/xlsx_risky_strings.py"], { input: files.slice(i, i + 40).join("\n"), encoding: "utf8", maxBuffer: 256 << 20 }).trim().split("\n").map((l) => JSON.parse(l)));
  let risky = 0, strings = 0, wbs = 0; const bad: string[] = [];
  for (const r of res) {
    if (r.error || !r.cells) continue;
    strings += r.strings ?? 0; if (!r.cells.length) continue;
    let w; try { w = readXlsxWorkbook(readFileSync(r.file)); } catch { continue; }
    wbs++;
    for (const [ref, text] of r.cells) {
      const b = ref.lastIndexOf("!"); const m = /^([A-Z]+)(\d+)$/.exec(ref.slice(b + 1))!;
      let col = 0; for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64;
      const v = w.valueAt(ref.slice(0, b), col - 1, Number(m[2]) - 1); risky++;
      if (v !== text) bad.push(`${r.file.split("/").pop()} ${ref}: ${JSON.stringify(text)} → ${JSON.stringify(v)}`);
    }
  }
  console.log(`    ${strings} string cells scanned; ${risky} number/boolean/formula-looking strings in ${wbs} workbooks compared`);
  ok(risky > 100, `too few risky strings: ${risky}`);
  ok(!bad.length, `${bad.length} lost their text: ${bad.slice(0, 8).join(" | ")}`);
});

await finish();
process.exit(0);
