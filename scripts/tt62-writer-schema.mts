/**
 * TT62 Writer schema conformance — every document the editor writes is validated against the ECMA-376 transitional
 * XSDs by an INDEPENDENT oracle (scripts/oracle/ooxml_xsd.py: lxml XMLSchema after Markup-Compatibility processing).
 *  1. the oracle itself: it must reject known-bad shapes (wrong child order, unknown element, bad enumeration value,
 *     unknown non-ignorable namespace) and accept an ignorable-namespace extension (w14) — otherwise a green result
 *     would mean nothing;
 *  2. randomized editing sessions (every edit operation the Writer exposes: typing, deleting, splitting / joining,
 *     run + paragraph formatting, styles, lists, indents, links, page breaks, tabs, footnotes / endnotes (+ formatted
 *     note edits), comments, tables (+ rows / columns), page setup, headers / footers, images, find / replace, Track
 *     Changes on/off with accept / reject of single changes) on two starting points (our blank document and a
 *     python-docx document); the package is saved and validated every few steps;
 *  3. a kitchen-sink document (every run / paragraph property together, also under Track Changes) — the random sessions
 *     rarely combine properties, and only combinations exercise the CT_PPrBase sequence;
 *  4. the TT61 file-revision paths (cell insert / delete markers, accepted and rejected) are schema-valid;
 *  5. the POI .docx corpus round trip (with an edit) adds no schema error that the input did not already have.
 * Limit of the oracle (disclosed): the transitional schema makes run properties (EG_RPrBase) an unordered choice, so
 * rPr child ORDER is not checked by it (the TT62 rPr-order mutant is an equivalent mutant w.r.t. this schema).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt62-writer-schema.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, rowsOf, cellsOf, makeImage, type WordDoc, type Table } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { setHf, setDifferentFirst } from "../src/lib/office/hdrftr.ts";

const { test, finish } = makeHarness("tt62-writer-schema");
const COV = { "FF-45": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt62w-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
type Res = { parts: Record<string, string[]>; checked: number; skipped: string[]; ok: boolean };
let seq = 0;
const put = (b: Uint8Array, tag = "f") => { const f = join(tmp, `${tag}${seq++}.docx`); writeFileSync(f, b); return f; };
const validate = (files: string[]): Record<string, Res> => {
  const out: Record<string, Res> = {};
  for (let i = 0; i < files.length; i += 40) Object.assign(out, JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", ...files.slice(i, i + 40)], { encoding: "utf8", maxBuffer: 256 << 20 })));
  return out;
};
const bad = (r: Res) => Object.entries(r.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e.slice(0, 3).join(" | ")}`);
// a 2×2 PNG (red / green / blue / white), built byte by byte so the test needs no image library
const PNG = new Uint8Array(Buffer.from("89504e470d0a1a0a0000000d4948445200000002000000020802000000fdd49a73000000164944415478da63f8cfc0f01f0418fe830003030300003c0a05fb3e6e0f8f0000000049454e44ae426082", "hex"));

await test("the oracle is a real verifier: it rejects wrong child order, an unknown element, a bad enumeration value and an unknown non-ignorable namespace; it accepts a w14 extension declared ignorable", COV, async () => {
  const base = await writeWord(await blankWord("o"));
  const fx = (name: string, edit: string) => {
    const src = put(base, "base"); const dst = join(tmp, `${name}.docx`);
    execFileSync(PY, ["-c", `import zipfile,sys
zi=zipfile.ZipFile(sys.argv[1]); zo=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)
for it in zi.infolist():
    d=zi.read(it.filename)
    if it.filename=='word/document.xml':
        s=d.decode(); ${edit}; d=s.encode()
    zo.writestr(it,d)
zo.close()`, src, dst]);
    return dst;
  };
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const files = {
    order: fx("order", `s=s.replace('<w:body>','<w:body><w:p><w:r><w:t>a</w:t></w:r><w:pPr><w:jc w:val="left"/></w:pPr></w:p>',1)`),
    unknown: fx("unknown", `s=s.replace('<w:body>','<w:body><w:p><w:bogus/></w:p>',1)`),
    enum: fx("enum", `s=s.replace('<w:body>','<w:body><w:p><w:pPr><w:jc w:val="sideways"/></w:pPr></w:p>',1)`),
    foreign: fx("foreign", `s=s.replace('${W}','${W} xmlns:zz="urn:not-understood"',1).replace('<w:body>','<w:body><w:p><zz:thing/></w:p>',1)`),
    ignorable: fx("ignorable", `assert 'mc:Ignorable="w14"' in s; s=s.replace('<w:body>','<w:body><w:p w14:paraId="1A2B3C4D"><w14:custom/><w:r><w:t>x</w:t></w:r></w:p>',1)`),
    altcontent: fx("altcontent", `s=s.replace('${W}','${W} xmlns:wps="urn:x-not-understood"',1).replace('<w:body>','<w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><wps:shape/></mc:Choice><mc:Fallback><w:t>fallback</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>',1)`),
  };
  const r = validate(Object.values(files));
  const doc = (k: keyof typeof files) => r[files[k]].parts["word/document.xml"];
  ok(doc("order").some((e) => /pPr.*not expected/.test(e)), "order rejected: " + doc("order"));
  ok(doc("unknown").some((e) => /bogus.*not expected/.test(e)), "unknown element rejected");
  ok(doc("enum").some((e) => /sideways/.test(e)), "bad enumeration rejected: " + doc("enum"));
  ok(doc("foreign").some((e) => /not-understood/.test(e)), "unknown non-ignorable namespace rejected: " + doc("foreign"));
  ok(doc("ignorable").length === 0, "ignorable w14 accepted: " + doc("ignorable"));
  ok(doc("altcontent").length === 0, "AlternateContent → Fallback accepted: " + doc("altcontent"));
  const plain = validate([put(base, "plain")]);
  ok(Object.values(plain)[0].ok && Object.values(plain)[0].checked >= 5, "our blank document is valid: " + bad(Object.values(plain)[0]));
});

/** one random editing step; returns a label */
function step(d: WordDoc, rand: (n: number) => number, t: number): string {
  const paras = allParas(d.blocks); const p = paras[rand(paras.length)];
  const len = E.plen(p); const a = rand(len + 1), b = Math.min(len, a + rand(8));
  const R = { a: { pid: p.id, off: a }, b: { pid: p.id, off: b } };
  const words = ["alpha ", "Beta ", "gamma, ", "delta. ", "épsilon ", "Zeta\u00a0", "eta—theta "];
  const pick = rand(30);
  switch (pick) {
    case 0: case 1: case 2: E.insertText(d, R.a, words[rand(words.length)]); return "type";
    case 3: if (b > a) { E.deleteRange(d, R); return "delete"; } return "noop";
    case 4: E.splitParagraph(d, R.a); return "split";
    case 5: if (paras.indexOf(p) > 0) { E.joinBackward(d, p.id); return "join"; } return "noop";
    case 6: E.applyFmt(d, R, [{ b: true }, { i: true }, { u: "single" }, { s: true }, { sz: 14 }, { font: "Georgia" }, { color: "C00000" }, { hl: "yellow" }, { va: "superscript" }, { caps: true }, { smallCaps: true }, { shd: "DDEEFF" }][rand(12)]); return "fmt";
    case 7: E.setParaProps(d, R, [{ align: "center" }, { align: "both" }, { indL: 720 }, { indFirst: 360 }, { before: 120, after: 240 }, { line: 360, lineRule: "auto" }, { keepNext: true }, { pageBreakBefore: true }, { shd: "FFF2CC" }][rand(9)]); return "para";
    case 8: E.setStyle(d, R, ["Heading1", "Heading2", "Title", "Quote", "Normal"][rand(5)]); return "style";
    case 9: E.toggleList(d, R, rand(2) ? "bullet" : "number"); return "list";
    case 10: E.indent(d, R, rand(2) ? 1 : -1); return "indent";
    case 11: if (b > a) { E.setLink(d, R, rand(3) ? `https://example.org/p${t}?q=a&b=c` : null); return "link"; } return "noop";
    case 12: E.insertPageBreak(d, R.a); return "pagebreak";
    case 13: if (!E.locate(d, p.id)?.table) { E.insertNote(d, R.a, rand(2) ? "footnote" : "endnote", `Note ${t} text.`); return "note"; } return "noop";
    case 14: { const ns = E.listNotes(d); if (ns.length) { const n = ns[rand(ns.length)]; E.editNoteText(d, n.type, n.id, n.text.slice(0, 3) + `\nedit ${t}` + n.text.slice(3)); return "noteedit"; } return "noop"; }
    case 15: if (b > a) { E.addComment(d, R, `Comment ${t} & <check>`, "Reviewer"); return "comment"; } return "noop";
    case 16: if (!E.locate(d, p.id)?.table) { E.insertTableAfter(d, p.id, 1 + rand(3), 1 + rand(3)); return "table"; } return "noop";
    case 17: { const w = E.locate(d, p.id); if (w?.table) { E.tableRowOp(d, p.id, (["above", "below", "delete"] as const)[rand(3)]); return "row"; } return "noop"; }
    case 18: { const w = E.locate(d, p.id); if (w?.table) { E.tableColOp(d, p.id, (["left", "right", "delete"] as const)[rand(3)]); return "col"; } return "noop"; }
    case 19: E.setPageSetup(d, [{ landscape: true }, { paper: "A4" }, { margins: { top: 1440, right: 1080, bottom: 1440, left: 1080 } }, { landscape: false, paper: "Letter" }][rand(4)]); return "page";
    case 20: setHf(d, rand(2) ? "header" : "footer", rand(4) ? "default" : "first", [{ text: `Header ${t}`, align: (["left", "center", "right"] as const)[rand(3)] }]); if (rand(4) === 0) setDifferentFirst(d, true); return "hf";
    case 21: if (!E.locate(d, p.id)?.table) { E.insertToken(d, R.a, makeImage(d, PNG, "image/png", 40, 40, `Picture ${t}`)); return "image"; } return "noop";
    case 22: E.replaceAll(d, "alpha", "ALPHA"); return "replace";
    case 23: E.setTracking(d, !d.track.on, "Ann"); return "track";
    case 24: { const cs = E.revisions(d).filter((c) => c.editable); if (cs.length) { E.resolveOne(d, cs[rand(cs.length)].key, rand(2) === 1); return "resolve"; } return "noop"; }
    case 25: if (rand(5) === 0) { E.resolveChanges(d, rand(2) === 1); return "resolveAll"; } return "noop";
    case 26: E.insertText(d, R.a, "tab\there"); return "tab";
    case 27: if (a < len) { E.deleteForward(d, { a: R.a, b: R.a }); return "delfwd"; } return "noop";
    default: E.insertText(d, R.a, words[rand(words.length)]); return "type";
  }
}

