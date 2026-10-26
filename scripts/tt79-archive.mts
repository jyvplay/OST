/**
 * TT79 — ZIP engine (src/lib/archive/*) against independent implementations.
 *
 *  V1  crypto vectors: AES FIPS-197 C.1–C.3, SHA-1 FIPS 180 examples, PBKDF2-HMAC-SHA1 RFC 6070, plus 200 random
 *      cross-checks against node:crypto (OpenSSL) for AES-ECB, SHA-1, HMAC-SHA1 and PBKDF2.
 *  C1  Python zipfile writes stored / deflate / bzip2 / LZMA entries (empty → 1 MiB, text, random, zeros); every entry
 *      we read equals Python's own read (bytes + CRC).
 *  C2  own inflater (native disabled) == zlib on every deflated entry and on node:zlib levels 0–9.
 *  C3  Deflate64: dotnet/runtime-assets deflate64.zip (made by Windows) — every entry equals Info-ZIP `unzip -p`;
 *      the malformed deflate64-rs fixtures end with a clean error or a CRC-verified result, never a hang.
 *  C4  Info-ZIP-made archives: -Z bzip2, -fz (forced ZIP64), stdin streaming (data descriptor + ZIP64), symlinks (-y),
 *      UTF-8 names — names and bytes equal `unzip`.
 *  C5  names: CP437 (Python with a raw cp437 name, no bit 11) decode == Python's cp437 decode; the Info-ZIP Unicode
 *      Path extra 0x7075 is honoured exactly when `unzip` honours it (CRC match) and ignored when stale.
 *  E1  WinZip AES read: pyzipper AES-128/192/256 × stored/deflate/bzip2/LZMA.  E2  AES write → pyzipper reads.
 *  E3  ZipCrypto read: Info-ZIP `zip -P` (incl. streamed with a data descriptor).  E4  ZipCrypto write → `unzip -P`
 *      and Python zipfile read it.
 *  W1  writer: UTF-8 names, folders, comments, Unix modes, timestamps → Python zipfile + `unzip -t` + zipinfo agree.
 *  W2  ZIP64: forced ZIP64 written by us → Python + `unzip -t`; Python force_zip64 → we read; 70 000 entries (count
 *      overflow → ZIP64 EOCD) round trip.
 *  X1  editing: delete / rename / add on an AES archive without the password — pyzipper still decrypts the renamed
 *      entry, untouched ciphertext is byte-identical; on a streamed ZipCrypto archive `unzip -P -t` passes.
 *  P1  throughput (reported): native deflate, own inflate, bzip2, LZMA, AES-256 decrypt.
 *  N1–N24 negative shapes (guards).
 * Needs: /home/user/tools/venv (pyzipper), /usr/bin/zip + unzip, /home/user/tools/corpus/zip.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createCipheriv, createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { readArchive, readEntry, writeArchive, editArchive, extractable, PasswordError, crc32, DEFAULT_LIMITS, type ArchiveEntry } from "../src/lib/archive/zip.ts";
import { inflateRawSync } from "../src/lib/archive/inflate.ts";
import { aesExpandKey, aesEncryptBlock, sha1, hmacSha1, pbkdf2Sha1 } from "../src/lib/archive/zipcrypt.ts";
import { listFolder, namesUnder, parentFolder, crumbs, looksText } from "../src/lib/archive/tree.ts";

const { test, finish } = makeHarness("tt79-archive");
const PY = "/home/user/tools/venv/bin/python";
const CORPUS = "/home/user/tools/corpus/zip";
const D = mkdtempSync(join(tmpdir(), "tt79z-"));
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const J = JSON.stringify;
const py = (code: string, ...args: string[]) => execFileSync(PY, ["-c", code, ...args], { maxBuffer: 1 << 28 }).toString();
/** Info-ZIP under a UTF-8 locale; exit status 1 = "warning" (e.g. prepended bytes) still yields the data */
const sh = (cmd: string, args: string[], opts: { cwd?: string; input?: Buffer } = {}) => {
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? D, input: opts.input, maxBuffer: 1 << 28, env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" } });
  if (r.status !== 0 && !(cmd === "unzip" && (r.status === 1 || (/warning/.test(String(r.stderr)) && !/error/.test(String(r.stderr)))))) throw new Error(`${cmd} ${args.join(" ")} → ${r.status}: ${r.stderr}`);
  return r.stdout;
};
const FF = { "FF-69": "full", "FM-05": "full" } as const;
const ENC = { "FF-70": "full" } as const;
const GUARD = { "FF-72": "full", "FF-12": "partial" } as const;
const open = (p: string) => new Uint8Array(readFileSync(p));
async function readAll(buf: Uint8Array, password?: string, native?: boolean) {
  const a = readArchive(buf); const out: Record<string, string> = {};
  for (const e of a.entries) if (!e.dir) out[e.name] = sha(await readEntry(buf, e, { password, native }));
  return { a, out };
}
/** python verifier: name → sha256 (pyzipper reads AES, ZipCrypto and plain) */
const PYREAD = `
import sys, json, hashlib, pyzipper, zipfile
p, pw, lib = sys.argv[1], sys.argv[2], sys.argv[3]
Z = pyzipper.AESZipFile if lib == "pyzipper" else zipfile.ZipFile
out = {"entries": {}, "meta": {}}
with Z(p) as z:
    if pw: z.setpassword(pw.encode())
    out["comment"] = z.comment.decode("utf-8", "replace")
    for i in z.infolist():
        out["meta"][i.filename] = {"dt": list(i.date_time), "mode": i.external_attr >> 16, "comment": i.comment.decode("utf-8","replace"), "type": i.compress_type}
        if not i.is_dir(): out["entries"][i.filename] = hashlib.sha256(z.read(i.filename)).hexdigest()
print(json.dumps(out))`;
const pyRead = (p: string, pw = "", lib = "pyzipper") => JSON.parse(py(PYREAD, p, pw, lib)) as { entries: Record<string, string>; meta: Record<string, { dt: number[]; mode: number; comment: string; type: number }>; comment: string };

