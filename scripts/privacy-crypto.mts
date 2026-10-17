/**
 * TT18 privacy suite 1 — the Encrypted Persistent Storage format (src/lib/privacy/pcrypt.ts).
 *
 * External verification: scripts/oracles/privacy_crypto.py re-implements the format from its spec
 * with pyca/cryptography (OpenSSL) and argon2-cffi (reference C Argon2). Every format claim is
 * checked in BOTH directions (ours → oracle, oracle → ours), plus adversarial header/blob edits.
 * Fails loudly if the oracle Python is missing.
 *
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/privacy-crypto.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import {
  ARGON2_DEFAULT, changePassphrase, createVolume, decryptContent, decryptName, decryptPath, deriveKek, encryptContent,
  encryptName, encryptPath, fromB64, importVolumeKeysForTest, padme, parseHeader, rotateRecoveryKey, toB64, unlockVolume,
  type KdfParams, type KeyHeader,
} from "../src/lib/privacy/pcrypt.ts";

const { test, finish } = makeHarness("privacy-crypto");
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const oracle = (req: Record<string, unknown>) => {
  const out = JSON.parse(execFileSync(PY, ["scripts/oracles/privacy_crypto.py"], { input: JSON.stringify(req), encoding: "utf8", timeout: 120_000 }));
  if (out.error) throw new Error(`oracle: ${out.error}`);
  return out;
};
const FAST: KdfParams = { kdf: "argon2id", m: 19456, t: 2, p: 1 }; // the policy floor — keeps the suite quick
const enc = new TextEncoder();
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const rejects = async (p: Promise<unknown>, re: RegExp, msg: string) => {
  try { await p; } catch (e) { assert.match(String((e as Error).message), re, msg); return; }
  assert.fail(`${msg}: expected a rejection`);
};

await test("Argon2id (hash-wasm) equals the reference C implementation (argon2-cffi), incl. the default 64 MiB/t=3 slot cost", { "SC-10": "partial" }, async () => {
  const cases: { pw: string; m: number; t: number; p: number }[] = [
    { pw: "correct horse battery staple", m: 19456, t: 2, p: 1 },
    { pw: "pässwörd ✓", m: 32768, t: 3, p: 4 },
    { pw: "tails-like", ...{ m: ARGON2_DEFAULT.m, t: ARGON2_DEFAULT.t, p: ARGON2_DEFAULT.p } },
  ];
  for (const c of cases) {
    const salt = Uint8Array.from({ length: 16 }, (_, i) => (i * 37 + c.m) & 255);
    const ours = await deriveKek(c.pw, salt, { kdf: "argon2id", m: c.m, t: c.t, p: c.p });
    // NFKC is applied on our side; these passwords are already NFKC-stable
    const theirs = oracle({ op: "argon2", password: c.pw.normalize("NFKC"), salt_b64: toB64(salt), m: c.m, t: c.t, p: c.p }).hex;
    assert.equal(hex(ours), theirs, `argon2id m=${c.m} t=${c.t} p=${c.p}`);
  }
  const salt = new Uint8Array(16).fill(7);
  assert.equal(hex(await deriveKek("pbkdf2 fallback", salt, { kdf: "pbkdf2-sha256", iterations: 600_000 })),
    oracle({ op: "pbkdf2", password: "pbkdf2 fallback", salt_b64: toB64(salt), iterations: 600_000 }).hex);
});

await test("Padmé equals the paper's pseudocode on 20 000 lengths; overhead ≤ 12%; hand-derived points", { "SC-10": "partial" }, async () => {
  // hand-derived from Algorithm 1: 9→10, 100→104, 1000→1024, 1025→1088, 4→4, 0→0, 1→1
  for (const [L, P] of [[0, 0], [1, 1], [4, 4], [9, 10], [100, 104], [1000, 1024], [1025, 1088]]) assert.equal(padme(L), P, `padme(${L})`);
  const lengths = [...Array.from({ length: 10000 }, (_, i) => i), ...Array.from({ length: 10000 }, (_, i) => 10000 + i * 997)];
  const theirs = oracle({ op: "padme", lengths }).padded as number[];
  let maxOver = 0;
  lengths.forEach((L, i) => {
    assert.equal(padme(L), theirs[i], `padme(${L})`);
    assert.ok(padme(L) >= L);
    if (L >= 2) maxOver = Math.max(maxOver, (padme(L) - L) / L);
  });
  assert.ok(maxOver <= 0.12, `max overhead ${maxOver}`);
  // leakage: lengths in [2^20, 2^21) round to multiples of 2^(E−S) = 2^15, and the top of the range rounds UP
  // to 2^21 itself → at most 2^S + 1 = 33 distinct sizes (≈5.04 bits; my first bound of 32 forgot the endpoint)
  const distinct = new Set<number>();
  for (let L = 1 << 20; L < 1 << 21; L += 257) distinct.add(padme(L));
  assert.ok(distinct.size <= 33, `distinct padded sizes ${distinct.size}`);
  assert.ok(distinct.has(1 << 21), "the endpoint case that the first bound missed");
});

await test("volume life-cycle: create → unlock by passphrase or recovery key (any case/separators) → wrong secret refused", { "SC-10": "partial", "BK-06": "partial" }, async () => {
  const { header, recoveryKey } = await createVolume("five random words here please", { kdf: FAST });
  assert.ok(recoveryKey && /^([A-Z0-9]{4}-){7}[A-Z0-9]{4}$/.test(recoveryKey), `recovery key format ${recoveryKey}`);
  assert.equal(header.slots.length, 2);
  parseHeader(JSON.stringify(header));
  assert.equal((await unlockVolume(header, "five random words here please")).slot.kind, "passphrase");
  assert.equal((await unlockVolume(header, recoveryKey!.toLowerCase().replace(/-/g, " "))).slot.kind, "recovery");
  await rejects(unlockVolume(header, "five random words here pleasE"), /wrong passphrase/, "near-miss passphrase");
  await rejects(createVolume("short"), /at least 8/, "short passphrase");
});

await test("change passphrase rewraps one slot only: old files still open, old passphrase refused, recovery still works; rotate recovery kills the old key", { "SC-10": "full", "BK-06": "full" }, async () => {
  const { header, keys, recoveryKey } = await createVolume("original passphrase", { kdf: FAST });
  const blob = await encryptContent(keys, { data: enc.encode("written before the change"), mime: "text/plain", encoding: "utf8" });
  const h2 = await changePassphrase(header, "original passphrase", "replacement passphrase", FAST);
  assert.equal(h2.volumeId, header.volumeId);
  assert.notEqual(h2.slots[0].wrapped, header.slots[0].wrapped);
  assert.equal(h2.slots[1].wrapped, header.slots[1].wrapped, "recovery slot untouched");
  await rejects(unlockVolume(h2, "original passphrase"), /wrong passphrase/, "old passphrase after change");
  const { keys: k2 } = await unlockVolume(h2, "replacement passphrase");
  assert.equal(new TextDecoder().decode((await decryptContent(k2, blob)).data), "written before the change", "no re-encryption needed");
  await unlockVolume(h2, recoveryKey!);
  await rejects(changePassphrase(h2, "original passphrase", "whatever passphrase", FAST), /current passphrase is wrong/, "change with wrong current");
  const { header: h3, recoveryKey: r2 } = await rotateRecoveryKey(h2, "replacement passphrase", FAST);
  await rejects(unlockVolume(h3, recoveryKey!), /wrong passphrase/, "old recovery key after rotation");
  await unlockVolume(h3, r2);
});

await test("header attacks: KDF downgrade (still above floor) breaks the slot tag; below-floor refused before derivation; slot swap / truncation refused", { "SC-10": "full" }, async () => {
  const { header } = await createVolume("header attack passphrase", { kdf: { kdf: "argon2id", m: 19456, t: 3, p: 1 } });
  const down: KeyHeader = JSON.parse(JSON.stringify(header));
  (down.slots[0].kdf as { t: number }).t = 2; // attacker lowers the cost, hoping we derive the weaker key
  await rejects(unlockVolume({ ...down, slots: [down.slots[0]] }, "header attack passphrase"), /wrong passphrase|modified/, "downgraded t");
  const floor: KeyHeader = JSON.parse(JSON.stringify(header));
  (floor.slots[0].kdf as { m: number }).m = 1024;
  const t0 = performance.now();
  assert.throws(() => parseHeader(JSON.stringify(floor)), /below policy floor/);
  await rejects(unlockVolume(floor, "header attack passphrase"), /below policy floor/, "m=1 MiB");
  assert.ok(performance.now() - t0 < 200, "refused before any expensive derivation");
  const pb: KeyHeader = JSON.parse(JSON.stringify(header));
  pb.slots[0].kdf = { kdf: "pbkdf2-sha256", iterations: 1000 };
  assert.throws(() => parseHeader(JSON.stringify(pb)), /below policy floor/);
  const swap: KeyHeader = JSON.parse(JSON.stringify(header));
  [swap.slots[0].wrapped, swap.slots[1].wrapped] = [swap.slots[1].wrapped, swap.slots[0].wrapped];
  await rejects(unlockVolume(swap, "header attack passphrase"), /wrong passphrase|modified/, "swapped wrapped keys");
  const otherVol: KeyHeader = { ...header, volumeId: toB64(new Uint8Array(16).fill(9)) };
  await rejects(unlockVolume(otherVol, "header attack passphrase"), /wrong passphrase|modified/, "volumeId replaced");
  assert.throws(() => parseHeader(JSON.stringify({ ...header, slots: [] })), /1–8 keyslots/);
  assert.throws(() => parseHeader(JSON.stringify({ ...header, format: "fusion-private-0" })), /not a Fusion/);
});

await test("oracle unwraps OUR keyslot (passphrase and recovery) to the DEK that decrypts OUR blob — end-to-end format conformance", { "SC-10": "full" }, async () => {
  const { header, keys, recoveryKey } = await createVolume("oracle cross check", { kdf: FAST });
  const blob = await encryptContent(keys, { data: enc.encode("ciphertext the oracle must open"), mime: "text/markdown", encoding: "utf8" });
  const viaPass = oracle({ op: "unwrap", header, secret: "oracle cross check" });
  const viaRec = oracle({ op: "unwrap", header, secret: recoveryKey!.toLowerCase() });
  assert.equal(viaPass.dek_b64, viaRec.dek_b64, "both slots wrap the same DEK");
  const d = oracle({ op: "decrypt", dek_b64: viaPass.dek_b64, volume_b64: header.volumeId, blob_b64: toB64(blob) });
  assert.equal(Buffer.from(d.data_b64, "base64").toString(), "ciphertext the oracle must open");
  assert.equal(d.mime, "text/markdown"); assert.equal(d.encoding, "utf8"); assert.equal(d.padding_all_zero, true);
});

await test("content blobs: oracle ⇄ ours both directions; Padmé-sized; any bit flip, flag edit or foreign volume refused", { "SC-10": "full" }, async () => {
  const dek = Uint8Array.from({ length: 32 }, (_, i) => i * 7 + 1);
  const vol = Uint8Array.from({ length: 16 }, (_, i) => 200 - i);
  const k = await importVolumeKeysForTest(dek, vol);
  const bin = Uint8Array.from({ length: 5000 }, (_, i) => (i * 131) & 255);
  const ours = await encryptContent(k, { data: bin, mime: "image/png", encoding: "base64" });
  assert.equal(ours.length, 4 + 2 + 12 + padme(4 + 1 + 9 + 1 + 5000) + 16, "stored size = header + Padmé(payload) + tag");
  const d = oracle({ op: "decrypt", dek_b64: toB64(dek), volume_b64: toB64(vol), blob_b64: toB64(ours) });
  assert.equal(d.data_b64, toB64(bin)); assert.equal(d.mime, "image/png"); assert.equal(d.encoding, "base64");
  const theirs = fromB64(oracle({ op: "encrypt", dek_b64: toB64(dek), volume_b64: toB64(vol), data_b64: toB64(enc.encode("from python ✓")), mime: "text/plain", encoding: "utf8" }).blob_b64);
  const p = await decryptContent(k, theirs);
  assert.equal(new TextDecoder().decode(p.data), "from python ✓"); assert.equal(p.mime, "text/plain");
  for (const i of [0, 5, 6, 17, 18, 40, ours.length - 1]) {
    const t = ours.slice(); t[i] ^= 0x01;
    await rejects(decryptContent(k, t), /authentication failed|not an encrypted|unsupported/, `bit flip at ${i}`);
  }
  const other = await importVolumeKeysForTest(dek, new Uint8Array(16).fill(1));
  await rejects(decryptContent(other, ours), /authentication failed/, "same DEK, other volume id");
  const sameLen = await encryptContent(k, { data: bin, mime: "image/png", encoding: "base64" });
  assert.notEqual(toB64(sameLen), toB64(ours), "fresh IV per write");
});

await test("names: deterministic SIV encryption byte-identical to the oracle; host-chosen nonce rejected; paths map both ways", { "SC-10": "full" }, async () => {
  const dek = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
  const vol = Uint8Array.from({ length: 16 }, (_, i) => i);
  const k = await importVolumeKeysForTest(dek, vol);
  for (const name of ["divorce-lawyer.docx", "Résumé 2026.pdf", "日本語.txt", "a"]) {
    const ours = await encryptName(k, name);
    assert.equal(ours, oracle({ op: "name", dek_b64: toB64(dek), volume_b64: toB64(vol), name }).enc, `name ${name}`);
    assert.equal(await encryptName(k, name), ours, "deterministic");
    assert.equal(await decryptName(k, ours), name);
    assert.ok(!ours.includes(name.slice(0, 3)) || name.length < 3, "name not visible");
  }
  const bad = oracle({ op: "name_bad_iv", dek_b64: toB64(dek), volume_b64: toB64(vol), name: "planted.txt" }).enc;
  assert.equal(oracle({ op: "name_dec", dek_b64: toB64(dek), volume_b64: toB64(vol), enc: bad }).name, "planted.txt", "valid GCM under the right key");
  await rejects(decryptName(k, bad), /synthetic-IV mismatch/, "non-SIV nonce");
  const p = "/Private/Taxes/2026/return.pdf";
  const e = await encryptPath(k, p);
  assert.match(e, /^\/Private\/~[\w-]+\/~[\w-]+\/~[\w-]+$/);
  assert.deepEqual(await decryptPath(k, e), { path: p, ok: true });
  assert.equal(await encryptPath(k, "/Private/.keyslots.json"), "/Private/.keyslots.json", "header keeps its reserved clear name");
  assert.equal(await encryptPath(k, "/Documents/x.txt"), "/Documents/x.txt", "outside Persistent Storage untouched");
  const foreign = await importVolumeKeysForTest(dek, new Uint8Array(16).fill(3));
  assert.equal((await decryptPath(foreign, e)).ok, false, "another volume cannot read the names");
});

await test("base64 codec (perf path): byte-identical to Node Buffer on 6 000 random inputs 0–299 B, strict on malformed input, 264 KiB encode < 5 ms", { "SC-10": "partial" }, async () => {
  const { randomBytes } = await import("node:crypto");
  const { toB64, fromB64 } = await import("../src/lib/privacy/pcrypt.ts");
  for (let len = 0; len < 300; len++) for (let r = 0; r < 20; r++) {
    const b = new Uint8Array(randomBytes(len)); const ref = Buffer.from(b).toString("base64");
    assert.equal(toB64(b), ref, `encode len ${len}`);
    assert.equal(Buffer.compare(Buffer.from(fromB64(ref)), Buffer.from(b)), 0, `decode len ${len}`);
  }
  for (const bad of ["a", "ab!d", "abc*", "ab=d=", "€abc"]) assert.throws(() => fromB64(bad), undefined, `accepted ${bad}`);
  assert.equal(Buffer.from(fromB64("aGVs\nbG8=")).toString(), "hello");
  const big = new Uint8Array(randomBytes(270_370)); toB64(big);
  const t0 = performance.now(); for (let i = 0; i < 5; i++) toB64(big); const ms = (performance.now() - t0) / 5;
  assert.ok(ms < 5, `encode ${ms.toFixed(2)} ms`);
});

finish();
