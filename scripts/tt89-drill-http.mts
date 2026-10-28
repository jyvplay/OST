/** HTTP tests against the isolated server and PostgreSQL; no real user data. */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { BACKUP_VERSION, makeBackup, type BackupEntry, type BackupPayload } from "../src/lib/backup/bundle.ts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing drill HTTP tests without TT89_DISPOSABLE_DATABASE=1 for a disposable server/database.");
const { test, finish } = makeHarness("tt89-drill-http");
const partial = { "BK-05": "partial" } as const;
const BASE = process.env.BASE ?? "http://localhost:3000";
const run = randomBytes(5).toString("hex"), at = "2026-10-01T12:00:00.000Z";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const file = (i: number): BackupEntry => {
  const content = `sample ${i} café`;
  return { path: `/tt89-${run}/file-${i}`, kind: "file", mime: "text/plain", encoding: "utf8", content, size: Buffer.byteLength(content), tags: "", sha256: hash(content) };
};
const folder = (i: number): BackupEntry => ({ path: `/tt89-${run}/empty-${i}`, kind: "dir", mime: "inode/directory", encoding: "utf8", content: "", size: 0, tags: "", sha256: hash("") });
const payload: BackupPayload = { version: BACKUP_VERSION, exportedAt: at, kind: "data", settings: [],
  entries: [...Array.from({ length: 15 }, (_, i) => file(i)), ...Array.from({ length: 10 }, (_, i) => folder(i))],
  notes: Array.from({ length: 11 }, (_, i) => ({ title: `note ${i}`, body: "body", tags: "", pinned: false, createdAt: at, updatedAt: at })) };
const bundle = await makeBackup(payload);
const post = async (body: unknown) => {
  const r = await fetch(`${BASE}/api/backup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const config = async (settings: { key: string; value: string }[]) => makeBackup({ version: BACKUP_VERSION, exportedAt: at, kind: "config", entries: [], notes: [], settings });

await test("sampled scratch restore works through HTTP and reports sample and total separately", partial, async () => {
  const r = await post({ bundle, drill: true }); assert.equal(r.status, 200); assert.equal(r.body.verified, true);
  assert.deepEqual(r.body.drill.sampled, { files: 12, folders: 8, notes: 8, settings: 0 });
  assert.deepEqual(r.body.drill.total, { files: 15, folders: 10, notes: 11, settings: 0 }); assert.equal(r.body.drill.skippedSettings, 0);
  assert.equal("restored" in r.body, false); assert.equal("previewToken" in r.body, false);
});
await test("tampering content, metadata or the complete manifest fails validation before drill", partial, async () => {
  for (const changed of [
    { ...bundle, entries: bundle.entries.map((e, i) => i ? e : { ...e, content: "tampered" }) },
    { ...bundle, entries: bundle.entries.map((e, i) => i ? e : { ...e, tags: "tampered" }) },
    { ...bundle, manifest: { ...bundle.manifest, sha256: "0".repeat(64) } },
  ]) { const r = await post({ bundle: changed, drill: true }); assert.equal(r.status, 409); assert.equal(r.body.verified, false); assert.equal(r.body.restored, 0); }
});
await test("wrong type, extra restore controls and non-JSON backup body are rejected", partial, async () => {
  assert.equal((await post({ bundle, drill: "true" })).status, 400);
  for (const field of [{ dryRun: true }, { dryRun: false }, { previewToken: "x" }, { allowLegacy: true }]) {
    const r = await post({ bundle, drill: true, ...field }); assert.equal(r.status, 400); assert.match(r.body.error, /cannot be combined/);
  }
  assert.equal((await post({ bundle: null, drill: true })).status, 409);
  assert.equal((await post({ bundle: [], drill: true })).status, 409);
  const r = await fetch(`${BASE}/api/backup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" }); assert.equal(r.status, 400);
});
await test("empty snapshot or all-unknown settings cannot give a pass", partial, async () => {
  const empty = await makeBackup({ ...payload, entries: [], notes: [] });
  const e = await post({ bundle: empty, drill: true }); assert.equal(e.status, 422); assert.match(e.body.error, /empty/i);
  const u = await post({ bundle: await config([{ key: `missing.${run}`, value: "x" }]), drill: true });
  assert.equal(u.status, 422); assert.match(u.body.error, /None of the sampled settings/);
});
await test("invalid known setting is rejected even if attacker recomputes the plain checksum", partial, async () => {
  const bad = await config([{ key: "appearance.theme", value: "not-a-theme" }]);
  const r = await post({ bundle: bad, drill: true }); assert.equal(r.status, 422); assert.match(r.body.error, /Invalid setting/);
});
await test("mixed current, locked and unknown settings are honestly reported as skipped", partial, async () => {
  const b = await config([{ key: "appearance.theme", value: "light" }, { key: "system.seedVersion", value: "other" }, { key: `missing.${run}`, value: "x" }]);
  const r = await post({ bundle: b, drill: true }); assert.equal(r.status, 200); assert.equal(r.body.drill.sampled.settings, 3); assert.equal(r.body.drill.skippedSettings, 2);
});
await test("legacy bundle can be drilled non-destructively but is labelled legacy with warning", partial, async () => {
  const entry = file(0);
  const legacy = { version: "fusion-bundle-1", exportedAt: at, kind: "data", entries: [{ ...entry }], manifest: [{ path: entry.path, sha256: entry.sha256, size: entry.content.length }], notes: [], settings: [] };
  const r = await post({ bundle: legacy, drill: true }); assert.equal(r.status, 200); assert.equal(r.body.legacy, true);
  assert.ok(r.body.warnings.some((w: string) => /Legacy.*metadata/i.test(w))); assert.equal(r.body.drill.sampled.files, 1);
});
await test("duplicate paths, parent-as-file, unsafe paths and invalid binary input are refused even with a new manifest", partial, async () => {
  const one = file(1);
  const badCases = [
    [one, one],
    [one, { ...file(2), path: `${one.path}/child` }],
    [{ ...one, path: "/../escape" }],
    [{ ...one, encoding: "base64", content: "!bad!", size: 4, sha256: hash("!bad!") }],
  ] as BackupEntry[][];
  for (const entries of badCases) {
    const b = await makeBackup({ ...payload, entries, notes: [] }); const r = await post({ bundle: b, drill: true });
    assert.equal(r.status, 409); assert.equal(r.body.verified, false);
  }
});
await test("a ciphertext envelope sent directly to the server is not treated as a decrypted bundle", partial, async () => {
  const r = await post({ drill: true, bundle: { format: "fusion-encrypted-bundle-2", envelope: {} } });
  assert.equal(r.status, 409); assert.equal(r.body.verified, false);
});
finish();