/* ------------------------------------------------------------------ fixtures (Python) */
const GEN = `
import sys, os, random, zipfile, struct, zlib, pyzipper
d = sys.argv[1]; random.seed(79)
text = ("The quick brown fox jumps over the lazy dog. " * 4000 + "".join(chr(0x41 + random.randrange(26)) for _ in range(20000))).encode()
payloads = {"empty": b"", "one": b"x", "hello": b"hello, zip\\n", "text": text[:200000], "random": bytes(random.randrange(256) for _ in range(100000)),
            "zeros": bytes(1 << 20), "mixed": (text[:50000] + bytes(random.randrange(256) for _ in range(50000))) * 3, "w70k": text[:70000]}
meth = {"stored": zipfile.ZIP_STORED, "deflate": zipfile.ZIP_DEFLATED, "bzip2": zipfile.ZIP_BZIP2, "lzma": zipfile.ZIP_LZMA}
with zipfile.ZipFile(os.path.join(d, "py-methods.zip"), "w") as z:
    for m, c in meth.items():
        for n, b in payloads.items(): z.writestr(f"{m}/{n}.bin", b, compress_type=c)
with zipfile.ZipFile(os.path.join(d, "py-zip64.zip"), "w", compression=zipfile.ZIP_DEFLATED) as z:
    for n in ["a.txt", "b.bin"]:
        with z.open(n, "w", force_zip64=True) as f: f.write(payloads["text"] if n == "a.txt" else payloads["random"])
    z.writestr("plain.txt", b"not zip64")
class CP(zipfile.ZipInfo):
    def _encodeFilenameFlags(self): return self.filename.encode("cp437"), self.flag_bits & ~0x800
with zipfile.ZipFile(os.path.join(d, "py-cp437.zip"), "w") as z:
    for n in ["Résumé ÄÖÜ.txt", "niño ½ ¼ ░▒▓.txt", "αß Γπ Σσµτ ±≥.txt"]: z.writestr(CP(n), n.encode())
def upath(fn, good):
    raw = "???.txt"; u = "日本語.txt".encode()
    zi = CP(raw); crc = zlib.crc32(raw.encode()) if good else 12345
    zi.extra = struct.pack("<HHBI", 0x7075, 5 + len(u), 1, crc) + u
    with zipfile.ZipFile(os.path.join(d, fn), "w") as z: z.writestr(zi, b"unicode path")
upath("py-upath.zip", True); upath("py-upath-stale.zip", False)
for bits in (128, 192, 256):
    with pyzipper.AESZipFile(os.path.join(d, f"pz-aes{bits}.zip"), "w", encryption=pyzipper.WZ_AES) as z:
        z.setpassword(b"s3cret pw"); z.setencryption(pyzipper.WZ_AES, nbits=bits)
        for m, c in meth.items():
            for n in ["hello", "text", "random", "one"]: z.writestr(f"{m}/{n}.bin", payloads[n], compress_type=c)
with zipfile.ZipFile(os.path.join(d, "py-dup.zip"), "w") as z:
    import warnings; warnings.simplefilter("ignore")
    z.writestr("same.txt", b"first"); z.writestr("same.txt", b"second"); z.writestr("other.txt", b"ok")
with zipfile.ZipFile(os.path.join(d, "py-slip.zip"), "w") as z:
    z.writestr("../evil.txt", b"x"); z.writestr("good/ok.txt", b"y"); z.writestr("a/../../evil2.txt", b"z")
with zipfile.ZipFile(os.path.join(d, "py-bomb.zip"), "w", compression=zipfile.ZIP_BZIP2) as z: z.writestr("zeros.bin", bytes(48 << 20))
for n, b in payloads.items(): open(os.path.join(d, "p-" + n), "wb").write(b)
`;

await test("V1 crypto vectors (FIPS-197, FIPS 180, RFC 6070) + 200 random cross-checks against node:crypto", { "FF-70": "full" }, () => {
  const blk = (k: string) => { const o = new Uint8Array(16); aesEncryptBlock(aesExpandKey(Buffer.from(k, "hex")), Buffer.from("00112233445566778899aabbccddeeff", "hex"), 0, o, 0); return hex(o); };
  ok(blk("000102030405060708090a0b0c0d0e0f") === "69c4e0d86a7b0430d8cdb78070b4c55a", "AES-128 C.1");
  ok(blk("000102030405060708090a0b0c0d0e0f1011121314151617") === "dda97ca4864cdfe06eaf70a0ec0d7191", "AES-192 C.2");
  ok(blk("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f") === "8ea2b7ca516745bfeafc49904b496089", "AES-256 C.3");
  const s = (t: string) => hex(sha1(new TextEncoder().encode(t)));
  ok(s("abc") === "a9993e364706816aba3e25717850c26c9cd0d89d" && s("") === "da39a3ee5e6b4b0d3255bfef95601890afd80709" && s("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") === "84983e441c3bd26ebaae4aa1f95129e5e54670f1", "SHA-1");
  const pb = (p: string, salt: string, c: number, n: number) => hex(pbkdf2Sha1(Buffer.from(p), Buffer.from(salt), c, n));
  ok(pb("password", "salt", 1, 20) === "0c60c80f961f0e71f3a9b524af6012062fe037a6" && pb("password", "salt", 2, 20) === "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957" && pb("password", "salt", 4096, 20) === "4b007901b765489abead49d926f721d065a429c1", "PBKDF2 RFC 6070 1–3");
  ok(pb("passwordPASSWORDpassword", "saltSALTsaltSALTsaltSALTsaltSALTsalt", 4096, 25) === "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038", "PBKDF2 RFC 6070 5");
  for (let i = 0; i < 200; i++) {
    const kl = [16, 24, 32][i % 3], key = randomBytes(kl), pt = randomBytes(16), o = new Uint8Array(16);
    aesEncryptBlock(aesExpandKey(key), pt, 0, o, 0);
    const c = createCipheriv(`aes-${kl * 8}-ecb`, key, null); c.setAutoPadding(false);
    ok(hex(o) === c.update(pt).toString("hex"), `AES-${kl * 8} random ${i}`);
    const m = randomBytes(i * 7), k2 = randomBytes(i % 90);
    ok(hex(sha1(m)) === createHash("sha1").update(m).digest("hex"), "sha1 " + i);
    ok(hex(hmacSha1(k2, m)) === createHmac("sha1", k2).update(m).digest("hex"), "hmac " + i);
    if (i % 20 === 0) ok(hex(pbkdf2Sha1(k2, m.subarray(0, 16), 50, 66)) === pbkdf2Sync(k2, m.subarray(0, 16), 50, 66, "sha1").toString("hex"), "pbkdf2 " + i);
  }
  return "3 AES + 3 SHA-1 + 4 PBKDF2 vectors; 200 AES/SHA-1/HMAC + 10 PBKDF2 random cross-checks vs OpenSSL";
});

