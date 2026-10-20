/**
 * TT49 — Writer header / footer EDITING (src/lib/office/hdrftr.ts) verified by an independent oracle
 * (scripts/oracle/docx_hf.py: python-docx 1.2 + lxml, never our reader) on the Apache POI .docx corpus:
 * edit existing headers, add headers/footers where none exist, different first page, remove, locked content kept,
 * untouched paragraphs and parts byte-identical, hostile input.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt49-writer.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, type WordDoc } from "../src/lib/office/wordml.ts";
import { hfLines, removeHf, setDifferentFirst, setHf, type HfLine } from "../src/lib/office/hdrftr.ts";
import { openZip, writeZip } from "../src/lib/office/zipkit.ts";

const { test: test0, finish } = makeHarness("tt49-writer");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !ONLY.split("|").some((o) => name.includes(o)) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const CORPUS = "/home/user/tools/corpus/docx", PY = "/home/user/tools/venv/bin/python";
const haveCorpus = existsSync(CORPUS) && existsSync(PY);
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const COV = { "FF-22": "full" } as const;
const tmp = mkdtempSync(join(tmpdir(), "tt49w-"));
type Para = { text: string; align: string | null; fields: string[]; fldChars: string[]; pictures: number };
type Slot = { linked: true } | { linked: false; paras: Para[]; tables: number };
type Sec = { firstPage: boolean; header: Slot; footer: Slot; firstHeader: Slot; firstFooter: Slot };
type Probe = { file: string; error?: string; sections: Sec[]; body: string[] };
const oracle = (paths: string[]): Probe[] => paths.length ? execFileSync(PY, ["-W", "ignore", "scripts/oracle/docx_hf.py", ...paths], { encoding: "utf8", maxBuffer: 1 << 28 }).trim().split("\n").map((l) => JSON.parse(l)) : [];
const files = haveCorpus ? readdirSync(CORPUS).filter((f) => f.endsWith(".docx")).sort().map((f) => join(CORPUS, f)) : [];
async function load(f: string): Promise<WordDoc | null> { try { return await readWord(new Uint8Array(readFileSync(f)), f.split("/").pop()); } catch { return null; } }
async function save(d: WordDoc, name: string) { const b = await writeWord(d); const p = join(tmp, name); writeFileSync(p, b); return { p, b }; }
async function partsDiff(a: Uint8Array, b: Uint8Array) {
  const za = openZip(a), zb = openZip(b); const out: string[] = [];
  const names = new Set([...za.entries.map((e) => e.name), ...zb.entries.map((e) => e.name)]);
  for (const n of names) { if (n.endsWith("/")) continue; /* zip directory entries carry no data (our writer omits them) */ const x = await za.read(n), y = await zb.read(n); if (!x || !y || Buffer.compare(Buffer.from(x), Buffer.from(y)) !== 0) out.push(n); }
  return out.sort();
}
const NONE: Sec = { firstPage: false, header: { linked: true }, footer: { linked: true }, firstHeader: { linked: true }, firstFooter: { linked: true } };
/** final section as python-docx sees it; a document without any <w:sectPr> has no sections → nothing referenced */
const last = (p: Probe) => p.sections[p.sections.length - 1] ?? NONE;
const paras = (s: Slot) => (s.linked ? [] : s.paras);
/** our own text for a slot after reading the saved file back */
const ours = (d: WordDoc, k: "header" | "footer", t: "default" | "first") => hfLines(d, k, t).map((l) => ({ text: l.text, align: l.align }));
const MARK = 'TT49 {PAGE} of {NUMPAGES} <&"\'>';
const MARK_SHOWN = 'TT49 1 of 1 <&"\'>';