await test("randomized editing sessions: 24 sessions × 60 steps (all edit operations, Track Changes toggled) on two starting documents; every saved package (checked every 10 steps) is schema-valid", COV, async () => {
  const pyDoc = join(tmp, "pybase.docx");
  execFileSync(PY, ["-c", `import docx
d = docx.Document(); d.add_heading("Report", 1); d.add_paragraph("First paragraph with words."); d.add_paragraph("Item", style="List Bullet")
t = d.add_table(rows=2, cols=2); t.style = "Table Grid"; t.cell(0, 0).text = "A"; t.cell(1, 1).text = "D"
d.add_paragraph("Closing line."); d.save("${pyDoc}")`]);
  const PYBASE = new Uint8Array(readFileSync(pyDoc));
  const files: { f: string; log: string }[] = [];
  let ops = 0; const seen = new Set<string>();
  for (let s = 0; s < 24; s++) {
    let rnd = 0x62000 + s * 7919;
    const rand = (n: number) => { rnd = (rnd * 1103515245 + 12345) >>> 0; return n <= 0 ? 0 : Math.floor((rnd / 2 ** 32) * n); };
    const d = s % 2 ? await readWord(PYBASE) : await blankWord("Fuzz");
    if (!(s % 2)) E.insertText(d, { pid: allParas(d.blocks)[0].id, off: 0 }, "Start of the fuzz document.");
    const log: string[] = [];
    for (let t = 0; t < 60; t++) {
      let lab: string;
      try { lab = step(d, rand, t); } catch (e) { throw new Error(`session ${s} step ${t} threw: ${(e as Error).message}\n${log.slice(-8).join(" ")}`); }
      log.push(lab); if (lab !== "noop") { ops++; seen.add(lab); }
      if (t % 10 === 9) files.push({ f: put(await writeWord(d), `s${s}t${t}-`), log: log.join(" ") });
    }
  }
  const r = validate([...files.map((x) => x.f), pyDoc]);
  // python-docx's own template is not fully valid (word/settings.xml <w:zoom w:val="bestFit"/> lacks the required
  // w:percent); the editor keeps such parts verbatim, so only errors the starting document did NOT have count
  const baseErr = new Set(Object.entries(r[pyDoc].parts).flatMap(([p, es]) => es.map((e) => `${p}|${e.replace(/^line \d+: /, "")}`)));
  ok(baseErr.size === 1 && [...baseErr][0].includes("zoom"), "the known template defect is the only input error: " + [...baseErr]);
  const fresh = (x: { f: string }) => Object.entries(r[x.f].parts).flatMap(([p, es]) => es.filter((e) => !baseErr.has(`${p}|${e.replace(/^line \d+: /, "")}`)).map((e) => `${p}: ${e}`));
  const fails = files.filter((x) => fresh(x).length).map((x) => `${x.f.split("/").pop()} [${x.log.split(" ").slice(-10).join(" ")}]: ${fresh(x).slice(0, 3).join(" ;; ").slice(0, 600)}`);
  ok(files.length === 144, "144 packages");
  console.log(`    ${files.length} packages, ${ops} operations, kinds: ${[...seen].sort().join(",")}`);
  ok(seen.size >= 24, `operation coverage ${seen.size}`);
  ok(!fails.length, `${fails.length} invalid packages:\n${fails.slice(0, 6).join("\n")}`);
});

