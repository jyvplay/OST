/**
 * TT70 FF-15 sealed recovery drafts — pure logic plus an outside decryptor.
 *  1. round trip: a .docx-shaped ZIP sealed with the document password opens to the identical bytes; the key
 *     derivation is cached in the caller's key object (the second seal does not re-derive).
 *  2. a wrong password, a case change, an empty password: refused as "password" (not "corrupt"); never throws.
 *  3. damage: non-base64, base64 of plaintext, a truncated container, a flipped ciphertext byte — never opens and is
 *     reported as damage, not as a wrong password (the HMAC integrity check catches the bit flip).
 *  4. no leak: the sealed bytes contain neither the password (UTF-8 / UTF-16LE) nor a plaintext marker.
 *  5. restoredProtection: never weaker than before — the file's current password wins; an unprotected file adopts
 *     the draft's password; a plain draft changes nothing; a still-locked file stays locked.
 *  6. the draft codec accepts encoding "sealed" with base64 and refuses it otherwise.
 *  7. Spreadsheet packing: the JSON travels as a one-entry ZIP; unicode round-trips; other ZIPs are refused.
 *  8. outside oracle: msoffcrypto-tool (MIT, HMAC verification on) decrypts both kinds of sealed draft with the
 *     password, python-docx reads the Writer one, and the wrong password fails there too.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt70-seal.mts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { DRAFT_ENTRY, openSealedDraft, packDraftText, restoredProtection, sealDraft, unpackDraftText, type ProtLike, type SealKey } from "../src/lib/office/draft-seal.ts";
import { decodeDraft, encodeDraft, type DraftRecord } from "../src/lib/doc-lifecycle.ts";
import { openZip, writeZip } from "../src/lib/office/zipkit.ts";

const { test, finish } = makeHarness("tt70-seal");
const FULL = { "FF-15": "full" } as const;
const PY = "/home/user/tools/venv/bin/python";
const tmp = mkdtempSync(join(tmpdir(), "tt70seal-"));
const PW = "Tr0ub4dor&3-ünï";
const MARK = "PLAINTEXT-MARKER-7f3a";
const docxLike = () => writeZip([
  { name: "[Content_Types].xml", data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
  { name: "word/document.xml", data: `<w:document><w:body><w:p><w:r><w:t>${MARK}</w:t></w:r></w:p></w:body></w:document>`, store: true },
]);
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
const has = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay).indexOf(Buffer.from(needle)) >= 0;
function msoff(bytes: Uint8Array, pw: string): { ok: boolean; plain?: Uint8Array; error?: string } {
  const i = join(tmp, `m${Math.random().toString(36).slice(2)}`), o = i + ".out"; writeFileSync(i, bytes);
  const r = JSON.parse(execFileSync(PY, ["scripts/oracle/msoff_decrypt.py"], { input: `${i}\t${pw}\t${o}\n` }).toString().trim());
  return r.ok ? { ok: true, plain: new Uint8Array(readFileSync(o)) } : { ok: false, error: r.error };
}

const plain = await docxLike();
const k: SealKey = { password: PW, key: null };
let sealed = "";

await test("round trip: the sealed draft opens with the password to the identical bytes; the key derivation is cached", FULL, async () => {
  const t0 = performance.now(); sealed = sealDraft(plain, k); const first = performance.now() - t0;
  assert.ok(k.key, "the derived key is cached in the caller's key object");
  const r = openSealedDraft(sealed, PW); assert.ok(r.ok, "opens");
  if (r.ok) assert.deepEqual(Buffer.from(r.bytes), Buffer.from(plain));
  const keyBefore = k.key;
  const t1 = performance.now(); const again = sealDraft(plain, k); const second = performance.now() - t1;
  assert.equal(k.key, keyBefore, "the cached key is reused, not re-derived");
  assert.ok(second < first, `the cached seal is faster (${second.toFixed(0)} ms vs ${first.toFixed(0)} ms)`);
  assert.notEqual(again, sealed, "two seals of the same draft differ (fresh IV / data key per container)");
  assert.throws(() => sealDraft(plain, { password: "", key: null }), /password/);
});

await test("a wrong password, a case change and an empty password are refused as 'password', without throwing", FULL, () => {
  for (const bad of ["wrong", PW.toUpperCase(), PW.slice(0, -1), PW + " ", ""]) {
    const r = openSealedDraft(sealed, bad);
    assert.equal(r.ok, false, `refused: ${JSON.stringify(bad)}`);
    if (!r.ok) assert.equal(r.reason, "password", `reason for ${JSON.stringify(bad)}: ${r.message}`);
  }
});

await test("damage is never opened and never mistaken for a wrong password: non-base64, plaintext, truncation, a flipped byte", FULL, () => {
  const raw = Buffer.from(sealed, "base64");
  const cases: [string, string][] = [
    ["non-base64", "@@not base64@@"], ["plaintext docx", b64(plain)], ["truncated", b64(raw.subarray(0, raw.length >> 1))], ["empty", ""],
  ];
  for (const [name, p] of cases) {
    const r = openSealedDraft(p, PW);
    assert.equal(r.ok, false, `${name} must not open`);
    if (!r.ok) assert.equal(r.reason, "corrupt", `${name} → ${r.reason}: ${r.message}`);
  }
  assert.equal(openSealedDraft(42 as unknown as string, PW).ok, false, "a non-string payload is refused");
  // single-bit tampering at 48 positions spread over the container: it either fails (as damage or, if it hit the
  // key-verifier, as a wrong password) or — CFB sector slack / unused fields — opens to EXACTLY the original bytes.
  // Never to different content: the HMAC over the encrypted package covers every byte that reaches the plaintext.
  let refused = 0, slack = 0;
  for (let i = 0; i < 48; i++) {
    const pos = Math.floor((i + 0.5) * raw.length / 48);
    const t = Buffer.from(raw); t[pos] ^= 1 << (i % 8);
    const r = openSealedDraft(b64(t), PW);
    if (!r.ok) refused++;
    else { assert.deepEqual(Buffer.from(r.bytes), Buffer.from(plain), `bit flip at ${pos} changed the plaintext undetected`); slack++; }
  }
  assert.ok(refused > 0, "some flips must be detected");
  console.log(`    (bit flips: ${refused} refused, ${slack} in slack — identical plaintext)`);
});

await test("no leak: the sealed bytes contain neither the password (UTF-8 / UTF-16LE) nor the plaintext marker", FULL, () => {
  const raw = new Uint8Array(Buffer.from(sealed, "base64"));
  assert.ok(raw[0] === 0xd0 && raw[1] === 0xcf, "a CFB (encrypted Office) container");
  assert.ok(!has(raw, Buffer.from(PW, "utf8")) && !has(raw, Buffer.from(PW, "utf16le")), "password absent");
  assert.ok(!has(raw, Buffer.from(MARK)), "document text absent");
  assert.ok(has(plain, Buffer.from(MARK)), "(control: the marker IS in the plaintext)");
});

await test("restoredProtection never weakens: the file's password wins; an unprotected file adopts the draft's; plain drafts change nothing", FULL, () => {
  const prot = (o: Partial<ProtLike>): ProtLike => ({ path: "/d/a.docx", password: null, key: null, wasEncrypted: true, removed: false, ...o });
  const cur = prot({ password: "P2" });
  assert.equal(restoredProtection(cur, "P1", "/d/a.docx"), cur, "the file's current password wins over the draft's");
  assert.equal(restoredProtection(cur, null, "/d/a.docx"), cur, "a plain draft over a protected file keeps the protection");
  const adopted = restoredProtection(null, "P1", "/d/a.docx");
  assert.deepEqual(adopted, { path: "/d/a.docx", wasEncrypted: false, password: "P1", key: null, removed: false }, "an unprotected file adopts the draft's password");
  const lockedOne = prot({});
  const fromLocked = restoredProtection(lockedOne, "P1", "/d/a.docx");
  assert.equal(fromLocked?.password, "P1"); assert.equal(fromLocked?.wasEncrypted, true); assert.equal(fromLocked?.removed, false);
  assert.equal(restoredProtection(lockedOne, null, "/d/a.docx"), lockedOne, "a still-locked file stays locked (plain draft)");
  assert.equal(restoredProtection(null, null, "/d/a.docx"), null, "unprotected + plain draft: unprotected");
  const withExtra = { ...prot({ password: "P2" }), plain: new Uint8Array([1]) };
  assert.equal(restoredProtection(withExtra, "P1", "/d/a.docx"), withExtra, "extra fields (Spreadsheet's plain package) are kept");
});

await test("the draft codec accepts encoding 'sealed' only with a base64 payload", FULL, () => {
  const rec: DraftRecord = { v: 1, kind: "writer", path: "/Documents/a.docx", title: "a.docx", savedAt: Date.now(), baseSha: null, encoding: "sealed", payload: sealed };
  const back = decodeDraft(encodeDraft(rec), "writer");
  assert.ok(back, "decodes"); assert.equal(back!.encoding, "sealed"); assert.equal(back!.payload, sealed);
  assert.equal(decodeDraft(encodeDraft({ ...rec, payload: "not base64 !" }), "writer"), null, "a non-base64 sealed payload is refused");
  assert.equal(decodeDraft(JSON.stringify({ ...rec, encoding: "aes" }), "writer"), null, "an unknown encoding is still refused");
});

await test("Spreadsheet packing: the draft JSON travels as a one-entry ZIP; unicode round-trips; other ZIPs are refused", FULL, async () => {
  const json = JSON.stringify({ workbook: { sheets: [["Ünïcødé ✓ 東京", "=SUM(A1:A3)"]] }, renames: { Sheet1: "Données" }, active: "Données" });
  const z = await packDraftText(json);
  assert.deepEqual(openZip(z).entries.map((e) => e.name), [DRAFT_ENTRY]);
  assert.equal(await unpackDraftText(z), json);
  const k2: SealKey = { password: PW, key: k.key };
  const r = openSealedDraft(sealDraft(z, k2), PW); assert.ok(r.ok);
  if (r.ok) assert.equal(await unpackDraftText(r.bytes), json, "sealed → opened → unpacked = the JSON");
  await assert.rejects(unpackDraftText(plain), new RegExp(DRAFT_ENTRY), "a docx is not a sheet draft");
  await assert.rejects(unpackDraftText(new Uint8Array([1, 2, 3])), "junk is refused");
});

await test("outside oracle: msoffcrypto-tool (HMAC verified) decrypts both sealed drafts; python-docx reads the Writer one; a wrong password fails there too", FULL, async () => {
  const realDocx = join(tmp, "real.docx");
  execFileSync(PY, ["-c", "import docx,sys; d=docx.Document(); d.add_paragraph(sys.argv[2]); d.save(sys.argv[1])", realDocx, MARK]);
  const sealedDocx = Buffer.from(sealDraft(new Uint8Array(readFileSync(realDocx)), { password: PW, key: null }), "base64");
  const m = msoff(sealedDocx, PW); assert.ok(m.ok, `msoffcrypto: ${m.error}`);
  const out = join(tmp, "out.docx"); writeFileSync(out, m.plain!);
  const text = execFileSync(PY, ["-c", "import docx,sys; print('\\n'.join(p.text for p in docx.Document(sys.argv[1]).paragraphs))", out], { encoding: "utf8" });
  assert.ok(text.includes(MARK), "python-docx reads the paragraph of the decrypted draft");
  assert.equal(msoff(sealedDocx, "wrong").ok, false, "msoffcrypto refuses the wrong password");
  const json = JSON.stringify({ workbook: { cell: "Σ 42" } });
  const sheetSealed = Buffer.from(sealDraft(await packDraftText(json), { password: PW, key: null }), "base64");
  const s = msoff(sheetSealed, PW); assert.ok(s.ok, `msoffcrypto (sheet): ${s.error}`);
  const zf = join(tmp, "sheet.zip"); writeFileSync(zf, s.plain!);
  const got = execFileSync(PY, ["-c", "import zipfile,sys; print(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]).decode('utf-8'))", zf, DRAFT_ENTRY], { encoding: "utf8" }).trim();
  assert.equal(got, json, "Python's zipfile reads the same JSON out of the decrypted container");
});

finish();
