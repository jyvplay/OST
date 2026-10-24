/**
 * TT48 — re-encrypting save for Writer/Spreadsheet: original MS-CFB writer + MS-OFFCRYPTO Agile encryption.
 * Independent verifiers (test-only): olefile 0.47 (BSD) strict compound-file parser; msoffcrypto-tool 6.0.0 (MIT)
 * decryption WITH HMAC integrity verification; msoffcrypto-tool's own encrypt output for the static DataSpaces streams.
 * Run: node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/tt48-office.mts
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { makeHarness } from "./harness.mts";
import { writeCfb, cfbCompare, type CfbNode } from "../src/lib/office/cfbwrite.ts";
import { readCfb, decryptOffice, encryptOffice, isEncryptedOffice, dataSpacesStorage, deriveAgileKey } from "../src/lib/office/offcrypto.ts";

const { test, finish } = makeHarness("tt48-office");
const COV = { "FF-20": "full", "FF-21": "full", "FF-22": "full", "FF-11": "full", "PR-11": "partial" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python", C = "/home/user/tools/corpus";
const tmp = mkdtempSync(join(tmpdir(), "tt48-"));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const olefile = (paths: string[]) => execFileSync(PY, ["scripts/oracle/cfb_probe.py"], { input: paths.join("\n") + "\n", maxBuffer: 256 << 20 }).toString().trim().split("\n").map((l) => JSON.parse(l) as { path: string; ok: boolean; error?: string; streams: Record<string, number>; sha: Record<string, string> });
const msoff = (rows: [string, string, string][]) => execFileSync(PY, ["scripts/oracle/msoff_decrypt.py"], { input: rows.map((r) => r.join("\t")).join("\n") + "\n", maxBuffer: 64 << 20 }).toString().trim().split("\n").map((l) => JSON.parse(l) as { in: string; ok: boolean; error?: string });
let seed = 0x5eed48; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

/** flatten a tree into "a/b" → bytes */
const flat = (nodes: CfbNode[], pre = ""): Map<string, Uint8Array> => { const m = new Map<string, Uint8Array>(); for (const n of nodes) { const k = pre + n.name; if (n.children) for (const [a, b] of flat(n.children, k + "/")) m.set(a, b); else m.set(k, n.data ?? new Uint8Array(0)); } return m; };

