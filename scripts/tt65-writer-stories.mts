/**
 * TT65 Writer: Track Changes in every story (FF-49). Headers, footers, footnotes and endnotes: Review lists their revisions
 * (Change.story / .where) and resolves them one by one or with Accept All / Reject All; with Track Changes on, edits there
 * are recorded as w:ins / w:del (header & footer Apply, Notes panel edits, spelling Change / Change All in a story).
 *
 * Ground truth: the SAME edit applied UNTRACKED to an independent copy of the same file. Independent oracle:
 * scripts/oracle/docx_stories.py (lxml; shares no code with src/lib/office) computes every story's Accept-All and
 * Reject-All views from the tracked file alone — Accept must equal the untracked edit, Reject the original; our own
 * resolution (one by one or all at once) must give the same two files. Every revision id is unique across ALL parts
 * (ECMA-376 §17.13.5), every package passes the ECMA-376 transitional XSDs (scripts/oracle/ooxml_xsd.py) and python-docx
 * opens it. Refusals (an edit cutting into a page field / a note field while tracking) change nothing, byte for byte.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt65-writer-stories.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, type WordDoc, type Para } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import * as WS from "../src/lib/office/wordspell.ts";
import { setHf, hfLines, removeHf, HF_TRACK_REFUSAL, type HfLine } from "../src/lib/office/hdrftr.ts";
import { Speller } from "../src/lib/spell/hunspell.ts";
import { parseXml } from "../src/lib/office/xmltree.ts";

const { test, finish } = makeHarness("tt65-writer-stories");
const COV = { "FF-49": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt65s-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 900)} != ${JSON.stringify(b)?.slice(0, 900)}`); };
type View = [string, string | null][];
type Story = { revisions: { kind: string; id: string; author: string; text: string }[]; accept: View; reject: View };
type Oracle = { stories: Record<string, Story>; ids: string[]; ids_unique: boolean; opens: boolean | string };
let seq = 0;
const put = (b: Uint8Array, tag = "f") => { const f = join(tmp, `${tag}${seq++}.docx`); writeFileSync(f, b); return f; };
const oracle = (b: Uint8Array): Oracle => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_stories.py", put(b)], { encoding: "utf8", maxBuffer: 64 << 20 }));
type Xsd = { parts: Record<string, string[]>; ok: boolean };
const xsd = (bs: Uint8Array[]): Xsd[] => { const fs = bs.map((b) => put(b, "x")); const out: Record<string, Xsd> = {}; for (let i = 0; i < fs.length; i += 40) Object.assign(out, JSON.parse(execFileSync(PY, ["scripts/oracle/ooxml_xsd.py", ...fs.slice(i, i + 40)], { encoding: "utf8", maxBuffer: 256 << 20 }))); return fs.map((f) => out[f]); };
const xsdBad = (r: Xsd) => Object.entries(r.parts).filter(([, e]) => e.length).map(([p, e]) => `${p}: ${e.slice(0, 2).join(" | ")}`);
const partsOf = (b: Uint8Array) => JSON.parse(execFileSync(PY, ["-c", "import zipfile,sys,json,hashlib; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({i.filename: hashlib.sha256(z.read(i.filename)).hexdigest() for i in z.infolist() if i.filename!='docProps/core.xml'}))", put(b, "p")], { encoding: "utf8" })) as Record<string, string>;
const sp = new Speller(readFileSync("public/dict/en_US.aff", "utf8"), readFileSync("public/dict/en_US.dic", "utf8"));
let s = 0x65a1;
const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s / 0x7fffffff; };
const rand = (n: number) => Math.floor(rnd() * n);
const open = (b: Uint8Array) => readWord(b);
/** the story of one kind ("header:", "footer:", "footnote:1", ...) — fixtures have one header and one footer part */
const story = (o: Oracle, prefix: string): Story => { const k = Object.keys(o.stories).find((x) => x === prefix || (prefix.endsWith(":") && x.startsWith(prefix))); ok(k, `no story ${prefix} in ${Object.keys(o.stories)}`); return o.stories[k]; };
const STORIES = ["body", "header:", "footer:", "footnote:1", "endnote:1"];
const sound = (o: Oracle, m: string) => { ok(o.opens === true, `${m}: python-docx ${o.opens}`); ok(o.ids_unique, `${m}: revision ids repeat across parts ${o.ids}`); };
/** tracked file T vs ground truth G (untracked edit) and original O, story by story, plus our own Accept All / Reject All */
async function verify(T: Uint8Array, G: Uint8Array, O: Uint8Array, m: string, which = STORIES) {
  const oT = oracle(T), oG = oracle(G), oO = oracle(O);
  sound(oT, m);
  for (const k of which) {
    eq(story(oT, k).accept, story(oG, k).accept, `${m} ${k}: oracle Accept All = the untracked edit`);
    eq(story(oT, k).reject, story(oO, k).accept, `${m} ${k}: oracle Reject All = the original`);
  }
  for (const accept of [true, false]) {
    const d = await open(T); E.resolveChanges(d, accept);
    eq(E.revisions(d).filter((c) => c.editable).length, 0, `${m}: nothing left after ${accept ? "Accept" : "Reject"} All`);
    const oR = oracle(await writeWord(d)); sound(oR, `${m} resolved`);
    for (const k of which) {
      eq(story(oR, k).revisions.length, 0, `${m} ${k}: no revision left in the saved file`);
      eq(story(oR, k).accept, story(accept ? oG : oO, k).accept, `${m} ${k}: our ${accept ? "Accept" : "Reject"} All`);
    }
  }
  return oT;
}