py(GEN, D);
const payloadNames = ["empty", "one", "hello", "text", "random", "zeros", "mixed", "w70k"];

await test("C1 Python zipfile stored/deflate/bzip2/LZMA: every entry equals Python's read (bytes + CRC)", FF, async () => {
  const p = join(D, "py-methods.zip"); const want = pyRead(p, "", "zipfile").entries;
  const { a, out } = await readAll(open(p));
  ok(a.entries.length === 32, "entries " + a.entries.length);
  const methods = new Set(a.entries.map((e) => e.method)); ok(J([...methods].sort((x, y) => x - y)) === "[0,8,12,14]", J([...methods]));
  for (const [n, h] of Object.entries(want)) ok(out[n] === h, "mismatch " + n);
  ok(Object.keys(out).length === Object.keys(want).length, "count");
  return `32 entries, methods 0/8/12/14, all equal`;
});

await test("C2 own inflater == zlib (every deflated corpus entry + node:zlib levels 0–9 + Python entries)", FF, async () => {
  const buf = open(join(D, "py-methods.zip"));
  const { out: own } = await readAll(buf, undefined, false), { out: nat } = await readAll(buf, undefined, true);
  ok(J(own) === J(nat), "own != native on python archive");
  let n = 0;
  for (const name of payloadNames) {
    const src = readFileSync(join(D, "p-" + name));
    for (let lvl = 0; lvl <= 9; lvl++) { const z = deflateRawSync(src, { level: lvl }); const r = inflateRawSync(z, { limit: src.length }); ok(Buffer.compare(Buffer.from(r.data), src) === 0 && r.used === z.length, `${name} L${lvl}`); n++; }
  }
  return `${n} zlib streams + 8 Python entries`;
});

await test("C3 Deflate64 (Windows-made dotnet fixture) == Info-ZIP unzip -p; malformed fixtures end cleanly", FF, async () => {
  const p = join(CORPUS, "d64-deflate64.zip"); ok(existsSync(p), "corpus missing — run scripts/sandbox/rebuild-all.sh");
  const buf = open(p), a = readArchive(buf); let d64 = 0;
  for (const e of a.entries) {
    if (e.dir) continue;
    const ours = await readEntry(buf, e); const theirs = sh("unzip", ["-p", p, e.name]);
    ok(Buffer.compare(Buffer.from(ours), theirs) === 0, "differs " + e.name); if (e.method === 9) d64++;
  }
  ok(d64 >= 1, "no deflate64 entry");
  const notes: string[] = [];
  for (const f of ["d64-deflate64_not_enough_space.zip", "d64-raw.zip", "d64-unitwf-1.5.0.minimized.zip"]) {
    const t0 = Date.now(); let r = "";
    try { const b = open(join(CORPUS, f)); const ar = readArchive(b); let good = 0; for (const e of ar.entries) { try { await readEntry(b, e); good++; } catch (x) { r = (x as Error).message.slice(0, 60); } } r = `${good}/${ar.entries.length} ok` + (r ? `; ${r}` : ""); }
    catch (x) { r = "refused: " + (x as Error).message.slice(0, 70); }
    ok(Date.now() - t0 < 20000, f + " too slow"); notes.push(`${f}: ${r}`);
  }
  console.log("   " + notes.join("\n   "));
  return `${d64} Deflate64 entr${d64 === 1 ? "y" : "ies"} (2.7 MB WMV) byte-identical to unzip; ${notes.length} malformed fixtures ended cleanly`;
});

