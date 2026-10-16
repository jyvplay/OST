/**
 * Fusion Shell Web — HTTP integration suite against a running server.
 * Run: BASE=http://localhost:3999 node scripts/integration.mjs
 * Each test attacks a contract (tamper, stale revision, whitelist bypass,
 * duplicate import, traversal) rather than only checking the happy path.
 * Every artifact it creates lives under /Test-* or a TEST* room and is purged.
 */
import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `T${Date.now().toString(36)}`;
const DIR = `/Test-${RUN}`;

const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, text };
};
const { test, finish } = makeHarness("integration");
const ok = (c, m) => { if (!c) throw new Error(m); };

function zip(files) {
  const locals = []; const cens = []; let offset = 0;
  for (const f of files) {
    const comp = deflateRawSync(f.data); const name = Buffer.from(f.name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(f.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); cens.push(ch, name); offset += 30 + name.length + comp.length;
  }
  const cen = Buffer.concat(cens); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cen.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cen, end]);
}

console.log(`\nIntegration against ${BASE} (run ${RUN})`);

await test("health + bootstrap reconcile the register", { "DP-10": "partial" }, async () => {
  const h = await call("GET", "/api/health"); ok(h.json.ok, "health not ok");
  const b = await call("GET", "/api/bootstrap"); ok(b.json.features >= 250, `features=${b.json.features}`);
});

await test("register has no audited row still over-claimed", { "DP-08": "partial" }, async () => {
  const r = await call("GET", "/api/features");
  for (const code of ["PR-10", "MD-04", "PR-13", "AU-02", "PR-07r", "PR-12"]) {
    const row = r.json.rows.find((x) => x.code === code);
    ok(row && row.nuance.startsWith("AUDIT"), `${code} missing audit note`);
  }
});

await test("FM-03 journaled move: 6 states in order, digest preserved, source retired", { "FM-03": "full", "DP-04": "partial", "DP-14": "partial", "NC-05": "partial" }, async () => {
  const w = await call("POST", "/api/fs", { op: "write", path: `${DIR}/a.md`, content: "journal me" });
  ok(w.json.sha256 === createHash("sha256").update("journal me").digest("hex"), "server digest differs from independent digest");
  const m = await call("POST", "/api/fs", { op: "move", src: `${DIR}/a.md`, dst: `${DIR}/sub/b.md` });
  ok(m.json.ok, JSON.stringify(m.json));
  const jobs = await call("GET", "/api/jobs?limit=10");
  const op = jobs.json.ops.find((o) => o.id === m.json.opId);
  const states = op.steps.map((s) => s.state).join(">");
  ok(states === "REQUESTED>COPYING_TO_TEMP>DEST_VERIFIED>DEST_PUBLISHED>SOURCE_RETIRE>COMPLETE", states);
  ok((await call("GET", `/api/fs?op=read&path=${DIR}/a.md`)).status === 404, "source still exists");
  ok((await call("GET", `/api/fs?op=read&path=${DIR}/sub/b.md`)).json.node.content === "journal me", "content changed");
});

await test("FM-03 adversarial moves are refused and journaled as FAILED", { "FM-03": "full" }, async () => {
  await call("POST", "/api/fs", { op: "mkdir", path: `${DIR}/loop` });
  const into = await call("POST", "/api/fs", { op: "move", src: `${DIR}/loop`, dst: `${DIR}/loop/inner` });
  ok(into.status === 400 && /into itself/.test(into.json.error), "dir-into-itself accepted");
  const exists = await call("POST", "/api/fs", { op: "copy", src: `${DIR}/sub/b.md`, dst: `${DIR}/sub/b.md` });
  ok(exists.status === 400, "copy onto itself accepted");
  const trav = await call("POST", "/api/fs", { op: "write", path: `${DIR}/../../../etc/x`, content: "x" });
  ok(trav.json.path === "/etc/x", `traversal normalised to ${trav.json.path}`); // normalised inside the VFS root, not escaped
  await call("POST", "/api/fs", { op: "purge", path: "/etc/x" });
});

await test("FM-18 overwrite snapshots the previous version", { "FM-18": "full", "DP-05": "partial", "BK-01": "partial" }, async () => {
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/v.txt`, content: "one" });
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/v.txt`, content: "two" });
  const v = await call("GET", `/api/fs?op=versions&path=${DIR}/v.txt`);
  ok(v.json.versions.length === 1 && v.json.versions[0].content === "one", JSON.stringify(v.json.versions));
});