// fixture: header (two lines, page fields), footer, a two-paragraph footnote and an endnote — written untracked, saved, re-opened
async function fixture(): Promise<Uint8Array> {
  const d = await blankWord("Stories");
  const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "Body text here.");
  E.insertNote(d, { pid: p0.id, off: 4 }, "footnote", "We recieve it today.\nSecond para.");
  E.insertNote(d, { pid: p0.id, off: 10 }, "endnote", "Endnote text.");
  setHf(d, "header", "default", [{ text: "Draft {PAGE} of {NUMPAGES}", align: "center" }, { text: "Teh quarterly headr" }]);
  setHf(d, "footer", "default", [{ text: "Footer one" }, { text: "Footer two", align: "right" }]);
  return writeWord(await readWord(await writeWord(d)));
}
const O = await fixture();
const tracked = async (b: Uint8Array) => { const d = await open(b); E.setTracking(d, true, "Rev B"); d.track.author = "Rev B"; return d; };
const plain = async (b: Uint8Array) => { const d = await open(b); d.track.on = false; return d; };
/** the same edit, tracked and untracked */
async function both(fn: (d: WordDoc) => void): Promise<{ T: Uint8Array; G: Uint8Array; dT: WordDoc }> {
  const dT = await tracked(O); fn(dT); const dG = await plain(O); fn(dG);
  return { T: await writeWord(dT), G: await writeWord(dG), dT };
}
const edit = (d: WordDoc, kind: "header" | "footer", f: (ls: HfLine[]) => HfLine[]) => setHf(d, kind, "default", f(hfLines(d, kind, "default")));

await test("header & footer Apply under Track Changes: edited line, alignment, new and removed lines are w:ins / w:del / w:pPrChange — oracle Accept All = the untracked edit, Reject All = the original; our Accept / Reject All agree; Review names the place", COV, async () => {
  const { T, G, dT } = await both((d) => {
    edit(d, "header", (ls) => [{ ...ls[0], text: "Final {PAGE} of {NUMPAGES}" }, { ...ls[1], align: "right" }, { text: "Confidential", align: "center" }]);
    edit(d, "footer", (ls) => [{ text: "New first" }, ls[1]]);
  });
  const oT = await verify(T, G, O, "hf");
  const kinds = (k: string) => story(oT, k).revisions.map((r) => r.kind).sort();
  ok(kinds("header:").includes("ins") && kinds("header:").includes("del") && kinds("header:").includes("pPrChange"), `header revisions ${kinds("header:")}`);
  ok(kinds("footer:").includes("ins") && kinds("footer:").includes("del") && kinds("footer:").includes("mark-del"), `footer revisions ${kinds("footer:")}`);
  ok(story(oT, "header:").revisions.every((r) => r.author === "Rev B"), "author recorded");
  eq(story(oT, "body").revisions.length, 0, "body untouched");
  const where = [...new Set(E.revisions(dT).map((c) => c.where ?? "Body"))];
  eq(where, ["Header", "Footer"], "Review lists header then footer changes");
  ok(E.revisions(dT).every((c) => c.key.startsWith("s:hf:")), "story keys");
  const back = await open(T);
  eq(E.revisions(back).map((c) => [c.where, c.kind, c.text]), E.revisions(dT).map((c) => [c.where, c.kind, c.text]), "the same list after save → re-open");
  eq(xsd([T]).flatMap(xsdBad), [], "XSD");
});

