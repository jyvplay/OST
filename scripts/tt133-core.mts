/** Original finite adversarial cases over the production kernels. No mocks,
 * simulated devices or alternate implementations substituted for app code. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { NOTE_LIMITS, noteCopyTitle, noteTitlePrefix, assertNoteRevision, excerptNote, filterNotes, importNoteMarkdown, noteInteger, noteWrite, sameNote, type NoteRecord } from "../src/lib/note-model.ts";
import { clearRamNoteDrafts, decodeNoteDraft, NOTE_RAM_DRAFT_LIMITS, NOTE_DRAFT_TTL, noteDraftKey, readNoteDraft, removeNoteDraft, writeNoteDraft } from "../src/lib/note-drafts.ts";
import { noteInline, noteMarkdown, NOTE_PREVIEW_LINES, safeNoteLink, toggleNoteTask } from "../src/lib/note-markdown.ts";
import { diagnosticFilePath, EMPTY_SEARCH, hasSearchExtension, orderSearchHits, searchExtension, searchInput, searchOptions, searchScope } from "../src/lib/search-query.ts";
import { exportSavedSearches, importSavedSearches, validateSavedSearches } from "../src/lib/saved-searches.ts";
import { pushRecent, validateRecents } from "../src/lib/recent-searches.ts";
import { searchIndexText } from "../src/lib/search-index-text.ts";
import { searchDocs } from "../src/lib/privacy/psearch.ts";
import { backlinks, resolveLinks } from "../src/lib/note-links.ts";
const { test, finish } = makeHarness("tt133-core");
const record: NoteRecord = { id: 7, revision: 3, title: "Original", body: "# Intro\nAlpha beta\n", tags: "one", pinned: false, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z" };
await test("Notes validator rejects wrong fields, blank/control titles, malformed Unicode, oversized bodies and nonintegral IDs", { "NT-10": "partial" }, () => {
  assert.deepEqual(noteWrite({}), { title: "Untitled", body: "", tags: "", pinned: false });
  assert.equal(noteWrite({ title: "  μ → 🧭  " }).title, "μ → 🧭");
  for (const input of [{ title: null }, { title: " " }, { title: "a\nb" }, { title: "x".repeat(NOTE_LIMITS.title + 1) }, { body: 1 }, { body: "x\0y" }, { body: "x".repeat(NOTE_LIMITS.body + 1) }, { tags: [] }, { tags: "a".repeat(NOTE_LIMITS.tags + 1) }, { pinned: "false" }, { body: "a\ud800b" }, { title: "\udfff" }]) assert.throws(() => noteWrite(input));
  for (const id of [0, -1, 1.2, NaN, Infinity, "7", 2_147_483_648]) assert.throws(() => noteInteger(id));
  assert.throws(() => noteWrite({}, record), /no editable/); assert.equal(noteWrite({ body: "changed" }, record).pinned, false);
});
await test("Revision comparison rejects stale saves including equal-content ABA histories", { "NT-10": "partial" }, () => {
  assertNoteRevision(3, 3); assert.throws(() => assertNoteRevision(1, 3), e => (e as { status?: number }).status === 409);
  const laterRevision: NoteRecord = { ...record, revision: 5 };
  assert.ok(sameNote(record, laterRevision)); assert.throws(() => assertNoteRevision(3, 5));
  for (const value of [null, "3", {}, -1, 1.1]) assert.throws(() => assertNoteRevision(value, 3));
});
await test("Per-window recovery keys are injective; strict codecs preserve content and reject stale/future/malformed records", { "NT-09": "partial" }, () => {
  const draft = { v: 1 as const, base: record, value: { ...record, body: "a\r\n\t🧭 \" \\" }, savedAt: Date.now() };
  assert.notEqual(noteDraftKey("a:b", 7), noteDraftKey("a", 7)); assert.notEqual(noteDraftKey("a", 7), noteDraftKey("a", 8));
  assert.equal(decodeNoteDraft(JSON.stringify(draft), 7)?.value.body, draft.value.body);
  assert.equal(decodeNoteDraft(JSON.stringify(draft), 8), null);
  for (const bad of [{ ...draft, v: 2 }, { ...draft, savedAt: draft.savedAt - NOTE_DRAFT_TTL - 1 }, { ...draft, savedAt: draft.savedAt + 120_000 }, { ...draft, base: { ...record, revision: 0 } }, { ...draft, value: { ...draft.value, pinned: "yes" } }]) assert.equal(decodeNoteDraft(JSON.stringify(bad), 7, draft.savedAt), null);
  assert.equal(decodeNoteDraft("{", 7), null);
});
await test("Amnesic draft path uses actual page-RAM storage operations and the same decoder, never an injected persistent store", { "NT-09": "partial" }, () => {
  const key = noteDraftKey("core-amnesic", 7), draft = { v: 1 as const, base: record, value: { ...record, body: "RAM draft" }, savedAt: Date.now() };
  writeNoteDraft(null, key, draft); assert.equal(readNoteDraft(null, key, 7)?.value.body, "RAM draft"); removeNoteDraft(null, key); assert.equal(readNoteDraft(null, key, 7), null);
});
await test("Note filter is NFKC/case-normalized, ANDs terms across title/body/tags, and preserves original order/data", { "NT-11": "full" }, () => {
  const rows = [record, { ...record, id: 8, title: "Fusion", body: "Blue sky", tags: "travel" }];
  assert.deepEqual(filterNotes(rows, "ｆｕｓｉｏｎ TRAVEL").map(n => n.id), [8]); assert.equal(filterNotes(rows, "blue absent").length, 0);
  assert.deepEqual(filterNotes(rows, " "), rows); assert.equal(rows[1].title, "Fusion");
});
await test("Markdown import: fatal UTF-8, byte cap and NUL rejection; exact CRLF body and first heading title", { "NT-13": "partial" }, () => {
  const body = "# μ Compass\r\nKeep <script>literal</script>\r\n";
  const imported = importNoteMarkdown(new TextEncoder().encode(body), "fallback.md"); assert.equal(imported.body, body); assert.equal(imported.title, "μ Compass");
  assert.equal(importNoteMarkdown(new TextEncoder().encode("plain"), "fallback.md").title, "fallback");
  assert.throws(() => importNoteMarkdown(new Uint8Array([0xff, 0xfe]), "bad.md"), /UTF-8/);
  assert.throws(() => importNoteMarkdown(new Uint8Array(NOTE_LIMITS.body + 1), "big.md"), /1 MiB/);
  assert.throws(() => importNoteMarkdown(new TextEncoder().encode("nul\0"), "bad.md"));
});
await test("Markdown blocks: headings, fenced code, quotes, list items and task lines, with explicit line budget", { "NT-12": "partial", "NT-15": "partial" }, () => {
  const source = "# Top\n```html\n# Not a heading\n<script>x()</script>\n```\n> Quote\n- Item\n- [ ] Task\n";
  const parsed = noteMarkdown(source); assert.equal(parsed.blocks.filter(b => b.kind === "heading").length, 1); assert.equal(parsed.blocks.find(b => b.kind === "code")?.text, "# Not a heading\n<script>x()</script>");
  assert.deepEqual(parsed.blocks.filter(b => b.kind === "task").map(b => b.line), [7]); assert.equal(parsed.truncated, false);
  assert.equal(noteMarkdown("x\n".repeat(NOTE_PREVIEW_LINES + 5)).blocks.length, NOTE_PREVIEW_LINES); assert.equal(noteMarkdown("x\n".repeat(NOTE_PREVIEW_LINES + 5)).truncated, true);
});
await test("Inline view uses text-only tokens; executable/relative/data URLs are not links and unmatched delimiters are linear-bounded", { "NT-12": "partial" }, () => {
  for (const url of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd", "/relative", "https://a.test/\nattack", "vbscript:x"]) assert.equal(safeNoteLink(url), null);
  assert.equal(safeNoteLink("https://example.test/a?q=1&b=2"), "https://example.test/a?q=1&b=2"); assert.ok(safeNoteLink("mailto:hello@example.test"));
  const tokens = noteInline("<img src=x onerror=alert(1)> **strong** *em* `code` ~~gone~~ [bad](javascript:alert(1))");
  assert.ok(tokens.some(t => t.kind === "text" && t.text.includes("<img"))); assert.ok(tokens.some(t => t.kind === "link" && t.href === null));
  const start = performance.now(), long = "[".repeat(100_000); assert.deepEqual(noteInline(long), [{ kind: "text", text: long }]);
  const elapsed = performance.now() - start; console.log(`  native unmatched-delimiter scan: ${elapsed.toFixed(3)} ms`); assert.ok(elapsed < 2500, "pathological unmatched delimiters exceeded a coarse 2.5s budget");
});
await test("Checklist edits change exactly one marker, preserve CRLF and unrelated text, and refuse stale line numbers", { "NT-17": "partial" }, () => {
  const body = "# Plan\r\n- [ ] μ task\r\n- [X] already\r\n";
  const next = toggleNoteTask(body, 1); assert.equal(next, "# Plan\r\n- [x] μ task\r\n- [X] already\r\n"); assert.equal(toggleNoteTask(next, 1), body);
  assert.throws(() => toggleNoteTask(body, 0)); assert.throws(() => toggleNoteTask(body, -1)); assert.throws(() => toggleNoteTask(body, 99));
});
await test("Excerpt extraction is an exact UTF-16 selection, never modifies its source, and refuses empty/out-of-range selections", { "NT-16": "partial" }, () => {
  const body = "Alpha\n🧭 beta\n"; assert.equal(excerptNote(body, 6, 13), "🧭 beta"); assert.equal(body, "Alpha\n🧭 beta\n");
  for (const [a, b] of [[0, 0], [-1, 2], [2, 1], [0, 99], [0.5, 4]]) assert.throws(() => excerptNote(body, a, b));
});
await test("Search inputs reject malformed source/mode/strategies/scopes, normalize only documented folder/suffix forms", { "SR-13": "partial", "SR-16": "partial" }, () => {
  assert.equal(searchScope(" /Documents/ "), "/Documents"); assert.equal(searchScope("/"), "/");
  for (const path of ["relative", "/Private/../Documents", "/./x", "/a//b", "//", "/a\0b"]) assert.throws(() => searchScope(path));
  assert.equal(searchExtension("MD"), ".md"); assert.equal(searchExtension(".tar.gz"), ".tar.gz");
  for (const extension of ["%", ".m*", ".a/b", ".", "x".repeat(33)]) assert.throws(() => searchExtension(extension));
  for (const input of [{ source: "other" }, { match: "semantic" }, { mode: "other" }, { source: "note", extension: ".md" }, { mode: "metadata", source: "spec" }, { phrase: "true" }, { q: "x".repeat(513) }]) assert.throws(() => searchInput(input));
  assert.deepEqual(searchOptions(new URLSearchParams("q=alpha&source=file&extension=MD&match=literal")), { q: "alpha", source: "file", extension: ".md", match: "literal", scope: "" });
});
await test("Result order is deterministic, copies rather than mutates, and uses source/reference tie-breaks", { "SR-14": "full" }, () => {
  const rows = [{ title: "z", ref: "/b", source: "file", rank: 3 }, { title: "A", ref: "/a", source: "note", rank: 1 }, { title: "a", ref: "/c", source: "file", rank: 1 }];
  assert.deepEqual(orderSearchHits(rows, "title").map(r => r.ref), ["/c", "/a", "/b"]); assert.deepEqual(orderSearchHits(rows, "reference").map(r => r.ref), ["/a", "/b", "/c"]); assert.equal(orderSearchHits(rows, "relevance")[0].ref, "/b"); assert.equal(rows[0].ref, "/b");
});
await test("Private/RAM literal search preserves whitespace and punctuation; extension filters apply before limit", { "SR-15": "partial", "SR-16": "partial" }, () => {
  const docs = [{ path: "/Private/a.MD", name: "a.MD", body: "one two %_needle", lower: "a.md\none two %_needle" }, { path: "/Private/b.txt", name: "b.txt", body: "one gap two", lower: "b.txt\none gap two" }];
  assert.equal(searchDocs(docs, "one two", "", 40, "private-local", { match: "literal" }).length, 1);
  assert.equal(searchDocs(docs, "%_needle", "", 40, "private-local", { match: "literal" })[0].ref, "/Private/a.MD");
  assert.equal(searchDocs(docs, "one", "", 1, "amnesic-ram", { extension: ".txt" })[0].ref, "/Private/b.txt"); assert.ok(hasSearchExtension("/a.TAR.GZ", ".tar.gz"));
});
await test("Missing-path validator does not normalize traversal, trailing separators or private-name aliases", { "SR-18": "partial" }, () => {
  assert.equal(diagnosticFilePath("/Documents/a b.md"), "/Documents/a b.md"); assert.equal(diagnosticFilePath("/"), "/");
  for (const value of ["", "relative", "/a/../b", "/a//b", "/a/", "/a\nb", "/" + "a".repeat(4096)]) assert.throws(() => diagnosticFilePath(value));
});
await test("Saved searches retain phrase, field, source, strategy, suffix, order and client filter controls; old v1 defaults migrate", { "SV-02": "full" }, () => {
  const full = { ...EMPTY_SEARCH, q: "one two", scope: "/Documents", phrase: true, source: "file" as const, extension: ".md", sort: "reference" as const, filter: "one.*", regex: true, caseSensitive: true, field: "lyrics" };
  const saved = validateSavedSearches([{ ...full, id: "s1", name: "All controls", savedAt: 1 }])[0]; assert.deepEqual(searchInput(saved), full);
  const legacy = validateSavedSearches([{ id: "old", name: "Old", q: "alpha", scope: "", mode: "metadata", savedAt: 0 }])[0]; assert.equal(legacy.field, ""); assert.equal(legacy.phrase, false);
});
await test("Portable profiles round-trip canonically; malformed, future, oversized and duplicate records are refused atomically", { "SV-03": "partial" }, () => {
  const list = validateSavedSearches([{ ...EMPTY_SEARCH, id: "id1", name: "Local", q: "μ → 🧭", savedAt: 4 }]);
  assert.deepEqual(importSavedSearches(exportSavedSearches(list)), list);
  for (const text of ["{", "null", JSON.stringify({ kind: "fusion.saved-searches.v99", searches: [] }), JSON.stringify({ kind: "fusion.saved-searches.v2", searches: [{ ...list[0], mode: "remote" }] }), " ".repeat(512 * 1024 + 1)]) assert.throws(() => importSavedSearches(text));
  assert.throws(() => validateSavedSearches([list[0], { ...list[0], name: "Other" }]), /ids must be unique/);
  assert.throws(() => validateSavedSearches([list[0], { ...list[0], id: "other", name: "Ｌｏｃａｌ" }]), /names must be unique/); assert.equal(list.length, 1);
});
await test("History distinguishes complete inputs, validates neighbours independently, and caps deterministic recency", { "SV-02": "partial", "SR-19": "partial" }, () => {
  let records = pushRecent([], { ...EMPTY_SEARCH, q: "same", at: 1 }); records = pushRecent(records, { ...EMPTY_SEARCH, q: "same", match: "literal", at: 2 }); assert.equal(records.length, 2);
  records = pushRecent(records, { ...EMPTY_SEARCH, q: "same", at: 3 }); assert.equal(records.length, 2); assert.equal(records[0].match, "ranked");
  assert.equal(validateRecents([null, { mode: "evil" }, records[0]]).length, 1);
});
await test("Index prefix agrees with code-point slicing and cannot emit a split surrogate at the 50,000 boundary", { "SR-17": "partial", "NT-10": "partial" }, () => {
  const values = ["x".repeat(50_001), "🧭".repeat(50_001), "x".repeat(49_999) + "🧭tail", "μ → abc".repeat(12_000)];
  for (const text of values) assert.equal(searchIndexText(text), Array.from(text).slice(0, 50_000).join(""));
  assert.equal(searchIndexText("🧭a", 1), "🧭"); assert.equal(searchIndexText("abc", 0), "");
});
await test("RAM recovery capacity is a real 64-entry bound: refusal cannot evict any live draft and removal releases exactly one slot", { "NT-09": "partial" }, () => {
  clearRamNoteDrafts(); const keys: string[] = [];
  try {
    for (let i = 0; i < NOTE_RAM_DRAFT_LIMITS.entries; i++) {
      const key = noteDraftKey(`native-capacity-${i}`, record.id); keys.push(key);
      writeNoteDraft(null, key, { v: 1, base: record, value: { ...record, body: `kept-${i}` }, savedAt: Date.now() });
    }
    const extra = noteDraftKey("native-capacity-extra", record.id);
    assert.throws(() => writeNoteDraft(null, extra, { v: 1, base: record, value: record, savedAt: Date.now() }), /quota/);
    keys.forEach((key, i) => assert.equal(readNoteDraft(null, key, record.id)?.value.body, `kept-${i}`));
    removeNoteDraft(null, keys[0]); writeNoteDraft(null, extra, { v: 1, base: record, value: record, savedAt: Date.now() });
    assert.equal(readNoteDraft(null, extra, record.id)?.value.body, record.body);
  } finally { clearRamNoteDrafts(); }
});
await test("RAM byte quota counts actual JSON-escaped UTF-16, not source characters: overflow retains all previously stored large drafts", { "NT-09": "partial" }, () => {
  clearRamNoteDrafts(); const large = { ...record, body: "\u0001".repeat(NOTE_LIMITS.body) };
  const draft = { v: 1 as const, base: large, value: large, savedAt: Date.now() }, bytes = JSON.stringify(draft).length * 2;
  const capacity = Math.floor(NOTE_RAM_DRAFT_LIMITS.bytes / bytes); assert.ok(capacity >= 1 && capacity < 5);
  try {
    for (let i = 0; i < capacity; i++) writeNoteDraft(null, `native-bytes-${i}`, draft);
    assert.throws(() => writeNoteDraft(null, "native-bytes-overflow", draft), /quota/);
    for (let i = 0; i < capacity; i++) assert.equal(readNoteDraft(null, `native-bytes-${i}`, record.id)?.value.body, large.body);
    assert.equal(readNoteDraft(null, "native-bytes-overflow", record.id), null);
    removeNoteDraft(null, "native-bytes-0"); writeNoteDraft(null, "native-bytes-overflow", draft);
    assert.equal(readNoteDraft(null, "native-bytes-overflow", record.id)?.value.body, large.body);
  } finally { clearRamNoteDrafts(); }
});
await test("Wiki-link graph refuses duplicate saved titles in both directions; backlinks reverse only actual unambiguous navigation edges", { "NT-14": "partial", "NT-02": "partial" }, () => {
  const notes = [{ id: 1, title: "Source", body: "[[Target]] [[Missing]] [[Unique]]" }, { id: 2, title: "Target", body: "" }, { id: 3, title: " target ", body: "" }, { id: 4, title: "Unique", body: "[[Source]]" }];
  assert.deepEqual(resolveLinks(notes, notes[0]).map(link => link.noteId), [null, null, 4]);
  assert.deepEqual(backlinks(notes, notes[1]), []); assert.deepEqual(backlinks(notes, notes[2]), []);
  assert.deepEqual(backlinks(notes, notes[3]), [{ id: 1, title: "Source" }]);
  for (const target of notes) {
    const forward = notes.filter(source => source.id !== target.id && resolveLinks(notes, source).some(link => link.noteId === target.id)).map(source => source.id).sort();
    assert.deepEqual(backlinks(notes, target).map(source => source.id).sort(), forward);
  }
});
await test("Backlinks use saved destination identity, not unsaved title impersonation", { "NT-14": "partial" }, () => {
  const target = { id: 1, title: "Saved target", body: "" }, source = { id: 2, title: "Source", body: "[[Saved target]]" }, shadow = { id: 3, title: "Other target", body: "" };
  const rows = [target, source, shadow];
  assert.deepEqual(backlinks(rows, { ...target, title: "Unsaved rename" }), [{ id: 2, title: "Source" }]);
  assert.deepEqual(backlinks(rows, { ...shadow, title: target.title }), []);
  assert.deepEqual(backlinks(rows, { id: -1, title: target.title, body: "" }), []);
});
await test("Generated note titles never split a valid surrogate pair at the import/duplicate cap", { "NT-13": "partial" }, () => {
  const heading = "a".repeat(499) + "🧭";
  const imported = importNoteMarkdown(Buffer.from(`# ${heading}\nBody μ`), "a.md");
  assert.equal(imported.title, "a".repeat(499)); assert.equal(imported.body, `# ${heading}\nBody μ`);
  const copied = noteCopyTitle("a".repeat(494) + "🧭" + "x".repeat(4));
  assert.equal(copied, "a".repeat(494) + " copy"); assert.equal(noteWrite({ title: copied }).title, copied);
  assert.equal(noteTitlePrefix("ordinary"), "ordinary"); assert.equal(noteCopyTitle("A 🧭 note"), "A 🧭 note copy");
});
finish();