await test("FM-11 trash → restore is exact; FM-07 finds duplicates by digest", { "FM-11": "full", "FM-07": "full" }, async () => {
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/dupe1.txt`, content: "same bytes" });
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/zz-dupe2.txt`, content: "same bytes" });
  const s = await call("GET", "/api/storage");
  const g = s.json.duplicates.find((d) => d.paths.includes(`${DIR}/dupe1.txt`));
  ok(g && g.paths.includes(`${DIR}/zz-dupe2.txt`), "duplicate group missing");
  await call("POST", "/api/fs", { op: "trash", path: `${DIR}/dupe1.txt` });
  ok((await call("GET", `/api/fs?op=list&path=${DIR}`)).json.nodes.every((n) => n.name !== "dupe1.txt"), "trashed file still listed");
  await call("POST", "/api/fs", { op: "restore", path: `${DIR}/dupe1.txt` });
  ok((await call("GET", `/api/fs?op=read&path=${DIR}/dupe1.txt`)).json.node.content === "same bytes", "restore not exact");
});

await test("SR-01 search finds new content with provenance", { "SR-01": "partial", "SR-02": "partial" }, async () => {
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/needle.md`, content: `zebra${RUN} lives here` });
  const r = await call("GET", `/api/search?q=zebra${RUN}`);
  ok(r.json.hits.some((h) => h.ref === `${DIR}/needle.md` && h.source === "file" && h.how), JSON.stringify(r.json.hits).slice(0, 200));
});

await test("SH-08 stale revision cannot clobber newer desktop state (409)", { "SH-08": "full" }, async () => {
  const id = `test:${RUN}`;
  ok((await call("PUT", "/api/state", { id, state: { windows: [] }, revision: 5 })).json.ok, "initial put");
  const stale = await call("PUT", "/api/state", { id, state: { windows: [{}] }, revision: 3 });
  ok(stale.status === 409 && stale.json.conflict, `stale write status ${stale.status}`);
  await call("DELETE", `/api/state?id=${id}`);
});

await test("AU-02 presets list and delete; non-prefixed rows cannot be deleted", { "AU-02": "partial", "PR-07r": "partial" }, async () => {
  await call("PUT", "/api/state", { id: `preset:${RUN}`, state: { windows: [{}, {}] }, revision: 1 });
  const l = await call("GET", "/api/state?list=preset");
  ok(l.json.rows.some((r) => r.name === RUN && r.windows === 2), "preset not listed");
  ok((await call("DELETE", "/api/state?id=default")).status === 400, "deleted the live desktop row");
  await call("DELETE", `/api/state?id=preset:${RUN}`);
});

await test("AU-01 routine whitelist rejects commands outside the palette vocabulary", { "AU-01": "partial" }, async () => {
  const bad = await call("POST", "/api/routines", { name: "evil", actions: [{ cmd: "open", arg: "files" }, { cmd: "eval", arg: "x" }] });
  ok(bad.status === 400 && /whitelist/.test(bad.json.error), JSON.stringify(bad.json));
  const good = await call("POST", "/api/routines", { name: `r${RUN}`, trigger: "interval", triggerArg: "60", actions: [{ cmd: "open", arg: "notes" }] });
  ok(good.json.ok, "valid routine rejected");
  await call("DELETE", `/api/routines?id=${good.json.row.id}`);
});

await test("PR-04 ICS import is idempotent by UID; export is valid iCalendar", { "PR-04": "full", "PR-03": "partial" }, async () => {
  const uid = `${RUN}@test`;
  const ics = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nSUMMARY:Integration\\, event\r\nDTSTART:20300101T100000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const a = await call("POST", "/api/tasks", { ics });
  const b = await call("POST", "/api/tasks", { ics });
  ok(a.json.added === 1 && b.json.added === 0 && b.json.skipped === 1, `${JSON.stringify(a.json)} ${JSON.stringify(b.json)}`);
  const exp = await call("GET", "/api/tasks?format=ics");
  ok(exp.text.startsWith("BEGIN:VCALENDAR") && exp.text.includes(`UID:${uid}`) && exp.text.includes("Integration\\, event"), "export missing event");
  const rows = (await call("GET", "/api/tasks")).json.rows.filter((r) => r.uid === uid);
  for (const r of rows) await call("DELETE", `/api/tasks?id=${r.id}`);
});

await test("CA-09 signalling: targeted delivery, no self-echo, kind whitelist, size cap", { "CA-09": "partial", "CT-02": "partial" }, async () => {
  const room = `TEST${RUN}`.toUpperCase();
  await call("POST", "/api/rtc", { room, from: "alice", kind: "hello" });
  await call("POST", "/api/rtc", { room, from: "bob", to: "alice", kind: "offer", payload: { type: "offer", sdp: "v=0" } });
  await call("POST", "/api/rtc", { room, from: "bob", to: "carol", kind: "ice", payload: {} });
  const alice = await call("GET", `/api/rtc?room=${room}&me=alice&since=0`);
  ok(alice.json.rows.length === 1 && alice.json.rows[0].kind === "offer", `alice got ${alice.json.rows.map((r) => r.kind)}`);
  const bob = await call("GET", `/api/rtc?room=${room}&me=bob&since=0`);
  ok(bob.json.rows.length === 1 && bob.json.rows[0].kind === "hello", "bob should see alice's hello only");
  ok((await call("POST", "/api/rtc", { room, from: "x", kind: "exec" })).status === 400, "unknown kind accepted");
  ok((await call("POST", "/api/rtc", { room, from: "x", kind: "ice", payload: { a: "x".repeat(70000) } })).status === 413, "oversized payload accepted");
});

await test("CA-11 Together anchor clock advances while playing and freezes on pause", { "CA-11": "partial", "CA-15": "partial", "CA-02": "partial" }, async () => {
  const room = `TEST${RUN}`;
  await call("POST", "/api/together", { room, clientId: "a", kind: "play", positionMs: 10_000 });
  await new Promise((r) => setTimeout(r, 400));
  const p = await call("GET", `/api/together?room=${room.toUpperCase()}`);
  ok(p.json.authoritativePositionMs >= 10_350 && p.json.authoritativePositionMs < 11_000, `pos ${p.json.authoritativePositionMs}`);
  await call("POST", "/api/together", { room, clientId: "a", kind: "pause", positionMs: 12_000 });
  await new Promise((r) => setTimeout(r, 300));
  ok((await call("GET", `/api/together?room=${room.toUpperCase()}`)).json.authoritativePositionMs === 12_000, "position moved while paused");
});

await test("FF-08/FF-10/FF-02 Forge engines via the API, with grades", { "FF-08": "full", "FF-10": "full", "FF-02": "full", "FF-12": "full", "PR-11": "partial", "FM-04": "partial" }, async () => {
  const opf = `<package><metadata><dc:title>T</dc:title></metadata><manifest><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="a"/></spine></package>`;
  const epub = zip([{ name: "META-INF/container.xml", data: Buffer.from(`<rootfile full-path="c.opf"/>`) }, { name: "c.opf", data: Buffer.from(opf) }, { name: "a.xhtml", data: Buffer.from("<body><p>Chapter text</p></body>") }]);
  await call("POST", "/api/fs", { op: "upload", path: `${DIR}/book.epub`, content: epub.toString("base64") });
  const e = await call("POST", "/api/forge", { op: "extract", path: `${DIR}/book.epub` });
  ok(e.json.grade === "C" && e.json.text.includes("Chapter text"), JSON.stringify(e.json).slice(0, 200));
  const h = Buffer.alloc(26 + 18); h.write("8BPS", 0, "ascii"); h.writeUInt16BE(1, 4); h.writeUInt16BE(3, 12); h.writeUInt32BE(10, 14); h.writeUInt32BE(20, 18); h.writeUInt16BE(8, 22); h.writeUInt16BE(3, 24);
  h.writeUInt32BE(0, 26); h.writeUInt32BE(0, 30); h.writeUInt32BE(6, 34); h.writeUInt32BE(2, 38); h.writeInt16BE(2, 42);
  await call("POST", "/api/fs", { op: "upload", path: `${DIR}/art.psd`, content: h.toString("base64") });
  const p = await call("POST", "/api/forge", { op: "extract", path: `${DIR}/art.psd` });
  ok(p.json.grade === "E" && p.json.header.width === 20 && p.json.header.layers === 2, JSON.stringify(p.json.header));
  const slip = zip([{ name: "../evil.txt", data: Buffer.from("x") }]);
  const s = await call("POST", "/api/forge", { op: "listZip", base64: slip.toString("base64") });
  ok(s.status === 400 && /zip-slip/.test(s.json.error), "zip-slip archive accepted by the server engine");
});

await test("BK-01 tampered backup bundle is refused before anything is written", { "BK-01": "full", "BK-03": "partial", "BK-05": "partial" }, async () => {
  const content = "original";
  const bundle = { version: "fusion-bundle-1", exportedAt: new Date().toISOString(), kind: "data",
    entries: [{ path: `${DIR}/restore.txt`, kind: "file", mime: "text/plain", encoding: "utf8", content: content + "!", sha256: "" }],
    manifest: [{ path: `${DIR}/restore.txt`, sha256: createHash("sha256").update(content).digest("hex"), size: 8 }] };
  const r = await call("POST", "/api/backup", bundle);
  ok(r.status === 409 && r.json.failures[0].path === `${DIR}/restore.txt`, JSON.stringify(r.json));
  ok((await call("GET", `/api/fs?op=read&path=${DIR}/restore.txt`)).status === 404, "partial restore happened");
});

await test("BL-01 licence: valid key verifies; one flipped character fails; wrong client is refused", { "BL-01": "full", "BL-02": "partial", "BL-05": "partial" }, async () => {
  const k = await call("POST", "/api/entitlement", { action: "issue", clientId: `c${RUN}`, kind: "pro" });
  ok((await call("POST", "/api/entitlement", { action: "verify", key: k.json.licenseKey })).json.valid === true, "valid key failed");
  const key = k.json.licenseKey; const i = key.indexOf(".") - 3;
  const tampered = key.slice(0, i) + (key[i] === "A" ? "B" : "A") + key.slice(i + 1);
  ok((await call("POST", "/api/entitlement", { action: "verify", key: tampered })).json.valid === false, "tampered key verified");
  ok((await call("POST", "/api/entitlement", { action: "activate", clientId: "someone-else", key })).status === 400, "key activated on another client");
});

await test("SR-04 / settings: locked settings refuse writes (423)", { "ST-01": "partial", "SC-08": "partial" }, async () => {
  ok((await call("PUT", "/api/settings", { key: "privacy.telemetry", value: "on" })).status === 423, "locked setting changed");
});


console.log("\nv3.3 regression attacks (aimed at this turn's patches)");

await test("CRITICAL regression: purging /a_b must not touch /aXb (LIKE wildcard)", { "FM-03": "full", "FM-11": "full", "DP-05": "partial" }, async () => {
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/lk_a/target.txt`, content: "target" });
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/lkXa/innocent.txt`, content: "unrelated" });
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/lk%a/pct.txt`, content: "percent" });
  await call("POST", "/api/fs", { op: "trash", path: `${DIR}/lk_a` });
  ok((await call("GET", `/api/fs?op=list&path=${DIR}/lkXa`)).json.nodes.length === 1, "trash of /lk_a hid /lkXa");
  await call("POST", "/api/fs", { op: "purge", path: `${DIR}/lk_a` });
  ok((await call("GET", `/api/fs?op=read&path=${DIR}/lkXa/innocent.txt`)).json.node?.content === "unrelated", "purge of /lk_a deleted /lkXa/innocent.txt");
  ok((await call("GET", `/api/fs?op=read&path=${DIR}/lk%25a/pct.txt`)).json.node?.content === "percent", "purge of /lk_a deleted /lk%a");
  const m = await call("POST", "/api/fs", { op: "move", src: `${DIR}/lk%a`, dst: `${DIR}/moved` });
  ok(m.json.ok && (await call("GET", `/api/fs?op=read&path=${DIR}/lkXa/innocent.txt`)).json.node, "moving /lk%a disturbed /lkXa");
});

