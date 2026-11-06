/**
 * TT135 pure-suite: batch rename (FM-03), trash retention (FM-11), downloads (PR-07m).
 */
import { makeHarness } from "./harness.mts";
import { expandPattern, planBatchRename, applyOrder, RENAME_LIMIT } from "../src/lib/files/batch-rename.ts";
import { planTrashPurge, describePurge, TRASH_PLAN_LIMIT } from "../src/lib/trash-retention.ts";
import { createEntry, start, progress, fail, complete, cancel, nameFromUrl, uniqueName, planRetry, summary, sortQueue, nextToStart, DOWNLOAD_MAX_BYTES } from "../src/lib/downloads.ts";
import { check, boundedRead, stream, normalizePath, normalizeFolder, isInside, describeGrant, describeGrantSummary } from "../src/lib/files/permissions.ts";
import { parsePlaylist, advanceIndex, streamStat, describePlaylist } from "../src/lib/m3u8.ts";

const { test, finish } = makeHarness("tt135-files-engines");

// ── Batch rename (FM-03) ──────────────────────────────────────────────────────
await test("FM-03 · simple pattern replaces {name}", { CODE: "FM-03" }, () => {
  const out = expandPattern("doc-{name}.{ext}", "report.pdf", 0, new Date("2026-01-01T00:00:00Z"));
  if (out !== "doc-report.pdf") throw new Error(`expected doc-report.pdf, got ${out}`);
});

await test("FM-03 · {n} pads to two digits", { CODE: "FM-03" }, () => {
  const out = expandPattern("{nn}-{name}.{ext}", "file.txt", 0, new Date("2026-01-01"));
  if (out !== "01-file.txt") throw new Error(`expected 01-file.txt, got ${out}`);
});

await test("FM-03 · {upper} applies to everything to its right", { CODE: "FM-03" }, () => {
  const out = expandPattern("{upper}{name}", "report", 0, new Date("2026-01-01"));
  if (out !== "REPORT") throw new Error(`expected REPORT, got ${out}`);
});

await test("FM-03 · {date} and {time} produce ISO-like strings", { CODE: "FM-03" }, () => {
  const d = new Date("2026-06-15T14:30:00");
  const out = expandPattern("{date}-{time}", "x.txt", 0, d);
  if (!out.includes("2026-06-15")) throw new Error(`date wrong: ${out}`);
  if (!out.includes("1430")) throw new Error(`time wrong: ${out}`);
});

await test("FM-03 · invalid token throws", { CODE: "FM-03" }, () => {
  try {
    expandPattern("{bogus}", "file.txt", 0, new Date());
    throw new Error("should have thrown on unknown token");
  } catch (e) {
    if (!(e instanceof Error) || !/Unknown token/.test(e.message)) throw e;
  }
});

await test("FM-03 · pattern producing reserved name is refused", { CODE: "FM-03" }, () => {
  try {
    expandPattern("..", "file.txt", 0, new Date());
    throw new Error("should have thrown on reserved name");
  } catch (e) {
    if (!(e instanceof Error) || !/reserved/.test(e.message)) throw e;
  }
});

await test("FM-03 · planBatchRename detects collisions", { CODE: "FM-03" }, () => {
  const entries = [
    { path: "/Documents/a.txt", name: "a.txt", kind: "file" as const },
    { path: "/Documents/b.txt", name: "b.txt", kind: "file" as const },
  ];
  // Both would become /Documents/collision.txt (same name for both)
  const plan = planBatchRename(entries, "collision.txt", new Date());
  if (plan.ok) throw new Error("should detect collision");
  if (plan.conflicts.length === 0) throw new Error("should list conflicts");
});

await test("FM-03 · planBatchRename with unique names succeeds", { CODE: "FM-03" }, () => {
  const entries = [
    { path: "/Documents/a.txt", name: "a.txt", kind: "file" as const },
    { path: "/Documents/b.txt", name: "b.txt", kind: "file" as const },
  ];
  const plan = planBatchRename(entries, "doc-{n}.{ext}", new Date());
  if (!plan.ok) throw new Error(`should succeed: ${plan.errors.join("; ")}`);
  if (plan.rows.length !== 2) throw new Error(`expected 2 rows, got ${plan.rows.length}`);
});

await test("FM-03 · applyOrder produces two phases with temp names", { CODE: "FM-03" }, () => {
  const entries = [
    { path: "/Documents/a.txt", name: "a.txt", kind: "file" as const },
  ];
  const plan = planBatchRename(entries, "renamed.txt", new Date());
  const order = applyOrder(plan, "abc123");
  if (order.phase1.length !== 1) throw new Error("phase1 should have 1 entry");
  if (order.phase2.length !== 1) throw new Error("phase2 should have 1 entry");
  if (!order.phase1[0].to.includes(".part")) throw new Error("phase1 should use temp name");
  if (order.phase2[0].to !== "/Documents/renamed.txt") throw new Error(`phase2 target wrong: ${order.phase2[0].to}`);
});

