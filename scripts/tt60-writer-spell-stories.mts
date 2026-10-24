/**
 * TT60 Writer spelling in every story — headers / footers and footnotes / endnotes (src/lib/office/wordspell.ts
 * storyIssues / allIssues / fixIssue on a story). Ground truth: the header / footer come from a .docx written by
 * python-docx (independent writer); the footnote is added with the editor; after fixes the saved file is read by the
 * independent oracles scripts/oracle/docx_hf.py (python-docx) and docx_notes.py (lxml), plus a direct lxml probe that the
 * header's bold run is still bold (formatting kept). Word verdicts come from the engine verified against spylls (tt59).
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt60-writer-spell-stories.mts
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { Speller } from "../src/lib/spell/hunspell.ts";
import { readWord, writeWord, allParas } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import * as WS from "../src/lib/office/wordspell.ts";

const { test, finish } = makeHarness("tt60-writer-spell-stories");
const COV = { "FF-42": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
function ok(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)?.slice(0, 700)} != ${JSON.stringify(b)?.slice(0, 700)}`); };
const sp = new Speller(readFileSync("public/dict/en_US.aff", "utf8"), readFileSync("public/dict/en_US.dic", "utf8"));
const dir = "/tmp/tt60stories"; mkdirSync(dir, { recursive: true });
const brief = (l: WS.SpellIssue[]) => l.map((i) => `${i.where ?? "Body"}:${i.kind}:${i.word.trim()}`);

execFileSync(PY, ["-c", `
import docx
d = docx.Document()
d.add_paragraph("Body text is fien.")
sec = d.sections[0]
hp = sec.header.paragraphs[0]
r = hp.add_run("Teh"); r.bold = True
hp.add_run(" quarterly headr")
fp = sec.footer.paragraphs[0]; fp.add_run("Page "); fp.add_run("foo").italic = True; fp.add_run("tr")
d.save("${dir}/in.docx")`]);
const load = async () => {
  const d = await readWord(new Uint8Array(readFileSync(`${dir}/in.docx`)));
  const p0 = allParas(d.blocks)[0];
  E.insertNote(d, { pid: p0.id, off: E.plen(p0) }, "footnote", "We recieve it.");
  E.insertNote(d, { pid: p0.id, off: 4 }, "endnote", "Fine words only.");
  // saved and re-opened, so the notes are file notes (not editor-dirty) and a fix must mark them for writing
  return readWord(await writeWord(d));
};
const probe = (f: string) => JSON.parse(execFileSync(PY, ["-c", `
import zipfile, json, re
from lxml import etree
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
z = zipfile.ZipFile("${f}")
out = {}
for n in z.namelist():
    if re.match(r"word/header\\d*\\.xml$", n):
        x = etree.fromstring(z.read(n))
        out["header_runs"] = [["".join(t.text or "" for t in r.iter(W + "t")), r.find(W + "rPr/" + W + "b") is not None] for r in x.iter(W + "r")]
print(json.dumps(out))`], { encoding: "utf8" }));
const hf = (f: string) => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_hf.py", f], { encoding: "utf8" }));
const notes = (f: string) => JSON.parse(execFileSync(PY, ["scripts/oracle/docx_notes.py", f], { encoding: "utf8" }));

await test("issues in every story: main text first, then header, footer, footnote — each with its place; spellIssues (main) unchanged", COV, async () => {
  const d = await load();
  eq(brief(WS.spellIssues(d, sp)), ["Body:spell:fien"], "main story only");
  eq(brief(WS.storyIssues(d, sp)), ["Header:spell:Teh", "Header:spell:headr", "Footer:spell:footr", "Footnote 1:spell:recieve"], "stories");
  eq(brief(WS.allIssues(d, sp)), ["Body:spell:fien", "Header:spell:Teh", "Header:spell:headr", "Footer:spell:footr", "Footnote 1:spell:recieve"], "all, in order");
  for (const i of WS.storyIssues(d, sp)) eq(WS.proofText(WS.issuePara(d, i)!).slice(i.off, i.off + i.len), i.word, "issuePara resolves " + i.word);
  eq(WS.allIssues(d, sp, { ignoreAll: new Set(["teh"]) }).length, 4, "Ignore All covers stories");
});

await test("fixing in a header keeps the run formatting (bold 'The'), footer + footnote fixed; saved file verified by python-docx (hf), lxml (notes, runs)", COV, async () => {
  const d = await load();
  for (const i of WS.storyIssues(d, sp).reverse()) WS.fixIssue(d, i, ({ Teh: "The", headr: "header", footr: "footer", recieve: "receive" } as Record<string, string>)[i.word]);
  eq(WS.storyIssues(d, sp), [], "no story issues left");
  const f = `${dir}/out.docx`; writeFileSync(f, await writeWord(d));
  const h = hf(f);
  const texts = JSON.stringify(h);
  ok(texts.includes("The quarterly header") && texts.includes("Page footer"), "python-docx header/footer text: " + texts.slice(0, 400));
  const n = notes(f);
  eq(Object.values(n.notes.footnote), ["We receive it."], "footnote text");
  eq(Object.values(n.notes.endnote), ["Fine words only."], "endnote untouched");
  eq(n.dangling, [], "no dangling refs");
  const pr = probe(f);
  eq(pr.header_runs, [["The", true], [" quarterly header", false]], "bold run kept bold; replaced inside the runs");
  // re-open: clean, and the main-text issue is still the only one
  eq(brief(WS.allIssues(await readWord(new Uint8Array(readFileSync(f))), sp)), ["Body:spell:fien"], "re-opened");
});

await test("Change All spans stories; a stale issue (text changed since the check) is refused; undo snapshots keep the old header blocks", COV, async () => {
  const d = await load();
  const p0 = allParas(d.blocks)[0];
  E.insertText(d, { pid: p0.id, off: E.plen(p0) }, " headr");
  const before = d.parts.get([...d.parts.keys()][0]);
  eq(WS.changeAll(d, sp, "headr", "header"), 2, "main + header");
  ok(d.parts.get([...d.parts.keys()][0]) !== before, "the header part array is replaced (an undo snapshot holding the old one restores it)");
  ok(JSON.stringify(before).includes("headr"), "the old array is untouched");
  const iss = WS.storyIssues(d, sp)[0];
  // simulate a stale issue: change the word first
  const stale = { ...iss, word: "Teh", off: iss.off };
  WS.fixIssue(d, iss, "The");
  WS.fixIssue(d, stale, "XXX");
  ok(!JSON.stringify(d.parts.get([...d.parts.keys()][0])).includes("XXX"), "stale fix refused");
  ok(d.hf.dirty.size >= 1, "header marked for re-serialisation");
});

await finish();
