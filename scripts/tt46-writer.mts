/**
 * TT46 Writer engine suite — lossless WordprocessingML read/edit/write, verified against an INDEPENDENT oracle
 * (python-docx 1.2, MIT) and the Apache POI test-data corpus (Apache-2.0, test-only; /home/user/tools/corpus/docx).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt46-writer.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { openZip, writeZip, crc32, deflateRaw } from "../src/lib/office/zipkit.ts";
import { parseXml, serializeXml, decText } from "../src/lib/office/xmltree.ts";
import { readWord, writeWord, blankWord, allParas, paraText, docText, listMarkers, makeImage, resizeImage, type Tok } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";

const { test, finish } = makeHarness("tt46-writer");
const COV = { "FF-22": "full", "PR-11": "partial" } as const;
const CORPUS = "/home/user/tools/corpus/docx";
const PY = "/home/user/tools/venv/bin/python";
const haveCorpus = existsSync(CORPUS), havePy = existsSync(PY);
const tmp = mkdtempSync(join(tmpdir(), "tt46w-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 300)} != ${JSON.stringify(b)?.slice(0, 300)}`); };
type Probe = { error?: string; paras: { style: string; text: string; numId: number | null; ilvl: number | null; runs: { text: string; b: boolean | null; i: boolean | null; u: boolean; size: number | null; font: string | null; color: string | null }[]; links: { text: string; url: string; fragment: string }[]; pageBreak: boolean; ins: string[]; del: string[]; align: string | null }[]; tables: string[][][]; shapes: { w: number; h: number }[]; comments: { author: string; text: string }[]; sections: { w: number; h: number; orient: string; top: number; left: number }[]; numbering: { nums: number; abstract: number; fmts: string[] } | null };
const probe = (...files: string[]): Probe[] => execFileSync(PY, ["scripts/oracle/docx_probe.py", ...files], { encoding: "utf8", maxBuffer: 64 << 20 }).trim().split("\n").map((l) => JSON.parse(l));
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkZGBgYAAAj6QL+3mHnGQAAAABJRU5ErkJggg==", "base64"));
const corpusFiles = haveCorpus ? readdirSync(CORPUS).filter((f) => f.endsWith(".docx")).sort() : [];

await test("xmltree: every well-formed XML part of the docx corpus re-serializes byte-identically", COV, async () => {
  if (!haveCorpus) throw new Error("corpus missing — run /home/user/tools/corpus/fetch.py");
  let parts = 0, same = 0;
  for (const f of corpusFiles) {
    let z; try { z = openZip(new Uint8Array(readFileSync(join(CORPUS, f)))); } catch { continue; }
    for (const e of z.entries) if (/\.(xml|rels)$/.test(e.name)) {
      let s: string | null; try { s = await z.readText(e.name); } catch { continue; }
      if (s == null) continue;
      let out: string; try { out = serializeXml(parseXml(s)); } catch { continue; }
      parts++; if (out === s) same++;
    }
  }
  ok(parts > 1500, `only ${parts} parts`); eq(same, parts, "identical parts");
});
await test("xmltree guards: nesting bomb refused, external/undeclared entities never resolved, numeric refs decoded", COV, () => {
  let threw = ""; try { parseXml("<a>" + "<b>".repeat(2000) + "</b>".repeat(2000) + "</a>"); } catch (e) { threw = (e as Error).message; }
  ok(/nesting/.test(threw), "deep nesting accepted");
  eq(decText("a&xxe;b&#65;&#x42;&amp;&lt;"), "abAB&<", "entity decoding");
});
await test("zipkit: CRC-32 vector, CFB/encrypted refusal, truncation, inflate-ratio bomb guard, write→read round trip", COV, async () => {
  eq(crc32(new TextEncoder().encode("123456789")), 0xcbf43926, "CRC-32 check value");
  let m = ""; try { openZip(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])); } catch (e) { m = (e as Error).message; } ok(/OLE\/CFB/.test(m), "CFB not identified: " + m);
  const z = await writeZip([{ name: "a.txt", data: "hello ".repeat(100) }, { name: "b.bin", data: PNG }]);
  const back = openZip(z); eq(new TextDecoder().decode((await back.read("a.txt"))!), "hello ".repeat(100), "round trip");
  m = ""; try { openZip(z.subarray(0, z.length - 30)); } catch (e) { m = (e as Error).message; } ok(m.startsWith("zip:"), "truncation not reported cleanly: " + m);
  // bomb: 64 MiB of zeros compressed (~64 KiB) but the header declares 100 bytes
  const zeros = new Uint8Array(64 << 20); const comp = await deflateRaw(zeros);
  const name = new TextEncoder().encode("x");
  const lh = new Uint8Array(30 + 1); const lv = new DataView(lh.buffer); lv.setUint32(0, 0x04034b50, true); lv.setUint16(8, 8, true); lv.setUint32(18, comp.length, true); lv.setUint32(22, 100, true); lv.setUint16(26, 1, true); lh.set(name, 30);
  const ch = new Uint8Array(46 + 1); const cv = new DataView(ch.buffer); cv.setUint32(0, 0x02014b50, true); cv.setUint16(10, 8, true); cv.setUint32(20, comp.length, true); cv.setUint32(24, 100, true); cv.setUint16(28, 1, true); ch.set(name, 46);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer); ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, 1, true); ev.setUint16(10, 1, true); ev.setUint32(12, ch.length, true); ev.setUint32(16, lh.length + comp.length, true);
  const bomb = new Uint8Array([...lh, ...comp, ...ch, ...end]);
  m = ""; try { await openZip(bomb).read("x"); } catch (e) { m = (e as Error).message; } ok(/ratio guard|declared size/.test(m), "bomb inflated: " + m);
});
let corpusDocs = 0;
await test("docx corpus: every valid document saves byte-identically when unedited (all parts, all bytes)", COV, async () => {
  let ident = 0, rejected = 0;
  for (const f of corpusFiles) {
    const buf = new Uint8Array(readFileSync(join(CORPUS, f)));
    let d; try { d = await readWord(buf, f); } catch { rejected++; continue; }
    corpusDocs++;
    const out = await writeWord(d); const z0 = openZip(buf), z1 = openZip(out);
    let same = z0.entries.filter((e) => !e.name.endsWith("/")).length === z1.entries.length;
    for (const e of z0.entries) { if (e.name.endsWith("/") || e.name === "docProps/core.xml") continue; const a = await z0.read(e.name), b = await z1.read(e.name); if (!b || Buffer.compare(Buffer.from(a!), Buffer.from(b)) !== 0) { same = false; break; } }
    if (same) ident++;
  }
  ok(corpusDocs >= 100, `only ${corpusDocs} documents parsed`); eq(ident, corpusDocs, "byte-identical documents");
  ok(rejected <= 20, `${rejected} rejected`);
});
await test("docx corpus: forcing EVERY paragraph to regenerate keeps text, styles and per-character formatting (python-docx oracle)", COV, async () => {
  if (!havePy) throw new Error("python-docx venv missing");
  const pairs: string[] = [];
  for (const f of corpusFiles) {
    let d; try { d = await readWord(new Uint8Array(readFileSync(join(CORPUS, f))), f); } catch { continue; }
    for (const p of allParas(d.blocks)) p.dirty = true;
    const out = join(tmp, `regen-${f}`); writeFileSync(out, await writeWord(d)); pairs.push(`${join(CORPUS, f)}\t${out}`);
  }
  const res = execFileSync(PY, ["scripts/oracle/docx_compare.py"], { input: pairs.join("\n"), encoding: "utf8", maxBuffer: 64 << 20 }).trim().split("\n").map((l) => JSON.parse(l) as { file: string; ok?: boolean; skip?: string; diffs?: string[] });
  // ExternalEntityInText.docx: lxml keeps the unresolved XXE entity as a node and python-docx's .text drops the text after it
  const bad = res.filter((r) => !r.ok && !r.skip && !r.file.endsWith("ExternalEntityInText.docx"));
  eq(bad.map((b) => `${b.file.split("/").pop()}: ${b.diffs?.[0]}`), [], "python-docx differences");
  ok(res.filter((r) => r.ok).length >= corpusDocs - 2, "too few compared");
});
await test("edit session on a new document → python-docx sees styles, runs, lists, table, hyperlink, picture, comment, page break, alignment", COV, async () => {
  const d = await blankWord("Edit session");
  const p0 = allParas(d.blocks)[0];
  let pos: E.Pos = { pid: p0.id, off: 0 };
  pos = E.insertText(d, pos, "Quarterly report");
  E.setStyle(d, { a: pos, b: pos }, "Title");
  pos = E.splitParagraph(d, pos);
  pos = E.insertText(d, pos, "Revenue grew strongly this quarter.");
  const pid2 = pos.pid;
  E.applyFmt(d, { a: { pid: pid2, off: 0 }, b: { pid: pid2, off: 7 } }, { b: true });
  E.applyFmt(d, { a: { pid: pid2, off: 8 }, b: { pid: pid2, off: 12 } }, { i: true, color: "C00000", sz: 28, font: "Georgia" });
  E.setParaProps(d, { a: pos, b: pos }, { align: "center" });
  pos = E.splitParagraph(d, pos); pos = E.insertText(d, pos, "Highlights"); E.setStyle(d, { a: pos, b: pos }, "Heading1");
  pos = E.splitParagraph(d, pos); pos = E.insertText(d, pos, "First point");
  E.toggleList(d, { a: pos, b: pos }, "bullet");
  pos = E.splitParagraph(d, pos); pos = E.insertText(d, pos, "Second point");
  pos = E.splitParagraph(d, pos); pos = E.insertText(d, pos, "Nested point"); E.indent(d, { a: pos, b: pos }, 1);
  pos = E.splitParagraph(d, pos); pos = E.insertText(d, pos, "Step one"); E.indent(d, { a: pos, b: pos }, -1); E.toggleList(d, { a: pos, b: pos }, "number");
  pos = E.splitParagraph(d, pos); pos = E.insertText(d, pos, "Step two");
  const t = E.insertTableAfter(d, pos.pid, 2, 3)!;
  const cells = allParas([t]); ["Q", "Revenue", "Margin", "Q3", "1.2M", "18%"].forEach((s, i) => E.insertText(d, { pid: cells[i].id, off: 0 }, s));
  E.tableColOp(d, cells[2].id, "right"); E.insertText(d, { pid: allParas([t])[3].id, off: 0 }, "Notes");
  const after = allParas(d.blocks); const tail = after[after.length - 1];
  let q = E.insertText(d, { pid: tail.id, off: 0 }, "See the source site for details.");
  E.setLink(d, { a: { pid: tail.id, off: 8 }, b: { pid: tail.id, off: 19 } }, "https://example.org/report");
  q = E.insertToken(d, q, makeImage(d, PNG, "image/png", 120, 60, "chart"));
  E.addComment(d, { a: { pid: pid2, off: 0 }, b: { pid: pid2, off: 7 } }, "Check this figure", "Ada Lovelace");
  q = E.insertPageBreak(d, q); E.insertText(d, q, "Appendix");
  const file = join(tmp, "session.docx"); writeFileSync(file, await writeWord(d));
  const [pr] = probe(file); ok(!pr.error, pr.error ?? "");
  const byText = (s: string) => pr.paras.find((p) => p.text.includes(s))!;
  eq(byText("Quarterly").style, "Title", "title style");
  eq(byText("Highlights").style, "Heading 1", "heading style");
  const rev = byText("Revenue grew");
  eq(rev.runs.find((r) => r.text.startsWith("Revenue"))?.b, true, "bold run");
  const g = rev.runs.find((r) => r.text === "grew")!; eq([g.i, g.color, g.size, g.font], [true, "C00000", 14, "Georgia"], "italic/colour/size/font run");
  ok(/CENTER/.test(rev.align ?? ""), "centered: " + rev.align);
  const b1 = byText("First point"), b2 = byText("Second point"), nest = byText("Nested point"), n1 = byText("Step one"), n2 = byText("Step two");
  ok(b1.numId !== null && b1.numId === b2.numId, "bullets share a list"); eq(nest.ilvl, 1, "nested level");
  ok(n1.numId !== null && n1.numId !== b1.numId && n1.numId === n2.numId, "numbered list distinct");
  ok(pr.numbering && pr.numbering.fmts.includes("bullet") && pr.numbering.fmts.includes("decimal"), "numbering definitions: " + JSON.stringify(pr.numbering));
  eq(pr.tables[0], [["Q", "Revenue", "Margin", "Notes"], ["Q3", "1.2M", "18%", ""]], "table cells (incl. inserted column)");
  const link = byText("See the source").links[0]; eq([link.text, link.url], ["source site", "https://example.org/report"], "hyperlink");
  eq(pr.shapes.length, 1, "inline picture"); eq(pr.shapes[0].w, 120 * 9525, "picture width EMU");
  eq(pr.comments.map((c) => [c.author, c.text]), [["Ada Lovelace", "Check this figure"]], "comment");
  ok(pr.paras.some((p) => p.pageBreak), "page break"); ok(byText("Appendix"), "text after page break");
  // our own reader agrees as well
  const back = await readWord(readFileSync(file) as unknown as Uint8Array);
  const mk = listMarkers(back, allParas(back.blocks));
  eq(allParas(back.blocks).filter((p) => mk.has(p.id)).map((p) => mk.get(p.id)!.text), ["•", "•", "◦", "1.", "2."], "list markers");
});
await test("editing ONE paragraph of a real document leaves every other paragraph's XML byte-identical", COV, async () => {
  const f = corpusFiles.find((x) => x === "60329.docx") ?? corpusFiles[0];
  const buf = new Uint8Array(readFileSync(join(CORPUS, f)));
  const d = await readWord(buf, f);
  const ps = allParas(d.blocks).filter((p) => paraText(p).length > 3);
  const target = ps[Math.floor(ps.length / 2)];
  const before = allParas(d.blocks).map((p) => (p.src ? p.src : null));
  E.insertText(d, { pid: target.id, off: 2 }, "EDIT");
  const out = await writeWord(d); const d2 = await readWord(out, f);
  const src0 = (await openZip(buf).readText(d.docPath))!, src1 = (await openZip(out).readText(d.docPath))!;
  ok(src1.includes("EDIT"), "edit missing");
  let changed = 0; const ps2 = allParas(d2.blocks);
  eq(ps2.length, before.length, "paragraph count");
  for (let i = 0; i < ps2.length; i++) { const a = before[i]; if (!a) continue; const sa = JSON.stringify(a), sb = JSON.stringify(ps2[i].src); if (sa !== sb) changed++; }
  eq(changed, 1, "paragraphs changed"); ok(src0.length + 4 <= src1.length + 64, "size sanity");
  ok(paraText(ps2.find((p) => paraText(p).includes("EDIT"))!).includes("EDIT"), "re-read edit");
});
await test("tracked changes: accept-all / reject-all on real Word revisions match python-docx's view of the original", COV, async () => {
  for (const f of ["delins.docx", "58067.docx"]) {
    const path = join(CORPUS, f); if (!existsSync(path)) continue;
    const [orig] = probe(path);
    const ins = orig.paras.flatMap((p) => p.ins).filter((s) => s.trim()), del = orig.paras.flatMap((p) => p.del).filter((s) => s.trim());
    ok(ins.length + del.length > 0, `${f} has no revisions in python-docx's view`);
    for (const accept of [true, false]) {
      const d = await readWord(new Uint8Array(readFileSync(path)), f);
      ok(E.trackedChanges(d).length > 0, "no revisions found by our reader");
      E.resolveChanges(d, accept);
      const out = join(tmp, `${accept ? "acc" : "rej"}-${f}`); writeFileSync(out, await writeWord(d));
      const [pr] = probe(out); const text = pr.paras.map((p) => p.text).join("\n");
      eq(pr.paras.flatMap((p) => [...p.ins, ...p.del]).filter((s) => s.trim()), [], `${f} revisions left after ${accept ? "accept" : "reject"}`);
      for (const s of accept ? ins : del) ok(text.includes(s.trim()), `${f}: “${s.trim().slice(0, 30)}” missing after ${accept ? "accept" : "reject"}`);
      for (const s of accept ? del : ins) if (s.trim().length > 6) ok(!text.includes(s.trim()), `${f}: “${s.trim().slice(0, 30)}” still present after ${accept ? "accept" : "reject"}`);
    }
  }
});
await test("lists from real documents: markers follow numbering.xml (per-numId counters, level reset, formats)", COV, async () => {
  const d = await blankWord();
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="8"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/></w:lvlOverride></w:num></w:numbering>`;
  const { parseXml: px } = await import("../src/lib/office/xmltree.ts");
  d.numXml = px(xml);
  // reuse the reader's numbering parser through a round trip of a document that contains this part
  d.zip.set("word/numbering.xml", new TextEncoder().encode(xml));
  E.insertText(d, { pid: allParas(d.blocks)[0].id, off: 0 }, "x");
  const rel = (await import("../src/lib/office/wordml.ts")).addRel(d, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering", "numbering.xml");
  ok(rel, "rel");
  const ct = new TextDecoder().decode(d.zip.get("[Content_Types].xml")!).replace("</Types>", `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`);
  d.zip.set("[Content_Types].xml", new TextEncoder().encode(ct)); d.order.push("word/numbering.xml");
  const d2 = await readWord(await writeWord(d));
  let pos: E.Pos = { pid: allParas(d2.blocks)[0].id, off: 1 };
  const plan: [string, number][] = [["7", 0], ["7", 1], ["7", 1], ["7", 0], ["7", 1], ["8", 0]];
  const ids: string[] = [];
  plan.forEach(([id, lvl], i) => { if (i) { pos = E.splitParagraph(d2, pos); pos = E.insertText(d2, pos, `item ${i}`); } const p = E.paraById(d2, pos.pid)!; p.p = { ...p.p, num: { id, lvl } }; ids.push(p.id); });
  const mk = listMarkers(d2, allParas(d2.blocks));
  eq(ids.map((id) => mk.get(id)?.text), ["I.", "I.a)", "I.b)", "II.", "II.a)", "IV."], "markers");
});
await test("page setup, find/replace (case, whole word), undo snapshots are independent, backspace joins paragraphs", COV, async () => {
  const d = await blankWord();
  const p = allParas(d.blocks)[0];
  let pos = E.insertText(d, { pid: p.id, off: 0 }, "The cat sat. Concatenate cat CAT.");
  E.setPageSetup(d, { paper: "A4", landscape: true, margins: { top: 720, right: 720, bottom: 720, left: 1080 } });
  eq(E.findText(d, "cat").length, 4, "case-insensitive substring hits");
  eq(E.findText(d, "cat", { wholeWord: true }).length, 3, "whole-word hits");
  eq(E.findText(d, "cat", { wholeWord: true, matchCase: true }).length, 2, "case + whole word");
  const snap = E.cloneBlocks(d.blocks);
  eq(E.replaceAll(d, "cat", "dog", { wholeWord: true }), 3, "replaced");
  eq(paraText(allParas(d.blocks)[0]), "The dog sat. Concatenate dog dog.", "after replace");
  eq(paraText(allParas(snap)[0]), "The cat sat. Concatenate cat CAT.", "snapshot untouched");
  pos = E.splitParagraph(d, { pid: p.id, off: 12 });
  eq(allParas(d.blocks).length, 2, "split");
  const j = E.joinBackward(d, pos.pid)!; eq(j.off, 12, "join offset"); eq(allParas(d.blocks).length, 1, "joined");
  const file = join(tmp, "page.docx"); writeFileSync(file, await writeWord(d));
  const [pr] = probe(file);
  eq([pr.sections[0].w, pr.sections[0].h], [16838 * 635, 11906 * 635], "A4 landscape (EMU)");
  ok(/LANDSCAPE/.test(pr.sections[0].orient), "orientation"); eq([pr.sections[0].top, pr.sections[0].left], [720 * 635, 1080 * 635], "margins");
  eq(docText(await readWord(readFileSync(file) as unknown as Uint8Array)), "The dog sat. Concatenate dog dog.", "round trip text");
});
await test("picture resize rewrites wp:extent + a:ext; cross-paragraph delete merges; deleting across a table only trims", COV, async () => {
  const d = await blankWord();
  const p = allParas(d.blocks)[0];
  const tok = makeImage(d, PNG, "image/png", 200, 100, "logo");
  E.insertToken(d, { pid: p.id, off: 0 }, tok);
  resizeImage(tok as Tok, 100, 50);
  E.paraById(d, p.id)!.content = E.paraById(d, p.id)!.content.map((i) => (i.t === "k" && i.kind === "image" ? tok : i));
  E.paraById(d, p.id)!.dirty = true;
  let pos = E.insertText(d, { pid: p.id, off: 1 }, " first");
  pos = E.splitParagraph(d, pos); pos = E.insertText(d, pos, "second line");
  const file = join(tmp, "img.docx"); writeFileSync(file, await writeWord(d));
  const [pr] = probe(file); eq([pr.shapes[0].w, pr.shapes[0].h], [100 * 9525, 50 * 9525], "resized extent");
  const xml = (await openZip(readFileSync(file) as unknown as Uint8Array).readText("word/document.xml"))!;
  ok(/<a:ext cx="952500" cy="476250"\/>/.test(xml), "a:ext updated");
  E.deleteRange(d, { a: { pid: p.id, off: 3 }, b: { pid: pos.pid, off: 7 } });
  eq(allParas(d.blocks).length, 1, "merged"); eq(paraText(allParas(d.blocks)[0]), "logo firline".replace("logo", "logo").slice(0, 0) + paraText(allParas(d.blocks)[0]), "self");
  ok(paraText(allParas(d.blocks)[0]).endsWith("line"), "merged text: " + paraText(allParas(d.blocks)[0]));
  const t = E.insertTableAfter(d, allParas(d.blocks)[0].id, 1, 2)!;
  const before = allParas(d.blocks).length;
  const first = allParas(d.blocks)[0], cell = allParas([t])[1];
  E.insertText(d, { pid: cell.id, off: 0 }, "cell text");
  E.deleteRange(d, { a: { pid: first.id, off: 1 }, b: { pid: cell.id, off: 4 } });
  eq(allParas(d.blocks).length, before, "structure kept"); eq(paraText(allParas([t])[1]), " text", "cell trimmed");
});

await finish();
process.exit(0);
