/**
 * TT57 Writer — tracked FORMATTING changes (w:rPrChange, ECMA-376 §17.13.5.31) on top of the TT56 w:ins / w:del model.
 * Ground truth: the independent lxml oracle scripts/oracle/docx_track.py (`*_runs`: per-run direct formatting after
 * accepting / rejecting / deciding each revision by id), the Apache POI corpus (Tika-792.docx, delins.docx carry
 * Word-written rPrChange) and python-docx opening every saved file.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt57-writer-fmt.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, type WordDoc } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";

const { test, finish } = makeHarness("tt57-writer-fmt");
const COV = { "FF-22": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/docx";
const tmp = mkdtempSync(join(tmpdir(), "tt57f-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
type Seg = [string, boolean | null, boolean | null, boolean | null, boolean | null, number | null, string | null];
type Oracle = { revs: { kind: string; id: string; author: string; text: string; in_move?: boolean }[]; ids_unique: boolean; opens: boolean | string; accept_text: string; reject_text: string; accept_runs: Seg[]; reject_runs: Seg[]; decided_runs: Seg[]; decided_text: string };
let seq = 0;
const oracle = (bytes: Uint8Array, decisions?: Record<string, boolean>): Oracle => {
  const f = join(tmp, `o${seq++}.docx`); writeFileSync(f, bytes);
  return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_track.py", f, ...(decisions ? [JSON.stringify(decisions)] : [])], { encoding: "utf8", maxBuffer: 64 << 20 }));
};
let rnd = 0x5eed57;
const rand = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 2 ** 32; };
const P = (d: WordDoc, i = 0) => allParas(d.blocks)[i];
async function base(text = "Alpha beta gamma delta."): Promise<WordDoc> {
  const d = await blankWord("Fmt"); E.insertText(d, { pid: P(d).id, off: 0 }, text); return d;
}
/** what OUR model shows after resolving everything: saved without revisions and read by the oracle */
async function oursResolved(bytes: Uint8Array, accept: boolean): Promise<Seg[]> {
  const d = await readWord(bytes, "t.docx"); E.resolveChanges(d, accept);
  const o = oracle(await writeWord(d)); eq(o.revs, [], "no revisions left after resolveChanges"); return o.accept_runs;
}

if (!existsSync(PY)) { console.log("python venv missing — run scripts/sandbox/bootstrap.sh"); process.exit(1); }

await test("bold on a word with tracking on → one w:rPrChange holding the old (plain) rPr; accept keeps bold, reject restores plain — oracle and our model agree", COV, async () => {
  const d = await base(); E.setTracking(d, true, "Alice");
  const pid = P(d).id;
  E.applyFmt(d, { a: { pid, off: 6 }, b: { pid, off: 10 } }, { b: true });
  const ch = E.revisions(d); eq(ch.map((c) => [c.kind, c.text, c.detail, c.author]), [["fmt", "beta", "Bold", "Alice"]], "one formatting change listed");
  const bytes = await writeWord(d); const o = oracle(bytes);
  eq(o.opens, true, "python-docx opens"); ok(o.ids_unique, "ids unique");
  eq(o.revs.map((r) => [r.kind, r.text, r.author]), [["fmt", "beta", "Alice"]], "oracle sees one rPrChange");
  eq(o.accept_text, "Alpha beta gamma delta.", "text unchanged by a formatting change");
  const plain = (t: string): Seg => [t, false, false, false, false, null, null];
  eq(o.accept_runs, [plain("Alpha "), ["beta", true, false, false, false, null, null], plain(" gamma delta.")], "accept → bold");
  eq(o.reject_runs, [plain("Alpha beta gamma delta.")], "reject → plain");
  eq(await oursResolved(bytes, true), o.accept_runs, "our accept-all = oracle accept");
  eq(await oursResolved(bytes, false), o.reject_runs, "our reject-all = oracle reject");
  // the same decisions made in the live editor model (no reopen: the record has no file rPr, only the remembered format)
  for (const accept of [true, false]) {
    const m = await base(); E.setTracking(m, true, "Alice"); const q = P(m).id;
    E.applyFmt(m, { a: { pid: q, off: 6 }, b: { pid: q, off: 10 } }, { b: true });
    ok(E.resolveOne(m, E.revisions(m)[0].key, accept), "resolve in memory");
    eq(oracle(await writeWord(m)).accept_runs, accept ? o.accept_runs : o.reject_runs, `in-memory ${accept ? "accept" : "reject"} = oracle`);
  }
});

