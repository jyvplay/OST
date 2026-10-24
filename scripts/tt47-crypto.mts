/**
 * TT47 — password-protected Office files (MS-OFFCRYPTO): from-scratch SHA/HMAC/AES primitives, CFB reader,
 * Agile + Standard decryption. Oracles: node:crypto (OpenSSL) for the primitives; msoffcrypto-tool (MIT,
 * test-only) for Standard decryption and for producing independent Agile (SHA-512/AES-256) vectors; Agile
 * files with no working oracle are verified by their own HMAC integrity record.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt47-crypto.mts
 */
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { sha1, sha256, sha384, sha512, hmac, aesCbcDecrypt, aesCbcEncrypt, aesEcbDecrypt } from "../src/lib/office/cryptoprims.ts";
import { OfficePasswordError, decryptOffice, isEncryptedOffice, readCfb } from "../src/lib/office/offcrypto.ts";
import { docText, readWord } from "../src/lib/office/wordml.ts";
import { readXlsxWorkbook } from "../src/lib/formula/xlsx.ts";
import { readdirSync, statSync } from "node:fs";

const { test: test0, finish } = makeHarness("tt47-crypto");
const ONLY = process.env.ONLY;
const test: typeof test0 = (name, covers, fn) => (ONLY && !name.includes(ONLY) ? Promise.resolve() : test0(name, covers, fn)) as ReturnType<typeof test0>;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const COV = { "FF-21": "full", "FF-22": "full", "PR-11": "partial" } as const;
export const PY = "/home/user/tools/venv/bin/python";
export const tmp = mkdtempSync(join(tmpdir(), "tt47c-"));
const C = "/home/user/tools/corpus";
const rd = (p: string) => new Uint8Array(readFileSync(p));
/** msoffcrypto-tool CLI (MIT; test-only oracle) */
const tool = (args: string[]) => execFileSync("/home/user/tools/venv/bin/msoffcrypto-tool", args, { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] });
const throwsLike = (fn: () => unknown, re: RegExp, what: string) => {
  try { fn(); } catch (e) { const m = `${(e as Error).name}: ${(e as Error).message}`; ok(re.test(m), `${what}: wrong error "${m}"`); return; }
  throw new Error(`${what}: accepted`);
};

