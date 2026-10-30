/** TT118 — unit contract for the nine new engines. Pure: no server, no browser. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { diffLines, diffStats, diffWords } from "../src/lib/diff-core";
import { extractTags, extractWikiLinks, resolveLinks, backlinks, notesByTag } from "../src/lib/note-links";
import { buildAgenda } from "../src/lib/agenda";
import { commonWindows, validateCountdowns, daysUntil } from "../src/lib/zones";
import { convert, formatConverted } from "../src/lib/converter";
import { cleanUrl } from "../src/lib/url-clean";
import { exportSettings, parseSettingsImport } from "../src/lib/settings-io";
import { parseBackupManifest, compareManifests } from "../src/lib/backup-compare";
import { editDistance, suggest } from "../src/lib/suggest";
import { photoTimeline, largestMonth } from "../src/lib/photo-timeline";
import { validateSavedSearches } from "../src/lib/saved-searches";

const { test, finish } = makeHarness("tt118-core");

await test("DF-01 diff: line ops in order, stats, one-word change reads as one word", { "DF-01": "full" }, () => {
  const ops = diffLines("a\nb\nc", "a\nx\nc\nd");
  assert.deepEqual(ops.map((o) => `${o.kind}:${o.text}`), ["same:a", "del:b", "add:x", "same:c", "add:d"]);
  assert.deepEqual(diffStats(ops), { added: 2, removed: 1, unchanged: 2 });
  const w = diffWords("the quick brown fox", "the quick red fox");
  assert.deepEqual(w.filter((o) => o.kind !== "same").map((o) => `${o.kind}:${o.text.trim()}`), ["del:brown", "add:red"]);
  assert.deepEqual(diffLines("", ""), [{ kind: "same", text: "" }]);
  assert.throws(() => diffLines("x\n".repeat(4001), "y"), /limited/);
});

await test("NT-02 tags/links: headings and URLs are not tags, backlinks reverse exactly", { "NT-02": "full" }, () => {
  const notes = [
    { id: 1, title: "Alpha", body: "# Heading\n\nLinks to [[Beta]] and [[Beta|the second note]]. Tags #work #deep-work. See https://x.example/#frag and a#b." },
    { id: 2, title: "Beta", body: "No links here. #work" },
    { id: 3, title: "Gamma", body: "Points at [[alpha]] (lowercase title still resolves)." },
  ];
  assert.deepEqual(extractTags(notes[0].body), ["deep-work", "work"]);
  assert.deepEqual(extractWikiLinks(notes[0].body), [{ target: "Beta", label: "Beta" }, { target: "Beta", label: "the second note" }]);
  assert.deepEqual(resolveLinks(notes, notes[0]).map((l) => l.noteId), [2, 2]);
  assert.deepEqual(resolveLinks(notes, notes[0])[0].noteId, 2);
  assert.deepEqual(backlinks(notes, notes[1]).map((b) => b.id), [1]);
  assert.deepEqual(backlinks(notes, notes[0]).map((b) => b.id), [3]);
  assert.deepEqual(notesByTag(notes, "work").map((n) => n.id), [1, 2]);
});

await test("PL-03 agenda: buckets by whole local days, done and undated separated", { "PL-03": "full" }, () => {
  const now = new Date(2026, 0, 15, 9, 0); // Thu 15 Jan 2026
  const agenda = buildAgenda([
    { id: 1, title: "late", done: false, dueAt: "2026-01-14T23:59:00", kind: "task" },
    { id: 2, title: "today late", done: false, dueAt: "2026-01-15T23:59:00", kind: "task" },
    { id: 3, title: "tmr", done: false, dueAt: "2026-01-16T08:00:00", kind: "task" },
    { id: 4, title: "week", done: false, dueAt: "2026-01-20T08:00:00", kind: "task" },
    { id: 5, title: "far", done: false, dueAt: "2026-03-01T08:00:00", kind: "task" },
    { id: 6, title: "no date", done: false, dueAt: null, kind: "task" },
    { id: 7, title: "finished", done: true, dueAt: "2026-01-10T08:00:00", kind: "task" },
  ], now);
  assert.deepEqual(agenda.map((g) => [g.bucket, g.tasks.map((t) => t.id)]), [
    ["overdue", [1]], ["today", [2]], ["tomorrow", [3]], ["this week", [4]], ["later", [5]], ["undated", [6]], ["done", [7]],
  ]);
});

await test("WD-01 zone overlap: London/New_York share an afternoon; Tokyo shares none", { "WD-01": "full" }, () => {
  const day = new Date("2026-01-15T00:00:00Z"); // winter: GMT / EST
  const both = commonWindows([{ zone: "Europe/London", startHour: 9, endHour: 17 }, { zone: "America/New_York", startHour: 9, endHour: 17 }], day);
  assert.equal(both.length, 1);
  assert.equal(both[0].minutes, 180); // 14:00–17:00 UTC = 09:00–12:00 New_York
  const none = commonWindows([{ zone: "Europe/London", startHour: 9, endHour: 17 }, { zone: "Asia/Tokyo", startHour: 9, endHour: 17 }], day);
  assert.equal(none.length, 0);
  assert.throws(() => commonWindows([{ zone: "Europe/London", startHour: 17, endHour: 9 }], day), /invalid work window/);
});

await test("WD-02 countdowns: whole days, validation", { "WD-02": "full" }, () => {
  const now = new Date(2026, 0, 15, 18, 30);
  assert.equal(daysUntil({ id: "a", label: "Conf", date: "2026-01-15" }, now), 0);
  assert.equal(daysUntil({ id: "a", label: "Conf", date: "2026-02-14" }, now), 30);
  assert.equal(daysUntil({ id: "a", label: "Past", date: "2026-01-01" }, now), -14);
  assert.throws(() => validateCountdowns([{ id: "a", label: "x", date: "Jan 5" }]), /YYYY-MM-DD/);
  assert.equal(validateCountdowns([{ id: "a", label: "x", date: "2026-06-01" }]).length, 1);
});

await test("CV-01 converter: exact definitions, affine temperature, cross-category refused", { "CV-01": "full" }, () => {
  assert.equal(convert(1, "mi", "km").value, 1.609344);
  assert.equal(convert(32, "°F", "°C").value, 0);
  assert.equal(convert(100, "°C", "°F").value, 212);
  assert.equal(convert(-273.15, "°C", "K").value, 0);
  assert.equal(convert(1, "GiB", "MiB").value, 1024);
  assert.equal(convert(1, "GB", "MB").value, 1000); // decimal category kept distinct from IEC
  assert.equal(formatConverted(convert(1, "m", "mm").value), "1000");
  assert.throws(() => convert(1, "kg", "m"), /different categories/);
  assert.throws(() => convert(1, "furlong", "m"), /different categories|unknown unit/);
});

await test("UC-01 clean link: trackers listed, load-bearing params kept, non-URL refused", { "UC-01": "full" }, () => {
  const r = cleanUrl("https://shop.example/p?utm_source=news&id=42&fbclid=abc&ref=home#reviews");
  assert.equal(r.url, "https://shop.example/p?id=42&ref=home#reviews");
  assert.deepEqual(r.removed, ["utm_source", "fbclid"]);
  assert.equal(cleanUrl("https://a.example/?q=1").changed, false);
  assert.throws(() => cleanUrl("not a url"), /not a URL/);
  assert.throws(() => cleanUrl("ftp://a.example/x?utm_source=y"), /only http/);
});

await test("ST-10 settings import: unknown and locked keys reported, never applied by parsing", { "ST-10": "full" }, () => {
  const json = exportSettings({ "appearance.theme": "dark" });
  const r = parseSettingsImport(json, new Set(["appearance.theme", "perf.governor"]));
  assert.deepEqual(r.accepted, { "appearance.theme": "dark" });
  const dirty = parseSettingsImport(JSON.stringify({ kind: "fusion.settings.v1", settings: { "evil.key": "x", "system.seedVersion": "0.0.1", "appearance.theme": 42 } }),
    new Set(["appearance.theme", "system.seedVersion"]), new Set(["system.seedVersion"]));
  assert.deepEqual(dirty.unknownKeys, ["evil.key"]);
  assert.ok(dirty.invalidValues.some((v) => v.includes("locked")));
  assert.ok(dirty.invalidValues.includes("appearance.theme")); // non-string value refused
  assert.deepEqual(dirty.accepted, {});
});

await test("BK-06 backup compare: added/removed/changed/unchanged and byte delta", { "BK-06": "full" }, () => {
  const h = (c: string) => c.repeat(64);
  const before = parseBackupManifest(JSON.stringify({ entries: [
    { path: "/a.txt", bytes: 10, sha256: h("a") }, { path: "/b.txt", bytes: 20, sha256: h("b") }, { path: "/c.txt", bytes: 30, sha256: h("c") }] }));
  const after = parseBackupManifest(JSON.stringify({ entries: [
    { path: "/a.txt", bytes: 10, sha256: h("a") }, { path: "/b.txt", bytes: 25, sha256: h("d") }, { path: "/d.txt", bytes: 5, sha256: h("e") }] }));
  const diff = compareManifests(before, after);
  assert.deepEqual(diff.added, ["/d.txt"]); assert.deepEqual(diff.removed, ["/c.txt"]);
  assert.equal(diff.changed.length, 1); assert.equal(diff.changed[0].path, "/b.txt");
  assert.equal(diff.unchanged, 1); assert.equal(diff.bytesDelta, 40 - 60);
  assert.throws(() => parseBackupManifest(JSON.stringify({ entries: [{ path: "rel.txt", bytes: 1, sha256: h("a") }] })), /invalid/);
});

await test("TM-02 suggestion: transposition costs one, short inputs get nothing", { "TM-02": "full" }, () => {
  assert.equal(editDistance("hlep", "help"), 1);
  assert.equal(editDistance("cat", "dog"), 3);
  assert.deepEqual(suggest("hlep", ["help", "ls", "cd", "open"]), ["help"]);
  assert.deepEqual(suggest("opne", ["open", "close", "tile"]), ["open"]);
  assert.deepEqual(suggest("ls", ["ls", "cd"]), []); // exact handled by caller; <3 chars: no confident guess
  assert.deepEqual(suggest("xyzqq", ["help", "open"]), []);
});

await test("PH-02 photo timeline: local months, undated counted, largest month by bytes", { "PH-02": "full" }, () => {
  const items = [
    { path: "/a.jpg", mime: "image/jpeg", size: 100, date: "2026-01-05T10:00:00" },
    { path: "/b.jpg", mime: "image/jpeg", size: 300, date: "2026-01-20T10:00:00" },
    { path: "/c.jpg", mime: "image/jpeg", size: 50, date: "2025-12-31T23:00:00" },
    { path: "/d.jpg", mime: "image/jpeg", size: 70, date: null },
  ];
  const t = photoTimeline(items);
  assert.deepEqual(t.groups.map((g) => [g.month, g.count, g.bytes]), [["2026-01", 2, 400], ["2025-12", 1, 50]]);
  assert.deepEqual(t.undated, { count: 1, bytes: 70 });
  assert.equal(largestMonth(items)!.month, "2026-01");
  assert.equal(photoTimeline([]).spanMonths, 0);
});

await test("SV-01 saved searches: modes validated, duplicate names refused, sorted newest first", { "SV-01": "full" }, () => {
  const ok = validateSavedSearches([
    { id: "s1", name: "Old", q: "a", scope: "", mode: "text", savedAt: 1 },
    { id: "s2", name: "New", q: "b", scope: "/Private", mode: "metadata", savedAt: 2 },
  ]);
  assert.deepEqual(ok.map((s) => s.name), ["New", "Old"]);
  assert.throws(() => validateSavedSearches([{ id: "s1", name: "X", q: "", scope: "", mode: "semantic", savedAt: 0 }]), /not a Find mode/);
  assert.throws(() => validateSavedSearches([
    { id: "s1", name: "Dup", q: "", scope: "", mode: "text", savedAt: 0 },
    { id: "s2", name: "DUP", q: "", scope: "", mode: "text", savedAt: 0 },
  ]), /unique/);
});
finish();
