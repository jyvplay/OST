/**
 * TT51 — Slides as a lossless real-.pptx editor (FF-23). The engine (src/lib/office/pml.ts) edits the PresentationML
 * package in place: unedited parts keep their original bytes, edited parts are re-serialised from a lossless XML tree.
 *
 * External evidence (independent of our code):
 *   1. scripts/oracle/pptx_probe.py — python-pptx 1.0.2 (MIT) reads every corpus deck and every file we write:
 *      slide order, hidden flags, layout names, notes, shape ids/names/geometry (with placeholder inheritance), text,
 *      table cells, group members, run formatting;
 *   2. scripts/oracle/pptx_validate.py — lxml package validator for the PowerPoint "repair" triggers (content types,
 *      dangling relationships / r:ids, sldId rules, duplicate shape ids) + a full python-pptx walk;
 *   3. msoffcrypto-tool (MIT) decrypts our password-protected save;
 *   4. Office's documented theme swatches (Accent 1 "Darker 25 %" = 2F5597, "Lighter 80 %" = DAE3F3) for colour maths.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt51-slides.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeHarness } from "./harness.mts";
import {
  readPptxDoc, writePptxDoc, blankPptx, isEdited, setShapeText, shapeParagraphs, spTreeOf, shapeKids, txBodyOf, paragraphsOf, paraText, runsOf, setParaText,
  formatRange, formatParas, duplicateSlide, moveSlide, deleteSlide, setHidden, isHidden, setNotesText, notesText, addShape, addPicture, setXfrm, readXfrm, deleteShape,
  zOrder, setShapeFill, setShapeLine, snapshot, restore, layoutsOf, addSlideFromLayout, phOf, cNvPrOf, altContent, mutSlide, bodyAt, pptxFromOutline, partXml, MAX_SLIDES, type PptxDoc,
} from "../src/lib/office/pml.ts";
import { slideView, oracleGeometry, autoNum, _test as V } from "../src/lib/office/pmlview.ts";
import { openZip, writeZip, deflateRaw } from "../src/lib/office/zipkit.ts";
import { parseXml, serializeEl, attr, kid, type XEl } from "../src/lib/office/xmltree.ts";
import { encryptOffice, decryptOffice, isEncryptedOffice } from "../src/lib/office/offcrypto.ts";

const { test: test0, finish } = makeHarness("tt51-slides");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const CORPUS = "/home/user/tools/corpus/pptx";
const PY = "/home/user/tools/venv/bin/python";
const have = existsSync(CORPUS) && existsSync(PY);
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const COV = { "FF-23": "full" } as const;
const tmp = mkdtempSync(join(tmpdir(), "tt51-"));
const BAD = /^(clusterfuzz-|crash-|Divino_Revelado)/;
const files = have ? readdirSync(CORPUS).filter((f) => f.endsWith(".pptx")).sort() : [];
const good = files.filter((f) => !BAD.test(f));
const bytesOf = (f: string) => new Uint8Array(readFileSync(join(CORPUS, f)));
const py = (script: string, args: string[]) => execFileSync(PY, [join("scripts/oracle", script), ...args], { maxBuffer: 1 << 28, timeout: 900_000 }).toString().trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
let baseline: Map<string, string[]> | null = null;
const baseProblems = (f: string) => { if (!baseline) baseline = new Map(py("pptx_validate.py", good.map((g) => join(CORPUS, g))).map((r) => [r.file.split("/").pop(), r.problems])); return baseline.get(f) ?? []; };
/** problems in an output that the original file did not already have (slide numbers normalised) */
const norm = (p: string) => p.replace(/slide\d+/g, "slideN").replace(/rId\d+/g, "rIdN").replace(/\d+/g, "#");
const newProblems = (orig: string, probs: string[]) => { const b = new Set(baseProblems(orig).map(norm)); return probs.filter((p) => !b.has(norm(p))); };

/* ---------- our reading, in python-pptx's shape vocabulary ---------- */
const PY_TAGS = new Set(["p:sp", "p:grpSp", "p:graphicFrame", "p:cxnSp", "p:pic", "p:contentPart"]);
interface OShape { id: number; name: string; geo: (number | null)[] | null; text?: string[]; table?: string[][][]; kids?: OShape[] }
function ourShapes(d: PptxDoc, si: number, list: XEl[]): OShape[] {
  return list.filter((e) => PY_TAGS.has(e.name)).map((e) => {
    const c = cNvPrOf(e); const g = e.name === "p:grpSp" || !phOf(e) ? readXfrm(e) : oracleGeometry(d, d.slides[si], e);
    const o: OShape = { id: Number(attr(c, "id")), name: attr(c, "name") ?? "", geo: g ? [g.x, g.y, g.cx, g.cy] : null };
    if (e.name === "p:sp") o.text = txBodyOf(e) ? paragraphsOf(txBodyOf(e)).map(paraText) : [""]; // python-pptx: an autoshape always "has" a text frame (created on access)
    if (e.name === "p:graphicFrame") { const tbl = findTbl(e); if (tbl) o.table = tbl; }
    if (e.name === "p:grpSp") o.kids = ourShapes(d, si, shapeKids(e));
    return o;
  });
}
function findTbl(e: XEl): string[][][] | undefined {
  const walk = (x: XEl): XEl | undefined => x.name === "a:tbl" ? x : x.kids.map((k) => (k.k === "el" ? walk(k) : undefined)).find(Boolean);
  const t = walk(e); if (!t) return undefined;
  return t.kids.filter((k): k is XEl => k.k === "el" && k.name === "a:tr").map((tr) => tr.kids.filter((k): k is XEl => k.k === "el" && k.name === "a:tc").map((tc) => { const tx = kid(tc, "a:txBody"); return tx ? paragraphsOf(tx).map(paraText) : [""]; }));
}
const cmpShape = (a: OShape, b: Record<string, unknown>, where: string, out: string[]) => {
  if (a.id !== b.id) out.push(`${where} id ${a.id} vs ${b.id}`);
  if (a.name !== b.name) out.push(`${where} name ${JSON.stringify(a.name)} vs ${JSON.stringify(b.name)}`);
  const bg = b.geo as (number | null)[] | null; if (bg && bg.every((v) => v !== null) && JSON.stringify(a.geo) !== JSON.stringify(bg)) out.push(`${where} geo ${JSON.stringify(a.geo)} vs ${JSON.stringify(bg)}`);
  if (b.text && JSON.stringify(a.text) !== JSON.stringify(b.text)) out.push(`${where} text ${JSON.stringify(a.text)?.slice(0, 80)} vs ${JSON.stringify(b.text).slice(0, 80)}`);
  if (b.table && JSON.stringify(a.table) !== JSON.stringify(b.table)) out.push(`${where} table differs`);
  if (b.kids) { const bk = b.kids as Record<string, unknown>[]; if ((a.kids?.length ?? 0) !== bk.length) out.push(`${where} kids ${a.kids?.length} vs ${bk.length}`); else bk.forEach((k, i) => cmpShape(a.kids![i], k, `${where}/${i}`, out)); }
};
const layoutName = (d: PptxDoc, i: number) => { const v = slideView(d, d.slides[i]); return v.layoutName ?? ""; };
const flatText = (shapes: Record<string, unknown>[]): string => shapes.map((s) => [...((s.text as string[]) ?? []), ...(((s.table as string[][][]) ?? []).flat(2)), flatText((s.kids as Record<string, unknown>[]) ?? [])].join("|")).join("‖");
const ourFlat = (d: PptxDoc, i: number) => flatText(ourShapes(d, i, shapeKids(spTreeOf(d.slides[i].xml))) as unknown as Record<string, unknown>[]);

