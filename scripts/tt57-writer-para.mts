/**
 * TT57 Writer — tracked PARAGRAPH-PROPERTY changes (w:pPrChange, ECMA-376 §17.13.5.29): alignment, style, list and
 * indent edits made while recording keep the properties from before the first change; Accept drops the record, Reject
 * restores them. Ground truth: the independent lxml oracle scripts/oracle/docx_track.py (`*_paras`: [pStyle, jc, numId,
 * ilvl, ind-left] per paragraph after accepting / rejecting / deciding each revision by id) and python-docx opening the file.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt57-writer-para.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, type WordDoc } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";

const { test, finish } = makeHarness("tt57-writer-para");
const COV = { "FF-22": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt57p-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
type PRow = [string | null, string | null, string | null, string | null, string | null];
type Oracle = { revs: { kind: string; id: string; author: string; text: string }[]; ids_unique: boolean; opens: boolean | string; accept_text: string; reject_text: string; accept_paras: PRow[]; reject_paras: PRow[]; decided_paras: PRow[] };
let seq = 0;
const oracle = (bytes: Uint8Array, decisions?: Record<string, boolean>): Oracle => {
  const f = join(tmp, `o${seq++}.docx`); writeFileSync(f, bytes);
  return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_track.py", f, ...(decisions ? [JSON.stringify(decisions)] : [])], { encoding: "utf8", maxBuffer: 64 << 20 }));
};
let rnd = 0x9a57;
const rand = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 2 ** 32; };
const P = (d: WordDoc, i = 0) => allParas(d.blocks)[i];
const whole = (d: WordDoc, i = 0) => { const p = P(d, i); const n = p.content.reduce((s, it) => s + (it.t === "r" ? it.text.length : 1), 0); return { a: { pid: p.id, off: 0 }, b: { pid: p.id, off: n } }; };
async function three(): Promise<WordDoc> {
  const d = await blankWord("Para");
  let pos = E.insertText(d, { pid: P(d).id, off: 0 }, "First paragraph");
  pos = E.splitParagraph(d, pos); pos = E.insertText(d, pos, "Second paragraph");
  pos = E.splitParagraph(d, pos); E.insertText(d, pos, "Third paragraph");
  return d;
}
/** our model after resolving everything, saved and read by the oracle (no records left) */
async function oursResolved(bytes: Uint8Array, accept: boolean): Promise<PRow[]> {
  const d = await readWord(bytes, "t.docx"); E.resolveChanges(d, accept);
  const o = oracle(await writeWord(d)); eq(o.revs, [], "no revisions left after resolveChanges"); return o.accept_paras;
}

if (!existsSync(PY)) { console.log("python venv missing — run scripts/sandbox/bootstrap.sh"); process.exit(1); }

await test("centre + indent with tracking on → one w:pPrChange per paragraph holding the old pPr; accept keeps, reject restores — oracle, reopened file and live model agree", COV, async () => {
  const d = await three(); E.setTracking(d, true, "Alice");
  E.setParaProps(d, whole(d, 1), { align: "center" }); E.indent(d, whole(d, 1), 1);
  const ch = E.revisions(d).filter((c) => c.kind === "para");
  eq(ch.map((c) => [c.text, c.detail, c.author]), [["Second paragraph", "Centered, Indent", "Alice"]], "one cumulative paragraph change");
  const bytes = await writeWord(d); const o = oracle(bytes);
  eq(o.opens, true, "python-docx opens"); ok(o.ids_unique, "ids unique");
  eq(o.revs.map((r) => [r.kind, r.text, r.author]), [["pfmt", "Second paragraph", "Alice"]], "oracle sees one pPrChange");
  eq(o.accept_text, o.reject_text, "text is not changed by a paragraph-property change");
  eq(o.accept_paras[1], [null, "center", null, null, "720"], "accept keeps centre + 0.5in indent");
  eq(o.reject_paras[1], [null, null, null, null, null], "reject restores the plain paragraph");
  eq(o.accept_paras[0], o.reject_paras[0], "neighbours untouched");
  eq(await oursResolved(bytes, true), o.accept_paras, "our accept-all (reopened) = oracle accept");
  eq(await oursResolved(bytes, false), o.reject_paras, "our reject-all (reopened) = oracle reject");
  for (const accept of [true, false]) {
    const m = await three(); E.setTracking(m, true, "Alice");
    E.setParaProps(m, whole(m, 1), { align: "center" }); E.indent(m, whole(m, 1), 1);
    ok(E.resolveOne(m, E.revisions(m).find((c) => c.kind === "para")!.key, accept), "resolve in memory");
    eq(E.revisions(m), [], "nothing pending");
    eq(oracle(await writeWord(m)).accept_paras, accept ? o.accept_paras : o.reject_paras, `in-memory ${accept ? "accept" : "reject"} = oracle`);
  }
});