await test("Notes panel edits under Track Changes return \"tracked\" and record w:ins / w:del (a new line = inserted paragraph mark) — oracle and our resolution agree with the untracked edit / the original; untracked edits keep other reviewers' revisions (\"kept\")", COV, async () => {
  const { T, G, dT } = await both((d) => {
    const r1 = E.editNoteText(d, "footnote", "1", "We receive it tomorrow.\nSecond para.\nThird para.");
    const r2 = E.editNoteText(d, "endnote", "1", "Endnote.");
    ok(r1 === (d.track.on ? "tracked" : "kept") || (!d.track.on && r1 !== false), `footnote result ${r1}`);
    ok(r2 !== false && r2 !== "refused", `endnote result ${r2}`);
  });
  const oT = await verify(T, G, O, "notes");
  ok(story(oT, "footnote:1").revisions.some((r) => r.kind === "mark-ins"), "the new paragraph's mark is a tracked insertion");
  eq([...new Set(E.revisions(dT).map((c) => c.where))], ["Footnote 1", "Endnote 1"], "Review names Footnote 1 / Endnote 1");
  // another reviewer's pending revision is kept by an untracked edit elsewhere in the note
  const d2 = await open(T); d2.track.on = false;
  const before = E.revisions(d2).filter((c) => c.story === "note:footnote:1").length;
  const now = E.noteTextOf(d2.notes.find((n) => n.type === "footnote" && n.id === "1")!.blocks);
  eq(E.editNoteText(d2, "footnote", "1", now.replace("Third", "Final")), "kept", "untracked edit of a note with revisions");
  ok(E.revisions(d2).filter((c) => c.story === "note:footnote:1").length >= before, "pending revisions survive");
  eq(E.noteTextOf(d2.notes.find((n) => n.type === "footnote" && n.id === "1")!.blocks), now.replace("Third", "Final"), "text applied");
  eq(xsd([T, await writeWord(d2)]).flatMap(xsdBad), [], "XSD");
});

await test("spelling Change and Change All in headers and notes are tracked like main-text fixes (w:del old word + w:ins new); verdicts from the engine, views from the oracle", COV, async () => {
  const fix = (d: WordDoc) => {
    const iss = WS.allIssues(d, sp).filter((i) => i.story);
    const words = iss.map((i) => i.word).sort();
    ok(words.includes("Teh") && words.includes("headr") && words.includes("recieve"), `story issues ${words}`);
    WS.fixIssue(d, iss.find((i) => i.word === "Teh")!, "The");
    WS.changeAll(d, sp, "headr", "header");
    WS.fixIssue(d, WS.allIssues(d, sp).find((i) => i.word === "recieve")!, "receive");
  };
  const { T, G, dT } = await both(fix);
  const oT = await verify(T, G, O, "spell");
  eq(story(oT, "header:").revisions.filter((r) => r.kind === "del").map((r) => r.text).sort(), ["Teh", "headr"], "old words tracked as deleted");
  eq(story(oT, "footnote:1").revisions.filter((r) => r.kind === "ins").map((r) => r.text), ["receive"], "new word tracked as inserted");
  eq(WS.allIssues(dT, sp).filter((i) => i.story && ["Teh", "headr", "recieve"].includes(i.word)).length, 0, "the struck words are no longer reported");
  // TT65 (found in the visual check): struck letters used to split a word for the checker — "re~~ci~~ceive" read as "re" +
  // "ceive", leaving false squiggles after every tracked fix. The checker reads the visible text now
  // ("Endnote" itself is not in en_US — a real verdict of the dictionary, the only issue left)
  eq(WS.allIssues(dT, sp).map((i) => `${i.where ?? "Body"}:${i.word}`), ["Endnote 1:Endnote"], "no false issues from struck letters in any story");
  const db = await tracked(O); const bp = allParas(db.blocks)[0];
  E.insertText(db, { pid: bp.id, off: 0 }, "Fianl "); // own insertion; now make it "Fi[an]nal" with someone else's text
  for (const it of bp.content) if (it.rev) it.rev = { ...it.rev, author: "Other" };
  const at = E.deleteForReplace(db, { a: { pid: bp.id, off: 2 }, b: { pid: bp.id, off: 4 } }); E.insertText(db, at, "na");
  const iss = WS.spellIssues(db, sp).filter((i) => i.pid === bp.id);
  eq(iss.map((i) => i.word), [], "Fi(an struck)nal is checked as the visible word Final");
  const db2 = await tracked(O); const bp2 = allParas(db2.blocks)[0];
  E.insertText(db2, { pid: bp2.id, off: 0 }, "Fxanl "); for (const it of bp2.content) if (it.rev) it.rev = { ...it.rev, author: "Other" };
  const at2 = E.deleteForReplace(db2, { a: { pid: bp2.id, off: 2 }, b: { pid: bp2.id, off: 4 } }); E.insertText(db2, at2, "na");
  const bad = WS.spellIssues(db2, sp).filter((i) => i.pid === bp2.id);
  eq(bad.map((i) => [i.word, i.off, i.len]), [["Fxnal", 0, 7]], "a misspelt visible word spanning struck letters: one issue over the whole model span");
  WS.fixIssue(db2, bad[0], "Final");
  eq(WS.spellIssues(db2, sp).filter((i) => i.pid === bp2.id).length, 0, "fixable (tracked)");
});