await test("C4 Info-ZIP archives: bzip2, forced ZIP64, streamed (data descriptor), symlink, UTF-8 names == unzip", FF, async () => {
  const w = join(D, "iz"); mkdirSync(w); mkdirSync(join(w, "dir ü")); writeFileSync(join(w, "dir ü", "naïve – 日本.txt"), "utf8 name\n".repeat(300)); writeFileSync(join(w, "big.txt"), readFileSync(join(D, "p-text")));
  symlinkSync("big.txt", join(w, "link"));
  sh("zip", ["-q", "-r", "-Z", "bzip2", join(D, "iz-bzip2.zip"), "."], { cwd: w });
  sh("zip", ["-q", "-r", "-fz", join(D, "iz-z64.zip"), "big.txt", "dir ü"], { cwd: w });
  sh("zip", ["-q", "-y", join(D, "iz-link.zip"), "link", "big.txt"], { cwd: w });
  writeFileSync(join(D, "iz-stream.zip"), sh("zip", ["-q", "-", "-"], { input: readFileSync(join(D, "p-mixed")) }));
  const rep: string[] = [];
  for (const f of ["iz-bzip2.zip", "iz-z64.zip", "iz-link.zip", "iz-stream.zip"]) {
    const p = join(D, f), buf = open(p), a = readArchive(buf);
    const names = sh("unzip", ["-Z1", p]).toString().trim().split("\n");
    ok(J(a.entries.map((e) => e.name)) === J(names), `${f} names ${J(a.entries.map((e) => e.name))} vs ${J(names)}`);
    for (const e of a.entries) {
      if (e.dir) continue;
      const ours = await readEntry(buf, e);
      if (e.symlink) { ok(!extractable(e) && new TextDecoder().decode(ours) === "big.txt", "symlink target"); continue; }
      ok(Buffer.compare(Buffer.from(ours), sh("unzip", ["-p", p, e.name.replace(/([[\]*?])/g, "[$1]")])) === 0, `${f}:${e.name}`);
    }
    rep.push(`${f}: ${a.entries.length} (${[...new Set(a.entries.map((e) => e.methodName))].join("/")}${a.zip64 || a.entries.some((e) => e.zip64) ? ", zip64" : ""}${a.entries.some((e) => e.flags & 8) ? ", descriptor" : ""}${a.entries.some((e) => e.symlink) ? ", symlink" : ""})`);
  }
  ok(readArchive(open(join(D, "iz-bzip2.zip"))).entries.some((e) => e.method === 12), "bzip2 used");
  const iu = readArchive(open(join(D, "iz-bzip2.zip"))); ok(iu.entries.some((e) => e.nameEncoding === "utf8-unflagged") && iu.issues.some((x) => x.includes("valid UTF-8")), "unflagged UTF-8 labelled");
  ok(readArchive(open(join(D, "iz-bzip2.zip")), DEFAULT_LIMITS, "cp437").entries.some((e) => e.name === "dir ├╝/"), "forced CP437 = Python's reading");
  ok(readArchive(open(join(D, "iz-z64.zip"))).entries.every((e) => e.zip64 || e.dir), "zip64 extras");
  ok(readArchive(open(join(D, "iz-stream.zip"))).entries[0].flags & 8, "descriptor");
  return rep.join("; ");
});

await test("C5 names: CP437 decode == Python; Unicode Path 0x7075 honoured exactly as Info-ZIP does (CRC), stale ignored", FF, () => {
  const p = join(D, "py-cp437.zip"); const a = readArchive(open(p));
  const want = Object.keys(pyRead(p, "", "zipfile").entries);
  ok(J(a.entries.map((e) => e.name)) === J(want), J(a.entries.map((e) => e.name)) + " vs " + J(want));
  ok(a.entries.every((e) => e.nameEncoding === "cp437") && a.issues.some((s) => s.includes("code page 437")), "flagged cp437");
  const good = readArchive(open(join(D, "py-upath.zip"))), stale = readArchive(open(join(D, "py-upath-stale.zip")));
  const izGood = sh("unzip", ["-Z1", join(D, "py-upath.zip")]).toString().trim(), izStale = sh("unzip", ["-Z1", join(D, "py-upath-stale.zip")]).toString().trim();
  ok(good.entries[0].name === "日本語.txt" && good.entries[0].nameEncoding === "unicode-path" && izGood === "日本語.txt", `good ${good.entries[0].name} / unzip ${izGood}`);
  ok(stale.entries[0].name === "???.txt" && izStale === "???.txt" && stale.issues.some((s) => s.includes("stale")), `stale ${stale.entries[0].name} / unzip ${izStale}`);
  return `${a.entries.length} cp437 names equal Python; 0x7075 good → ${good.entries[0].name}, stale → ${stale.entries[0].name} (unzip agrees)`;
});

await test("E1 WinZip AES read: pyzipper AES-128/192/256 × stored/deflate/bzip2/LZMA", ENC, async () => {
  let n = 0;
  for (const bits of [128, 192, 256]) {
    const p = join(D, `pz-aes${bits}.zip`), want = pyRead(p, "s3cret pw").entries, buf = open(p);
    const { a, out } = await readAll(buf, "s3cret pw");
    ok(a.entries.every((e) => e.encryption === "aes" && e.aesStrength === bits / 64 - 1), "strength " + bits);
    for (const [k, h] of Object.entries(want)) { ok(out[k] === h, `${bits} ${k}`); n++; }
    ok(new Set(a.entries.map((e) => e.method)).size === 4, "4 methods inside AES");
  }
  const vers = new Set(readArchive(open(join(D, "pz-aes256.zip"))).entries.map((e) => e.aesVersion));
  return `${n} AES entries decrypted + verified (AE versions seen: ${[...vers].join(",")})`;
});

await test("E2 WinZip AES write (128/192/256, stored + deflate): pyzipper decrypts; wrong password refused by pyzipper", ENC, async () => {
  for (const enc of ["aes128", "aes192", "aes256"] as const) {
    const items = payloadNames.map((n) => ({ name: `${enc}/${n}.bin`, data: new Uint8Array(readFileSync(join(D, "p-" + n))), method: (n === "random" ? 0 : 8) as 0 | 8 }));
    const z = await writeArchive(items, { password: "pässwörd", encryption: enc, deflate: (d) => deflateRawSync(d) });
    const p = join(D, `ours-${enc}.zip`); writeFileSync(p, z);
    const got = pyRead(p, "pässwörd").entries;
    for (const it of items) ok(got[it.name] === sha(it.data), `${enc} ${it.name}`);
    let refused = false; try { pyRead(p, "wrong"); } catch { refused = true; } ok(refused, "pyzipper accepted a wrong password");
    const { out } = await readAll(z, "pässwörd"); ok(Object.keys(out).length === items.length, "self read");
  }
  return "3 strengths × 8 payloads decrypted by pyzipper";
});