let oracle: Map<string, Record<string, unknown>> | null = null;
const oracleOf = () => (oracle ??= new Map(py("pptx_probe.py", good.map((g) => join(CORPUS, g))).map((r) => [String(r.file).split("/").pop()!, r])));

/* ================================================================ tests */

await test("reader vs python-pptx over every openable corpus deck: slide order, hidden flags, layout names, notes text, shape ids/names, geometry with placeholder inheritance, paragraph text, table cells and group members agree exactly", COV, async () => {
  ok(have, "corpus/venv missing — run scripts/sandbox/bootstrap.sh and scripts/corpus/fetch.py");
  const O = oracleOf(); let decks = 0, slides = 0, shapes = 0; const bad: string[] = [];
  for (const f of good) {
    const o = O.get(f)!; ok(!o.error, `${f}: oracle failed ${o.error}`);
    const d = await readPptxDoc(bytesOf(f), f); decks++;
    const os = o.slides as Record<string, unknown>[];
    if (os.length !== d.slides.length) { bad.push(`${f}: ${d.slides.length} slides vs ${os.length}`); continue; }
    if (JSON.stringify(o.size) !== JSON.stringify([d.size.cx, d.size.cy])) bad.push(`${f}: size ${d.size.cx}x${d.size.cy} vs ${o.size}`);
    d.slides.forEach((s, i) => {
      slides++; const p = os[i];
      if ("/" + s.path !== p.partname) bad.push(`${f}#${i}: part ${s.path} vs ${p.partname}`);
      if (isHidden(s) !== p.hidden) bad.push(`${f}#${i}: hidden`);
      if (layoutName(d, i) !== p.layout) bad.push(`${f}#${i}: layout ${layoutName(d, i)} vs ${p.layout}`);
      if (p.notes !== null && notesText(d, i) !== String(p.notes).replace(/\v/g, "\n")) bad.push(`${f}#${i}: notes ${JSON.stringify(notesText(d, i)).slice(0, 60)} vs ${JSON.stringify(p.notes).slice(0, 60)}`);
      const ours = ourShapes(d, i, shapeKids(spTreeOf(s.xml))); const theirs = p.shapes as Record<string, unknown>[];
      if (ours.length !== theirs.length) { bad.push(`${f}#${i}: ${ours.length} shapes vs ${theirs.length}`); return; }
      theirs.forEach((t, k) => { shapes++; cmpShape(ours[k], t, `${f}#${i}/${k}`, bad); });
    });
  }
  console.log(`  reader: ${decks} decks, ${slides} slides, ${shapes} top-level shapes compared, ${bad.length} mismatches`);
  ok(decks === 83 && slides === 551, `corpus drift: ${decks} decks / ${slides} slides`);
  ok(bad.length === 0, bad.slice(0, 12).join("\n"));
  // H∂ the corpus never exercises: absolute relationship targets and part names whose case differs from the target that names
  // them (OPC names are case-insensitive). Both must open; an edited save must not write the part twice under two spellings.
  {
    const td = new TextDecoder(), te = new TextEncoder(); const z = openZip(await blankPptx("Case")); const ents: { name: string; data: Uint8Array }[] = [];
    for (const e of z.entries) { let data = (await z.read(e.name))!; let name = e.name;
      if (name === "ppt/slides/slide1.xml") name = "ppt/slides/Slide1.XML";
      if (name === "ppt/_rels/presentation.xml.rels") data = te.encode(td.decode(data).replace('Target="slides/slide1.xml"', 'Target="/ppt/slides/slide1.xml"'));
      if (name === "ppt/slides/_rels/slide1.xml.rels") data = te.encode(td.decode(data).replace('Target="../slideLayouts/slideLayout1.xml"', 'Target="/ppt/slideLayouts/slideLayout1.xml"'));
      ents.push({ name, data }); }
    const d = await readPptxDoc(await writeZip(ents), "case.pptx");
    ok(d.slides.length === 1 && JSON.stringify(shapeParagraphs(d.slides[0].xml, "0")) === '["Case"]', `absolute/mixed-case deck: ${d.slides.length} slides ${d.warnings}`);
    ok(slideView(d, d.slides[0]).layoutName === "Title Slide", `layout through an absolute target: ${slideView(d, d.slides[0]).layoutName}`);
    setShapeText(d, 0, "0", ["Edited"]); const out = await writePptxDoc(d); const names = openZip(out).entries.map((e) => e.name.toLowerCase());
    ok(new Set(names).size === names.length, `edited save writes a part twice: ${names.filter((n, k) => names.indexOf(n) !== k)}`);
    const p = join(tmp, "case-edited.pptx"); writeFileSync(p, out); const [v] = py("pptx_validate.py", [p]); ok(v.ok, `case deck: ${v.problems}`);
    const [pr] = py("pptx_probe.py", [p]); ok(JSON.stringify(((pr.slides as Record<string, unknown>[])[0].shapes as Record<string, unknown>[])[0].text) === '["Edited"]', "python-pptx does not read the edit");
  }
  // attack on that repair: ONE part named with TWO spellings (presentation rels vs the notes slide's back-reference), in both
  // zip entry orders — the result must not depend on the order, and an edited save must still write the slide once
  {
    const td = new TextDecoder(), te = new TextEncoder(); const d0 = await readPptxDoc(await blankPptx("Two"), "t.pptx"); setNotesText(d0, 0, "n");
    const z = openZip(await writePptxDoc(d0)); const ents: { name: string; data: Uint8Array }[] = [];
    for (const e of z.entries) { let data = (await z.read(e.name))!; let name = e.name;
      if (name === "ppt/slides/slide1.xml") name = "ppt/slides/Slide1.xml";
      if (/notesSlides\/_rels\/notesSlide1\.xml\.rels$/.test(name)) data = te.encode(td.decode(data).replace("../slides/slide1.xml", "../slides/SLIDE1.xml"));
      ents.push({ name, data }); }
    for (const list of [ents, ents.slice().reverse()]) {
      const d = await readPptxDoc(await writeZip(list), "two.pptx"); ok(d.slides.length === 1 && notesText(d, 0) === "n", `two spellings: ${d.slides.length} slides, notes ${notesText(d, 0)}`);
      setShapeText(d, 0, "0", ["Edited"]); const names = openZip(await writePptxDoc(d)).entries.map((e) => e.name.toLowerCase());
      ok(new Set(names).size === names.length, `two spellings: part written twice ${names.filter((n, k) => names.indexOf(n) !== k)}`);
    }
  }
});

await test("lossless identity: opening and saving every corpus deck without edits returns the original bytes (83/83); the view model renders every slide of every deck without throwing", COV, async () => {
  let same = 0, drawn = 0;
  for (const f of good) {
    const b = bytesOf(f); const d = await readPptxDoc(b, f); const out = await writePptxDoc(d);
    if (!isEdited(d) && Buffer.compare(Buffer.from(out), Buffer.from(b)) === 0) same++;
    for (const s of d.slides) { slideView(d, s); drawn++; }
  }
  ok(same === good.length, `${same}/${good.length} identical`); ok(drawn === 551, `drawn ${drawn}`);
});

