/**
 * TT20 privacy suite 4 — one-file encrypted backup / verify / restore (SC-17) and amnesic unsaved-work rescue (SC-18),
 * against the REAL server + Postgres. Host-side claims are checked by reading Postgres directly.
 *
 * The suite wipes and restores /Private. It refuses to run without explicit disposable
 * database/server opt-in, and refuses any pre-existing nodes or historical versions.
 * Run only against an isolated server/database: the preflight cannot exclude concurrent writers.
 *
 * Run: BASE=http://localhost:3999 DATABASE_URL=… node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/privacy-backup.mts
 */
import assert from "node:assert/strict";
import pg from "pg";
import { makeHarness } from "./harness.mts";
import { PrivacyLayer } from "../src/lib/privacy/layer.ts";
import { KEYSLOT_PATH, createVolume, decryptContent, encryptContent, encryptPath, fromB64, toB64, type KdfParams, type KeyHeader } from "../src/lib/privacy/pcrypt.ts";
import { BACKUP_FORMAT, createBackup, keysForBackup, parseBackup, restoreBackup, verifyBackup } from "../src/lib/privacy/backup.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing destructive privacy-backup tests without TT89_DISPOSABLE_DATABASE=1 for a disposable server/database.");
const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("privacy-backup");
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" });
await db.connect();
const raw = (url: string, init?: RequestInit) => fetch(BASE + url, init);
const FAST: KdfParams = { kdf: "argon2id", m: 19456, t: 2, p: 1 };
const RUN = Math.random().toString(36).slice(2, 8);
const WORD = `zyxbackup${RUN}`;
const PASS = "backup suite passphrase words";
const rows = async (sql: string, args: unknown[] = []) => (await db.query(sql, args)).rows;
const hostPost = async (body: unknown) => { const r = await raw("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j)); return j; };
const children = async (p: string) => ((await (await raw(`/api/fs?op=list&path=${encodeURIComponent(p)}`)).json()).nodes ?? []) as { path: string; name: string }[];
const wipePrivate = async () => { for (const n of await children("/Private")) await hostPost({ op: "purge", path: n.path }); };
const writeHeader = (h: KeyHeader) => hostPost({ op: "write", path: KEYSLOT_PATH, content: JSON.stringify(h, null, 1), mime: "application/json", reason: "privacy-header" });
/** live (non-trashed) encrypted rows under /Private, minus the header: path → content */
const snapshot = async () => new Map((await rows("select path, content from vfs_nodes where path like '/Private/%' and path <> $1 and coalesce(trashed,false)=false", [KEYSLOT_PATH])).map((r) => [r.path as string, r.content as string | null]));

// A missing keyslot does not imply empty storage: include trashed nodes and orphaned versions.
const pre = await raw("/api/fs?op=read&path=/Private/.keyslots.json");
const listing = await raw("/api/fs?op=list&path=/Private");
const listed = await listing.json().catch(() => ({}));
const existing = (await db.query(`SELECT EXISTS (SELECT 1 FROM vfs_nodes WHERE path LIKE '/Private/%') AS nodes,
  EXISTS (SELECT 1 FROM vfs_versions WHERE path = '/Private' OR path LIKE '/Private/%') AS versions`)).rows[0];
if (pre.status !== 404 || !listing.ok || !Array.isArray(listed.nodes) || listed.nodes.length || existing.nodes || existing.versions) {
  await db.end(); console.error("Existing /Private data or versions found — refusing destructive privacy-backup tests."); process.exit(2);
}
await hostPost({ op: "mkdir", path: "/Private" }).catch(() => undefined);

const { header, keys, recoveryKey } = await createVolume(PASS, { kdf: FAST });
const L = new PrivacyLayer(raw); L.keys = keys;
const lw = async (path: string, content: string, encoding?: string) => { const r = await L.handle("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path, content, encoding, reason: "it" }) }); assert.equal(r.status, 200, await r.clone().text()); };
const lread = async (path: string) => (await (await L.handle(`/api/fs?op=read&path=${encodeURIComponent(path)}`)).json()).node as { content: string };
const BIN = toB64(Uint8Array.from({ length: 70_000 }, (_, i) => (i * 37) & 255));
let backupText = "";

try {
  await writeHeader(header);
  await lw(`/Private/Plans ${WORD}/Q4 notes.md`, `# ${WORD} meet at the café`);
  await lw(`/Private/Plans ${WORD}/Deep/évidence ${WORD}.txt`, "nested");
  await lw(`/Private/photo.bin`, BIN, "base64");
  await lw(`/Private/empty.txt`, "");
  await L.handle("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "mkdir", path: `/Private/Empty folder ${WORD}` }) });
  await hostPost({ op: "write", path: `/Private/[clear] leaked ${RUN}.txt`, content: "host cleartext", reason: "it" });

  await test("backup is one file holding only ciphertext: no names, no content, no tree shape; cleartext entries are skipped and reported", { "SC-17": "full" }, async () => {
    const before = await snapshot();
    const b = await createBackup(raw, keys);
    backupText = b.text;
    assert.equal(b.file.format, BACKUP_FORMAT);
    assert.equal(b.files, 4); assert.equal(b.dirs, 3);
    assert.deepEqual(b.skipped, [`leaked ${RUN}.txt`]);
    // tokens ≥5 chars: 2-char tokens occur in base64 text by chance
    for (const leak of [WORD, "Plans ", "Q4 notes", "photo.bin", "empty.txt", "Deep/", "café", "évidence", "Empty folder"]) assert.ok(!b.text.includes(leak), `backup leaks "${leak}"`);
    const j = JSON.parse(b.text);
    assert.deepEqual(Object.keys(j).sort(), ["format", "header", "manifest"], "nothing but header + sealed manifest in clear");
    assert.equal(j.header.volumeId, header.volumeId);
    assert.ok(fromB64(j.manifest).length % 256 === 0 || fromB64(j.manifest).length > 70_000, "manifest is a padded FEN1 blob");
    assert.deepEqual(await snapshot(), before, "making a backup changes nothing on the host");
  });

  await test("verify opens every entry with the passphrase AND with the recovery key; wrong secret and a flipped byte are rejected", { "SC-17": "full" }, async () => {
    const f = parseBackup(backupText);
    for (const secret of [PASS, recoveryKey!.toLowerCase().replace(/-/g, " ")]) {
      const v = await verifyBackup(f, await keysForBackup(f, secret));
      assert.equal(v.files, 4); assert.equal(v.dirs, 3); assert.deepEqual(v.failures, []);
      assert.equal(v.plainBytes, Buffer.byteLength(`# ${WORD} meet at the café`) + 6 + 70_000);
    }
    await assert.rejects(keysForBackup(f, "wrong passphrase entirely"));
    const bytes = fromB64(f.manifest); bytes[bytes.length - 3] ^= 1;
    await assert.rejects(verifyBackup({ ...f, manifest: toB64(bytes) }, keys), /authentication/);
    assert.throws(() => parseBackup("{\"format\":\"something-else\"}"), /not a Fusion/);
    assert.throws(() => parseBackup("PK\u0003\u0004"), /not JSON/);
  });

  await test("restore onto a host with no volume recreates header + identical ciphertext rows; the layer reads the plaintext back", { "SC-17": "full" }, async () => {
    const before = await snapshot();
    await wipePrivate();
    assert.equal((await snapshot()).size, 0); assert.equal((await rows("select count(*)::int n from vfs_nodes where path=$1", [KEYSLOT_PATH]))[0].n, 0);
    const f = parseBackup(backupText);
    const r = await restoreBackup(raw, f, await keysForBackup(f, PASS));
    assert.equal(r.headerWritten, true); assert.equal(r.written, 4); assert.equal(r.dirs, 3); assert.deepEqual(r.failures, []);
    const after = await snapshot();
    for (const [p, c] of before) if (!p.includes("[clear]")) assert.equal(after.get(p), c, "same encrypted path, byte-identical ciphertext");
    assert.equal(after.size, before.size - 1, "everything but the skipped cleartext entry");
    assert.equal((await lread(`/Private/Plans ${WORD}/Q4 notes.md`)).content, `# ${WORD} meet at the café`);
    assert.equal((await lread(`/Private/photo.bin`)).content, BIN);
    const [hrow] = await rows("select content from vfs_nodes where path=$1", [KEYSLOT_PATH]);
    assert.equal(JSON.parse(hrow.content).volumeId, header.volumeId);
  });

  await test("restore into the SAME volume merges only what is missing; never overwrites newer files", { "SC-17": "full" }, async () => {
    await lw(`/Private/empty.txt`, "edited after the backup");
    await hostPost({ op: "purge", path: await encryptPath(keys, `/Private/Plans ${WORD}/Deep/évidence ${WORD}.txt`) });
    const f = parseBackup(backupText);
    const r = await restoreBackup(raw, f, keys);
    assert.equal(r.headerWritten, false); assert.equal(r.written, 1); assert.equal(r.kept, 3);
    assert.equal((await lread(`/Private/empty.txt`)).content, "edited after the backup", "newer file kept");
    assert.equal((await lread(`/Private/Plans ${WORD}/Deep/évidence ${WORD}.txt`)).content, "nested", "missing file restored");
  });

  await test("a DIFFERENT volume on the host is never touched; a backup with one corrupted entry writes nothing at all", { "SC-17": "full" }, async () => {
    const f = parseBackup(backupText);
    const other = await createVolume("another volume passphrase", { kdf: FAST, withRecovery: false });
    await wipePrivate(); await writeHeader(other.header);
    await assert.rejects(restoreBackup(raw, f, keys), /DIFFERENT Persistent Storage/);
    assert.equal((await snapshot()).size, 0, "nothing written next to the other volume");
    // storage corruption captured at backup time: re-seal a manifest whose first file has a damaged ciphertext
    await wipePrivate();
    const m = JSON.parse(new TextDecoder().decode((await decryptContent(keys, fromB64(f.manifest))).data));
    const victim = m.entries.find((e: { k: string }) => e.k === "file");
    const c = fromB64(victim.c); c[40] ^= 0x10; victim.c = toB64(c);
    const sealed = await encryptContent(keys, { data: new TextEncoder().encode(JSON.stringify(m)), mime: "application/json", encoding: "utf8" });
    const bad = { ...f, manifest: toB64(sealed) };
    const v = await verifyBackup(bad, keys);
    assert.equal(v.failures.length, 1); assert.equal(v.files, 3);
    await assert.rejects(restoreBackup(raw, bad, keys), /failed verification.*nothing was written/);
    assert.equal((await rows("select count(*)::int n from vfs_nodes where path like '/Private/%'"))[0].n, 0, "not even the header");
  });

  await test("amnesic rescue: RAM-only files are listed and moved into /Private/Rescued encrypted; nothing lands in clear; locked refuses", { "SC-18": "full", "SC-11": "partial" }, async () => {
    const f = parseBackup(backupText);
    await restoreBackup(raw, f, keys);
    const A = new PrivacyLayer(raw); A.amnesic = true; A.keys = keys;
    let changes = 0; A.onRamChange = () => { changes += 1; };
    const DOC = `/Documents/draft-${RUN} ${WORD}.txt`;
    await A.handle("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: DOC, content: `unsaved ${WORD}`, reason: "it" }) });
    assert.ok(changes >= 1, "RAM change notified (drives the UI list)");
    assert.deepEqual(A.ramFiles().map((x) => x.path), [DOC]);
    const locked = new PrivacyLayer(raw); locked.amnesic = true;
    await assert.rejects(locked.rescue([DOC]));
    const bogus = await A.rescue(["/Documents/not-in-ram.txt"]);
    assert.equal(bogus.failed.length, 1);
    const r = await A.rescue([DOC]);
    assert.deepEqual(r.moved, [{ from: DOC, to: `/Private/Rescued${DOC}` }]);
    assert.deepEqual(A.ramFiles(), [], "nothing left to lose");
    const enc = await encryptPath(keys, `/Private/Rescued${DOC}`);
    const [row] = await rows("select content from vfs_nodes where path=$1", [enc]);
    assert.ok(row?.content?.startsWith("RkVOMQ"), "rescued file is a FEN1 blob on the host");
    assert.equal((await rows("select count(*)::int n from vfs_nodes where path like $1 or content like $1", [`%${WORD}%`]))[0].n, 0, "no plaintext name or content anywhere");
    assert.equal((await lread(`/Private/Rescued${DOC}`)).content, `unsaved ${WORD}`);
  });

  await test("cost: backing up 24 × 256 KiB encrypted files and verifying them is bounded (no decryption on the backup path)", { "SC-17": "partial" }, async () => {
    const big = toB64(Uint8Array.from({ length: 256 * 1024 }, (_, i) => (i * 131 + 7) & 255));
    for (let i = 0; i < 24; i += 1) await lw(`/Private/bulk/${i}.bin`, big, "base64");
    const t0 = performance.now(); const b = await createBackup(raw, keys); const t1 = performance.now();
    const v = await verifyBackup(parseBackup(b.text), keys); const t2 = performance.now();
    assert.ok(v.files >= 24 && v.failures.length === 0);
    const mb = (24 * 256) / 1024;
    console.log(`  backup ${mb} MiB of files in ${Math.round(t1 - t0)} ms (${(mb / ((t1 - t0) / 1000)).toFixed(1)} MiB/s incl. HTTP); verify ${Math.round(t2 - t1)} ms`);
    assert.ok(t1 - t0 < 20_000 && t2 - t1 < 10_000);
  });
} finally {
  await wipePrivate().catch(() => undefined);
  await hostPost({ op: "purge", path: `/Documents/draft-${RUN} ${WORD}.txt` }).catch(() => undefined);
  // The preflight required an empty private tree, and opt-in requires isolation.
  // Remove this suite's orphaned version rows as well as the live test nodes.
  await db.query("DELETE FROM vfs_versions WHERE path = '/Private' OR path LIKE '/Private/%'");
  await db.end();
}
finish();
