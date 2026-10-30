/** TT117 — unit contract for the nine new engines. Pure: no server, no browser. */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { validateAlarms, nextFire, upcomingAlarms, snooze, lapStats, daysBetween, addDays, businessDaysBetween } from "../src/lib/clock-core";
import { parseRRule, formatRRule, expandRecurrence } from "../src/lib/recurrence";
import { analyzeNote } from "../src/lib/notes-stats";
import { exportClips, parseClipImport } from "../src/lib/clip-io";
import { compileFind, findInText } from "../src/lib/find-core";
import { buildManifest, parseManifest, verifyManifest, archiveStats, duplicateGroups, type MemoryRef } from "../src/lib/recall-report";
import { exportSession, parseBrowserImport } from "../src/lib/browser-io";
import { exportRoutines, parseRoutineImport } from "../src/lib/routine-io";
import { checkRegister, citedSuites } from "../src/lib/spec-health";

const { test, finish } = makeHarness("tt117-core");
const D = (s: string) => new Date(s + "T00:00:00");

await test("CK-01 alarms: next fire, weekly days, disabled, snooze, validation", { "CK-01": "full" }, () => {
  const a = validateAlarms([{ id: "a1", label: "Standup", time: "09:30", days: [1, 2, 3, 4, 5], enabled: true, snoozeMin: 10 }])[0];
  assert.equal(nextFire(a, new Date(2026, 0, 5, 9, 29))!.getTime(), new Date(2026, 0, 5, 9, 30).getTime()); // Mon
  assert.equal(nextFire(a, new Date(2026, 0, 5, 9, 30))!.getDay(), 2); // strictly after -> Tue
  assert.equal(nextFire(a, new Date(2026, 0, 9, 10, 0))!.getDay(), 1); // Fri after -> Mon
  assert.equal(nextFire({ ...a, enabled: false }, new Date()) , null);
  assert.equal(nextFire({ ...a, days: [] }, new Date(2026, 0, 5, 10, 0))!.getDate(), 6); // empty days = daily
  assert.equal(snooze(a, new Date(2026, 0, 5, 9, 30)).getMinutes(), 40);
  assert.equal(upcomingAlarms([a, { ...a, id: "a2", time: "07:00", days: [] }], new Date(2026, 0, 5, 6, 0))[0].alarm.id, "a2");
  assert.throws(() => validateAlarms([{ id: "x", label: "", time: "25:00", days: [], enabled: true }]), /HH:MM/);
  assert.throws(() => validateAlarms([{ id: "x", label: "", time: "09:00", days: [7], enabled: true }]), /weekday/);
  assert.throws(() => validateAlarms([a, a]), /unique/);
});

await test("CK-02 lap splits: deltas, fastest/slowest, monotonic refusal", { "CK-02": "full" }, () => {
  const s = lapStats([10_000, 25_000, 33_000]);
  assert.deepEqual(s.laps.map((l) => l.splitMs), [10_000, 15_000, 8_000]);
  assert.equal(s.fastest!.index, 3); assert.equal(s.slowest!.index, 2);
  assert.equal(s.averageSplitMs, 11_000);
  assert.equal(lapStats([]).fastest, null);
  assert.throws(() => lapStats([5_000, 4_000]), /non-decreasing/);
});

await test("CK-03 date arithmetic: days, add, business days sign-aware", { "CK-03": "full" }, () => {
  assert.equal(daysBetween(D("2026-01-01"), D("2026-01-31")), 30);
  assert.equal(daysBetween(D("2026-01-31"), D("2026-01-01")), -30);
  assert.equal(addDays(D("2026-01-31"), 1).getDate(), 1);
  assert.equal(businessDaysBetween(D("2026-01-02"), D("2026-01-05")), 1); // Fri->Mon counts Mon? (a,b] Mon only... Fri excluded, Mon is endpoint excluded? [a,b): Sat,Sun,Mon -> Mon counted? see impl: i=1..3 Sat,Sun,Mon => 1
  assert.equal(businessDaysBetween(D("2026-01-05"), D("2026-01-02")), -1);
  assert.equal(businessDaysBetween(D("2026-01-05"), D("2026-01-05")), 0);
  assert.equal(businessDaysBetween(D("2026-01-01"), D("2026-01-31")), 21); // Jan 2026: Fri 2nd + four full Mon-Fri weeks
  assert.throws(() => addDays(D("2026-01-01"), 1.5), /integer/);
});