await test("formatting back to the original removes the record; a second change keeps the FIRST original (Word); untracked formatting adds nothing", COV, async () => {
  const d = await base(); const pid = P(d).id; const r = { a: { pid, off: 0 }, b: { pid, off: 5 } };
  E.applyFmt(d, r, { i: true }); eq(E.revisions(d), [], "untracked formatting is not a revision");
  E.setTracking(d, true, "Bob");
  E.applyFmt(d, r, { b: true }); E.applyFmt(d, r, { sz: 28 });
  const c = E.revisions(d); eq(c.map((x) => [x.kind, x.text, x.detail]), [["fmt", "Alpha", "Bold, Font size 14 pt"]], "one record, cumulative diff");
  const o = oracle(await writeWord(d));
  eq(o.reject_runs[0], ["Alpha", false, true, false, false, null, null], "reject returns to the pre-tracking formatting (italic, no bold, default size)");
  eq(o.accept_runs[0], ["Alpha", true, true, false, false, 28, null], "accept keeps bold + 14 pt + italic");
  E.applyFmt(d, r, { b: null, sz: null }); eq(E.revisions(d), [], "returning to the original formatting drops the record");
  eq(oracle(await writeWord(d)).revs, [], "and nothing is written");
});

await test("parsed rPrChange (Word-written, POI corpus) → listed with a detail; reject restores the recorded original rPr exactly; accept drops it — equal to the oracle", COV, async () => {
  for (const name of ["Tika-792.docx", "delins.docx"]) {
    const src = new Uint8Array(readFileSync(join(CORPUS, name)));
    // a formatting change INSIDE a move (w:moveFrom / w:moveTo) belongs to that opaque move token — decided with it
    const o = oracle(src); const fmts = o.revs.filter((r) => r.kind === "fmt" && !r.in_move);
    ok(o.revs.some((r) => r.kind === "fmt"), `${name}: oracle finds rPrChange`);
    const d = await readWord(src, name);
    const ours = E.revisions(d).filter((c) => c.kind === "fmt");
    // rPrChange inside content the editor keeps opaque (a field, a content control, a revision container it cannot
    // edit) is decided together with that opaque change; count those inside our tokens so every record is accounted for
    const countIn = (n: unknown): number => { const x = n as { k?: string; name?: string; kids?: unknown[] }; return x?.k === "el" ? (x.name === "w:rPrChange" ? 1 : 0) + (x.kids ?? []).reduce((a: number, k) => a + countIn(k), 0) : 0; };
    let opaque = 0; const tokRPr = new Set<unknown>(), textRPr = new Set<unknown>();
    for (const p of allParas(d.blocks)) for (const it of p.content) {
      if (it.t === "k") { opaque += it.nodes.reduce((a: number, n) => a + countIn(n), 0); if (it.rPr) tokRPr.add(it.rPr); } else if (it.rPr) textRPr.add(it.rPr);
    }
    // a run holding only objects (a field's instruction text, a break) carries its rPrChange on the token's run rPr
    for (const r of tokRPr) if (!textRPr.has(r)) opaque += countIn(r);
    eq(ours.length + opaque, o.revs.filter((r) => r.kind === "fmt").length, `${name}: every rPrChange is either a listed change (${ours.length}) or inside an opaque token (${opaque})`);
    ok(ours.length > 0 || name === "Tika-792.docx", `${name}: some formatting changes are directly reviewable`);
    const listed = new Set(ours.map((c) => c.key.slice(6)));
    ok(ours.every((c) => c.editable && c.detail), `${name}: editable with a detail`);
    for (const accept of [true, false]) {
      const d2 = await readWord(src, name);
      for (const c of E.revisions(d2).filter((x) => x.kind === "fmt")) ok(E.resolveOne(d2, c.key, accept), `resolve ${c.key}`);
      const mine = oracle(await writeWord(d2));
      eq(mine.revs.filter((r) => r.kind === "fmt" && listed.has(r.id)), [], `${name}: reviewed fmt records gone`);
      const want = oracle(src, Object.fromEntries(o.revs.map((r) => [`${r.kind}:${r.id}`, r.kind === "fmt" && listed.has(r.id) ? accept : true]))).decided_runs;
      const got = oracle(await writeWord(d2), {}).accept_runs;
      eq(got, want, `${name}: ${accept ? "accept" : "reject"} all formatting changes (insertions/deletions accepted on both sides)`);
    }
  }
});