await test("edit the existing default header of every corpus document that has one: python-docx sees the new text with live PAGE/NUMPAGES fields; every other paragraph, part and the body are unchanged", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  let edited = 0; const skipped: string[] = [];
  for (const f of files) {
    const d = await load(f); if (!d || !d.page.headerRid) continue;
    const lines = hfLines(d, "header", "default"); const i = lines.findIndex((l) => !l.locked);
    if (i < 0) { skipped.push(`${f.split("/").pop()}: every header line locked`); continue; }
    const [before] = oracle([f]); if (before.error) { skipped.push(`${f.split("/").pop()}: oracle ${before.error}`); continue; }
    const orig = new Uint8Array(readFileSync(f));
    const want = lines.map((l, j) => (j === i ? { ...l, text: MARK, align: "center" as const } : l));
    setHf(d, "header", "default", want);
    const { p, b } = await save(d, `edit-${edited}.docx`);
    const [after] = oracle([p]); ok(!after.error, `${f}: python-docx cannot open the result: ${after.error}`);
    const hb = paras(last(before).header), ha = paras(last(after).header);
    ok(ha.length === hb.length, `${f}: header paragraph count ${hb.length} → ${ha.length}`);
    ok(ha[i].text === MARK_SHOWN && ha[i].align?.startsWith("CENTER") && ha[i].fields.join() === "PAGE,NUMPAGES" && ha[i].fldChars.join() === "begin,separate,end,begin,separate,end", `${f}: edited line ${JSON.stringify(ha[i])}`);
    for (let j = 0; j < hb.length; j++) if (j !== i) ok(JSON.stringify(ha[j]) === JSON.stringify(hb[j]), `${f}: header line ${j} changed: ${JSON.stringify(hb[j])} → ${JSON.stringify(ha[j])}`);
    ok(JSON.stringify(after.body) === JSON.stringify(before.body), `${f}: body text changed`);
    for (const k of ["footer", "firstHeader", "firstFooter"] as const) ok(JSON.stringify(last(after)[k]) === JSON.stringify(last(before)[k]), `${f}: ${k} changed`);
    const changed = (await partsDiff(orig, b)).filter((n) => n !== "docProps/core.xml");
    const hdrPart = d.hf.xml.get(d.page.headerRid!)!.path;
    ok(JSON.stringify(changed) === JSON.stringify([hdrPart]), `${f}: changed parts ${changed} (only ${hdrPart} expected)`);
    const back = await readWord(b);
    ok(JSON.stringify(ours(back, "header", "default")) === JSON.stringify(want.map((l) => ({ text: l.text.replace("<&\"'>", "<&\"'>"), align: l.align ?? "left" }))), `${f}: our reader after save ${JSON.stringify(ours(back, "header", "default"))}`);
    edited++;
  }
  console.log(`    ${edited} corpus headers edited; skipped: ${skipped.join("; ") || "none"}`);
  ok(edited >= 21, `only ${edited} documents edited`);
});

await test("add a header AND a footer to every corpus document that has none: new parts, relationships, content types and section references that python-docx resolves", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  let added = 0; const bad: string[] = [];
  for (const f of files) {
    const d = await load(f); if (!d || d.page.headerRid || d.page.footerRid) continue;
    const [before] = oracle([f]); if (before.error) continue;
    setHf(d, "header", "default", [{ text: "Added header {PAGE}", align: "right" }]);
    setHf(d, "footer", "default", [{ text: "Page {PAGE} of {NUMPAGES}", align: "center" }, { text: "second\tline" }]);
    const { p, b } = await save(d, `add-${added}.docx`);
    const [after] = oracle([p]);
    if (after.error) { bad.push(`${f}: ${after.error}`); continue; }
    const s = last(after); const h = paras(s.header), ft = paras(s.footer);
    if (!(h.length === 1 && h[0].text === "Added header 1" && h[0].align?.startsWith("RIGHT") && h[0].fields.join() === "PAGE")) bad.push(`${f}: header ${JSON.stringify(s.header)}`);
    if (!(ft.length === 2 && ft[0].text === "Page 1 of 1" && ft[0].align?.startsWith("CENTER") && ft[1].text === "second\tline")) bad.push(`${f}: footer ${JSON.stringify(s.footer)}`);
    if (JSON.stringify(after.body) !== JSON.stringify(before.body)) bad.push(`${f}: body changed`);
    const z = openZip(b); const ct = (await z.readText("[Content_Types].xml"))!;
    if (!/wordprocessingml\.header\+xml/.test(ct) || !/wordprocessingml\.footer\+xml/.test(ct)) bad.push(`${f}: content types`);
    // a second save of the same document (Content_Types is rebuilt from the original each time) must still open
    const again = await save(d, `add-${added}-again.docx`); const [o2] = oracle([again.p]);
    if (o2.error || paras(last(o2).header)[0]?.text !== "Added header 1") bad.push(`${f}: second save ${o2.error ?? JSON.stringify(last(o2).header)}`);
    if (s.header.linked === false && h[0].style !== undefined && !["Header", "header"].includes((h[0] as unknown as { style: string }).style ?? "")) bad.push(`${f}: new header paragraph style ${(h[0] as unknown as { style: string }).style}`);
    added++;
  }
  ok(!bad.length, bad.slice(0, 8).join("\n  "));
  ok(added >= 60, `only ${added} documents`);
  console.log(`    header + footer added to ${added} documents; python-docx resolves all`);
});

