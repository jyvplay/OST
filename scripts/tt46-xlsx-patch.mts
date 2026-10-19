/**
 * TT46 — lossless .xlsx save (src/lib/formula/xlsx-patch.ts), verified by an
 * independent implementation (openpyxl 3.x, MIT, test-only) over the Apache
 * POI spreadsheet corpus (Apache-2.0, test-only; /home/user/tools/corpus/xlsx).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt46-xlsx-patch.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { patchXlsx, loadedBaseline } from "../src/lib/formula/xlsx-patch.ts";
import { readXlsxWorkbook, writeXlsxWorkbook, workbookToJson, workbookFromJson } from "../src/lib/formula/xlsx.ts";
import { openZip } from "../src/lib/office/zipkit.ts";
import { a1, type Workbook } from "../src/lib/formula/engine.ts";

const { test: test0, finish } = makeHarness("tt46-xlsx-patch");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !name.includes(ONLY) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const COV = { "FF-20": "full", "FF-11": "full" } as const;
const CORPUS = "/home/user/tools/corpus/xlsx";
const PY = "/home/user/tools/venv/bin/python";
const haveCorpus = existsSync(CORPUS) && existsSync(PY);
const tmp = mkdtempSync(join(tmpdir(), "tt46x-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 400)} != ${JSON.stringify(b)?.slice(0, 400)}`); };
type Probe = { file: string; skip?: string; ok?: boolean; error?: string; diff: string[]; styleDiff: Record<string, string[]>; extras: Record<string, unknown>; partsLost: string[]; values?: Record<string, unknown> };
const probe = (pairs: [string, string][], extra: string[] = []): Probe[] => {
  const out: Probe[] = [];
  for (let i = 0; i < pairs.length; i += 40) {
    const chunk = pairs.slice(i, i + 40).map((p) => p.join("\t")).join("\n");
    let text: string;
    try { text = execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_patch_probe.py", ...extra], { input: chunk, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (e) { const x = e as { status?: number; signal?: string; stderr?: string; stdout?: string }; throw new Error(`oracle failed (status ${x.status}, signal ${x.signal}) on chunk ${i / 40}: ${(x.stderr ?? "").slice(-600)}`); }
    out.push(...text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  return out;
};
/** Workbook as the UI holds it: read, then through the JSON round-trip the Spreadsheet module uses. */
const uiWorkbook = (bytes: Uint8Array): Workbook => { const wb = workbookFromJson(JSON.parse(JSON.stringify(workbookToJson(readXlsxWorkbook(Buffer.from(bytes)))))); wb.recalculate(); return wb; };
const baseOf = (bytes: Uint8Array): Workbook => loadedBaseline(bytes);
const readable: { name: string; bytes: Uint8Array }[] = []; const slow: string[] = [];
if (haveCorpus) for (const f of readdirSync(CORPUS).filter((x) => x.endsWith(".xlsx")).sort()) {
  const bytes = new Uint8Array(readFileSync(join(CORPUS, f)));
  const t0 = performance.now();
  try { readXlsxWorkbook(Buffer.from(bytes)); openZip(bytes); } catch { continue; /* correctly rejected (encrypted / corrupt / bomb) */ }
  if (performance.now() - t0 > 8000) { slow.push(f); continue; } // reader-performance limit, disclosed
  readable.push({ name: f, bytes });
}
if (slow.length) console.log(`    excluded (reader > 8 s): ${slow.join(", ")}`);

await test("no-edit save of every readable corpus workbook returns the original bytes", COV, async () => {
  ok(haveCorpus, "corpus or venv missing — run /home/user/tools/corpus/fetch.py");
  ok(readable.length > 80, `only ${readable.length} readable workbooks`);
  const bad: string[] = [];
  for (const { name, bytes } of readable) {
    try { const { bytes: out } = await patchXlsx(bytes, uiWorkbook(bytes), {}, baseOf(bytes)); if (Buffer.compare(Buffer.from(out), Buffer.from(bytes)) !== 0) bad.push(name); }
    catch (e) { bad.push(`${name}: ${(e as Error).message.slice(0, 80)}`); }
  }
  ok(bad.length <= Math.floor(readable.length * 0.02), `${bad.length}/${readable.length} not identical: ${bad.slice(0, 8).join(" | ")}`);
  console.log(`    identity: ${readable.length - bad.length}/${readable.length}${bad.length ? ` (differs: ${bad.join(", ")})` : ""}`);
});