await test("40 random sessions: random tracked formatting / typing / deleting over random ranges, random per-change decisions in random order — our result = oracle decided_runs; save → reopen keeps every record", COV, async () => {
  const keys = ["b", "i", "u", "s", "sz", "color"] as const;
  const val = (k: (typeof keys)[number]) => (k === "sz" ? [20, 28, 36][Math.floor(rand() * 3)] : k === "color" ? ["FF0000", "0070C0"][Math.floor(rand() * 2)] : k === "u" ? "single" : true);
  let fmtSeen = 0;
  for (let trial = 0; trial < 40; trial++) {
    const d = await base("one two three four five six seven");
    const p2 = E.splitParagraph(d, { pid: P(d).id, off: 33 }); E.insertText(d, p2, "eight nine ten");
    if (rand() < 0.4) E.applyFmt(d, { a: { pid: P(d).id, off: 4 }, b: { pid: P(d).id, off: 7 } }, { i: true }); // pre-existing formatting
    E.setTracking(d, true, rand() < 0.5 ? "Alice" : "Bob");
    for (let step = 0; step < 6; step++) {
      const pi = Math.floor(rand() * 2); const p = P(d, pi); const n = E.plen(p); if (n < 2) continue;
      const a = Math.floor(rand() * (n - 1)), b = a + 1 + Math.floor(rand() * Math.min(6, n - a - 1));
      const r = { a: { pid: p.id, off: a }, b: { pid: p.id, off: b } };
      const k = rand();
      if (k < 0.6) { const key = keys[Math.floor(rand() * keys.length)]; E.applyFmt(d, r, { [key]: rand() < 0.25 ? null : val(key) }); }
      else if (k < 0.8) E.insertText(d, { pid: p.id, off: a }, "XY");
      else E.deleteRange(d, r);
      if (rand() < 0.3) E.setTracking(d, true, rand() < 0.5 ? "Alice" : "Bob");
    }
    const bytes = await writeWord(d);
    const o0 = oracle(bytes); eq(o0.opens, true, `trial ${trial}: opens`);
    fmtSeen += o0.revs.filter((r) => r.kind === "fmt").length;
    // reopen keeps the same revision list (kinds, texts, authors)
    const re = await readWord(bytes, "t.docx");
    const sig = (x: WordDoc) => E.revisions(x).map((c) => `${c.kind}|${c.author}|${c.text}`).sort();
    eq(sig(re), sig(await readWord(await writeWord(re), "t.docx")), `trial ${trial}: save → reopen stable`);
    const list = E.revisions(re); const dec: Record<string, boolean> = {};
    for (const c of list) dec[c.key.slice(2)] = rand() < 0.5;
    for (const key of list.map((c) => c.key).sort(() => rand() - 0.5)) {
      const live = new Set(E.revisions(re).map((c) => c.key));
      if (live.has(key)) ok(E.resolveOne(re, key, dec[key.slice(2)]), `resolveOne ${key}`);
    }
    eq(E.revisions(re), [], `trial ${trial}: all resolved`);
    const ours = oracle(await writeWord(re));
    const want = oracle(bytes, dec);
    eq(ours.accept_text, want.decided_text, `trial ${trial}: text`);
    eq(ours.accept_runs, want.decided_runs, `trial ${trial}: formatting, decisions ${JSON.stringify(dec)}`);
  }
  ok(fmtSeen > 40, `random sessions produced formatting revisions (${fmtSeen})`);
});

await test("split formatted run: a tracked insertion typed inside a tracked-bold word → saved ids stay unique, both halves keep the record, oracle accept/reject agree", COV, async () => {
  const d = await base(); E.setTracking(d, true, "Alice");
  const pid = P(d).id;
  E.applyFmt(d, { a: { pid, off: 6 }, b: { pid, off: 16 } }, { b: true }); // "beta gamma"
  E.insertText(d, { pid, off: 10 }, "XYZ");
  const bytes = await writeWord(d); const o = oracle(bytes);
  ok(o.ids_unique, "revision ids unique after the split");
  eq(o.revs.filter((r) => r.kind === "fmt").map((r) => r.text).sort(), [" gamma", "beta"].sort(), "both halves carry a formatting record");
  const plain = (t: string): Seg => [t, false, false, false, false, null, null];
  eq(o.reject_runs, [plain("Alpha beta gamma delta.")], "reject all → original text, plain");
  eq(await oursResolved(bytes, false), o.reject_runs, "ours = oracle (reject)");
  eq(await oursResolved(bytes, true), o.accept_runs, "ours = oracle (accept)");
  const saved2 = oracle(await writeWord(d)); ok(saved2.ids_unique, "second save also unique");
});

await finish();