await test("FM-03 · applyOrder rejects invalid token", { CODE: "FM-03" }, () => {
  const entries = [{ path: "/Documents/a.txt", name: "a.txt", kind: "file" as const }];
  const plan = planBatchRename(entries, "renamed.txt", new Date());
  try {
    applyOrder(plan, "BAD TOKEN!");
    throw new Error("should reject invalid token");
  } catch (e) {
    if (!(e instanceof Error) || !/token/i.test(e.message)) throw e;
  }
});

// ── Trash retention (FM-11) ───────────────────────────────────────────────────
await test("FM-11 · items older than retention are purged", { CODE: "FM-11" }, () => {
  const now = Date.now();
  const items = [
    { path: "/Trash/old.txt", bytes: 100, deletedAt: now - 30 * 86400000 }, // 30 days old
    { path: "/Trash/new.txt", bytes: 100, deletedAt: now - 1000 }, // recent
  ];
  const plan = planTrashPurge(items, { days: 7, maxBytes: 0 }, now);
  if (plan.purge.length !== 1) throw new Error(`expected 1 purge, got ${plan.purge.length}`);
  if (plan.purge[0].path !== "/Trash/old.txt") throw new Error(`wrong purge: ${plan.purge[0].path}`);
});

await test("FM-11 · pinned items are never purged", { CODE: "FM-11" }, () => {
  const now = Date.now();
  const items = [
    { path: "/Trash/old.txt", bytes: 100, deletedAt: now - 30 * 86400000, pinned: true },
  ];
  const plan = planTrashPurge(items, { days: 7, maxBytes: 0 }, now);
  if (plan.purge.length !== 0) throw new Error("pinned item should not be purged");
  if (plan.kept.length !== 1) throw new Error("pinned item should be kept");
});

await test("FM-11 · unknown timestamps are never purged", { CODE: "FM-11" }, () => {
  const now = Date.now();
  const items = [
    { path: "/Trash/unknown.txt", bytes: 100, deletedAt: null },
  ];
  const plan = planTrashPurge(items, { days: 7, maxBytes: 0 }, now);
  if (plan.purge.length !== 0) throw new Error("unknown timestamp should not be purged");
  if (plan.unknown.length !== 1) throw new Error("should report unknown");
});

await test("FM-11 · size rule purges oldest unpinned when over budget", { CODE: "FM-11" }, () => {
  const now = Date.now();
  const items = [
    { path: "/Trash/a.txt", bytes: 500, deletedAt: now - 10 * 86400000 },
    { path: "/Trash/b.txt", bytes: 500, deletedAt: now - 9 * 86400000 },
    { path: "/Trash/c.txt", bytes: 500, deletedAt: now - 8 * 86400000 },
  ];
  const plan = planTrashPurge(items, { days: 0, maxBytes: 1000 }, now);
  if (plan.purge.length < 1) throw new Error("should purge at least one to meet budget");
  if (plan.reclaimedBytes < 500) throw new Error("should reclaim at least 500 bytes");
});

await test("FM-11 · describePurge gives a compact summary", { CODE: "FM-11" }, () => {
  const now = Date.now();
  const plan = planTrashPurge([{ path: "/Trash/a.txt", bytes: 100, deletedAt: now - 30 * 86400000 }], { days: 7, maxBytes: 0 }, now);
  const s = describePurge(plan);
  if (!s.includes("Purge")) throw new Error(`should mention purge: ${s}`);
});

await test("FM-11 · empty trash produces empty plan", { CODE: "FM-11" }, () => {
  const plan = planTrashPurge([], { days: 7, maxBytes: 0 }, Date.now());
  if (plan.purge.length !== 0) throw new Error("empty trash should have no purge");
  if (plan.kept.length !== 0) throw new Error("empty trash should have no kept");
});

// ── Downloads (PR-07m) ────────────────────────────────────────────────────────
await test("PR-07m · nameFromUrl extracts filename from URL path", { CODE: "PR-07m" }, () => {
  const n = nameFromUrl("https://example.com/path/to/file.pdf");
  if (n !== "file.pdf") throw new Error(`expected file.pdf, got ${n}`);
});

await test("PR-07m · nameFromUrl rejects non-http URLs", { CODE: "PR-07m" }, () => {
  try {
    nameFromUrl("ftp://example.com/file.txt");
    throw new Error("should reject FTP");
  } catch (e) {
    if (!(e instanceof Error) || !/http/.test(e.message)) throw e;
  }
});