await test("CFB writer: 40 random trees (nested storages, Unicode names, 0…20,000-byte streams across the 4096 mini-stream cutoff) parse under olefile's strict mode and our reader with identical bytes", COV, async () => {
  const ALPH = "abcXYZ019 _-.é漢Ωдś";
  const trees: CfbNode[][] = [];
  for (let t = 0; t < 40; t++) {
    const mk = (depth: number): CfbNode[] => {
      const n = 1 + rnd(depth === 0 ? 9 : 5); const used = new Set<string>(); const out: CfbNode[] = [];
      for (let i = 0; i < n; i++) {
        let name = ""; const L = 1 + rnd(20); for (let k = 0; k < L; k++) name += ALPH[rnd(ALPH.length)];
        name = name.trim() || `n${i}`; if (used.has(name.toUpperCase())) continue; used.add(name.toUpperCase());
        if (depth < 3 && rnd(4) === 0) out.push({ name, children: mk(depth + 1) });
        else { const sizes = [0, 1, 63, 64, 65, 4095, 4096, 4097, rnd(20000), rnd(3000)]; out.push({ name, data: new Uint8Array(randomBytes(sizes[rnd(sizes.length)])) }); }
      }
      return out.length ? out : [{ name: "x", data: new Uint8Array(5) }];
    };
    trees.push(mk(0));
  }
  const paths = trees.map((tr, i) => { const p = join(tmp, `tree${i}.cfb`); writeFileSync(p, writeCfb(tr)); return p; });
  const res = olefile(paths);
  let streams = 0;
  res.forEach((r, i) => {
    ok(r.ok, `tree ${i}: olefile strict parse failed: ${r.error}`);
    const want = flat(trees[i]);
    // olefile lists only non-empty-name streams; it reports every stream, including empty ones
    ok(Object.keys(r.streams).length === want.size, `tree ${i}: ${Object.keys(r.streams).length} streams vs ${want.size}`);
    for (const [k, b] of want) { ok(r.sha[k] === sha(b), `tree ${i}: olefile bytes differ for ${k}`); streams++; }
    const ours = readCfb(new Uint8Array(readFileSync(paths[i])));
    const walk = (idx: number, pre: string, out: Map<string, Uint8Array>) => {
      const seen = new Set<number>(); const rec = (j: number) => { if (j === 0xffffffff || seen.has(j)) return; seen.add(j); const e = ours.entries[j]; rec(e.left); const k = pre + e.name; if (e.type === 2) out.set(k, ours.stream(e)); else walk(e.child, k + "/", out); rec(e.right); };
      rec(idx); return out;
    };
    // MS-CFB 2.6.4 invariants Office relies on and olefile does not check: every sibling tree is a BST in
    // (length, uppercase) order and colouring is valid (all black is a valid red-black tree when it is balanced)
    const raw = new Uint8Array(readFileSync(paths[i])); const dirStart = new DataView(raw.buffer).getUint32(48, true);
    const height = (j: number, lo: string | null, hi: string | null): number => {
      if (j === 0xffffffff) return 0; const e = ours.entries[j];
      ok((lo === null || cfbCompare(lo, e.name) < 0) && (hi === null || cfbCompare(e.name, hi) < 0), `tree ${i}: sibling order broken at ${e.name}`);
      const off = 512 + dirStart * 512 + j * 128 + 67; ok(raw[off] === 1, `tree ${i}: ${e.name} not black`);
      const hl = height(e.left, lo, e.name), hr = height(e.right, e.name, hi); ok(hl === hr || Math.abs(hl - hr) <= 1, `tree ${i}: unbalanced at ${e.name}`);
      return 1 + Math.max(hl, hr);
    };
    for (const e of ours.entries) if (e.type === 1 || e.type === 5) height(e.child, null, null);
    const mine = walk(ours.entries[0].child, "", new Map());
    for (const [k, b] of want) ok(mine.has(k) && sha(mine.get(k)!) === sha(b), `tree ${i}: our reader differs for ${k}`);
  });
  console.log(`    40 trees, ${streams} streams byte-identical in olefile (strict) and our reader`);
});

await test("CFB writer: a 7.5 MB stream needs more than 109 FAT sectors → DIFAT chain; olefile strict + our reader agree; sibling order follows MS-CFB 2.6.4", COV, async () => {
  const big = new Uint8Array(randomBytes(7_500_000)); const p = join(tmp, "big.cfb");
  writeFileSync(p, writeCfb([{ name: "Big", data: big }, { name: "small", data: new Uint8Array([1, 2, 3]) }]));
  const b = new Uint8Array(readFileSync(p)); const dv = new DataView(b.buffer);
  ok(dv.getUint32(72, true) >= 1 && dv.getUint32(44, true) > 109, `expected a DIFAT: fat=${dv.getUint32(44, true)} difat=${dv.getUint32(72, true)}`);
  const [r] = olefile([p]); ok(r.ok, `olefile: ${r.error}`); ok(r.sha.Big === sha(big), "olefile big bytes");
  const c = readCfb(b); ok(sha(c.stream(c.rootChildren().find((e) => e.name === "Big")!)) === sha(big), "our reader big bytes");
  ok(cfbCompare("B", "aa") < 0 && cfbCompare("abc", "ABD") < 0 && cfbCompare("Ab", "aB") === 0, "MS-CFB name order");
  for (const bad of [[{ name: "a/b", data: new Uint8Array(1) }], [{ name: "x".repeat(32), data: new Uint8Array(1) }], [{ name: "Same", data: new Uint8Array(1) }, { name: "SAME", data: new Uint8Array(1) }]] as CfbNode[][]) {
    let threw = false; try { writeCfb(bad); } catch { threw = true; } ok(threw, `invalid tree accepted: ${bad.map((x) => x.name).join(",")}`);
  }
});