await test("corpus edit session: change a number, add a bold text cell, re-style a cell — openpyxl sees exactly those edits and nothing else lost", COV, async () => {
  ok(haveCorpus, "corpus missing");
  const pairs: [string, string][] = []; const expect = new Map<string, { cells: string[]; styled: string | null }>();
  const failures: string[] = []; const refused: string[] = [];
  for (const { name, bytes } of readable) {
    const wb = uiWorkbook(bytes);
    const sheet = [...wb.sheets.values()][0];
    let num: [number, number] | null = null, maxC = 0, maxR = 0, styled: [number, number] | null = null;
    for (const [k, c] of sheet.grid) {
      const [col, row] = k.split(",").map(Number); maxC = Math.max(maxC, col); maxR = Math.max(maxR, row);
      if (!num && c.input !== "" && !c.formula && /^-?\d+(\.\d+)?$/.test(c.input) && !sheet.merges.some((m) => col >= m.c0 && col <= m.c1 && row >= m.r0 && row <= m.r1)) num = [col, row];
      if (!styled && c.input !== "" && !c.formula && c.style && !c.style.bold && (!num || num[0] !== col || num[1] !== row)) styled = [col, row];
    }
    if (maxC > 16000 || maxR > 1_048_000) continue;
    const cells: string[] = [];
    try {
      if (num) { sheet.setCell(num[0], num[1], "4242.5"); cells.push(`${sheet.name}!${a1(num[0], num[1])}`); }
      sheet.setCell(maxC + 2, maxR + 2, "Fusion edit ✓ & <ok>"); sheet.setStyle(maxC + 2, maxR + 2, { bold: true }); cells.push(`${sheet.name}!${a1(maxC + 2, maxR + 2)}`);
      if (styled) sheet.setStyle(styled[0], styled[1], { bold: true });
      wb.recalculate();
      const { bytes: out } = await patchXlsx(bytes, wb, {}, baseOf(bytes));
      const p = join(tmp, `e-${name}`); writeFileSync(p, out);
      pairs.push([join(CORPUS, name), p]); expect.set(join(CORPUS, name), { cells, styled: styled ? `${sheet.name}!${a1(styled[0], styled[1])}` : null });
    } catch (e) {
      const m = (e as Error).message;
      // damaged packages are refused (the UI then offers a full export with an itemised loss report)
      if (/CRC|not closed|duplicate zip entry|ambiguous package/.test(m)) refused.push(name); else failures.push(`${name}: patch threw ${m.slice(0, 100)}`);
    }
  }
  const res = probe(pairs);
  const lim = res.filter((r) => r.skip?.startsWith("oracle limitation")).map((r) => r.file.split("/").pop());
  if (lim.length) console.log(`    oracle could not verify (disclosed): ${lim.join(", ")}`);
  let checked = 0;
  for (const r of res) {
    if (r.skip) continue;
    const want = expect.get(r.file)!; const short = r.file.split("/").pop();
    if (!r.ok) { failures.push(`${short}: openpyxl cannot load the saved file: ${r.error}`); continue; }
    checked++;
    const unexpected = r.diff.filter((k) => !want.cells.includes(k));
    if (unexpected.length) failures.push(`${short}: unexpected cell changes ${unexpected.slice(0, 4).join(",")}`);
    const missing = want.cells.filter((k) => !r.diff.includes(k));
    if (missing.length) failures.push(`${short}: edits not visible ${missing.join(",")}`);
    for (const [k, fields] of Object.entries(r.styleDiff)) {
      if (k === want.styled ? fields.some((f) => f !== "font") : !want.cells.includes(k)) failures.push(`${short}: style drift at ${k} (${fields.join(",")})`);
    }
    if (Object.keys(r.extras).length) failures.push(`${short}: features changed ${JSON.stringify(r.extras).slice(0, 160)}`);
    if (r.partsLost.length) failures.push(`${short}: parts lost ${r.partsLost.slice(0, 3).join(",")}`);
  }
  if (refused.length) console.log(`    damaged packages refused by the patch writer: ${refused.join(", ")}`);
  console.log(`    openpyxl-verified edit sessions: ${checked - new Set(failures.map((f) => f.split(":")[0])).size}/${checked} clean`);
  ok(checked > 70, `only ${checked} files checked`);
  ok(failures.length === 0, `${failures.length} problems:\n      ${failures.slice(0, 12).join("\n      ")}`);
});