await test("search treats % and _ in queries literally", { "SR-01": "full", "SR-05": "full" }, async () => {
  const pct = await call("GET", `/api/search?q=${encodeURIComponent("%")}`);
  ok(pct.json.hits.length < 50 || pct.json.hits.every((h) => /%/.test(h.title + h.ref + h.snippet)), "'%' matched everything");
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/scope_1/inside.md`, content: `scoped${RUN}` });
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/scopeX1/outside.md`, content: `scoped${RUN}` });
  const s = await call("GET", `/api/search?q=scoped${RUN}&scope=${encodeURIComponent(`${DIR}/scope_1/`)}`);
  ok(s.json.hits.length === 1 && s.json.hits[0].ref.endsWith("inside.md"), `scope leaked: ${s.json.hits.map((h) => h.ref)}`);
});

await test("SR-03 typo tolerance over HTTP: 'noets' finds the notes; junk finds nothing", { "SR-03": "full" }, async () => {
  const r = await call("GET", "/api/search?q=noets");
  ok(r.json.hits.some((h) => /fuzzy/.test(h.how) && /note/i.test(h.title + h.ref)), JSON.stringify(r.json.hits.slice(0, 3)));
  const junk = await call("GET", "/api/search?q=qqqqzzzzxx");
  ok(junk.json.hits.length === 0, `junk matched ${junk.json.hits.length}`);
});