await test("DataSpaces storage streams are byte-identical to msoffcrypto-tool's encrypt output (independent writer)", COV, async () => {
  // msoffcrypto-tool 6.0.0 writes a corrupt CFB for packages < 4 KiB, so use the first ≥ 8 KiB corpus document
  const src = readdirSync(`${C}/docx`).sort().map((f) => `${C}/docx/${f}`).find((f) => f.endsWith(".docx") && statSync(f).size >= 8192 && readFileSync(f)[0] === 0x50)!;
  const vec = join(tmp, "msoff.enc"); execFileSync("/home/user/tools/venv/bin/msoffcrypto-tool", ["-e", "-p", "x", src, vec], { stdio: "pipe" });
  const ours = join(tmp, "ds.cfb"); writeFileSync(ours, writeCfb([dataSpacesStorage()]));
  const [a, b] = olefile([vec, ours]); ok(a.ok && b.ok, `${a.error ?? ""} ${b.error ?? ""}`);
  const keys = Object.keys(b.streams); ok(keys.length === 4, `4 DataSpaces streams, got ${keys}`);
  for (const k of keys) ok(a.sha[k] === b.sha[k], `${k} differs from msoffcrypto (${a.streams[k]} vs ${b.streams[k]} bytes)`);
});

const VEC: { name: string; plain: Uint8Array; enc: Uint8Array; pw: string }[] = [];
await test("re-encryption: 22 corpus .docx/.xlsx (1.9 KB … 3 MB, mini-stream and multi-segment, Unicode password) → msoffcrypto-tool decrypts byte-identically WITH HMAC verification, olefile strict parses, our reader agrees", COV, async () => {
  const pick = (dir: string) => readdirSync(`${C}/${dir}`).filter((f) => /\.(docx|xlsx)$/.test(f) && !/password|protected|clusterfuzz|crash|corrupt/i.test(f)).map((f) => `${C}/${dir}/${f}`)
    .filter((p) => { const b = readFileSync(p); return b[0] === 0x50 && b[1] === 0x4b && b.length < 4 << 20; }).sort((x, y) => statSync(x).size - statSync(y).size);
  const d = pick("docx"), x = pick("xlsx");
  const take = (arr: string[]) => [arr[0], arr[1], arr[Math.floor(arr.length * 0.25)], arr[Math.floor(arr.length * 0.5)], arr[Math.floor(arr.length * 0.75)], arr[Math.floor(arr.length * 0.9)], arr[arr.length - 1]];
  const files = [...new Set([...take(d), ...take(x), ...d.slice(2, 6), ...x.slice(2, 6)])];
  const rows: [string, string, string][] = [];
  files.forEach((f, i) => {
    const pw = i === 3 ? "pässwörd ✓ 密码 🔑" : i % 2 ? "Correct Horse Battery Staple" : "a";
    const plain = new Uint8Array(readFileSync(f)); const enc = encryptOffice(plain, pw, { spinCount: i < 2 ? 100000 : 1000 });
    const p = join(tmp, `enc${i}.docx`); writeFileSync(p, enc); rows.push([p, pw, join(tmp, `dec${i}`)]);
    VEC.push({ name: f.split("/").pop()!, plain, enc, pw });
  });
  const res = msoff(rows);
  res.forEach((r, i) => { ok(r.ok, `${VEC[i].name}: msoffcrypto-tool refused: ${r.error}`); ok(sha(new Uint8Array(readFileSync(rows[i][2]))) === sha(VEC[i].plain), `${VEC[i].name}: msoffcrypto output differs`); });
  const ole = olefile(rows.map((r) => r[0])); ole.forEach((r, i) => ok(r.ok, `${VEC[i].name}: olefile: ${r.error}`));
  for (const v of VEC) { const r = decryptOffice(v.enc, v.pw); ok(r.method === "agile" && r.integrity === "verified" && sha(r.bytes) === sha(v.plain), `${v.name}: our reader`); ok(isEncryptedOffice(v.enc), "detected"); }
  const sizes = VEC.map((v) => v.plain.length).sort((a, b) => a - b);
  ok(sizes[0] < 4096 && sizes[sizes.length - 1] > 1_000_000, `size coverage ${sizes[0]}…${sizes[sizes.length - 1]}`);
  console.log(`    ${VEC.length} files ${sizes[0]}…${sizes[sizes.length - 1]} bytes: msoffcrypto (HMAC verified) + olefile + our reader all byte-identical`);
});