await test("Review one by one: resolving story changes singly (any order) equals Accept All / Reject All; a mixed review (accept header, reject notes) gives exactly that per story", COV, async () => {
  const fn = (d: WordDoc) => {
    edit(d, "header", (ls) => [{ ...ls[0], text: "Final {PAGE} of {NUMPAGES}" }, { text: "Added" }, ls[1]]);
    edit(d, "footer", (ls) => [ls[0]]);
    E.editNoteText(d, "footnote", "1", "We receive it.\nSecond para!");
  };
  const { T, G } = await both(fn);
  const oG = oracle(G), oO = oracle(O);
  for (const accept of [true, false]) for (let trial = 0; trial < 3; trial++) {
    const d = await open(T); let n = 0;
    for (;;) { const l = E.revisions(d).filter((c) => c.editable); if (!l.length) break; ok(E.resolveOne(d, l[rand(l.length)].key, accept), "resolveOne"); ok(++n < 200, "terminates"); }
    const oR = oracle(await writeWord(d)); sound(oR, "singly");
    for (const k of STORIES) eq(story(oR, k).accept, story(accept ? oG : oO, k).accept, `singly ${accept} ${k}`);
  }
  const d = await open(T);
  for (;;) {
    const l = E.revisions(d).filter((c) => c.editable); if (!l.length) break;
    const c = l[0]; ok(E.resolveOne(d, c.key, c.story?.startsWith("hf:") ?? true), "mixed resolve");
  }
  const oM = oracle(await writeWord(d));
  for (const k of ["header:", "footer:"]) eq(story(oM, k).accept, story(oG, k).accept, `mixed ${k} accepted`);
  eq(story(oM, "footnote:1").accept, story(oO, "footnote:1").accept, "mixed footnote rejected");
  ok(!E.resolveOne(d, "s:hf:rIdNope|r:ins:1", true) && !E.resolveOne(d, "s:note:footnote:99|r:ins:1", true), "unknown story keys refused");
});

await test("revision ids are unique ACROSS parts: a re-opened file reserves the ids already used in headers / footers (defect: the scan skipped them), and a save renumbers collisions in every written part while untouched parts keep their bytes", COV, async () => {
  const d1 = await tracked(O); edit(d1, "header", (ls) => [{ ...ls[0], text: "Final {PAGE} of {NUMPAGES}" }, ls[1]]);
  const T1 = await writeWord(d1);
  const hdrIds = story(oracle(T1), "header:").revisions.map((r) => Number(r.id));
  const d2 = await tracked(T1);
  ok(d2.track.next > Math.max(...hdrIds), `next id ${d2.track.next} must exceed header ids ${hdrIds}`);
  const p0 = allParas(d2.blocks)[0]; E.insertText(d2, { pid: p0.id, off: 0 }, "New ");
  const T2 = await writeWord(d2); const o2 = oracle(T2); sound(o2, "reserved");
  ok(story(o2, "body").revisions.length > 0, "the body edit is tracked");
  eq(partsOf(T2)["word/" + Object.keys(o2.stories).find((k) => k.startsWith("header:"))!.slice(7)], partsOf(T1)["word/" + Object.keys(o2.stories).find((k) => k.startsWith("header:"))!.slice(7)], "untouched header part keeps its bytes");
  // force a collision: the footnote's and the body's new revisions get the same id, both parts written → renumbered
  const d3 = await tracked(T1);
  const q0 = allParas(d3.blocks)[0]; E.insertText(d3, { pid: q0.id, off: 0 }, "X ");
  E.editNoteText(d3, "footnote", "1", "We recieve it today!\nSecond para.");
  const bodyRev = allParas(d3.blocks).flatMap((p) => p.content).find((it) => it.rev)!.rev!;
  for (const p of allParas(d3.notes.find((n) => n.type === "footnote")!.blocks)) for (const it of p.content) if (it.rev) it.rev = { ...it.rev, id: bodyRev.id };
  const o3 = oracle(await writeWord(d3)); sound(o3, "collision renumbered");
  ok(story(o3, "footnote:1").revisions.length > 0 && story(o3, "body").revisions.length > 0, "both parts carry revisions");
});

