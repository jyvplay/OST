/** TT122 — unit contract for the twenty new engines. Pure: no server, no browser. */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { fileFacts } from "../src/lib/file-facts";
import { snapDelay, delayLabel } from "../src/lib/capture-delay";
import { batteryPercent, batteryLabel } from "../src/lib/battery-status";
import { sortJobs } from "../src/lib/job-sort";
import { filterRoutines } from "../src/lib/routine-filter";
import { filterEntries } from "../src/lib/archive-filter";
import { facingConstraint, facingLabel } from "../src/lib/camera-facing";
import { wrapStyle, readWrap, WRAP_KEY } from "../src/lib/editor-wrap";
import { lapsText } from "../src/lib/laps-text";
import { notesBundle } from "../src/lib/notes-bundle";
import { contactCardFile } from "../src/lib/contact-card";
import { backupInventory } from "../src/lib/backup-inventory";
import { loopLabel, nextLoop } from "../src/lib/loop-pref";
import { reclaimSummary } from "../src/lib/reclaim-summary";
import { familyProgress } from "../src/lib/family-progress";
import { sortApps } from "../src/lib/app-sort";
import { libraryStats } from "../src/lib/library-stats";
import { shuffleOrder, isShuffledOrder } from "../src/lib/shuffle-order";
import { completionStats } from "../src/lib/completion-stats";
import { syncSummary } from "../src/lib/sync-summary";

const { test, finish } = makeHarness("tt122-core");

await test("PK-01 file facts: text counted with wc rules, binary never invents lines", { "PK-01": "full" }, () => {
  const t = fileFacts({ path: "/a.txt", mime: "text/plain", size: 11, encoding: "utf8", content: "one two\nthree\n", sha256: "abcdef0123456789" });
  assert.deepEqual([t.kind, t.lines, t.words, t.shortSha], ["text", 2, 3, "abcdef012345"]);
  const b = fileFacts({ path: "/a.png", mime: "image/png", size: 99, encoding: "base64" });
  assert.deepEqual([b.kind, b.lines, b.shortSha], ["binary", null, null]);
});

await test("CP-01 capture delay: ladder snapped, labels honest", { "CP-01": "full" }, () => {
  assert.equal(snapDelay(3), 3);
  assert.equal(snapDelay(7), 0, "unsupported delay falls back to immediate, never a surprise wait");
  assert.equal(delayLabel(0), "now");
  assert.equal(delayLabel(10), "10s");
});

await test("DV-01 battery: clamped percent, unknown times stated", { "DV-01": "full" }, () => {
  assert.equal(batteryPercent({ level: 1.4, charging: false, chargingTime: 0, dischargingTime: 0 }), 100, "level clamped");
  assert.match(batteryLabel({ level: 0.5, charging: false, chargingTime: Infinity, dischargingTime: Infinity }), /50% · on battery \(time unknown\)/);
  assert.match(batteryLabel({ level: 0.5, charging: false, chargingTime: 0, dischargingTime: 3660 }), /~1h 01m/);
  assert.match(batteryLabel({ level: 0.9, charging: true, chargingTime: 600, dischargingTime: 0 }), /full ~10 min/);
});

await test("MN-01 job sort: copies, three orders", { "MN-01": "full" }, () => {
  const jobs = [{ at: "2026-01-02", op: "write" }, { at: "2026-01-03", op: "delete" }, { at: "2026-01-01", op: "write" }];
  assert.deepEqual(sortJobs(jobs, "newest").map((j) => j.at), ["2026-01-03", "2026-01-02", "2026-01-01"]);
  assert.deepEqual(sortJobs(jobs, "oldest").map((j) => j.at), ["2026-01-01", "2026-01-02", "2026-01-03"]);
  assert.deepEqual(sortJobs(jobs, "op").map((j) => j.op), ["delete", "write", "write"]);
  assert.equal(jobs[0].at, "2026-01-02", "input untouched");
});