await test("E3 ZipCrypto read: Info-ZIP zip -P (files + streamed with a data descriptor)", ENC, async () => {
  const w = join(D, "iz");
  sh("zip", ["-q", "-P", "zc pass", join(D, "iz-zc.zip"), "big.txt", "dir ü/naïve – 日本.txt"], { cwd: w });
  writeFileSync(join(D, "iz-zc-stream.zip"), sh("zip", ["-q", "-P", "zc pass", "-", "-"], { input: readFileSync(join(D, "p-random")) }));
  let n = 0;
  for (const f of ["iz-zc.zip", "iz-zc-stream.zip"]) {
    const p = join(D, f), buf = open(p), a = readArchive(buf);
    for (const e of a.entries) { if (e.dir) continue; ok(e.encryption === "zipcrypto", "flag"); const ours = await readEntry(buf, e, { password: "zc pass" }); ok(Buffer.compare(Buffer.from(ours), sh("unzip", ["-P", "zc pass", "-p", p, e.name])) === 0, f + e.name); n++; }
  }
  ok(readArchive(open(join(D, "iz-zc-stream.zip"))).entries[0].flags & 8, "stream uses a descriptor (check byte from DOS time)");
  return `${n} ZipCrypto entries equal unzip -P`;
});

await test("E4 ZipCrypto write: unzip -P -t passes and Python zipfile reads it", ENC, async () => {
  const items = payloadNames.map((n) => ({ name: `zc/${n}.bin`, data: new Uint8Array(readFileSync(join(D, "p-" + n))) }));
  const p = join(D, "ours-zc.zip"); writeFileSync(p, await writeArchive(items, { password: "legacy", encryption: "zipcrypto", deflate: (d) => deflateRawSync(d) }));
  const t = sh("unzip", ["-P", "legacy", "-t", p]).toString(); ok(/No errors detected/.test(t), t.slice(-200));
  const got = pyRead(p, "legacy", "zipfile").entries; for (const it of items) ok(got[it.name] === sha(it.data), it.name);
  return "8 entries: unzip -t OK, Python zipfile bytes equal";
});

await test("W1 writer: UTF-8 names, folders, comments, Unix modes, timestamps → Python + unzip -t + zipinfo", FF, async () => {
  const mt = new Date(2024, 1, 29, 13, 37, 42);
  const items = [
    { name: "docs/", dir: true, mtime: mt },
    { name: "docs/Ünïcødé – 日本語.txt", data: new TextEncoder().encode("hello ".repeat(1000)), mtime: mt, comment: "entry comment ✓" },
    { name: "bin/run.sh", data: new TextEncoder().encode("#!/bin/sh\necho hi\n"), mtime: mt, unixMode: 0o100755 },
    { name: "empty.txt", data: new Uint8Array(0), mtime: mt },
  ];
  const p = join(D, "ours-w1.zip"); writeFileSync(p, await writeArchive(items, { comment: "archive comment ★", deflate: (d) => deflateRawSync(d) }));
  const r = pyRead(p, "", "zipfile");
  ok(r.comment === "archive comment ★", "comment " + r.comment);
  ok(r.entries["docs/Ünïcødé – 日本語.txt"] === sha(items[1].data!), "utf8 entry");
  ok(J(r.meta["docs/Ünïcødé – 日本語.txt"].dt) === J([2024, 2, 29, 13, 37, 42]), "dt " + J(r.meta["docs/Ünïcødé – 日本語.txt"].dt));
  ok(r.meta["bin/run.sh"].mode === 0o100755 && r.meta["docs/"].mode === 0o040755, "modes");
  ok(r.meta["docs/Ünïcødé – 日本語.txt"].comment === "entry comment ✓", "entry comment");
  ok(/No errors detected/.test(sh("unzip", ["-t", p]).toString()), "unzip -t");
  const zi = sh("zipinfo", [p]).toString(); ok(/-rwxr-xr-x/.test(zi) && /drwxr-xr-x/.test(zi), zi);
  const back = readArchive(open(p)); ok(back.entries[1].mtime.getTime() === Math.floor(mt.getTime() / 1000) * 1000, "UT extra mtime");
  return "Python names/bytes/date/modes/comments equal; unzip -t OK; zipinfo shows rwx modes";
});

await test("W2 ZIP64: ours forced → Python + unzip -t; Python force_zip64 → ours; 70 000 entries (count overflow)", FF, async () => {
  const items = payloadNames.map((n) => ({ name: n, data: new Uint8Array(readFileSync(join(D, "p-" + n))) }));
  const p = join(D, "ours-z64.zip"); const z = await writeArchive(items, { forceZip64: true, deflate: (d) => deflateRawSync(d) }); writeFileSync(p, z);
  const r = pyRead(p, "", "zipfile"); for (const it of items) ok(r.entries[it.name] === sha(it.data), "py " + it.name);
  ok(/No errors detected/.test(sh("unzip", ["-t", p]).toString()), "unzip -t z64");
  const a = readArchive(z); ok(a.zip64 && a.entries.every((e) => e.zip64), "flags");
  const pz = await readAll(open(join(D, "py-zip64.zip"))); const want = pyRead(join(D, "py-zip64.zip"), "", "zipfile").entries; ok(J(pz.out) === J(want), "py zip64");
  const many = Array.from({ length: 70000 }, (_, i) => ({ name: `d${i % 50}/f${i}.txt`, data: new TextEncoder().encode(String(i)) }));
  const pm = join(D, "ours-70k.zip"); const zm = await writeArchive(many, { level: "store" }); writeFileSync(pm, zm);
  const cnt = py(`import zipfile,sys;z=zipfile.ZipFile(sys.argv[1]);print(len(z.infolist()), z.read("d7/f69957.txt").decode())`, pm).trim();
  ok(cnt === "70000 69957", "python count " + cnt);
  ok(/No errors detected/.test(sh("unzip", ["-tq", pm]).toString()), "unzip -tq 70k");
  ok(readArchive(zm).entries.length === 70000, "self 70k");
  return `forced ZIP64 + Python zip64 + 70 000-entry archive (${(zm.length / 1e6).toFixed(1)} MB) all agree`;
});

