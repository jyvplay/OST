/** Production kernels, explicit finite inputs. Not native UI acceptance. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import { expandNoteTemplate, exportNoteCopies, importNoteCopies, insertNoteLink, markdownTable, mergedNote, noteBatch, NOTE_COLLECTION_BYTES, noteTemplate, replaceNoteText, splitNote, templateFilename } from "../src/lib/note-workflows.ts";
import { noteMarkdown } from "../src/lib/note-markdown.ts";
import { NOTE_LIMITS, type NoteRecord } from "../src/lib/note-model.ts";
import { sourceTextRange, displayedTextRange } from "../src/lib/text-selection.ts";
import { textDifference } from "../src/lib/text-difference.ts";
import { clipFilePath, clipboardSelection, transferableClip } from "../src/lib/clipboard-workflows.ts";
import { addClip } from "../src/lib/cliphistory.ts";
import { EMPTY_RESOURCES, literalPage, resourceOptions, searchResources } from "../src/lib/search-resources.ts";
import { EMPTY_SEARCH, searchInput } from "../src/lib/search-query.ts";
import { exportSearchResults } from "../src/lib/search-results-export.ts";
import { exportSavedSearches, importSavedSearches } from "../src/lib/saved-searches.ts";
import { pushRecent } from "../src/lib/recent-searches.ts";
const { test, finish } = makeHarness("tt134-workflows-core");
const fields = { title: 'μ "Copy" 🧭', body: "first\r\n<script>literal</script> 🧭\n", tags: "one,two", pinned: true };
const row: NoteRecord = { ...fields, id: 17, revision: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
await test("Copy-only batch validates all rows, forbids identities/unknowns, enforces 32 rows and UTF-8 budget", { "NT-19": "partial", "NT-20": "partial", "NT-21": "partial" }, () => {
  assert.deepEqual(noteBatch([fields]), [fields]); assert.equal(noteBatch(Array.from({ length: 32 }, () => fields)).length, 32);
  for (const bad of [null, [], [null], [{}], [{ ...fields, id: 3 }], [{ ...fields, expectedRevision: 1 }], [{ ...fields, extra: true }], [fields, { title: " " }], Array(33).fill(fields), [{ ...fields, body: "x".repeat(NOTE_LIMITS.body + 1) }]]) assert.throws(() => noteBatch(bad));
  assert.throws(() => noteBatch(Array.from({ length: 3 }, () => ({ ...fields, body: "🧭".repeat(524288) }))), /4 MiB/);
});
await test("Portable note copies round-trip editable fields only; unknown envelopes and identities are refused", { "NT-19": "partial" }, () => {
  const text = exportNoteCopies([row]); assert.deepEqual(importNoteCopies(text), [fields]);
  const parsed = JSON.parse(text); assert.equal(parsed.kind, "fusion.note-copies.v1"); assert.equal("id" in parsed.notes[0], false); assert.equal("revision" in parsed.notes[0], false);
  for (const bad of ['{', '[]', JSON.stringify({ ...parsed, extra: 1 }), JSON.stringify({ ...parsed, notes: [{ ...fields, id: 4 }] }), JSON.stringify({ ...parsed, notes: [{ ...fields, body: "\ud800" }] }), JSON.stringify({ ...parsed, kind: "other" }), " ".repeat(4194305)]) assert.throws(() => importNoteCopies(bad));
});
await test("Merge creates a separate saved-body composition, preserves inputs and rejects oversized output", { "NT-20": "partial" }, () => {
  const b = { ...row, id: 18, title: "Second", body: "tail" }; const before = JSON.stringify([row, b]);
  assert.equal(mergedNote([row, b], "Merged").body, `# ${row.title}\n\n${row.body}\n\n---\n\n# Second\n\ntail`);
  assert.equal(JSON.stringify([row, b]), before); assert.throws(() => mergedNote([row], "bad"));
  assert.throws(() => mergedNote([{ ...row, body: "x".repeat(1048576) }, b], "Too large"));
});
await test("Heading splits ignore fenced headings and preserve the exact CRLF source when rejoined", { "NT-21": "partial" }, () => {
  const value = { ...fields, title: "Original", body: "intro\r\n# Alpha\r\n```\r\n# not a section\r\n```\r\n# 🧭 Beta\r\nend\r\n" };
  const split = splitNote(value); assert.deepEqual(split.map(s => s.title), ["Original — introduction", "Alpha", "🧭 Beta"]); assert.equal(split.map(s => s.body).join(""), value.body); assert.ok(split.every(s => !s.pinned));
  for (const body of ["no heading", "# Only\ntext", "# First\n# Next\n" + "\n".repeat(5000), Array.from({ length: 33 }, (_, i) => `# Part ${i}`).join("\n")]) assert.throws(() => splitNote({ ...fields, body }));
});
await test("Literal replace is exact/case-sensitive, supports deletion, and refuses explosive expansion before construction", { "NT-22": "partial" }, () => {
  assert.deepEqual(replaceNoteText("a🧭a A a", "a", "$&"), { body: "$&🧭$& A $&", count: 3 }); assert.equal(replaceNoteText("abab", "ab", "").body, ""); assert.equal(replaceNoteText("abc", "X", "y").count, 0);
  assert.throws(() => replaceNoteText("x", "", "")); assert.throws(() => replaceNoteText("x".repeat(1048576), "x", "yy"), /exceed/); assert.throws(() => replaceNoteText("x", "x", "\ud800"));
});
await test("Link construction replaces only the selected range, rejects active schemes/bracket labels, encodes URL parentheses", { "NT-23": "partial" }, () => {
  assert.equal(insertNoteLink("aa🧭zz", 2, 4, "Compass", "https://example.com/a(b)"), "aa[Compass](https://example.com/a%28b%29)zz");
  for (const url of ["javascript:alert(1)", "data:text/html,test", "https://bad .invalid", "/relative"]) assert.throws(() => insertNoteLink("a", 0, 1, "test", url));
  for (const label of ["[bad]", "bad\tlabel", "bad\u0001label", "bad\x7flabel"]) assert.throws(() => insertNoteLink("a", 0, 1, label, "https://example.com")); assert.throws(() => insertNoteLink("🧭", 1, 2, "x", "https://example.com"));
});
await test("Pipe tables parse escaped pipes/backslashes and alignment, keep HTML as text and bound rows/columns", { "NT-24": "partial" }, () => {
  const doc = noteMarkdown("| left \\| pipe | right |\n| :--- | ---: |\n| <img src=x> | **bold** |\n"); const table = doc.blocks[0]; assert.equal(table.kind, "table");
  if (table.kind === "table") { assert.deepEqual(table.header, ["left | pipe", "right"]); assert.deepEqual(table.align, ["left", "right"]); assert.equal(table.rows[0][0], "<img src=x>"); }
  const built = noteMarkdown(markdownTable(16, 100)); assert.equal(built.blocks[0].kind, "table"); if (built.blocks[0].kind === "table") assert.equal(built.blocks[0].rows.length, 100);
  for (const dimensions of [[1, 1], [17, 1], [2, 0], [2, 101], [2.5, 3]]) assert.throws(() => markdownTable(dimensions[0], dimensions[1]));
  assert.notEqual(noteMarkdown("A|B\n--|---\nx|y").blocks[0].kind, "table");
});
await test("Templates expand only three plain tokens using the supplied real clock; no expression execution or recursive evaluation", { "NT-25": "partial" }, () => {
  const now = new Date(), t = noteTemplate({ kind: "fusion.note-template.v1", fields: { ...fields, body: "{{title}}/{{date}}/{{time}}/{{globalThis.alert(1)}}" } });
  const value = expandNoteTemplate(t, "{{date}}", now); assert.ok(value.body.startsWith("{{date}}/")); assert.ok(value.body.endsWith("/{{globalThis.alert(1)}}")); assert.equal(value.pinned, false);
  assert.match(value.body, /\/\d{4}-\d{2}-\d{2}\/\d{2}:\d{2}\//);
  for (const name of ["../x", "/x", "x\\y", "\0", " ", ".", "x".repeat(81)]) assert.throws(() => templateFilename(name)); assert.equal(templateFilename("μ notes"), "μ notes.json");
  assert.throws(() => noteTemplate({ ...t, script: "evil()" })); assert.throws(() => noteTemplate({ kind: t.kind, fields: { ...fields, id: 7 } }));
});
await test("Saved-body/clipboard line diff exactly reconstructs each side, including empty/CRLF/Unicode; it is not an LCS claim", { "NT-26": "partial", "CB-08": "partial" }, () => {
  for (const [a, b] of [["", ""], ["x\r\n🧭\nend", "x\r\ny\nend"], ["a\nb\na", "a\na"], ["x", ""], ["", "y"], ["a\n", "a"]]) {
    const d = textDifference(a, b); assert.equal([...d.before, ...d.removed, ...d.after].join("\n"), a); assert.equal([...d.before, ...d.added, ...d.after].join("\n"), b); assert.equal(d.equal, a === b);
  }
  assert.throws(() => textDifference("x".repeat(1048577), ""));
});
await test("Clipboard tools refuse sensitive/oversized/invalid text without discarding original entries", { "CB-04": "partial", "CB-05": "partial", "CB-06": "partial", "CB-07": "partial", "CB-08": "partial" }, () => {
  const c = { at: Date.now(), text: fields.body, from: "test", sensitive: false }; assert.equal(transferableClip(c), fields.body);
  for (const entry of [{ ...c, sensitive: true }, { ...c, text: "x\0" }, { ...c, text: "\udfff" }, { ...c, text: "x".repeat(1048577) }]) assert.throws(() => transferableClip(entry)); assert.equal(c.text, fields.body);
});
await test("Template budget includes the complete wrapper: exact 4 MiB roundtrip, one byte over refused", { "NT-25": "partial" }, () => {
  const fields = { title: "Boundary", body: "", tags: "", pinned: false };
  const remaining = NOTE_COLLECTION_BYTES - Buffer.byteLength(JSON.stringify({ kind: "fusion.note-template.v1", fields }));
  fields.body = "\u0001".repeat(Math.floor(remaining / 6)) + "a".repeat(remaining % 6);
  const template = noteTemplate({ kind: "fusion.note-template.v1", fields });
  const text = JSON.stringify(template); assert.equal(Buffer.byteLength(text), NOTE_COLLECTION_BYTES); assert.deepEqual(noteTemplate(JSON.parse(text)), template);
  assert.throws(() => noteTemplate({ ...template, fields: { ...fields, body: fields.body + "a" } }), /complete template/);
});
await test("Native LF textarea offsets map back to exact CRLF/CR source excerpts, with invalid ranges refused", { "CB-04": "partial" }, () => {
  assert.equal(clipboardSelection("a\r\n🧭z", 1, 4), "\r\n🧭"); assert.equal(clipboardSelection("a\rb", 1, 2), "\r"); assert.equal(clipboardSelection("abc", 3, 3), "");
  for (const [start, end] of [[-1, 2], [2, 1], [0, 4], [0.5, 2]]) assert.throws(() => clipboardSelection("abc", start, end));
});
await test("Source/native textarea ranges invert across every boundary in mixed CRLF/CR/Unicode text", { "NT-22": "partial", "NT-23": "partial", "CB-04": "partial" }, () => {
  const source = "head\r\n🧭tail\rnext\n", displayed = source.replace(/\r\n?/g, "\n");
  for (let start = 0; start <= displayed.length; start++) for (let end = start; end <= displayed.length; end++) {
    const raw = sourceTextRange(source, start, end);
    assert.deepEqual(displayedTextRange(source, raw.start, raw.end), { start, end });
    assert.equal(source.slice(raw.start, raw.end).replace(/\r\n?/g, "\n"), displayed.slice(start, end));
  }
  assert.throws(() => displayedTextRange("a\r\nb", 2, 3), /splits a CRLF/); assert.throws(() => displayedTextRange("a", 0, 2));
});
await test("Create-only clipboard destinations reject Private, traversal, repeated slash and noncanonical paths", { "CB-07": "partial" }, () => {
  assert.equal(clipFilePath(" /Documents/μ.txt "), "/Documents/μ.txt");
  for (const path of ["relative.txt", "/", "/a/../b", "/a//b", "/x/", "/Private", "/Private/x", "/x\\y", "/a\nb", "/\ud800"]) assert.throws(() => clipFilePath(path));
});
await test("Same-millisecond/clock-rollback captures retain distinct identities and independent removal/pin targets", { "CB-08": "partial" }, () => {
  const a = { at: 17, text: "one", from: "a", sensitive: false }; const list = addClip([a], { ...a, text: "two" }); assert.equal(new Set(list.map(c => c.at)).size, 2); assert.equal(list[1].at, 17);
  const rolled = addClip(list, { at: 1, text: "three", from: "b", sensitive: false }); assert.equal(new Set(rolled.map(c => c.at)).size, 3); assert.equal(list.length, 2);
});
await test("170,000 retained pins do not overflow a timestamp spread/argument stack", { "CB-08": "partial" }, () => {
  const list = Array.from({ length: 170_000 }, (_, at) => ({ text: `pinned ${at}`, from: "finite kernel fixture", sensitive: false, pinned: true, at }));
  const next = addClip(list, { text: "new", from: "capture", at: 0, sensitive: false }, list.length + 1);
  assert.equal(next.length, list.length + 1); assert.equal(next[0].at, 170_000); assert.equal(list[list.length - 1].at, 169_999);
});
await test("Resource filters validate exact UTC calendar days, half-open intervals and canonical safe byte ranges", { "SR-20": "partial", "SR-21": "partial" }, () => {
  assert.deepEqual(searchResources({ modifiedAfter: "2024-02-29", modifiedBefore: "2024-03-01", minBytes: "0", maxBytes: "9007199254740991" }), { ...EMPTY_RESOURCES, modifiedAfter: "2024-02-29", modifiedBefore: "2024-03-01", minBytes: "0", maxBytes: "9007199254740991" });
  for (const value of [{ modifiedAfter: "2025-02-29" }, { modifiedAfter: "0000-01-01" }, { modifiedBefore: "2026-13-01" }, { modifiedAfter: "2026-01-01", modifiedBefore: "2026-01-01" }, { minBytes: "-1" }, { maxBytes: "01" }, { minBytes: "1e3" }, { minBytes: "9007199254740992" }, { minBytes: "20", maxBytes: "19" }]) assert.throws(() => searchResources(value));
  assert.throws(() => searchInput({ ...EMPTY_SEARCH, source: "spec", minBytes: "1" }));
});
await test("Folder exclusion is canonical, rejects traversal and retains SQL wildcard characters as literal path data", { "SR-22": "partial" }, () => {
  assert.equal(resourceOptions(new URLSearchParams({ excludeFolder: "/Docs/a%_/'quote/" })).excludeFolder, "/Docs/a%_/'quote");
  for (const excludeFolder of ["relative", "/Docs/../Private", "/Docs//x", "/x\\y", "/x\0"]) assert.throws(() => searchResources({ excludeFolder }));
});
await test("Literal paging allows exactly four bounded public offsets, rejects ranked/metadata/invalid continuations", { "SR-25": "partial" }, () => {
  for (const offset of [0, 50, 100, 150]) assert.deepEqual(literalPage(new URLSearchParams({ match: "literal", offset: String(offset), publicPages: "1" })), { offset, publicPages: true });
  const invalidPages: Record<string, string>[] = [{ match: "ranked", offset: "50" }, { match: "literal", offset: "200" }, { match: "literal", offset: "-1" }, { match: "literal", offset: "050" }, { match: "literal", publicPages: "yes" }, { match: "literal", mode: "metadata", offset: "50" }];
  for (const params of invalidPages) assert.throws(() => literalPage(new URLSearchParams(params)));
});
await test("New resource predicates round-trip complete profiles/history, while legacy profiles get explicit empty defaults", { "SR-20": "partial", "SR-21": "partial", "SR-22": "partial", "SV-02": "partial", "SR-19": "partial" }, () => {
  const input = searchInput({ ...EMPTY_SEARCH, q: "needle", modifiedAfter: "2020-01-01", modifiedBefore: "2025-01-01", minBytes: "3", maxBytes: "700", excludeFolder: "/Archive" });
  const saved = { ...input, id: "real-profile", name: "Resource search", savedAt: Date.now() };
  assert.deepEqual(importSavedSearches(exportSavedSearches([saved]))[0], saved); assert.equal(pushRecent([], { ...input, at: Date.now() })[0].excludeFolder, "/Archive");
  const old = searchInput({ q: "old", source: "file" }); for (const key of Object.keys(EMPTY_RESOURCES)) assert.equal(old[key as keyof typeof EMPTY_RESOURCES], "");
});
await test("Result JSON is lossless for visible rows/query; CSV neutralizes spreadsheet formulas and independently parses quotes/newlines", { "SR-23": "partial" }, () => {
  const hits = ["=1+1", " +SUM(1,2)", "-9", "@evil", 'μ "quoted"\nline 🧭'].map((title, i) => ({ source: "note", ref: String(i + 1), title, snippet: fields.body, how: "literal", rank: 0.05 }));
  assert.deepEqual(JSON.parse(exportSearchResults(EMPTY_SEARCH, hits, "json")).hits, hits);
  const csv = exportSearchResults(EMPTY_SEARCH, hits, "csv");
  const parsed = JSON.parse(execFileSync("python3", ["-c", "import csv,sys,json,io;print(json.dumps(list(csv.reader(io.StringIO(sys.stdin.read())))))"], { input: csv, encoding: "utf8" }));
  assert.equal(parsed.length, 6); assert.equal(parsed[1][2], "'=1+1"); assert.equal(parsed[2][2], "' +SUM(1,2)"); assert.equal(parsed[5][2], hits[4].title); assert.equal(parsed[5][3], fields.body);
  assert.throws(() => exportSearchResults(EMPTY_SEARCH, Array(201).fill(hits[0]), "json")); assert.throws(() => exportSearchResults(EMPTY_SEARCH, [{ ...hits[0], rank: NaN }], "json"));
});
await test("Comparison-limit copy attack: supplementary Unicode is counted as UTF-16 code units, never MiB bytes", { "NT-26": "partial", "CB-08": "partial" }, () => {
  assert.equal(textDifference("😀".repeat(524288), "").removed[0].length, 1_048_576);
  assert.throws(() => textDifference("😀".repeat(524289), ""), /1,048,576 UTF-16 code units per side/);
});
finish();
