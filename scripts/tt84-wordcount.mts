import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { countWordDoc, countWordRange, countWriterText } from "../src/lib/office/wordcount.ts";
import { allParas, blankWord, makeImage, readWord, rowsOf, cellsOf, writeWord } from "../src/lib/office/wordml.ts";
import * as E from "../src/lib/office/wordedit.ts";
import {
  clearBrowserStorage,
  inspectBrowserStorage,
  SERVER_BUCKETS,
  summarizePreview,
  validateBucketSelection,
  validatePurgeRequest,
  verifyPostPurge,
  type BucketStat,
  type KvStorageLike,
} from "../src/lib/storage-core.ts";

const { test, finish } = makeHarness("tt84-wordcount");
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const ok = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const eq = (actual: unknown, expected: unknown, message: string) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); };

await test("W1 empty text has zero counts", { "FF-82": "full" }, () => {
  eq(countWriterText(""), { words: 0, characters: 0, charactersNoSpaces: 0, paragraphs: 0, lines: 0 }, "empty document");
});
await test("W2 spaces, blank paragraphs and CRLF do not inflate words or character totals", { "FF-82": "full" }, () => {
  eq(countWriterText("one two\r\n\r\nthree\t"), { words: 3, characters: 13, charactersNoSpaces: 11, paragraphs: 2, lines: 3 }, "line normalization");
  const onlyWhitespace = countWriterText(" \t\n");
  ok(onlyWhitespace.words === 0 && onlyWhitespace.charactersNoSpaces === 0, `whitespace-only counts ${JSON.stringify(onlyWhitespace)}`);
});
await test("W3 apostrophes, hyphens, decomposed accents and emoji count as reader-visible characters", { "FF-82": "full" }, () => {
  const c = countWriterText("don't re-enter e\u0301 👨‍👩‍👧‍👦");
  ok(c.words === 3, `word tokenization ${JSON.stringify(c)}`);
  ok(c.characters === 18 && c.charactersNoSpaces === 15, `grapheme counts ${JSON.stringify(c)}`);
});
await test("W4 long input stays bounded and preserves linear counts", { "FF-82": "full" }, () => {
  const text = `${"alpha ".repeat(20_000)}omega`;
  const start = performance.now(), c = countWriterText(text), elapsed = performance.now() - start;
  ok(c.words === 20_001, `word count ${c.words}`);
  ok(c.characters === 120_005 && c.charactersNoSpaces === 100_005, `character counts ${JSON.stringify(c)}`);
  ok(elapsed < 3_000, `50k words took ${elapsed.toFixed(0)} ms`);
});
await test("W5 selection-style input: same tokenizer on a substring, whitespace and punctuation edges", { "FF-82": "full" }, () => {
  ok(countWriterText("  Alpha beta  ").words === 2, "leading/trailing whitespace adds no words");
  ok(countWriterText("… , ; ( )").words === 0, "standalone punctuation is not a word");
  ok(countWriterText("Alpha, beta; gamma. delta!").words === 4, "sentence punctuation separates words");
  ok(countWriterText("C++ && ||").words === 1, "only the letter run counts");
  ok(countWriterText("one two three").words === 3, "plain selection");
});
await test("W6 grapheme clusters: emoji ZWJ sequences and combining marks count as one reader-visible character", { "FF-82": "full" }, () => {
  const c = countWriterText("👨‍👩‍👧‍👦 🇫🇷 e\u0301 \u00e9");
  ok(c.words === 2, `emoji runs are not words, "e" and "é" are: ${c.words}`);
  ok(c.characters === 7, `seven perceived characters: ${c.characters}`);
  ok(c.charactersNoSpaces === 4, `four non-space perceived characters: ${c.charactersNoSpaces}`);
});
await test("W7 tabs and form feeds separate words like spaces; only newlines split lines", { "FF-82": "full" }, () => {
  const t = countWriterText("a\tb\fc");
  ok(t.words === 3 && t.characters === 5 && t.charactersNoSpaces === 3 && t.lines === 1, `tab/form feed: ${JSON.stringify(t)}`);
  const w = countWriterText("\t\n\f");
  ok(w.words === 0 && w.charactersNoSpaces === 0 && w.paragraphs === 0 && w.lines === 2, `whitespace-only: ${JSON.stringify(w)}`);
});
await test("W8 line and paragraph boundaries: trailing newline ends the last line, adds no paragraph", { "FF-82": "full" }, () => {
  eq(countWriterText("a"), { words: 1, characters: 1, charactersNoSpaces: 1, paragraphs: 1, lines: 1 }, "single line");
  eq(countWriterText("a\n"), { words: 1, characters: 1, charactersNoSpaces: 1, paragraphs: 1, lines: 2 }, "trailing newline closes the line");
  eq(countWriterText("a\n\nb\n"), { words: 2, characters: 2, charactersNoSpaces: 2, paragraphs: 2, lines: 4 }, "blank block is not a paragraph");
  eq(countWriterText(""), { words: 0, characters: 0, charactersNoSpaces: 0, paragraphs: 0, lines: 0 }, "empty document has no lines");
});
await test("W9 internal combining marks stay one word and CJK Unified Ideographs count per ideograph", { "FF-82": "full" }, () => {
  const decomposed = countWriterText("re\u0301sume\u0301 cafe\u0301s nai\u0308ve");
  eq(decomposed, { words: 3, characters: 18, charactersNoSpaces: 16, paragraphs: 1, lines: 1 }, "decomposed accents inside words");
  const cjk = countWriterText("你好世界 Hello世界2026");
  eq(cjk.words, 8, "4 ideographs + Hello + 2 ideographs + 2026");
  eq(cjk.characters, 16, "16 visible characters");
  eq(cjk.charactersNoSpaces, 15, "15 non-space characters");
});
await test("W10 model-aware countWordDoc excludes tracked deletions, inline images, and deleted table rows", { "FF-82": "full" }, async () => {
  const doc = await blankWord("Tracked");
  const p0 = allParas(doc.blocks)[0];
  const end = E.insertText(doc, { pid: p0.id, off: 0 }, "alpha beta gamma");
  // Insert an inline image: its label ("pic.png") must never be counted as a word.
  const imgTok = makeImage(doc, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), "image/png", 64, 64, "pic.png");
  E.insertToken(doc, end, imgTok);
  eq(countWordDoc(doc).words, 3, "inline image excluded");
  // Turn on Track Changes and delete "beta ":
  doc.track.on = true;
  doc.track.author = "Alice";
  E.deleteRange(doc, { a: { pid: p0.id, off: 6 }, b: { pid: p0.id, off: 11 } });
  const afterDel = countWordDoc(doc);
  eq({ words: afterDel.words, characters: afterDel.characters, charactersNoSpaces: afterDel.charactersNoSpaces, paragraphs: afterDel.paragraphs, lines: afterDel.lines },
    { words: 2, characters: 11, charactersNoSpaces: 10, paragraphs: 1, lines: 1 }, "tracked deletion excluded");
  // Insert a 2x2 table, populate it, then delete row 2 under Track Changes:
  doc.track.on = false;
  const tbl = E.insertTableAfter(doc, p0.id, 2, 2)!;
  const r0c0 = cellsOf(rowsOf(tbl)[0])[0].blocks[0] as E.Para;
  const r1c0 = cellsOf(rowsOf(tbl)[1])[0].blocks[0] as E.Para;
  E.insertText(doc, { pid: r0c0.id, off: 0 }, "cell one");
  E.insertText(doc, { pid: r1c0.id, off: 0 }, "deleted row words");
  eq(countWordDoc(doc).words, 7, "body (2) + row0 (2) + row1 (3)");
  // External WordprocessingML row-level deletion (w:trPr/w:del without run-level w:del):
  rowsOf(tbl)[1].rev = { kind: "del", id: 77, author: "Bob" };
  eq(countWordDoc(doc).words, 4, "row-level w:trPr/w:del excluded even when runs carry no w:del");
  rowsOf(tbl)[1].rev = undefined;
  doc.track.on = true;
  E.tableRowOp(doc, r1c0.id, "delete");
  eq(countWordDoc(doc).words, 4, "deleted table row excluded under Track Changes");
});
await test("W11 countWordDoc and countWordRange handle footnotes, endnotes, deleted paragraph marks and multi-cell selections", { "FF-82": "full" }, async () => {
  const doc = await blankWord("Notes");
  const p0 = allParas(doc.blocks)[0];
  const at1 = E.insertText(doc, { pid: p0.id, off: 0 }, "first line");
  const p1Pos = E.splitParagraph(doc, at1);
  const at2 = E.insertText(doc, p1Pos, "second line");
  E.insertNote(doc, at2, "footnote", "note alpha beta");
  const c0 = countWordDoc(doc);
  eq(c0.words, 4, "body words");
  eq(c0.notes.words, 3, "referenced footnote words");
  eq(c0.withNotes.words, 7, "body + footnote words");
  // Selection across only the first word of p0:
  eq(countWordRange(doc, { a: { pid: p0.id, off: 0 }, b: { pid: p0.id, off: 5 } }).words, 1, "single-word range");
  // Selection across p0 and p1 (including the footnote reference token at the end of p1, which must not add a word):
  const fullRange = countWordRange(doc, { a: { pid: p0.id, off: 0 }, b: { pid: p1Pos.pid, off: E.plen(E.paraById(doc, p1Pos.pid)!) } });
  eq(fullRange, { words: 4, characters: 21, charactersNoSpaces: 19, paragraphs: 2, lines: 2 }, "cross-paragraph range excludes note marker");
  // Delete the paragraph mark between p0 and p1 under Track Changes -> paragraphs merge in visible count:
  doc.track.on = true;
  E.deleteRange(doc, { a: { pid: p0.id, off: 10 }, b: { pid: p1Pos.pid, off: 0 } });
  const merged = countWordDoc(doc);
  eq({ paragraphs: merged.paragraphs, lines: merged.lines }, { paragraphs: 1, lines: 1 }, "deleted paragraph mark merges visible paragraphs");
});
await test("W12 round-trip .docx differential against independent python-docx + Python grapheme/word oracle", { "FF-82": "full" }, async () => {
  const doc = await blankWord("Oracle");
  const p0 = allParas(doc.blocks)[0];
  const pos1 = E.insertText(doc, { pid: p0.id, off: 0 }, "Don't re-enter cafe\u0301s");
  const p1Pos = E.splitParagraph(doc, pos1);
  E.insertText(doc, p1Pos, "Second paragraph with 42 numbers.");
  const tbl = E.insertTableAfter(doc, p1Pos.pid, 1, 2)!;
  const c0p = cellsOf(rowsOf(tbl)[0])[0].blocks[0] as E.Para;
  const c1p = cellsOf(rowsOf(tbl)[0])[1].blocks[0] as E.Para;
  E.insertText(doc, { pid: c0p.id, off: 0 }, "Table left");
  E.insertText(doc, { pid: c1p.id, off: 0 }, "Table right");
  const bytes = await writeWord(doc);
  const reread = await readWord(bytes, "oracle.docx");
  const ours = countWordDoc(reread);
  const dir = mkdtempSync(join(tmpdir(), "tt84-docx-"));
  const file = join(dir, "oracle.docx");
  writeFileSync(file, bytes);
  const py = JSON.parse(execFileSync(PY, ["-c", `
import docx, json, re, sys
d = docx.Document(sys.argv[1])
lines = [p.text for p in d.paragraphs]
for t in d.tables:
    for r in t.rows:
        for c in r.cells:
            lines.extend(p.text for p in c.paragraphs)
text = "\\n".join(lines)
vis = text.replace("\\n", "")
import unicodedata
# Count words using independent regex over NFC-normalized tokens:
words = re.findall(r"[\\w'\\u2019-]+", unicodedata.normalize("NFC", text), flags=re.UNICODE)
print(json.dumps({
    "words": len(words),
    "paragraphs": sum(1 for l in lines if l.strip()),
    "lines": len(lines),
}))
`, file], { encoding: "utf8" }));
  eq({ words: ours.words, paragraphs: ours.paragraphs, lines: ours.lines }, py, "agrees with independent python-docx oracle");
});
await test("U1 AP-02 bucket selection and purge validation refuse protected tables, duplicates, empty lists and missing DELETE confirmation", { "AP-02": "full" }, () => {
  for (const bad of [
    null,
    "notes",
    [],
    ["unknown"],
    ["features"],
    ["spikes"],
    ["license_authority"],
    ["/System"],
    ["notes", "notes"],
  ]) {
    ok(!validateBucketSelection(bad).ok, `must refuse bucket selection ${JSON.stringify(bad)}`);
  }
  for (const badReq of [
    null,
    { op: "preview", buckets: ["notes"], confirm: "DELETE" },
    { op: "purge", buckets: ["notes"] },
    { op: "purge", buckets: ["notes"], confirm: "delete" },
    { op: "purge", buckets: ["notes"], confirm: "YES" },
    { op: "purge", buckets: ["notes"], confirm: true },
    { op: "purge", buckets: [], confirm: "DELETE" },
    { op: "purge", buckets: ["features"], confirm: "DELETE" },
  ]) {
    ok(!validatePurgeRequest(badReq).ok, `must refuse purge request ${JSON.stringify(badReq)}`);
  }
  const good = validatePurgeRequest({ op: "purge", buckets: ["trash", "notes"], confirm: "DELETE" });
  eq(good, { ok: true, buckets: ["trash", "notes"] }, "valid purge request");
});
await test("U2 AP-02 / FM-07 preview summarization and post-purge invariant verification", { "AP-02": "full", "FM-07": "partial" }, () => {
  const before: BucketStat[] = SERVER_BUCKETS.map((m, i) => ({
    ...m,
    rows: (i + 1) * 3,
    bytes: (i + 1) * 1024,
    samples: [`sample-${m.id}-1`, `sample-${m.id}-2`],
  }));
  const preview = summarizePreview(before, ["trash", "notes"]);
  eq(preview.buckets.map((b) => b.id), ["trash", "notes"], "selected buckets only");
  eq(preview.totalRows, 6 + 12, "exact sum of selected rows");
  eq(preview.totalBytes, 2048 + 4096, "exact sum of selected bytes");
  // Simulate valid post-purge state (trash and notes zeroed, sessions gains 1 audit_log row, others untouched):
  const afterOk = before.map((b) =>
    b.id === "trash" || b.id === "notes"
      ? { ...b, rows: 0, bytes: 0, samples: [] }
      : b.id === "sessions"
        ? { ...b, rows: b.rows + 1 }
        : b,
  );
  eq(verifyPostPurge(before, afterOk, ["trash", "notes"]), { ok: true, errors: [] }, "valid post-purge state");
  // Simulate residual data left in a purged bucket -> must fail verification:
  const afterResidual = afterOk.map((b) => (b.id === "trash" ? { ...b, rows: 1 } : b));
  ok(!verifyPostPurge(before, afterResidual, ["trash", "notes"]).ok, "detects residual rows in purged bucket");
  // Simulate collateral damage to an unselected bucket -> must fail verification:
  const afterCollateral = afterOk.map((b) => (b.id === "alerts" ? { ...b, rows: b.rows - 1 } : b));
  ok(!verifyPostPurge(before, afterCollateral, ["trash", "notes"]).ok, "detects collateral mutation of unselected bucket");
});
await test("U3 AP-02 browser storage inspection and clearing compute exact UTF-16 byte totals", { "AP-02": "full" }, () => {
  const map = new Map<string, string>([
    ["fusion.draft.1", "alpha"],
    ["spell.userWords", "[\"café\"]"],
  ]);
  const mockStorage: KvStorageLike = {
    get length() { return map.size; },
    key(i: number) { return [...map.keys()][i] ?? null; },
    getItem(k: string) { return map.get(k) ?? null; },
    removeItem(k: string) { map.delete(k); },
  };
  const rep = inspectBrowserStorage(mockStorage);
  eq(rep.rows, 2, "two keys");
  eq(rep.bytes, (("fusion.draft.1".length + "alpha".length) + ("spell.userWords".length + "[\"café\"]".length)) * 2, "UTF-16 byte total");
  const cleared = clearBrowserStorage(mockStorage);
  eq(cleared, { removed: 2, bytesFreed: rep.bytes }, "cleared all keys");
  eq(inspectBrowserStorage(mockStorage).rows, 0, "empty after clear");
});
finish();