await test("kitchen sink: every run property on one run, every paragraph property + style + list on one paragraph, the same again under Track Changes (rPrChange / pPrChange with everything), a table cell with shading inside a landscape A4 section with first-page header — schema-valid", COV, async () => {
  const outs: string[] = [];
  for (const tracked of [false, true]) {
    const d = await blankWord("k"); const p = allParas(d.blocks)[0];
    E.insertText(d, { pid: p.id, off: 0 }, "Everything at once in this paragraph.");
    if (tracked) E.setTracking(d, true, "Ann");
    const R = { a: { pid: p.id, off: 0 }, b: { pid: p.id, off: 10 } };
    for (const f of [{ rStyle: "Strong" }, { font: "Georgia" }, { b: true }, { i: true }, { caps: true }, { smallCaps: true }, { s: true }, { color: "C00000" }, { sz: 15 }, { hl: "yellow" }, { u: "double" }, { shd: "DDEEFF" }, { va: "superscript" }]) E.applyFmt(d, R, f);
    E.setStyle(d, R, "Heading2"); E.toggleList(d, R, "number");
    E.setParaProps(d, R, { keepNext: true, pageBreakBefore: true, shd: "FFF2CC", before: 120, after: 240, line: 360, lineRule: "auto", indL: 720, indR: 360, indFirst: 360, align: "both" });
    E.setLink(d, { a: { pid: p.id, off: 12 }, b: { pid: p.id, off: 16 } }, "https://example.org/?a=1&b=2");
    E.insertNote(d, { pid: p.id, off: 20 }, "footnote", "A note.");
    E.addComment(d, { a: { pid: p.id, off: 21 }, b: { pid: p.id, off: 25 } }, "Why?", "Ann");
    E.setTracking(d, false);
    const t = E.insertTableAfter(d, p.id, 2, 2)!; const cp = allParas(cellsOf(rowsOf(t)[0])[0].blocks)[0];
    E.insertText(d, { pid: cp.id, off: 0 }, "cell"); E.setParaProps(d, { a: { pid: cp.id, off: 0 }, b: { pid: cp.id, off: 4 } }, { align: "center", shd: "E2EFDA" });
    E.setPageSetup(d, { paper: "A4", landscape: true, margins: { top: 1000, right: 900, bottom: 1000, left: 900 } });
    setHf(d, "header", "default", [{ text: "Header", align: "right" }]); setHf(d, "footer", "first", [{ text: "First footer", align: "center" }]); setDifferentFirst(d, true);
    outs.push(put(await writeWord(d), tracked ? "sinkT" : "sink"));
  }
  // a section with a header reference but no pgSz / pgMar (legal: both are optional) gets page setup → pgSz must land after
  // the references (regression for the TT62 fix)
  const h0 = await blankWord("h"); setHf(h0, "header", "default", [{ text: "H" }]);
  const hp = put(await writeWord(h0), "hdr"); const hn = join(tmp, "hdr-nopg.docx");
  execFileSync(PY, ["-c", `import zipfile,sys,re
zi=zipfile.ZipFile(sys.argv[1]); zo=zipfile.ZipFile(sys.argv[2],'w',zipfile.ZIP_DEFLATED)
for it in zi.infolist():
    d=zi.read(it.filename)
    if it.filename=='word/document.xml':
        s=d.decode(); n=len(s); s=re.sub(r'<w:pgSz[^>]*/>','',s); s=re.sub(r'<w:pgMar[^>]*/>','',s); assert len(s)<n and 'headerReference' in s; d=s.encode()
    zo.writestr(it,d)
zo.close()`, hp, hn]);
  const h1 = await readWord(new Uint8Array(readFileSync(hn)));
  E.setPageSetup(h1, { paper: "A4", landscape: true });
  outs.push(hn, put(await writeWord(h1), "hdrpg"));
  const r = validate(outs);
  for (const f of outs) ok(r[f].ok, `${f.split("/").pop()}: ${bad(r[f]).join(" ;; ").slice(0, 900)}`);
});

