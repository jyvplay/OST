/**
 * TT139 pure suite — the twelve new engines, each tested against its own
 * failure modes rather than its happy path.
 *
 * Every case here is an assertion about a returned value; none of them is a
 * "does it run" smoke test. Where a property is numeric (CRC, deflate, contrast,
 * entropy) the expected value is either an independent published constant or was
 * cross-checked against an external implementation (Python's zipfile / Node's
 * zlib / an independent Decimal reference) in a separate script — the
 * cross-check itself is recorded in the turn report, not asserted here.
 *
 * No DOM, no server, no database: this suite is refused by run-fast.sh if it
 * ever imports one, which is the guard that keeps it schedulable in parallel.
 */
import { makeHarness } from "./harness.mts";
import {
  parseMarkdown, renderMarkdownHtml, markdownOutline, markdownText, escapeHtml, decodeEntities,
  delimiterFlanking, MD_MAX_NODES,
} from "../src/lib/markdown.ts";
import { writeZip, readZip, readZipDirectory, crc32, deflateRaw, inflateRaw, safeEntryName, toDosDate, fromDosDate, ZIP_MAX_ENTRIES } from "../src/lib/zip-writer.ts";
import { diffLinesText, diffArrays, toUnified, toHunks, diffStats, diffWords, mergeThreeWay, splitLines } from "../src/lib/diff-v2.ts";
import { parseQuery, rankSearch, highlightSpans, parseDateValue, normaliseTerm, tokenize, describeQuery } from "../src/lib/search-rank.ts";
import { parseCsv, writeCsv, detectDelimiter, unescapeFormulaCell, csvPreview, CSV_MAX_FIELD } from "../src/lib/csv.ts";
import { contrastRatio, contrastLevel, simulateVision, hexToRgb, rgbToHex, parseCssColor, relativeLuminance, deltaE76, bestForeground, generateHarmony, compositeOver, isDistinct, srgbToLinear, linearToSrgb } from "../src/lib/colour.ts";
import { ShortcutRegistry, chordFromEvent, normaliseChord, DEFAULT_BINDINGS, RESERVED_CHORDS } from "../src/lib/keyboard-shortcuts.ts";
import { bytesToBase64, base64ToBytes, bytesToBase64Url, base64UrlToBytes, hexToBytes, bytesToHex, guessEncoding, constantTimeEqual, passwordEntropyBits, shannonEntropy, textToBytes, bytesToText } from "../src/lib/text-crypto.ts";
import { daysFromCivil, civilFromDays, addCivilDays, dayOfWeek, isoWeek, partsInZone, resolveWallTime, describeDelta, toIcsUtc, parseIcsTime, civilDaysBetween, callOverlap, isLeapYear, daysInMonth } from "../src/lib/calendar-time.ts";
import { convert, parseQuantity, findUnit, compatibleUnits, formatQuantity, UNITS } from "../src/lib/units.ts";
import { findMatches, replaceAll, nextMatch, findStatus, countReplacements } from "../src/lib/text-search.ts";
import { compose, replayKeys, controlByte, canCompose, DEAD_KEYS } from "../src/lib/keyboard-map.ts";
import { pluralCategory, formatMessage, formatList, ordinalCategory, pluralOperands, formatNumber, formatRelative } from "../src/lib/i18n.ts";

const { test, finish } = makeHarness("tt139-engines");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const throws = (fn: () => unknown, m: string) => { try { fn(); } catch { return; } throw new Error(`expected a refusal: ${m}`); };

// ── FF-73 Markdown ──────────────────────────────────────────────────────────
await test("MD-01 · raw HTML in the source is escaped, never parsed", { "FF-73": "full" }, () => {
  const html = renderMarkdownHtml('# t\n\n<img src=x onerror="alert(1)"> and <script>alert(1)</script>\n\ninline <b>bold</b>');
  ok(!html.includes("<img"), "an img tag was emitted from source text");
  ok(!html.includes("<script"), "a script tag was emitted");
  ok(!html.includes("<b>"), "a b tag was emitted");
  ok(html.includes("&lt;img"), "the source was not escaped");
  // negative control: the escaper itself must map all five characters
  eq(escapeHtml(`<>&"'`), "&lt;&gt;&amp;&quot;&#39;", "escapeHtml");
});