await test("different first page: a first-page header is created, <w:titlePg/> is set in schema order, the default header stays; switching it off keeps both parts", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  let n = 0;
  for (const f of files.slice(0, 60)) {
    const d = await load(f); if (!d || d.page.titlePg) continue;
    const [before] = oracle([f]); if (before.error) continue;
    setHf(d, "header", "first", [{ text: "Cover {PAGE}", align: "center" }]);
    const { p, b } = await save(d, `first-${n}.docx`);
    const [after] = oracle([p]); ok(!after.error, `${f}: ${after.error}`);
    const s = last(after);
    ok(s.firstPage && paras(s.firstHeader)[0]?.text === "Cover 1", `${f}: first page ${JSON.stringify(s.firstHeader)}`);
    ok(JSON.stringify(s.header) === JSON.stringify(last(before).header), `${f}: default header changed`);
    const xml = (await openZip(b).readText(d.docPath))!; const sect = xml.slice(xml.lastIndexOf("<w:sectPr"));
    const order = [...sect.matchAll(/<w:(headerReference|footerReference|pgSz|pgMar|cols|titlePg|docGrid)\b/g)].map((m) => m[1]);
    // EG_HdrFtrReferences is a repeating choice: header/footer references may interleave, but all precede pgSz…
    const rank = (x: string) => ["headerReference|footerReference", "pgSz", "pgMar", "cols", "titlePg", "docGrid"].findIndex((r) => r.split("|").includes(x));
    ok(order.every((x, i) => i === 0 || rank(order[i - 1]) <= rank(x)), `${f}: sectPr order ${order}`);
    setDifferentFirst(d, false); const off = await save(d, `first-off-${n}.docx`); const [o2] = oracle([off.p]); ok(!o2.error, `${f}: after switching off: ${o2.error}`);
    ok(!last(o2).firstPage && JSON.stringify(last(o2).header) === JSON.stringify(last(before).header), `${f}: switching off`);
    if (++n >= 15) break;
  }
  ok(n >= 10, `only ${n} documents`);
});

await test("untouched header paragraphs keep their exact XML; locked lines (pictures, DATE/STYLEREF/… fields, links) survive an edit of the same header byte-for-byte", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  const topParas = (xml: string) => { const out: string[] = []; let depth = 0, start = -1; for (const m of xml.matchAll(/<(\/?)w:(p|tbl|sdt|txbxContent)\b[^>]*?(\/?)>/g)) { if (m[2] !== "p") { depth += m[1] ? -1 : m[3] ? 0 : 1; continue; } if (depth) continue; if (m[3]) { out.push(m[0]); continue; } if (!m[1]) { if (start < 0) start = m.index!; } else if (start >= 0) { out.push(xml.slice(start, m.index! + m[0].length)); start = -1; } } return out; };
  let kept = 0, lockedKept = 0;
  for (const f of files) {
    const d = await load(f); if (!d) continue;
    for (const kind of ["header", "footer"] as const) {
      const rid = kind === "header" ? d.page.headerRid : d.page.footerRid; if (!rid || !d.hf.xml.has(rid)) continue;
      const lines = hfLines(d, kind, "default"); if (lines.length < 2) continue;
      const path = d.hf.xml.get(rid)!.path; const origXml = (await openZip(new Uint8Array(readFileSync(f))).readText(path))!;
      const i = lines.findIndex((l) => !l.locked); if (i < 0) continue;
      // locked lines are sent back with CHANGED text too: they must still be kept verbatim (never flattened)
      setHf(d, kind, "default", lines.map((l, j) => (j === i || l.locked ? { ...l, text: l.text + " (edited)" } : l)));
      const { b } = await save(d, `keep-${kept}.docx`);
      const newXml = (await openZip(b).readText(path))!;
      const A = topParas(origXml), B = topParas(newXml);
      ok(A.length === B.length, `${f} ${kind}: paragraph count ${A.length} → ${B.length}`);
      let k = -1; for (let j = 0; j < A.length; j++) {
        // map top-level XML paragraphs to lines (lines are top-level paragraphs in the same order)
        k++; if (k === i) { ok(A[j] !== B[j], `${f}: edited paragraph unchanged`); continue; }
        ok(A[j] === B[j], `${f} ${kind}: paragraph ${j} XML changed`);
        if (lines[k]?.locked) lockedKept++;
      }
      kept++;
    }
  }
  console.log(`    ${kept} multi-paragraph headers/footers edited; ${lockedKept} locked paragraphs kept byte-for-byte`);
  ok(kept >= 5 && lockedKept >= 1, `kept ${kept}, locked kept ${lockedKept}`);
});

