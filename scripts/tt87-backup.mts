import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeHarness } from "./harness.mts";
import { BACKUP_VERSION, canonicalJson, contentSize, digestText, makeBackup, verifyBackup, type BackupPayload } from "../src/lib/backup/bundle.ts";

const { test, finish } = makeHarness("tt87-backup");
const at = "2026-10-27T01:00:00.000Z";
const text = "Résumé 🐚\n";
const payload: BackupPayload = {
  version: BACKUP_VERSION, exportedAt: at, kind: "data",
  entries: [{ path: "/Documents/résumé.txt", kind: "file", mime: "text/plain", encoding: "utf8", content: text,
    size: Buffer.byteLength(text), tags: "personal", sha256: await digestText(text) }],
  notes: [{ title: "Note", body: "hello", tags: "tag", pinned: true, createdAt: at, updatedAt: at }], settings: [],
};
const bundle = await makeBackup(payload);
const clone = <T,>(x: T): T => structuredClone(x);
const reject = async (x: unknown, clue?: RegExp) => {
  const result = await verifyBackup(x);
  assert.equal(result.ok, false, "malformed snapshot was accepted");
  if (!result.ok && clue) assert.match(result.failures.map((f) => f.reason).join(" "), clue);
};

await test("TT87 SHA-256 and canonical JSON match independent Node crypto, including Unicode and reordered object keys", { "BK-03": "partial" }, async () => {
  assert.equal(await digestText(text), createHash("sha256").update(text, "utf8").digest("hex"));
  assert.equal(bundle.manifest.sha256, createHash("sha256").update(canonicalJson(payload), "utf8").digest("hex"));
  assert.equal(canonicalJson({ z: "🐚", a: { c: 2, b: 1 } }), canonicalJson({ a: { b: 1, c: 2 }, z: "🐚" }));
  const reordered = JSON.parse(JSON.stringify(bundle, (_key, v) => v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).reverse()) : v));
  assert.equal((await verifyBackup(reordered)).ok, true);
});

await test("TT87 checksum covers file bytes, path, MIME, tags, deletion, note fields, timestamp and bundle kind", { "BK-01": "partial", "BK-03": "partial" }, async () => {
  const attacks: ((x: typeof bundle) => void)[] = [
    (b) => { b.entries[0].content += "!"; },
    (b) => { b.entries[0].path = "/Documents/other.txt"; },
    (b) => { b.entries[0].mime = "application/json"; },
    (b) => { b.entries[0].tags = "changed"; },
    (b) => { b.entries = []; },
    (b) => { b.notes[0].body += "!"; },
    (b) => { b.notes = []; },
    (b) => { b.exportedAt = "2026-10-27T02:00:00.000Z"; },
    (b) => { b.kind = "config"; },
    (b) => { b.entries[0].sha256 = "0".repeat(64); },
    (b) => { b.entries[0].size += 1; },
  ];
  for (const attack of attacks) { const b = clone(bundle); attack(b); await reject(b); }
});

await test("TT87 refuses at least 15 malformed, unsafe, duplicate and unbounded shapes even when a checksum is recomputed", { "BK-03": "partial" }, async () => {
  const badPayloads: ((p: any) => void)[] = [
    (p) => { p.entries[0].path = "/Documents/../outside"; },
    (p) => { p.entries[0].path = "/Documents//outside"; },
    (p) => { p.entries[0].path = "relative"; },
    (p) => { p.entries[0].path = "/Documents/\0bad"; },
    (p) => { p.entries.push(clone(p.entries[0])); },
    (p) => { p.entries[0].kind = "directory"; },
    (p) => { p.entries[0].encoding = "rot13"; },
    (p) => { p.entries[0].content = "%%%"; p.entries[0].encoding = "base64"; p.entries[0].size = 2; },
    (p) => { p.entries[0].size = -1; },
    (p) => { p.entries[0].tags = "nul\0"; },
    (p) => { p.entries[0].extra = "not covered by schema"; },
    (p) => { p.entries[0].kind = "dir"; },
    (p) => { p.entries.push({ ...clone(p.entries[0]), path: `${p.entries[0].path}/child` }); },
    (p) => { p.notes[0].pinned = "true"; },
    (p) => { p.notes[0].createdAt = "2026-02-30T00:00:00.000Z"; },
    (p) => { p.notes[0].createdAt = "0000-01-01T00:00:00.000Z"; },
    (p) => { p.notes[0].body = "unpaired \uD800"; },
    (p) => { p.notes[0].extra = "ignored?"; },
    (p) => { p.settings = [{ key: "a", value: "1" }]; },
    (p) => { p.entries[0].content = "x".repeat(8 * 1024 * 1024 + 1); },
  ];
  for (const mutate of badPayloads) { const p = clone(payload); mutate(p); await reject(await makeBackup(p)); }
  const cfg: BackupPayload = { version: BACKUP_VERSION, exportedAt: at, kind: "config", entries: [], notes: [], settings: [{ key: "appearance.theme", value: "dark" }] };
  const dup = clone(cfg); dup.settings.push(clone(dup.settings[0])); await reject(await makeBackup(dup), /duplicate/);
  const missing: any = clone(bundle); delete missing.manifest; await reject(missing, /checksum/);
  const invalid: any = clone(bundle); invalid.manifest.algorithm = "SHA-1"; await reject(invalid, /checksum/);
});

await test("TT87 base64 size counts decoded bytes, not characters; UTF-8 uses bytes rather than UTF-16 units", { "BK-01": "partial" }, () => {
  assert.equal(contentSize("YQ==", "base64"), 1);
  assert.equal(contentSize("YWJj", "base64"), 3);
  assert.equal(contentSize("YQ=", "base64"), -1);
  assert.equal(contentSize("💜", "utf8"), 4);
});

await test("TT87 legacy v1 requires a bijective manifest and explicitly warns of unprotected metadata, notes and settings", { "BK-01": "partial", "BK-03": "partial" }, async () => {
  const legacy = { version: "fusion-bundle-1", exportedAt: at, kind: "data", entries: [{ path: "/old.txt", kind: "file", mime: "text/plain", encoding: "utf8", content: text, sha256: await digestText(text) }],
    notes: [], settings: [{ key: "appearance.theme", value: "light" }], manifest: [{ path: "/old.txt", sha256: await digestText(text), size: text.length }] };
  const valid = await verifyBackup(legacy); assert.equal(valid.ok, true);
  if (valid.ok) { assert.equal(valid.legacy, true); assert.equal(valid.payload.settings.length, 0); assert.match(valid.warnings.join(" "), /not protected/); }
  const missing = clone(legacy); missing.manifest = []; await reject(missing, /manifest/);
  const extra = clone(legacy); extra.manifest.push({ ...extra.manifest[0], path: "/extra" }); await reject(extra, /do not match/);
  const dup = clone(legacy); dup.manifest.push(clone(dup.manifest[0])); await reject(dup, /duplicate/);
  const corrupt = clone(legacy); corrupt.entries[0].content += "!"; await reject(corrupt, /mismatch/);
});
finish();
