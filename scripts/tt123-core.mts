/** TT123 — unit contract for the twenty new engines. Pure: no server, no browser. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { rasterSize, MAX_RASTER_PIXELS } from "../src/lib/raster-size";
import { elapsedLabel } from "../src/lib/elapsed";
import { filterAccess } from "../src/lib/access-filter";
import { clampTermFont, stepTermFont } from "../src/lib/term-font";
import { offsetMinutes, sortZonesByOffset, offsetLabel } from "../src/lib/zone-offset";
import { nextMatch } from "../src/lib/match-nav";
import { allTags, filterByTag, tagsOf } from "../src/lib/note-tags";
import { prunePlan } from "../src/lib/prune-plan";
import { pushCommand, historyText, CMD_HISTORY_MAX } from "../src/lib/cmd-history";
import { historyAsText } from "../src/lib/calc-history-text";
import { filterMessages } from "../src/lib/message-search";
import { undatedPhotos } from "../src/lib/photo-dates";
import { overdueText } from "../src/lib/overdue-text";
import { buildQuery } from "../src/lib/phrase-query";
import { deviceInfoText } from "../src/lib/device-info";
import { clampSlide, slideLabel } from "../src/lib/slide-nav";
import { familyKey, sortByFamily } from "../src/lib/contact-name-sort";
import { namesList } from "../src/lib/names-list";

const { test, finish } = makeHarness("tt123-core");

await test("WB-07/VT-01 raster size: scale honoured, pixel cap scales down and says so", { "WB-07": "full", "VT-01": "full" }, () => {
  assert.deepEqual(rasterSize(100, 50, 2), { w: 200, h: 100, scale: 2, capped: false });
  const big = rasterSize(10000, 10000, 2);
  assert.equal(big.capped, true);
  assert.ok(big.w * big.h <= MAX_RASTER_PIXELS + big.w, `capped near the limit: ${big.w}x${big.h}`);
  assert.equal(rasterSize(0, 0).w, 2, "zero-size canvas still yields a drawable bitmap at scale");
});

await test("BM-01 elapsed: derived from instants, hours when needed", { "BM-01": "full" }, () => {
  assert.equal(elapsedLabel(0, 65000), "01:05");
  assert.equal(elapsedLabel(0, 3661000), "1:01:01");
  assert.equal(elapsedLabel(5000, 4000), "00:00", "clock skew never shows negative time");
});

await test("AL-01 access filter: spans app/action/result", { "AL-01": "full" }, () => {
  const rows = [{ app: "files", action: "write", result: "ok" }, { app: "vault", action: "unlock", result: "denied" }];
  assert.deepEqual(filterAccess(rows, "denied").map((r) => r.app), ["vault"]);
  assert.equal(filterAccess(rows, " "), rows);
});

await test("SSH-01 term font: clamped ladder, integer steps", { "SSH-01": "full" }, () => {
  assert.equal(clampTermFont(99), 22);
  assert.equal(clampTermFont(1), 10);
  assert.equal(stepTermFont(13, 1), 14);
  assert.equal(stepTermFont(22, 1), 22, "already at the top stays");
  assert.equal(clampTermFont(Number.NaN), 13, "NaN falls back to the default size");
});

await test("CK-07 zone offsets: Intl-derived, sorted west to east, labels", { "CK-07": "full" }, () => {
  const at = new Date("2026-10-30T12:00:00Z");
  assert.equal(offsetMinutes("UTC", at), 0);
  assert.ok(offsetMinutes("Asia/Tokyo", at) > offsetMinutes("America/New_York", at), "Tokyo east of New York");
  assert.equal(sortZonesByOffset(["Asia/Tokyo", "UTC", "America/New_York"], at)[0], "America/New_York");
  assert.equal(offsetLabel(-240), "UTC−4");
  assert.equal(offsetLabel(330), "UTC+5:30");
});

await test("ED-07 match nav: next/prev with honest wrap reporting", { "ED-07": "full" }, () => {
  const offs = [10, 40, 90];
  assert.deepEqual(nextMatch(offs, 10, 1), { index: 1, wrapped: false });
  assert.deepEqual(nextMatch(offs, 90, 1), { index: 0, wrapped: true });
  assert.deepEqual(nextMatch(offs, 10, -1), { index: 2, wrapped: true });
  assert.equal(nextMatch([], 0, 1), null);
});

await test("NT-07 note tags: facets from stored lists, untagged explicit", { "NT-07": "full" }, () => {
  const notes = [{ tags: "work, ideas" }, { tags: "work" }, { tags: "" }];
  assert.deepEqual(allTags(notes), ["ideas", "work"]);
  assert.equal(filterByTag(notes, "work").length, 2);
  assert.equal(filterByTag(notes, "untagged").length, 1);
  assert.deepEqual(tagsOf({ tags: " a ,, b " }), ["a", "b"]);
});

await test("BK-11 prune plan: only dated files, keeps N newest", { "BK-11": "full" }, () => {
  const names = ["fusion-backup-20261001-0900.json", "fusion-backup-20261030-0900.json", "fusion-backup-20261020-0900.json", "random.json"];
  assert.deepEqual(prunePlan(names, 2, new Date(2026, 9, 30, 12)), ["fusion-backup-20261001-0900.json"], "oldest dated pruned; undated never eligible");
  assert.deepEqual(prunePlan(names, 9, new Date(2026, 9, 30)), []);
});

await test("TM-06 cmd history: consecutive dup collapse, cap, numbering", { "TM-06": "full" }, () => {
  let h: string[] = [];
  h = pushCommand(h, "ls"); h = pushCommand(h, "ls"); h = pushCommand(h, "pwd");
  assert.deepEqual(h, ["ls", "pwd"], "immediate repeat collapsed");
  assert.equal(pushCommand(h, "  ").length, 2, "blank not recorded");
  assert.match(historyText(h), /^ {2}1 {2}ls/);
  for (let i = 0; i < CMD_HISTORY_MAX + 5; i++) h = pushCommand(h, `cmd${i}`);
  assert.equal(h.length, CMD_HISTORY_MAX);
});

await test("CV-03 history text: chronological worked calculation", { "CV-03": "full" }, () => {
  const newestFirst = [{ expr: "6*7", text: "42" }, { expr: "1+1", text: "2" }];
  assert.equal(historyAsText(newestFirst), "1+1 = 2\n6*7 = 42");
  assert.equal(historyAsText([]), "");
});

await test("MS-05 message search: sender+text, loaded messages only", { "MS-05": "full" }, () => {
  const msgs = [{ from: "ada", text: "hello world" }, { from: "grace", text: "hello" }];
  assert.deepEqual(filterMessages(msgs, "ada").map((m) => m.from), ["ada"]);
  assert.deepEqual(filterMessages(msgs, "world").map((m) => m.from), ["ada"]);
});

await test("PH-07 undated photos: missing index date, never guessed", { "PH-07": "full" }, () => {
  const items = [{ path: "/a.png", sha256: "s1" }, { path: "/b.png", sha256: "s2" }, { path: "/c.png", sha256: "s3" }];
  const index = { s1: { capturedAt: "2026-01-01" }, s2: { capturedAt: null } };
  assert.deepEqual(undatedPhotos(items, index).map((i) => i.path), ["/b.png", "/c.png"]);
});

await test("PL-08 overdue text: open only, oldest first, whole days", { "PL-08": "full" }, () => {
  const now = new Date(2026, 9, 30, 15, 0);
  const tasks = [
    { title: "Recent", dueAt: "2026-10-29T09:00:00", done: false },
    { title: "Ancient", dueAt: "2026-10-20T09:00:00", done: false },
    { title: "Done old", dueAt: "2026-10-01T09:00:00", done: true },
    { title: "Future", dueAt: "2026-11-01T09:00:00", done: false },
  ];
  const text = overdueText(tasks, now);
  assert.ok(text.indexOf("Ancient") < text.indexOf("Recent"), "oldest first");
  assert.match(text, /10 days overdue/);
  assert.ok(!text.includes("Done old") && !text.includes("Future"));
  assert.equal(overdueText([], now), "(nothing overdue)");
});

await test("SR-12 phrase query: wrapped, embedded quotes doubled not stripped", { "SR-12": "full" }, () => {
  assert.equal(buildQuery("quarterly report", true), '"quarterly report"');
  assert.equal(buildQuery('say "hi" now', true), '"say ""hi"" now"');
  assert.equal(buildQuery("plain", false), "plain");
});

await test("DV-02 device info: absences stated, memory caveated", { "DV-02": "full" }, () => {
  const t = deviceInfoText({ ua: "UA", platform: "", cores: undefined, memory: undefined, touch: false, online: true });
  assert.match(t, /Platform: not exposed/);
  assert.match(t, /CPU cores: not exposed/);
  assert.match(deviceInfoText({ ua: "UA", platform: "Linux", cores: 2, memory: 8, touch: true, online: false }), /~8 GB \(capped by the browser\)/);
});

await test("SL-01 slide nav: 1-based clamp, garbage refused", { "SL-01": "full" }, () => {
  assert.equal(clampSlide("3", 10), 2);
  assert.equal(clampSlide("99", 10), 9);
  assert.equal(clampSlide("0", 10), 0);
  assert.equal(clampSlide("abc", 10), null);
  assert.equal(slideLabel(0, 5), "Slide 1 of 5");
});

await test("CN-09 family sort: structured N first, display-name fallback", { "CN-09": "full" }, () => {
  const cs = [{ fn: "Grace Murray", n: { family: "Murray", given: "Grace" } }, { fn: "Ada Byron", n: { family: "", given: "" } }, { fn: "Alan Turing", n: { family: "Turing", given: "Alan" } }];
  assert.equal(familyKey(cs[1]), "byron", "falls back to last word of FN");
  assert.deepEqual(sortByFamily(cs).map((c) => c.fn), ["Ada Byron", "Grace Murray", "Alan Turing"]);
});

await test("FM-19 names list: screen order, names only", { "FM-19": "full" }, () => {
  assert.equal(namesList([{ name: "b.txt" }, { name: "a.txt" }]), "b.txt\na.txt", "input order preserved (the screen sort)");
  assert.equal(namesList([]), "");
});

finish();