await test("remove: the section no longer references the header (python-docx: linked to previous), body and footer unchanged; no-edit save stays byte-identical", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  let removed = 0, identical = 0;
  for (const f of files) {
    const orig = new Uint8Array(readFileSync(f)); const d = await load(f); if (!d) continue;
    if (d.page.headerRid || d.page.footerRid) { const { b } = await save(d, "noedit.docx"); ok(Buffer.compare(Buffer.from(b), Buffer.from(orig)) === 0 || (await partsDiff(orig, b)).every((n) => n === "docProps/core.xml"), `${f}: no-edit save changed parts`); identical++; }
    if (!d.page.headerRid) continue;
    const [before] = oracle([f]); if (before.error || before.sections.length !== 1) continue;
    removeHf(d, "header", "default"); const { p } = await save(d, `rm-${removed}.docx`); const [after] = oracle([p]);
    ok(last(after).header.linked === true, `${f}: header still referenced`);
    ok(JSON.stringify(last(after).footer) === JSON.stringify(last(before).footer) && JSON.stringify(after.body) === JSON.stringify(before.body), `${f}: footer/body changed`);
    removed++;
  }
  console.log(`    ${removed} headers removed; ${identical} documents with headers/footers unchanged on a no-edit save`);
  ok(removed >= 10 && identical >= 25, `removed ${removed}, identical ${identical}`);
});

await test("hostile input: over-long text and too many lines are capped, XML specials escaped, invalid XML characters dropped, tabs become <w:tab/>, braces other than the two fields stay text — and every result opens in python-docx", COV, async () => {
  const d = await readWord(new Uint8Array(await (await import("../src/lib/office/wordml.ts")).blankWord("x").then(writeWord)));
  const lines: HfLine[] = [
    { text: "A".repeat(5000) },
    { text: "x\u0001y\u0000z\uFFFE\uD800w\r\nv", align: "right" },
    { text: "<w:p>&amp; {page} {PAGES} {PAGE}{NUMPAGES}\tTab", align: "center" },
    ...Array.from({ length: 80 }, (_, i) => ({ text: `line ${i}` })),
  ];
  setHf(d, "footer", "default", lines);
  const { p, b } = await save(d, "hostile.docx");
  const back = await readWord(b); const got = hfLines(back, "footer", "default");
  ok(got.length === 50, `lines capped at 50, got ${got.length}`);
  ok(got[0].text.length === 2000, `text capped at 2000, got ${got[0].text.length}`);
  ok(got[1].text === "xyzw v" && got[1].align === "right", `invalid characters dropped: ${JSON.stringify(got[1].text)}`);
  ok(got[2].text === "<w:p>&amp; {page} {PAGES} {PAGE}{NUMPAGES}\tTab", `specials/braces: ${JSON.stringify(got[2].text)}`);
  if (!haveCorpus) return;
  const [o] = oracle([p]); ok(!o.error, `python-docx: ${o.error}`);
  const ft = paras(last(o).footer); ok(ft.length === 50 && ft[2].text === "<w:p>&amp; {page} {PAGES} 11\tTab" && ft[2].fields.join() === "PAGE,NUMPAGES", `oracle: ${JSON.stringify(ft[2])}`);
  // an empty list keeps one empty paragraph (a part must contain a block)
  setHf(d, "header", "default", []); const e = await save(d, "empty.docx"); const [o2] = oracle([e.p]); ok(paras(last(o2).header).length === 1 && paras(last(o2).header)[0].text === "", `empty header ${JSON.stringify(last(o2).header)}`);
});