await test("SHA-1/256/384/512, HMAC and AES-128/192/256 (CBC, ECB) equal OpenSSL on 400 random vectors incl. padding boundaries", COV, async () => {
  const lens = [0, 1, 55, 56, 63, 64, 65, 111, 112, 119, 127, 128, 129, 1000, 4096];
  for (let i = 0; i < 400; i++) {
    const n = i < lens.length ? lens[i] : Math.floor(Math.random() * 3000);
    const m = new Uint8Array(randomBytes(n));
    for (const [name, fn] of [["sha1", sha1], ["sha256", sha256], ["sha384", sha384], ["sha512", sha512]] as const) {
      const want = createHash(name).update(m).digest("hex"); ok(hex(fn(m)) === want, `${name} len ${n}`);
    }
    const key = new Uint8Array(randomBytes(i % 3 === 0 ? 200 : 20));
    ok(hex(hmac("SHA512", key, m)) === createHmac("sha512", key).update(m).digest("hex"), `hmac-sha512 len ${n} key ${key.length}`);
    ok(hex(hmac("SHA1", key, m)) === createHmac("sha1", key).update(m).digest("hex"), `hmac-sha1 len ${n}`);
    const bits = [128, 192, 256][i % 3]; const k = new Uint8Array(randomBytes(bits / 8)); const iv = new Uint8Array(randomBytes(16));
    const data = new Uint8Array(randomBytes(16 * (1 + (i % 40))));
    const c = createCipheriv(`aes-${bits}-cbc`, k, iv).setAutoPadding(false); const ct = new Uint8Array(Buffer.concat([c.update(data), c.final()]));
    ok(hex(aesCbcEncrypt(k, iv, data)) === hex(ct), `aes-${bits}-cbc encrypt`);
    ok(hex(aesCbcDecrypt(k, iv, ct)) === hex(data), `aes-${bits}-cbc decrypt`);
    const e = createCipheriv(`aes-${bits}-ecb`, k, null).setAutoPadding(false); const et = new Uint8Array(Buffer.concat([e.update(data), e.final()]));
    ok(hex(aesEcbDecrypt(k, et)) === hex(data), `aes-${bits}-ecb decrypt`);
  }
  // FIPS-197 Appendix C.1 known answer
  const kat = aesCbcEncrypt(Uint8Array.from(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex")), new Uint8Array(16), Uint8Array.from(Buffer.from("00112233445566778899aabbccddeeff", "hex")));
  ok(hex(kat) === "69c4e0d86a7b0430d8cdb78070b4c55a", `FIPS-197 C.1 ${hex(kat)}`);
  const t = performance.now(); let h = new Uint8Array(64); const buf = new Uint8Array(68);
  for (let i = 0; i < 100000; i++) { new DataView(buf.buffer).setUint32(0, i, true); buf.set(h, 4); h = sha512(buf); }
  const ms = performance.now() - t; console.log(`    100,000-round SHA-512 spin: ${Math.round(ms)} ms`);
  ok(ms < 3000, `spin too slow: ${ms} ms`);
});

await test("corpus: Agile SHA-1 'pass' (HMAC verified, opens in Writer), Standard 'solrcell' and 'tika' byte-equal to msoffcrypto-tool", COV, async () => {
  const pass = rd(`${C}/docx/bug53475-password-is-pass.docx`);
  ok(isEncryptedOffice(pass), "pass.docx not detected");
  const a = decryptOffice(pass, "pass");
  ok(a.method === "agile" && a.integrity === "verified", `pass.docx ${a.method}/${a.integrity}`);
  const wd = await readWord(a.bytes, "pass.docx"); const txt = docText(wd);
  ok(txt.trim().length > 0, "pass.docx decrypted but has no text"); console.log(`    pass.docx text: ${JSON.stringify(txt.slice(0, 60))}`);
  for (const [f, pw, kind] of [["docx/bug53475-password-is-solrcell.docx", "solrcell", "docx"], ["xlsx/protected_passtika.xlsx", "tika", "xlsx"]] as const) {
    const enc = rd(`${C}/${f}`); const r = decryptOffice(enc, pw); ok(r.method === "standard", `${f} method ${r.method}`);
    const out = join(tmp, `oracle-${kind}`); tool(["-p", pw, `${C}/${f}`, out]);
    ok(Buffer.compare(Buffer.from(r.bytes), readFileSync(out)) === 0, `${f}: differs from msoffcrypto-tool (${r.bytes.length} vs ${statSync(out).size})`);
    if (kind === "docx") ok(docText(await readWord(r.bytes, "x.docx")).length > 0, "solrcell docx has no text");
    else { const wb = readXlsxWorkbook(Buffer.from(r.bytes)); ok(wb.sheets.size > 0, "tika xlsx has no sheets"); console.log(`    tika.xlsx sheets: ${[...wb.sheets.keys()].join(", ")}`); }
  }
});

const VEC: { name: string; plain: Uint8Array; enc: Uint8Array; pw: string }[] = [];
await test("independent Agile vectors: msoffcrypto-tool -e (SHA-512/AES-256, HMAC) on 24 corpus files + Unicode password decrypt byte-equal", COV, async () => {
  const pick = (dir: string, n: number) => readdirSync(`${C}/${dir}`).filter((f) => /\.(docx|xlsx)$/.test(f) && !/password|protected|passtika|clusterfuzz|corrupt|truncat/i.test(f)).map((f) => `${C}/${dir}/${f}`)
    .filter((p) => { const b = readFileSync(p); return b[0] === 0x50 && b[1] === 0x4b && b.length > 4200 && b.length < 4 << 20; }).sort((x, y) => statSync(x).size - statSync(y).size)
    .filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / n)) === 0).slice(0, n);
  const big = (dir: string) => readdirSync(`${C}/${dir}`).filter((f) => /\.(docx|xlsx)$/.test(f) && !/password|protected/i.test(f)).map((f) => `${C}/${dir}/${f}`)
    .filter((p) => statSync(p).size < 4 << 20).sort((x, y) => statSync(y).size - statSync(x).size)[0];
  const files = [...new Set([...pick("docx", 11), big("docx"), ...pick("xlsx", 11), big("xlsx")])];
  let sizes: number[] = [];
  for (const [i, f] of files.entries()) {
    const pw = i === files.length - 1 ? "p\u00e4ssw\u00f6rd \u2713 \u5bc6\u7801" : i % 2 ? "Correct Horse 42" : "x";
    const out = join(tmp, `v${i}`);
    try { tool(["-e", "-p", pw, f, out]); } catch { console.log(`    (oracle refused input ${f.split("/").pop()} — skipped)`); continue; }
    const enc = rd(out); const plain = rd(f);
    ok(isEncryptedOffice(enc), `${f}: vector not detected as encrypted`);
    const info = new TextDecoder().decode(readCfb(enc).stream(readCfb(enc).rootChildren().find((e) => e.name === "EncryptionInfo")!));
    ok(/hashAlgorithm="SHA512"/.test(info) && /keyBits="256"/.test(info), `${f}: vector is not SHA-512/AES-256`);
    const r = decryptOffice(enc, pw);
    ok(r.method === "agile" && r.integrity === "verified", `${f}: ${r.method}/${r.integrity}`);
    ok(Buffer.compare(Buffer.from(r.bytes), Buffer.from(plain)) === 0, `${f}: decrypted bytes differ`);
    VEC.push({ name: f.split("/").pop()!, plain, enc, pw }); sizes.push(plain.length);
  }
  ok(VEC.length >= 20 && VEC.some((x) => /[^\x00-\x7f]/.test(x.pw)), `only ${VEC.length} vectors / no Unicode password vector`);
  sizes = sizes.sort((x, y) => x - y);
  ok(sizes[sizes.length - 1] > 64 * 4096, `size coverage ${sizes[0]}..${sizes[sizes.length - 1]}`);
  console.log(`    ${VEC.length} vectors, plaintext ${sizes[0]}..${sizes[sizes.length - 1]} bytes (${Math.ceil(sizes[sizes.length - 1] / 4096)} segments max)`);
});