await test("RT-02 routine filter: name+actions, order preserved", { "RT-02": "full" }, () => {
  const rs = [{ name: "Morning", actions: "open notes" }, { name: "Backup night", actions: "export" }, { name: "Focus", actions: "open planner" }];
  assert.deepEqual(filterRoutines(rs, "open").map((r) => r.name), ["Morning", "Focus"]);
  assert.equal(filterRoutines(rs, "  "), rs, "blank query is identity");
});

await test("AR-01 archive filter: name match keeps folder context", { "AR-01": "full" }, () => {
  const es = [{ name: "docs/", dir: true }, { name: "docs/report.txt" }, { name: "img.png" }];
  assert.deepEqual(filterEntries(es, "report").map((e) => e.name), ["docs/", "docs/report.txt"], "parent folder kept as context");
  assert.equal(filterEntries(es, "").length, 3);
});

await test("LN-16 facing: auto omits the constraint entirely", { "LN-16": "full" }, () => {
  assert.deepEqual(facingConstraint("auto"), {}, "no facingMode key passed for browser default");
  assert.deepEqual(facingConstraint("environment"), { facingMode: { ideal: "environment" } });
  assert.equal(facingLabel("user"), "front camera");
});

await test("ED-06 wrap: style pair consistent, storage read guarded", { "ED-06": "full" }, () => {
  assert.deepEqual(wrapStyle(true), { whiteSpace: "pre-wrap", overflowX: "hidden" });
  assert.deepEqual(wrapStyle(false), { whiteSpace: "pre", overflowX: "auto" });
  assert.equal(readWrap({ getItem: (k) => (k === WRAP_KEY ? "1" : null) }), true);
  assert.equal(readWrap({ getItem: () => { throw new Error("denied"); } }), false, "storage refusal reads as off");
});

await test("CK-06 laps text: splits from cumulative, fastest marked", { "CK-06": "full" }, () => {
  const t = lapsText([60000, 150000, 200000]);
  assert.match(t, /lap 1: 1:00\.000/);
  assert.match(t, /lap 3: 0:50\.000 \(fastest\)/);
  assert.equal(lapsText([]), "(no laps)");
});

await test("NT-06 notes bundle: title order, solo-export rendering reused", { "NT-06": "full" }, () => {
  const out = notesBundle([{ title: "Zeta", body: "z" }, { title: "alpha", body: "a" }], new Date("2026-10-30T00:00:00Z"));
  assert.ok(out.indexOf("alpha") < out.indexOf("Zeta"), "alphabetical regardless of input order");
  assert.match(out, /2 notes/);
  assert.match(notesBundle([], new Date()), /\(no notes\)/);
});

await test("CN-08 contact card: slug filename, serializer round-trips", { "CN-08": "full" }, async () => {
  const { parseVcf, emptyContact } = await import("../src/lib/contacts-core");
  const c = emptyContact("u1");
  c.fn = "Ada Byron";
  c.n = { ...c.n, given: "Ada", family: "Byron" };
  c.emails = [{ value: "ada@example.com", types: ["home"] }];
  const f = contactCardFile(c);
  assert.equal(f.filename, "ada-byron.vcf");
  const back = parseVcf(f.text);
  assert.equal(back.contacts.length, 1, "the single card parses back as one contact");
  assert.equal(back.contacts[0].fn, "Ada Byron");
});

await test("BK-10 backup inventory: dated sorted newest-first, undated unknown", { "BK-10": "full" }, () => {
  const inv = backupInventory(["fusion-backup-20261001-0900.json", "random.json", "fusion-backup-20261030-0900.json"], new Date(2026, 9, 30, 12, 0));
  assert.equal(inv[0].name, "fusion-backup-20261030-0900.json");
  assert.equal(inv[0].freshness, "fresh");
  assert.equal(inv.find((e) => e.name === "random.json")?.freshness, "unknown", "undated file is never guessed fresh");
  assert.equal(inv[1].freshness, "stale", "29-day-old backup is stale");
});

await test("MD-11 loop: label states state, toggle flips", { "MD-11": "full" }, () => {
  assert.equal(loopLabel(true), "loop on");
  assert.equal(nextLoop(true), false);
  assert.equal(nextLoop(nextLoop(true)), true);
});

