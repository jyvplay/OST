/** TT125 core: pure-engine contracts for the twenty features this turn promotes.
 *  Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt125-core.mts */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { stampText } from "../src/lib/stamp-text.ts";
import { caseTransform, caseLabel, CASE_MODES } from "../src/lib/case-text.ts";
import { pdfPageText } from "../src/lib/page-text.ts";
import { readingMinutes, readingTimeText, READING_WPM } from "../src/lib/read-time.ts";
import { filterSessions } from "../src/lib/session-filter.ts";
import { estimateText } from "../src/lib/storage-estimate.ts";
import { bookPositionText } from "../src/lib/position-text.ts";
import { reuseGroups, reuseReportText } from "../src/lib/pwd-audit.ts";
import { doneTasksText } from "../src/lib/done-list.ts";
import { parseAlias, expandAlias } from "../src/lib/alias-map.ts";
import { recallHitsText } from "../src/lib/recall-text.ts";
import { asciiRuns, asciiRunsText, STRINGS_MIN } from "../src/lib/peek-strings.ts";
import { zoomOptions, torchSupported } from "../src/lib/zoom-pick.ts";
import { pushRecent, RECENT_MAX } from "../src/lib/recents.ts";
import { mergeClipTexts } from "../src/lib/merge-clips.ts";
import { participantsText } from "../src/lib/participants-text.ts";
import { shortcutsText } from "../src/lib/shortcuts-text.ts";

const { test, finish } = makeHarness("tt125-core");