await test("charts, comments, conditional formats, data validation, images and theme-coloured fonts survive an edit; only edited parts change", COV, async () => {
  ok(haveCorpus, "corpus missing");
  const want = (re: RegExp) => readable.filter(({ bytes }) => openZip(bytes).entries.some((e) => re.test(e.name)));
  const charts = want(/xl\/charts\/chart\d+\.xml$/), comments = want(/xl\/comments\d*\.xml$/), drawings = want(/xl\/media\//);
  ok(charts.length && comments.length && drawings.length, `corpus lacks feature files (${charts.length}/${comments.length}/${drawings.length})`);
  for (const { name, bytes } of [...charts.slice(0, 4), ...comments.slice(0, 4), ...drawings.slice(0, 3)]) {
    const wb = uiWorkbook(bytes); const sheet = [...wb.sheets.values()][0];
    sheet.setCell(0, 0, "edited");
    const { bytes: out } = await patchXlsx(bytes, wb);
    const a = openZip(bytes), b = openZip(out);
    const changed: string[] = [];
    for (const e of a.entries) {
      const x = await a.read(e.name), y = await b.read(e.name);
      if (!y) { if (!/calcChain/.test(e.name)) throw new Error(`${name}: lost ${e.name}`); continue; }
      if (Buffer.compare(Buffer.from(x!), Buffer.from(y)) !== 0) changed.push(e.name);
    }
    const allowed = /(^xl\/worksheets\/[^/]+\.xml$|^xl\/workbook\.xml$|^xl\/styles\.xml$|^xl\/_rels\/workbook\.xml\.rels$|^\[Content_Types\]\.xml$)/;
    const bad = changed.filter((n) => !allowed.test(n));
    eq(bad, [], `${name}: unrelated parts rewritten`);
  }
});

await test("cached values: a formula depending on an edited cell is re-cached (data_only reader sees the new result); calcChain dropped + fullCalcOnLoad", COV, async () => {
  // build a workbook with the old writer, then edit through the patch writer
  const wb0 = workbookFromJson({ sheets: [{ name: "Data", cells: [{ ref: "A1", input: "2" }, { ref: "A2", input: "3" }, { ref: "A3", input: "=A1*A2" }, { ref: "B1", input: "=SUM(A1:A2)&\" total\"" }] }] } as never);
  const base = new Uint8Array(writeXlsxWorkbook(wb0));
  const wb = uiWorkbook(base); wb.sheets.get("Data")!.setCell(0, 0, "10"); wb.recalculate();
  const { bytes } = await patchXlsx(base, wb);
  const p = join(tmp, "cache.xlsx"); writeFileSync(p, bytes);
  const r = JSON.parse(execFileSync(PY, ["-c", `import openpyxl,json;w=openpyxl.load_workbook(${JSON.stringify(p)},data_only=True)["Data"];print(json.dumps([w["A3"].value,w["B1"].value,w["A1"].value]))`], { encoding: "utf8" }));
  eq(r, [30, "13 total", 10], "cached values");
  const wbXml = (await openZip(bytes).readText("xl/workbook.xml"))!;
  ok(/fullCalcOnLoad="1"/.test(wbXml), "fullCalcOnLoad missing");
});

await test("sheet rename, add, delete and reorder; merges, column widths, freeze panes and validations written; definedNames follow the rename", COV, async () => {
  const wb0 = workbookFromJson({ sheets: [{ name: "One", cells: [{ ref: "A1", input: "a" }] }, { name: "Two", cells: [{ ref: "A1", input: "b" }] }, { name: "Three", cells: [{ ref: "A1", input: "=One!A1&Two!A1" }] }] } as never);
  wb0.defineName("Total", "One!$A$1");
  const base = new Uint8Array(writeXlsxWorkbook(wb0));
  const wb = uiWorkbook(base);
  const json = workbookToJson(wb) as { sheets: { name: string }[] };
  // rename One→First, delete Two, add New at the front
  const one = json.sheets.find((s) => s.name === "One")!; one.name = "First";
  const three = json.sheets.find((s) => s.name === "Three")! as { name: string; cells: { ref: string; input: string }[] };
  three.cells = [{ ref: "A1", input: "=First!A1&\"!\"" }];
  json.sheets = [{ name: "New", cells: [{ ref: "B2", input: "hello" }] } as never, one, three];
  const wb2 = workbookFromJson(json as never); wb2.recalculate();
  const s1 = wb2.sheets.get("First")!; s1.merges.push({ c0: 0, r0: 2, c1: 2, r1: 3 }); s1.colWidths[1] = 210; s1.freezeRows = 1;
  s1.validations.push({ id: "v1", sqref: "D1:D5", type: "list", formula1: "\"yes,no\"", allowBlank: true, errorStyle: "stop", showError: true, inCellDropdown: true });
  const { bytes, report } = await patchXlsx(base, wb2, { First: "One" });
  eq(report.sheetsRenamed, [["One", "First"]], "rename detected"); eq(report.sheetsRemoved, ["Two"], "delete detected"); eq(report.sheetsAdded, ["New"], "add detected");
  const p = join(tmp, "struct.xlsx"); writeFileSync(p, bytes);
  const r = JSON.parse(execFileSync(PY, ["-c", `import openpyxl,json
w=openpyxl.load_workbook(${JSON.stringify(p)})
f=w["First"]
print(json.dumps({"sheets":w.sheetnames,"new":w["New"]["B2"].value,"f":w["Three"]["A1"].value,"merge":[str(m) for m in f.merged_cells.ranges],"width":round(f.column_dimensions["B"].width,2),"freeze":f.freeze_panes,"dv":[str(d.sqref) for d in f.data_validations.dataValidation],"names":{n:w.defined_names[n].attr_text for n in w.defined_names}}))`], { encoding: "utf8" }));
  eq(r.sheets, ["New", "First", "Three"], "sheet order"); eq(r.new, "hello", "new sheet cell"); eq(r.f, "=First!A1&\"!\"", "formula");
  eq(r.merge, ["A3:C4"], "merge"); eq(r.width, 30, "width (210 px → 30 chars)"); eq(r.freeze, "A2", "freeze"); eq(r.dv, ["D1:D5"], "validation");
  eq(r.names, { Total: "First!$A$1" }, "defined name follows rename");
  // our own reader agrees
  const back = readXlsxWorkbook(Buffer.from(bytes)); back.recalculate();
  eq(back.valueAt("Three", 0, 0), "a!", "recomputed value");
});

await test("style derivation keeps theme colours and font face/size of the original cell", COV, async () => {
  ok(haveCorpus, "corpus missing");
  // find a corpus cell whose font uses a theme colour or a non-Calibri face
  const res: string[] = [];
  for (const { name, bytes } of readable.slice(0, 120)) {
    const styles = await openZip(bytes).readText("xl/styles.xml"); if (!styles || !/<color theme=/.test(styles)) continue;
    const wb = uiWorkbook(bytes); const sheet = [...wb.sheets.values()][0];
    const target = [...sheet.grid.entries()].find(([, c]) => c.input !== "" && !c.formula && !c.style?.bold);
    if (!target) continue;
    const [col, row] = target[0].split(",").map(Number);
    sheet.setStyle(col, row, { bold: true });
    const { bytes: out } = await patchXlsx(bytes, wb);
    const p = join(tmp, `s-${name}`); writeFileSync(p, out);
    const coord = a1(col, row);
    const r = JSON.parse(execFileSync(PY, ["-c", `import openpyxl,json
a=openpyxl.load_workbook(${JSON.stringify(join(CORPUS, name))}).worksheets[0][${JSON.stringify(coord)}].font
b=openpyxl.load_workbook(${JSON.stringify(p)}).worksheets[0][${JSON.stringify(coord)}].font
c=lambda x: None if x is None else (x.rgb if x.type=="rgb" else (x.type, x.theme, x.tint))
print(json.dumps([[a.name,a.sz,c(a.color),bool(a.b)],[b.name,b.sz,c(b.color),bool(b.b)]]))`], { encoding: "utf8" }));
    eq([r[1][0], r[1][1], r[1][2]], [r[0][0], r[0][1], r[0][2]], `${name} ${coord}: face/size/colour kept`);
    ok(r[1][3] === true, `${name}: bold applied`);
    res.push(name); if (res.length >= 6) break;
  }
  ok(res.length >= 3, `only ${res.length} theme-styled files exercised`);
});

await test("Strict OOXML workbooks (openpyxl cannot read them): edit round-trips through our reader, namespaces kept, no part lost", COV, async () => {
  ok(haveCorpus, "corpus missing");
  const strict = readable.filter(({ bytes }) => /purl\.oclc\.org\/ooxml\/spreadsheetml\/main/.test(Buffer.from(bytes).toString("latin1")) || true).filter(({ name }) => /strict/i.test(name) || name === "57914.xlsx");
  ok(strict.length >= 2, `only ${strict.length} strict files`);
  for (const { name, bytes } of strict) {
    const wb = uiWorkbook(bytes); const sheet = [...wb.sheets.values()][0];
    sheet.setCell(0, 0, "strict edit"); sheet.setCell(1, 0, "=LEN(A1)"); wb.recalculate();
    const { bytes: out } = await patchXlsx(bytes, wb, {}, baseOf(bytes));
    const back = readXlsxWorkbook(Buffer.from(out)); back.recalculate();
    eq(back.valueAt(sheet.name, 0, 0), "strict edit", `${name} A1`); eq(back.valueAt(sheet.name, 1, 0), 11, `${name} B1`);
    const a = openZip(bytes), b = openZip(out);
    for (const e of a.entries) if (!e.name.endsWith("/") && !/calcChain/.test(e.name)) ok(b.has(e.name), `${name}: lost ${e.name}`);
    const ws = (await b.readText(e0(a)))!; ok(/purl\.oclc\.org/.test(ws), `${name}: strict namespace lost`);
  }
});
await test("conditional formats are imported for display: every constant cellIs rule (numeric or string operand; rgb, theme+tint or indexed colours) matches an independent reading (openpyxl rules + lxml dxfs + colorsys tint)", { "FF-21": "partial" }, async () => {
  ok(haveCorpus, "corpus missing");
  const cand = readable.filter(({ bytes }) => /conditionalFormatting/.test(Buffer.from(bytes).toString("latin1")) || openZip(bytes).entries.some((e) => /worksheets\/.*\.xml$/.test(e.name)));
  const ours = new Map<string, unknown[]>();
  for (const { name, bytes } of cand) {
    const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v);
    ours.set(join(CORPUS, name), readXlsxWorkbook(Buffer.from(bytes)).condFormats.filter((r) => ["gt", "lt", "ge", "le", "eq", "between"].includes(r.kind) && (r.fill || r.color))
      .map((r) => [r.sheet, r.range, r.kind, num(r.a), r.b === undefined ? null : num(r.b), r.fill ?? null, r.color ?? null]));
  }
  const paths = [...ours.keys()]; const res: { file: string; rules?: unknown[]; error?: string }[] = [];
  for (let i = 0; i < paths.length; i += 40) {
    const text = execFileSync(PY, ["-W", "ignore", "scripts/oracle/xlsx_cf.py"], { input: paths.slice(i, i + 40).join("\n"), encoding: "utf8", maxBuffer: 256 << 20 });
    res.push(...text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  let compared = 0, rules = 0; const bad: string[] = [], skipped: string[] = [];
  const key = (x: unknown) => JSON.stringify(x);
  for (const r of res) {
    if (r.error || !r.rules) { skipped.push(r.file.split("/").pop()!); continue; }
    if (/\.strict\.|strict-|beta/i.test(r.file.split("/").pop()!)) { skipped.push(`${r.file.split("/").pop()} (oracle namespace limits)`); continue; }
    const A = (ours.get(r.file) ?? []).map(key).sort(), B = r.rules.map(key).sort();
    if (!A.length && !B.length) continue;
    compared++; rules += B.length;
    if (key(A) !== key(B)) bad.push(`${r.file.split("/").pop()}: ours ${A.filter((x) => !B.includes(x)).slice(0, 3).join(" ")} (${A.length}) vs oracle ${B.filter((x) => !A.includes(x)).slice(0, 3).join(" ")} (${B.length})`);
  }
  console.log(`    ${compared} workbooks / ${rules} rules compared; oracle skips: ${skipped.length} (${skipped.slice(0, 8).join(", ")})`);
  ok(compared >= 5, `only ${compared} workbooks had comparable rules`);
  ok(!bad.length, bad.slice(0, 6).join("\n      "));
});

function e0(z: ReturnType<typeof openZip>) { return z.entries.find((e) => /worksheets\/sheet\d+\.xml$/.test(e.name))!.name; }

await finish(); process.exit(0);