await test("X1 editing without the password: AES archive delete/rename/add → pyzipper; streamed ZipCrypto rename → unzip -P -t", { "FF-69": "full", "FF-70": "full", "FF-71": "partial" }, async () => {
  const src = open(join(D, "pz-aes256.zip"));
  const out = await editArchive(src, [{ op: "delete", name: "stored/one.bin" }, { op: "rename", from: "lzma/text.bin", to: "renamed/τέξτ.bin" }, { op: "add", item: { name: "added.txt", data: new TextEncoder().encode("plain add") } }], { deflate: (d) => deflateRawSync(d) });
  const p = join(D, "edit-aes.zip"); writeFileSync(p, out);
  const r = pyRead(p, "s3cret pw"); const orig = pyRead(join(D, "pz-aes256.zip"), "s3cret pw").entries;
  ok(!("stored/one.bin" in r.entries) && r.entries["renamed/τέξτ.bin"] === orig["lzma/text.bin"] && r.entries["added.txt"] === sha(new TextEncoder().encode("plain add")), J(Object.keys(r.entries)));
  const ea = readArchive(src), eb = readArchive(out);
  const raw = (b: Uint8Array, e: ArchiveEntry) => hex(b.subarray(e.dataOffset, e.dataOffset + e.csize));
  const same = eb.entries.filter((e) => e.name.startsWith("deflate/")).every((e) => raw(out, e) === raw(src, ea.entries.find((x) => x.name === e.name)!));
  ok(same, "untouched ciphertext changed");
  const zs = open(join(D, "iz-zc-stream.zip")); const ren = await editArchive(zs, [{ op: "rename", from: "-", to: "stream.bin" }]);
  const p2 = join(D, "edit-zc.zip"); writeFileSync(p2, ren);
  ok(/No errors detected/.test(sh("unzip", ["-P", "zc pass", "-t", p2]).toString()), "unzip -t after rename of a descriptor entry");
  ok(Buffer.compare(sh("unzip", ["-P", "zc pass", "-p", p2, "stream.bin"]), readFileSync(join(D, "p-random"))) === 0, "renamed bytes");
  return "AES: delete + rename (non-ASCII) + add, ciphertext of untouched entries byte-identical; ZipCrypto descriptor rename verified by unzip";
});

await test("P1 throughput (reported)", { "FF-69": "partial" }, async () => {
  const big = Buffer.concat(Array.from({ length: 40 }, () => readFileSync(join(D, "p-mixed")))); // ~12 MB
  const t = async (label: string, write: () => Promise<Uint8Array> | Uint8Array, pw?: string, native?: boolean) => {
    const z = await write(); const a = readArchive(z); const t0 = performance.now(); const d = await readEntry(z, a.entries[0], { password: pw, native }); const ms = performance.now() - t0;
    ok(d.length === big.length, label); return `${label} ${(big.length / 1e6 / (ms / 1000)).toFixed(0)} MB/s`;
  };
  const fz = join(D, "perf.bin"); writeFileSync(fz, big);
  const pz = (m: string, extra = "") => () => { py(`import zipfile,sys${extra};z=zipfile.ZipFile(sys.argv[2],"w");z.write(sys.argv[1],"perf.bin",compress_type=zipfile.${m})${extra ? ";" : ""}`, fz, join(D, "perf.zip")); return open(join(D, "perf.zip")); };
  const r = [
    await t("deflate native", pz("ZIP_DEFLATED")), await t("deflate own", pz("ZIP_DEFLATED"), undefined, false),
    await t("bzip2", pz("ZIP_BZIP2")), await t("LZMA", pz("ZIP_LZMA")),
    await t("AES-256+store", () => writeArchive([{ name: "perf.bin", data: big, method: 0 }], { password: "p" }), "p"),
  ];
  console.log("   P1 " + r.join(", ")); return `${(big.length / 1e6).toFixed(1)} MB: ` + r.join(", ");
});

await test("T1 folder model: implicit folders, explicit folder entries, counts, unsafe names flat at the root, subtree selection", { "FF-71": "partial" }, async () => {
  const z = await writeArchive([{ name: "a/b/c.txt", data: new Uint8Array(5) }, { name: "a/d.txt", data: new Uint8Array(7) }, { name: "e/", dir: true }, { name: "z.txt", data: new Uint8Array(1) }, { name: "a/b/10.txt", data: new Uint8Array(2) }, { name: "a/b/9.txt", data: new Uint8Array(2) }], { level: "store" });
  const a = readArchive(z);
  const root = listFolder(a.entries, ""); ok(J(root.map((r) => r.kind[0] + ":" + r.name)) === J(["f:a", "f:e", "f:z.txt"]), J(root.map((r) => r.name)));
  const fa = root[0] as Extract<typeof root[number], { kind: "folder" }>; ok(fa.files === 4 && fa.size === 16 && !fa.explicit, J(fa));
  ok((root[1] as { explicit: unknown }).explicit, "explicit e/");
  ok(J(listFolder(a.entries, "a/b/").map((r) => r.name)) === J(["9.txt", "10.txt", "c.txt"]), "numeric collation");
  ok(J(namesUnder(a.entries, [fa]).sort()) === J(["a/b/10.txt", "a/b/9.txt", "a/b/c.txt", "a/d.txt"]), "subtree");
  ok(parentFolder("a/b/") === "a/" && parentFolder("a/") === "" && J(crumbs("a/b/")) === J([{ name: "a", path: "a/" }, { name: "b", path: "a/b/" }]), "crumbs");
  const slip = readArchive(open(join(D, "py-slip.zip"))); const sr = listFolder(slip.entries, "");
  ok(J(sr.map((r) => r.kind[0] + ":" + r.name)) === J(["f:good", "f:../evil.txt", "f:a/../../evil2.txt"]) && listFolder(slip.entries, "a/").length === 0, J(sr.map((r) => r.name)));
  ok(looksText(new TextEncoder().encode("héllo\nworld")) && !looksText(new Uint8Array([0, 1, 2, 3])), "looksText");
});

