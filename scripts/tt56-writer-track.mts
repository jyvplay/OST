/**
 * TT56 Writer Track Changes — recording own edits as w:ins / w:del (run, object and paragraph-mark revisions, nested
 * deletions inside another reviewer's insertion), per-change accept / reject, settings.xml w:trackRevisions — verified
 * against an INDEPENDENT oracle (scripts/oracle/docx_track.py: lxml + python-docx, ECMA-376 §17.13.5 semantics) and the
 * Apache POI docx corpus (test-only).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt56-writer-track.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { openZip } from "../src/lib/office/zipkit.ts";
import { readWord, writeWord, blankWord, allParas, type WordDoc } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";

const { test, finish } = makeHarness("tt56-writer-track");
const COV = { "FF-22": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/docx";
const tmp = mkdtempSync(join(tmpdir(), "tt56t-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 600)} != ${JSON.stringify(b)?.slice(0, 600)}`); };
type Rev = { kind: string; id: string; author: string; date: string | null; text: string; mark: boolean; nested: boolean };
type Oracle = { revs: Rev[]; ids_unique: boolean; track: boolean; opens: boolean | string; accept_text: string; reject_text: string; decided_text: string };
let seq = 0;
const oracle = (bytes: Uint8Array, decisions?: Record<string, boolean>): Oracle => {
  const f = join(tmp, `o${seq++}.docx`); writeFileSync(f, bytes);
  return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_track.py", f, ...(decisions ? [JSON.stringify(decisions)] : [])], { encoding: "utf8", maxBuffer: 64 << 20 }));
};
const sig = (r: Rev[]) => r.map((x) => `${x.kind}|${x.author}|${x.mark ? "mark" : JSON.stringify(x.text)}|${x.nested ? "nested" : ""}`).sort();
let rnd = 0x5eed56;
const rand = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 2 ** 32; };

/** The scripted editing session (two reviewers). Returns the tracked document. */
async function session(): Promise<WordDoc> {
  const d = await blankWord("Tracked");
  const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: 0 }, "The quick brown fox jumps.");
  const p2 = E.splitParagraph(d, { pid: p0.id, off: 26 }); E.insertText(d, p2, "Second line here.");
  const p3 = E.splitParagraph(d, { pid: p2.pid, off: 17 }); E.insertText(d, p3, "Third.");
  E.setTracking(d, true, "Alice");
  E.deleteRange(d, { a: { pid: p0.id, off: 4 }, b: { pid: p0.id, off: 10 } });           // [quick ] deleted
  const at = E.insertText(d, { pid: p0.id, off: 10 }, "slow ");                         // {slow }
  E.insertText(d, at, "and ");                                                          // continues the same insertion
  const s = E.splitParagraph(d, { pid: p2.pid, off: 6 });                               // inserted paragraph mark
  E.joinBackward(d, p3.pid);                                                            // deleted paragraph mark (of " line here.")
  ok(s.pid, "split");
  E.insertText(d, { pid: p3.pid, off: 0 }, "XYZ");
  E.deleteRange(d, { a: { pid: p3.pid, off: 1 }, b: { pid: p3.pid, off: 2 } });           // own insertion → really removed
  E.insertPageBreak(d, { pid: p3.pid, off: E.plen(E.paraById(d, p3.pid)!) });           // object + paragraph mark insertion
  E.setTracking(d, true, "Bob");
  E.deleteRange(d, { a: { pid: p0.id, off: 10 }, b: { pid: p0.id, off: 14 } });          // "slow" inside Alice's insertion
  return d;
}
const ORIGINAL = "The quick brown fox jumps.\nSecond line here.\nThird.";
const FINAL = "The  and brown fox jumps.\nSecond\n line here.XZThird.\n";

if (!existsSync(PY)) { console.log("python venv missing — run scripts/sandbox/bootstrap.sh"); process.exit(1); }

await test("recording: each edit kind produces exactly the expected w:ins / w:del (lxml oracle); trackRevisions saved; ids unique; python-docx opens", COV, async () => {
  const d = await session();
  const o = oracle(await writeWord(d));
  eq(o.opens, true, "python-docx open");
  eq(o.track, true, "settings.xml w:trackRevisions");
  ok(o.ids_unique, "revision ids are not unique: " + JSON.stringify(o.revs.map((r) => r.id)));
  eq(sig(o.revs), [
    "del|Alice|\"quick \"|", "del|Alice|mark|", "del|Bob|\"slow\"|nested",
    "ins|Alice|\"\"|", "ins|Alice|\"XZ\"|", "ins|Alice|\"slow and \"|", "ins|Alice|mark|", "ins|Alice|mark|",
  ].sort(), "revision set");
  for (const r of o.revs) ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.date ?? ""), `w:date ${r.date}`);
  eq(o.reject_text, ORIGINAL, "reject-all view (oracle) is the original text");
  eq(o.accept_text, FINAL, "accept-all view (oracle) is the edited text");
  // our review list agrees with the file: one entry per (kind, id)
  eq(E.revisions(d).length, new Set(o.revs.map((r) => `${r.kind}:${r.id}`)).size, "revisions() count");
});