/** first slide shape with a non-empty paragraph */
function firstText(d: PptxDoc): { si: number; addr: string; p: number } | null {
  for (let si = 0; si < d.slides.length; si++) {
    const ks = shapeKids(spTreeOf(d.slides[si].xml));
    for (let k = 0; k < ks.length; k++) { const e = ks[k]; if (e.name !== "p:sp" || !txBodyOf(e)) continue; const ps = paragraphsOf(txBodyOf(e)); const p = ps.findIndex((q) => paraText(q).replace(/\v/g, "").length >= 3); if (p >= 0) return { si, addr: String(k), p }; }
  }
  return null;
}

await test("text edits keep formatting: a word typed into the middle of a paragraph joins its run (rPr kept byte-for-byte), every other run and paragraph keeps its exact XML, untouched parts keep their bytes; python-pptx reads the new text and the validator finds no new problems in any deck", COV, async () => {
  const outDir = join(tmp, "text"); mkdirSync(outDir, { recursive: true }); const exp = new Map<string, { si: number; k: number; text: string[] }>(); let n = 0;
  for (const f of good) {
    const b = bytesOf(f); const d = await readPptxDoc(b, f); const t = firstText(d); if (!t) continue;
    const before = paragraphsOf(txBodyOf(shapeKids(spTreeOf(d.slides[t.si].xml))[Number(t.addr)])).map((p) => serializeEl(p));
    const paras = shapeParagraphs(d.slides[t.si].xml, t.addr); const old = paras[t.p]; const mid = Math.floor(old.length / 2);
    paras[t.p] = old.slice(0, mid) + " Ωmega✓ " + old.slice(mid);
    const runsBefore = runsOf(paragraphsOf(txBodyOf(shapeKids(spTreeOf(d.slides[t.si].xml))[Number(t.addr)]))[t.p]);
    setShapeText(d, t.si, t.addr, paras.map((x) => x.replace(/\v/g, "\n")));
    const tx = txBodyOf(shapeKids(spTreeOf(d.slides[t.si].xml))[Number(t.addr)])!; const after = paragraphsOf(tx);
    after.forEach((p, i) => { if (i !== t.p) ok(serializeEl(p) === before[i], `${f}: paragraph ${i} changed`); });
    const runsAfter = runsOf(after[t.p]);
    ok(runsAfter.length === runsBefore.length, `${f}: run count ${runsBefore.length} → ${runsAfter.length}`);
    runsAfter.forEach((r, i) => { const a = kid(r.el, "a:rPr"), bb = kid(runsBefore[i].el, "a:rPr"); ok((a ? serializeEl(a) : "") === (bb ? serializeEl(bb) : ""), `${f}: run ${i} rPr changed`); });
    const out = await writePptxDoc(d); writeFileSync(join(outDir, f), out); exp.set(f, { si: t.si, k: Number(t.addr), text: paras }); n++;
    // only the slide part (and docProps/core.xml) differ from the original package
    const zo = openZip(b), zn = openZip(out); const changed: string[] = [];
    for (const e of zn.entries) { const x = await zn.read(e.name), y = await zo.read(e.name); if (!y || Buffer.compare(Buffer.from(x!), Buffer.from(y)) !== 0) changed.push(e.name); }
    ok(changed.every((c) => c === d.slides[t.si].path || c === "docProps/core.xml"), `${f}: unexpected changed parts ${changed.join(",")}`);
  }
  const probes = py("pptx_probe.py", [...exp.keys()].map((f) => join(outDir, f))); const vals = py("pptx_validate.py", [...exp.keys()].map((f) => join(outDir, f)));
  const bad: string[] = [];
  probes.forEach((p) => { const f = String(p.file).split("/").pop()!; const e = exp.get(f)!; const sh = (p.slides as Record<string, unknown>[])[e.si].shapes as Record<string, unknown>[];
    if (!sh.some((x) => JSON.stringify(x.text) === JSON.stringify(e.text))) bad.push(`${f}: python-pptx does not see the edited text`); });
  vals.forEach((v) => { const f = String(v.file).split("/").pop()!; const np = newProblems(f, v.problems); if (np.length) bad.push(`${f}: ${np.slice(0, 3).join("; ")}`); });
  console.log(`  text edits: ${n} decks edited, ${bad.length} problems`);
  ok(n >= 55, `only ${n} decks had text`); ok(bad.length === 0, bad.slice(0, 10).join("\n"));
});

await test("setParaText unit cases: insertion at a run boundary joins the left run; deletion across runs keeps both outer runs' rPr; typing into an empty paragraph uses endParaRPr; line breaks stay a:br; fields keep their a:fld; XML-illegal control characters are dropped", COV, async () => {
  const P = (inner: string) => parseXml(`<a:p xmlns:a="a">${inner}</a:p>`).root;
  const s = (p: XEl) => serializeEl(p);
  let p = P(`<a:r><a:rPr b="1"/><a:t>Hello</a:t></a:r><a:r><a:rPr i="1"/><a:t> world</a:t></a:r>`);
  setParaText(p, "Hello there world"); ok(s(p) === `<a:p xmlns:a="a"><a:r><a:rPr b="1"/><a:t>Hello there</a:t></a:r><a:r><a:rPr i="1"/><a:t> world</a:t></a:r></a:p>`, s(p));
  p = P(`<a:r><a:rPr b="1"/><a:t>Hello</a:t></a:r><a:r><a:rPr i="1"/><a:t> world</a:t></a:r>`);
  setParaText(p, "Held"); ok(s(p) === `<a:p xmlns:a="a"><a:r><a:rPr b="1"/><a:t>Hel</a:t></a:r><a:r><a:rPr i="1"/><a:t>d</a:t></a:r></a:p>`, s(p));
  p = P(`<a:endParaRPr sz="4400" lang="en-US"/>`); setParaText(p, "New"); ok(/<a:r><a:rPr sz="4400" lang="en-US"\/><a:t>New<\/a:t><\/a:r><a:endParaRPr/.test(s(p)), s(p));
  p = P(`<a:r><a:t>ab</a:t></a:r>`); setParaText(p, "a\nb"); ok(/<a:br/.test(s(p)) && paraText(p) === "a\vb", s(p));
  p = P(`<a:r><a:t>Slide </a:t></a:r><a:fld id="{X}" type="slidenum"><a:t>3</a:t></a:fld>`); setParaText(p, "Page 3"); ok(/<a:fld id="\{X\}" type="slidenum"><a:t>3<\/a:t><\/a:fld>/.test(s(p)) && paraText(p) === "Page 3", s(p));
  p = P(`<a:r><a:t>x</a:t></a:r>`); setParaText(p, "x\u0001y\u0008z"); ok(paraText(p) === "xyz", paraText(p));
  p = P(`<a:r><a:rPr b="1"/><a:t>abc</a:t></a:r><a:r><a:rPr i="1"/><a:t>def</a:t></a:r><a:r><a:rPr u="sng"/><a:t>ghi</a:t></a:r>`);
  setParaText(p, "abhi"); ok(s(p) === `<a:p xmlns:a="a"><a:r><a:rPr b="1"/><a:t>ab</a:t></a:r><a:r><a:rPr u="sng"/><a:t>hi</a:t></a:r></a:p>`, s(p));
});