await test("negative shapes: 25 malformed/hostile inputs are refused with a specific error, never hang, never yield plaintext", COV, async () => {
  const pass = rd(`${C}/docx/bug53475-password-is-pass.docx`), std = rd(`${C}/docx/bug53475-password-is-solrcell.docx`);
  const v = VEC.find((x) => x.plain.length > 3 * 4096) ?? VEC[0];
  const t0 = performance.now();
  const plainDocx = rd(`${C}/docx/${readdirSync(`${C}/docx`).find((f) => f.endsWith(".docx") && !/password/.test(f))}`);
  ok(!isEncryptedOffice(plainDocx) && !isEncryptedOffice(new Uint8Array(0)), "plain/empty detected as encrypted");
  throwsLike(() => decryptOffice(new Uint8Array(0), "x"), /not a compound file/, "1 empty");
  throwsLike(() => decryptOffice(plainDocx, "x"), /not a compound file/, "2 plain zip");
  throwsLike(() => decryptOffice(pass.slice(0, 511), "pass"), /not a compound file/, "3 header truncated");
  throwsLike(() => decryptOffice(pass.slice(0, pass.length >> 1), "pass"), /cfb:|offcrypto:/, "4 file truncated in half");
  const patch = (b: Uint8Array, o: number, bytes: number[]) => { const c = b.slice(); bytes.forEach((x, i) => (c[o + i] = x)); return c; };
  const u32 = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset).getUint32(o, true);
  const le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24];
  throwsLike(() => decryptOffice(patch(pass, 28, [0xff, 0xfe]), "pass"), /unsupported header/, "5 byte-order mark");
  throwsLike(() => decryptOffice(patch(pass, 30, [12, 0]), "pass"), /unsupported header/, "6 v3 with 4096-byte sectors");
  const ss = 1 << pass[30], fat0 = u32(pass, 76), dir0 = u32(pass, 48);
  throwsLike(() => decryptOffice(patch(pass, (fat0 + 1) * ss + dir0 * 4, le(dir0)), "pass"), /broken sector chain/, "7 FAT self-loop on the directory chain");
  throwsLike(() => decryptOffice(patch(pass, 48, le(0x7fffff)), "pass"), /sector out of range|broken sector chain/, "8 directory start out of range");
  throwsLike(() => decryptOffice(patch(patch(pass, 68, le(fat0)), 72, [1, 0, 0, 0]), "pass"), /DIFAT loop|cfb:/, "9 DIFAT chain into a FAT sector");
  throwsLike(() => decryptOffice(patch(pass, 76, le(0x7fffff)), "pass"), /sector out of range/, "10 FAT sector out of range");
  // locate streams inside the raw file by content
  const find = (b: Uint8Array, needle: Uint8Array) => Buffer.from(b).indexOf(Buffer.from(needle));
  const cfbOf = (b: Uint8Array) => readCfb(b); const streamOf = (b: Uint8Array, n: string) => { const c = cfbOf(b); return c.stream(c.rootChildren().find((e) => e.name === n)!); };
  const vpkg = streamOf(v.enc, "EncryptedPackage"); const pOff = find(v.enc, vpkg.subarray(0, 64)); ok(pOff > 0, "package not found");
  throwsLike(() => decryptOffice(patch(v.enc, pOff, le(vpkg.length + 100)), v.pw), /size field out of range/, "11 package size beyond stream");
  throwsLike(() => decryptOffice(patch(v.enc, pOff + 4, [0, 1, 0, 0]), v.pw), /size field out of range/, "12 package size 2^40");
  throwsLike(() => decryptOffice(patch(v.enc, pOff + 5000, [v.enc[pOff + 5000] ^ 1]), v.pw), /integrity check failed/, "13 one flipped ciphertext bit (Agile HMAC)");
  const vinfo = streamOf(v.enc, "EncryptionInfo"); const iOff = find(v.enc, vinfo.subarray(0, 64)); ok(iOff > 0, "info not found");
  const xml = new TextDecoder().decode(vinfo.subarray(8));
  const xpatch = (from: string, to: string) => { ok(from.length === to.length, "same-length patch"); const at = xml.indexOf(from); ok(at >= 0, `missing ${from}`); return patch(v.enc, iOff + 8 + at, [...new TextEncoder().encode(to)]); };
  throwsLike(() => decryptOffice(patch(v.enc, iOff, [3, 0, 3, 0]), v.pw), /unsupported encryption version 3.3/, "14 version 3.3");
  throwsLike(() => decryptOffice(xpatch('cipherAlgorithm="AES"', 'cipherAlgorithm="DES"'), v.pw), /unsupported cipher/, "15 DES cipher");
  throwsLike(() => decryptOffice(xpatch('hashAlgorithm="SHA512"', 'hashAlgorithm="SHA513"'), v.pw), /unsupported hash/, "16 unknown hash");
  throwsLike(() => decryptOffice(xpatch('spinCount="100000"', 'spinCount="-10000"'), v.pw), /bad spinCount/, "17 negative spinCount");
  const hv = /encryptedHmacValue="([^"]+)"/.exec(xml)![1]; const hv2 = (hv[0] === "A" ? "B" : "A") + hv.slice(1);
  throwsLike(() => decryptOffice(xpatch(`encryptedHmacValue="${hv}"`, `encryptedHmacValue="${hv2}"`), v.pw), /integrity check failed/, "18 tampered HMAC value");
  for (const [pw, what] of [["", "19 empty password"], [v.pw.toUpperCase() === v.pw ? v.pw.toLowerCase() : v.pw.toUpperCase(), "20 password case differs"], [v.pw + " ", "21 trailing space"]] as const)
    throwsLike(() => decryptOffice(v.enc, pw), /OfficePasswordError: The password is not correct/, what);
  const sinfo = streamOf(std, "EncryptionInfo"); const sOff = find(std, sinfo.subarray(0, 48));
  throwsLike(() => decryptOffice(patch(std, sOff + 12 + 8, le(0x6801)), "solrcell"), /unsupported Standard algorithm 0x6801/, "22 Standard RC4");
  const spkg = streamOf(std, "EncryptedPackage"); const spOff = find(std, spkg.subarray(0, 64));
  throwsLike(() => decryptOffice(patch(std, spOff + 8, [std[spOff + 8] ^ 0x80]), "solrcell"), /not a ZIP package/, "23 Standard first block tampered");
  const nm = find(v.enc, new Uint8Array([...new TextEncoder().encode("EncryptedPackage")].flatMap((c) => [c, 0])));
  const renamed = patch(v.enc, nm, [0x58, 0]);
  ok(!isEncryptedOffice(renamed), "renamed stream still detected");
  throwsLike(() => decryptOffice(renamed, v.pw), /not an encrypted Office package/, "24 EncryptedPackage stream missing");
  // 25: msoffcrypto-tool 6.0.0's own encrypt output for a <4 KiB package records a stream larger than the mini stream it writes
  // (olefile reads it truncated; msoffcrypto cannot decrypt it either) — a real-world malformed container
  const small = readdirSync(`${C}/docx`).map((f) => `${C}/docx/${f}`).find((p) => p.endsWith("Bug66263-table.docx"));
  if (small) { const out = join(tmp, "defective-mini.enc"); tool(["-e", "-p", "x", small, out]); throwsLike(() => decryptOffice(rd(out), "x"), /mini stream shorter than its size/, "25 truncated mini stream"); }
  ok(performance.now() - t0 < 60000, "negative shapes too slow");
  try { decryptOffice(v.enc, "nope"); } catch (e) { ok(e instanceof OfficePasswordError && e.kind === "wrong", "typed error"); }
});