await test("accept-all / reject-all (ours) equal the oracle's independent resolution, on the live model and after a save/re-open", COV, async () => {
  for (const reopen of [false, true]) for (const accept of [true, false]) {
    let d = await session();
    if (reopen) d = await readWord(await writeWord(d), "t.docx");
    if (reopen) ok(E.revisions(d).every((c) => c.editable), "re-opened revisions parse as editable revision runs");
    const n = E.resolveChanges(d, accept);
    ok(n >= 7, `resolved ${n}`);
    const o = oracle(await writeWord(d));
    eq(o.revs, [], `revisions left (reopen=${reopen}, accept=${accept})`);
    eq(o.accept_text, accept ? FINAL : ORIGINAL, `text after ${accept ? "accept" : "reject"} all (reopen=${reopen})`);
    eq(o.opens, true, "opens");
  }
});

await test("per-change review: 40 random accept/reject decisions, applied one change at a time in random order, equal the oracle", COV, async () => {
  const base = await writeWord(await session());
  for (let trial = 0; trial < 40; trial++) {
    const d = await readWord(base, "t.docx");
    const list = E.revisions(d);
    const dec: Record<string, boolean> = {};
    for (const c of list) dec[c.key.slice(2)] = rand() < 0.5;
    const order = list.map((c) => c.key).sort(() => rand() - 0.5);
    for (const k of order) {
      // a deletion nested in an insertion disappears with that insertion when it is rejected first (Word does the same)
      const live = new Set(E.revisions(d).map((c) => c.key));
      if (live.has(k)) ok(E.resolveOne(d, k, dec[k.slice(2)]), `resolveOne ${k}`); else ok(!E.resolveOne(d, k, true), `stale key ${k} still resolves`);
    }
    eq(E.revisions(d), [], "all resolved");
    const ours = oracle(await writeWord(d)).accept_text;
    const want = oracle(base, dec).decided_text;
    eq(ours, want, `trial ${trial} decisions ${JSON.stringify(dec)}`);
  }
});

await test("next/previous order + toggling: revisions() is in document order; turning tracking off is saved; untracked edits add no revision", COV, async () => {
  const d = await readWord(await writeWord(await session()), "t.docx");
  eq(d.track.on, true, "trackRevisions read back");
  const o = E.order(d); const keys = E.revisions(d).map((c) => (o.get(c.pid) ?? 0) * 1e6 + c.off);
  eq(keys, keys.slice().sort((a, b) => a - b), "document order");
  E.setTracking(d, false);
  const before = E.revisions(d).length;
  const p = allParas(d.blocks)[0];
  E.insertText(d, { pid: p.id, off: E.plen(p) }, " Plain.");
  eq(E.revisions(d).length, before, "untracked insert recorded a revision");
  const o2 = oracle(await writeWord(d));
  eq(o2.track, false, "w:trackRevisions removed");
  ok(o2.accept_text.startsWith("The  and brown fox jumps. Plain."), o2.accept_text.slice(0, 60));
  ok(!o2.revs.some((r) => r.text.includes("Plain")), "Plain is not a revision");
});

await test("typing over a selection under tracking: deleted text stays, the insertion follows it (Word order); Delete key skips past", COV, async () => {
  const d = await blankWord("t"); const p = allParas(d.blocks)[0];
  E.insertText(d, { pid: p.id, off: 0 }, "alpha beta gamma");
  E.setTracking(d, true, "Ann");
  const at = E.deleteForReplace(d, { a: { pid: p.id, off: 6 }, b: { pid: p.id, off: 10 } });
  eq(at.off, 10, "caret after the struck text");
  E.insertText(d, at, "BETA");
  const f = E.deleteForward(d, { a: { pid: p.id, off: 15 }, b: { pid: p.id, off: 16 } });
  eq(f.off, 16, "Delete moves past the struck character");
  const o = oracle(await writeWord(d));
  eq(o.accept_text, "alpha BETA amma", "accept");
  eq(o.reject_text, "alpha beta gamma", "reject");
  const xml = (await openZip(await writeWord(d)).readText(d.docPath))!;
  ok(xml.indexOf("<w:delText>beta</w:delText>") < xml.indexOf(">BETA<"), "deletion precedes insertion in the XML");
});

await test("POI corpus: every document with run revisions re-serializes (all paragraphs regenerated) with the same revisions and the same accept/reject text", COV, async () => {
  if (!existsSync(CORPUS)) throw new Error("corpus missing — run scripts/corpus/fetch.py");
  let files = 0, revs = 0; const bad: string[] = [];
  for (const f of readdirSync(CORPUS).filter((x) => x.endsWith(".docx")).sort()) {
    const buf = new Uint8Array(readFileSync(join(CORPUS, f)));
    let xml: string | null = null;
    try { xml = await openZip(buf).readText("word/document.xml"); } catch { continue; }
    if (!xml || !/<w:(ins|del) /.test(xml)) continue;
    let d: WordDoc; try { d = await readWord(buf, f); } catch { continue; }
    let o0: Oracle; try { o0 = oracle(buf); } catch { continue; }
    for (const p of allParas(d.blocks)) p.dirty = true;
    const o1 = oracle(await writeWord(d));
    files++; revs += o0.revs.length;
    const same = JSON.stringify(sig(o0.revs)) === JSON.stringify(sig(o1.revs)) && o0.accept_text === o1.accept_text && o0.reject_text === o1.reject_text && o1.opens === true;
    if (!same) bad.push(f);
  }
  console.log(`  corpus: ${files} documents with revisions, ${revs} revisions, ${bad.length} differing: ${bad.join(", ")}`);
  ok(files >= 3, `only ${files} corpus documents with revisions`);
  eq(bad, [], "documents whose revisions changed on re-serialization");
});

await finish();
process.exit(0);