await test("file revision paths stay valid: lxml-written cellIns / cellDel accepted and rejected (all and one by one) → schema-valid, and the lxml-marked fixture itself is valid", COV, async () => {
  const d = await blankWord("c"); const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Cells.");
  const t = E.insertTableAfter(d, p0.id, 3, 3)!;
  rowsOf(t).forEach((r, ri) => cellsOf(r).forEach((c, ci) => E.insertText(d, { pid: allParas(c.blocks)[0].id, off: 0 }, `R${ri}C${ci}`)));
  const a = put(await writeWord(d), "cells"); const m = join(tmp, "cells-m.docx");
  execFileSync(PY, ["scripts/oracle/docx_tblrev.py", "markcells", a, m, "0,0,2,ins,801", "0,1,0,del,802", "0,2,1,ins,803"]);
  const MB = new Uint8Array(readFileSync(m));
  const outs: string[] = [m];
  for (const acc of [true, false]) { const x = await readWord(MB); E.resolveChanges(x, acc); outs.push(put(await writeWord(x), "res")); }
  for (const k of ["c:801", "c:802", "c:803"]) for (const acc of [true, false]) { const x = await readWord(MB); E.resolveOne(x, k, acc); outs.push(put(await writeWord(x), "one")); }
  const r = validate(outs);
  const fails = outs.filter((f) => !r[f].ok).map((f) => `${f.split("/").pop()}: ${bad(r[f]).join(" ;; ").slice(0, 400)}`);
  ok(!fails.length, fails.join("\n"));
  const out = execFileSync(PY, ["-c", `import sys, json, re, os, zipfile
sys.path.insert(0, 'scripts/oracle'); import ooxml_xsd as X
print(json.dumps(X.check(sys.argv[1])['ok']))`, m], { encoding: "utf8" });
  ok(out.trim() === "true", "marked fixture valid");
});

