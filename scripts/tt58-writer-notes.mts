/**
 * TT58 Writer — footnote / endnote EDITING (ECMA-376 §17.11): insert at the caret, edit the note text, delete (the note
 * leaves the package with its reference), numbering in reference order, untouched notes byte-identical.
 * Ground truth: the independent lxml oracle scripts/oracle/docx_notes.py (references in order, note texts, the
 * footnoteRef mark, separators, dangling / orphan notes, content type + relationship) and python-docx opening the file;
 * the Apache POI corpus (footnotes.docx, endnotes.docx, bug65649.docx, Bug54849.docx, table_footnotes.docx, form_footnotes.docx).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt58-writer-notes.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCentralDirectory, readEntry } from "../src/lib/server/zip.ts";
import { makeHarness } from "./harness.mts";
import { readWord, writeWord, blankWord, allParas, type WordDoc } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import { el } from "../src/lib/office/xmltree.ts";

const { test, finish } = makeHarness("tt58-writer-notes");
const COV = { "FF-22": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/docx";
const tmp = mkdtempSync(join(tmpdir(), "tt58n-"));
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 600)} != ${JSON.stringify(b)?.slice(0, 600)}`); };
type K = "footnote" | "endnote";
type Oracle = { refs: [K, string][]; notes: Record<K, Record<string, string>>; ref_mark: Record<K, Record<string, boolean>>; separators: Record<K, string[]>; dangling: unknown[]; orphans: [K, string][]; ids_unique: boolean; parts_ok: boolean; opens: boolean | string; styles: Record<K, Record<string, (string | null)[]>> };
let seq = 0;
const oracle = (bytes: Uint8Array): Oracle => { const f = join(tmp, `o${seq++}.docx`); writeFileSync(f, bytes); return JSON.parse(execFileSync(PY, ["scripts/oracle/docx_notes.py", f], { encoding: "utf8" })); };
const sound = (o: Oracle, m: string) => { eq(o.opens, true, `${m}: python-docx opens`); eq(o.dangling, [], `${m}: no dangling reference`); ok(o.ids_unique, `${m}: note ids unique`); ok(o.parts_ok, `${m}: notes parts have content type + relationship`); };
const P = (d: WordDoc, i = 0) => allParas(d.blocks)[i];
const plen = (d: WordDoc, i = 0) => P(d, i).content.reduce((s, it) => s + (it.t === "r" ? it.text.length : 1), 0);
const corpus = (f: string) => new Uint8Array(readFileSync(join(CORPUS, f)));
const partBytes = (bytes: Uint8Array, path: string) => { const b = Buffer.from(bytes); const e = readCentralDirectory(b).find((x) => x.name === path); return e ? readEntry(b, e) : undefined; };

if (!existsSync(PY)) { console.log("python venv missing — run scripts/sandbox/bootstrap.sh"); process.exit(1); }

await test("blank document: insert two footnotes and an endnote → footnotes.xml / endnotes.xml created with separators, content types, relationships, footnoteRef marks and FootnoteText style; numbering follows reference order", COV, async () => {
  const d = await blankWord("Notes");
  E.insertText(d, { pid: P(d).id, off: 0 }, "Alpha beta gamma.");
  const a = E.insertNote(d, { pid: P(d).id, off: 5 }, "footnote", "First note");
  E.insertNote(d, { pid: P(d).id, off: plen(d) }, "endnote", "An endnote\nsecond line");
  const b = E.insertNote(d, { pid: P(d).id, off: 1 }, "footnote", "Inserted before & <earlier>");
  eq(E.listNotes(d).map((n) => [n.type, n.n, n.text]), [["footnote", 1, "Inserted before & <earlier>"], ["footnote", 2, "First note"], ["endnote", 1, "An endnote\nsecond line"]], "listed in reference order with display numbers");
  const o = oracle(await writeWord(d)); sound(o, "new parts");
  eq(o.refs, [["footnote", b.id], ["footnote", a.id], ["endnote", "1"]], "references in document order");
  eq(o.notes.footnote, { [a.id]: "First note", [b.id]: "Inserted before & <earlier>" }, "footnote texts (escaped correctly)");
  eq(o.notes.endnote, { "1": "An endnote\nsecond line" }, "endnote: one paragraph per line");
  eq(o.separators, { footnote: ["separator", "continuationSeparator"], endnote: ["separator", "continuationSeparator"] }, "separator notes written");
  ok(o.ref_mark.footnote[a.id] && o.ref_mark.endnote["1"], "each note starts with its reference mark");
  eq(o.styles.footnote[a.id], ["FootnoteText"], "FootnoteText paragraph style"); eq(o.styles.endnote["1"], ["EndnoteText", "EndnoteText"], "EndnoteText on both lines");
  eq(o.orphans, [], "no orphans");
  // reopen: our reader sees the same notes
  const re = await readWord(await writeWord(d), "n.docx");
  eq(E.listNotes(re).map((n) => [n.type, n.n, n.text]), E.listNotes(d).map((n) => [n.type, n.n, n.text]), "reopened = same notes");
});

await test("edit and delete: setNoteText rewrites only that note; deleteNote removes reference and note; Backspace over a reference also drops the note on save; ids stay stable", COV, async () => {
  const d = await blankWord("Notes");
  E.insertText(d, { pid: P(d).id, off: 0 }, "One two three four.");
  const n1 = E.insertNote(d, { pid: P(d).id, off: 3 }, "footnote", "n1");
  const n2 = E.insertNote(d, { pid: P(d).id, off: 8 }, "footnote", "n2");
  const n3 = E.insertNote(d, { pid: P(d).id, off: 14 }, "footnote", "n3");
  ok(E.setNoteText(d, "footnote", n2.id, "n2 edited"), "edit"); ok(!E.setNoteText(d, "footnote", "999", "x"), "unknown note refused");
  ok(E.deleteNote(d, "footnote", n1.id), "delete n1"); ok(!E.deleteNote(d, "footnote", n1.id), "second delete is a no-op");
  let o = oracle(await writeWord(d)); sound(o, "after edit/delete");
  eq(o.refs.map((r) => r[1]), [n2.id, n3.id], "n1's reference gone"); eq(o.notes.footnote, { [n2.id]: "n2 edited", [n3.id]: "n3" }, "n1's note gone, n2 edited");
  eq(E.listNotes(d).map((n) => n.n), [1, 2], "renumbered 1, 2");
  // Backspace over n3's reference mark (the plain editor path, no deleteNote)
  const p = P(d); let off = 0; for (const it of p.content) { if (it.t === "k" && it.kind === "note" && it.note?.id === n3.id) break; off += it.t === "r" ? it.text.length : 1; }
  E.deleteRange(d, { a: { pid: p.id, off }, b: { pid: p.id, off: off + 1 } });
  o = oracle(await writeWord(d)); sound(o, "after Backspace");
  eq(o.notes.footnote, { [n2.id]: "n2 edited" }, "the typed-away reference's note is dropped"); eq(o.orphans, [], "no orphan left behind");
  // a reference the editor keeps inside OPAQUE XML (here a w:customXml wrapper) still holds its note: never dropped
  const n4 = E.insertNote(d, { pid: p.id, off: 0 }, "footnote", "inside opaque");
  const q = P(d); const at = q.content.findIndex((it) => it.t === "k" && it.kind === "note" && it.note?.id === n4.id);
  q.content[at] = { t: "k", kind: "other", bare: true, label: "", nodes: [el("w:customXml", { "w:element": "tag" }, [el("w:r", {}, [el("w:footnoteReference", { "w:id": n4.id })])])] }; q.dirty = true;
  E.setNoteText(d, "footnote", n2.id, "n2 again");
  o = oracle(await writeWord(d)); sound(o, "opaque reference");
  eq(o.notes.footnote[n4.id], "inside opaque", "the note referenced from opaque XML is kept"); eq(o.notes.footnote[n2.id], "n2 again", "other edits still written");
});

await test("POI corpus (6 files): untouched round trip keeps every notes part byte-identical; editing one note changes only that note; deleting one keeps the rest; all equal to the oracle", COV, async () => {
  const files = ["footnotes.docx", "endnotes.docx", "bug65649.docx", "Bug54849.docx", "table_footnotes.docx", "form_footnotes.docx"];
  let edited = 0;
  for (const f of files) {
    const src = corpus(f); const o0 = oracle(src);
    const d = await readWord(src, f);
    const ours = E.listNotes(d);
    eq(ours.map((n) => [n.type, n.id]), o0.refs, `${f}: our references = oracle`);
    for (const n of ours) eq(n.text, o0.notes[n.type][n.id], `${f}: ${n.type} ${n.id} text`);
    const same = await writeWord(d);
    for (const part of ["word/footnotes.xml", "word/endnotes.xml"]) { const a = partBytes(src, part), b = partBytes(same, part); if (a) ok(b && Buffer.from(a).equals(Buffer.from(b)), `${f}: ${part} byte-identical when untouched`); }
    if (!ours.length) continue;
    const t = ours[ours.length - 1];
    const d2 = await readWord(src, f); ok(E.setNoteText(d2, t.type, t.id, "Edited by TT58"), `${f}: edit`);
    const o2 = oracle(await writeWord(d2)); sound(o2, `${f} edited`);
    for (const [k, i] of o0.refs) eq(o2.notes[k][i], k === t.type && i === t.id ? "Edited by TT58" : o0.notes[k][i], `${f}: ${k} ${i} after editing ${t.id}`);
    eq(o2.separators, o0.separators, `${f}: separators kept`);
    edited++;
    if (ours.length > 1 || f === "footnotes.docx") {
      const d3 = await readWord(src, f); const victim = ours[0];
      ok(E.deleteNote(d3, victim.type, victim.id), `${f}: delete`);
      const o3 = oracle(await writeWord(d3)); sound(o3, `${f} deleted`);
      eq(o3.refs, o0.refs.filter((r) => !(r[0] === victim.type && r[1] === victim.id)), `${f}: references minus the deleted one`);
      ok(!(victim.id in o3.notes[victim.type]) || o0.refs.filter((r) => r[0] === victim.type && r[1] === victim.id).length > 1, `${f}: the deleted note left the package`);
    }
  }
  ok(edited >= 5, `edited notes in ${edited} corpus files`);
});

await test("Track Changes: a footnote inserted while recording is a tracked insertion (reject → reference and note gone); deleting one while recording keeps it as a pending deletion until accepted", COV, async () => {
  const d = await blankWord("Notes"); E.insertText(d, { pid: P(d).id, off: 0 }, "Tracked text.");
  E.setTracking(d, true, "Ann");
  const n = E.insertNote(d, { pid: P(d).id, off: 7 }, "footnote", "Tracked note");
  ok(E.revisions(d).some((c) => c.kind === "ins"), "the reference is listed as an insertion");
  let o = oracle(await writeWord(d)); sound(o, "tracked insert"); eq(o.refs, [["footnote", n.id]], "written while pending");
  const r = await readWord(await writeWord(d), "t.docx"); E.resolveChanges(r, false);
  o = oracle(await writeWord(r)); sound(o, "rejected"); eq([o.refs, o.notes.footnote], [[], {}], "reject: reference and note gone");
  const a = await readWord(await writeWord(d), "t.docx"); E.resolveChanges(a, true);
  o = oracle(await writeWord(a)); eq(o.notes.footnote, { [n.id]: "Tracked note" }, "accept: note kept");
  // pending deletion
  const m = await readWord(await writeWord(a), "m.docx"); E.setTracking(m, true, "Bo"); ok(E.deleteNote(m, "footnote", n.id), "delete while recording");
  o = oracle(await writeWord(m)); sound(o, "pending delete"); eq(o.notes.footnote, { [n.id]: "Tracked note" }, "pending deletion keeps the note");
  E.resolveChanges(m, true); o = oracle(await writeWord(m)); sound(o, "accepted delete"); eq([o.refs, o.notes.footnote], [[], {}], "accepting the deletion removes reference and note");
});

await test("120 random sessions: insert / edit / delete footnotes and endnotes at random places, save, reopen — our list = oracle references and texts, never dangling or orphaned, ids unique", COV, async () => {
  let rnd = 0x58a7;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) >>> 0; return rnd / 2 ** 32; };
  for (let t = 0; t < 120; t++) {
    let d = await blankWord("R"); E.insertText(d, { pid: P(d).id, off: 0 }, "The quick brown fox jumps over the lazy dog.");
    for (let k = 0; k < 7; k++) {
      const notes = E.listNotes(d); const op = rand();
      const kind: K = rand() < 0.7 ? "footnote" : "endnote";
      if (op < 0.5 || !notes.length) E.insertNote(d, { pid: P(d).id, off: Math.floor(rand() * (plen(d) + 1)) }, kind, `note ${t}.${k}${rand() < 0.2 ? "\nline 2" : ""}`);
      else if (op < 0.75) { const n = notes[Math.floor(rand() * notes.length)]; E.setNoteText(d, n.type, n.id, `edit ${t}.${k}`); }
      else { const n = notes[Math.floor(rand() * notes.length)]; E.deleteNote(d, n.type, n.id); }
      if (rand() < 0.15) d = await readWord(await writeWord(d), "r.docx");
    }
    const o = oracle(await writeWord(d)); sound(o, `trial ${t}`); eq(o.orphans, [], `trial ${t}: no orphans`);
    const ours = E.listNotes(d);
    eq(ours.map((n) => [n.type, n.id]), o.refs, `trial ${t}: references`);
    for (const n of ours) eq(n.text, o.notes[n.type][n.id], `trial ${t}: ${n.type} ${n.id} text`);
  }
});

finish();