await test("range formatting: bold/italic/size/colour on a sub-range splits runs at the exact boundaries (python-pptx sees bold only on the selected characters), paragraph alignment / bullets / level land in a:pPr in schema order", COV, async () => {
  const d = await readPptxDoc(await blankPptx("Fmt"), "f.pptx");
  const i = addSlideFromLayout(d, 1, layoutsOf(d).find((l) => /content/i.test(l.name))!.path);
  const k = shapeKids(spTreeOf(d.slides[i].xml)).findIndex((e) => phOf(e)?.type === "body" || phOf(e)?.idx === "1");
  setShapeText(d, i, String(k), ["Hello brave world", "Second line"]);
  const tx = bodyAt(mutSlide(d, i).xml, String(k))!;
  formatRange(tx, { p: 0, o: 6 }, { p: 0, o: 11 }, { b: true, color: "#FF0000", sz: 28 });
  formatRange(tx, { p: 1, o: 0 }, { p: 1, o: 6 }, { i: true, u: true });
  formatParas(tx, 0, 0, { algn: "ctr", bullet: "num" }); formatParas(tx, 1, 1, { lvl: 1, bullet: "none" });
  const out = await writePptxDoc(d); const f = join(tmp, "fmt.pptx"); writeFileSync(f, out);
  const [r] = py("pptx_probe.py", ["--runs", f]); const sh = (r.slides as Record<string, unknown>[])[i].shapes as Record<string, unknown>[];
  const body = sh.find((s) => Array.isArray(s.text) && (s.text as unknown[][])[0]?.[0] === "Hello brave world") as Record<string, unknown>; ok(body, JSON.stringify(sh).slice(0, 300));
  const p0 = (body.text as unknown[][])[0], p1 = (body.text as unknown[][])[1];
  ok(JSON.stringify((p0[3] as unknown[][]).map((x) => [x[0], x[1], x[4], x[5]])) === JSON.stringify([["Hello ", null, null, null], ["brave", true, 28, "FF0000"], [" world", null, null, null]]), JSON.stringify(p0));
  ok(String(p0[1]).startsWith("CENTER"), `align ${p0[1]}`); ok(p1[2] === 1, `level ${p1[2]}`);
  ok(JSON.stringify((p1[3] as unknown[][]).map((x) => [x[0], x[2], x[3]])) === JSON.stringify([["Second", true, true], [" line", null, null]]), JSON.stringify(p1));
  const [v] = py("pptx_validate.py", [f]); ok(v.ok, v.problems.join("; "));
  const pPr = kid(paragraphsOf(tx)[0], "a:pPr")!; ok(pPr.kids.filter((x) => x.k === "el").map((x) => (x as XEl).name).join(",") === "a:buAutoNum", serializeEl(pPr));
  formatParas(tx, 0, 0, { bullet: "char" }); ok(kid(paragraphsOf(tx)[0], "a:pPr")!.kids.filter((x) => x.k === "el").map((x) => (x as XEl).name).join(",") === "a:buFont,a:buChar", "buFont must precede buChar (CT_TextParagraphProperties order)");
});

/** media parts no relationship in the package points at */
async function orphanMedia(bytes: Uint8Array): Promise<number> {
  const z = openZip(bytes); const used = new Set<string>(); const td = new TextDecoder();
  for (const e of z.entries) {
    if (!e.name.endsWith(".rels")) continue; const src = e.name.replace(/(^|\/)_rels\/([^/]+)\.rels$/, "$1$2"); const dir = src.split("/").slice(0, -1);
    for (const m of td.decode((await z.read(e.name))!).matchAll(/Target="([^"]+)"/g)) {
      if (/^[a-z]+:/i.test(m[1])) continue; const segs = m[1].startsWith("/") ? [] : dir.slice();
      for (const g of m[1].split("/")) { if (g === "..") segs.pop(); else if (g && g !== ".") segs.push(g); } used.add(segs.join("/").toLowerCase());
    }
  }
  return z.entries.filter((e) => /^ppt\/media\//i.test(e.name) && !used.has(e.name.toLowerCase())).length;
}

await test("slide operations on every multi-slide corpus deck — duplicate, move, hide, delete — produce the expected slide sequence, hidden flags and notes in python-pptx, with no new validator problems (no dangling rels, content types or sldIds; duplicated charts get their own parts)", COV, async () => {
  const O = oracleOf(); const outDir = join(tmp, "ops"); mkdirSync(outDir, { recursive: true }); const exp = new Map<string, { texts: string[]; hidden: boolean[]; notes: (string | null)[] }>();
  for (const f of good) {
    const o = O.get(f)!; const os = o.slides as Record<string, unknown>[]; if (os.length < 3) continue;
    const d = await readPptxDoc(bytesOf(f), f);
    const T = os.map((s) => flatText(s.shapes as Record<string, unknown>[])), H = os.map((s) => s.hidden as boolean), N = os.map((s) => (s.notes === null ? null : String(s.notes)));
    // expected after: dup(0) → move(last→0) → hide(1) → delete(2)
    let t = [T[0], ...T], h = [H[0], ...H], n = [N[0] && N[0].trim() ? N[0] : null, ...N];
    duplicateSlide(d, 0);
    ok(new Set(d.slides.map((x) => x.sldId)).size === d.slides.length && d.slides.every((x) => Number(x.sldId) >= 256), `${f}: duplicate slide id ${d.slides.map((x) => x.sldId)}`);
    const L = t.length - 1; t = [t[L], ...t.slice(0, L)]; h = [h[L], ...h.slice(0, L)]; n = [n[L], ...n.slice(0, L)]; moveSlide(d, L, 0);
    h[1] = true; setHidden(d, 1, true);
    t.splice(2, 1); h.splice(2, 1); n.splice(2, 1); deleteSlide(d, 2);
    const outB = await writePptxDoc(d); writeFileSync(join(outDir, f), outB); exp.set(f, { texts: t, hidden: h, notes: n });
    // deleting a slide must not leave media nobody references (beyond what the original already had)
    ok(await orphanMedia(outB) <= await orphanMedia(bytesOf(f)), `${f}: media orphaned by the slide delete`);
  }
  const outs = [...exp.keys()].map((f) => join(outDir, f)); const probes = py("pptx_probe.py", outs); const vals = py("pptx_validate.py", outs); const bad: string[] = [];
  for (const p of probes) {
    const f = String(p.file).split("/").pop()!; const e = exp.get(f)!; if (p.error) { bad.push(`${f}: python-pptx ${p.error}`); continue; }
    const ps = p.slides as Record<string, unknown>[];
    if (ps.length !== e.texts.length) { bad.push(`${f}: ${ps.length} slides, expected ${e.texts.length}`); continue; }
    ps.forEach((s, i) => {
      if (flatText(s.shapes as Record<string, unknown>[]) !== e.texts[i]) bad.push(`${f}#${i}: text differs`);
      if (s.hidden !== e.hidden[i]) bad.push(`${f}#${i}: hidden ${s.hidden} expected ${e.hidden[i]}`);
      const want = e.notes[i]; const got = s.notes === null ? null : String(s.notes);
      if ((want ?? "") !== (got ?? "")) bad.push(`${f}#${i}: notes ${JSON.stringify(got).slice(0, 50)} expected ${JSON.stringify(want).slice(0, 50)}`);
    });
  }
  vals.forEach((v) => { const f = String(v.file).split("/").pop()!; const np = newProblems(f, v.problems); if (np.length) bad.push(`${f}: ${np.slice(0, 3).join("; ")}`); });
  console.log(`  slide ops: ${exp.size} decks, ${bad.length} problems`);
  ok(exp.size >= 25, `only ${exp.size} decks`); ok(bad.length === 0, bad.slice(0, 12).join("\n"));
});

