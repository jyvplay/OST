import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { makeHarness } from "./harness.mts";
import { MAX_BACKUP_BYTES } from "../src/lib/backup/bundle.ts";
import { makeRecoveryKey, normalizeRecoveryKey, openRecoveryBundle, RECOVERY_FORMAT, sealRecoveryBundle } from "../src/lib/backup/recovery.ts";

const { test, finish } = makeHarness("tt88-recovery");
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const passphrase = "correct horse 🐚 battery";
const recovery = makeRecoveryKey();
const payload = JSON.stringify({ contents: "Résumé 🐚", settings: ["appearance.theme"] });
const bundle = await sealRecoveryBundle(payload, passphrase, recovery);
const oracle = (operation: "open" | "seal", value: object) => JSON.parse(execFileSync(PY, ["scripts/oracle/recovery_crypto.py"], {
  input: JSON.stringify({ operation, passphrase, recovery, ...value }), encoding: "utf8",
}));
const flipped = (value: string) => { const bytes = Buffer.from(value, "base64"); bytes[0] ^= 1; return bytes.toString("base64"); };
const reject = async (value: unknown, method: "passphrase" | "recovery", secret: string) => {
  await assert.rejects(openRecoveryBundle(value, method, secret), (e: Error) => !e.message.includes(secret) && e.message.length > 0);
};

await test("BK-06 Web Crypto output opens with both credentials in independent Python cryptography", { "BK-06": "full" }, async () => {
  assert.equal(oracle("open", { bundle }).plaintext, payload);
  assert.equal(await openRecoveryBundle(bundle, "passphrase", passphrase), payload);
  assert.equal(await openRecoveryBundle(bundle, "recovery", recovery.toLowerCase()), payload);
});
await test("BK-06 independently encrypted Python envelope opens with both Web Crypto slots", { "BK-06": "full" }, async () => {
  const independent = oracle("seal", { plaintext: payload });
  assert.equal(await openRecoveryBundle(independent, "passphrase", passphrase), payload);
  assert.equal(await openRecoveryBundle(independent, "recovery", recovery), payload);
});
await test("BK-06 random 256-bit recovery keys have exact portable format and no repeats in a 100-key sample", { "BK-06": "partial" }, () => {
  const sample = Array.from({ length: 100 }, makeRecoveryKey);
  assert.equal(new Set(sample).size, 100);
  for (const key of sample) { assert.match(key, /^FSR1(?:-[0-9A-F]{8}){8}$/); assert.equal(normalizeRecoveryKey(`  ${key.toLowerCase()}  `), key); }
  for (const bad of ["", "FSR1", recovery.slice(0, -1), recovery + "-00000000", recovery.replace("FSR1", "FSR2"), recovery.replace(/A/, "Z"), recovery.replace(/-/g, "")]) {
    if (bad !== recovery) assert.throws(() => normalizeRecoveryKey(bad));
  }
});
await test("BK-06 missing secure-context Web Crypto fails closed rather than generating an unusable key", { "BK-06": "partial" }, () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  try {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: () => { throw new Error("must not run"); } } });
    assert.throws(makeRecoveryKey, /Secure-context Web Crypto is unavailable/);
  } finally { Object.defineProperty(globalThis, "crypto", original); }
});
await test("BK-06 wrong passphrase, wrong valid recovery key and malformed key are rejected without echoing the secrets", { "BK-06": "full" }, async () => {
  await reject(bundle, "passphrase", "wrong secret");
  await reject(bundle, "recovery", makeRecoveryKey());
  await reject(bundle, "recovery", "not-a-recovery-key");
});
await test("BK-06 every stored byte field and work factor is authenticated when opening through either slot", { "BK-06": "full" }, async () => {
  for (const field of ["salt", "passIv", "passWrapped", "recoveryIv", "recoveryWrapped", "dataIv", "data"] as const) {
    const changed = { ...bundle, [field]: flipped(bundle[field]) };
    await reject(changed, "passphrase", passphrase);
    await reject(changed, "recovery", recovery);
  }
  const changed = { ...bundle, iterations: bundle.iterations + 1 };
  await reject(changed, "passphrase", passphrase); await reject(changed, "recovery", recovery);
});
await test("BK-06 swapping another archive's password slot cannot hide damage from either legitimate credential", { "BK-06": "full" }, async () => {
  const other = await sealRecoveryBundle(payload, passphrase, recovery);
  const changed = { ...bundle, salt: other.salt, passIv: other.passIv, passWrapped: other.passWrapped };
  await reject(changed, "passphrase", passphrase); await reject(changed, "recovery", recovery);
  assert.notEqual(bundle.salt, other.salt); assert.notEqual(bundle.dataIv, other.dataIv);
});
await test("BK-06 schema, algorithms, canonical base64, size and KDF limits fail before unlock", { "BK-06": "full" }, async () => {
  const bad: unknown[] = [null, [], {}, { ...bundle, format: "wrong" }, { ...bundle, cipher: "AES-CBC" }, { ...bundle, kdf: "none" },
    { ...bundle, iterations: 599999 }, { ...bundle, iterations: 2000001 }, { ...bundle, iterations: 600000.5 },
    { ...bundle, extra: true }, { ...bundle, salt: "!!!!" }, { ...bundle, salt: "YQ==" },
    { ...bundle, salt: "YR==" }, { ...bundle, data: "" }, { ...bundle, passIv: "" },
    { ...bundle, data: "A".repeat(Math.ceil((MAX_BACKUP_BYTES + 16) / 3) * 4 + 4) }];
  for (const candidate of bad) await reject(candidate, "recovery", recovery);
  // Alter only unused padding bits in the data encoding: the decoded bytes and
  // tag remain identical, so this specifically tests canonical encoding.
  const tiny = await sealRecoveryBundle("x", passphrase, recovery);
  assert.ok(tiny.data.endsWith("=") && !tiny.data.endsWith("=="));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const at = tiny.data.length - 2;
  const noncanonical = tiny.data.slice(0, at) + alphabet[alphabet.indexOf(tiny.data[at]) | 1] + tiny.data.slice(at + 1);
  assert.deepEqual(Buffer.from(noncanonical, "base64"), Buffer.from(tiny.data, "base64"));
  await reject({ ...tiny, data: noncanonical }, "recovery", recovery);
  // These two envelopes have *valid* tags at the forbidden work factors; a
  // floor/ceiling mutation must be caught, not hidden by a later AAD failure.
  for (const iterations of [599999, 2000001]) {
    const validButDisallowed = oracle("seal", { plaintext: payload, iterations });
    await reject(validButDisallowed, "recovery", recovery);
  }
});
await test("BK-06 reordered JSON keys are equivalent, but only this explicit format is accepted", { "BK-06": "partial" }, async () => {
  const reordered = Object.fromEntries(Object.entries(bundle).reverse());
  assert.equal(await openRecoveryBundle(reordered, "recovery", recovery), payload);
  assert.equal(bundle.format, RECOVERY_FORMAT);
  await assert.rejects(sealRecoveryBundle("a", "short", recovery));
});
finish();