await test("PL-01 recurrence: daily/weekly BYDAY/monthly clamp/count/until + RRULE round-trip", { "PL-01": "full", "PL-02": "full" }, () => {
  const weekly = parseRRule("FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1");
  const occ = expandRecurrence(new Date(2026, 0, 5, 9, 0), weekly, D("2026-01-01"), D("2026-01-15"));
  assert.deepEqual(occ.map((d) => d.getDate()), [5, 7, 12, 14]);
  const monthly = expandRecurrence(new Date(2026, 0, 31, 9, 0), parseRRule("FREQ=MONTHLY"), D("2026-01-01"), D("2026-04-01"));
  assert.deepEqual(monthly.map((d) => `${d.getMonth() + 1}/${d.getDate()}`), ["1/31", "2/28", "3/31"]); // anchor day remembered
  const counted = expandRecurrence(new Date(2026, 0, 1, 9, 0), parseRRule("FREQ=DAILY;COUNT=3"), D("2025-01-01"), D("2027-01-01"));
  assert.equal(counted.length, 3);
  const until = expandRecurrence(new Date(2026, 0, 1, 9, 0), parseRRule("FREQ=DAILY;UNTIL=20260103"), D("2025-01-01"), D("2027-01-01"));
  assert.equal(until.length, 3);
  assert.equal(formatRRule(parseRRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH")), "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH");
  assert.throws(() => parseRRule("FREQ=HOURLY"), /FREQ/);
  assert.throws(() => parseRRule("FREQ=DAILY;BYDAY=XX"), /BYDAY/);
  assert.throws(() => expandRecurrence(new Date(2026, 0, 1), parseRRule("FREQ=DAILY"), D("2026-02-01"), D("2026-01-01")), /inverted/);
});

await test("NT-01 note stats: code excluded, outline, links, reading time", { "NT-01": "full" }, () => {
  const s = analyzeNote("# Title\n\nHello world. This is prose!\n\n```ts\nconst ignored = 'words words words';\n```\n\n## Part\n\nSee [a](https://x.example) and ![i](https://x.example/i.png) plus `inline code`.");
  assert.equal(s.headings.length, 2); assert.equal(s.headings[1].line, 9);
  assert.equal(s.codeBlocks, 1); assert.equal(s.codeLines, 1);
  assert.equal(s.links, 1); assert.equal(s.images, 1);
  assert.equal(s.sentences, 3); // two in prose + the link sentence
  assert.equal(s.words, 20); // exact: the fenced line's 5 code words are excluded (would be 25)
  assert.equal(s.readingMinutes, 1);
  assert.equal(analyzeNote("").readingMinutes, 0);
});

await test("CB-01 clipboard export/import: sensitive refused, dedupe, malformed refused whole", { "CB-01": "full" }, () => {
  const clips = [
    { text: "hello", at: 1, sensitive: false, from: "Files" },
    { text: "••••", at: 2, sensitive: true, from: "Vault" },
  ];
  const json = exportClips(clips);
  assert.ok(!json.includes("secret")); assert.ok(json.includes('"redacted": true'));
  const r = parseClipImport(json, []);
  assert.equal(r.added.length, 1); assert.equal(r.refusedSensitive, 1);
  assert.equal(parseClipImport(json, clips).skippedDuplicates, 1);
  assert.throws(() => parseClipImport("{nope", []), /JSON/);
  assert.throws(() => parseClipImport(JSON.stringify({ kind: "other", entries: [] }), []), /not a Fusion/);
});

await test("FN-01 find: literal escape, regex error, whole word, positions, cap", { "FN-01": "full" }, () => {
  const lit = compileFind("a.b", { regex: false, caseSensitive: true, wholeWord: false });
  assert.ok("pattern" in lit);
  assert.equal(findInText("a.b axb a.b", (lit as { pattern: RegExp }).pattern).matches.length, 2);
  const bad = compileFind("(", { regex: true, caseSensitive: true, wholeWord: false });
  assert.ok("error" in bad);
  const word = compileFind("cat", { regex: true, caseSensitive: false, wholeWord: true });
  const found = findInText("Cat scatter cat\ncat", (word as { pattern: RegExp }).pattern);
  assert.deepEqual(found.matches.map((m) => [m.line, m.column]), [[1, 1], [1, 13], [2, 1]]);
});

await test("RC-40/41/42 recall report: deterministic manifest, verify diff, stats, duplicates", { "RC-40": "full", "RC-41": "full", "RC-42": "full" }, () => {
  const mem: MemoryRef[] = [
    { path: "/Downloads/Recall/b.com/a.png", sha256: "a".repeat(64), bytes: 100, mime: "image/png", method: "resident-file", capturedAt: "2026-01-02T10:00:00.000Z", folder: "b.com" },
    { path: "/Downloads/Recall/a.com/a.png", sha256: "a".repeat(64), bytes: 100, mime: "image/png", method: "resident-file", capturedAt: "2026-01-02T11:00:00.000Z", folder: "a.com" },
    { path: "/Downloads/Recall/a.com/c.webm", sha256: "b".repeat(64), bytes: 300, mime: "video/webm", method: "authorized-display-recording", capturedAt: null, folder: "a.com" },
  ];
  assert.equal(buildManifest(mem, "2026-01-03T00:00:00.000Z"), buildManifest([...mem].reverse(), "2026-01-03T00:00:00.000Z")); // deterministic
  const manifest = buildManifest(mem);
  assert.equal(parseManifest(manifest).length, 3);
  assert.equal(verifyManifest(manifest, mem).ok, true);
  const diff = verifyManifest(manifest, mem.slice(1).map((m) => m.path.endsWith("c.webm") ? { ...m, bytes: 301 } : m));
  assert.equal(diff.ok, false); assert.deepEqual(diff.missing, ["/Downloads/Recall/b.com/a.png"]); assert.equal(diff.changed[0].field, "bytes");
  const stats = archiveStats(mem);
  assert.equal(stats.totalBytes, 500); assert.equal(stats.undated, 1); assert.equal(stats.byDay[0].count, 2);
  const dups = duplicateGroups(mem);
  assert.equal(dups.length, 1); assert.equal(dups[0].wastedBytes, 100); assert.equal(dups[0].paths.length, 2);
  assert.throws(() => parseManifest(JSON.stringify({ kind: "x", memories: [] })), /not a Fusion/);
});

await test("BR-01 browser session io: unsafe URLs dropped and reported, groups preserved", { "BR-01": "full" }, () => {
  const json = exportSession(
    [{ id: "t1", url: "https://example.com/a", title: "A", group: "g1", pinned: true, asleep: false, profile: "work" }],
    [{ id: "g1", name: "Work", color: "#fff", collapsed: false }],
  );
  assert.ok(!json.includes("wp-session") && !json.includes("sid"));
  const back = parseBrowserImport(json, "http://localhost:3999");
  assert.equal(back.tabs.length, 1); assert.equal(back.tabs[0].group, "g1"); assert.equal(back.dropped, 0);
  const dirty = parseBrowserImport(JSON.stringify({ kind: "fusion.browser-session.v1", tabs: [{ url: "javascript:alert(1)" }, { url: "https://ok.example/" }], groups: [] }), "http://localhost:3999");
  assert.equal(dirty.dropped, 1); assert.equal(dirty.tabs.length, 1);
  assert.throws(() => parseBrowserImport(JSON.stringify({ kind: "fusion.browser-session.v1", tabs: [{ url: "javascript:x" }] }), "http://x"), /no usable tabs/);
});

await test("RT-01 routine io: whitelist re-validated, duplicate names skipped not overwritten", { "RT-01": "full" }, () => {
  const json = exportRoutines([{ name: "Focus", actions: [{ cmd: "open", arg: "notes" }] }]);
  const r = parseRoutineImport(json, ["focus"]);
  assert.deepEqual(r.skipped, ["Focus"]); assert.equal(r.routines.length, 0);
  assert.equal(parseRoutineImport(json, []).routines.length, 1);
  assert.throws(() => parseRoutineImport(JSON.stringify({ kind: "fusion.routines.v1", routines: [{ name: "X", actions: [{ cmd: "exec", arg: "rm" }] }] }), []), /whitelist/);
});

await test("SP-01 register health: duplicates, missing suites, unclaimed built rows, unknown claims", { "SP-01": "full" }, () => {
  const suites = new Set(readdirSync("scripts").filter((f) => f.endsWith(".mts")));
  assert.ok(citedSuites("tt117-core.mts ×3; e2e-tt116-density.mts").includes("tt117-core.mts"));
  const issues = checkRegister([
    { code: "AA-01", status: "built", test: "tt117-core.mts" },
    { code: "AA-01", status: "built", test: "" },
    { code: "AA-02", status: "built", test: "no-such-suite.mts" },
    { code: "AA-03", status: "blocked", test: "" },
  ], [{ id: "m1", implements: ["AA-01", "ZZ-99"] }], suites);
  const kinds = issues.map((i) => i.kind);
  assert.ok(kinds.includes("duplicate-code")); assert.ok(kinds.includes("missing-suite"));
  assert.ok(kinds.includes("built-without-module")); assert.ok(kinds.includes("module-claims-unknown-code"));
  assert.ok(!issues.some((i) => i.code === "AA-03")); // blocked rows exempt from module claim
});

await test("PL-02 ICS RRULE round-trip: import carries the rule, export re-emits it", { "PL-02": "full" }, async () => {
  const { parseIcs, toIcs } = await import("../src/lib/ics");
  const items = parseIcs("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u1@x\r\nSUMMARY:Standup\r\nDTSTART:20260105T093000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
  assert.equal(items.length, 1);
  assert.equal(items[0].rrule, "FREQ=WEEKLY;BYDAY=MO,WE");
  const out = toIcs(items.map((i) => ({ ...i, kind: "event" })));
  assert.ok(out.includes("RRULE:FREQ=WEEKLY;BYDAY=MO,WE"));
  const again = parseIcs(out);
  assert.equal(again[0].rrule, "FREQ=WEEKLY;BYDAY=MO,WE");
});

finish();