await test("ED-10 stampText: zero-padded local date and time, minute precision", { "ED-10": "full" }, () => {
  assert.equal(stampText(new Date(2026, 0, 5, 7, 9)), "2026-01-05 07:09");
  assert.equal(stampText(new Date(2030, 11, 31, 23, 59)), "2030-12-31 23:59");
  assert.match(stampText(new Date()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

await test("ED-09 caseTransform: upper/lower exact; title caps run-starts only", { "ED-09": "full" }, () => {
  assert.equal(caseTransform("hello WORLD", "upper"), "HELLO WORLD");
  assert.equal(caseTransform("Hello World", "lower"), "hello world");
  assert.equal(caseTransform("the iPad's USB-c port", "title"), "The iPad's USB-c Port");
  assert.equal(caseTransform("already camelCase inside", "title"), "Already camelCase Inside");
  assert.equal(CASE_MODES.length, 3);
  assert.equal(caseLabel("title"), "Title Case");
});

await test("PD-03 pdfPageText: lines by y, spans by x, blanks dropped", { "PD-03": "full" }, () => {
  const spans = [
    { str: "world", x: 60, y: 20 }, { str: "hello", x: 10, y: 20 },
    { str: "  ", x: 99, y: 21 }, { str: "two", x: 10, y: 45 },
  ];
  assert.equal(pdfPageText(spans), "hello world\ntwo");
  assert.equal(pdfPageText([]), "");
});

await test("WR-02 reading time: 238 wpm, rounds up, empty says so", { "WR-02": "full" }, () => {
  assert.equal(READING_WPM, 238);
  assert.equal(readingMinutes(0), 0);
  assert.equal(readingMinutes(1), 1);
  assert.equal(readingMinutes(239), 2);
  assert.match(readingTimeText(476), /≈ 2 min read at 238 wpm/);
  assert.equal(readingTimeText(0), "no words yet");
});

await test("BM-03 filterSessions: matches transport, target or state; empty query keeps all", { "BM-03": "full" }, () => {
  const list = [
    { transport: "tcp", target: "cam-1", state: "live" },
    { transport: "quic", target: "lab", state: "idle" },
  ];
  assert.equal(filterSessions(list, "").length, 2);
  assert.equal(filterSessions(list, "QUIC").length, 1);
  assert.equal(filterSessions(list, "live").length, 1);
  assert.equal(filterSessions(list, "cam").length, 0); // target only matches via the extractor
  assert.equal(filterSessions(list, "cam", (s) => s.target).length, 1);
  assert.equal(filterSessions(list, "nope").length, 0);
});

await test("DV-03 estimateText: both, one, or neither number shared", { "DV-03": "full" }, () => {
  assert.equal(estimateText(1048576, 4194304), "using 1.0 MB of 4.0 MB (25%)");
  assert.equal(estimateText(null, 4194304), "quota 4.0 MB · usage not shared");
  assert.equal(estimateText(2048, null), "using 2.0 kB · quota not shared");
  assert.equal(estimateText(null, null), "the browser shares no storage estimate here");
});

await test("BK-13 bookPositionText: fraction and chapter stated, absences honest", { "BK-13": "full" }, () => {
  assert.equal(bookPositionText("Dune", 0.421, "ch 3"), "Dune — 42% — ch 3");
  assert.equal(bookPositionText("Dune", null, "ch 3"), "Dune — ch 3");
  assert.equal(bookPositionText("Dune", 0.5, null), "Dune — 50%");
  assert.equal(bookPositionText("Dune", null, null), "Dune — position not reported by this book");
  assert.equal(bookPositionText("Dune", 9, null), "Dune — 100%");
});

await test("VA-03 reuseGroups: only digests compared, labels sorted, report honest", { "VA-03": "full" }, () => {
  const g = reuseGroups([
    { id: 1, label: "mail", digest: "aa" }, { id: 2, label: "bank", digest: "aa" },
    { id: 3, label: "wiki", digest: "bb" }, { id: 4, label: "old", digest: "" },
  ]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].labels, ["bank", "mail"]);
  assert.equal(reuseReportText(g), "2× shared: bank, mail");
  assert.equal(reuseReportText([]), "no secret is stored twice");
});

await test("PL-10 doneTasksText: done only, list order, empty stated", { "PL-10": "full" }, () => {
  assert.equal(doneTasksText([{ title: "b", done: true }, { title: "a", done: false }, { title: "c", done: true }]), "- b\n- c");
  assert.equal(doneTasksText([{ title: "a", done: false }]), "nothing done yet");
});

await test("TM-08 alias: parse validates, expansion is first-token one-pass", { "TM-08": "full" }, () => {
  assert.deepEqual(parseAlias("alias g=git status"), { name: "g", cmd: "git status" });
  assert.equal(parseAlias("alias g="), null);
  assert.equal(parseAlias("ls"), null);
  const map = { g: "git status", ls: "ls --color" };
  assert.equal(expandAlias("g -s", map), "git status -s");
  assert.equal(expandAlias("g", map), "git status");
  assert.equal(expandAlias("grep x", map), "grep x");
  assert.equal(expandAlias("ls", { ls: "ls" }), "ls"); // no recursion into itself
});

await test("RC-43 recallHitsText: newest first, timestamped", { "RC-43": "full" }, () => {
  const t = recallHitsText([
    { title: "old", where: "host", at: 1000 }, { title: "new", where: "tab", at: 2000 },
  ]);
  assert.ok(t.indexOf("new") < t.indexOf("old"));
  assert.equal(recallHitsText([]), "no hits recorded");
});

await test("PK-04 asciiRuns: min length honoured, runs split on any non-printable", { "PK-04": "full" }, () => {
  const bytes = [..."abcd\x00efghij\x01xy"].map((c) => c.charCodeAt(0));
  assert.deepEqual(asciiRuns(bytes), ["abcd", "efghij"]);
  assert.deepEqual(asciiRuns(bytes, 5), ["efghij"]);
  assert.equal(STRINGS_MIN, 4);
  assert.equal(asciiRunsText([0, 1, 2]), "no ASCII run of 4+ bytes");
});

await test("LN-19/LN-20 zoomOptions from capabilities; torch is a capability, never assumed", { "LN-19": "full", "LN-20": "full" }, () => {
  assert.deepEqual(zoomOptions({ min: 1, max: 4, step: 1 }), [1, 2, 3, 4]);
  assert.deepEqual(zoomOptions({ min: 2, max: 2 }), []);
  assert.deepEqual(zoomOptions(null), []);
  assert.deepEqual(zoomOptions({ min: 1, max: 8, step: 0.5 }).at(-1), 8);
  assert.equal(torchSupported({ torch: true }), true);
  assert.equal(torchSupported({}), false);
  assert.equal(torchSupported(null), false);
});

await test("AP-08 pushRecent: newest first, deduped, capped", { "AP-08": "full" }, () => {
  assert.deepEqual(pushRecent(["b", "a"], "c"), ["c", "b", "a"]);
  assert.deepEqual(pushRecent(["b", "a"], "a"), ["a", "b"]);
  assert.deepEqual(pushRecent(Array.from({ length: 10 }, (_, i) => `m${i}`), "x").length, RECENT_MAX);
});

await test("CB-03 mergeClipTexts: shown order, blank clips dropped, separator explicit", { "CB-03": "full" }, () => {
  assert.equal(mergeClipTexts(["one", "  ", "two"]), "one\n\ntwo");
  assert.equal(mergeClipTexts(["a", "b"], " | "), "a | b");
  assert.equal(mergeClipTexts([]), "");
});

await test("TG-03 participantsText: hosts first, then alphabetical, empty stated", { "TG-03": "full" }, () => {
  assert.equal(participantsText([{ name: "zoe" }, { name: "amy", host: true }, { name: "bo" }]), "amy (host)\nbo\nzoe");
  assert.equal(participantsText([]), "nobody else is in the room");
});

await test("ST-16 shortcutsText: keys then purpose, one per line", { "ST-16": "full" }, () => {
  assert.equal(shortcutsText([{ keys: "Ctrl+K", what: "command palette" }]), "Ctrl+K  —  command palette");
  assert.equal(shortcutsText([]), "no shortcuts listed");
});

finish();
