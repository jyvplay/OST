/**
 * TT61 Writer — formatting-preserving note editing (src/lib/office/wordedit.ts editNoteText). The TT58 editor rewrote an
 * edited note as plain text; now only the changed span is rewritten.
 * Ground truth: the formatted footnote is written by lxml (scripts/oracle/docx_noteruns.py format — an independent
 * writer), edited through our model, saved, and read back by the same independent lxml probe (run text + b / i / u per
 * paragraph, the footnoteRef mark, the paragraph style) and scripts/oracle/docx_notes.py (text, references, soundness).
 * Expected run lists are written out by hand; a randomized differential checks that every unchanged character keeps its
 * formatting and the note text always equals what was typed.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt61-writer-notes-rich.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, type WordDoc } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";

const { test, finish } = makeHarness("tt61-writer-notes-rich");
const COV = { "FF-43": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt61n-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 900)} != ${JSON.stringify(b)?.slice(0, 900)}`); };
type Run = [string, boolean, boolean, boolean];
type ProbePara = { style: string | null; runs: Run[]; ref: boolean };
let seq = 0;
const file = (b: Uint8Array) => { const f = join(tmp, `f${seq++}.docx`); writeFileSync(f, b); return f; };
const probe = (b: Uint8Array): { footnote: Record<string, ProbePara[]> } => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_noteruns.py", "probe", file(b)], { encoding: "utf8" }));
const notes = (b: Uint8Array) => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_notes.py", file(b)], { encoding: "utf8" }));

// fixture: our blank document + one footnote, then footnote 1 rewritten with formatted runs by lxml
const base = await blankWord("N");
const p0 = allParas(base.blocks)[0];
E.insertText(base, { pid: p0.id, off: 0 }, "Claim.");
E.insertNote(base, { pid: p0.id, off: 6 }, "footnote", "placeholder");
const plainFile = file(await writeWord(base));
const richFile = join(tmp, "rich.docx");
execFileSync(PY, ["scripts/oracle/docx_noteruns.py", "format", plainFile, richFile]);
const RICH = new Uint8Array(readFileSync(richFile));
const load = () => readWord(RICH);
const ORIG = "See Smith in Journal of Tests, 2026.\nSecond line here.";
const P2: Run[] = [["Second ", false, false, false], ["line", false, false, true], [" here.", false, false, false]];
const edit = async (d: WordDoc, text: string) => { const r = E.editNoteText(d, "footnote", "1", text); const b = await writeWord(d); return { r, b, fn: probe(b).footnote["1"] }; };

await test("fixture sanity: the lxml-written formatted note reads back as written (independent probe) and as text in our model", COV, async () => {
  const fn = probe(RICH).footnote["1"];
  eq(fn[0].runs, [[" See ", false, false, false], ["Smith", true, false, false], [" in ", false, false, false], ["Journal of Tests", false, true, false], [", 2026.", false, false, false]], "P1");
  eq(fn[1].runs, P2, "P2");
  const d = await load();
  eq(E.listNotes(d)[0].text, ORIG, "noteTextOf");
});

await test("an edit inside plain text, inside a bold word, at the start of an italic word: only the edited span changes; inserted text takes the previous character's formatting", COV, async () => {
  let d = await load();
  let x = await edit(d, ORIG.replace("2026", "2025"));
  eq(x.r, "kept", "formatting kept");
  eq(x.fn[0].runs, [[" See ", false, false, false], ["Smith", true, false, false], [" in ", false, false, false], ["Journal of Tests", false, true, false], [", 2025.", false, false, false]], "year changed, everything else intact");
  eq(x.fn[1].runs, P2, "second paragraph untouched");
  ok(x.fn[0].ref, "footnoteRef mark kept");
  ok(x.fn[0].refFirst, "reference mark still leads the note");
  d = await load();
  x = await edit(d, "Note. " + ORIG);
  ok(x.fn[0].ref && x.fn[0].refFirst, "typing at the very start lands after the reference mark, not before it");
  eq(x.fn[0].runs[0], [" Note. See ", false, false, false], "typed at start");
  d = await load(); // a note written without the customary space after the mark (common in LibreOffice output)
  const r0 = (d.notes.find((n) => n.id === "1")!.blocks[0] as { content: { t: string; text?: string }[] }).content.find((it) => it.t === "r")!;
  r0.text = "See ";
  x = await edit(d, "Note. " + ORIG);
  ok(x.fn[0].refFirst, "no leading space: typed text still lands after the reference mark");
  eq(x.fn[0].runs[0], ["Note. See ", false, false, false], "typed at start (no space)");
  d = await load();
  x = await edit(d, ORIG.replace("Smith", "Smithson"));
  eq(x.fn[0].runs[1], ["Smithson", true, false, false], "typed inside bold → bold");
  d = await load();
  x = await edit(d, ORIG.replace(" in Journal", " in the Journal"));
  eq(x.fn[0].runs.slice(2, 4), [[" in the ", false, false, false], ["Journal of Tests", false, true, false]], "typed before an italic word takes the plain character before it");
  d = await load();
  x = await edit(d, ORIG.replace("Smith in Journal", "Jones in Annals"));
  eq(x.fn[0].runs.slice(0, 4), [[" See ", false, false, false], ["Jones", true, false, false], [" in ", false, false, false], ["Annals of Tests", false, true, false]], "replacing across runs: prefix/suffix diff keeps the shared ' in '");
  const n = notes(x.b);
  eq(n.notes.footnote["1"], "See Jones in Annals of Tests, 2026.\nSecond line here.", "docx_notes text");
  eq(n.dangling, [], "references intact");
});

await test("line breaks: typing \\n splits the paragraph (new one keeps FootnoteText), deleting a break joins paragraphs, deleting everything keeps the reference mark", COV, async () => {
  let d = await load();
  let x = await edit(d, ORIG.replace("2026.", "2026.\nThird"));
  eq(x.fn.length, 3, "three paragraphs");
  eq(x.fn[1].runs, [["Third", false, false, false]], "new paragraph text, plain (previous character's formatting)");
  eq(x.fn[1].style, x.fn[0].style, "the new paragraph copies the paragraph style");
  ok(x.fn.every((p) => p.style === "FootnoteText"), "every paragraph keeps FootnoteText: " + x.fn.map((p) => p.style));
  eq(x.fn[2].runs, P2, "the old second paragraph follows untouched");
  d = await load();
  x = await edit(d, ORIG.replace("2026.\nSecond", "2026. Second"));
  eq(x.fn.length, 1, "joined");
  eq(x.fn[0].runs.slice(-3), [[", 2026. Second ", false, false, false], ["line", false, false, true], [" here.", false, false, false]], "joined runs keep their formatting");
  d = await load();
  x = await edit(d, "");
  eq(x.r, "kept", "kept");
  ok(x.fn[0].ref, "the footnoteRef mark survives deleting all text");
  eq(notes(x.b).notes.footnote["1"], "", "empty note text");
  eq(E.editNoteText(d, "footnote", "1", ""), false, "no change → false");
  eq(E.editNoteText(d, "footnote", "99", "x"), false, "unknown note → false");
});

// TT65 contract change: TT61 rebuilt a note holding a tracked change as plain text ("plain") — silently resolving another
// reviewer's pending revision. Now the edit goes through the note's own view (wordedit viewEdit): the revision is kept
await test("a note holding another reviewer's tracked change is edited in place: the call says \"kept\" and the revision survives", COV, async () => {
  const d = await load();
  const n = d.notes.find((x) => x.id === "1")!;
  const para = n.blocks[0] as { content: { t: string; text?: string; rev?: { id: number } }[] };
  const r = para.content.find((it) => it.t === "r")!; r.rev = { kind: "ins", id: 900, author: "A" } as never;
  const want = E.noteTextOf(n.blocks).replace("2026", "2027");
  eq(E.editNoteText(d, "footnote", "1", want), "kept", "kept reported");
  eq(E.noteTextOf(d.notes.find((x) => x.id === "1")!.blocks), want, "text applied");
  const after = (d.notes.find((x) => x.id === "1")!.blocks[0] as typeof para).content.filter((it) => it.rev);
  eq(after.map((it) => [it.text, it.rev!.id]), [[" See ", 900]], "the pending insertion is untouched");
});

await test("randomized differential: 60 random edits — note text always equals the request; every character outside the changed span keeps its formatting; save → re-open → lxml text agrees", COV, async () => {
  let rnd = 0x61a7e5;
  const rand = (n: number) => { rnd = (rnd * 1103515245 + 12345) >>> 0; return Math.floor((rnd / 2 ** 32) * n); };
  const alphabet = "ab XY,.\n";
  const fmtMap = (d: WordDoc) => {
    const n = d.notes.find((x) => x.id === "1")!; const out: string[] = []; let first = true;
    for (const p of n.blocks as { content: { t: string; text?: string; f?: { b?: boolean; i?: boolean; u?: string } }[] }[]) {
      if (!first) out.push("\n|"); first = false;
      for (const it of p.content) if (it.t === "r") for (const ch of it.text!) out.push(`${ch}|${it.f?.b ? "b" : ""}${it.f?.i ? "i" : ""}${it.f?.u && it.f.u !== "none" ? "u" : ""}`);
    }
    if (out[0]?.startsWith(" |")) out.shift();
    return out;
  };
  for (let t = 0; t < 60; t++) {
    const d = await load();
    const before = E.listNotes(d)[0].text; const fb = fmtMap(d);
    const a = rand(before.length + 1), b = a + rand(Math.min(6, before.length - a) + 1);
    let ins = ""; for (let k = rand(5); k > 0; k--) ins += alphabet[rand(alphabet.length)];
    const want = before.slice(0, a) + ins + before.slice(b);
    const r = E.editNoteText(d, "footnote", "1", want);
    if (want === before) { eq(r, false, "identity edit"); continue; }
    eq(r, "kept", `trial ${t} kept`);
    eq(E.listNotes(d)[0].text, want, `trial ${t} text`);
    const fa = fmtMap(d);
    // prefix / suffix characters (as the diff sees them) keep their formatting
    let p = 0; while (p < before.length && p < want.length && before[p] === want[p]) p++;
    let s = 0; while (s < before.length - p && s < want.length - p && before[before.length - 1 - s] === want[want.length - 1 - s]) s++;
    eq(fa.slice(0, p), fb.slice(0, p), `trial ${t} prefix formatting`);
    if (s) eq(fa.slice(fa.length - s), fb.slice(fb.length - s), `trial ${t} suffix formatting`);
    if (t % 6 === 0) {
      const bytes = await writeWord(d);
      eq(notes(bytes).notes.footnote["1"], want, `trial ${t} lxml text after save`);
      eq(E.listNotes(await readWord(bytes))[0].text, want, `trial ${t} re-open`);
    }
  }
});

await test("diffHunks (from-scratch Myers): on 400 random string pairs the hunks rebuild the target exactly and the edit count equals an independent DP insert/delete distance; two separate edits leave the text between them — and its formatting — alone", COV, async () => {
  let rnd = 0x5eed61;
  const rand = (n: number) => { rnd = (rnd * 1103515245 + 12345) >>> 0; return Math.floor((rnd / 2 ** 32) * n); };
  const rs = (n: number) => { let o = ""; for (let k = 0; k < n; k++) o += "abc\n "[rand(5)]; return o; };
  const dp = (x: string, y: string) => { const D = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))); for (let i = 1; i <= x.length; i++) for (let j = 1; j <= y.length; j++) D[i][j] = x[i - 1] === y[j - 1] ? D[i - 1][j - 1] : 1 + Math.min(D[i - 1][j], D[i][j - 1]); return D[x.length][y.length]; };
  for (let t = 0; t < 400; t++) {
    const x = rs(rand(30)), y = rand(3) ? rs(rand(30)) : x.slice(0, rand(x.length + 1)) + rs(rand(4)) + x.slice(rand(x.length + 1));
    const h = E.diffHunks(x, y);
    let out = "", last = 0, cost = 0;
    for (const k of h) { ok(k.a >= last && k.b >= k.a, `trial ${t} ordered`); out += x.slice(last, k.a) + k.ins; last = k.b; cost += k.b - k.a + k.ins.length; }
    out += x.slice(last);
    eq(out, y, `trial ${t} rebuild`);
    eq(cost, dp(x, y), `trial ${t} minimal (${JSON.stringify(x)} → ${JSON.stringify(y)})`);
  }
  eq(E.diffHunks("same", "same"), [], "identity");
  const d = await load();
  const x = await edit(d, ORIG.replace("See", "Cf.").replace("Tests", "Testing"));
  eq(x.fn[0].runs, [[" Cf. ", false, false, false], ["Smith", true, false, false], [" in ", false, false, false], ["Journal of Testing", false, true, false], [", 2026.", false, false, false]], "two separate edits; the bold word between them is untouched");
  eq(x.fn[1].runs, P2, "P2");
});

await test("POI corpus (6 files, every footnote / endnote): a random mid-note edit keeps the text exact, keeps each untouched character's formatting (independent lxml probe before vs after), keeps references sound", COV, async () => {
  const CORPUS = "/home/user/tools/corpus/docx";
  const files = ["footnotes.docx", "endnotes.docx", "bug65649.docx", "Bug54849.docx", "table_footnotes.docx", "form_footnotes.docx"];
  let edited = 0, kept = 0;
  const flat = (ps: ProbePara[]) => ps.map((p) => p.runs.flatMap(([t, b, i, u]) => [...t].map((ch) => `${ch}${b ? "b" : ""}${i ? "i" : ""}${u ? "u" : ""}`)).join("")).join("¶");
  for (const f of files) {
    const src = new Uint8Array(readFileSync(join(CORPUS, f)));
    const d0 = await readWord(src);
    for (const n of E.listNotes(d0)) {
      if (n.text.length < 4) continue;
      const d = await readWord(src);
      const mid = Math.floor(n.text.length / 2);
      const want = n.text.slice(0, mid) + "ZQ" + n.text.slice(mid + 1);
      const r = E.editNoteText(d, n.type, n.id, want);
      ok(r === "kept" || r === "plain", `${f} ${n.type} ${n.id}: ${r}`);
      edited++; if (r === "kept") kept++;
      const bytes = await writeWord(d);
      const o = notes(bytes);
      eq(o.notes[n.type][n.id], want, `${f} ${n.type} ${n.id} text`);
      eq(o.dangling, [], `${f} references`);
      if (r === "kept") {
        const before = flat((probe(src) as Record<string, Record<string, ProbePara[]>>)[n.type][n.id]);
        const after = flat((probe(bytes) as Record<string, Record<string, ProbePara[]>>)[n.type][n.id]);
        // the edit replaced one character with two: everything else is identical, formatting included
        let p = 0; while (p < before.length && before[p] === after[p]) p++;
        let s = 0; while (s < before.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
        ok(p + s >= before.length - 6, `${f} ${n.type} ${n.id}: only the edited span differs (${p}+${s} of ${before.length})`);
      }
    }
  }
  console.log(`    corpus: ${edited} notes edited, ${kept} with formatting kept, ${edited - kept} plain fallback`);
  ok(edited >= 6 && kept >= edited / 2, "coverage");
});

await finish();