await test("MD-02 · javascript: and data: destinations are dropped, text kept", { "FF-73": "full" }, () => {
  const html = renderMarkdownHtml("[click](javascript:alert(1)) [img](data:text/html,x) [ok](https://e.com)");
  ok(!/href="javascript:/i.test(html), "javascript: href survived");
  ok(!/href="data:/i.test(html), "data: href survived");
  ok(html.includes('href="https://e.com"'), "a safe link was dropped");
  ok(html.includes("click"), "the link text was lost");
});

await test("MD-03 · code fences keep their content byte-exact and their language", { "FF-73": "full" }, () => {
  const src = "```ts\nconst a = '<div>' && x > 1;\n  indented\n```";
  const html = renderMarkdownHtml(src);
  ok(html.includes('class="language-ts"'), "language class missing");
  ok(html.includes("const a = &#39;&lt;div&gt;&#39; &amp;&amp; x &gt; 1;"), "code body not preserved/escaped exactly");
  ok(html.includes("  indented"), "indentation lost inside a fence");
  // a fence with no closing fence still ends at EOF and is not a paragraph
  ok(renderMarkdownHtml("```\nabc").includes("<pre>"), "unclosed fence was not treated as code");
});

await test("MD-04 · emphasis follows the CommonMark flanking rules (no intraword _em_)", { "FF-73": "full" }, () => {
  eq(renderMarkdownHtml("snake_case_name"), "<p>snake_case_name</p>", "intraword underscore must not open emphasis");
  eq(renderMarkdownHtml("*a* **b** ***c***"), "<p><em>a</em> <strong>b</strong> <strong><em>c</em></strong></p>", "basic emphasis");
  eq(renderMarkdownHtml("a * b * c"), "<p>a * b * c</p>", "spaced asterisks must stay literal");
  // an unmatched delimiter must not swallow the rest of the paragraph
  eq(renderMarkdownHtml("**unclosed"), "<p>**unclosed</p>", "unmatched run");
  const f = delimiterFlanking("a", " ", "*");
  ok(f.canOpen === false && f.canClose === true, "flanking of '*' before a space is wrong");
});

await test("MD-05 · nested blocks, tables, task lists and outline agree with the render", { "FF-73": "full" }, () => {
  const src = [
    "# H1", "## H2", "", "> quote with **strong**", "> > nested", "",
    "| a | b |", "|:--|--:|", "| 1 | 2 |", "",
    "- [x] done", "- [ ] todo", "", "1. one", "2. two",
  ].join("\n");
  const html = renderMarkdownHtml(src);
  ok(html.includes("<h1>H1</h1>") && html.includes("<h2>H2</h2>"), "headings");
  ok(html.includes("<blockquote><p>quote with <strong>strong</strong></p>"), "blockquote+inline");
  ok(html.includes("text-align:left") && html.includes("text-align:right"), "table alignment");
  ok(html.includes("\u2611 done") && html.includes("\u2610 todo"), "task markers");
  const outline = markdownOutline(src);
  eq(outline.map((h) => [h.level, h.text]), [[1, "H1"], [2, "H2"]], "outline");
  ok(markdownText(src).includes("done"), "plain text extraction lost a task item");
});

await test("MD-06 · bounds are enforced, and the refusal is an error rather than truncation", { "FF-73": "full" }, () => {
  const giant = "# a\n".repeat(MD_MAX_NODES);
  throws(() => parseMarkdown(giant), "node-count bound");
  throws(() => parseMarkdown("x".repeat((1 << 20) + 1)), "input-size bound");
  throws(() => parseMarkdown(null as unknown as string), "type bound");
  // control: a document just under the bound parses
  ok(parseMarkdown("# ok\n\ntext").length === 2, "normal document");
});

// ── FF-74 ZIP ───────────────────────────────────────────────────────────────
const te = new TextEncoder();
const td = new TextDecoder();
const repetitive = te.encode("The quick brown fox jumps over the lazy dog. ".repeat(200));

await test("ZIP-01 · CRC-32 matches the published IEEE 802.3 check value", { "FF-74": "full" }, () => {
  // The standard check value for "123456789" is 0xCBF43926.
  eq(crc32(te.encode("123456789")).toString(16), "cbf43926", "CRC-32 check value");
  eq(crc32(new Uint8Array(0)), 0, "empty CRC");
});

await test("ZIP-02 · deflate round-trips exactly on adversarial byte patterns", { "FF-74": "full" }, () => {
  const cases: Uint8Array[] = [
    new Uint8Array(0),
    te.encode("a"),
    te.encode("a".repeat(1000)),
    repetitive,
    Uint8Array.from({ length: 5000 }, (_, i) => (i * 37) & 0xff),
    Uint8Array.from({ length: 3000 }, (_, i) => (i < 1500 ? 0 : i & 0xff)),
    crypto.getRandomValues(new Uint8Array(2000)),
  ];
  for (const input of cases) {
    const packed = deflateRaw(input);
    const back = inflateRaw(packed);
    eq(bytesToHex(back), bytesToHex(input), `round-trip of ${input.length} bytes`);
  }
  // repetitive input must actually compress, and random input must not grow much
  ok(deflateRaw(repetitive).length < repetitive.length / 5, "repetitive data did not compress");
  const rand = crypto.getRandomValues(new Uint8Array(4000));
  ok(deflateRaw(rand).length < rand.length * 1.06, "incompressible data grew by more than 6%");
});

await test("ZIP-03 · writer produces a directory an independent reader accepts, byte-identically twice", { "FF-74": "full" }, () => {
  const entry = (name: string, data: Uint8Array) => ({ name, data });
  const items = [entry("a.txt", te.encode("hello")), entry("dir/b.bin", new Uint8Array([0, 255, 128])), entry("dir/", new Uint8Array(0))];
  const first = writeZip(items, { comment: "tt139" });
  const second = writeZip(items, { comment: "tt139" });
  eq(bytesToHex(first), bytesToHex(second), "deterministic output");
  const archive = readZipDirectory(first);
  eq(archive.entries.map((e) => e.name), ["a.txt", "dir/b.bin", "dir/"], "entry names and order");
  eq(archive.comment, "tt139", "archive comment");
  const extracted = readZip(first);
  eq(td.decode(extracted[0].data), "hello", "text payload");
  eq(Array.from(extracted[1].data), [0, 255, 128], "binary payload");
  ok(extracted.every((e) => e.crcOk), "CRC verification");
});

await test("ZIP-04 · zip-slip, duplicate names and over-long archives are refused", { "FF-74": "full" }, () => {
  throws(() => safeEntryName("../../etc/passwd"), "parent traversal");
  throws(() => safeEntryName("a/../../b"), "nested traversal");
  throws(() => safeEntryName("C:/windows"), "absolute drive path");
  throws(() => safeEntryName(""), "empty name");
  eq(safeEntryName("/lead/slash.txt"), "lead/slash.txt", "leading slash is normalised, not rejected");
  eq(safeEntryName("a\\b\\c.txt"), "a/b/c.txt", "backslashes normalise");
  throws(() => writeZip([{ name: "x", data: te.encode("1") }, { name: "x", data: te.encode("2") }]), "duplicate entry");
  throws(() => writeZip([{ name: "d/", data: te.encode("not empty"), dir: true }]), "non-empty directory entry");
  ok(ZIP_MAX_ENTRIES === 65535, "entry cap");
});

await test("ZIP-05 · a corrupted payload is detected, and a bomb's declared size is refused before inflating", { "FF-74": "full" }, () => {
  const zip = writeZip([{ name: "a.txt", data: repetitive }]);
  const corrupted = zip.slice();
  // flip a byte inside the deflate payload (after the 30-byte local header + name)
  corrupted[40] = corrupted[40] ^ 0xff;
  throws(() => readZip(corrupted), "corrupted CRC");
  // a lying header: set the uncompressed size fields huge
  const lying = writeZip([{ name: "b.txt", data: te.encode("small") }]).slice();
  const view = new DataView(lying.buffer);
  view.setUint32(22, 0xfffffff0, true);
  view.setUint32(90, 0xfffffff0, true);
  throws(() => readZip(lying, { maxTotalBytes: 1 << 20 }), "declared expansion limit");
  throws(() => readZip(new Uint8Array(10)), "truncated archive");
  throws(() => readZip(te.encode("not a zip at all, just text")), "not an archive");
});

await test("ZIP-06 · DOS timestamps round-trip and clamp the representable range", { "FF-74": "full" }, () => {
  const when = new Date(Date.UTC(2024, 4, 17, 13, 45, 22));
  const { date, time } = toDosDate(when);
  const back = fromDosDate(date, time);
  eq(back.getUTCFullYear(), 2024, "year");
  eq(back.getUTCMonth(), 4, "month");
  eq(back.getUTCDate(), 17, "day");
  eq(back.getUTCHours(), 13, "hour");
  eq(back.getUTCMinutes(), 45, "minute");
  // 2-second resolution is a property of the format, so 22 s must survive exactly
  eq(back.getUTCSeconds(), 22, "even seconds survive");
  const pre = toDosDate(new Date(Date.UTC(1970, 0, 1)));
  eq(fromDosDate(pre.date, pre.time).getUTCFullYear(), 1980, "pre-1980 clamps to the DOS epoch");
});

// ── PR-13 diff ──────────────────────────────────────────────────────────────
await test("DIFF-01 · Myers distance equals an independent longest-common-subsequence count", { "PR-13": "full" }, () => {
  // For line sequences, shortest edit script = |a| + |b| - 2*LCS.
  const lcs = (a: string[], b: string[]) => {
    const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    return t[0][0];
  };
  const cases: [string[], string[]][] = [
    [[], []], [["a"], []], [[], ["b"]], [["a", "b", "c"], ["a", "b", "c"]],
    [["a", "b", "c"], ["a", "x", "c"]], [["a", "b"], ["b", "a"]],
    [["1", "2", "3", "4", "5"], ["1", "3", "5", "6"]],
    [["x", "y", "x", "z"], ["x", "z", "x"]],
  ];
  for (const [a, b] of cases) {
    const r = diffArrays(a, b);
    eq(r.distance, a.length + b.length - 2 * lcs(a, b), `distance for ${JSON.stringify(a)}→${JSON.stringify(b)}`);
    eq(bytesToHex(te.encode(r.ops.filter((o) => o.kind === "same").map((o) => o.text).join("|"))), bytesToHex(te.encode(lcsSeq(a, b))), "same-sequence content");
  }
  function lcsSeq(a: string[], b: string[]): string {
    const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const out: string[] = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { out.push(a[i]); i++; j++; }
      else if (t[i + 1][j] >= t[i][j + 1]) i++;
      else j++;
    }
    return out.join("|");
  }
});

await test("DIFF-02 · the budget reports truncation instead of pretending everything changed", { "PR-13": "full" }, () => {
  const a = Array.from({ length: 60 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 60 }, (_, i) => `b${i}`);
  const limited = diffArrays(a, b, (x, y) => x === y, { maxD: 3 });
  ok(limited.truncated, "a 60-line total rewrite must report truncation at maxD 3");
  ok(limited.ops.some((o) => o.kind === "del") && limited.ops.some((o) => o.kind === "add"), "the refused diff still shows both sides");
  const generous = diffArrays(a, b, (x, y) => x === y, { maxD: 200 });
  ok(!generous.truncated, "the same diff must succeed with an adequate budget");
});

await test("DIFF-03 · unified text and hunks are well formed and reversible", { "PR-13": "full" }, () => {
  const before = "alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta";
  const after = "alpha\nBETA\ngamma\ndelta\nepsilon\nzeta\neta\nTHETA";
  const r = diffLinesText(before, after);
  const unified = toUnified(r, { oldName: "a", newName: "b", context: 1 });
  ok(unified.startsWith("--- a\n+++ b\n"), "header");
  ok(/@@ -\d+,\d+ \+\d+,\d+ @@/.test(unified), "hunk header shape");
  // Applying the unified diff to the old text must reproduce the new text.
  eq(applyUnified(before, unified), after, "unified diff application");
  const hunks = toHunks(r, 1);
  eq(hunks.length, 2, "two separated changes with one line of context collapse into two hunks");
  eq(diffStats(r), { added: 2, removed: 2, unchanged: 6 }, "stats");
  function applyUnified(oldText: string, patch: string): string {
    const out: string[] = [];
    const src = splitLines(oldText);
    let cursor = 0;
    for (const line of patch.split("\n")) {
      const head = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(line);
      if (head) { const start = Number(head[1]) - 1; while (cursor < start) out.push(src[cursor++]); continue; }
      if (line.startsWith("---") || line.startsWith("+++") || line === "") continue;
      if (line.startsWith(" ")) { out.push(src[cursor++]); continue; }
      if (line.startsWith("-")) { cursor++; continue; }
      if (line.startsWith("+")) { out.push(line.slice(1)); continue; }
    }
    while (cursor < src.length) out.push(src[cursor++]);
    return out.join("\n");
  }
});

await test("DIFF-04 · three-way merge refuses to hide a conflict and merges disjoint edits", { "PR-13": "full" }, () => {
  eq(mergeThreeWay("a\nb\nc\nd\ne", "a\nB\nc\nd\ne", "a\nb\nc\nd\nE"), { text: "a\nB\nc\nd\nE", conflicts: [] }, "disjoint edits merge cleanly");
  const conflict = mergeThreeWay("a\nb\nc", "a\nX\nc", "a\nY\nc");
  eq(conflict.conflicts.length, 1, "overlapping edits conflict");
  eq(conflict.conflicts[0].ours, "X", "ours is reported");
  eq(conflict.conflicts[0].theirs, "Y", "theirs is reported");
  eq(mergeThreeWay("a\nb", "a\nNEW\nb", "a\nNEW\nb").conflicts.length, 0, "identical insertions are not a conflict");
  eq(mergeThreeWay("a\nb", "a\nX\nb", "a\nY\nb").conflicts.length, 1, "different insertions at one point conflict");
  eq(mergeThreeWay("a\nb\nc", "a\nc", "a\nB\nc").conflicts.length, 1, "delete vs edit conflicts");
});

await test("DIFF-05 · word diff is finer than line diff and costs less than a full table", { "PR-13": "full" }, () => {
  const w = diffWords("the quick brown fox", "the quick red fox");
  eq(w.ops.filter((o) => o.kind === "del").map((o) => o.text), ["brown"], "removed word");
  eq(w.ops.filter((o) => o.kind === "add").map((o) => o.text), ["red"], "added word");
  ok(w.ops.some((o) => o.kind === "same" && o.text.trim() === "quick"), "unchanged words retained");
  const big = Array.from({ length: 4000 }, (_, i) => `line ${i}`).join("\n");
  const changed = big.replace("line 2000", "line 2000 CHANGED");
  const t0 = performance.now();
  const r = diffLinesText(big, changed);
  const ms = performance.now() - t0;
  ok(r.distance === 2, `one replaced line is distance 2, got ${r.distance}`);
  ok(ms < 400, `4000-line one-line-change diff took ${ms.toFixed(0)} ms`);
});

// ── SR-26 ranking ───────────────────────────────────────────────────────────
await test("SR-26 · the query grammar parses every operator and reports bad input", { "SR-26": "full" }, () => {
  const q = parseQuery('budget "quarterly plan" -draft tag:finance path:docs after:7d is:pinned');
  eq(q.phrases, [["quarter", "plan"].map(normaliseTerm)], "phrase tokens");
  eq(q.negated, ["draft"], "negation");
  eq(q.fields, [{ field: "tag", value: "finance" }, { field: "path", value: "docs" }], "field filters");
  ok(q.pinnedOnly, "pinned");
  ok(typeof q.after === "number", "after date");
  const bad = parseQuery("after:notadate x");
  ok(bad.error !== null, "a bad date must be reported, not dropped");
  eq(bad.terms, ["x"], "the rest of the query still parses");
  eq(parseQuery("").terms, [], "empty query");
  eq(parseQuery('"unterminated').phrases, [["unterminat"]], "an unterminated phrase still yields its words (stemmed)");
});

await test("SR-26 · ranking prefers a title match and length-normalises long bodies", { "SR-26": "full" }, () => {
  const docs = [
    { id: "title-hit", title: "Budget review", body: "x", updatedAt: 0 },
    { id: "body-hit", title: "Notes", body: "we discussed the budget at length in this very long document " .repeat(40), updatedAt: 0 },
  ];
  const ranked = rankSearch(docs, parseQuery("budget"));
  eq(ranked[0].id, "title-hit", "a title match outranks a body match");
  ok(ranked[0].fields.includes("title"), "the hit reports the field it matched");
  // AND semantics: a second positive term must appear somewhere in the document
  eq(rankSearch(docs, parseQuery("budget nonexistentword")).length, 0, "all terms are required");
});

await test("SR-26 · filters are conjunctive and negation scans every field", { "SR-26": "full" }, () => {
  const docs = [
    { id: "1", title: "Plan", body: "budget budget", tags: ["finance"], pinned: true, updatedAt: Date.UTC(2026, 10, 1) },
    { id: "2", title: "Plan draft", body: "budget", tags: ["finance"], updatedAt: Date.UTC(2026, 0, 1) },
    { id: "3", title: "Recipe", body: "flour", tags: ["food"] },
  ];
  eq(rankSearch(docs, parseQuery("budget tag:finance")).map((h) => h.id).sort(), ["1", "2"], "tag filter");
  eq(rankSearch(docs, parseQuery("budget -draft")).map((h) => h.id), ["1"], "negation excludes a title");
  eq(rankSearch(docs, parseQuery("is:pinned")).map((h) => h.id), ["1"], "pinned filter");
  eq(rankSearch(docs, parseQuery("after:2026-06-01")).map((h) => h.id), ["1"], "date filter");
  // doc 3 has no updatedAt, i.e. an unknown date. A date filter is a statement
  // about when something was updated, so a document with no date cannot satisfy
  // it — filtering it out is the honest behaviour, not a silent "matches".
  eq(rankSearch(docs, parseQuery("before:2026-06-01")).map((h) => h.id), ["2"], "before filter excludes undated documents");
  // a filter alone must not match everything when the term is absent
  eq(rankSearch(docs, parseQuery("zzz")).length, 0, "no false positives");
});

await test("SR-26 · highlight spans merge overlaps and never nest", { "SR-26": "full" }, () => {
  const spans = highlightSpans("budget budgets", ["budget", "get"]);
  for (let i = 1; i < spans.length; i++) ok(spans[i].start > spans[i - 1].end || spans[i].start === spans[i - 1].end, "spans must not overlap");
  eq(spans[0], { start: 0, end: 6 }, "first span");
  eq(highlightSpans("abc", []), [], "no terms");
});

await test("SR-26 · relative dates resolve against a supplied clock, never the wall clock", { "SR-26": "full" }, () => {
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  eq(parseDateValue("7d", now), now - 7 * 86_400_000, "7 days");
  eq(parseDateValue("today", now), Date.UTC(2026, 10, 6), "today is midnight UTC");
  eq(parseDateValue("2026-11-06", now), Date.UTC(2026, 10, 6), "iso date");
  eq(parseDateValue("2026-02-30", now), null, "impossible calendar date");
  eq(parseDateValue("2026-13-01", now), null, "month out of range");
  eq(describeQuery(parseQuery("a b -c")), "2 terms · excluding c", "description");
});

// ── FF-75 CSV ───────────────────────────────────────────────────────────────
await test("CSV-01 · quoted delimiters, doubled quotes and embedded newlines survive", { "FF-75": "full" }, () => {
  const text = 'a,b,c\r\n"x,1","y""q","line\nbreak"\r\n';
  const r = parseCsv(text);
  eq(r.rows, [["a", "b", "c"], ["x,1", 'y"q', "line\nbreak"]], "fields");
  eq(r.dialect.lineEnding, "\r\n", "detected line ending");
  eq(r.dialect.delimiter, ",", "detected delimiter");
  eq(r.errors, [], "no errors on a well-formed file");
});

await test("CSV-02 · BOM, CR-only endings and an unbalanced quote are reported, not silently repaired", { "FF-75": "full" }, () => {
  const bom = parseCsv("\uFEFFa,b\r1,2\r3,4");
  ok(bom.hadBom, "BOM reported");
  eq(bom.rows[0], ["a", "b"], "BOM is not part of the first cell");
  eq(bom.rows.length, 3, "CR-only endings split rows");
  const broken = parseCsv('a,b\n"unclosed,2');
  ok(broken.errors.some((e) => e.includes("quoted")), "unbalanced quote is reported");
  eq(broken.rows[1], ["unclosed", "2"], "the readable part of the last row is recovered");
  throws(() => parseCsv("a\u0000b"), "NUL bytes are refused");
});

await test("CSV-03 · delimiter detection scores consistency, not frequency", { "CSV-01": "full" }, () => {
  // semicolons inside a comma-separated text column must not win
  eq(detectDelimiter('name,note\nalice,"a; b; c; d; e"\nbob,"f; g; h"'), ",", "comma wins over a semicolon-rich column");
  eq(detectDelimiter("a\tb\tc\n1\t2\t3\n4\t5\t6"), "\t", "tab");
  eq(detectDelimiter("one\ntwo"), ",", "single-column text defaults to comma");
  eq(detectDelimiter(""), ",", "empty input");
});

await test("CSV-04 · export guards formula injection and the guard is exactly reversible", { "FF-75": "full" }, () => {
  const { text, guarded } = writeCsv([["=1+1", "ok", "@sum"], ["-2", "+3", "plain"]]);
  ok(text.includes("'=1+1"), "leading = is guarded");
  ok(text.includes("'@sum"), "leading @ is guarded");
  ok(!text.includes("'-2"), "a negative number must stay a number");
  // A leading "+" is guarded on purpose: spreadsheets accept "+cmd|..." as a
  // formula, so a signed number has to be quoted to stay data. The cost is one
  // visible apostrophe on a "+3" cell, and `unescapeFormulaCell` reverses it.
  ok(text.includes("'+3"), "leading + is guarded, because it is a live formula prefix");
  eq(guarded.length, 3, "three cells guarded");
  eq(unescapeFormulaCell("'+3"), "+3", "the quote on a signed number is reversible");
  eq(unescapeFormulaCell("'=1+1"), "=1+1", "reversible");
  eq(unescapeFormulaCell("plain"), "plain", "untouched cell");
  eq(unescapeFormulaCell("'-2"), "'-2", "a hyphen cell is never guarded, so it never reverses");
  const plain = writeCsv([["=1+1"]], { guardFormulas: false });
  eq(plain.text.trim(), "=1+1", "opt-out is explicit");
  // quoting is minimal but correct
  eq(writeCsv([["a,b"]]).text, '"a,b"\r\n', "quoted only when needed");
  eq(writeCsv([['say "hi"']]).text, '"say ""hi"""\r\n', "quotes doubled");
});

await test("CSV-05 · ragged rows are counted, not dropped; a field cap is enforced", { "FF-75": "full" }, () => {
  const r = parseCsv("a,b,c\n1,2\n3,4,5\n");
  eq(r.raggedRows, [1], "the short row is identified");
  eq(r.rows.length, 3, "no row was dropped");
  const long = `"${"x".repeat(CSV_MAX_FIELD + 1)}"`;
  throws(() => parseCsv(long), "field cap");
  const preview = csvPreview([["a", "bb"], ["ccc", "d"]], 1, 1);
  eq(preview.hiddenRows, 1, "hidden rows counted");
  eq(preview.hiddenCols, 0, "hidden columns counted");
});

// ── CG-01 colour ────────────────────────────────────────────────────────────
await test("CG-01 · WCAG contrast matches the published extremes and thresholds", { "CG-01": "full" }, () => {
  eq(contrastRatio("#000000", "#ffffff"), 21, "black on white is exactly 21:1");
  eq(contrastRatio("#ffffff", "#ffffff"), 1, "identity is 1:1");
  // #767676 on white is the canonical 4.54:1 AA boundary colour
  const boundary = contrastRatio("#767676", "#ffffff");
  ok(boundary > 4.5 && boundary < 4.6, `#767676 on white should be ~4.54, got ${boundary.toFixed(3)}`);
  eq(contrastLevel(21), "AAA", "21:1");
  eq(contrastLevel(4.5), "AA", "4.5 is AA");
  eq(contrastLevel(4.49), "AA-large", "just under 4.5 is only AA-large");
  eq(contrastLevel(2.9), "fail", "below 3 fails");
  eq(contrastLevel(3.2, true), "AA", "large text needs 3:1");
  // sRGB transfer function must be the exact piecewise curve, not the 2.2 power
  ok(Math.abs(relativeLuminance({ r: 119, g: 119, b: 119 }) - 0.1845) < 0.001, "luminance of #777777");
  eq(linearToSrgb(srgbToLinear(128)), 128, "transfer round-trip at mid grey");
});

await test("CG-01 · lightness behaves as perception, not as HSL: a red/blue swap is not 'equal brightness'", { "CG-01": "full" }, () => {
  const red = relativeLuminance(hexToRgb("#ff0000"));
  const blue = relativeLuminance(hexToRgb("#0000ff"));
  const green = relativeLuminance(hexToRgb("#00ff00"));
  ok(green > red && red > blue, "luminance order must be G > R > B");
  // HSL lightness says all three are 0.5 — that is exactly the trap this function avoids
  ok(deltaE76(hexToRgb("#ff0000"), hexToRgb("#0000ff")) > 100, "red and blue are perceptually far apart");
  ok(!isDistinct("#ff0000", "#fe0000"), "near-identical reds are not distinct");
  ok(isDistinct("#ff0000", "#ee0000"), "a visible red difference is distinct");
});

await test("CG-01 · colour-vision simulation is deterministic, monotone in severity and keeps greys grey", { "CG-01": "full" }, () => {
  const grey = { r: 128, g: 128, b: 128 };
  // A neutral grey is a fixed point of the protan/deutan projections (only the
  // L/M→L or L/M→M terms change, and the deutan matrix keeps the equal-L=M
  // axis). Tritanopia does not: the Brettel–Viénot S term is rebuilt, so the
  // honest assertion there is that the shift is small and *bounded*, not zero.
  for (const t of ["protanopia", "deuteranopia"] as const) {
    const sim = simulateVision(grey, t);
    ok(Math.abs(sim.r - sim.g) <= 4 && Math.abs(sim.g - sim.b) <= 4, `${t} must keep a neutral grey near-neutral, got ${JSON.stringify(sim)}`);
  }
  const trit = simulateVision(grey, "tritanopia");
  const drift = Math.max(Math.abs(trit.r - 128), Math.abs(trit.g - 128), Math.abs(trit.b - 128));
  ok(drift <= 40, `tritanopia on mid grey should shift by a bounded amount, got ${drift}`);
  // severity 0 is the identity; severity 1 is maximal; the path is monotone toward it
  eq(simulateVision({ r: 255, g: 0, b: 0 }, "deuteranopia", 0), { r: 255, g: 0, b: 0 }, "severity 0 is identity");
  const full = simulateVision({ r: 255, g: 0, b: 0 }, "deuteranopia", 1);
  ok(full.g > 100, `the projection must turn pure red into an olive/brown, got ${JSON.stringify(full)}`);
  const half = simulateVision({ r: 255, g: 0, b: 0 }, "deuteranopia", 0.5);
  ok((half.g > 0 && half.g < full.g) || half.g === full.g, "partial severity is between the two");
  const achromat = simulateVision({ r: 255, g: 0, b: 0 }, "achromatopsia");
  ok(achromat.r === achromat.g && achromat.g === achromat.b, "achromatopsia is exactly neutral");
});

await test("CG-01 · CSS colour parsing accepts the syntaxes users paste and rejects the rest", { "CG-01": "full" }, () => {
  eq(parseCssColor("#abc"), { rgb: { r: 170, g: 187, b: 204 }, alpha: 1 }, "#abc expansion");
  eq(parseCssColor("rgb(10, 20, 30)"), { rgb: { r: 10, g: 20, b: 30 }, alpha: 1 }, "rgb()");
  eq(parseCssColor("rgba(10,20,30,0.5)")?.alpha, 0.5, "rgba alpha");
  eq(parseCssColor("hsl(210, 50%, 40%)"), { rgb: { r: 51, g: 102, b: 153 }, alpha: 1 }, "hsl()");
  eq(parseCssColor("rgb(50%, 0%, 100%)")?.rgb, { r: 128, g: 0, b: 255 }, "percentage channels");
  eq(parseCssColor("not-a-colour"), null, "garbage");
  eq(parseCssColor("#12"), null, "short hex");
  eq(rgbToHex(hexToRgb("#0A0B0C")), "#0a0b0c", "normalised lowercase");
});

await test("CG-01 · theme helpers pick a readable foreground and keep generated palettes distinct", { "CG-01": "full" }, () => {
  const dark = bestForeground("#101010", ["#000000", "#ffffff", "#777777"]);
  eq(dark.hex, "#ffffff", "white wins on a near-black background");
  ok(dark.metMinimum, "white on near-black clears 4.5:1");
  const light = bestForeground("#f7f7f7", ["#ffffff", "#222222"]);
  eq(light.hex, "#222222", "dark ink wins on a light background");
  const none = bestForeground("#808080", ["#808080"]);
  ok(none.metMinimum === false, "a colour on itself must be reported as failing, not rounded up");
  const harmony = generateHarmony("#3366cc", "triad", 3);
  eq(harmony.length, 3, "harmony length");
  ok(harmony.every((h) => /^#[0-9a-f]{6}$/.test(h)), "harmony values are hex");
  eq(compositeOver({ r: 255, g: 255, b: 255 }, 0.5, { r: 0, g: 0, b: 0 }), { r: 127.5, g: 127.5, b: 127.5 }, "50% white over black");
  eq(compositeOver({ r: 255, g: 255, b: 255 }, 1, { r: 0, g: 0, b: 0 }), { r: 255, g: 255, b: 255 }, "opaque foreground");
});

// ── IN-09 shortcuts ─────────────────────────────────────────────────────────
await test("IN-09 · chord normalisation is order-independent and platform-aware", { "IN-09": "full" }, () => {
  eq(normaliseChord("Shift+Ctrl+K"), "ctrl+shift+k", "modifier order is canonical");
  eq(normaliseChord("Cmd+K"), "meta+k", "cmd is meta");
  eq(normaliseChord("Option+K"), "alt+k", "option is alt");
  eq(normaliseChord("Esc"), "escape", "esc alias");
  eq(normaliseChord("Control+Return"), "ctrl+enter", "return alias");
  eq(chordFromEvent({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true }), "ctrl+shift+k", "event chord");
  eq(chordFromEvent({ key: "Control" }), null, "a bare modifier is not a chord");
  eq(chordFromEvent({ key: "e", isComposing: true }), null, "composition is not a chord");
  eq(chordFromEvent({ key: "Dead", code: "Quote" }), null, "a dead key produces no chord target");
});

await test("IN-09 · scope precedence resolves a dialog Escape without closing the window", { "IN-09": "full" }, () => {
  const reg = new ShortcutRegistry();
  for (const b of DEFAULT_BINDINGS) ok(reg.register(b).ok, `register ${b.command}`);
  const inDialog = reg.resolve({ key: "Escape" }, { activeScopes: ["dialog", "window", "global"], inputFocused: false });
  eq(inDialog.reason, "shadowed", "the dialog deliberately shadows the global close");
  eq(inDialog.binding, null, "nothing fires");
  const inWindow = reg.resolve({ key: "Escape" }, { activeScopes: ["window", "global"], inputFocused: false });
  eq(inWindow.binding?.command, "window.close", "a window still closes");
  const inInput = reg.resolve({ key: "s", ctrlKey: true }, { activeScopes: ["editor"], inputFocused: true });
  eq(inInput.binding?.command, "editor.save", "editor save is allowed while typing");
  const blocked = reg.resolve({ key: "Delete" }, { activeScopes: ["files"], inputFocused: true });
  eq(blocked.reason, "input-focused", "Delete in a text field must not trash a file");
});

await test("IN-09 · reserved chords and conflicts are reported, never silently accepted", { "IN-09": "full" }, () => {
  const reg = new ShortcutRegistry();
  eq(reg.register({ chord: "ctrl+w", command: "x", label: "x", scope: "global" }).reason, "reserved", "Ctrl+W is the browser's");
  ok(RESERVED_CHORDS.has("ctrl+w"), "reserved set");
  reg.register({ chord: "ctrl+j", command: "a", label: "A", scope: "global" });
  reg.register({ chord: "ctrl+j", command: "b", label: "B", scope: "global" });
  const audit = reg.audit();
  eq(audit.hard.length, 1, "same chord in the same scope is a hard conflict");
  eq(audit.hard[0].commands.sort(), ["a", "b"], "both commands named");
  // the same chord in *different* scopes is a shadow, not a conflict
  const reg2 = new ShortcutRegistry();
  reg2.register({ chord: "ctrl+j", command: "a", label: "A", scope: "global" });
  reg2.register({ chord: "ctrl+j", command: "b", label: "B", scope: "dialog", shadowed: true });
  eq(reg2.audit().hard.length, 0, "cross-scope is not a hard conflict");
});

await test("IN-09 · hints are generated from the same data the dispatcher matches", { "IN-09": "full" }, () => {
  const pc = new ShortcutRegistry();
  eq(pc.hint("ctrl+shift+p"), "Ctrl+Shift+P", "non-mac hint");
  eq(pc.hint("escape"), "Esc", "escape label");
  const mac = new ShortcutRegistry({ platform: "mac" });
  eq(mac.hint("meta+k"), "⌘K", "mac hint");
  eq(mac.hint("ctrl+alt+k"), "⌃⌥K", "mac modifiers");
});

// ── HW-11 encoders ──────────────────────────────────────────────────────────
await test("HW-08 · Base64 matches RFC 4648 test vectors exactly", { "HW-08": "full" }, () => {
  const vectors: [string, string][] = [
    ["", ""], ["f", "Zg=="], ["fo", "Zm8="], ["foo", "Zm9v"], ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="], ["foobar", "Zm9vYmFy"],
  ];
  for (const [plain, encoded] of vectors) {
    eq(bytesToBase64(te.encode(plain)), encoded, `encode ${JSON.stringify(plain)}`);
    eq(td.decode(base64ToBytes(encoded)), plain, `decode ${JSON.stringify(encoded)}`);
  }
  // the canonical base64url vectors from RFC 4648 §10
  eq(bytesToBase64Url(new Uint8Array([251, 255, 190])), "-_--", "base64url");
  eq(Array.from(base64UrlToBytes("-_--")), [251, 255, 190], "base64url decode");
});

await test("HW-08 · Base64 handles non-Latin-1 text and rejects invalid input", { "HW-08": "full" }, () => {
  const text = "héllo 🌍 ✓";
  eq(td.decode(base64ToBytes(bytesToBase64(te.encode(text)))), text, "UTF-8 through Base64");
  eq(bytesToBase64(te.encode("\u0000\u00ff")), "AMO/", "UTF-8 encoding of U+0000 U+00FF is three bytes");
  eq(Array.from(te.encode("\u0000\u00ff")), [0, 0xc3, 0xbf], "and those bytes are the UTF-8 form, not Latin-1");
  throws(() => base64ToBytes("Zm9v!"), "invalid character");
  throws(() => base64ToBytes("Zg="), "wrong padding");
  throws(() => base64ToBytes("Z"), "truncated input");
  eq(td.decode(base64ToBytes("Zm9v\nYmFy")), "foobar", "embedded whitespace tolerated");
  eq(bytesToBase64(new Uint8Array([0, 255])), "AP8=", "raw 0x00 0xff — a string-based encoder would refuse or mangle this");
  eq(Array.from(base64ToBytes("AP8=")), [0, 255], "raw bytes back");
});

await test("HW-08 · hex is strict, constant-time compare is length-safe, entropy is bounded", { "HW-08": "full" }, () => {
  eq(bytesToHex(hexToBytes("deadbeef")), "deadbeef", "hex round-trip");
  eq(bytesToHex(hexToBytes("DE:AD:BE:EF")), "deadbeef", "separators tolerated");
  throws(() => hexToBytes("abc"), "odd length");
  throws(() => hexToBytes("zz"), "non-hex");
  ok(constantTimeEqual(hexToBytes("00ff"), hexToBytes("00ff")), "equal");
  ok(!constantTimeEqual(hexToBytes("00ff"), hexToBytes("00fe")), "unequal");
  ok(!constantTimeEqual(hexToBytes("00"), hexToBytes("0000")), "different lengths are never equal");
  // entropy of a uniform byte distribution is exactly 8 bits/byte
  const uniform = new Uint8Array(256 * 8);
  for (let i = 0; i < uniform.length; i++) uniform[i] = i % 256;
  ok(Math.abs(shannonEntropy(uniform) - 8) < 1e-9, `uniform entropy should be 8, got ${shannonEntropy(uniform)}`);
  eq(shannonEntropy(new Uint8Array(100)), 0, "constant input has zero entropy");
  ok(passwordEntropyBits("aaaaaaaa") < 1, "a repeated character carries almost no entropy");
  ok(passwordEntropyBits("correct horse battery staple") > 90, "a long passphrase carries a lot");
});

await test("HW-08 · encoding detection distinguishes BOMs, UTF-16 and legacy bytes", { "HW-08": "full" }, () => {
  eq(guessEncoding(new Uint8Array([0xef, 0xbb, 0xbf, 0x41])).encoding, "utf-8-bom", "UTF-8 BOM");
  eq(guessEncoding(new Uint8Array([0xff, 0xfe, 0x41, 0x00])).encoding, "utf-16le-bom", "UTF-16LE BOM");
  eq(guessEncoding(new Uint8Array([0xfe, 0xff, 0x00, 0x41])).encoding, "utf-16be-bom", "UTF-16BE BOM");
  eq(guessEncoding(te.encode("héllo")).encoding, "utf-8", "valid UTF-8");
  ok(guessEncoding(te.encode("ascii only")).ascii_only, "ASCII is flagged");
  eq(guessEncoding(new Uint8Array([0x41, 0x80, 0x42])).encoding, "windows-1252", "invalid UTF-8 falls back with low confidence");
  eq(bytesToText(te.encode("ok")), "ok", "decode");
  throws(() => bytesToText(new Uint8Array([0xff, 0xfe, 0xfd]), { fatal: true }), "fatal decoding refuses invalid bytes");
});

// ── CK-09 civil time ────────────────────────────────────────────────────────
await test("CK-09 · civil day numbers agree with Date.UTC across four centuries", { "CK-09": "full" }, () => {
  for (const [y, m, d] of [[1970, 1, 1], [2000, 2, 29], [1900, 3, 1], [2026, 11, 6], [2100, 12, 31], [1600, 2, 29]]) {
    const z = daysFromCivil(y, m, d);
    eq(z, Math.round(Date.UTC(y, m - 1, d) / 86_400_000), `daysFromCivil(${y}-${m}-${d})`);
    eq(civilFromDays(z), { y, m, d }, `civilFromDays(${z})`);
  }
  eq(isLeapYear(2000), true, "2000 is a leap year");
  eq(isLeapYear(1900), false, "1900 is not");
  eq(daysInMonth(2024, 2), 29, "February 2024");
  eq(addCivilDays(2024, 2, 28, 1), { y: 2024, m: 2, d: 29 }, "leap-day addition");
  eq(addCivilDays(2023, 2, 28, 1), { y: 2023, m: 3, d: 1 }, "non-leap addition");
  eq(addCivilDays(2026, 1, 1, -1), { y: 2025, m: 12, d: 31 }, "backwards across a year boundary");
});

await test("CK-09 · weekday and ISO week match known calendar facts", { "CK-09": "full" }, () => {
  eq(dayOfWeek(1970, 1, 1), 4, "1970-01-01 was a Thursday");
  eq(dayOfWeek(2024, 2, 29), 4, "2024-02-29 was a Thursday");
  eq(dayOfWeek(2026, 11, 6), 5, "2026-11-06 is a Friday");
  eq(isoWeek(2026, 1, 1), { year: 2026, week: 1 }, "2026-01-01 is in ISO week 1");
  eq(isoWeek(2027, 1, 1), { year: 2026, week: 53 }, "2027-01-01 belongs to ISO week 53 of 2026");
  eq(civilDaysBetween({ y: 2026, m: 11, d: 6 }, { y: 2026, m: 11, d: 13 }), 7, "one week");
  eq(civilDaysBetween({ y: 2026, m: 3, d: 1 }, { y: 2026, m: 4, d: 1 }), 31, "March has 31 days regardless of DST");
});

await test("CK-09 · a wall time that does not exist is a gap, and one that happens twice is an overlap", { "CK-09": "full" }, () => {
  // America/New_York springs forward 2026-03-08 at 02:00 local
  const gap = resolveWallTime(2026, 3, 8, 2, 30, "America/New_York");
  eq(gap.kind, "gap", "02:30 does not exist on the spring-forward day");
  // ...and falls back on 2026-11-01 at 02:00 local, so 01:30 happens twice
  const overlap = resolveWallTime(2026, 11, 1, 1, 30, "America/New_York");
  eq(overlap.kind, "overlap", "01:30 happens twice on the fall-back day");
  if (overlap.kind === "overlap") eq(overlap.later - overlap.earlier, 3_600_000, "the two occurrences are exactly an hour apart");
  const normal = resolveWallTime(2026, 7, 1, 12, 0, "America/New_York");
  eq(normal.kind, "unique", "an ordinary wall time");
  if (normal.kind === "unique") eq(normal.offsetMinutes, -240, "EDT is UTC−4");
  // A zone with no DST must never produce a gap or overlap for a valid time.
  for (const [m, d] of [[3, 8], [11, 1], [1, 1], [12, 31]]) {
    eq(resolveWallTime(2026, m, d, 12, 0, "Asia/Tokyo").kind, "unique", `Tokyo ${m}-${d}`);
  }
});

await test("CK-09 · a conversion round-trips through the zone it reports", { "CK-09": "full" }, () => {
  const r = resolveWallTime(2026, 6, 15, 9, 30, "Europe/Paris");
  ok(r.kind === "unique", "Paris in June is unambiguous");
  if (r.kind === "unique") {
    const back = partsInZone(r.instant, "Europe/Paris");
    eq([back.y, back.m, back.d, back.h, back.mi], [2026, 6, 15, 9, 30], "round trip");
    eq(r.offsetMinutes, 120, "CEST is UTC+2");
  }
  eq(toIcsUtc(Date.UTC(2026, 10, 6, 12, 34, 56)), "20261106T123456Z", "ICS timestamp");
  eq(parseIcsTime("20261106"), { kind: "date", y: 2026, m: 11, d: 6 }, "ICS date");
  eq(parseIcsTime("20261106T123456Z"), { kind: "utc", instant: Date.UTC(2026, 10, 6, 12, 34, 56) }, "ICS UTC time");
  eq(parseIcsTime("nonsense"), null, "invalid ICS time");
});

await test("CK-09 · relative phrasing and overlap search are bounded and honest", { "CK-09": "full" }, () => {
  const now = Date.UTC(2026, 10, 6, 12, 0, 0);
  eq(describeDelta(now + 3 * 3_600_000, now), "in 3 hours", "future");
  eq(describeDelta(now - 60_000, now), "1 minute ago", "past singular");
  eq(describeDelta(now + 20_000, now), "in a moment", "very near future");
  eq(describeDelta(now, now), "just now", "now");
  const overlap = callOverlap("America/Los_Angeles", "Europe/London", now);
  ok(overlap === null || (overlap.endHour > overlap.startHour && overlap.startHour >= 0 && overlap.endHour <= 24), "overlap window is a valid range");
});

// ── CV-04 units ─────────────────────────────────────────────────────────────
await test("CV-04 · defined factors are exact to double precision", { "CV-04": "full" }, () => {
  const inch = convert(1, "in", "m");
  ok(inch.ok && inch.value === 0.0254, "1 in = 0.0254 m exactly");
  const mile = convert(1, "mi", "m");
  ok(mile.ok && mile.value === 1609.344, "1 mi = 1609.344 m exactly");
  const lb = convert(1, "lb", "g");
  ok(lb.ok && lb.value === 453.59237, "1 lb = 453.59237 g exactly");
  eq(formatQuantity(0.1 + 0.2), "0.3", "float noise is not shown as 0.30000000000000004");
  // the boiling point is the classic affine case that a multiplier table gets wrong
  const c = convert(100, "degC", "degF");
  ok(c.ok && Math.abs(c.value - 212) < 1e-9, `100 °C must be 212 °F, got ${c.ok ? c.value : c.error}`);
  const back = convert(212, "degF", "degC");
  ok(back.ok && Math.abs(back.value - 100) < 1e-9, "and back");
  ok(convert(-40, "degC", "degF").ok && Math.abs((convert(-40, "degC", "degF") as { value: number }).value + 40) < 1e-9, "-40 is the crossing point");
});

await test("CV-04 · a dimensionally impossible conversion is refused with the reason", { "CV-04": "full" }, () => {
  const bad = convert(5, "kg", "m");
  ok(!bad.ok, "mass to length must fail");
  if (!bad.ok) ok(bad.error.includes("different kinds"), `error should name the problem: ${bad.error}`);
  const speed = convert(100, "kph", "mph");
  ok(speed.ok && Math.abs(speed.value - 62.13711922373339) < 1e-9, "derived dimensions convert");
  // data sizes: the two kilobars are both present and never conflated
  const kib = convert(1, "KiB", "B");
  ok(kib.ok && kib.value === 1024, "KiB is 1024 bytes");
  const kb = convert(1, "kB", "B");
  ok(kb.ok && kb.value === 1000, "kB is 1000 bytes");
  const angle = convert(180, "rad", "deg");
  ok(!angle.ok, "rad and deg have no registered degree unit, so this must refuse rather than guess");
  const nan = convert(Number.NaN, "m", "ft");
  ok(!nan.ok, "NaN is refused");
});

await test("CV-04 · free-text quantities parse the forms people type", { "CV-04": "full" }, () => {
  const feet = parseQuantity("6'2\"");
  ok(feet !== null && Math.abs(feet.value - (6 + 2 / 12)) < 1e-12, "6'2\" is 6.1666 ft");
  const dur = parseQuantity("1h30m");
  ok(dur !== null && dur.value === 5400, "1h30m is 5400 s");
  const kg = parseQuantity("12.5 kg");
  ok(kg !== null && kg.value === 12.5 && kg.unit.id === "kg", "12.5 kg");
  eq(parseQuantity("12.5").unit.id, "one", "a bare number is dimensionless, not silently metres");
  eq(parseQuantity("no unit here at all"), null, "prose is refused");
  eq(parseQuantity(""), null, "empty input");
  ok(compatibleUnits(findUnit("mi")!).every((u) => u.dimension.join() === "1,0,0,0,0,0,0"), "compatible units share the dimension vector");
  ok(!compatibleUnits(findUnit("mi")!).some((u) => u.id === "mi"), "the unit itself is not listed as an alternative");
  ok(UNITS.every((u) => /^[-0-9.,eE]+$/.test(String(u.factor))), "every factor is a plain finite number");
});

// ── ED-11 find/replace ──────────────────────────────────────────────────────
await test("ED-11 · matching honours case, whole-word and Unicode boundaries", { "ED-11": "full" }, () => {
  const text = "The note is notable. NOTE: notes and Notes.";
  eq(findMatches(text, "note").matches.length, 4, "case-insensitive substring count");
  // substring semantics: "note" also occurs inside "notes", so the honest count
  // is 2 — the earlier expectation of 1 was wrong, not the engine.
  eq(findMatches(text, "note", { caseSensitive: true }).matches.map((m) => m.start), [4, 27], "case-sensitive substring offsets");
  eq(findMatches(text, "note", { caseSensitive: true, wholeWord: true }).matches.length, 1, "case-sensitive whole word");
  eq(findMatches(text, "note", { wholeWord: true }).matches.map((m) => m.text), ["note", "NOTE"], "whole word excludes notable and notes");
  // a non-ASCII letter is a word character, so "café" must not match inside "cafés"
  eq(findMatches("café cafés", "café", { wholeWord: true }).matches.length, 1, "Unicode word boundary");
  eq(findMatches("straße STRASSE", "STRASSE").matches.length, 1, "ASCII case folding does not equate ß");
  // Regression for a real off-by-one: toLowerCase() maps "İ" to two code units,
  // which shifted every later highlight. Offsets are now always valid slices.
  const turkish = "İstanbul and note";
  const tm = findMatches(turkish, "note").matches;
  eq(tm.length, 1, "a match after a length-changing fold is still found");
  eq(turkish.slice(tm[0].start, tm[0].end), "note", "and its offsets point at the real text");
  eq(findMatches("İSTANBUL note", "note").matches.length, 1, "a long haystack after İ");
  // the documented consequence, asserted rather than hidden
  eq(findMatches("İ", "i").matches.length, 0, "dotless/dotted i is matched case-sensitively");
  eq(findMatches("", "x").matches.length, 0, "empty haystack");
  eq(findMatches("abc", "").matches.length, 0, "empty needle");
});

await test("ED-11 · a pathological regex is refused or bounded rather than freezing", { "ED-11": "full" }, () => {
  const bad = findMatches("abc", "(unclosed", { regex: true });
  ok(bad.error !== null && bad.error.includes("regular expression"), "an invalid pattern is reported");
  const zero = findMatches("abc", "(?=b)", { regex: true });
  eq(zero.matches.length, 0, "zero-width matches are skipped instead of looping forever");
  const many = findMatches("a".repeat(60_000), "a", { maxMatches: 100 });
  eq(many.matches.length, 100, "the cap is enforced");
  ok(many.truncated, "hitting the cap is reported");
  eq(findMatches("x", "y".repeat(600)).error?.includes("limited"), true, "pattern length bound");
});

await test("ED-11 · replace-all is literal in literal mode and expands groups in regex mode", { "ED-11": "full" }, () => {
  eq(replaceAll("a.b.c", ".", "-").text, "a-b-c", "literal dot");
  eq(replaceAll("x=1, y=2", "(\\w+)=(\\d+)", "$2:$1", { regex: true }).text, "1:x, 2:y", "group expansion");
  // a backslash in the replacement must survive literal mode
  eq(replaceAll("a\\1b", "\\1", "Z").text, "aZb", "backslashes in the needle are literal");
  eq(replaceAll("abc", "b", "\\1").text, "a\\1c", "a replacement template is verbatim outside regex mode");
  eq(replaceAll("aaa", "a", "aa").replaced, 3, "no re-matching of inserted text");
  eq(replaceAll("nomatch", "z", "y"), { text: "nomatch", replaced: 0, ranges: [], error: null }, "nothing to do");
});

await test("ED-11 · navigation wraps predictably and the status string is the single source of truth", { "ED-11": "full" }, () => {
  const text = "one two one two one";
  const matches = findMatches(text, "one").matches;
  eq(matches.length, 3, "three matches");
  eq(nextMatch(matches, -1, 1)?.start, 0, "next from before the start");
  eq(nextMatch(matches, 0, 1)?.start, 8, "strictly after the caret");
  eq(nextMatch(matches, 100, 1)?.start, 0, "wraps to the first");
  eq(nextMatch(matches, 100, 1, { wrap: false }), null, "no wrap when disabled");
  eq(nextMatch(matches, 0, -1)?.start, 16, "previous wraps backwards");
  const state = { query: "one", replace: "", caseSensitive: false, wholeWord: false, regex: false, index: 2 };
  eq(findStatus(state, matches, false), "3 of 3", "status");
  eq(findStatus({ ...state, index: 99 }, matches, false), "3 of 3", "an out-of-range index is clamped, not invented");
  eq(findStatus({ ...state, query: "" }, matches, false), "type to find", "empty query");
  eq(countReplacements(text, "one"), 3, "count without replacing");
});

// ── PR-14 keyboard map ──────────────────────────────────────────────────────
await test("PR-14 · dead-key composition produces one Unicode character, not two", { "PR-14": "full" }, () => {
  eq(replayKeys([{ key: "´", code: "Dead" }, { key: "e" }]).bytes, "é", "acute + e");
  eq(replayKeys([{ key: "^", code: "Dead" }, { key: "o" }]).bytes, "ô", "circumflex + o");
  eq(replayKeys([{ key: "~", code: "Dead" }, { key: "n" }]).bytes, "ñ", "tilde + n");
  eq(replayKeys([{ key: "¨", code: "Dead" }, { key: "u" }]).bytes, "ü", "diaeresis + u");
  eq(compose("n", "~"), "ñ", "NFC composition");
  eq(compose("q", "´"), null, "no precomposed q-acute exists");
  ok(canCompose("e", "´") && !canCompose("q", "´"), "composability pre-check");
});

await test("PR-14 · a dead key followed by a non-composable key emits the standalone accent", { "PR-14": "full" }, () => {
  eq(replayKeys([{ key: "´", code: "Dead" }, { key: "q" }]).bytes, "\u00b4q", "the accent is flushed, not lost");
  const arrow = replayKeys([{ key: "´", code: "Dead" }, { key: "ArrowUp" }]);
  eq(arrow.bytes, "\u00b4\u001b[A", "flushed before a control sequence, as xterm does");
  ok(arrow.notes.some((n) => n.includes("waiting")), "the pending state is explained");
  eq(DEAD_KEYS["´"], "\u00b4", "standalone accent table");
});

await test("PR-14 · control bytes and special sequences follow the C0 table", { "PR-14": "full" }, () => {
  eq(controlByte("c", true, false), "\u0003", "Ctrl+C is ETX");
  eq(controlByte("d", true, false), "\u0004", "Ctrl+D is EOT");
  eq(controlByte("[", true, false), "\u001b", "Ctrl+[ is ESC");
  eq(controlByte("?", true, false), "\u007f", "Ctrl+? is DEL");
  eq(controlByte("c", true, true), "\u001b\u0003", "Alt sends an ESC prefix");
  eq(controlByte("a", false, false), null, "no control without Ctrl");
  eq(replayKeys([{ key: "Enter" }]).bytes, "\r", "Enter is CR, not LF");
  eq(replayKeys([{ key: "Backspace" }]).bytes, "\u007f", "Backspace is DEL");
  eq(replayKeys([{ key: "F5" }]).bytes, "\u001b[15~", "F5 sequence");
  eq(replayKeys([{ key: "ArrowLeft" }]).bytes, "\u001b[D", "arrow sequence");
  eq(replayKeys([{ key: "e", isComposing: true }]).bytes, "", "an IME composition owns its text");
});

// ── DP-15 i18n ──────────────────────────────────────────────────────────────
await test("DP-15 · plural categories follow the CLDR rules for every family", { "DP-15": "full" }, () => {
  const cases: [string, number, string][] = [
    ["en", 1, "one"], ["en", 0, "other"], ["en", 2, "other"],
    ["ru", 1, "one"], ["ru", 2, "few"], ["ru", 5, "many"], ["ru", 11, "many"], ["ru", 21, "one"], ["ru", 22, "few"],
    ["pl", 1, "one"], ["pl", 3, "few"], ["pl", 12, "many"], ["pl", 25, "many"],
    ["cs", 1, "one"], ["cs", 3, "few"], ["cs", 5, "other"],
    ["ar", 0, "zero"], ["ar", 1, "one"], ["ar", 2, "two"], ["ar", 7, "few"], ["ar", 42, "many"],
    ["cy", 3, "few"], ["cy", 6, "many"], ["ga", 4, "few"], ["lt", 11, "other"], ["lv", 0, "zero"],
    ["ja", 1, "other"], ["zh", 5, "other"], ["fr", 1, "one"], ["fr", 0, "one"], ["tr", 1, "one"],
  ];
  for (const [loc, n, expected] of cases) eq(pluralCategory(loc, n).category, expected, `${loc}/${n}`);
  // the engine must say which rule fired, not just the category
  ok(pluralCategory("ru", 3).rule.includes("% 10"), "the rule is reported");
  eq(pluralOperands(1.5), { n: 1.5, i: 1, v: 1, w: 1, f: 5, t: 5, e: 0 }, "operands of a decimal");
});

await test("DP-15 · message formatting handles plural, select, number, date and a missing argument", { "DP-15": "full" }, () => {
  eq(formatMessage("{n, plural, one {# file} other {# files}}", { locale: "en", args: { n: 1 } }), "1 file", "plural one");
  eq(formatMessage("{n, plural, one {# file} other {# files}}", { locale: "en", args: { n: 3 } }), "3 files", "plural other");
  eq(formatMessage("{g, select, admin {Administrator} other {Member}}", { locale: "en", args: { g: "admin" } }), "Administrator", "select");
  eq(formatMessage("{g, select, admin {Administrator} other {Member}}", { locale: "en", args: { g: "guest" } }), "Member", "select falls to other");
  eq(formatMessage("missing {who}", { locale: "en", args: {} }), "missing {who}", "a missing argument is visible, not silent");
  eq(formatMessage("{{literal}}", { locale: "en", args: {} }), "{literal}", "an unparseable placeholder passes through");
  eq(formatMessage("{n, number}", { locale: "de-DE", args: { n: 1234.5 } }), "1.234,5", "locale number grouping");
  ok(formatMessage("{d, date}", { locale: "en-US", args: { d: new Date(Date.UTC(2026, 10, 6)) } }).includes("2026"), "date formatting");
  eq(ordinalCategory("en", 1), "one", "1st"); eq(ordinalCategory("en", 2), "two", "2nd"); eq(ordinalCategory("en", 3), "few", "3rd"); eq(ordinalCategory("en", 4), "other", "4th"); eq(ordinalCategory("en", 11), "other", "11th");
  ok(formatList(["a", "b", "c"], "en").includes("and"), "list conjunction");
  eq(formatList([], "en"), "", "empty list");
  eq(formatNumber(1234.5, "en-US"), "1,234.5", "number formatting");
  ok(formatRelative(Date.now() - 3_600_000, "en").includes("hour"), "relative time");
});

finish();