await test("PR-07m · createEntry produces a queued download", { CODE: "PR-07m" }, () => {
  const e = createEntry("dl1", "https://example.com/file.pdf", []);
  if (e.state !== "queued") throw new Error(`expected queued, got ${e.state}`);
  if (e.name !== "file.pdf") throw new Error(`expected file.pdf, got ${e.name}`);
});

await test("PR-07m · uniqueName appends (2) when name exists", { CODE: "PR-07m" }, () => {
  const n = uniqueName(["file.pdf"], "file.pdf");
  if (n !== "file (2).pdf") throw new Error(`expected file (2).pdf, got ${n}`);
});

await test("PR-07m · start transitions queued → running", { CODE: "PR-07m" }, () => {
  const e = createEntry("dl1", "https://example.com/f.pdf", []);
  const running = start(e);
  if (running.state !== "running") throw new Error(`expected running, got ${running.state}`);
  if (running.attempts !== 1) throw new Error(`expected attempts=1, got ${running.attempts}`);
});

await test("PR-07m · progress is monotonic and bounded", { CODE: "PR-07m" }, () => {
  let e = start(createEntry("dl1", "https://example.com/f.pdf", []));
  e = progress(e, 1024);
  if (e.received !== 1024) throw new Error(`expected 1024, got ${e.received}`);
  try {
    progress(e, 512); // backwards
    throw new Error("should reject backward progress");
  } catch (err) {
    if (!(err instanceof Error) || !/non-decreasing/.test(err.message)) throw err;
  }
});

await test("PR-07m · fail transitions running → failed with reason", { CODE: "PR-07m" }, () => {
  let e = start(createEntry("dl1", "https://example.com/f.pdf", []));
  e = fail(e, Date.now(), "Connection reset");
  if (e.state !== "failed") throw new Error(`expected failed, got ${e.state}`);
  if (e.error !== "Connection reset") throw new Error(`expected error message, got ${e.error}`);
});

await test("PR-07m · complete requires matching size", { CODE: "PR-07m" }, () => {
  let e = start(createEntry("dl1", "https://example.com/f.pdf", [], 2048));
  e = progress(e, 1024);
  try {
    complete(e);
    throw new Error("should reject incomplete download");
  } catch (err) {
    if (!(err instanceof Error) || !/bytes/.test(err.message)) throw err;
  }
});

await test("PR-07m · complete accepts when size matches", { CODE: "PR-07m" }, () => {
  let e = start(createEntry("dl1", "https://example.com/f.pdf", [], 1024));
  e = progress(e, 1024);
  const done = complete(e);
  if (done.state !== "done") throw new Error(`expected done, got ${done.state}`);
});

await test("PR-07m · cancel stops a running download", { CODE: "PR-07m" }, () => {
  let e = start(createEntry("dl1", "https://example.com/f.pdf", []));
  e = cancel(e);
  if (e.state !== "cancelled") throw new Error(`expected cancelled, got ${e.state}`);
});

await test("PR-07m · retry plan gives exponential backoff", { CODE: "PR-07m" }, () => {
  let e = start(createEntry("dl1", "https://example.com/f.pdf", []));
  e = fail(e, Date.now(), "timeout");
  const r1 = planRetry(e, Date.now());
  if (!r1.retry) throw new Error("should retry on first failure");
  if (r1.delayMs !== 2000) throw new Error(`expected 2000ms backoff, got ${r1.delayMs}`);
});

await test("PR-07m · retry exhausted after 3 attempts", { CODE: "PR-07m" }, () => {
  let e = createEntry("dl1", "https://example.com/f.pdf", []);
  for (let i = 0; i < 3; i++) {
    e = start(e);
    e = fail(e, Date.now(), "timeout");
  }
  const r = planRetry(e, Date.now());
  if (r.retry) throw new Error("should not retry after 3 attempts");
});

await test("PR-07m · sortQueue puts running first", { CODE: "PR-07m" }, () => {
  const q = createEntry("q1", "https://example.com/1.pdf", []);
  const r = start(createEntry("r1", "https://example.com/2.pdf", []));
  const sorted = sortQueue([q, r]);
  if (sorted[0].state !== "running") throw new Error("running should be first");
});

await test("PR-07m · summary reports counts", { CODE: "PR-07m" }, () => {
  const e = complete(progress(start(createEntry("d1", "https://example.com/f.pdf", [])), 100));
  const s = summary([e]);
  if (!s.includes("1 saved")) throw new Error(`expected '1 saved': ${s}`);
});


// ── Extension permissions (FM-14) ──────────────────────────────────────────
await test("FM-14 · check grants read inside folder", { CODE: "FM-14" }, () => {
  const g = { folder: "/Documents/", permissions: ["read"] as const };
  const r = check(g, "/Documents/a.txt", "read");
  if (!r.granted) throw new Error("should grant read inside folder");
  if (r.resolved !== "/Documents/a.txt") throw new Error(`wrong resolved: ${r.resolved}`);
});