await test("lists: bullets added under tracking reject to none; bullets REMOVED under tracking reject to the real list id (a new list is created for the record); back-to-original drops the record", COV, async () => {
  const d = await three(); E.setTracking(d, true, "Bob");
  E.toggleList(d, whole(d, 0), "bullet");
  eq(E.revisions(d).map((c) => [c.kind, c.detail]), [["para", "Bulleted list"]], "listed as a list change");
  let o = oracle(await writeWord(d));
  ok(o.accept_paras[0][2] && o.accept_paras[0][2] !== "0", "accept: a numbering id"); eq(o.reject_paras[0][2], null, "reject: no list");
  E.toggleList(d, whole(d, 0), "bullet"); eq(E.revisions(d), [], "toggling back drops the record");
  eq(oracle(await writeWord(d)).revs, [], "and nothing is written");
  // a list made BEFORE tracking, removed while tracking: the old pPr must point at a list that exists in numbering.xml
  const m = await three(); E.toggleList(m, whole(m, 2), "number"); E.setTracking(m, true, "Bob");
  E.toggleList(m, whole(m, 2), "number");
  eq(E.revisions(m).map((c) => [c.kind, c.detail]), [["para", "List removed"]], "listed as a removal");
  const bytes = await writeWord(m); o = oracle(bytes);
  eq(o.accept_paras[2][2], null, "accept: no list"); ok(o.reject_paras[2][2] && /^\d+$/.test(o.reject_paras[2][2]), `reject: a numeric list id, got ${o.reject_paras[2][2]}`);
  const reopened = await readWord(bytes, "l.docx"); ok(reopened.numbering.has(o.reject_paras[2][2]!), "the recorded list id exists in numbering.xml");
  eq(await oursResolved(bytes, false), o.reject_paras, "our reject-all = oracle reject");
});

await test("not tracked: edits with recording off, and a paragraph whose mark is a pending insertion (new text); a style change lists the style; ids stay unique beside ins/del/fmt", COV, async () => {
  const d = await three();
  E.setParaProps(d, whole(d, 0), { align: "right" }); eq(E.revisions(d), [], "recording off → no record");
  E.setTracking(d, true, "Cy");
  const end = whole(d, 2).b; const np = E.splitParagraph(d, end); E.insertText(d, np, "Brand new");
  const added = allParas(d.blocks).findIndex((q) => q.markRev?.kind === "ins"); ok(added >= 0, "the split made an inserted paragraph mark");
  E.setParaProps(d, whole(d, added), { align: "center" });
  ok(!E.revisions(d).some((c) => c.kind === "para"), "a newly inserted paragraph's properties are part of the insertion");
  E.setParaProps(d, whole(d, 1), { style: "Heading1" });
  const c = E.revisions(d).find((x) => x.kind === "para"); ok(c && /^Style /.test(c.detail ?? ""), `style detail, got ${c?.detail}`);
  E.applyFmt(d, { a: { pid: P(d, 0).id, off: 0 }, b: { pid: P(d, 0).id, off: 5 } }, { b: true });
  const o = oracle(await writeWord(d));
  ok(o.ids_unique, "ins / del / rPrChange / pPrChange ids unique"); eq(o.opens, true, "opens");
  eq(o.revs.map((r) => r.kind).sort(), ["fmt", "ins", "ins", "pfmt"], "kinds written");
  eq(o.reject_paras[1][0], null, "reject → no style"); eq(o.accept_paras[1][0], "Heading1", "accept → Heading1");
  eq(o.accept_paras[0][1], "right", "the untracked alignment stays either way"); eq(o.reject_paras[0][1], "right", "…also on reject");
});