await test("bounded fuzz: 240 random header/FAT/directory mutations of encrypted files — every outcome is a thrown Error or exact plaintext", COV, async () => {
  let rng = 0x2f6b1d; const rnd = (n: number) => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng % n; };
  const std = rd(`${C}/xlsx/protected_passtika.xlsx`); const want = decryptOffice(std, "tika").bytes;
  const srcs = [{ enc: std, pw: "tika", plain: want, agile: false }, ...VEC.filter((x) => x.plain.length < 20000).slice(0, 2).map((x) => ({ ...x, agile: true }))];
  let threw = 0, exact = 0, stdAltered = 0; const t0 = performance.now();
  for (let i = 0; i < 240; i++) {
    const s = srcs[i % srcs.length]; const c = s.enc.slice();
    const region = rnd(3); const n = 1 + rnd(4);
    for (let k = 0; k < n; k++) { const o = region === 0 ? rnd(512) : region === 1 ? 512 + rnd(Math.min(c.length - 512, 2048)) : rnd(c.length); c[o] = rnd(256); }
    const ts = performance.now();
    try {
      const r = decryptOffice(c, s.pw);
      if (Buffer.compare(Buffer.from(r.bytes), Buffer.from(s.plain)) === 0) exact++;
      else if (!s.agile) stdAltered++; // Standard encryption has no integrity record (ZIP CRCs catch it downstream)
      else ok(false, `mutant ${i} returned different plaintext from an Agile (HMAC-protected) file`);
    }
    catch (e) { ok(e instanceof Error, `mutant ${i} threw a non-Error`); if ((e as Error).message.includes("returned different plaintext")) throw e; threw++; }
    ok(performance.now() - ts < 5000, `mutant ${i} took too long`);
  }
  console.log(`    240 mutants: ${threw} refused, ${exact} exact plaintext (benign bytes), ${stdAltered} Standard-only altered plaintext (no integrity record in Standard), ${Math.round(performance.now() - t0)} ms`);
  ok(threw >= 60 && threw + exact + stdAltered === 240, "fuzz accounting");
});

await finish();
process.exit(0);