/* ------------------------------------------------------------------ negative shapes */
const patch = (b: Uint8Array, from: string, to: string) => { const o = b.slice(), f = Buffer.from(from), t = Buffer.from(to); ok(f.length === t.length, "same length"); let n = 0; for (let i = 0; i + f.length <= o.length; i++) if (Buffer.compare(Buffer.from(o.subarray(i, i + f.length)), f) === 0) { o.set(t, i); n++; } ok(n >= 2, "patched " + n); return o; };
const throwsMsg = async (fn: () => unknown, re: RegExp, label: string) => { try { await fn(); } catch (e) { ok(re.test((e as Error).message), `${label}: wrong error "${(e as Error).message}"`); return (e as Error).message; } throw new Error(label + ": no error"); };
await test("N1–N24 negative shapes (zip-slip, symlink, duplicates, overlap, mismatch, bombs, lies, tamper, multi-volume, truncation, limits, methods)", GUARD, async () => {
  const out: string[] = []; const fails: string[] = [];
  const N = async (id: string, fn: () => Promise<string> | string) => { try { out.push(`${id} ${await fn()}`); } catch (e) { fails.push(`${id}: ${(e as Error).message}`); } };
  const plain = async (names: string[]) => writeArchive(names.map((n) => ({ name: n, data: new TextEncoder().encode("data of " + n) })), { level: "store" });
  await N("N1 ../ traversal", () => { const a = readArchive(open(join(D, "py-slip.zip"))); const bad = a.entries.filter((e) => !e.safePath).map((e) => e.name); ok(J(bad) === J(["../evil.txt", "a/../../evil2.txt"]) && a.entries.find((e) => e.name === "good/ok.txt")!.safePath === "good/ok.txt", J(bad)); return "blocked " + bad.length; });
  await N("N2 absolute /etc", async () => { const a = readArchive(patch(await plain(["Xetc/passwd"]), "Xetc/passwd", "/etc/passwd")); ok(!a.entries[0].safePath && !extractable(a.entries[0]), "abs"); return "blocked"; });
  await N("N3 drive letter", async () => { const a = readArchive(patch(await plain(["Cx/win.ini"]), "Cx/win.ini", "C:/win.ini")); ok(!a.entries[0].safePath, "drive"); return "blocked"; });
  await N("N4 backslash traversal", async () => { const a = readArchive(patch(await plain(["XXXXXboot.ini"]), "XXXXXboot.ini", "..\\..\\boot.ini".slice(0, 13))); ok(!a.entries[0].safePath, "bs " + a.entries[0].name); return "blocked " + a.entries[0].name; });
  await N("N5 symlink never extracted", () => { const e = readArchive(open(join(D, "iz-link.zip"))).entries.find((x) => x.name === "link")!; ok(e.symlink && !extractable(e), "link"); return "listed, not extractable"; });
  await N("N6 duplicate names", () => { const a = readArchive(open(join(D, "py-dup.zip"))); ok(a.entries.filter((e) => e.duplicate).length === 2 && !a.entries.filter((e) => e.duplicate).some(extractable) && extractable(a.entries[2]), "dup"); return "2 flagged"; });
  await N("N7 overlapping entries (non-recursive bomb)", async () => {
    const z = await plain(["a.txt", "b.txt"]); const a = readArchive(z); const o = z.slice(); const dv = new DataView(o.buffer);
    // grow a.txt's sizes (local + central) so its data covers b.txt's local header
    const span = a.entries[1].dataOffset + a.entries[1].csize - a.entries[0].dataOffset;
    dv.setUint32(a.entries[0].localOffset + 18, span, true); dv.setUint32(a.entries[0].localOffset + 22, span, true);
    let cen = -1; for (let i = o.length - 22; i > 0; i--) if (dv.getUint32(i, true) === 0x02014b50) { cen = i; } // first central record
    for (let i = 0; i < o.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) { cen = i; break; }
    dv.setUint32(cen + 20, span, true); dv.setUint32(cen + 24, span, true);
    return await throwsMsg(() => readArchive(o), /overlap/, "overlap");
  });
  await N("N8 local/central name mismatch", async () => { const z = await plain(["aaaa.txt"]); const o = z.slice(); o[30] = "b".charCodeAt(0); return await throwsMsg(() => readArchive(o), /local and central names differ/, "mismatch"); });
  await N("N9 ratio bomb (48 MiB of zeros, bzip2)", async () => await throwsMsg(() => readArchive(open(join(D, "py-bomb.zip"))), /bomb guard/, "ratio"));
  await N("N10 declared size lie (usize smaller)", async () => {
    const z = await writeArchive([{ name: "x.bin", data: new Uint8Array(readFileSync(join(D, "p-text"))) }], { deflate: (d) => deflateRawSync(d) }); const o = z.slice(); const dv = new DataView(o.buffer);
    for (let i = 0; i < o.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint32(i + 24, 1000, true); break; }
    const a = readArchive(o); return await throwsMsg(() => readEntry(o, a.entries[0], { native: false }), /exceeds|size mismatch/, "lie") + " / native: " + (await throwsMsg(() => readEntry(o, a.entries[0]), /exceeds|size mismatch/, "lie native")).slice(0, 30);
  });
  await N("N11 CRC corruption", async () => { const z = await plain(["c.txt"]); const a = readArchive(z); const o = z.slice(); o[a.entries[0].dataOffset] ^= 1; return await throwsMsg(() => readEntry(o, a.entries[0]), /CRC-32 mismatch/, "crc"); });
  await N("N12 AES tamper + wrong password", async () => {
    const src = open(join(D, "pz-aes256.zip")), a = readArchive(src), e = a.entries.find((x) => x.name === "stored/text.bin")!; const o = src.slice(); o[e.dataOffset + 16 + 2 + 100] ^= 0x40;
    const m1 = await throwsMsg(() => readEntry(o, e, { password: "s3cret pw" }), /authentication code mismatch/, "tamper");
    let pe = false; try { await readEntry(src, e, { password: "nope" }); } catch (x) { pe = x instanceof PasswordError; } ok(pe, "wrong pw → PasswordError");
    let need = false; try { await readEntry(src, e); } catch (x) { need = x instanceof PasswordError; } ok(need, "no pw → PasswordError");
    return m1.slice(0, 40) + "; wrong/missing password → PasswordError";
  });
  await N("N13 ZipCrypto wrong password", async () => { const b = open(join(D, "iz-zc.zip")), e = readArchive(b).entries[0]; let n = 0; for (const pw of ["a", "b", "c", "zc pas", "ZC PASS"]) { try { await readEntry(b, e, { password: pw }); } catch { n++; } } ok(n === 5, "rejections " + n); return "5/5 rejected"; });
  await N("N14 multi-volume refused", async () => { const z = await plain(["m.txt"]); const o = z.slice(); const dv = new DataView(o.buffer); dv.setUint16(o.length - 22 + 4, 1, true); return await throwsMsg(() => readArchive(o), /multi-volume/, "disk"); });
  await N("N15 truncated archive", async () => { const z = open(join(D, "py-methods.zip")); return await throwsMsg(() => readArchive(z.subarray(0, z.length >> 1)), /end-of-central|damaged|past/, "trunc"); });
  await N("N16 entry-count limit", async () => await throwsMsg(() => readArchive(open(join(D, "py-methods.zip")), { ...DEFAULT_LIMITS, maxEntries: 10 }), /entry limit|entries exceed/, "count"));
  await N("N17 unsupported method listed, read refused", async () => {
    const z = await plain(["u.txt"]); const o = z.slice(); const dv = new DataView(o.buffer);
    dv.setUint16(8, 93, true); for (let i = 0; i < o.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint16(i + 10, 93, true); break; }
    const a = readArchive(o); ok(a.entries[0].methodName === "Zstandard", a.entries[0].methodName); return await throwsMsg(() => readEntry(o, a.entries[0]), /not supported/, "zstd");
  });
  await N("N18 prepended data (self-extractor) corrected", async () => {
    const z = open(join(D, "py-methods.zip")); const o = new Uint8Array(1024 + z.length); o.fill(0x4d, 0, 1024); o.set(z, 1024);
    const a = readArchive(o); ok(a.prefix === 1024, "prefix " + a.prefix); const e = a.entries.find((x) => x.name === "bzip2/mixed.bin")!; const d = await readEntry(o, e); // unzip 6.0 has no LZMA (exit 81)
    const pth = join(D, "sfx.zip"); writeFileSync(pth, o); ok(Buffer.compare(Buffer.from(d), sh("unzip", ["-p", pth, e.name])) === 0, "unzip agrees"); return "prefix 1024, bytes equal unzip";
  });
  await N("N19 truncated Deflate64 stream", async () => { const b = open(join(CORPUS, "d64-deflate64.zip")); const e = readArchive(b).entries.find((x) => x.method === 9)!; const raw = b.subarray(e.dataOffset, e.dataOffset + (e.csize >> 1)); return await throwsMsg(() => inflateRawSync(raw, { deflate64: true, limit: e.usize }), /unexpected end|inflate/, "d64"); });
  await N("N20 bzip2 / LZMA corruption → error (no hang)", async () => {
    const b = open(join(D, "py-methods.zip")), a = readArchive(b); const res: string[] = [];
    for (const nm of ["bzip2/text.bin", "lzma/text.bin"]) { const e = a.entries.find((x) => x.name === nm)!; for (const off of [40, 400, 4000]) { const o = b.slice(); o[e.dataOffset + off] ^= 0x10; const t0 = Date.now(); res.push((await throwsMsg(() => readEntry(o, e), /bzip2|lzma|CRC|size/, nm + off)).split(":")[0]); ok(Date.now() - t0 < 5000, "slow"); } }
    return res.join(",");
  });
  await N("N21 stale Unicode Path ignored", () => { const a = readArchive(open(join(D, "py-upath-stale.zip"))); ok(a.entries[0].name === "???.txt", a.entries[0].name); return "kept header name"; });
  await N("N22 writer refuses unsafe + duplicate names", async () => { await throwsMsg(() => writeArchive([{ name: "../x", data: new Uint8Array(1) }]), /unsafe/, "w unsafe"); return await throwsMsg(() => writeArchive([{ name: "a", data: new Uint8Array(1) }, { name: "a", data: new Uint8Array(1) }]), /duplicate/, "w dup"); });
  await N("N23 method 99 without AES extra", async () => { const z = await plain(["q.txt"]); const o = z.slice(); const dv = new DataView(o.buffer); for (let i = 0; i < o.length - 4; i++) if (dv.getUint32(i, true) === 0x02014b50) { dv.setUint16(i + 10, 99, true); break; } return await throwsMsg(() => readArchive(o), /method 99/, "99"); });
  await N("N24 per-entry size limit + editor refuses rename onto an existing name", async () => {
    await throwsMsg(() => readArchive(open(join(D, "py-methods.zip")), { ...DEFAULT_LIMITS, maxEntryBytes: 1000 }), /declares/, "size");
    return await throwsMsg(() => editArchive(open(join(D, "py-methods.zip")), [{ op: "rename", from: "stored/one.bin", to: "stored/hello.bin" }]), /duplicate/, "rename dup");
  });
  console.log("  " + out.join("\n  "));
  ok(!fails.length, fails.join("\n"));
  return `${out.length} negative shapes hold`;
});

void readdirSync; void crc32;
finish();