await test("lines holding other fields (DATE complex field, STYLEREF fldSimple) or a hyperlink are locked: sent back with changed text they stay byte-identical and python-docx still sees the fields", COV, async () => {
  // fixture: a header whose part carries a DATE complex field, a STYLEREF simple field, a hyperlink and an editable PAGE line
  const base = await readWord(await (await import("../src/lib/office/wordml.ts")).blankWord("x").then(writeWord));
  setHf(base, "header", "default", [{ text: "placeholder" }]);
  const first = await writeWord(base); const z = openZip(first); const hp = base.hf.xml.get(base.page.headerRid!)!.path;
  const pDate = '<w:p><w:r><w:t xml:space="preserve">Printed </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE \\@ "d MMMM yyyy" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>20 October 2026</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  const pRef = '<w:p><w:fldSimple w:instr=" STYLEREF Heading1 "><w:r><w:t>Chapter</w:t></w:r></w:fldSimple></w:p>';
  const pLink = '<w:p><w:hyperlink w:anchor="top"><w:r><w:t>Back to top</w:t></w:r></w:hyperlink></w:p>';
  const pPage = '<w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>';
  const xml0 = (await z.readText(hp))!.replace(/<w:p>.*<\/w:p>/s, pDate + pRef + pLink + pPage);
  const files = await Promise.all(z.entries.filter((e) => !e.name.endsWith("/")).map(async (e) => ({ name: e.name, data: e.name === hp ? xml0 : (await z.read(e.name))! })));
  const src = await writeZip(files); writeFileSync(join(tmp, "fields.docx"), src);
  const d = await readWord(src); const lines = hfLines(d, "header", "default");
  ok(lines.map((l) => l.label ?? "editable").join() === "field DATE,field STYLEREF,hyperlink,editable", `locks ${JSON.stringify(lines)}`);
  ok(lines[3].text === "Page {PAGE}", `fldSimple PAGE reads as a field: ${lines[3].text}`);
  setHf(d, "header", "default", lines.map((l) => ({ ...l, text: l.text + " (edited)" })));
  const { p, b } = await save(d, "fields-edited.docx"); const out = (await openZip(b).readText(hp))!;
  for (const [nm, x] of [["DATE", pDate], ["STYLEREF", pRef], ["hyperlink", pLink]]) ok(out.includes(x), `${nm} paragraph not kept byte-for-byte`);
  ok(!out.includes(pPage), "the editable line was rebuilt");
  if (!haveCorpus) return;
  const [o] = oracle([p]); const ps = paras(last(o).header);
  ok(ps[0].fields.includes("DATE") && ps[1].fields.includes("STYLEREF") && ps[3].text === "Page 1 (edited)" && ps[3].fields.join() === "PAGE", `python-docx ${JSON.stringify(ps)}`);
});

await test("three-column headers (positional tabs): an edited line keeps its centre/right <w:ptab/> elements, so python-docx and our reader see the same three columns", COV, async () => {
  if (!haveCorpus) { console.log("    corpus missing — skipped"); return; }
  for (const name of ["ThreeColHead.docx", "ThreeColHeadFoot.docx"]) {
    const d = (await load(join(CORPUS, name)))!; const lines = hfLines(d, "header", "default");
    ok(lines.length === 1 && !lines[0].locked && lines[0].text.split("\t").length === 3, `${name}: ${JSON.stringify(lines)}`);
    setHf(d, "header", "default", [{ ...lines[0], text: "Left {PAGE}\tMiddle\tRight {NUMPAGES}" }]);
    const { p, b } = await save(d, `ptab-${name}`);
    const xml = (await openZip(b).readText(d.hf.xml.get(d.page.headerRid!)!.path))!;
    const tabs = [...xml.matchAll(/<w:ptab\b[^>]*w:alignment="(\w+)"/g)].map((m) => m[1]);
    ok(tabs.join() === "center,right", `${name}: ptabs ${tabs}`);
    const back = await readWord(b); ok(hfLines(back, "header", "default")[0].text === "Left {PAGE}\tMiddle\tRight {NUMPAGES}", `${name}: our reader`);
    const [o] = oracle([p]); const t = paras(last(o).header)[0];
    ok(t.text === "Left 1\tMiddle\tRight 1" && t.fields.join() === "PAGE,NUMPAGES", `${name}: python-docx ${JSON.stringify(t)}`);
  }
});

await finish();