await test("security properties: Office-default parameters, fresh salts/keys per save, no plaintext block in the ciphertext, wrong password and tampering refused by the independent decryptor", COV, async () => {
  const v = VEC.find((x) => x.plain.length > 20000)!;
  const info = (enc: Uint8Array) => { const c = readCfb(enc); return new TextDecoder().decode(c.stream(c.rootChildren().find((e) => e.name === "EncryptionInfo")!).subarray(8)); };
  const a = encryptOffice(v.plain, "same"), b = encryptOffice(v.plain, "same");
  const xa = info(a);
  for (const want of ['spinCount="100000"', 'hashAlgorithm="SHA512"', 'keyBits="256"', 'cipherChaining="ChainingModeCBC"', "encryptedHmacValue="]) ok(xa.includes(want), `EncryptionInfo lacks ${want}`);
  const salts = (x: string) => [...x.matchAll(/saltValue="([^"]+)"/g)].map((m) => m[1]);
  ok(salts(xa).join() !== salts(info(b)).join() && sha(a) !== sha(b), "two saves must use fresh salts and keys");
  // only distinctive blocks (≥ 8 distinct byte values) — zero runs occur both in ZIP data and in CFB sector padding
  const blocks = new Set<string>(); for (let i = 0; i + 16 <= v.plain.length; i++) { const blk = v.plain.subarray(i, i + 16); if (new Set(blk).size >= 8) blocks.add(Buffer.from(blk).toString("hex")); }
  let leaks = 0; for (let i = 0; i + 16 <= a.length; i++) if (blocks.has(Buffer.from(a.subarray(i, i + 16)).toString("hex"))) leaks++;
  ok(leaks === 0, `${leaks} plaintext blocks appear in the encrypted file`);
  const pa = join(tmp, "sec.enc"); writeFileSync(pa, a);
  const c = readCfb(a); const pkg = c.stream(c.rootChildren().find((e) => e.name === "EncryptedPackage")!);
  const at = Buffer.from(a).indexOf(Buffer.from(pkg.subarray(0, 64))); const t = a.slice(); t[at + 9000] ^= 1;
  const pt = join(tmp, "tampered.enc"); writeFileSync(pt, t);
  const [good, wrong, tam] = msoff([[pa, "same", join(tmp, "s1")], [pa, "Same", join(tmp, "s2")], [pt, "same", join(tmp, "s3")]]);
  ok(good.ok && !wrong.ok && !tam.ok, `msoffcrypto: good=${good.ok} wrong=${wrong.ok} tampered=${tam.ok} (${tam.error})`);
  let threw = 0; for (const f of [() => encryptOffice(new Uint8Array([1, 2, 3]), "x"), () => encryptOffice(v.plain, ""), () => decryptOffice(t, "same")]) { try { f(); } catch { threw++; } }
  ok(threw === 3, "non-ZIP input, empty password and a tampered file must be refused");
});

await test("window key cache: repeated saves reuse the derived password key (one 100,000-round derivation) but get a fresh package key, data salt and HMAC key; every save decrypts in msoffcrypto with HMAC verification", COV, async () => {
  const v = VEC[4]; const t0 = performance.now(); const key = deriveAgileKey("cached pw"); const tk = performance.now() - t0;
  const t1 = performance.now(); const a = encryptOffice(v.plain, "cached pw", { key }), b = encryptOffice(v.plain, "cached pw", { key }); const te = (performance.now() - t1) / 2;
  const x = (e: Uint8Array) => { const c = readCfb(e); return new TextDecoder().decode(c.stream(c.rootChildren().find((q) => q.name === "EncryptionInfo")!).subarray(8)); };
  const salts = (s: string) => [...s.matchAll(/saltValue="([^"]+)"/g)].map((m) => m[1]); const kv = (s: string) => /encryptedKeyValue="([^"]+)"/.exec(s)![1];
  const [sa, sb] = [salts(x(a)), salts(x(b))];
  ok(sa[1] === sb[1] && sa[0] !== sb[0] && kv(x(a)) !== kv(x(b)), "password salt shared, data salt and package key fresh");
  const pa = join(tmp, "ka.enc"), pb = join(tmp, "kb.enc"); writeFileSync(pa, a); writeFileSync(pb, b);
  const res = msoff([[pa, "cached pw", join(tmp, "ka")], [pb, "cached pw", join(tmp, "kb")]]);
  ok(res.every((r) => r.ok) && sha(new Uint8Array(readFileSync(join(tmp, "kb")))) === sha(v.plain), `msoffcrypto: ${res.map((r) => r.error).join()}`);
  console.log(`    derive ${tk.toFixed(0)} ms once; each cached save ${te.toFixed(1)} ms for ${v.plain.length} bytes`);
});

await finish();
process.exit(0);
