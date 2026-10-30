/** TT120 — unit contract for the ten new engines. Pure: no server, no browser. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { clampLine, offsetAtLine, totalLines, docStats } from "../src/lib/line-nav";
import { noteFilename, noteToMarkdown } from "../src/lib/note-export";
import { presetDue, presetLabel } from "../src/lib/due-presets";
import { zoneStatus } from "../src/lib/zone-status";
import { headLines, tailLines, parseCountArg } from "../src/lib/text-slice";
import { backupAge, freshnessLabel, STALE_DAYS } from "../src/lib/backup-freshness";
import { groupBySource, sourceSummary } from "../src/lib/result-groups";
import { neighbor, positionLabel } from "../src/lib/photo-order";
import { providersOf, filterByProvider } from "../src/lib/provider-filter";
import { validateStars, toggleStar } from "../src/lib/contact-stars";

const { test, finish } = makeHarness("tt120-core");

await test("ED-04 line nav + stats: clamped, wc-consistent", { "ED-04": "full" }, () => {
  const text = "one\ntwo\nthree";
  assert.equal(clampLine(99, text), 3, "past-the-end clamps to the last line");
  assert.equal(clampLine(0, text), 1);
  assert.equal(offsetAtLine(text, 3), 8);
  assert.equal(totalLines(text), 3);
  const st = docStats("alpha beta\ngamma");
  assert.deepEqual([st.lines, st.words, st.bytes], [2, 3, 16]);
  assert.equal(st.readingMinutes, 1);
  assert.equal(docStats("").readingMinutes, 0, "empty is 0 minutes, not a rounded-up 1");
});

await test("NT-04 note export: filename cannot escape, front-matter stands alone", { "NT-04": "full" }, () => {
  assert.equal(noteFilename("../../etc/passwd"), "etc passwd.md");
  assert.equal(noteFilename(""), "untitled.md");
  assert.equal(noteFilename("A/B: C?"), "A B C.md");
  const md = noteToMarkdown({ title: "Trip", body: "packed", tags: "a, b,, " }, new Date("2026-10-30T00:00:00Z"));
  assert.match(md, /^---\ntitle: Trip\nexported: 2026-10-30/);
  assert.match(md, /tags: a, b/);
  assert.ok(md.endsWith("packed\n"));
});

await test("PL-05 due presets: local end-of-day, +1/+7 days", { "PL-05": "full" }, () => {
  const now = new Date(2026, 9, 30, 9, 15);
  const today = presetDue("today", now)!;
  assert.deepEqual([today.getDate(), today.getHours(), today.getMinutes()], [30, 23, 59]);
  assert.equal(presetDue("tomorrow", now)!.getDate(), 31);
  assert.equal(presetDue("next-week", now)!.getDate(), 6, "Oct 30 + 7 days crosses into Nov 6");
  assert.equal(presetDue("none", now), null);
  assert.match(presetLabel("tomorrow", now), /Tomorrow · .*Oct 31/);
});

await test("WD-04 zone status: weekday 09-17 open, weekend closed", { "WD-04": "full" }, () => {
  // 2026-10-30 is a Friday; 14:00 UTC = 14:00 London (GMT) → open; 03:00 UTC → closed.
  assert.equal(zoneStatus("Europe/London", new Date("2026-10-30T14:00:00Z")).open, true);
  assert.equal(zoneStatus("Europe/London", new Date("2026-10-30T03:00:00Z")).open, false);
  // Saturday 2026-10-31 14:00 UTC → closed even at 14:00.
  assert.equal(zoneStatus("Europe/London", new Date("2026-10-31T14:00:00Z")).open, false);
  assert.match(zoneStatus("Europe/London", new Date("2026-10-30T14:00:00Z")).localTime, /Fri 14:00/);
});

await test("TM-04 head/tail: whole file when short, -n parsing", { "TM-04": "full" }, () => {
  const text = "a\nb\nc\n";
  assert.deepEqual(headLines(text, 2), ["a", "b"]);
  assert.deepEqual(tailLines(text, 2), ["b", "c"]);
  assert.deepEqual(tailLines(text, 99), ["a", "b", "c"], "no phantom empty line from the trailing newline");
  assert.deepEqual(parseCountArg(["-n", "5", "f.txt"]), { n: 5, file: "f.txt" });
  assert.deepEqual(parseCountArg(["-3", "f.txt"]), { n: 3, file: "f.txt" });
  assert.deepEqual(parseCountArg(["f.txt"]), { n: 10, file: "f.txt" });
});

await test("BK-08 freshness: never/fresh/stale against the stated threshold", { "BK-08": "full" }, () => {
  const now = Date.parse("2026-10-30T00:00:00Z");
  assert.equal(backupAge(null, now).state, "never");
  assert.equal(backupAge(now - 2 * 86_400_000, now).state, "fresh");
  assert.equal(backupAge(now - STALE_DAYS * 86_400_000, now).state, "stale");
  assert.match(freshnessLabel(null, now), /No backup built yet/);
  assert.match(freshnessLabel(now - 9 * 86_400_000, now), /9 days ago — older than 7 days/);
});

await test("SR-10 result groups: first-seen order, counts", { "SR-10": "full" }, () => {
  const hits = [{ source: "file", ref: "a" }, { source: "note", ref: "b" }, { source: "file", ref: "c" }];
  assert.deepEqual(groupBySource(hits).map((g) => [g.source, g.hits.length]), [["file", 2], ["note", 1]]);
  assert.equal(sourceSummary(hits), "2 file · 1 note");
});

await test("PH-04 photo neighbours: no silent wrap at the boundary", { "PH-04": "full" }, () => {
  const shown = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
  assert.equal(neighbor(shown, "/b", 1)?.item.path, "/c");
  assert.equal(neighbor(shown, "/c", 1), null, "last photo + next is a boundary, not a loop");
  assert.equal(neighbor(shown, "/a", -1), null);
  assert.equal(positionLabel(shown, "/b"), "2 of 3");
  assert.equal(neighbor(shown, "/missing", 1), null);
});

await test("MU-03 provider facet: counts, all explicit, unknown matches nothing", { "MU-03": "full" }, () => {
  const items = [{ id: "1", provider: "youtube" }, { id: "2", provider: "vimeo" }, { id: "3", provider: "youtube" }];
  assert.deepEqual(providersOf(items), [{ provider: "youtube", count: 2 }, { provider: "vimeo", count: 1 }]);
  assert.equal(filterByProvider(items, "all").length, 3);
  assert.deepEqual(filterByProvider(items, "youtube").map((i) => i.id), ["1", "3"]);
  assert.equal(filterByProvider(items, "bogus").length, 0, "a typo'd facet is empty, not everything");
});

await test("CN-06 stars: validated set, toggle round-trips", { "CN-06": "full" }, () => {
  const s = validateStars(["u1", "", 7, "u2", null]);
  assert.deepEqual([...s].sort(), ["u1", "u2"]);
  assert.equal(toggleStar(s, "u1").has("u1"), false);
  assert.equal(toggleStar(s, "u3").has("u3"), true);
  assert.equal(validateStars("nope").size, 0);
});

finish();