await test("refusals change nothing: a tracked header edit cutting into a page field throws HF_TRACK_REFUSAL before any mutation (save byte-identical); a tracked note edit inside a field returns \"refused\"; typing {PAGE} while tracking inserts a real tracked PAGE field", COV, async () => {
  const d = await tracked(O); const ref = await writeWord(await tracked(O));
  const parts0 = new Map(d.parts); const ls = hfLines(d, "header", "default");
  let msg = "";
  try { setHf(d, "header", "default", [{ ...ls[0], text: ls[0].text.replace("{PAGE}", "{PAG") }, ls[1]]); } catch (e) { msg = (e as Error).message; }
  eq(msg, HF_TRACK_REFUSAL, "refusal message");
  ok([...d.parts].every(([k, v]) => parts0.get(k) === v) && d.hf.dirty.size === 0, "no part replaced or marked");
  eq(partsOf(await writeWord(d)), partsOf(ref), "save after a refusal = save without the attempt");
  // a field token inside a note: tracked edits may go around it, not into it
  const dn = await tracked(O); const note = dn.notes.find((n) => n.type === "footnote" && n.id === "1")!;
  const fld = parseXml(`<w:fldSimple xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" w:instr="DATE"><w:r><w:t>2026</w:t></w:r></w:fldSimple>`).root;
  (note.blocks[0] as Para).content.push({ t: "k", kind: "field", nodes: [fld], bare: false, label: "" } as never);
  const txt = E.noteTextOf(note.blocks);
  ok(txt.includes("2026"), `field text in the note view: ${txt}`);
  const blocks0 = dn.notes.find((n) => n.id === "1" && n.type === "footnote")!.blocks;
  eq(E.editNoteText(dn, "footnote", "1", txt.replace("2026", "2027")), "refused", "edit inside the field");
  ok(dn.notes.find((n) => n.id === "1" && n.type === "footnote")!.blocks === blocks0, "note untouched");
  eq(E.editNoteText(dn, "footnote", "1", txt.replace("today", "now")), "tracked", "edit around the field");
  ok(E.noteTextOf(dn.notes.find((n) => n.id === "1" && n.type === "footnote")!.blocks).includes("2026"), "field kept");
  // {PAGE} typed into a line under tracking: a tracked field, not literal braces
  const dp = await tracked(O); const lp = hfLines(dp, "header", "default");
  setHf(dp, "header", "default", [lp[0], { ...lp[1], text: lp[1].text + " p{PAGE}" }]);
  eq(hfLines(dp, "header", "default")[1].text, "Teh quarterly headr p{PAGE}", "reads back as a field");
  const B = await writeWord(dp); const hx = readHdr(B);
  ok(/<w:ins [^>]*>(?:(?!<\/w:ins>).)*<w:instrText[^>]*>\s*PAGE/.test(hx), "the PAGE field codes are inside w:ins");
  eq(xsd([B]).flatMap(xsdBad), [], "XSD");
});
function readHdr(b: Uint8Array): string {
  return execFileSync(PY, ["-c", "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); print(''.join(z.read(n).decode() for n in z.namelist() if n.startswith('word/header')))", put(b, "h")], { encoding: "utf8" });
}

await test("Remove header under Track Changes keeps the part, its text struck (Accept → empty header, Reject → the original); without tracking the reference is dropped as before", COV, async () => {
  const d = await tracked(O); removeHf(d, "header", "default");
  ok(d.page.headerRid, "still referenced");
  const T = await writeWord(d); const oT = oracle(T); sound(oT, "remove");
  eq(story(oT, "header:").reject, story(oracle(O), "header:").accept, "Reject = original");
  eq(story(oT, "header:").accept.map((p) => p[0]).join(""), "", "Accept = no text");
  const a = await open(T); E.resolveChanges(a, true); eq(hfLines(a, "header", "default").map((l) => l.text).join(""), "", "our Accept All");
  const u = await plain(O); removeHf(u, "header", "default"); ok(!u.page.headerRid, "untracked remove drops the reference");
});