await test("ST-11 reclaim summary: only real duplicate groups count", { "ST-11": "full" }, () => {
  assert.deepEqual(reclaimSummary([{ copies: 3, reclaimable: 200 }, { copies: 1, reclaimable: 50 }, { copies: 2, reclaimable: 100 }]), { groups: 2, copies: 5, bytes: 300 }, "single-copy groups excluded");
  assert.deepEqual(reclaimSummary([]), { groups: 0, copies: 0, bytes: 0 });
});

await test("SP-02 family progress: built share per family, sorted", { "SP-02": "full" }, () => {
  const rows = [{ family: "A", status: "built" }, { family: "A", status: "partial" }, { family: "B", status: "built" }, { family: "B", status: "built" }];
  const out = familyProgress(rows);
  assert.deepEqual(out.map((f) => [f.family, f.pct]), [["B", 100], ["A", 50]]);
  assert.deepEqual(familyProgress([]), []);
});

await test("AP-07 app sort: registry group order, alpha within group", { "AP-07": "full" }, () => {
  const apps = [{ title: "Writer", group: "Create" }, { title: "Files", group: "Core" }, { title: "Editor", group: "Create" }];
  assert.deepEqual(sortApps(apps, "group", ["Core", "Create"]).map((a) => a.title), ["Files", "Editor", "Writer"]);
  assert.deepEqual(sortApps(apps, "title", ["Core", "Create"]).map((a) => a.title), ["Editor", "Files", "Writer"]);
  assert.equal(apps[0].title, "Writer", "input untouched");
});

await test("MU-05 library stats: per-kind counts from the shared library", { "MU-05": "full" }, () => {
  const items = [{ kind: "audio", provider: "spotify" }, { kind: "audio", provider: "soundcloud" }, { kind: "video", provider: "yt" }];
  assert.equal(libraryStats(items, "audio"), "2 saved · 2 providers");
  assert.equal(libraryStats(items, "video"), "1 saved · 1 provider");
  assert.equal(libraryStats([], "audio"), "library empty");
});

await test("PH-06 shuffle: permutation, seeded determinism, identity detection", { "PH-06": "full" }, () => {
  let i = 0; const rng = () => { i = (i + 0.61) % 1; return i; };
  const a = shuffleOrder(8, rng);
  assert.deepEqual([...a].sort((x, y) => x - y), [0, 1, 2, 3, 4, 5, 6, 7], "a true permutation");
  i = 0; assert.deepEqual(shuffleOrder(8, rng), a, "same seed, same order");
  assert.equal(isShuffledOrder([0, 1, 2]), false);
  assert.equal(isShuffledOrder(a), true);
  assert.deepEqual(shuffleOrder(0, rng), []);
});

await test("PL-07 completion stats: today/week windows, undated kept separate", { "PL-07": "full" }, () => {
  const now = new Date(2026, 9, 30, 15, 0); // Friday 2026-10-30
  const tasks = [
    { done: true, dueAt: "2026-10-30T09:00:00" },
    { done: true, dueAt: "2026-10-26T09:00:00" }, // Monday same week
    { done: true, dueAt: "2026-10-25T09:00:00" }, // Sunday, previous week
    { done: true, dueAt: null },
    { done: false, dueAt: "2026-10-30T09:00:00" },
  ];
  assert.deepEqual(completionStats(tasks, now), { today: 1, week: 2, undated: 1 });
});

await test("LD-01 sync summary: conflicts never read as clean", { "LD-01": "full" }, () => {
  assert.equal(syncSummary(null), "not synced yet in this window");
  assert.match(syncSummary({ pushed: 1, pulled: 2, conflicts: 1, at: "2026-10-30T10:00:00" }), /1 conflict need review/);
  assert.match(syncSummary({ pushed: 0, pulled: 0, conflicts: 0, at: "2026-10-30T10:00:00" }), /already up to date/);
  assert.match(syncSummary({ pushed: 3, pulled: 0, conflicts: 0, at: "2026-10-30T10:00:00" }), /no conflicts/);
});

finish();
