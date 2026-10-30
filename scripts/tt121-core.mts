/** TT121 — unit contract for the twenty new engines. Pure: no server, no browser. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { MEM_EMPTY, memAdd, memSub, memStore, memClear, memRecall } from "../src/lib/calc-memory";
import { transformLines } from "../src/lib/line-ops";
import { TIMER_PRESETS, presetBySeconds } from "../src/lib/timer-presets";
import { snapRate, rateLabel } from "../src/lib/playback-rate";
import { strengthBits, strengthLabel, generatePassphrase } from "../src/lib/passphrase";
import { unreadCount, filterAlerts } from "../src/lib/alert-filter";
import { clipKindOf, filterByKind } from "../src/lib/clip-kind";
import { formatDecimal, formatDMS } from "../src/lib/coord-format";
import { bookProgress, chapterLabel } from "../src/lib/book-progress";
import { stepZoom, clampZoom, zoomLabel, MIN_ZOOM, MAX_ZOOM } from "../src/lib/zoom-step";
import { agendaText } from "../src/lib/agenda-text";
import { resultsText } from "../src/lib/result-filter";
import { sortLibrary } from "../src/lib/library-sort";
import { sortPhotos } from "../src/lib/photo-sort";
import { filterContacts } from "../src/lib/contact-filter";
import { backupFilename, parseBackupDate } from "../src/lib/backup-name";
import { sortText, uniqText } from "../src/lib/text-sort";
import { sortNotes } from "../src/lib/note-sort";
import { filterApps, appGroups } from "../src/lib/app-filter";

const { test, finish } = makeHarness("tt121-core");

await test("CV-02 calculator memory: register transitions, NaN refused", { "CV-02": "full" }, () => {
  assert.equal(memRecall(MEM_EMPTY), null, "empty register recalls nothing, not 0");
  const m = memAdd(memStore(10), 5);
  assert.equal(memRecall(m), 15);
  assert.equal(memRecall(memSub(m, 20)), -5);
  assert.equal(memRecall(memClear()), null);
  assert.equal(memAdd(m, Number.NaN), m, "NaN add is refused, register unchanged");
  assert.equal(memStore(Number.POSITIVE_INFINITY).has, false);
});

await test("ED-05 line ops: sort/dedupe keep termination, natural order", { "ED-05": "full" }, () => {
  assert.equal(transformLines("b10\nb2\na\n", {}), "a\nb2\nb10\n", "natural numeric order, trailing newline kept");
  assert.equal(transformLines("x\nx\ny", { dedupe: true }), "x\ny", "no phantom trailing newline added");
  assert.equal(transformLines("a  \nb\t\n", { trimTrailing: true }), "a\nb\n");
  assert.equal(transformLines("", {}), "");
  assert.equal(transformLines("b\na", { desc: true }), "b\na");
});

await test("CK-05 timer presets: fixed ladder, lookup exact", { "CK-05": "full" }, () => {
  assert.deepEqual(TIMER_PRESETS.map((p) => p.seconds), [60, 300, 600, 1500, 2700, 3600]);
  assert.equal(presetBySeconds(1500)?.label, "25m");
  assert.equal(presetBySeconds(42), null, "non-preset duration has no label");
});

await test("MD-10 playback rate: snapped to the portable ladder", { "MD-10": "full" }, () => {
  assert.equal(snapRate(1.3), 1.25);
  assert.equal(snapRate(99), 2, "clamped to the fastest offered rate");
  assert.equal(snapRate(0), 1, "zero/NaN fall back to normal speed");
  assert.equal(snapRate(Number.NaN), 1);
  assert.equal(rateLabel(1.5), "1.5×");
});

await test("SC-19 passphrase: strength is pool-based, generator deterministic under injected RNG", { "SC-19": "full" }, () => {
  assert.equal(strengthBits(""), 0);
  assert.ok(strengthBits("correct horse battery staple") > strengthBits("aaaa"), "varied pools beat repeats");
  assert.ok(strengthBits("aaaaaaaa") < strengthBits("abcdefgh"), "repeat runs are discounted");
  assert.equal(strengthLabel(10), "weak");
  assert.equal(strengthLabel(200), "excellent");
  let i = 0; const rng = () => { i = (i + 0.37) % 1; return i; };
  const a = generatePassphrase(rng, 4);
  i = 0; const b = generatePassphrase(rng, 4);
  assert.equal(a, b, "same RNG stream, same passphrase");
  assert.equal(a.split("-").length, 5, "4 words + numeric suffix");
});

await test("NC-07 alert facets: unread count derived, unread-only + query compose", { "NC-07": "full" }, () => {
  const rows = [
    { read: false, title: "Build done", body: "", app: "monitor" },
    { read: true, title: "Backup", body: "ok", app: "backup" },
    { read: false, title: "Backup failed", body: "", app: "backup" },
  ];
  assert.equal(unreadCount(rows), 2);
  assert.deepEqual(filterAlerts(rows, { unreadOnly: true }).map((r) => r.title), ["Build done", "Backup failed"]);
  assert.deepEqual(filterAlerts(rows, { q: "backup" }).map((r) => r.title), ["Backup", "Backup failed"]);
  assert.equal(filterAlerts(rows, { unreadOnly: true, q: "monitor" }).length, 1);
});

await test("CB-02 clip kinds: whole-entry classification only", { "CB-02": "full" }, () => {
  assert.equal(clipKindOf("https://example.com/x"), "link");
  assert.equal(clipKindOf("see https://example.com for details"), "text", "a sentence containing a link stays text");
  assert.equal(clipKindOf("ada@example.com"), "email");
  assert.equal(clipKindOf("const x = 1;\nlet y = 2;"), "code");
  assert.equal(clipKindOf("hello world"), "text");
  const items = [{ text: "https://a.dev" }, { text: "plain" }, { text: "b@c.d" }];
  assert.deepEqual(filterByKind(items, "email").map((i) => i.text), ["b@c.d"]);
  assert.equal(filterByKind(items, "all").length, 3);
});

await test("MP-09 coordinates: decimal interchange + unambiguous DMS", { "MP-09": "full" }, () => {
  assert.equal(formatDecimal(41.49932, -81.6943605), "41.499320, -81.694360");
  const dms = formatDMS(-33.8688, 151.2093);
  assert.ok(dms.includes("S") && dms.includes("E"), `hemispheres carried: ${dms}`);
  assert.ok(formatDMS(0, 0).startsWith("0°0′0″N"), "zero is N/E, never blank");
});

await test("EB-01 book progress: clamped, smooth, chapter label honest", { "EB-01": "full" }, () => {
  assert.equal(bookProgress(0, 10), 0);
  assert.equal(bookProgress(9, 10), 90);
  assert.equal(bookProgress(99, 10), 90, "stale past-end index clamps to last chapter start");
  assert.equal(bookProgress(9, 10, 1), 100);
  assert.equal(bookProgress(0, 0), 0, "empty spine is 0%, not NaN");
  assert.equal(chapterLabel(2, 12), "Chapter 3 of 12");
});

await test("PD-01/WB-06 zoom ladder: steps snap, ends clamp, label rounds", { "PD-01": "full", "WB-06": "full" }, () => {
  assert.equal(stepZoom(1, 1), 1.25);
  assert.equal(stepZoom(1.1, 1), 1.25, "free zoom steps up to the next rung");
  assert.equal(stepZoom(1.1, -1), 1);
  assert.equal(stepZoom(MAX_ZOOM, 1), MAX_ZOOM);
  assert.equal(stepZoom(MIN_ZOOM, -1), MIN_ZOOM);
  assert.equal(clampZoom(100), MAX_ZOOM);
  assert.equal(zoomLabel(1.5), "150%");
});

await test("PL-06 agenda text: day-scoped, sorted, done marked not dropped", { "PL-06": "full" }, () => {
  const day = new Date(2026, 9, 30, 12, 0);
  const text = agendaText([
    { title: "Later", due: "2026-10-30T15:00:00", done: false },
    { title: "Early", due: "2026-10-30T09:00:00", done: true },
    { title: "Tomorrow", due: "2026-10-31T09:00:00", done: false },
    { title: "Someday", due: null, done: false },
  ], day);
  const lines = text.split("\n");
  assert.ok(lines[1].startsWith("✓"), "done task marked");
  assert.ok(lines[2].includes("Later"), "sorted by time");
  assert.ok(!text.includes("Tomorrow") && !text.includes("Someday"), "other days and undated excluded");
  assert.ok(agendaText([], day).includes("(no tasks due)"));
});

await test("SR-11 results as text: one line per hit, snippets excluded", { "SR-11": "full" }, () => {
  const hits = [
    { title: "Notes", ref: "/Documents/notes.md", source: "file", snippet: "quarterly" },
    { title: "Budget", ref: "/Documents/budget.csv", source: "file", snippet: "taxes" },
  ];
  assert.equal(resultsText(hits), "Notes [file] /Documents/notes.md\nBudget [file] /Documents/budget.csv");
  assert.equal(resultsText([]), "", "no hits, no stray newline");
});

await test("MU-04 library sort: stable, added order untouched", { "MU-04": "full" }, () => {
  const items = [
    { title: "beta", provider: "soundcloud" },
    { title: "Alpha", provider: "spotify" },
    { title: "alpha", provider: "archive" },
  ];
  assert.deepEqual(sortLibrary(items, "added").map((i) => i.title), ["beta", "Alpha", "alpha"]);
  assert.deepEqual(sortLibrary(items, "title").map((i) => i.title), ["Alpha", "alpha", "beta"], "equal titles keep stored order");
  assert.deepEqual(sortLibrary(items, "provider").map((i) => i.provider), ["archive", "soundcloud", "spotify"]);
  assert.deepEqual(items.map((i) => i.title), ["beta", "Alpha", "alpha"], "input not mutated");
});

await test("PH-05 photo sort: name/size/date, missing values last ascending, copy sorted", { "PH-05": "full" }, () => {
  const items = [
    { path: "/Pictures/b.png", size: 300, capturedAt: "2026-01-02" },
    { path: "/Pictures/a.png", size: 100, capturedAt: "2026-01-03" },
    { path: "/Pictures/c.png", capturedAt: "2026-01-01" },
  ];
  assert.deepEqual(sortPhotos(items, "name").map((p) => p.path), ["/Pictures/a.png", "/Pictures/b.png", "/Pictures/c.png"]);
  assert.deepEqual(sortPhotos(items, "size").map((p) => p.size ?? -1), [100, 300, -1], "unknown size sorts last ascending");
  assert.deepEqual(sortPhotos(items, "size", true).map((p) => p.size ?? -1), [300, 100, -1], "descending puts unknown last");
  assert.equal(items[0].path, "/Pictures/b.png", "input order preserved");
});

await test("CN-07 contact facets: blank vCard fields do not count as present", { "CN-07": "full" }, () => {
  const cs = [
    { emails: ["ada@example.com"], phones: [] },
    { emails: [""], phones: ["+1 555"] },
    { emails: [], phones: [] },
  ];
  assert.equal(filterContacts(cs, "email").length, 1, "empty-string email is absent");
  assert.equal(filterContacts(cs, "phone").length, 1);
  assert.equal(filterContacts(cs, "noEmail").length, 2);
  assert.equal(filterContacts(cs, "all").length, 3);
});

await test("BK-09 backup filename: local date, strict round-trip", { "BK-09": "full" }, () => {
  const d = new Date(2026, 9, 30, 9, 5);
  assert.equal(backupFilename(d), "fusion-backup-20261030-0905.json");
  assert.equal(parseBackupDate("fusion-backup-20261030-0905.json")?.getTime(), d.getTime());
  assert.equal(parseBackupDate("fusion-backup-final.json"), null, "renamed files are not dated backups");
  assert.equal(parseBackupDate("other-20261030-0905.json"), null);
});

await test("TM-05 terminal sort/uniq: numeric mode, adjacent vs global uniq", { "TM-05": "full" }, () => {
  assert.equal(sortText("10\n2\n1\n", { numeric: true }), "1\n2\n10\n", "numeric, not lexicographic");
  assert.equal(sortText("b\na\n", {}), "a\nb\n");
  assert.equal(sortText("a\na\nb\na\n", { unique: true }), "a\nb\n", "sorted lines dedupe fully after sorting");
  assert.equal(uniqText("a\na\nb\na\n"), "a\nb\na\n", "uniq alone removes only adjacent runs");
  assert.equal(uniqText("a\na\nb\na\n", true), "a\nb\n", "global dedupe removes all repeats");
});

await test("NT-05 note sort: pinned lead, title case-insensitive, updated newest first", { "NT-05": "full" }, () => {
  const notes = [
    { id: 1, title: "banana", updatedAt: "2026-01-01", pinned: false },
    { id: 2, title: "Apple", updatedAt: "2026-01-03", pinned: false },
    { id: 3, title: "cherry", updatedAt: "2026-01-02", pinned: true },
  ];
  assert.deepEqual(sortNotes(notes, "title").map((n) => n.title), ["cherry", "Apple", "banana"], "pinned first even in title sort");
  assert.deepEqual(sortNotes(notes, "updated").map((n) => n.id), [3, 2, 1]);
});

await test("AP-06 app filter: group facet exact, query spans title+group+summary", { "AP-06": "full" }, () => {
  const apps = [
    { title: "Writer", group: "Create", summary: "documents" },
    { title: "Files", group: "Core", summary: "documents and folders" },
    { title: "Cream", group: "Core" },
  ];
  assert.deepEqual(filterApps(apps, "", "Create").map((a) => a.title), ["Writer"]);
  assert.deepEqual(filterApps(apps, "documents").map((a) => a.title), ["Writer", "Files"], "summary is searchable");
  assert.deepEqual(filterApps(apps, "cre").map((a) => a.title), ["Writer", "Cream"], "query matches group too");
  assert.deepEqual(appGroups(apps), ["Core", "Create"]);
});

finish();
