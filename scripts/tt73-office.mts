/**
 * TT73 office class-A gates (Spreadsheet, Writer, Slides). Every oracle is independent of the app: Excel's own cached
 * values / chart caches read with lxml, Apache POI's dfUS assertions (Apache-2.0 test data), the ECMA-376 transitional
 * XSDs via lxml (scripts/oracle/ooxml_xsd.py, now including PresentationML), python-docx and python-pptx.
 *
 *  S1  TEXT: 806 Excel-cached TEXT() results from the corpus (docs/heldout/tt73-text-oracle.json) — all agree
 *  S2  number formats: Apache POI TestDataFormatter dfUS assertions that hold in Excel (189 rows) — at least 163 agree
 *  S3  external workbook links ([1]Sheet!A1, [1]!Name, sheet-scoped [1]Sheet!Name, [0]!Name) resolve from the cached
 *      externalLink parts, as Excel shows them before "Update links"
 *  S4  Unicode sheet / table / defined names (Лист2!A1, Таблица1[[Col]], Налог) — a Russian corpus workbook's SUBTOTAL
 *      over a table column equals Excel's cached value; TT72 failed with "unexpected character 'Т'"
 *  S5  Excel numeric-argument rules (refs count numbers only; literal text → #VALUE!; MODE no repeat → #N/A; …)
 *  C1  FF-29 gate: every corpus chart series evaluates to Excel's c:numCache / c:strCache — values, categories / scatter
 *      x values and cached series names (36 charts, 76 series, 1,828 points)
 *  H1  held-out formula probe: at least 26,869 of 26,946 Excel-cached formula cells agree (TT72: 26,295)
 *  W1  header / footer picture: its relationship is in header1.xml.rels (OPC), python-docx finds it, schema-valid,
 *      re-reads with the same bytes; tracked as w:ins with Track Changes on; existing headers without xmlns:r
 *  W2  FF-22 gate: EVERY readable corpus docx gets body text typed AND a header picture, is saved, and (a) adds no schema
 *      error the input lacked, (b) python-docx opens it and sees the typed text and the header picture, (c) re-reads
 *  P1  the PresentationML schema oracle is a real verifier (rejects an unknown element and wrong child order in a slide)
 *  P2  FF-23 gate: EVERY openable corpus deck gets text typed, a text box + shape + picture, notes, a duplicated slide and
 *      a slide from a layout, is saved, and (a) adds no schema error the input lacked, (b) python-pptx opens it and sees
 *      the edits
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt73-office.mts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { formatValue } from "../src/lib/formula/numfmt.ts";
import { setDate1904 } from "../src/lib/formula/dates.ts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { chartCache } from "./tt73-chartcache.mts";
import { triage } from "./tt73-triage.mts";
import { readWord, writeWord, blankWord, allParas, paraText, type WordDoc } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { addHfPicture, hfLines, setHf } from "../src/lib/office/hdrftr.ts";
import { readPptxDoc, writePptxDoc, blankPptx, addShape, addPicture, setNotesText, duplicateSlide, addSlideFromLayout, layoutsOf } from "../src/lib/office/pml.ts";
import { openZip as openZip0, writeZip } from "../src/lib/office/zipkit.ts";

const { test, finish } = makeHarness("tt73-office");
/** every entry of a zip as a Map (name → bytes) */
const openZip = async (b: Uint8Array) => { const z = openZip0(b); const m = new Map<string, Uint8Array>(); for (const e of z.entries) { const d = await z.read(e.name); if (d) m.set(e.name, d); } return m; };
const ONLY = process.env.TT73_ONLY;
const want = (id: string) => !ONLY || ONLY.split(/[ ,]+/).includes(id);
const PY = "/home/user/tools/venv/bin/python";
const XLSX = "/home/user/tools/corpus/xlsx", DOCX = "/home/user/tools/corpus/docx", PPTX = "/home/user/tools/corpus/pptx";
const tmp = mkdtempSync(join(tmpdir(), "tt73o-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const SHEET = { "FF-19": "full", "FF-21": "full" } as const;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
// a 2×2 PNG (red / green / blue / white), byte by byte so the test needs no image library
const PNG = new Uint8Array(Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73000000164944415478da63f8cfc0f01f0418fe830003030300003c0a05fb3e6e0f8f0000000049454e44ae426082", "hex"));
type XsdRes = { parts: Record<string, string[]>; ok: boolean };
const xsd = (files: string[]): Record<string, XsdRes> => {
  const out: Record<string, XsdRes> = {};
  for (let i = 0; i < files.length; i += 30) Object.assign(out, JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", ...files.slice(i, i + 30)], { encoding: "utf8", maxBuffer: 256 << 20 })));
  return out;
};
const norm = (e: string) => e.replace(/^line \d+: /, "");
/** schema errors in `o` that the input `i` did not already have (per part; a part new in the output is compared with every input error) */
const newErrors = (r: Record<string, XsdRes>, i: string, o: string) => {
  const all = new Set(Object.values(r[i].parts).flat().map(norm)); const out: string[] = [];
  for (const [part, es] of Object.entries(r[o].parts)) { const before = r[i].parts[part] ? new Set(r[i].parts[part].map(norm)) : all; for (const e of es) if (!before.has(norm(e))) out.push(`${part}: ${e}`); }
  return out;
};
const val = (wb: Workbook, sheet: string, a1: string) => { const m = /^([A-Z]+)(\d+)$/.exec(a1)!; let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return wb.valueAt(sheet, c - 1, Number(m[2]) - 1); };

/* ------------------------------------------------------------------ spreadsheet */
if (want("S1")) await test("S1 TEXT: all 806 Excel-cached TEXT() results in the corpus agree (number formats, dates, 1904 workbooks, booleans, sections)", SHEET, () => {
  const rows = JSON.parse(readFileSync("docs/heldout/tt73-text-oracle.json", "utf8")) as { file: string; ref: string; v: unknown; fmt: string; xl: string; d1904?: boolean }[];
  const conv = (v: unknown) => (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : v);
  const bad: string[] = [];
  for (const r of rows) { setDate1904(!!r.d1904); try { const us = formatValue(conv(r.v) as number, r.fmt).text; if (us !== r.xl) bad.push(`${r.file} ${r.ref} ${JSON.stringify(r.fmt)} ${JSON.stringify(r.v)}: Excel ${JSON.stringify(r.xl)} us ${JSON.stringify(us)}`); } finally { setDate1904(false); } }
  console.log(`    TEXT ${rows.length - bad.length}/${rows.length}`);
  ok(rows.length >= 800 && !bad.length, `${bad.length} disagree:\n${bad.slice(0, 6).join("\n")}`);
});
if (want("S2")) await test("S2 number formats vs Apache POI TestDataFormatter dfUS assertions (Excel behaviour; POI-only deviations listed in DESIGN-TT73): ≥ 163 of 189 agree (TT72: 120)", SHEET, () => {
  const rows = JSON.parse(readFileSync("docs/heldout/tt73-poi-dataformatter.json", "utf8")) as { v: number; fmt: string; xl: string }[];
  const agree = rows.filter((r) => formatValue(r.v, r.fmt).text === r.xl).length;
  console.log(`    POI dfUS ${agree}/${rows.length}`);
  ok(rows.length === 189 && agree >= 163, `${agree}/${rows.length}`);
});
if (want("S3")) await test("S3 external workbook links resolve from the cached externalLink parts: [1]Sheet!A1, [1]!Name, sheet-scoped [1]Sheet!Name, [0]!Name; a missing book is #REF!", SHEET, () => {
  const wb = readXlsxWorkbook(readFileSync(join(XLSX, "ref2-56737.xlsx")));
  ok(wb.externals.length >= 1, "no external books read");
  const e3 = val(wb, "Refs", "E3"), g3 = val(wb, "Refs", "G3"), i3 = val(wb, "Refs", "I3");
  ok(e3 === "Hello!" && g3 === "Test A1" && i3 === 142, `ref2-56737 E3=${JSON.stringify(e3)} G3=${JSON.stringify(g3)} I3=${JSON.stringify(i3)}`);
  const w2 = readXlsxWorkbook(readFileSync(join(XLSX, "56737.xlsx")));
  const d3 = val(w2, "Uses", "D3"), c5 = val(w2, "Uses", "C5");
  ok(d3 === 142 && c5 === -1, `56737 D3=${JSON.stringify(d3)} C5=${JSON.stringify(c5)}`);
  const w3 = readXlsxWorkbook(readFileSync(join(XLSX, "bug67784.xlsx")));
  ok(val(w3, "Sheet1", "A6") === 0, `bug67784 A6=${JSON.stringify(val(w3, "Sheet1", "A6"))}`);
  const w4 = new Workbook(); w4.sheets.get("Sheet1")!.setCell(0, 0, "=[7]Data!A1"); w4.recalculate();
  ok(JSON.stringify(w4.valueAt("Sheet1", 0, 0)) === JSON.stringify({ error: "#REF!" }), `missing book ${JSON.stringify(w4.valueAt("Sheet1", 0, 0))}`);
});
if (want("S4")) await test("S4 Unicode names: Лист2!A1 and 'Лист2'!A1, SUM(Лист2!A1:A3), a defined name Налог, and the Russian corpus workbook's SUBTOTAL(109,Таблица1[[Sum for Q1 ]]) = Excel's cached 19239.04 (TT72: #NAME?, lexer refused 'Т')", SHEET, () => {
  const wb = new Workbook(); wb.addSheet("Лист2");
  wb.sheets.get("Лист2")!.setCell(0, 0, "5"); wb.sheets.get("Лист2")!.setCell(0, 1, "7");
  const s = wb.sheets.get("Sheet1")!;
  s.setCell(0, 0, "=Лист2!A1*2"); s.setCell(0, 1, "=SUM(Лист2!A1:A3)"); s.setCell(0, 2, "=Лист2!A1+'Лист2'!A2");
  const err = wb.defineName("Налог", "=Лист2!$A$2"); ok(!err, `defineName: ${String(err)}`);
  s.setCell(0, 3, "=Налог*10"); s.setCell(0, 4, "=ΑΒΓ");
  wb.recalculate();
  const got = [0, 1, 2, 3, 4].map((r) => JSON.stringify(wb.valueAt("Sheet1", 0, r))).join(" ");
  ok(got === `10 12 12 70 {"error":"#NAME?"}`, got);
  const ru = readXlsxWorkbook(readFileSync(join(XLSX, "LIBRE_OFFICE-128382-0.xlsx")));
  const b13 = ru.valueAt("Basic features", 1, 12), e13 = ru.valueAt("Basic features", 4, 12);
  ok(typeof b13 === "number" && Math.abs(b13 - 19239.04) < 1e-6 && typeof e13 === "number" && Math.abs(e13 - 27527.01) < 1e-6, `B13=${JSON.stringify(b13)} E13=${JSON.stringify(e13)}`);
});
if (want("S5")) await test("S5 Excel numeric-argument rules: refs count numbers only, literal text → #VALUE!, TRUE literal → 1, MODE with no repeat → #N/A, PRODUCT of no numbers → 0, ROUND digits truncate, TEXT(TRUE) without a 4th section", SHEET, () => {
  const wb = new Workbook(); const s = wb.sheets.get("Sheet1")!;
  s.setCell(0, 0, "1"); s.setCell(0, 1, "x"); s.setCell(0, 2, "3"); s.setCell(0, 3, "TRUE");
  const cases: [string, string][] = [
    ["=STDEV(A1:A4)", "1.4142135623731"], ["=STDEV(1,3,\"x\")", '{"error":"#VALUE!"}'], ["=STDEV(1,3,TRUE)", "1.1547005383793"], ["=MODE(1,2,3)", '{"error":"#N/A"}'],
    ["=MODE(1,1,\"2\")", '{"error":"#VALUE!"}'], ["=PRODUCT(A2)", "0"], ["=ROUND(2.567,1.9)", "2.6"], ["=TEXT(TRUE,\"0\")", '"TRUE"'], ["=MEDIAN(A1:A4)", "2"],
  ];
  cases.forEach(([f], i) => s.setCell(1, i, f)); wb.recalculate();
  const bad = cases.map(([f, w], i) => { const v = wb.valueAt("Sheet1", 1, i); const g = typeof v === "number" ? String(Number(v.toPrecision(14))) : JSON.stringify(v); return g === w ? "" : `${f}: ${g} (Excel ${w})`; }).filter(Boolean);
  ok(!bad.length, bad.join("; "));
});
if (want("C1")) await test("C1 FF-29 chart gate: every corpus chart series evaluates to Excel's own c:numCache / c:strCache — values (blank where Excel cached no point), categories / scatter x values and cached series names (lxml oracle)", { "FF-29": "full" }, () => {
  const files = readdirSync(XLSX).filter((f) => /\.xlsx$/i.test(f)).map((f) => join(XLSX, f));
  const r = chartCache(files);
  console.log(`    ${r.matched}/${r.charts} charts, ${r.series} series: values ${r.agreePts}/${r.points}, categories ${r.agreeCats}/${r.cats}, names ${r.agreeNames}/${r.names}`);
  ok(r.charts >= 36 && r.matched === r.charts && r.points >= 1800 && r.agreePts === r.points && r.agreeCats === r.cats && r.agreeNames === r.names, r.bad.slice(0, 8).join("\n"));
});
if (want("H1")) await test("H1 held-out formula probe: ≥ 26,869 of 26,946 Excel-cached formula cells agree after recalculation (TT72 baseline 26,295)", { "FF-52": "full", ...SHEET }, () => {
  const files = readdirSync(XLSX).filter((f) => /\.xlsx$/i.test(f)).map((f) => join(XLSX, f));
  const r = triage(files);
  console.log(`    ${r.agree}/${r.cells} agree (${r.bad.length} disagree)`);
  ok(r.cells >= 26900 && r.agree >= 26869, `${r.agree}/${r.cells}`);
});

/* ------------------------------------------------------------------ writer */
const pyDocx = (file: string, needle: string) => JSON.parse(execFileSync(PY, ["-c", `import docx,sys,json,hashlib
from docx.oxml.ns import qn
d=docx.Document(sys.argv[1]); body="".join(t.text or "" for t in d.element.body.iter(qn("w:t")))
hdr=[]
for s in d.sections:
    for h in (s.header, s.first_page_header):
        if h.is_linked_to_previous: continue
        for r in h.part.rels.values():
            if r.reltype.endswith("/image") and not r.is_external: hdr.append(hashlib.sha256(r.target_part.blob).hexdigest())
print(json.dumps({"found": sys.argv[2] in body, "hdr": hdr}))`, file, needle], { encoding: "utf8" }));
const zipText = async (b: Uint8Array, p: string) => { const z = await openZip(b); const e = z.get(p); return e ? new TextDecoder().decode(e) : undefined; };

if (want("W1")) await test("W1 header / footer picture: relationship in THAT part's .rels (not document.xml.rels), python-docx finds the image bytes, schema-valid, re-read shows it; Track Changes wraps it in w:ins; an existing header without xmlns:r on its root still gets a declared r:embed", { "FF-22": "full" }, async () => {
  const d = await readWord(await writeWord(await blankWord("w1")));
  setHf(d, "header", "default", [{ text: "Fusion Letterhead", align: "center" }]);
  addHfPicture(d, "header", "default", PNG, "image/png", 120, 40, "Logo", "right");
  addHfPicture(d, "footer", "default", PNG, "image/png", 30, 30, "Seal");
  // in session (before any save): the page view draws header tokens from doc.parts — the picture must carry its bytes
  const live = [...d.parts.values()].flat().flatMap((b) => (b.t === "p" ? b.content : [])).filter((it) => it.t === "k" && it.kind === "image");
  ok(live.length === 2 && live.every((it) => it.t === "k" && !!it.img && sha(it.img.data) === sha(PNG)), `in-session header / footer pictures ${live.length}, bytes ${live.map((it) => it.t === "k" && !!it.img?.data).join(",")}`);
  const out = await writeWord(d); const f = join(tmp, "w1.docx"); writeFileSync(f, out);
  const docRels = (await zipText(out, "word/_rels/document.xml.rels"))!;
  ok(!/relationships\/image"/.test(docRels), "an image relationship landed in document.xml.rels");
  const z = await openZip(out); const hdrPart = [...z.keys()].find((k) => /^word\/header\d+\.xml$/.test(k))!; const ftrPart = [...z.keys()].find((k) => /^word\/footer\d+\.xml$/.test(k))!;
  for (const part of [hdrPart, ftrPart]) {
    const xml = (await zipText(out, part))!; const rels = (await zipText(out, part.replace("word/", "word/_rels/") + ".rels"))!;
    const rid = /r:embed="([^"]+)"/.exec(xml)?.[1]; ok(rid && new RegExp(`Id="${rid}"[^>]*relationships/image|relationships/image"[^>]*Id="${rid}"`).test(rels), `${part}: r:embed ${rid} not in its own rels`);
  }
  const py = pyDocx(f, "zzz"); ok(py.hdr.length === 1 && py.hdr[0] === sha(PNG), `python-docx header images ${JSON.stringify(py.hdr)}`);
  const r = xsd([f]); ok(r[f].ok, `schema: ${JSON.stringify(Object.entries(r[f].parts).filter(([, e]) => e.length)).slice(0, 400)}`);
  const back = await readWord(out); const lines = hfLines(back, "header", "default");
  ok(lines.length === 2 && lines[0].text === "Fusion Letterhead" && lines[1].locked && lines[1].label === "picture", `re-read lines ${JSON.stringify(lines)}`);
  const img = [...back.parts.values()].flat().flatMap((b) => (b.t === "p" ? b.content : [])).find((it) => it.t === "k" && it.kind === "image");
  ok(img && img.t === "k" && img.img && sha(img.img.data) === sha(PNG), "re-read header picture lost its bytes");
  // Track Changes on: the picture paragraph is a tracked insertion
  const t = await readWord(out); t.track.on = true; addHfPicture(t, "header", "default", PNG, "image/png", 20, 20, "Tracked");
  const tx = (await zipText(await writeWord(t), hdrPart))!; ok(/<w:ins [^>]*>(?:(?!<\/w:ins>).)*<w:drawing>/.test(tx), "tracked picture is not inside w:ins");
  // an existing header part whose root does not declare xmlns:r (synthesised: the corpus has none) — r:embed must still be declared
  const plain = await blankWord("w1b"); setHf(plain, "header", "default", [{ text: "Plain header" }]);
  const pz = await openZip(await writeWord(plain)); const hp0 = [...pz.keys()].find((k) => /^word\/header\d+\.xml$/.test(k))!;
  pz.set(hp0, new TextEncoder().encode(new TextDecoder().decode(pz.get(hp0)!).replace(/ xmlns:r="[^"]*"/, "")));
  const stripped = await writeZip([...pz].map(([n, data]) => ({ name: n, data })));
  ok(!/<w:hdr[^>]*xmlns:r=/.test(new TextDecoder().decode((await openZip(stripped)).get(hp0)!)), "xmlns:r not stripped");
  const sd = await readWord(stripped); addHfPicture(sd, "header", "default", PNG, "image/png", 20, 20, "x");
  const fs0 = join(tmp, "w1-stripped-in.docx"), fs1 = join(tmp, "w1-stripped.docx"); writeFileSync(fs0, stripped); writeFileSync(fs1, await writeWord(sd));
  const rs = xsd([fs0, fs1]); ok(rs[fs1].ok, `stripped-root header: ${JSON.stringify(Object.entries(rs[fs1].parts).filter(([, e]) => e.length)).slice(0, 300)}`);
  ok(pyDocx(fs1, "Plain").hdr.includes(sha(PNG)), "python-docx misses the picture in the stripped-root header");
  // real corpus headers (their own rels, styles and namespaces) take a picture without new schema errors
  let tried = 0;
  for (const name of readdirSync(DOCX).filter((x) => x.endsWith(".docx")).sort()) {
    const b = new Uint8Array(readFileSync(join(DOCX, name)));
    const wd = await readWord(b).catch(() => null); if (!wd || !hfLines(wd, "header", "default").length) continue;
    addHfPicture(wd, "header", "default", PNG, "image/png", 20, 20, "x");
    const o = join(tmp, `w1-${name}`); writeFileSync(o, await writeWord(wd));
    const rr = xsd([join(DOCX, name), o]); const ne = newErrors(rr, join(DOCX, name), o); ok(!ne.length, `${name}: ${ne.slice(0, 3).join(" | ")}`);
    ok(pyDocx(o, "zzz").hdr.includes(sha(PNG)), `${name}: python-docx misses the header picture`);
    tried++; if (tried >= 3) break;
  }
  console.log(`    stripped-root header OK; ${tried} corpus documents with an existing header took a picture cleanly`);
  ok(tried >= 3, `only ${tried} corpus documents with a header`);
});

if (want("W2")) await test("W2 FF-22 Writer gate: EVERY readable corpus docx — text typed into the first body paragraph AND a picture added to its header — saves with no schema error the input lacked; python-docx opens every one and sees the typed text and the header picture; our reader re-reads both", { "FF-22": "full" }, async () => {
  const files = readdirSync(DOCX).filter((f) => f.endsWith(".docx")).sort();
  const pairs: [string, string, string][] = []; const unreadable: string[] = []; const reread: string[] = [];
  for (const f of files) {
    let d: WordDoc;
    try { d = await readWord(new Uint8Array(readFileSync(join(DOCX, f)))); } catch { unreadable.push(f); continue; }
    const p = allParas(d.blocks)[0]; if (!p) continue;
    const needle = `TT73 edit ${pairs.length}`;
    E.insertText(d, { pid: p.id, off: 0 }, needle + " ");
    addHfPicture(d, "header", "default", PNG, "image/png", 40, 40, "Logo");
    const out = await writeWord(d); const o = join(tmp, `w2-${pairs.length}.docx`); writeFileSync(o, out);
    pairs.push([join(DOCX, f), o, needle]);
    const back = await readWord(out);
    const hasText = allParas(back.blocks).some((q) => paraText(q).includes(needle));
    const hasPic = [...back.parts.values()].flat().some((b) => b.t === "p" && b.content.some((it) => it.t === "k" && it.kind === "image" && !!it.img && sha(it.img.data) === sha(PNG)));
    if (!hasText || !hasPic) reread.push(`${f}: text ${hasText} picture ${hasPic}`);
  }
  ok(pairs.length >= 100, `edited ${pairs.length}`);
  const r = xsd(pairs.flatMap(([i, o]) => [i, o]));
  const schema: string[] = []; const py: string[] = []; let inputsInvalid = 0;
  for (const [i, o, needle] of pairs) {
    if (!r[i].ok) inputsInvalid++;
    for (const e of newErrors(r, i, o)) schema.push(`${i.split("/").pop()} ${e}`);
    try { const j = pyDocx(o, needle); if (!j.found || !j.hdr.includes(sha(PNG))) py.push(`${i.split("/").pop()}: found ${j.found} header images ${j.hdr.length}`); } catch (e) { py.push(`${i.split("/").pop()}: python-docx ${(e as Error).message.split("\n").slice(-2).join(" ")}`); }
  }
  console.log(`    ${pairs.length} documents edited + saved (${unreadable.length} refused as damaged: ${unreadable.join(", ")}); ${inputsInvalid} inputs already schema-invalid; new schema errors ${schema.length}; python-docx misses ${py.length}; re-read misses ${reread.length}`);
  ok(!schema.length && !py.length && !reread.length, [...schema.slice(0, 5), ...py.slice(0, 5), ...reread.slice(0, 5)].join("\n"));
});

if (want("N1")) await test("N1 negative shapes (19): header-picture inputs (SVG / WebP / empty / text MIME refused; 0, negative, NaN, ∞ sizes clamped; markup and 10 000-character descriptions sanitised), external refs (missing book, missing sheet, missing name, a string literal that looks like a ref) and Unicode names (× ÷ 😀 unquoted, a name starting with an Arabic-Indic digit, A1 / R1C1 lookalikes)", { "FF-22": "full", ...SHEET }, async () => {
  const d = await readWord(await writeWord(await blankWord("n1")));
  let refused = 0;
  for (const mime of ["image/svg+xml", "image/webp", "", "text/plain"]) { try { addHfPicture(d, "header", "default", PNG, mime, 10, 10); } catch { refused++; } }
  ok(refused === 4, `refused ${refused}/4 bad MIME types`);
  for (const [w, h] of [[0, 0], [-5, 7], [NaN, 10], [Infinity, -Infinity]]) addHfPicture(d, "header", "default", PNG, "image/png", w, h, "<b>&\"x\"</b>" + "y".repeat(10000));
  addHfPicture(d, "footer", "default", PNG, "image/png", 10, 10, "");
  const out = await writeWord(d); const f = join(tmp, "n1.docx"); writeFileSync(f, out);
  const z = await openZip(out); const hx = new TextDecoder().decode(z.get([...z.keys()].find((k) => /^word\/header\d+\.xml$/.test(k))!)!);
  const ext = [...hx.matchAll(/<wp:extent cx="([^"]+)" cy="([^"]+)"/g)].map((m) => [Number(m[1]), Number(m[2])]);
  ok(ext.length === 4 && ext.every(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a >= 9525 && b >= 9525 && a <= 2000 * 9525), `extents ${JSON.stringify(ext)}`);
  const descrs = [...hx.matchAll(/descr="([^"]*)"/g)].map((m) => m[1]); ok(descrs.length === 4 && descrs.every((x) => !/[<>&]/.test(x) && x.length <= 120), `descr ${descrs[0]?.slice(0, 40)}`);
  ok(/descr="Picture"/.test(new TextDecoder().decode(z.get([...z.keys()].find((k) => /^word\/footer\d+\.xml$/.test(k))!)!)), "empty descr not defaulted");
  const r = xsd([f]); ok(r[f].ok, `schema ${JSON.stringify(Object.entries(r[f].parts).filter(([, e]) => e.length)).slice(0, 300)}`);
  // external references
  const wb = readXlsxWorkbook(readFileSync(join(XLSX, "ref2-56737.xlsx"))); const s = wb.sheets.get("Refs")!;
  const cases: [string, string][] = [["=[99]Data!A1", "#REF!"], ["=[1]NoSuchSheet!A1", "#REF!"], ["=[0]!NoSuchName", "#NAME?"], ["=\"[1]Sheet!A1\"", "[1]Sheet!A1"]];
  cases.forEach(([fm], i) => s.setCell(20, 30 + i, fm)); wb.recalculate();
  const got = cases.map(([fm, w], i) => { const v = wb.valueAt("Refs", 20, 30 + i); const g = typeof v === "object" && v && "error" in v ? (v as { error: string }).error : String(v); return g === w ? "" : `${fm}: ${g} (want ${w})`; }).filter(Boolean);
  ok(!got.length, got.join("; "));
  // Unicode identifiers that Excel does not accept unquoted / as names
  const u = new Workbook(); const us = u.sheets.get("Sheet1")!;
  ["=×Sheet!A1", "=÷1", "=😀!A1"].forEach((fm, i) => us.setCell(0, i, fm)); u.recalculate();
  const bad = [0, 1, 2].map((i) => u.valueAt("Sheet1", 0, i)).filter((v) => !(typeof v === "object" && v && "error" in v));
  ok(!bad.length, `accepted as references: ${JSON.stringify(bad)}`);
  let nameRefused = 0; for (const n of ["\u0663abc", "A1", "R1C1", "Лист 1"]) { try { u.defineName(n, "=1"); } catch { nameRefused++; } }
  ok(nameRefused === 4, `refused ${nameRefused}/4 invalid names`);
});

/* ------------------------------------------------------------------ slides */
if (want("P1")) await test("P1 the PresentationML schema oracle is a real verifier: a fresh deck validates; a slide with an unknown p: element or with p:clrMapOvr before p:cSld is rejected", { "FF-23": "full" }, async () => {
  const base = await blankPptx("p1"); const fb = join(tmp, "p1.pptx"); writeFileSync(fb, base);
  const d = await readPptxDoc(base, "p1.pptx"); const lay = layoutsOf(d)[0]; addSlideFromLayout(d, 0, lay.path);
  const withSlide = await writePptxDoc(d); const fs = join(tmp, "p1s.pptx"); writeFileSync(fs, withSlide);
  const z = await openZip(withSlide); const sp = [...z.keys()].find((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k))!; const sx = new TextDecoder().decode(z.get(sp)!);
  const mut = async (name: string, s: string) => { const m = new Map(z); m.set(sp, new TextEncoder().encode(s)); const f = join(tmp, name); writeFileSync(f, await writeZip([...m].map(([n, data]) => ({ name: n, data })))); return f; };
  const unknown = await mut("p1u.pptx", sx.replace("</p:spTree>", "<p:bogus/></p:spTree>"));
  const order = await mut("p1o.pptx", sx.replace(/<p:cSld\b/, '<p:clrMapOvr><a:masterClrMapping xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/></p:clrMapOvr><p:cSld').replace(/<p:clrMapOvr>(?:(?!<\/p:clrMapOvr>).)*<\/p:clrMapOvr>(?=\s*<\/p:sld>)/, ""));
  const r = xsd([fb, fs, unknown, order]);
  ok(r[fb].ok && r[fs].ok, `fresh deck: ${JSON.stringify(r[fs].parts[sp])}`);
  ok((r[unknown].parts[sp] ?? []).length > 0, "unknown element accepted");
  ok((r[order].parts[sp] ?? []).length > 0, "wrong child order accepted");
});
const pyPptx = (file: string) => JSON.parse(execFileSync(PY, ["-c", `import pptx,sys,json
p=pptx.Presentation(sys.argv[1]); out=[]
for s in p.slides:
    t=[sh.text_frame.text for sh in s.shapes if sh.has_text_frame]
    n=s.notes_slide.notes_text_frame.text if s.has_notes_slide and s.notes_slide.notes_text_frame is not None else ""
    out.append({"t": t, "n": n, "pics": sum(1 for sh in s.shapes if sh.shape_type == 13)})
print(json.dumps(out))`, file], { encoding: "utf8", maxBuffer: 64 << 20 }));
if (want("P2")) await test("P2 FF-23 Slides gate: EVERY openable corpus deck — text box + preset shape + picture, speaker notes, a duplicated slide and a slide from a layout — saves with no schema error the input lacked (ECMA-376 pml.xsd via lxml) and python-pptx sees every edit", { "FF-23": "full" }, async () => {
  const BAD = /^(clusterfuzz-|crash-|Divino_Revelado)/;
  const files = readdirSync(PPTX).filter((f) => f.endsWith(".pptx") && !BAD.test(f)).sort();
  const pairs: [string, string, number][] = []; const refused: string[] = [];
  for (const f of files) {
    let d;
    try { d = await readPptxDoc(new Uint8Array(readFileSync(join(PPTX, f))), f); } catch { refused.push(f); continue; }
    if (!d.slides.length) continue;
    addShape(d, 0, "textbox", { x: 457200, y: 457200, cx: 3e6, cy: 5e5 }, `TT73 box ${pairs.length}`);
    addShape(d, 0, "star5", { x: 1e6, y: 1e6, cx: 1e6, cy: 1e6 });
    addPicture(d, 0, PNG, "png", { x: 2e6, y: 2e6, cx: 5e5, cy: 5e5 });
    setNotesText(d, 0, `TT73 notes ${pairs.length}`);
    duplicateSlide(d, 0);
    const lay = layoutsOf(d)[0]; if (lay) addSlideFromLayout(d, d.slides.length, lay.path);
    const o = join(tmp, `p2-${pairs.length}.pptx`); writeFileSync(o, await writePptxDoc(d));
    pairs.push([join(PPTX, f), o, pairs.length]);
  }
  ok(pairs.length >= 80, `edited ${pairs.length} decks (refused ${refused.join(", ")})`);
  const r = xsd(pairs.flatMap(([i, o]) => [i, o]));
  const schema: string[] = []; const py: string[] = []; let inputsInvalid = 0;
  for (const [i, o, k] of pairs) {
    if (!r[i].ok) inputsInvalid++;
    for (const e of newErrors(r, i, o)) schema.push(`${i.split("/").pop()} ${e}`);
    try {
      const s = pyPptx(o) as { t: string[]; n: string; pics: number }[];
      const first = s[0], dup = s[1];
      if (!first?.t.includes(`TT73 box ${k}`) || first.n !== `TT73 notes ${k}` || first.pics < 1 || !dup?.t.includes(`TT73 box ${k}`)) py.push(`${i.split("/").pop()}: ${JSON.stringify({ t: first?.t.slice(-2), n: first?.n, pics: first?.pics, dup: dup?.t.slice(-1) })}`);
    } catch (e) { py.push(`${i.split("/").pop()}: python-pptx ${(e as Error).message.split("\n").slice(-2).join(" ")}`); }
  }
  console.log(`    ${pairs.length} decks edited + saved (${refused.length} refused); ${inputsInvalid} inputs already schema-invalid; new schema errors ${schema.length}; python-pptx misses ${py.length}`);
  ok(!schema.length && !py.length, [...schema.slice(0, 6), ...py.slice(0, 6)].join("\n"));
});

ok(existsSync(PY), "venv python missing");
await finish();
