import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { Workbook } from "../src/lib/formula/engine.ts";
import { writeXlsxWorkbook, readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import * as M from "../src/lib/office/pml.ts";
import { findSlideText, replaceSlideText } from "../src/lib/office/pmlsearch.ts";
import { findAll, kid, setAttr, serializeXml, textOf } from "../src/lib/office/xmltree.ts";
import { signatureRectAt, signaturePageSize } from "../src/lib/pdf/sigplacement.ts";
import { PdfDoc } from "../src/lib/pdf/pdfdoc.ts";
import { makeSelfSignedIdentity, signPdf, validateSignatures } from "../src/lib/pdf/pdfsig.ts";
import { mkpdf } from "./tt52/mkpdf.ts";
const { test, finish } = makeHarness("tt81-core");
const PY = process.env.ORACLE_PY ?? "/home/user/runtime/venv/bin/python";
const dir = mkdtempSync(join(tmpdir(), "tt81-"));
const ok = (c: unknown, msg: string) => { if (!c) throw new Error(msg); };
const eq = (a: unknown, b: unknown) => ok(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const refuses = (fn: () => unknown) => { let threw = false; try { fn(); } catch { threw = true; } ok(threw, "must refuse"); };
const value = (wb: Workbook, c: number, r: number): unknown => { const v = wb.valueAt(wb.sheet().name, c, r); return v && typeof v === "object" && "error" in v ? v.error : v; };
const sheetCov = { "FF-78": "full" as const };
const slideCov = { "FF-80": "partial" as const };
const pdfCov = { "FF-79": "partial" as const };

await test("S1 MODE/SNGL scalar reference vs range, errors, ties and no duplicates", sheetCov, () => {
  const wb = new Workbook(), sh = wb.sheet();
  ["text", "2", "2", "3", "3", "TRUE", "=1/0"].forEach((v, r) => sh.setCell(0, r, v));
  const cases: [string, unknown][] = [
    ["=MODE(A1,2,2)", "#VALUE!"], ["=MODE(A1:A3)", 2], ["=MODE(1,2,3)", "#N/A"],
    ["=MODE.SNGL(1,2,3)", "#N/A"], ["=MODE(A2,A3)", 2], ["=MODE(TRUE,1,1)", "#VALUE!"],
    ['=MODE("2",2,2)', "#VALUE!"], ["=MODE(A6,2,2)", "#VALUE!"], ["=MODE(A8,2,2)", "#VALUE!"],
    ["=MODE(A1:A7)", "#DIV/0!"], ["=MODE({3,2,3,2})", 3], ["=MODE.SNGL(A1:A5)", 2],
    ["=MODE.MULT(1,2,3)", "#N/A"], ["=MODE.MULT(A1,2,2)", "#VALUE!"], ["=MODE.MULT({2,2;3,3})", 2],
  ];
  cases.forEach(([f], r) => sh.setCell(3, r, f)); wb.recalculate();
  cases.forEach(([f, v], r) => { try { eq(value(wb, 3, r), v); } catch (e) { throw new Error(`${f}: ${(e as Error).message}`); } });
});
await test("S2 MODE.MULT vertical spill, collision, clear/recalculate, xlsx round-trip and independent openpyxl formula", sheetCov, () => {
  const wb = new Workbook(), sh = wb.sheet(); sh.setCell(0, 0, "=MODE.MULT({3,2,3,2,4})"); wb.recalculate();
  eq([value(wb, 0, 0), value(wb, 0, 1)], [3, 2]);
  sh.setCell(1, 0, "=MODE.MULT({3,2,3,2})"); sh.setCell(1, 1, "occupied"); wb.recalculate(); eq(value(wb, 1, 0), "#SPILL!");
  sh.setCell(1, 1, ""); wb.recalculate(); eq([value(wb, 1, 0), value(wb, 1, 1)], [3, 2]);
  const bytes = writeXlsxWorkbook(wb); writeFileSync(join(dir, "mode.xlsx"), bytes);
  const out = execFileSync(PY, ["-c", "import openpyxl,sys,json; w=openpyxl.load_workbook(sys.argv[1]); c=w.active['A1']; print(json.dumps(getattr(c.value,'text',c.value)))", join(dir, "mode.xlsx")], { encoding: "utf8" });
  ok(out.includes("MODE.MULT"), `openpyxl lost formula: ${out}`);
  const reread = readXlsxWorkbook(bytes); eq([value(reread, 0, 0), value(reread, 0, 1)], [3, 2]);
});
await test("S3 deterministic independent frequency-map oracle on 240 integer vectors", sheetCov, () => {
  let seed = 81;
  for (let k = 0; k < 240; k++) {
    const xs = Array.from({ length: 3 + k % 40 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % 11 - 5; });
    // Brute-force counting is deliberately different from production's Map accumulator.
    const counts = xs.map((v) => xs.filter((x) => x === v).length), max = Math.max(...counts);
    const expected = [...new Set(xs.filter((_, i) => counts[i] === max))];
    const wb = new Workbook(); wb.sheet().setCell(0, 0, `=MODE.MULT({${xs.join(",")}})`); wb.recalculate();
    if (max === 1) eq(value(wb, 0, 0), "#N/A"); else eq(expected.map((_, i) => value(wb, 0, i)), expected);
  }
});

await test("S4 all 17 legacy MODE cells agree with Excel cached results in the Apache POI fixture (includes M936)", sheetCov, () => {
  const file = "scripts/fixtures/tt81/poi-formulas.xlsx";
  const expected: [string, string, unknown][] = JSON.parse(execFileSync(PY, ["-c", `
import openpyxl,sys,json
w=openpyxl.load_workbook(sys.argv[1]); v=openpyxl.load_workbook(sys.argv[1],data_only=True)
print(json.dumps([(s.title,c.coordinate,v[s.title][c.coordinate].value) for s in w for row in s for c in row if c.data_type=='f' and c.value.startswith('=MODE(')]))
`, file], { encoding: "utf8" }));
  eq(expected.length, 17); const wb = readXlsxWorkbook(readFileSync(file));
  for (const [sheet, ref, want] of expected) {
    const m = /^([A-Z]+)([0-9]+)$/.exec(ref)!; const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const v = wb.valueAt(sheet, c, Number(m[2]) - 1); eq(v && typeof v === "object" && "error" in v ? v.error : v, want);
  }
});

const fixture = join(dir, "source.pptx");
execFileSync(PY, ["-c", `
from pptx import Presentation
from pptx.util import Inches
from pptx.dml.color import RGBColor
import sys
p=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); tf=s.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(2)).text_frame
r=tf.paragraphs[0].add_run(); r.text='Need'; r.font.bold=True; r.font.color.rgb=RGBColor(255,0,0)
r=tf.paragraphs[0].add_run(); r.text='le Needle [x]'; r.font.italic=True
q=tf.add_paragraph(); q.text='other paragraph'
t=s.shapes.add_table(1,1,0,0, Inches(2), Inches(1)).table; t.cell(0,0).text='Needle table'
g=s.shapes.add_group_shape(); g.shapes.add_textbox(0,0, Inches(2), Inches(1)).text='Needle group'
s.notes_slide.notes_text_frame.text='Needle notes'
s2=p.slides.add_slide(p.slide_layouts[6]); s2.shapes.add_textbox(0,0, Inches(2), Inches(1)).text='NEEDLE second'
p.save(sys.argv[1])
`, fixture]);
await test("L1 literal case/scope, groups and tables; no notes/master/package false hits", slideCov, async () => {
  const d = await M.readPptxDoc(readFileSync(fixture), "source.pptx");
  eq(findSlideText(d, "Needle").length, 5); eq(findSlideText(d, "Needle", { matchCase: true }).length, 4);
  eq(findSlideText(d, "Needle", { slide: 1 }).length, 1); eq(findSlideText(d, "[x]").length, 1);
  eq(findSlideText(d, "").length, 0); eq(findSlideText(d, "notes").length, 0);
  eq(findSlideText(d, "[.*]").length, 0); refuses(() => findSlideText(d, "x", { slide: -1 })); refuses(() => findSlideText(d, "x".repeat(4097)));
  const before = await M.writePptxDoc(d); eq(replaceSlideText(d, "missing", "x"), 0); eq(Buffer.from(await M.writePptxDoc(d)).equals(Buffer.from(before)), true);
});
await test("L2 cross-run replacement keeps first style, independent python-pptx reads tables/groups, untouched parts identical", slideCov, async () => {
  const d = await M.readPptxDoc(readFileSync(fixture), "source.pptx");
  eq(replaceSlideText(d, "Needle", "Thread & <x>"), 5); eq(findSlideText(d, "Needle").length, 0);
  const out = join(dir, "out.pptx"); writeFileSync(out, await M.writePptxDoc(d));
  const report = JSON.parse(execFileSync(PY, ["-c", `
from pptx import Presentation
import zipfile,sys,json
p=Presentation(sys.argv[1]); tf=p.slides[0].shapes[0].text_frame
assert tf.paragraphs[0].runs[0].text=='Thread & <x>'
assert tf.paragraphs[0].runs[0].font.bold and not tf.paragraphs[0].runs[0].font.italic
assert tf.paragraphs[0].runs[1].font.italic
assert p.slides[0].shapes[1].table.cell(0,0).text=='Thread & <x> table'
assert p.slides[0].shapes[2].shapes[0].text=='Thread & <x> group'
assert p.slides[0].notes_slide.notes_text_frame.text=='Needle notes'
a,b=zipfile.ZipFile(sys.argv[2]),zipfile.ZipFile(sys.argv[1]); changed=[n for n in a.namelist() if a.read(n)!=b.read(n)]
# Core properties may update ONLY the existing modified timestamp.
import re
assert re.sub(rb'(<dcterms:modified[^>]*>)[^<]*',rb'\\1',a.read('docProps/core.xml'))==re.sub(rb'(<dcterms:modified[^>]*>)[^<]*',rb'\\1',b.read('docProps/core.xml'))
print(json.dumps(changed))
`, out, fixture], { encoding: "utf8" }));
  eq(report.sort(), ["docProps/core.xml", "ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]);
});
await test("L3 one-step snapshot undo/redo, deletion, repeated replacement, literal dollar and unicode; paragraph boundaries", slideCov, async () => {
  const d = await M.readPptxDoc(await M.blankPptx("aaaa 😀 [x]"), "a.pptx");
  const snap = M.snapshot(d); eq(replaceSlideText(d, "aa", "$&"), 2); eq(findSlideText(d, "$&").length, 2);
  const changed = M.snapshot(d); M.restore(d, snap); eq(findSlideText(d, "aaaa").length, 1); M.restore(d, changed); eq(findSlideText(d, "$&").length, 2);
  eq(replaceSlideText(d, "$&", ""), 2); eq(findSlideText(d, "$&").length, 0);
  eq(replaceSlideText(d, "😀", "🙂"), 1); eq(findSlideText(d, "🙂").length, 1);
  refuses(() => replaceSlideText(d, "x", "line\nbreak")); refuses(() => replaceSlideText(d, "x", "\ud800"));
  const original = await M.readPptxDoc(readFileSync(fixture), "s.pptx"); eq(findSlideText(original, "[x]other").length, 0);
});
await test("L4 hard breaks and dynamic fields block matching, replacement explosion refused before mutation", slideCov, async () => {
  const d = await M.readPptxDoc(await M.blankPptx("ab"), "a.pptx");
  const tx = M.bodyAt(d.slides[0].xml, "0")!; const p = kid(tx, "a:p")!;
  const r = kid(p, "a:r")!; p.kids.push({ ...r, kids: r.kids.map((x) => x.k === "el" && x.name === "a:t" ? { ...x, kids: [{ k: "text" as const, raw: "cd" }] } : x) });
  p.kids.splice(1, 0, { k: "el", name: "a:br", attrs: [], quote: [], kids: [], selfClose: true });
  eq(findSlideText(d, "abcd").length, 0);
  p.kids[1] = { k: "el", name: "a:fld", attrs: [], quote: [], kids: [], selfClose: true }; eq(findSlideText(d, "abcd").length, 0);
  const huge = await M.readPptxDoc(await M.blankPptx("a".repeat(300)), "h.pptx");
  const before = serializeXml(huge.slides[0].xml); refuses(() => replaceSlideText(huge, "a", "b".repeat(65536))); eq(serializeXml(huge.slides[0].xml), before); eq(huge.dirty.size, 0);
});
await test("P1 custom box geometry exact all rotations, negative crop origin and edge boxes", pdfCov, () => {
  const crop = [-10, 20, 590, 820];
  const expected = [[20, 690, 240, 760], [50, 50, 120, 270], [340, 80, 560, 150], [460, 570, 530, 790]];
  [0, 90, 180, 270].forEach((rotate, i) => eq(signatureRectAt({ crop, rotate }, { left: 30, top: 60, width: 220, height: 70 }), expected[i]));
  const page = { crop, rotate: -90 }; eq(signaturePageSize(page), { width: 800, height: 600 }); eq(signatureRectAt(page, { left: 0, top: 0, width: 800, height: 600 }), crop);
});
await test("P2 refuse NaN, infinities, zero, negative, off-page, malformed geometry before signing", pdfCov, () => {
  const page = { crop: [0, 0, 600, 800], rotate: 0 }, b = { left: 10, top: 10, width: 220, height: 70 };
  for (const patch of [{ left: -1 }, { top: NaN }, { width: 0 }, { height: Infinity }, { width: 601 }, { top: 790 }]) refuses(() => signatureRectAt(page, { ...b, ...patch }));
  for (const pg of [{ crop: [0, 0, 0, 3], rotate: 0 }, { crop: [0, 0, 600, 800], rotate: 45 }]) refuses(() => signatureRectAt(pg, b));
});
await test("P3 signed custom boxes: pyHanko intact/valid, pypdf Rect and PDFium visible pixels within displayed box on four rotations", pdfCov, async () => {
  const id = await makeSelfSignedIdentity("TT81 tester", "");
  for (const rotate of [0, 90, 180, 270]) {
    const d = PdfDoc.open(mkpdf([{ text: [], w: 600, h: 800, rotate }]));
    const box = { left: 77, top: 113, width: 220, height: 70 }, rect = signatureRectAt(d.pages()[0], box);
    const signed = await signPdf(d, id, { visible: { page: 0, rect } });
    eq((await validateSignatures(PdfDoc.open(signed)))[0].status, "valid");
    const f = join(dir, `sig${rotate}.pdf`); writeFileSync(f, signed);
    const report = JSON.parse(execFileSync(PY, ["-c", `
import sys,json,asyncio
from pypdf import PdfReader
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
import pypdfium2 as p
r=PdfReader(sys.argv[1]); rect=list(map(float,r.pages[0]['/Annots'][0].get_object()['/Rect']))
with open(sys.argv[1],'rb') as f:
 s=validate_pdf_signature(PdfFileReader(f).embedded_signatures[0]); assert s.intact and s.valid
pdf=p.PdfDocument(sys.argv[1]); pdf.init_forms(); image=pdf[0].render(scale=1,may_draw_forms=True).to_pil().convert('RGB')
pts=[(x,y) for y in range(image.height) for x in range(image.width) if min(image.getpixel((x,y)))<230]
assert pts,'no signature ink'
print(json.dumps({'rect':rect,'ink':[min(x for x,y in pts),min(y for x,y in pts),max(x for x,y in pts),max(y for x,y in pts)]}))
`, f], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
    eq(report.rect, rect); const [l, t, r, b] = report.ink;
    ok(l >= box.left - 1 && t >= box.top - 1 && r <= box.left + box.width + 1 && b <= box.top + box.height + 1, `rotation ${rotate}: ink ${report.ink}`);
  }
});
finish();
