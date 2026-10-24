/**
 * TT52 — first-party PDF engine + editor (FF-03 PDF view/extract, PR-08 PDF viewer, FF-13 thumbnails).
 *
 * External evidence (independent of our code), used when the corpus + venv exist (scripts/corpus/fetch-pdf.py,
 * scripts/sandbox/bootstrap.sh):
 *   1. PDFium (pypdfium2 5.14.0, BSD-3/Apache-2.0 — Chrome's PDF engine) text: bigram-F1 differential over the pdf.js
 *      test corpus (scripts/tt52-textcmp.mts reads /tmp/text.jsonl written by scripts/oracle/pdf_probe.py --text);
 *   2. PDFium + qpdf (pikepdf 10.17.0, MPL-2.0 binding of Apache-2.0 qpdf) re-open every file our editor writes and
 *      check page count/order, rotation, annotation count, title, untouched pages and the append-only prefix
 *      (scripts/oracle/pdf_editcheck.py);
 *   3. PDFium renders (pdf_probe.py --render) for the canvas differential (scripts/tt52-render.mts, browser — run by
 *      the e2e suite's companion command, numbers recorded in docs/DESIGN-TT52.md).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt52-pdf.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeHarness } from "./harness.mts";
import { mkpdf } from "./tt52/mkpdf.ts";
import { PdfDoc, PasswordRequired } from "../src/lib/pdf/pdfdoc.ts";
import { PdfEditor, extractPages, mergeDocuments } from "../src/lib/pdf/pdfedit.ts";
import { pageChars, layout, pageText, search } from "../src/lib/pdf/pdftext.ts";
import { serialize, N, PDict, PStr, Lexer, parseObj, nameText } from "../src/lib/pdf/pdfobj.ts";
import { synthAppearance } from "../src/lib/pdf/pdfappear.ts";
import { loadShading, Interpreter, IDENT, runAnnotations } from "../src/lib/pdf/pdfinterp.ts";
import { helvWidth, wrap } from "../src/lib/pdf/pdftextfit.ts";
import { appForFile } from "../src/lib/open-with.ts";
import { ccittDecode, _codes } from "../src/lib/pdf/pdfccitt.ts";
import { formatFor } from "../src/lib/forge.ts";

const { test: test0, finish } = makeHarness("tt52-pdf");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const CORPUS = "/home/user/tools/corpus/pdf";
const PY = "/home/user/tools/venv/bin/python";
const have = existsSync(CORPUS) && existsSync(PY);
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const COV = { "FF-03": "full", "PR-08": "full" } as const;
const tmp = mkdtempSync(join(tmpdir(), "tt52-"));
const txt = (d: PdfDoc, i: number) => pageText(d, d.pages()[i]).replace(/\s+/g, " ").trim();
const enc = new TextEncoder();
const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, "latin1"));
const PW: Record<string, string> = { "issue6010_1.pdf": "abc", "issue3371.pdf": "ELXRTQWS", "bug1782186.pdf": "Hello", "saslprep-r6.pdf": "SªSL\u00adprep" };

await test("open + text: hand-built PDF, three pages, page text in order", COV, () => {
  const d = PdfDoc.open(mkpdf([{ text: ["Alpha one", "Second line"] }, { text: ["Bravo two"] }, { text: ["Charlie three"], rotate: 90 }]));
  ok(d.pages().length === 3, "page count"); ok(txt(d, 0) === "Alpha one Second line", `p1 text ${txt(d, 0)}`);
  ok(txt(d, 2) === "Charlie three" && d.pages()[2].rotate === 90, "p3 text/rotate");
  const hits = search(layout(pageChars(d, d.pages()[0])), "second", 0); ok(hits.length === 1 && hits[0].rects.length >= 1, "search hit with rects");
});

await test("incremental save keeps the original bytes as an exact prefix; Prev chains to the old xref", COV, () => {
  const src = mkpdf([{ text: ["Keep me"] }, { text: ["Two"] }]); const d = PdfDoc.open(src);
  const ed = new PdfEditor(d); ed.rotate(0, 90); ed.setInfo({ Title: "Rotated" }); const out = ed.save();
  ok(out.length > src.length && Buffer.from(out.subarray(0, src.length)).equals(Buffer.from(src)), "prefix not byte-identical");
  const tail = Buffer.from(out.subarray(src.length)).toString("latin1"); ok(new RegExp(`/Prev ${d.startxref}\\b`).test(tail), "no /Prev to the previous xref");
  const r = PdfDoc.open(out); ok(r.pages()[0].rotate === 90 && r.pages()[1].rotate === 0, "rotation"); ok(r.info().Title === "Rotated", "title"); ok(txt(r, 0) === "Keep me", "text survives");
});

await test("page operations: reorder + delete + insert blank + move, verified by page text", COV, () => {
  const d = PdfDoc.open(mkpdf(["A", "B", "C", "D"].map((t) => ({ text: [`Page ${t}`] }))));
  const ed = new PdfEditor(d); ed.reorder([3, 2, 1, 0]); ed.deletePages([3]); ed.insertBlank(1, 300, 400); ed.movePage(0, 3);
  const r = PdfDoc.open(ed.save()); const got = r.pages().map((p, i) => txt(r, i) || `blank${p.media[2]}x${p.media[3]}`);
  ok(JSON.stringify(got) === JSON.stringify(["blank300x400", "Page C", "Page B", "Page D"]), `order ${JSON.stringify(got)}`);
});

await test("annotations: 8 kinds written with appearance streams; PDF text of the FreeText comes back from its appearance", COV, () => {
  const d = PdfDoc.open(mkpdf([{ text: ["Mark this sentence please"] }])); const ed = new PdfEditor(d);
  const r = [72, 700, 300, 716];
  ed.addAnnotation(0, { type: "Highlight", rects: [r], contents: "hl" }); ed.addAnnotation(0, { type: "Underline", rects: [r] }); ed.addAnnotation(0, { type: "StrikeOut", rects: [r] });
  ed.addAnnotation(0, { type: "Ink", ink: [[100, 100, 150, 160, 200, 120]] }); ed.addAnnotation(0, { type: "Square", rect: [100, 300, 200, 360] }); ed.addAnnotation(0, { type: "Circle", rect: [250, 300, 350, 360] });
  ed.addAnnotation(0, { type: "FreeText", rect: [72, 400, 400, 440], contents: "Typed note (é)", fontSize: 12 }); ed.addAnnotation(0, { type: "Text", rect: [500, 700, 520, 720], contents: "sticky" });
  const out = PdfDoc.open(ed.save()); const ann = out.arr(out.pages()[0].dict.get("Annots")).map((a) => out.dict(a)!);
  ok(ann.length === 8, `annots ${ann.length}`);
  for (const a of ann) { const ap = out.dict(a.get("AP")); ok(ap && out.resolve(ap.get("N")), `no AP for ${String((out.resolve(a.get("Subtype")) as { n: string }).n)}`); ok(out.arr(a.get("Rect")).length === 4, "rect"); }
  const withAnnots = layout(pageChars(out, out.pages()[0], { annotations: true })).map((l) => l.text).join(" ");
  ok(withAnnots.includes("Typed note (é)"), `FreeText appearance text: ${withAnnots}`);
  const hl = ann.find((a) => (out.resolve(a.get("Subtype")) as { n: string }).n === "Highlight")!; ok(out.arr(hl.get("QuadPoints")).length === 8, "quadpoints");
});

await test("forms: text field + checkbox + choice filled, appearances generated, values re-read", COV, () => {
  const src = mkpdf([{ text: ["Form"] }], { fields: [{ name: "name", type: "Tx", rect: [72, 600, 300, 620] }, { name: "agree", type: "Btn", rect: [72, 560, 86, 574] }, { name: "pick", type: "Ch", rect: [72, 520, 200, 540], options: ["Red", "Green"] }] });
  const ed = new PdfEditor(PdfDoc.open(src)); ok(ed.fields().length === 3, "fields");
  ok(ed.fillField("name", "Ada Lovelace"), "fill text"); ok(ed.fillField("agree", true), "check"); ok(ed.fillField("pick", "Green"), "choice");
  const r = PdfDoc.open(ed.save()); const f = new PdfEditor(r).fields(); const by = Object.fromEntries(f.map((x) => [x.name, x.value]));
  ok(by.name === "Ada Lovelace" && by.agree === "Yes" && by.pick === "Green", `values ${JSON.stringify(by)}`);
  const t = layout(pageChars(r, r.pages()[0], { annotations: true })).map((l) => l.text).join(" "); ok(t.includes("Ada Lovelace"), `field appearance text: ${t}`);
});

await test("NEG forms: read-only field and unknown field are refused, document unchanged", COV, () => {
  const ed = new PdfEditor(PdfDoc.open(mkpdf([{ text: ["x"] }], { fields: [{ name: "locked", type: "Tx", rect: [72, 600, 300, 620], flags: 1, value: "fixed" }] })));
  ok(ed.fillField("locked", "changed") === false, "read-only accepted"); ok(ed.fillField("nope", "x") === false, "unknown accepted"); ok(!ed.dirty, "editor became dirty");
});

await test("NEG page ops: deleting every page, bad permutations and out-of-range rotate throw", COV, () => {
  const d = PdfDoc.open(mkpdf([{ text: ["a"] }, { text: ["b"] }]));
  const bad: [string, () => void][] = [["delete all", () => new PdfEditor(d).deletePages([0, 1])], ["dup perm", () => new PdfEditor(d).reorder([0, 0])], ["oob perm", () => new PdfEditor(d).reorder([0, 5])], ["empty perm", () => new PdfEditor(d).reorder([])], ["rotate oob", () => new PdfEditor(d).rotate(9, 90)], ["markup without rects", () => new PdfEditor(d).addAnnotation(0, { type: "Highlight", rects: [] })], ["ink without strokes", () => new PdfEditor(d).addAnnotation(0, { type: "Ink", ink: [] })]];
  for (const [n, f] of bad) { let threw = false; try { f(); } catch { threw = true; } ok(threw, `${n} did not throw`); }
});

await test("privacy: a clean copy drops a deleted page's content; the incremental save keeps it (documented)", COV, () => {
  const src = mkpdf([{ text: ["Public"] }, { text: ["SECRET-XYZ-77"] }]); const ed = new PdfEditor(PdfDoc.open(src)); ed.deletePages([1]);
  const inc = ed.save(); const clean = new PdfEditor(PdfDoc.open(src)); clean.deletePages([1]); const c = clean.saveClean();
  ok(has(inc, "SECRET-XYZ-77"), "incremental update unexpectedly removed old bytes"); ok(!has(c, "SECRET-XYZ-77"), "clean copy still contains the deleted page");
  const r = PdfDoc.open(c); ok(r.pages().length === 1 && txt(r, 0) === "Public", "clean copy content");
});

await test("merge + extract: page counts and text order", COV, () => {
  const a = PdfDoc.open(mkpdf([{ text: ["A1"] }, { text: ["A2"] }])), b = PdfDoc.open(mkpdf([{ text: ["B1"] }, { text: ["B2"] }, { text: ["B3"] }]));
  const m = PdfDoc.open(mergeDocuments([a, b])); ok(m.pages().map((_, i) => txt(m, i)).join(",") === "A1,A2,B1,B2,B3", "merge order");
  const x = PdfDoc.open(extractPages(b, [2, 0])); ok(x.pages().map((_, i) => txt(x, i)).join(",") === "B3,B1", "extract order");
});

await test("NEG damaged xref: save() falls back to a clean rewrite instead of chaining onto bad offsets", COV, () => {
  const src = mkpdf([{ text: ["Damaged"] }], { corruptXref: true }); const d = PdfDoc.open(src); const ed = new PdfEditor(d);
  ok(!ed.xrefExact(), "corrupt offset not detected"); ed.setInfo({ Title: "t" }); const out = ed.save();
  ok(!Buffer.from(out.subarray(0, src.length)).equals(Buffer.from(src)), "appended onto a damaged file"); const r = PdfDoc.open(out); ok(!r.recovered && r.info().Title === "t" && txt(r, 0) === "Damaged", "rewrite unreadable");
});

await test("NEG hostile input: garbage, truncation, page-tree loop and absurd /Count stay bounded", COV, () => {
  const t0 = Date.now();
  const cases: Uint8Array[] = [new Uint8Array(0), enc.encode("not a pdf at all"), mkpdf([{ text: ["x"] }]).subarray(0, 120), Uint8Array.from({ length: 4096 }, (_, i) => (i * 7919) & 255),
    enc.encode("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[2 0 R]/Count 999999999>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF")];
  for (const c of cases) { try { const d = PdfDoc.open(c); ok(d.pages().length < 50_000, "page explosion"); } catch (e) { ok(e instanceof Error, "non-Error thrown"); } }
  ok(Date.now() - t0 < 5000, "hostile inputs took too long");
});

await test("names round-trip byte-exactly (GBK font name bytes survive a rewrite) — regression", COV, () => {
  const lx = new Lexer(enc.encode("/#BA#DA#CC#E5")); const n = parseObj(lx) as { n: string }; ok(serialize(n as never) === "/#ba#da#cc#e5", `serialised ${serialize(n as never)}`);
  ok(serialize(N("Caf\u00e9")) === "/Caf#e9", "latin-1 name"); ok(nameText(String.fromCharCode(...enc.encode("Ünï"))) === "Ünï", "utf-8 display"); ok(nameText("\u00ba\u00da") === "\u00ba\u00da", "non-UTF-8 bytes kept");
});

await test("synthesised appearances for annotations without /AP (as PDFium/Acrobat); NEG: no colour → nothing", COV, () => {
  const a = new PDict().set("Subtype", N("Square")).set("Rect", [10, 10, 110, 60]).set("C", [1, 0, 0]);
  const d = PdfDoc.open(mkpdf([{ text: ["x"] }]));
  const s = synthAppearance(d, a); ok(s && /re S$/.test(s.content) && s.content.includes("1 0 0 RG"), `square ${s?.content}`);
  ok(synthAppearance(d, new PDict().set("Subtype", N("Square")).set("Rect", [0, 0, 5, 5])) === null, "square without colours painted");
  ok(synthAppearance(d, new PDict().set("Subtype", N("Link")).set("Rect", [0, 0, 5, 5]).set("C", [0, 0, 1])) === null, "link painted");
  const ft = synthAppearance(d, new PDict().set("Subtype", N("FreeText")).set("Rect", [0, 0, 200, 50]).set("Contents", new PStr(enc.encode("Hello"))).set("DA", new PStr(enc.encode("/Helv 10 Tf 0 0 1 rg"))));
  ok(ft && ft.content.includes("(Hello) Tj") && ft.content.includes("0 0 1 rg"), "freetext");
});

await test("NEG shading: an axial shading whose function takes 18 inputs is rejected (PDFium paints nothing)", COV, () => {
  const d = PdfDoc.open(mkpdf([{ text: ["x"] }]));
  const fn = new PDict().set("FunctionType", 2).set("Domain", Array(36).fill(0).map((_, i) => i % 2)).set("C0", [0]).set("C1", [1]).set("N", 1);
  const bad = new PDict().set("ShadingType", 2).set("ColorSpace", N("DeviceGray")).set("Coords", [0, 0, 1, 0]).set("Function", fn);
  ok(loadShading(d, bad, null) === null, "invalid shading accepted");
  const good = new PDict().set("ShadingType", 2).set("ColorSpace", N("DeviceGray")).set("Coords", [0, 0, 1, 0]).set("Function", new PDict().set("FunctionType", 2).set("Domain", [0, 1]).set("C0", [0]).set("C1", [1]).set("N", 1));
  ok(loadShading(d, good, null) !== null, "valid shading rejected");
});

await test("text fitting: wrap() never exceeds the width; Helvetica widths match the AFM (\"Hello\" = 2.278 em at 1 pt)", COV, () => {
  ok(Math.abs(helvWidth("Hello", 1000) - 2278) < 0.5, `width ${helvWidth("Hello", 1000)}`);
  const lines = wrap("The quick brown fox jumps over the lazy dog and keeps running far away", 120, 12); ok(lines.length >= 3, "no wrapping");
  for (const l of lines) ok(helvWidth(l, 12) <= 120 + 0.01, `line too wide: ${l}`);
});

await test("routing: .pdf opens in the PDF app; forge grade A with the gaps written into the boundary", COV, () => {
  ok(appForFile("a/b/Report.PDF", "application/pdf") === "pdf", "routing"); const f = formatFor("x.pdf")!;
  ok(f.grade === "A" && f.editable && /JPEG 2000/.test(f.boundary) && /soft masks/.test(f.boundary), "forge row");
});

await test("encrypted files: RC4/AES open with their pdf.js-manifest passwords; edits stay encrypted and re-open; NEG wrong password", COV, () => {
  if (!have) { console.log("  (corpus absent — skipped)"); return; }
  let n = 0;
  for (const [f, pw] of Object.entries(PW)) {
    const p = join(CORPUS, f); if (!existsSync(p)) continue; const b = new Uint8Array(readFileSync(p));
    let threw = false; try { PdfDoc.open(b, pw + "x"); } catch (e) { threw = e instanceof PasswordRequired; } ok(threw, `${f}: wrong password accepted`);
    const d = PdfDoc.open(b, pw); ok(d.sec, `${f} not encrypted?`); const ed = new PdfEditor(d); ed.setInfo({ Title: "Locked edit" }); ed.addAnnotation(0, { type: "FreeText", rect: [20, 20, 220, 60], contents: "inside" });
    const out = ed.save(); const strId = (d.sec as unknown as { strMethod: string }).strMethod === "Identity"; // /StrF /Identity: strings are clear by design
    ok(strId === has(out.subarray(b.length), "Locked edit"), `${f}: title ${strId ? "should be clear (StrF Identity)" : "written in clear"}`);
    const r = PdfDoc.open(out, pw); ok(r.info().Title === "Locked edit", `${f}: title not recovered`); n++;
  }
  ok(n >= 3, `only ${n} encrypted samples`);
});

await test("corpus: 972 pdf.js test files open; page tree agrees with PDFium/pypdf page counts (/tmp/struct.jsonl)", COV, () => {
  if (!have) { console.log("  (corpus absent — skipped)"); return; }
  const files = readdirSync(CORPUS).filter((f) => f.endsWith(".pdf")); let opened = 0, pwd = 0, agree = 0, compared = 0; const t0 = Date.now();
  const ref = existsSync("/tmp/struct.jsonl") ? new Map(readFileSync("/tmp/struct.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((o) => [o.file, o.pdfium?.n ?? o.pypdf?.n])) : new Map();
  for (const f of files) {
    try { const d = PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, f))), PW[f]); opened++; const n = d.pages().length; const r = ref.get(f); if (typeof r === "number" && r > 0) { compared++; if (r === n) agree++; } }
    catch (e) { if (e instanceof PasswordRequired) pwd++; }
  }
  console.log(`  opened ${opened}/${files.length} (+${pwd} need a password), page count agrees ${agree}/${compared}, ${Date.now() - t0} ms`);
  ok(opened >= 955 && (compared === 0 || agree / compared >= 0.98), "corpus regression");
});

await test("oracle: our edits re-opened by PDFium + qpdf (rotate, annotate, title, reorder/delete/insert, merge, extract)", COV, () => {
  if (!have) { console.log("  (corpus absent — skipped)"); return; }
  const out = join(tmp, "edits"); execFileSync("node", ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt52-editcmp.mts"], { env: { ...process.env, OUT: out, N: process.env.EDIT_N ?? "260" }, stdio: "pipe", timeout: 600_000 });
  const res = execFileSync(PY, ["scripts/oracle/pdf_editcheck.py", out, CORPUS], { timeout: 1_200_000, maxBuffer: 64 << 20 }).toString();
  const head = JSON.parse(res.split("\n")[0]) as { jobs: number; ok: number; fail: number; unverifiable: number };
  const fails = res.split("\n").slice(1).filter(Boolean).map((l) => JSON.parse(l) as { file: string; why: string[] });
  // documented oracle disagreements: Pages-tree-refs (PDFium counts a page it then fails to load), pr6531_2 (crafted
  // file whose Info strings neither engine decrypts), GBK simple fonts whose text PDFium re-decodes from the font name
  const known = /^(Pages-tree-refs|pr6531_2|merge-\d+|extract-\d+)/;
  const unexplained = fails.filter((f) => !known.test(f.file) || (/^(merge|extract)/.test(f.file) && !f.why.every((w) => /merge page|extract mismatch|merge pages/.test(w))));
  console.log(`  ${head.ok}/${head.jobs - head.unverifiable} verified (${head.unverifiable} unverifiable: oracle cannot open the original), ${fails.length} disagreements, ${unexplained.length} unexplained`);
  ok(unexplained.length === 0, unexplained.slice(0, 5).map((f) => `${f.file}: ${f.why.join("; ")}`).join("\n"));
  ok(head.ok / Math.max(1, head.jobs - head.unverifiable) >= 0.98, "verified share below 98 %");
});

await test("oracle: text differential vs PDFium ≥ 0.93 mean bigram-F1 (needs /tmp/text.jsonl)", COV, () => {
  if (!have || !existsSync("/tmp/text.jsonl")) { console.log("  (oracle output absent — run scripts/oracle/pdf_probe.py --text --pages 3 > /tmp/text.jsonl)"); return; }
  const out = execFileSync("node", ["--experimental-strip-types", "--no-warnings", "--import", "./scripts/register-hook.mjs", "scripts/tt52-textcmp.mts"], { timeout: 600_000, maxBuffer: 64 << 20 }).toString();
  const m = /mean: '([\d.]+)'/.exec(out); ok(m, "no summary"); console.log(`  ${out.split("\n")[0]}`); ok(Number(m[1]) >= 0.93, `mean ${m[1]}`);
});

await test("interpreter: annotations of every corpus page run without throwing (bounded time)", COV, () => {
  if (!have) { console.log("  (corpus absent — skipped)"); return; }
  const t0 = Date.now(); let pages = 0, threw = 0;
  const dev = { wantsImages: false, wantsPaths: true, save() {}, restore() {}, fill() {}, stroke() {}, clip() {}, glyph() {}, image() {}, shade() {} };
  for (const f of readdirSync(CORPUS).filter((x) => x.endsWith(".pdf")).slice(0, 400)) {
    let d: PdfDoc; try { d = PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, f))), PW[f]); } catch { continue; }
    const p = d.pages()[0]; if (!p) continue; pages++;
    try { const it = new Interpreter(d, dev as never, IDENT, { warnings: [], deadline: Date.now() + 3000 }); it.runPage(p); runAnnotations(d, p, it, dev as never, false); } catch { threw++; }
  }
  console.log(`  ${pages} pages, ${threw} threw, ${Date.now() - t0} ms`); ok(threw === 0, `${threw} pages threw`);
});

await test("CCITT tables: white/black/mode codes are prefix-free and complete (Kraft sum), as T.4 requires", COV, () => {
  const check = (name: string, codes: string[]) => {
    for (const a of codes) for (const b of codes) ok(a === b || !b.startsWith(a), `${name}: ${a} is a prefix of ${b}`);
    const kraft = codes.reduce((t, c) => t + 2 ** -c.length, 0); ok(kraft <= 1 + 1e-12, `${name}: Kraft ${kraft}`); return kraft;
  };
  const kw = check("white", [..._codes.WHITE, ..._codes.EXT].map((x) => x[1])), kb = check("black", [..._codes.BLACK, ..._codes.EXT].map((x) => x[1])); check("modes", _codes.MODES.map((x) => x[1]));
  ok(_codes.WHITE.length === 64 + 27 && _codes.BLACK.length === 64 + 27 && _codes.EXT.length === 13, "table sizes"); ok(kw > 0.99 && kb > 0.99, `tables incomplete (${kw}, ${kb})`);
});

await test("CCITT oracle: libtiff (via Pillow) encodes 9 bitmaps as G4, G3-1D and G3-2D; our decoder reproduces every bit", COV, () => {
  if (!existsSync(PY)) { console.log("  (venv absent — skipped)"); return; }
  const lines = execFileSync(PY, ["scripts/oracle/ccitt_encode.py"], { encoding: "utf8", maxBuffer: 64 << 20 }).trim().split("\n").map((l) => JSON.parse(l));
  let n = 0;
  for (const o of lines) {
    ok(!o.error, `encoder: ${o.error}`);
    // Pillow writes mode "1" with paper = bit 1, which libtiff codes as black runs: compare raw rows with BlackIs1
    const r = ccittDecode(Buffer.from(o.data, "hex"), { K: o.k, Columns: o.w, Rows: o.h, BlackIs1: true }); ok(!r.partial && r.rows === o.h, `${o.name}: partial/rows`);
    const want = Buffer.from(o.bits, "hex"), rb = (o.w + 7) >> 3, last = o.w % 8 ? (0xff << (8 - (o.w % 8))) & 0xff : 0xff;
    for (let y = 0; y < o.h; y++) for (let x = 0; x < rb; x++) { const i = y * rb + x; ok(((r.data[i] ^ ~want[i]) & (x === rb - 1 ? last : 0xff)) === 0, `${o.name}: row ${y} byte ${x}`); }
    n++;
  }
  ok(n === 27, `only ${n} cases`);
});

await test("NEG CCITT: corrupt, truncated and garbage streams decode the good rows, flag partial, never throw or hang; absurd sizes are capped", COV, () => {
  const o = JSON.parse(existsSync(PY) ? execFileSync(PY, ["scripts/oracle/ccitt_encode.py"], { encoding: "utf8" }).split("\n").find((l) => l.includes("blobs-group4"))! : "null");
  const t0 = Date.now();
  if (o) {
    const good = Buffer.from(o.data, "hex"); const bad = Buffer.from(good); bad.fill(0xff, good.length >> 1, (good.length >> 1) + 6);
    const r = ccittDecode(bad, { K: -1, Columns: o.w, Rows: o.h }); ok(r.partial && r.data.length === ((o.w + 7) >> 3) * o.h, "corrupt stream not flagged / wrong size");
    const ref = ccittDecode(good, { K: -1, Columns: o.w, Rows: o.h }); ok(Buffer.from(r.data.subarray(0, (o.w + 7) >> 3)).equals(Buffer.from(ref.data.subarray(0, (o.w + 7) >> 3))), "first row lost");
    const tr = ccittDecode(good.subarray(0, 20), { K: -1, Columns: o.w, Rows: o.h }); ok(tr.partial, "truncated not flagged");
  }
  for (let k = -1; k <= 1; k++) { const g = ccittDecode(Uint8Array.from({ length: 5000 }, (_, i) => (i * 2654435761) >>> 24), { K: k, Columns: 1728 }); ok(g.data.length % 216 === 0, "garbage output shape"); }
  const huge = ccittDecode(new Uint8Array(16), { K: -1, Columns: 1 << 30, Rows: 1 << 30 }); ok(huge.data.length <= 1 << 26, "dimensions not capped");
  ok(Date.now() - t0 < 4000, "CCITT negative cases too slow");
});

await test("CCITT in a page: an inline /CCF image reaches the device as decoded 1-bit samples (no 'unsupported codec')", COV, () => {
  if (!existsSync(PY)) { console.log("  (venv absent — skipped)"); return; }
  const o = JSON.parse(execFileSync(PY, ["scripts/oracle/ccitt_encode.py"], { encoding: "utf8" }).split("\n").find((l) => l.includes("text-group4"))!);
  const bin = String.fromCharCode(...Buffer.from(o.data, "hex"));
  const d = PdfDoc.open(mkpdf([{ text: ["fax"], extra: `q 240 0 0 40 72 400 cm BI /W ${o.w} /H ${o.h} /BPC 1 /CS /G /F /CCF /DP <</K -1 /Columns ${o.w} /Rows ${o.h} /BlackIs1 true>> ID ${bin} EI Q` }]));
  const got: { codec: unknown; data: Uint8Array; bpc: number }[] = []; const warnings: string[] = [];
  const dev = { wantsImages: true, wantsPaths: false, save() {}, restore() {}, fill() {}, stroke() {}, clip() {}, glyph() {}, shade() {}, image(img: { codec: unknown; data: Uint8Array; bpc: number }) { got.push(img); } };
  new Interpreter(d, dev as never, IDENT, { warnings }).runPage(d.pages()[0]);
  ok(got.length === 1 && got[0].codec === null && got[0].bpc === 1, `image not decoded: ${JSON.stringify(got.map((g) => g.codec))}`);
  const ref = ccittDecode(Buffer.from(o.data, "hex"), { K: -1, Columns: o.w, Rows: o.h, BlackIs1: true }); ok(Buffer.from(got[0].data).equals(Buffer.from(ref.data)), "samples differ from the decoder");
});

await test("CID-keyed CFF: an explicit top FontMatrix is not scaled again (issue16500 glyphs at 1000-unit size, not ×1000) — regression", COV, () => {
  if (!have) { console.log("  (corpus absent — skipped)"); return; }
  const d = PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, "issue16500.pdf")))); const boxes: number[] = [];
  const dev = { wantsImages: false, wantsPaths: true, save() {}, restore() {}, clip() {}, image() {}, shade() {}, fill() {}, stroke() {},
    glyph(g: unknown, font: { outline(g: unknown): number[] | null; outlineMatrix(): number[] }) { const o = font.outline(g) ?? []; const m = font.outlineMatrix(); let mx = 0;
      for (let i = 0; i < o.length;) { const op = o[i++]; const n = op === 0 || op === 1 ? 2 : op === 2 ? 4 : op === 3 ? 6 : 0; for (let k = 0; k < n; k += 2) mx = Math.max(mx, Math.abs(o[i + k] * m[0] + o[i + k + 1] * m[2])); i += n; }
      if (o.length) boxes.push(mx); } };
  new Interpreter(d, dev as never, IDENT, { warnings: [] }).runPage(d.pages()[0]);
  ok(boxes.length > 3, "no outlines"); const big = Math.max(...boxes); ok(big > 0.2 && big < 2, `glyph extent ${big} em (expected ≈0.5)`);
});

await test("nested content keeps the caller's graphics state: unbalanced q/Q in a form/glyph never unwinds the page's q levels — regression", COV, () => {
  const d = PdfDoc.open(mkpdf([{ text: ["x"] }]));
  const dev = { wantsImages: false, wantsPaths: true, save() {}, restore() {}, fill() {}, stroke() {}, clip() {}, glyph() {}, image() {}, shade() {} };
  const it = new Interpreter(d, dev as never, IDENT, { warnings: [] }) as unknown as { run(b: Uint8Array, r: null): void; runAt(b: Uint8Array, r: null, m: number[]): void; gs: { ctm: number[] }; stack: unknown[]; op(k: string, a: unknown[], r: null): void };
  it.op("q", [], null); it.op("cm", [2, 0, 0, 2, 0, 0], null); it.op("q", [], null); it.op("cm", [1, 0, 0, 1, 7, 7], null);
  it.runAt(enc.encode("q 9 0 0 9 0 0 cm"), null, IDENT); // unbalanced q left open by the nested stream
  ok(it.stack.length === 2 && JSON.stringify(it.gs.ctm) === "[2,0,0,2,14,14]", `after unbalanced q: depth ${it.stack.length} ctm ${JSON.stringify(it.gs.ctm)}`);
  it.runAt(enc.encode("Q Q Q 3 0 0 3 0 0 cm"), null, IDENT); // extra Q in the nested stream
  ok(it.stack.length === 2 && JSON.stringify(it.gs.ctm) === "[2,0,0,2,14,14]", `after extra Q: depth ${it.stack.length} ctm ${JSON.stringify(it.gs.ctm)}`);
  if (have) { let n = 0; const d2 = PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, "bug1001080.pdf"))));
    new Interpreter(d2, { ...dev, type3Glyph() { n++; } } as never, IDENT, { warnings: [] }).runPage(d2.pages()[0]); ok(n === 41, `bug1001080: ${n} of 41 Type 3 glyphs drawn`); }
});

await test("embedded-file-only encryption (/EFF, StmF+StrF Identity) opens without a password like PDFium — regression", COV, () => {
  if (!have) return;
  for (const f of ["auth-event-ef-open.pdf", "encrypted-attachment.pdf"]) {
    const d = PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, f))));
    ok(d.pages().length === 1 && d.warnings.some((w) => w.includes("embedded files are encrypted")), `${f}: ${d.pages().length} pages, warnings ${JSON.stringify(d.warnings)}`);
  }
  let threw = false; try { PdfDoc.open(new Uint8Array(readFileSync(join(CORPUS, "issue6010_1.pdf")))); } catch (e) { threw = e instanceof PasswordRequired; }
  ok(threw, "a fully encrypted file still requires its password");
});

writeFileSync(join(tmp, "done"), "1");
finish();