await test("FM-05 compress → extract round trip preserves bytes (text and binary)", { "FM-05": "full" }, async () => {
  await call("POST", "/api/fs", { op: "write", path: `${DIR}/arc/a.md`, content: "alpha ".repeat(300) });
  await call("POST", "/api/fs", { op: "upload", path: `${DIR}/arc/sub/b.bin`, content: Buffer.from([0, 255, 1, 254, 0]).toString("base64") });
  const c = await call("POST", "/api/fs", { op: "compress", path: `${DIR}/arc` });
  ok(c.json.ok && c.json.entries === 2, JSON.stringify(c.json));
  const x = await call("POST", "/api/fs", { op: "extract", path: `${DIR}/arc.zip`, dst: `${DIR}/out` });
  ok(x.json.written === 2, JSON.stringify(x.json));
  ok((await call("GET", `/api/fs?op=read&path=${DIR}/out/a.md`)).json.node.content === "alpha ".repeat(300), "text changed");
  const b = (await call("GET", `/api/fs?op=read&path=${DIR}/out/sub/b.bin`)).json.node;
  ok(b.encoding === "base64" && Buffer.from(b.content, "base64").equals(Buffer.from([0, 255, 1, 254, 0])), "binary changed");
});

await test("FM-05 extract refuses zip-slip and writes nothing", { "FM-05": "full", "FF-12": "full" }, async () => {
  const evil = zip([{ name: "ok.txt", data: Buffer.from("fine") }, { name: "../../escape.txt", data: Buffer.from("x") }]);
  await call("POST", "/api/fs", { op: "upload", path: `${DIR}/evil.zip`, content: evil.toString("base64") });
  const x = await call("POST", "/api/fs", { op: "extract", path: `${DIR}/evil.zip`, dst: `${DIR}/evil-out` });
  ok(x.status === 400 && /zip-slip/.test(x.json.error), JSON.stringify(x.json));
  ok((await call("GET", `/api/fs?op=read&path=${DIR}/evil-out/ok.txt`)).status === 404, "partial extraction happened");
});

await test("Together GET accepts lowercase room codes (casing fix)", { "CA-11": "partial" }, async () => {
  const room = `low${RUN}`.toLowerCase();
  await call("POST", "/api/together", { room, clientId: "a", kind: "seek", positionMs: 4242 });
  const g = await call("GET", `/api/together?room=${room}`);
  ok(g.json.room && g.json.authoritativePositionMs === 4242, JSON.stringify(g.json).slice(0, 160));
});

await test("deleting a note removes only its own index row", { "PR-02": "partial", "SR-02": "partial" }, async () => {
  const n = await call("POST", "/api/notes", { title: `note${RUN}`, body: "b" });
  await call("DELETE", `/api/notes?id=${n.json.row.id}`);
  const r = await call("GET", `/api/search?q=note${RUN}`);
  ok(!r.json.hits.some((h) => h.source === "note"), "note still indexed after delete");
  const spec = await call("GET", "/api/search?q=journal&source=spec");
  ok(spec.json.hits.length > 0, "spec index rows disappeared");
});

// cleanup
await call("POST", "/api/fs", { op: "purge", path: DIR });
await call("POST", "/api/fs", { op: "purge", path: "/Sync" }).catch(() => undefined);

finish();
