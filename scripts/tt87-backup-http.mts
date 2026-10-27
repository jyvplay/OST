/** Real Next.js HTTP routes and PostgreSQL; the rollback test uses a temporary DB trigger, never production code. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { makeHarness } from "./harness.mts";
import { makeBackup, digestText, type BackupBundle, type BackupPayload } from "../src/lib/backup/bundle.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing backup HTTP/trigger tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable server/database.");
const { test, finish } = makeHarness("tt87-backup-http");
const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `TT87${randomBytes(8).toString("hex")}`;
const DIR = `/${RUN}`;
const PRIVATE = `/Private/${RUN}`;
const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await response.json();
  return { status: response.status, json };
};
const must = async (method: string, path: string, body?: unknown) => {
  const r = await call(method, path, body);
  assert.ok(r.status >= 200 && r.status < 300 && r.json.ok !== false, `${method} ${path} ${r.status}: ${JSON.stringify(r.json)}`);
  return r.json;
};
const fs = (op: string, path: string, extras: object = {}) => must("POST", "/api/fs", { op, path, ...extras });
const read = async (path: string) => (await must("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).node;
const setting = async (key: string) => (await must("GET", "/api/settings")).rows.find((s: any) => s.key === key)?.value;
const set = (key: string, value: string) => must("PUT", "/api/settings", { key, value });
const subset = async (b: BackupBundle, entries = b.entries, notes = b.notes, settings = b.settings) => {
  const { manifest: _manifest, ...p } = b;
  return makeBackup({ ...p, entries, notes, settings });
};
const preview = (bundle: unknown) => must("POST", "/api/backup", { bundle, dryRun: true });
const commit = (bundle: unknown, previewToken: string, allowLegacy = false) => must("POST", "/api/backup", { bundle, previewToken, allowLegacy });
const db = new Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
// A random subtree is still checked before the test claims it; prefix matching is literal.
for (const root of [DIR, PRIVATE]) {
  for (const [table, column] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) {
    const existing = await db.query(`SELECT 1 FROM ${table} WHERE ${column}=$1 OR left(${column},char_length($1)+1)=$1||'/' LIMIT 1`, [root]);
    if (existing.rowCount) { await db.end(); throw new Error(`Fixture already exists: ${root}`); }
  }
}
const originalTheme = await setting("appearance.theme");
const originalDensity = await setting("appearance.density");
const triggerName = `tt87_fail_${Date.now()}`;

try {
  await test("BK-03 config export → preview → actual atomic restore, history, no document data, and idempotent replay", { "BK-03": "full" }, async () => {
    await set("appearance.theme", "light"); await set("appearance.density", "compact");
    const full: BackupBundle = await must("GET", "/api/backup?kind=config");
    assert.equal(full.version, "fusion-bundle-2"); assert.deepEqual(full.entries, []); assert.deepEqual(full.notes, []);
    assert.ok(!full.settings.some((x) => x.key === "system.seedVersion" || x.key === "privacy.telemetry"));
    const b = await subset(full, [], [], full.settings.filter((s) => ["appearance.theme", "appearance.density"].includes(s.key)));
    await set("appearance.theme", "dark"); await set("appearance.density", "touch");
    const beforeHistory = (await must("GET", "/api/settings?history=1")).history;
    const latestHistoryId = Math.max(0, ...beforeHistory.map((h: any) => h.id));
    const p = await preview(b); assert.equal(p.summary.settingsChange, 2); assert.equal(await setting("appearance.theme"), "dark");
    const noPreview = await call("POST", "/api/backup", { bundle: b }); assert.equal(noPreview.status, 409);
    const done = await commit(b, p.previewToken); assert.equal(done.summary.settingsChange, 2);
    assert.equal(await setting("appearance.theme"), "light"); assert.equal(await setting("appearance.density"), "compact");
    const history = (await must("GET", "/api/settings?history=1")).history;
    assert.ok(history.some((h: any) => h.id > latestHistoryId && h.key === "appearance.theme" && h.oldValue === "dark" && h.newValue === "light"));
    const stale = await call("POST", "/api/backup", { bundle: b, previewToken: p.previewToken }); assert.equal(stale.status, 409);
    const repeat = await preview(b); assert.equal(repeat.summary.settingsChange, 0); assert.equal(repeat.summary.settingsUnchanged, 2);
    await commit(b, repeat.previewToken);
  });

  await test("BK-03 stale preview, invalid known value, locked and unknown keys cannot cause unintended changes", { "BK-03": "full" }, async () => {
    await set("appearance.theme", "light"); await set("appearance.density", "compact");
    const full: BackupBundle = await must("GET", "/api/backup?kind=config");
    const b = await subset(full, [], [], [{ key: "appearance.theme", value: "dark" }, { key: "appearance.density", value: "touch" }]);
    const p = await preview(b);
    await set("appearance.density", "balanced");
    const stale = await call("POST", "/api/backup", { bundle: b, previewToken: p.previewToken });
    assert.equal(stale.status, 409); assert.equal(await setting("appearance.density"), "balanced"); assert.equal(await setting("appearance.theme"), "light");
    const bad = await subset(full, [], [], [{ key: "appearance.theme", value: "invalid-theme" }]);
    const invalid = await call("POST", "/api/backup", { bundle: bad, dryRun: true }); assert.equal(invalid.status, 422);
    const blocked = await subset(full, [], [], [{ key: "privacy.telemetry", value: "on" }, { key: `${RUN}.unknown`, value: "secret" }]);
    const pr = await preview(blocked); assert.deepEqual(pr.summary.settingsLocked, ["privacy.telemetry"]); assert.deepEqual(pr.summary.settingsUnknown, [`${RUN}.unknown`]);
    await commit(blocked, pr.previewToken); assert.equal(await setting("privacy.telemetry"), "off"); assert.equal(await setting(`${RUN}.unknown`), undefined);
  });

  await test("BK-03 an actual database failure during the second setting update rolls back the first update and its history", { "BK-03": "full" }, async () => {
    await set("appearance.theme", "dark"); await set("appearance.density", "balanced");
    const full: BackupBundle = await must("GET", "/api/backup?kind=config");
    const b = await subset(full, [], [], [{ key: "appearance.theme", value: "light" }, { key: "appearance.density", value: "compact" }]);
    const p = await preview(b);
    const before = await db.query("select count(*)::int as n from settings_history where key = 'appearance.theme'");
    const fn = `${triggerName}_settings`;
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key = 'appearance.density' AND NEW.value = 'compact' THEN RAISE EXCEPTION 'TT87 settings failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    try {
      const result = await call("POST", "/api/backup", { bundle: b, previewToken: p.previewToken });
      assert.equal(result.status, 500); assert.equal(await setting("appearance.theme"), "dark"); assert.equal(await setting("appearance.density"), "balanced");
      const after = await db.query("select count(*)::int as n from settings_history where key = 'appearance.theme'");
      assert.equal(after.rows[0].n, before.rows[0].n);
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${fn} ON settings`); await db.query(`DROP FUNCTION IF EXISTS ${fn}()`);
    }
  });

  await test("BK-01 data snapshot restores Unicode text, binary, empty folders and notes; keeps previous file versions and avoids duplicate notes", { "BK-01": "partial" }, async () => {
    await fs("mkdir", `${DIR}/empty`);
    await fs("write", `${DIR}/text.txt`, { content: "backup — café 🐚" });
    const bytes = Buffer.from([0, 1, 2, 255, 128, 10]);
    await fs("write", `${DIR}/binary.bin`, { content: bytes.toString("base64"), encoding: "base64", mime: "application/octet-stream" });
    const n = await must("POST", "/api/notes", { title: `${RUN} note`, body: "backup note", tags: "restore" });
    const full: BackupBundle = await must("GET", "/api/backup?kind=data");
    assert.equal(full.settings.length, 0);
    const b = await subset(full, full.entries.filter((e) => e.path === DIR || e.path.startsWith(`${DIR}/`)), full.notes.filter((e) => e.title === `${RUN} note`), []);
    await fs("write", `${DIR}/text.txt`, { content: "later edits" });
    await fs("write", `${DIR}/binary.bin`, { content: Buffer.from("new binary").toString("base64"), encoding: "base64", mime: "application/octet-stream" });
    await fs("purge", `${DIR}/empty`);
    await must("PUT", "/api/notes", { id: n.row.id, body: "edited note" });
    const p = await preview(b); assert.equal(p.summary.filesReplace, 2); assert.equal(p.summary.foldersCreate, 1); assert.equal(p.summary.notesAdd, 1);
    assert.equal((await read(`${DIR}/text.txt`)).content, "later edits");
    await commit(b, p.previewToken);
    assert.equal((await read(`${DIR}/text.txt`)).content, "backup — café 🐚");
    assert.deepEqual(Buffer.from((await read(`${DIR}/binary.bin`)).content, "base64"), bytes);
    assert.equal((await read(`${DIR}/empty`)).kind, "dir");
    const versions = (await must("GET", `/api/fs?op=versions&path=${encodeURIComponent(`${DIR}/text.txt`)}`)).versions;
    assert.ok(versions.some((v: any) => v.content === "later edits" && v.reason === "restore"));
    const list = (await must("GET", "/api/notes")).rows.filter((n: any) => n.title === `${RUN} note`);
    assert.deepEqual(list.map((n: any) => n.body).sort(), ["backup note", "edited note"]);
    const again = await preview(b); assert.equal(again.summary.notesAdd, 0); assert.equal(again.summary.notesUnchanged, 1); assert.equal(again.summary.filesReplace, 0);
    await commit(b, again.previewToken);
    assert.equal((await must("GET", "/api/notes")).rows.filter((n: any) => n.title === `${RUN} note`).length, 2);
  });

  await test("BK-01 identical source notes are counted rather than collapsed, and a repeated restore adds no extra copies", { "BK-01": "partial" }, async () => {
    await must("POST", "/api/notes", { title: `${RUN} duplicates`, body: "same content", tags: "duplicates" });
    const full: BackupBundle = await must("GET", "/api/backup?kind=data");
    const n = full.notes.find((item) => item.title === `${RUN} duplicates`)!;
    const b = await subset(full, [], [n, structuredClone(n)], []);
    const p = await preview(b); assert.equal(p.summary.notesUnchanged, 1); assert.equal(p.summary.notesAdd, 1);
    await commit(b, p.previewToken);
    const repeat = await preview(b); assert.equal(repeat.summary.notesUnchanged, 2); assert.equal(repeat.summary.notesAdd, 0);
  });

  await test("BK-01 restores private ciphertext without indexing, refuses an encrypted-to-plaintext overwrite and file/folder collision", { "BK-01": "partial", "SC-17": "partial" }, async () => {
    await fs("write", `${PRIVATE}/secret`, { content: "ciphertext-before", mime: "application/x-fusion-encrypted" });
    const full: BackupBundle = await must("GET", "/api/backup?kind=data");
    const b = await subset(full, full.entries.filter((e) => e.path === PRIVATE || e.path.startsWith(`${PRIVATE}/`)), [], []);
    await fs("write", `${PRIVATE}/secret`, { content: "ciphertext-after", mime: "application/x-fusion-encrypted" });
    const p = await preview(b); await commit(b, p.previewToken);
    assert.equal((await read(`${PRIVATE}/secret`)).content, "ciphertext-before");
    assert.equal(Number((await db.query("select count(*) as n from index_docs where source='file' and ref=$1", [`${PRIVATE}/secret`])).rows[0].n), 0);
    const badEntries = structuredClone(b.entries); const bad = badEntries.find((e) => e.kind === "file")!; bad.mime = "text/plain";
    const downgrade = await subset(b, badEntries, [], []);
    const refusal = await call("POST", "/api/backup", { bundle: downgrade, dryRun: true }); assert.equal(refusal.status, 409); assert.match(refusal.json.error, /encrypted/);
    await fs("write", `${DIR}/collision`, { content: "existing file" });
    const collision = await subset(b, [{ ...b.entries.find((e) => e.kind === "dir")!, path: `${DIR}/collision` }], [], []);
    const collisionRes = await call("POST", "/api/backup", { bundle: collision, dryRun: true }); assert.equal(collisionRes.status, 409); assert.equal((await read(`${DIR}/collision`)).content, "existing file");
  });

  await test("BK-01 a real PostgreSQL error during the second file update rolls back the first file, its version and search index", { "BK-01": "partial" }, async () => {
    const a = `${DIR}/atomic-a.txt`, z = `${DIR}/atomic-z.txt`;
    await fs("write", a, { content: "saved A" }); await fs("write", z, { content: "saved Z" });
    const full: BackupBundle = await must("GET", "/api/backup?kind=data");
    const b = await subset(full, full.entries.filter((e) => e.path === a || e.path === z), [], []);
    await fs("write", a, { content: "current A" }); await fs("write", z, { content: "current Z" });
    const beforeVersions = (await must("GET", `/api/fs?op=versions&path=${encodeURIComponent(a)}`)).versions.length;
    const p = await preview(b); assert.equal(p.summary.filesReplace, 2);
    await db.query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.path = '${z}' AND NEW.content = 'saved Z' THEN RAISE EXCEPTION 'TT87 injected failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${triggerName} BEFORE UPDATE ON vfs_nodes FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`);
    try {
      const r = await call("POST", "/api/backup", { bundle: b, previewToken: p.previewToken });
      assert.equal(r.status, 500); assert.match(r.json.error, /could not be confirmed/); assert.equal(r.json.restored, null);
      assert.equal((await read(a)).content, "current A"); assert.equal((await read(z)).content, "current Z");
      assert.equal((await must("GET", `/api/fs?op=versions&path=${encodeURIComponent(a)}`)).versions.length, beforeVersions);
      const index = await db.query("select body from index_docs where source='file' and ref=$1", [a]); assert.equal(index.rows[0].body, "current A");
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS ${triggerName} ON vfs_nodes`); await db.query(`DROP FUNCTION IF EXISTS ${triggerName}()`);
    }
  });

  await test("BK-01 legacy v1 imports only after explicit consent; missing or tampered manifest never writes", { "BK-01": "partial" }, async () => {
    const path = `${DIR}/legacy.txt`, content = "legacy café";
    const hash = await digestText(content);
    const b = { version: "fusion-bundle-1", exportedAt: new Date().toISOString(), kind: "data",
      entries: [{ path, kind: "file", mime: "text/plain", encoding: "utf8", content, sha256: hash }],
      manifest: [{ path, sha256: hash, size: content.length }], notes: [], settings: [] };
    const bad = structuredClone(b); bad.manifest = [];
    const missing = await call("POST", "/api/backup", { bundle: bad, dryRun: true }); assert.equal(missing.status, 409);
    assert.equal((await call("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).status, 404);
    const p = await preview(b); assert.equal(p.legacy, true); assert.match(p.warnings.join(" "), /not protected/);
    assert.equal((await call("POST", "/api/backup", { bundle: b, previewToken: p.previewToken })).status, 409);
    await commit(b, p.previewToken, true); assert.equal((await read(path)).content, content);
  });
} finally {
  await db.query(`DROP TRIGGER IF EXISTS ${triggerName} ON vfs_nodes`).catch(() => undefined);
  await db.query(`DROP FUNCTION IF EXISTS ${triggerName}()`).catch(() => undefined);
  await set("appearance.theme", originalTheme).catch(() => undefined);
  await set("appearance.density", originalDensity).catch(() => undefined);
  for (const path of [DIR, PRIVATE]) {
    await fs("purge", path).catch(() => undefined);
    // Independent fixture cleanup still removes versions/index if a purge
    // regression or early failure left orphan rows; never match other subtrees.
    await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [path]);
    await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [path]);
    await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [path]);
  }
  const list = await must("GET", "/api/notes").catch(() => ({ rows: [] }));
  for (const n of list.rows.filter((row: any) => row.title.startsWith(RUN))) await must("DELETE", `/api/notes?id=${n.id}`).catch(() => undefined);
  await db.end();
}
finish();
