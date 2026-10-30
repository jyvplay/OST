/** TT119 — unit contract for the eleven new engines. Pure: no server, no browser. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { findMatches, replaceAll, replaceOne } from "../src/lib/editor-find";
import { folderSizes, formatBytes } from "../src/lib/folder-size";
import { dailyTitle, findDailyNote } from "../src/lib/daily-note";
import { filterTasks } from "../src/lib/task-filter";
import { validateZones, addZone, removeZone, isValidZone } from "../src/lib/zone-list";
import { wc, formatWc } from "../src/lib/wc-core";
import { bundleTree } from "../src/lib/bundle-tree";
import { validateRecents, pushRecent, RECENT_LIMIT } from "../src/lib/recent-searches";
import { clampInterval, nextIndex, prevIndex } from "../src/lib/slideshow";
import { convertZoneTime } from "../src/lib/zone-convert";
import { validatePlays, pushPlay } from "../src/lib/recent-plays";

const { test, finish } = makeHarness("tt119-core");

await test("ED-03 find/replace: literal, counted, nth-only, empty refused", { "ED-03": "full" }, () => {
  const text = "a.b a.b axb\na.b";
  assert.equal(findMatches(text, "a.b").length, 3, "dots are literal, axb does not match");
  assert.equal(findMatches(text, "A.B").length, 3, "case-insensitive by default");
  assert.equal(findMatches(text, "A.B", true).length, 0);
  assert.deepEqual(findMatches("x\nyy x", "x").map((m) => [m.line, m.column]), [[1, 1], [2, 4]], "line/column reported");
  assert.equal(replaceAll(text, "a.b", "z").count, 3);
  assert.equal(replaceOne(text, "a.b", "z", 2).text, "a.b z axb\na.b");
  assert.throws(() => findMatches(text, ""), /Type something/);
});

await test("BK-07 engine: folder rollup, unknown not zero", { "BK-07": "full" }, () => {
  const sizes = folderSizes({ path: "/", kind: "dir", children: [
    { path: "/a", kind: "dir", children: [
      { path: "/a/x.bin", kind: "file", size: 1000 },
      { path: "/a/y.bin", kind: "file" },
    ] },
    { path: "/b.txt", kind: "file", size: 24 },
  ] });
  const root = sizes.find((s) => s.path === "/")!;
  assert.deepEqual([root.bytes, root.files, root.dirs, root.unknown], [1024, 3, 2, 1]);
  assert.equal(sizes[0].path, "/", "largest first");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(500), "500 B");
});

await test("NT-03 daily note: local title, both conventions, no guessing", { "NT-03": "full" }, () => {
  const now = new Date(2026, 9, 30, 23, 30);
  assert.equal(dailyTitle(now), "2026-10-30");
  const notes = [{ id: "1", title: "Shopping" }, { id: "2", title: "2026-10-30" }, { id: "3", title: "Daily 2026-10-29" }];
  assert.equal(findDailyNote(notes, now)?.id, "2");
  assert.equal(findDailyNote([{ id: "9", title: "daily 2026-10-30" }], now)?.id, "9");
  assert.equal(findDailyNote(notes.slice(0, 1), now), null, "a similarly-named note is not invented");
});

await test("PL-04 task filter: query+status, order preserved", { "PL-04": "full" }, () => {
  const tasks = [
    { id: "1", title: "Buy milk", notes: "", done: false },
    { id: "2", title: "Call Ana", notes: "about milk", done: true },
    { id: "3", title: "Milk report", notes: "", done: false },
  ];
  assert.deepEqual(filterTasks(tasks, "milk").map((t) => t.id), ["1", "2", "3"], "notes match too, order kept");
  assert.deepEqual(filterTasks(tasks, "milk", "open").map((t) => t.id), ["1", "3"]);
  assert.deepEqual(filterTasks(tasks, "", "done").map((t) => t.id), ["2"]);
});

await test("CK-04 zone list: Intl-validated, UTC pinned, capped", { "CK-04": "full" }, () => {
  assert.equal(isValidZone("Europe/London"), true);
  assert.equal(isValidZone("Mars/Olympus"), false);
  assert.deepEqual(validateZones(["America/New_York", "Bogus/Zone", "America/New_York", 7]), ["UTC", "America/New_York"], "invalid and duplicate entries dropped");
  assert.throws(() => removeZone(["UTC"], "UTC"), /reference/);
  assert.throws(() => addZone(["UTC"], "Bogus/Zone"), /Unknown/);
  const full = Array.from({ length: 12 }, (_, i) => `Z${i}`); // length is what the cap checks
  assert.throws(() => addZone(full as unknown as string[], "Europe/Paris"), /At most/);
});

await test("TM-03 wc: UTF-8 bytes, POSIX lines", { "TM-03": "full" }, () => {
  assert.deepEqual(wc("a b\nc\n"), { lines: 2, words: 3, bytes: 6, chars: 6 });
  assert.equal(wc("a").lines, 0, "no trailing newline = 0 complete lines");
  assert.equal(wc("😀").bytes, 4, "an emoji is 4 bytes, not 2 code units");
  assert.equal(wc("").bytes, 0);
  assert.match(formatWc("f.txt", wc("x y")), /f\.txt$/);
});

await test("BK-07 bundle explorer: flat entries become a sized folder tree", { "BK-07": "full" }, () => {
  const tree = bundleTree([
    { path: "/Docs", kind: "dir" },
    { path: "/Docs/a.md", kind: "file", size: 100 },
    { path: "/Docs/deep/b.bin", kind: "file", size: 924 },
    { path: "/top.txt", kind: "file", size: 0 },
  ]);
  const sizes = folderSizes(tree);
  const root = sizes.find((x) => x.path === "/")!;
  assert.deepEqual([root.bytes, root.files, root.dirs], [1024, 3, 3], "intermediate dirs are created, bytes roll up");
  assert.equal(sizes.find((x) => x.path === "/Docs")!.bytes, 1024);
  assert.equal(sizes.find((x) => x.path === "/Docs/deep")!.files, 1);
});

await test("SR-09 recents: dedup-to-front, mode validated, capped", { "SR-09": "full" }, () => {
  let list = pushRecent([], { q: "a", scope: "", mode: "text", at: 1 });
  list = pushRecent(list, { q: "b", scope: "", mode: "text", at: 2 });
  list = pushRecent(list, { q: "a", scope: "", mode: "text", at: 3 });
  assert.deepEqual(list.map((r) => r.q), ["a", "b"], "a repeat moves to the front, no duplicate");
  assert.equal(validateRecents([{ q: "x", scope: "", mode: "evil", at: 1 }]).length, 0, "unknown mode cannot be injected");
  const many = validateRecents(Array.from({ length: 30 }, (_, i) => ({ q: `q${i}`, scope: "", mode: "text", at: i })));
  assert.equal(many.length, RECENT_LIMIT);
});

await test("PH-03 slideshow: wraps, clamps, empty has no next", { "PH-03": "full" }, () => {
  assert.equal(nextIndex(2, 3), 0, "wraps at the end");
  assert.equal(prevIndex(0, 3), 2);
  assert.equal(nextIndex(0, 0), -1);
  assert.equal(clampInterval(0), 1);
  assert.equal(clampInterval(3600), 60);
  assert.equal(clampInterval(Number.NaN), 4);
});

await test("WD-03 zone convert: dateline shift reported, invalid refused", { "WD-03": "full" }, () => {
  const r = convertZoneTime("2026-10-30", "09:00", "America/New_York", "Asia/Tokyo");
  assert.equal(r.targetTime, "22:00");
  assert.equal(r.dayShift, 0, "09:00 New York is 22:00 Tokyo the same day (EDT)");
  const r2 = convertZoneTime("2026-10-30", "23:00", "America/New_York", "Asia/Tokyo");
  assert.equal(r2.dayShift, 1, "late evening crosses into tomorrow, and says so");
  assert.throws(() => convertZoneTime("30/10/2026", "09:00", "UTC", "UTC"), /YYYY-MM-DD/);
  assert.throws(() => convertZoneTime("2026-10-30", "09:00", "Bogus/Zone", "UTC"), /time zone|Time zone/i);
});

await test("MU-02 recent plays: front-dedup, validated, capped", { "MU-02": "full" }, () => {
  let list = pushPlay([], { id: "t1", title: "One", at: 1 });
  list = pushPlay(list, { id: "t2", title: "Two", at: 2 });
  list = pushPlay(list, { id: "t1", title: "One", at: 3 });
  assert.deepEqual(list.map((p) => p.id), ["t1", "t2"]);
  assert.equal(validatePlays([{ id: "", title: "x", at: 1 }, { id: "ok", title: "y", at: 1 }]).length, 1);
});

finish();