await test("FM-14 · check denies read outside folder", { CODE: "FM-14" }, () => {
  const g = { folder: "/Documents/", permissions: ["read"] as const };
  const r = check(g, "/System/secret.txt", "read");
  if (r.granted) throw new Error("should deny outside folder");
  if (!r.reason.includes("outside")) throw new Error(`reason should say outside: ${r.reason}`);
});

await test("FM-14 · check denies missing permission", { CODE: "FM-14" }, () => {
  const g = { folder: "/Documents/", permissions: ["read"] as const };
  const r = check(g, "/Documents/a.txt", "write");
  if (r.granted) throw new Error("should deny write without permission");
});

await test("FM-14 · path traversal is normalised away", { CODE: "FM-14" }, () => {
  const g = { folder: "/Documents/", permissions: ["read"] as const };
  const r = check(g, "/Documents/../System/secret.txt", "read");
  if (r.granted) throw new Error("should deny traversal escape");
});

await test("FM-14 · boundedRead caps at maxBytes", { CODE: "FM-14" }, () => {
  const g = { folder: "/Documents/", permissions: ["read"] as const };
  const r = boundedRead(g, "/Documents/a.txt", 4096);
  if (!r.ok) throw new Error("should allow read");
  if (r.bytes !== 4096) throw new Error(`expected 4096, got ${r.bytes}`);
});

await test("FM-14 · stream requires separate permission", { CODE: "FM-14" }, () => {
  const g = { folder: "/Documents/", permissions: ["read"] as const };
  const r = stream(g, "/Documents/a.txt", 1024);
  if (r.ok) throw new Error("should deny stream without stream permission");
});

await test("FM-14 · app metadata is never exposed", { CODE: "FM-14" }, () => {
  const g = { folder: "/", permissions: ["read", "stream", "list", "write", "execute"] as const };
  const r = check(g, "/.fusion/config.json", "read");
  if (r.granted) throw new Error("should deny access to .fusion metadata");
});

// ── Streaming playlists (ST-04) ─────────────────────────────────────────────
await test("ST-04 · parsePlaylist parses basic M3U8", { CODE: "ST-04" }, () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:20.0,\nseg2.ts";
  const p = parsePlaylist(text, "https://example.com/");
  if (p.entries.length !== 2) throw new Error(`expected 2 entries, got ${p.entries.length}`);
  if (p.totalSeconds !== 30) throw new Error(`expected 30s, got ${p.totalSeconds}`);
});

await test("ST-04 · parsePlaylist detects byte ranges", { CODE: "ST-04" }, () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-BYTERANGE:1024@0\n#EXTINF:10.0,\nseg1.ts";
  const p = parsePlaylist(text);
  if (p.entries[0].byteLength !== 1024) throw new Error(`expected 1024 bytes, got ${p.entries[0].byteLength}`);
});

await test("ST-04 · parsePlaylist detects live playlists", { CODE: "ST-04" }, () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:live\n#EXTINF:10.0,\nseg1.ts";
  const p = parsePlaylist(text);
  if (!p.isLive) throw new Error("should detect live playlist");
});

await test("ST-04 · byte ranges require version 3+", { CODE: "ST-04" }, () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:1\n#EXT-X-BYTERANGE:1024@0\n#EXTINF:10.0,\nseg1.ts";
  const p = parsePlaylist(text);
  if (!p.invalid) throw new Error("should flag byte range with version 1");
});

await test("ST-04 · advanceIndex moves to next for live playlists", { CODE: "ST-04" }, () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-PLAYLIST-TYPE:live\n#EXTINF:10.0,\nseg1.ts\n#EXTINF:10.0,\nseg2.ts";
  const p = parsePlaylist(text);
  const next = advanceIndex(p, 0, 10);
  if (next !== 1) throw new Error(`expected index 1, got ${next}`);
});

await test("ST-04 · streamStat reports counts and bytes", { CODE: "ST-04" }, () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-BYTERANGE:2048@0\n#EXTINF:10.0,\nseg1.ts";
  const p = parsePlaylist(text);
  const s = streamStat(p);
  if (s.count !== 1) throw new Error(`expected 1 segment, got ${s.count}`);
  if (s.totalBytes !== 2048) throw new Error(`expected 2048 bytes, got ${s.totalBytes}`);
});

await test("ST-04 · describePlaylist gives a one-line summary", { CODE: "ST-04" }, () => {
  const text = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10.0,\nseg1.ts";
  const p = parsePlaylist(text);
  const d = describePlaylist(p);
  if (!d.includes("1 segment")) throw new Error(`should mention segments: ${d}`);
});
finish();