await test("POI corpus round trip: every readable .docx in the corpus, opened, edited (text typed into the first body paragraph) and saved, adds no schema error the input did not already have (per part, line numbers ignored)", COV, async () => {
  const dir = "/home/user/tools/corpus/docx";
  const files = readdirSync(dir).filter((f) => f.endsWith(".docx")).sort();
  const pairs: [string, string][] = []; const unreadable: string[] = [];
  for (const f of files) {
    let d: WordDoc;
    try { d = await readWord(new Uint8Array(readFileSync(join(dir, f)))); } catch { unreadable.push(f); continue; }
    const p = allParas(d.blocks)[0];
    if (p) E.insertText(d, { pid: p.id, off: 0 }, "Edited ");
    pairs.push([join(dir, f), put(await writeWord(d), "corp")]);
  }
  ok(pairs.length >= 100, `round-tripped ${pairs.length}`);
  const r = validate(pairs.flat());
  const norm = (e: string) => e.replace(/^line \d+: /, "");
  const fails: string[] = []; let inputsInvalid = 0;
  for (const [i, o] of pairs) {
    if (!r[i].ok) inputsInvalid++;
    for (const [part, es] of Object.entries(r[o].parts)) {
      const before = new Set((r[i].parts[part] ?? Object.values(r[i].parts).flat()).map(norm));
      for (const e of es) if (!before.has(norm(e))) fails.push(`${i.split("/").pop()} ${part}: ${e}`);
    }
  }
  console.log(`    ${pairs.length} documents round-tripped (${unreadable.length} refused as damaged: ${unreadable.join(", ")}); ${inputsInvalid} inputs already schema-invalid`);
  ok(!fails.length, `${fails.length} new errors:\n${fails.slice(0, 8).join("\n")}`);
});

await finish();