await test("randomized differential: 40 header / footer sessions and 40 note sessions of random edits (characters, new / removed lines, alignment, {PAGE}, new paragraphs) — tracked = refused-with-no-change, or oracle Accept = untracked edit and Reject = original; ids unique; XSD on every 4th", COV, async () => {
  const alpha = "abc XYZ,.\t";
  const mut = (t: string) => { let x = t; for (let k = 1 + rand(3); k > 0; k--) { const at = rand(x.length + 1); if (rnd() < 0.5 && x.length) x = x.slice(0, at) + x.slice(at + 1 + rand(3)); else x = x.slice(0, at) + (rnd() < 0.1 ? "{PAGE}" : alpha[rand(alpha.length)].repeat(1 + rand(3))) + x.slice(at); } return x; };
  let refused = 0, done = 0; const xs: Uint8Array[] = [];
  for (let i = 0; i < 40; i++) {
    const kind = i % 2 ? "footer" : "header";
    // the plan names source lines by INDEX (paragraph ids differ between two readWord calls) and is mapped onto each
    // document's own line ids — the first version of this test planned on a third copy, so no id matched and every
    // session silently became "remove all + insert": valid, but in-place edits and refusals were never exercised
    type Planned = HfLine & { src?: number };
    const plan = (ls: HfLine[]): Planned[] => {
      const out: Planned[] = ls.map((l, k) => (rnd() < 0.6 ? { ...l, text: mut(l.text), src: k } : rnd() < 0.3 ? { ...l, align: (["left", "center", "right"] as const)[rand(3)], src: k } : { ...l, src: k }));
      if (rnd() < 0.35 && out.length > 1) out.splice(rand(out.length), 1);
      if (rnd() < 0.35) out.splice(rand(out.length + 1), 0, { text: mut("new line"), align: (["left", "center", "right"] as const)[rand(3)] });
      return out;
    };
    const onto = (d: WordDoc, pl: Planned[]): HfLine[] => { const ls = hfLines(d, kind, "default"); return pl.map(({ src, ...l }) => ({ ...l, id: src === undefined ? undefined : ls[src].id })); };
    const d0 = await open(O); const want = plan(hfLines(d0, kind, "default"));
    const dT = await tracked(O); const ref = await writeWord(await tracked(O));
    const wantT = onto(dT, want);
    let threw = false;
    try { setHf(dT, kind, "default", wantT); } catch (e) { threw = true; eq((e as Error).message, HF_TRACK_REFUSAL, "refusal reason"); }
    if (threw) { refused++; eq(partsOf(await writeWord(dT)), partsOf(ref), `session ${i}: refusal changed nothing`); continue; }
    const dG = await plain(O); setHf(dG, kind, "default", onto(dG, want));
    const T = await writeWord(dT); await verify(T, await writeWord(dG), O, `hf session ${i}`, [`${kind}:`]); done++;
    if (i % 4 === 0) xs.push(T);
  }
  let nRef = 0, nDone = 0;
  for (let i = 0; i < 40; i++) {
    const kind = i % 3 ? "footnote" : "endnote";
    const d0 = await open(O); const cur = E.noteTextOf(d0.notes.find((n) => n.type === kind && n.id === "1")!.blocks);
    let want = mut(cur); if (rnd() < 0.3) { const at = rand(want.length + 1); want = want.slice(0, at) + "\n" + want.slice(at); }
    want = want.replace(/\{PAGE\}/g, "pg");
    const dT = await tracked(O); const r = E.editNoteText(dT, kind, "1", want);
    if (r === false) continue;
    if (r === "refused") { nRef++; continue; }
    eq(r, "tracked", `note session ${i}`);
    const dG = await plain(O); E.editNoteText(dG, kind, "1", want);
    const T = await writeWord(dT); await verify(T, await writeWord(dG), O, `note session ${i}`, [`${kind}:1`]); nDone++;
    if (i % 4 === 0) xs.push(T);
  }
  console.log(`    header/footer: ${done} verified, ${refused} refused (cut a field); notes: ${nDone} verified, ${nRef} refused`);
  ok(done >= 20 && nDone >= 30, "most sessions are real edits");
  ok(refused >= 1, "the generator does reach the refusal path (an edit cutting a page field)");
  eq(xsd(xs).flatMap(xsdBad), [], "XSD");
});

finish();