await test("Word-shaped file record (pPrChange with a recorded pStyle + jc, mark rPr present) → listed; reject restores the recorded pPr exactly and keeps the mark's rPr; untouched round-trip keeps the record", COV, async () => {
  const d = await three(); const src = join(tmp, "plain.docx"); writeFileSync(src, await writeWord(d));
  const out = join(tmp, "word.docx");
  execFileSync(PY, ["-c", `
import sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
zi = zipfile.ZipFile(src); zo = zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED)
for it in zi.infolist():
    b = zi.read(it.filename)
    if it.filename == "word/document.xml":
        s = b.decode("utf8")
        i = s.index("<w:p>") if "<w:p>" in s else s.index("<w:p ")
        j = s.index(">", i) + 1
        rec = '<w:pPr><w:jc w:val="center"/><w:rPr><w:b/></w:rPr><w:pPrChange w:id="901" w:author="Word User" w:date="2026-10-01T09:00:00Z"><w:pPr><w:pStyle w:val="Title"/><w:jc w:val="right"/></w:pPr></w:pPrChange></w:pPr>'
        k = s.index("<w:pPr", j) if s.find("<w:pPr", j) == j else -1
        if k == j:
            e = s.index("</w:pPr>", j) + len("</w:pPr>") if "</w:pPr>" in s[j:j + 4000] else s.index("/>", j) + 2
            s = s[:j] + rec + s[e:]
        else:
            s = s[:j] + rec + s[j:]
        b = s.encode("utf8")
    zo.writestr(it, b)
zo.close()
`, src, out]);
  const bytes = new Uint8Array(readFileSync(out)); const o = oracle(bytes);
  eq(o.revs.map((r) => [r.kind, r.id, r.author]), [["pfmt", "901", "Word User"]], "oracle sees the crafted record");
  eq(o.reject_paras[0], ["Title", "right", null, null, null], "oracle reject = recorded pPr");
  const w = await readWord(bytes, "w.docx");
  const c = E.revisions(w); eq(c.map((x) => [x.kind, x.author, x.key]), [["para", "Word User", "p:fmt:901"]], "listed with its file id");
  eq(oracle(await writeWord(w)).revs.map((r) => r.id), ["901"], "untouched round-trip keeps the record");
  ok(E.resolveOne(w, "p:fmt:901", false), "reject");
  const after = await writeWord(w); const o2 = oracle(after);
  eq(o2.revs, [], "record gone"); eq(o2.accept_paras, o.reject_paras, "our reject = oracle reject");
  const xml = new TextDecoder().decode(after);
  ok(o2.opens === true, "python-docx opens"); void xml;
  const w2 = await readWord(after, "w2.docx"); eq(w2.blocks.length > 0, true, "re-reads");
  const mark = allParas(w2.blocks)[0].pPr; ok(mark && JSON.stringify(mark).includes("w:b"), "the paragraph mark's rPr (bold) survived the reject");
  const w3 = await readWord(bytes, "w3.docx"); ok(E.resolveOne(w3, "p:fmt:901", true), "accept");
  eq(oracle(await writeWord(w3)).accept_paras, o.accept_paras, "our accept = oracle accept");
});

await test("120 random trials: random align / indent / list / style edits on 3 paragraphs with recording toggling, random per-revision decisions — live model, reopened file and the oracle agree", COV, async () => {
  const aligns = ["center", "right", "both", undefined];
  for (let t = 0; t < 120; t++) {
    const d = await three();
    for (let k = 0; k < 6; k++) {
      if (rand() < 0.25) E.setTracking(d, !d.track.on, "R" + (t % 3));
      const i = Math.floor(rand() * 3), r = whole(d, i), op = Math.floor(rand() * 4);
      if (op === 0) E.setParaProps(d, r, { align: aligns[Math.floor(rand() * aligns.length)] });
      else if (op === 1) E.indent(d, r, rand() < 0.7 ? 1 : -1);
      else if (op === 2) E.toggleList(d, r, rand() < 0.5 ? "bullet" : "number");
      else E.setParaProps(d, r, { style: rand() < 0.5 ? "Heading1" : undefined });
    }
    const bytes = await writeWord(d);
    const revs = E.revisions(d).filter((c) => c.kind === "para");
    const decisions: Record<string, boolean> = {}; const mine: [string, boolean][] = [];
    for (const c of revs) { const acc = rand() < 0.5; decisions[`pfmt:${c.key.slice(6)}`] = acc; mine.push([c.key, acc]); }
    const o = oracle(bytes, decisions);
    ok(o.ids_unique, `trial ${t}: ids unique`);
    eq(o.revs.filter((r) => r.kind === "pfmt").length, revs.length, `trial ${t}: written records = listed`);
    for (const [key, acc] of mine) ok(E.resolveOne(d, key, acc), `trial ${t}: resolve ${key}`);
    eq(oracle(await writeWord(d)).accept_paras, o.decided_paras, `trial ${t}: live decisions = oracle`);
    const re = await readWord(bytes, "r.docx");
    for (const [key, acc] of mine) ok(E.resolveOne(re, key, acc), `trial ${t}: reopened resolve ${key}`);
    eq(oracle(await writeWord(re)).accept_paras, o.decided_paras, `trial ${t}: reopened decisions = oracle`);
  }
});

finish();