await test("duplicated slide with a chart gets a deep copy (own chart part + embedded workbook), deleting the original removes only its own chart; deleting a slide drops links to it from other slides, its notes slide, custom-show entries and section ids", COV, async () => {
  const charty = good.filter((f) => /chart/i.test(f));
  let checked = 0, ownedChecked = 0;
  for (const f of charty) {
    const d = await readPptxDoc(bytesOf(f), f);
    const si = d.slides.findIndex((s) => s.relsXml.root.kids.some((k) => k.k === "el" && /\/chart$/.test(attr(k, "Type") ?? ""))); if (si < 0) continue;
    const chartsOf = (i: number) => d.slides[i].relsXml.root.kids.filter((k): k is XEl => k.k === "el" && /\/chart$/.test(attr(k, "Type") ?? "")).map((k) => attr(k, "Target")!);
    const before = chartsOf(si); const j = duplicateSlide(d, si); const dup = chartsOf(j);
    ok(dup.length === before.length && dup.every((t) => !before.includes(t)), `${f}: duplicate shares chart parts ${before} / ${dup}`);
    deleteSlide(d, si);
    const out = await writePptxDoc(d); const p = join(tmp, `chartdup-${f}`); writeFileSync(p, out);
    const [v] = py("pptx_validate.py", [p]); const np = newProblems(f, v.problems); ok(np.length === 0, `${f}: ${np.join("; ")}`);
    const z = openZip(out); for (const t of dup) ok(z.entries.some((e) => e.name === "ppt/" + t.replace(/^\.\.\//, "")), `${f}: duplicated chart part ${t} missing`);
    // …and the chart's own parts (embedded workbook, style, colours) are copies too, so editing one chart's data cannot change the other
    const ownedOf = async (t: string) => { const cp = "ppt/" + t.replace(/^\.\.\//, ""); const rels = await z.read(cp.replace(/([^/]+)$/, "_rels/$1.rels")); return rels ? [...new TextDecoder().decode(rels).matchAll(/Target="([^"]+)"/g)].map((m) => m[1]).filter((x) => !/^[a-z]+:/i.test(x) && !/(^|\/)media\//.test(x)) : []; }; // media is shared by design
    const origOwned = new Set((await Promise.all(before.map(ownedOf))).flat()); const dupOwned = (await Promise.all(dup.map(ownedOf))).flat();
    ok(dupOwned.every((x) => !origOwned.has(x)), `${f}: duplicated chart shares ${dupOwned.filter((x) => origOwned.has(x))}`); if (dupOwned.length) ownedChecked++;
    checked++;
  }
  ok(checked >= 3, `only ${checked} chart decks`); ok(ownedChecked >= 3, `only ${ownedChecked} charts own parts`);
  // links + sections: synthetic deck from the blank template
  const d = await readPptxDoc(await blankPptx("Links"), "l.pptx"); const lay = layoutsOf(d)[1].path; addSlideFromLayout(d, 1, lay); addSlideFromLayout(d, 2, lay);
  const s0 = mutSlide(d, 0); const target = d.slides[2];
  const rid = "rId99"; s0.relsXml.root.kids.push(parseXml(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="${target.path.split("/").pop()}"/>`).root);
  const tb = addShape(d, 0, "textbox", { x: 0, y: 0, cx: 1e6, cy: 3e5 }, "go");
  const r = runsOf(paragraphsOf(bodyAt(mutSlide(d, 0).xml, tb)!)[0])[0]; kid(r.el, "a:rPr")!.kids.push(parseXml(`<a:hlinkClick xmlns:a="a" xmlns:r="r" r:id="${rid}" action="ppaction://hlinksldjump"/>`).root); kid(r.el, "a:rPr")!.selfClose = false;
  setNotesText(d, 2, "to be deleted");
  // a picture only the doomed slide uses: its media part must go with it
  const uniq = Uint8Array.from(PNG); uniq[uniq.length - 13] ^= 0; addPicture(d, 2, uniq, "png", { x: 0, y: 0, cx: 2e5, cy: 2e5 });
  ok([...d.zip.keys(), ...d.dirty].some((k) => /^ppt\/media\//.test(k)), "picture part not added");
  deleteSlide(d, 2);
  const out = await writePptxDoc(d); const p = join(tmp, "links.pptx"); writeFileSync(p, out);
  const [v] = py("pptx_validate.py", [p]); ok(v.ok, v.problems.join("; "));
  ok(!/hlinkClick/.test(new TextDecoder().decode((await openZip(out).read("ppt/slides/slide1.xml"))!)), "dangling slide link kept");
  ok(!openZip(out).entries.some((e) => /notesSlide/.test(e.name)), "deleted slide's notes kept");
  ok(!openZip(out).entries.some((e) => /^ppt\/media\//.test(e.name)), `deleted slide's picture kept: ${openZip(out).entries.map((e) => e.name).filter((n) => /media/.test(n))}`);
});

await test("speaker notes: setting notes on a slide without a notes slide creates one (and a notes master + theme when the deck has none) on every corpus deck; python-pptx reads the exact text including markup characters and line breaks; editing existing notes keeps the notes slide", COV, async () => {
  const outDir = join(tmp, "notes"); mkdirSync(outDir, { recursive: true }); const NOTE = "TT51 note <b>&amp; \"quoted\" ✓\nsecond line";
  for (const f of good) { const d = await readPptxDoc(bytesOf(f), f); if (!d.slides.length) continue; setNotesText(d, d.slides.length - 1, NOTE); writeFileSync(join(outDir, f), await writePptxDoc(d)); }
  const outs = good.map((f) => join(outDir, f)).filter(existsSync); const bad: string[] = [];
  py("pptx_probe.py", outs).forEach((p) => { const ss = p.slides as Record<string, unknown>[]; if (String(ss[ss.length - 1].notes) !== NOTE) bad.push(`${p.file}: notes ${JSON.stringify(ss[ss.length - 1].notes)}`); });
  py("pptx_validate.py", outs).forEach((v) => { const f = String(v.file).split("/").pop()!; const np = newProblems(f, v.problems); if (np.length) bad.push(`${f}: ${np.slice(0, 3).join("; ")}`); });
  const noMaster = good.filter((f) => !openZip(bytesOf(f)).entries.some((e) => /notesMaster/.test(e.name)));
  console.log(`  notes: ${outs.length} decks (${noMaster.length} had no notes master), ${bad.length} problems`);
  ok(noMaster.length > 0, "corpus has no deck without a notes master (test would not exercise creation)"); ok(bad.length === 0, bad.slice(0, 10).join("\n"));
});

await test("shape operations on every corpus deck: add text box + preset shape + picture, move/resize, fill/outline, z-order, delete a picture (its media part is garbage-collected when unused) — python-pptx sees the shapes at the written geometry and shape ids stay unique", COV, async () => {
  const outDir = join(tmp, "shapes"); mkdirSync(outDir, { recursive: true }); const exp = new Map<string, { si: number; count: number; moved?: [number, number[]] }>(); let gcChecked = 0;
  for (const f of good) {
    const d = await readPptxDoc(bytesOf(f), f); if (!d.slides.length) continue; const si = 0;
    const before = shapeKids(spTreeOf(d.slides[si].xml)).filter((e) => PY_TAGS.has(e.name)).length;
    const tb = addShape(d, si, "textbox", { x: 457200, y: 457200, cx: 3e6, cy: 5e5 }, "Hello TT51");
    const st = addShape(d, si, "star5", { x: 1e6, y: 1e6, cx: 1e6, cy: 1e6 });
    setShapeFill(d, si, st, "#22AA88"); setShapeLine(d, si, st, "#112233", 2);
    addPicture(d, si, PNG, "png", { x: 2e6, y: 2e6, cx: 5e5, cy: 5e5 });
    setXfrm(d, si, tb, { x: 600000, y: 700000, cx: 3100000, cy: 520000 });
    const nt = zOrder(d, si, st, "back"); ok(nt === "0", `z-order path ${nt}`);
    const starName = attr(cNvPrOf(shapeKids(spTreeOf(d.slides[si].xml))[0]), "name");
    const nf = zOrder(d, si, nt, "front"); const ks = shapeKids(spTreeOf(d.slides[si].xml));
    ok(nf === String(ks.length - 1) && attr(cNvPrOf(ks[ks.length - 1]), "name") === starName, `${f}: bring to front → ${nf} of ${ks.length}`);
    const tbIdx = shapeKids(spTreeOf(d.slides[si].xml)).findIndex((e) => attr(cNvPrOf(e), "name")?.startsWith("TextBox") && paragraphsOf(txBodyOf(e)).map(paraText).join() === "Hello TT51");
    exp.set(f, { si, count: before + 3, moved: [tbIdx, [600000, 700000, 3100000, 520000]] });
    // delete an existing picture somewhere and check the media GC
    for (let i = 0; i < d.slides.length && gcChecked < 30; i++) {
      const ks = shapeKids(spTreeOf(d.slides[i].xml)); const k = ks.findIndex((e) => e.name === "p:pic"); if (k < 0) continue;
      const rid = attr(((): XEl | undefined => { const w = (x: XEl): XEl | undefined => x.name === "a:blip" ? x : x.kids.map((c) => (c.k === "el" ? w(c) : undefined)).find(Boolean); return w(ks[k]); })(), "r:embed");
      const rel = d.slides[i].relsXml.root.kids.find((x): x is XEl => x.k === "el" && attr(x, "Id") === rid); if (!rel) break;
      const media = "ppt/" + String(attr(rel, "Target")).replace(/^\.\.\//, "");
      const usedElsewhere = (() => { let c = 0; for (const s of d.slides) for (const r of s.relsXml.root.kids) if (r.k === "el" && /\/image$/.test(attr(r, "Type") ?? "") && ("ppt/" + String(attr(r, "Target")).replace(/^\.\.\//, "")) === media) c++; return c > 1; })()
        || (serializeEl(d.slides[i].xml.root).split(`r:embed="${rid}"`).length - 1) > 1 // several pictures share one relationship
        || [...d.zip.keys()].some((z) => z.endsWith(".rels") && !/slides\/_rels/.test(z) && new TextDecoder().decode(d.zip.get(z)!).includes(media.split("/").pop()!));
      deleteShape(d, i, String(k));
      ok(d.removed.has(media) !== usedElsewhere, `${f}: media ${media} gc wrong (used elsewhere: ${usedElsewhere})`);
      if (i === si) exp.get(f)!.count--, exp.get(f)!.moved = undefined;
      gcChecked++; break;
    }
    writeFileSync(join(outDir, f), await writePptxDoc(d));
  }
  const outs = [...exp.keys()].map((f) => join(outDir, f)); const bad: string[] = [];
  py("pptx_probe.py", outs).forEach((p) => {
    const f = String(p.file).split("/").pop()!; const e = exp.get(f)!; const sh = (p.slides as Record<string, unknown>[])[e.si].shapes as Record<string, unknown>[];
    if (sh.length !== e.count) bad.push(`${f}: ${sh.length} shapes, expected ${e.count}`);
    if (!sh.some((s) => JSON.stringify(s.text) === JSON.stringify(["Hello TT51"]))) bad.push(`${f}: text box missing`);
    if (e.moved) { const s = sh.find((x) => JSON.stringify(x.text) === JSON.stringify(["Hello TT51"])); if (s && JSON.stringify(s.geo) !== JSON.stringify(e.moved[1])) bad.push(`${f}: moved geo ${JSON.stringify(s.geo)}`); }
  });
  py("pptx_validate.py", outs).forEach((v) => { const f = String(v.file).split("/").pop()!; const np = newProblems(f, v.problems); if (np.length) bad.push(`${f}: ${np.slice(0, 3).join("; ")}`); });
  console.log(`  shape ops: ${outs.length} decks, media GC checked on ${gcChecked}, ${bad.length} problems`);
  ok(gcChecked >= 15, `gc checked ${gcChecked}`); ok(bad.length === 0, bad.slice(0, 12).join("\n"));
});

await test("undo is exact: a snapshot taken before a burst of edits (text, notes, slide ops, shapes, pictures) restores a package whose every part has the original content", COV, async () => {
  let n = 0;
  for (const f of good) {
    const b = bytesOf(f); const d = await readPptxDoc(b, f); if (d.slides.length < 2) continue;
    const snap = snapshot(d);
    const t = firstText(d); if (t) { const ps = shapeParagraphs(d.slides[t.si].xml, t.addr); ps[t.p] = "changed"; setShapeText(d, t.si, t.addr, ps); }
    setNotesText(d, 0, "undo me"); duplicateSlide(d, 1); deleteSlide(d, 0); addPicture(d, 0, PNG, "png", { x: 0, y: 0, cx: 1e5, cy: 1e5 }); moveSlide(d, 0, d.slides.length - 1);
    restore(d, snap);
    const out = await writePptxDoc(d); const zo = openZip(b), zn = openZip(out);
    const names = (z: ReturnType<typeof openZip>) => z.entries.map((e) => e.name).filter((x) => x !== "docProps/core.xml").sort();
    ok(JSON.stringify(names(zn)) === JSON.stringify(names(zo)), `${f}: part list differs after undo`);
    for (const e of zn.entries) { if (e.name === "docProps/core.xml") continue; const x = await zn.read(e.name), y = await zo.read(e.name); ok(Buffer.compare(Buffer.from(x!), Buffer.from(y!)) === 0, `${f}: ${e.name} differs after undo`); }
    // P1: edits that cancel out give back the original FILE, byte for byte (not a re-zip with a new modified date)
    ok(Buffer.compare(Buffer.from(out), Buffer.from(b)) === 0, `${f}: undo back to the opened state did not return the original bytes`);
    n++;
  }
  ok(n >= 33, `only ${n}`);
});

await test("new decks: blankPptx is a valid 16:9 package (validator clean, python-pptx opens it, 4 layouts); a slide from every layout validates; an outline (legacy .fdeck) converts to a real deck with titles, bullets and notes", COV, async () => {
  const d = await readPptxDoc(await blankPptx("Brand new"), "n.pptx"); ok(d.size.cx === 12192000 && d.size.cy === 6858000, "size");
  const lays = layoutsOf(d); ok(lays.length === 4, `layouts ${lays.map((l) => l.name)}`);
  lays.forEach((l, k) => addSlideFromLayout(d, k + 1, l.path));
  const p = join(tmp, "blank.pptx"); writeFileSync(p, await writePptxDoc(d));
  const [v] = py("pptx_validate.py", [p]); ok(v.ok, v.problems.join("; "));
  const [o] = py("pptx_probe.py", [p]); ok((o.slides as unknown[]).length === 5 && o.layouts === 4, JSON.stringify(o).slice(0, 300));
  ok(JSON.stringify((o.slides as Record<string, unknown>[]).map((s) => s.layout)) === JSON.stringify(["Title Slide", ...lays.map((l) => l.name)]), "layout names");
  const out = await pptxFromOutline("Legacy", [{ title: "One", body: ["a", "b"], notes: "n1" }, { title: "Two & <three>", body: ["c"] }]);
  const q = join(tmp, "outline.pptx"); writeFileSync(q, out);
  const [v2] = py("pptx_validate.py", [q]); ok(v2.ok, v2.problems.join("; "));
  const [o2] = py("pptx_probe.py", [q]); const ss = o2.slides as Record<string, unknown>[];
  ok(ss.length === 2 && JSON.stringify(ss.map((x) => (x.shapes as Record<string, unknown>[]).map((y) => y.text))) === JSON.stringify([[["One"], ["a", "b"]], [["Two & <three>"], ["c"]]]) && ss[0].notes === "n1" && ss[1].notes === null, JSON.stringify(ss).slice(0, 400));
});

await test("password-protected decks: our Agile-encrypted save decrypts with msoffcrypto-tool to the exact package, and our decryptor opens it again; the encrypted file is a CFB container, not a zip", COV, async () => {
  const d = await readPptxDoc(bytesOf("SampleShow.pptx"), "SampleShow.pptx"); setNotesText(d, 0, "secret notes");
  const plain = await writePptxDoc(d); const enc = encryptOffice(plain, "Tr0ub4dor&3", { spinCount: 1000 });
  ok(isEncryptedOffice(enc), "not detected as encrypted"); let zipOk = true; try { openZip(enc); } catch { zipOk = false; } ok(!zipOk, "encrypted file opens as zip");
  const p = join(tmp, "enc.pptx"), q = join(tmp, "dec.pptx"); writeFileSync(p, enc);
  execFileSync(PY, ["-c", `import msoffcrypto,sys\nf=msoffcrypto.OfficeFile(open(sys.argv[1],'rb'));f.load_key(password=sys.argv[3]);f.decrypt(open(sys.argv[2],'wb'))`, p, q, "Tr0ub4dor&3"]);
  ok(Buffer.compare(readFileSync(q), Buffer.from(plain)) === 0, "msoffcrypto output differs");
  const back = decryptOffice(enc, "Tr0ub4dor&3"); const d2 = await readPptxDoc(back.bytes, "x.pptx"); ok(notesText(d2, 0) === "secret notes", "notes after decrypt");
});

await test("hostile input: the 12 corpus files python-pptx also rejects (fuzzer cases, bad CRC, truncated zip) fail with a clear error; billion-laughs DOCTYPE text is not expanded; target paths cannot climb out of the package; a sldIdLst with missing / duplicate / external slides opens what is valid; 5,000-deep group nesting and > 2,000 slides are refused or capped without crashing", COV, async () => {
  const rejects = files.filter((f) => BAD.test(f)); ok(rejects.length === 12, `bad files ${rejects.length}`);
  for (const f of rejects) { let err = ""; const t0 = Date.now(); try { await readPptxDoc(bytesOf(f), f); } catch (e) { err = (e as Error).message; } ok(/pptx|zip/.test(err), `${f}: ${err || "accepted"}`); ok(Date.now() - t0 < 5000, `${f} slow`); }
  const base = await blankPptx("Hostile"); const z = openZip(base); const parts = new Map<string, Uint8Array>(); for (const e of z.entries) parts.set(e.name, (await z.read(e.name))!);
  const build = async (mut: (m: Map<string, Uint8Array>) => void) => { const m = new Map(parts); mut(m); return writeZip([...m].map(([name, data]) => ({ name, data }))); };
  const td = new TextDecoder(), te = new TextEncoder();
  // billion laughs: entities must not expand (our parser never resolves DTD entities)
  let b = await build((m) => { const s = td.decode(m.get("ppt/slides/slide1.xml")!); m.set("ppt/slides/slide1.xml", te.encode(s.replace("<p:sld ", `<!DOCTYPE p:sld [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><p:sld `).replace(/<a:endParaRPr/, "<a:r><a:t>&c;</a:t></a:r><a:endParaRPr"))); });
  let d = await readPptxDoc(b, "bl.pptx"); const txt = shapeKids(spTreeOf(d.slides[0].xml)).map((e) => (txBodyOf(e) ? paragraphsOf(txBodyOf(e)).map(paraText).join() : "")).join(); ok(txt.length < 200, `entity expanded (${txt.length})`);
  // path traversal in a relationship target
  b = await build((m) => { m.set("ppt/slides/_rels/slide1.xml.rels", te.encode(td.decode(m.get("ppt/slides/_rels/slide1.xml.rels")!).replace("</Relationships>", `<Relationship Id="rId77" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../../../../../etc/passwd"/></Relationships>`))); });
  d = await readPptxDoc(b, "tr.pptx"); slideView(d, d.slides[0]); deleteSlide(d, 0); const w = await writePptxDoc(d); ok(!openZip(w).entries.some((e) => e.name.includes("..") || e.name.startsWith("/") || e.name.includes("etc/passwd")), "escaped path written");
  // sldIdLst: missing part, duplicate entry, external target
  b = await build((m) => { m.set("ppt/presentation.xml", te.encode(td.decode(m.get("ppt/presentation.xml")!).replace(/(<p:sldId [^>]*\/>)/, `$1<p:sldId id="400" r:id="rId900"/>$1`))); });
  d = await readPptxDoc(b, "ids.pptx"); ok(d.slides.length === 1 && d.warnings.length === 2, `slides ${d.slides.length} warnings ${d.warnings}`);
  // deep nesting
  b = await build((m) => { const s = td.decode(m.get("ppt/slides/slide1.xml")!); const g = (n: number) => `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${n + 10}" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>`; m.set("ppt/slides/slide1.xml", te.encode(s.replace("</p:spTree>", Array.from({ length: 5000 }, (_, i) => g(i)).join("") + "</p:grpSp>".repeat(5000) + "</p:spTree>"))); });
  let deepErr = ""; try { d = await readPptxDoc(b, "deep.pptx"); for (const s of d.slides) slideView(d, s); } catch (e) { deepErr = (e as Error).message; }
  ok(deepErr === "" || /deep|nest|depth|stack/i.test(deepErr), `deep nesting: ${deepErr}`);
  // too many slides
  b = await build((m) => { const s = td.decode(m.get("ppt/presentation.xml")!); const ids = Array.from({ length: MAX_SLIDES + 5 }, (_, i) => `<p:sldId id="${300 + i}" r:id="rIdS${i}"/>`).join(""); m.set("ppt/presentation.xml", te.encode(s.replace(/<p:sldIdLst>.*<\/p:sldIdLst>/s, `<p:sldIdLst>${ids}</p:sldIdLst>`)));
    const r = td.decode(m.get("ppt/_rels/presentation.xml.rels")!); m.set("ppt/_rels/presentation.xml.rels", te.encode(r.replace("</Relationships>", Array.from({ length: MAX_SLIDES + 5 }, (_, i) => `<Relationship Id="rIdS${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>`).join("") + "</Relationships>"))); });
  d = await readPptxDoc(b, "many.pptx"); ok(d.slides.length <= MAX_SLIDES, `opened ${d.slides.length}`);
  // zip bomb with a lying header: 64 MiB of zeros declared as 1,000 bytes → refused while inflating, never materialised
  const zb = new Uint8Array(await build((m) => m.set("ppt/media/bomb.bin", new Uint8Array(64 << 20))));
  const nameB = te.encode("ppt/media/bomb.bin"); const dv = new DataView(zb.buffer);
  for (let o = 0; o < zb.length - 50; o++) {
    const sig = dv.getUint32(o, true); const at = sig === 0x04034b50 ? 30 : sig === 0x02014b50 ? 46 : -1; if (at < 0) continue;
    if (nameB.every((c, k) => zb[o + at + k] === c)) dv.setUint32(o + (sig === 0x04034b50 ? 22 : 24), 1000, true);
  }
  ok(zb.length < (2 << 20), `bomb not compressed (${zb.length})`);
  let bombErr = ""; try { await readPptxDoc(zb, "bomb.pptx"); } catch (e) { bombErr = (e as Error).message; }
  ok(/inflates beyond|guard|mismatch/.test(bombErr), `bomb: ${bombErr || "accepted"}`);
  // part-count guard: 20,001 tiny entries are refused before any XML is parsed
  const many = await build((m) => { for (let i = 0; i <= 20_000; i++) m.set(`ppt/media/x${i}.bin`, new Uint8Array(0)); });
  let manyErr = ""; try { await readPptxDoc(many, "parts.pptx"); } catch (e) { manyErr = (e as Error).message; }
  ok(/too many (parts|entries)/.test(manyErr), `part-count guard: ${manyErr || "accepted"}`); // zipkit and pml both cap at 20,000
  // size guard: a 65 MiB input is refused by size, before the zip reader runs
  let bigErr = ""; try { await readPptxDoc(new Uint8Array(65 << 20), "big.pptx"); } catch (e) { bigErr = (e as Error).message; }
  ok(/64 MiB/.test(bigErr), `size guard: ${bigErr || "accepted"}`);
});

await test("colour maths and numbering against Office's documented values: Accent 1 (4472C4) lumMod 75 % = 2F5597 ('Darker 25 %'), lumMod 20 % + lumOff 80 % = DAE3F3 ('Lighter 80 %'), tint/shade/alpha, clrMap bg1→lt1; auto-numbers arabic / alpha / roman with all punctuation styles", COV, async () => {
  const ctx = { theme: { colors: { accent1: "4472C4", lt1: "FFFFFF", dk1: "000000" } }, map: { bg1: "lt1", tx1: "dk1" } } as never;
  const C = (x: string) => V.colorOf(parseXml(x).root, ctx);
  ok(C(`<a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr>`)?.toUpperCase() === "#2F5597", String(C(`<a:schemeClr val="accent1"><a:lumMod val="75000"/></a:schemeClr>`)));
  ok(C(`<a:schemeClr val="accent1"><a:lumMod val="20000"/><a:lumOff val="80000"/></a:schemeClr>`)?.toUpperCase() === "#DAE3F3", String(C(`<a:schemeClr val="accent1"><a:lumMod val="20000"/><a:lumOff val="80000"/></a:schemeClr>`)));
  ok(C(`<a:schemeClr val="bg1"/>`) === "#ffffff" && C(`<a:schemeClr val="tx1"/>`) === "#000000", "clrMap");
  ok(C(`<a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr>`) === "rgba(255,0,0,0.500)", "alpha");
  ok(C(`<a:srgbClr val="000000"><a:tint val="50000"/></a:srgbClr>`) === "#808080", String(C(`<a:srgbClr val="000000"><a:tint val="50000"/></a:srgbClr>`)));
  ok(C(`<a:prstClr val="white"><a:shade val="50000"/></a:prstClr>`) === "#808080", "shade");
  ok(C(`<a:sysClr val="windowText" lastClr="000000"/>`) === "#000000", "sysClr");
  ok(autoNum("arabicPeriod", 3) === "3." && autoNum("alphaUcParenR", 28) === "AB)" && autoNum("romanLcParenBoth", 14) === "(xiv)" && autoNum("romanUcPeriod", 1999) === "MCMXCIX." && autoNum("arabicPlain", 7) === "7", "autonum");
});

await test("view model over the corpus: placeholders inherit layout/master geometry, theme colours resolve for every text run (no undefined colours or fonts), pictures map to package parts with crops, tables carry their grid, charts point at chart parts, SmartArt draws its saved drawing; approximate presets are reported, never silent", COV, async () => {
  let runs = 0, pics = 0, tables = 0, charts = 0, smart = 0, approx = 0; const bad: string[] = [];
  for (const f of good) {
    const d = await readPptxDoc(bytesOf(f), f);
    for (const s of d.slides) {
      const v = slideView(d, s);
      const walk = (xs: ReturnType<typeof slideView>["shapes"]) => { for (const x of xs) {
        if (!Number.isFinite(x.x + x.y + x.w + x.h)) bad.push(`${f} ${x.name}: non-finite geometry`);
        for (const p of x.text?.paras ?? []) for (const r of p.runs) { runs++; if (!r.color || !r.font || !(r.sz > 0)) bad.push(`${f} ${x.name}: run ${JSON.stringify(r).slice(0, 80)}`); }
        if (x.img?.part) { pics++; if (!d.zip.has(x.img.part)) bad.push(`${f}: picture part ${x.img.part} missing`); }
        if (x.table) { tables++; if (!x.table.cols.length) bad.push(`${f}: table without grid`); }
        if (x.chart) { charts++; if (!d.zip.has(x.chart.part)) bad.push(`${f}: chart part missing`); }
        if (x.note?.startsWith("SmartArt") && x.children?.length) smart++;
        if (x.geom?.approx && !x.note) bad.push(`${f}: silent approximation ${x.geom.name}`); if (x.geom?.approx) approx++;
        if (x.children) walk(x.children);
      } };
      walk(v.shapes);
    }
  }
  console.log(`  view: ${runs} runs, ${pics} pictures, ${tables} tables, ${charts} charts, ${smart} SmartArt drawings, ${approx} approximate presets (reported)`);
  ok(bad.length === 0, bad.slice(0, 10).join("\n")); ok(tables >= 30 && charts >= 20 && pics >= 100, "coverage too low");
});

finish();
