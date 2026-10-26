/**
 * TT79 — PDF signing identities from PKCS #12, visible signatures, a personal trust list.
 *   src/lib/pdf/legacyciphers.ts, src/lib/pdf/pkcs12.ts, src/lib/pdf/pdfsig.ts (trust + visible appearance).
 *
 * Oracles (test-only, never shipped): node:crypto/OpenSSL 3.0.20 (3DES), RFC 2268 §5 (RC2) and RFC 6229 (RC4)
 * vectors; PFX files written by pyca/cryptography 50 and by the OpenSSL CLI (default AES, -legacy RC2/3DES, -nomac,
 * -macalg sha512, NONE encryption); pyHanko 0.38 for chain trust (`trust_roots`) and signature validity; PDFium for
 * the visible appearance (ink inside the widget rectangle, text inside the rectangle); qpdf for syntax.
 *
 *  P1  ciphers: 3DES-CBC == OpenSSL both ways, RC2 RFC 2268 vectors, RC4 RFC 6229 vector, unpad rejects bad pads
 *  P2  every PFX variant parses: the private key == the key the writer was given (cryptography compares the private
 *      numbers), the certificate set == leaf + chain, the MAC and encryption schemes are named as OpenSSL names them
 *  P3  wrong password → P12PasswordError for every variant; one flipped byte in the authSafe → MAC error;
 *      -nomac + wrong password → still refused (padding / DER check), never a garbage key
 *  P4  identityFromPkcs12: the key/cert pairing is PROVED (challenge signature); chain ordered leaf → root; a file
 *      whose only certificate belongs to another key is refused
 *  P5  sign with a PFX identity (RSA and EC, unicode password), visible on page 2 → pyHanko intact + valid +
 *      ENTIRE_FILE + trusted (root given) / untrusted (no root); Fusion: valid; trust "trusted" with the root as anchor,
 *      also with the intermediate as anchor, "untrusted" with an unrelated anchor, "no-anchors" without
 *  P6  visible appearance: PDFium renders ink inside the rectangle on page 2 and none outside it vs the unsigned page,
 *      page 1 is pixel-identical; the appearance text (signer, reason) is extracted inside the rectangle; qpdf clean
 *  P8  rotated pages (/Rotate 0, 90, 180, 270): placeSignature puts the box in the SEEN bottom-right corner and the
 *      appearance is counter-rotated — PDFium's rendering (which applies /Rotate) has all new ink in that corner and
 *      the rendered box matches the unrotated one (dark-pixel IoU ≥ 0.9), i.e. the text reads upright
 *  P7  trust negatives agree with pyHanko's bottom line: non-CA intermediate, expired signer, signer whose key usage
 *      forbids signing → pyHanko not (valid ∧ trusted), Fusion trust "untrusted" with a reason
 *  N1… hostile PFX: random bytes, truncated, iteration count 2^31, > 1 MiB, PBMAC1, envelopedData authSafe,
 *      257 bags, nesting depth 6, a PBES2 with an unknown cipher — an Error (never a hang, never a key)
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { PdfDoc } from "../src/lib/pdf/pdfdoc.ts";
import { validateSignatures, signPdf, tlv, parseCert, placeSignature } from "../src/lib/pdf/pdfsig.ts";
import { parsePkcs12, identityFromPkcs12, P12PasswordError, bmpPassword, p12kdf } from "../src/lib/pdf/pkcs12.ts";
import { des3Cbc, rc2Ecb, rc4, unpad } from "../src/lib/pdf/legacyciphers.ts";
import { hmac } from "../src/lib/office/cryptoprims.ts";
import { mkpdf } from "./tt52/mkpdf.ts";

const { test, finish } = makeHarness("tt79-pdf");
const PY = "/home/user/tools/venv/bin/python", ORACLE = join(process.cwd(), "scripts/oracle/p12_oracle.py");
const have = existsSync(PY);
const T = mkdtempSync(join(tmpdir(), "tt79pdf-"));
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex"), h = (s: string) => Uint8Array.from(Buffer.from(s, "hex"));
const C1 = { "FF-73": "full" as const }, C2 = { "FF-74": "full" as const }, C3 = { "FF-75": "full" as const };
const py = (...a: string[]) => execFileSync(PY, [ORACLE, ...a], { encoding: "utf8", maxBuffer: 1 << 24 }).trim();
const rd = (f: string) => new Uint8Array(readFileSync(join(T, f)));
const throwsKind = async (fn: () => Promise<unknown>, kind: "password" | "error", label: string) => {
  const t0 = Date.now(); let err: unknown = null; try { await fn(); } catch (e) { err = e; }
  ok(err, `${label}: accepted`); ok(Date.now() - t0 < 5000, `${label}: took ${Date.now() - t0} ms`);
  if (kind === "password") ok(err instanceof P12PasswordError, `${label}: ${(err as Error).message} is not a password error`);
};

// ---- fixtures: cryptography writer + OpenSSL CLI writer
py("make", T);
const man = JSON.parse(readFileSync(join(T, "manifest.json"), "utf8")) as Record<string, { password: string; key: string | null }>;
const ossl = (out: string, ...extra: string[]) => {
  execFileSync("openssl", ["pkcs12", "-export", "-inkey", join(T, "leaf.key.pem"), "-in", join(T, "leaf.pem"), "-certfile", join(T, "chain.pem"), "-name", "ada", "-passout", "pass:open sesame", "-out", join(T, out), ...extra], { stdio: "pipe" });
  man[out] = { password: "open sesame", key: "leaf.key.der" };
};
ossl("os_default.p12"); ossl("os_legacy.p12", "-legacy"); ossl("os_nomac.p12", "-nomac"); ossl("os_sha512.p12", "-macalg", "sha512");
ossl("os_none.p12", "-keypbe", "NONE", "-certpbe", "NONE"); ossl("os_aes128.p12", "-keypbe", "AES-128-CBC", "-certpbe", "AES-128-CBC");
const SCHEMES: Record<string, RegExp> = {
  "os_default.p12": /AES-256/, "os_legacy.p12": /RC2-CBC|3-KeyTripleDES/, "cg_3des.p12": /3-KeyTripleDES/, "cg_best.p12": /PBES2 PBKDF2-HMAC-SHA256 AES-256/, "os_aes128.p12": /AES-128/,
};
const MACS: Record<string, string | null> = { "os_nomac.p12": null, "os_sha512.p12": "HMAC-SHA512", "cg_pbes2.p12": "HMAC-SHA512", "cg_3des.p12": "HMAC-SHA1", "os_legacy.p12": "HMAC-SHA1", "os_default.p12": "HMAC-SHA256" };

// DER builders for spliced / hostile PFX files
const SEQ = (...p: Uint8Array[]) => tlv(0x30, ...p), SET = (...p: Uint8Array[]) => tlv(0x31, ...p), CTX0 = (...p: Uint8Array[]) => tlv(0xa0, ...p), OCT = (b: Uint8Array) => tlv(4, b);
const OIDb = (s: string) => { const a = s.split(".").map(Number); const out = [a[0] * 40 + a[1]]; for (const v of a.slice(2)) { const t: number[] = []; let x = v; do { t.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x); for (let i = 0; i < t.length - 1; i++) t[i] |= 0x80; out.push(...t); } return tlv(6, out); };
const INTb = (n: number) => { const b: number[] = []; let x = n; do { b.unshift(x & 255); x = Math.floor(x / 256); } while (x); if (b[0] & 0x80) b.unshift(0); return tlv(2, b); };
function keyBag(pk8: Uint8Array) { return SEQ(OIDb("1.2.840.113549.1.12.10.1.1"), CTX0(pk8)); }
function certBag(c: Uint8Array) { return SEQ(OIDb("1.2.840.113549.1.12.10.1.3"), CTX0(SEQ(OIDb("1.2.840.113549.1.9.22.1"), CTX0(OCT(c))))); }
function pfxPlain(bags: Uint8Array[], extra?: Uint8Array) {
  const sc = SEQ(...bags); const authSafe = SEQ(SEQ(OIDb("1.2.840.113549.1.7.1"), CTX0(OCT(sc))));
  return SEQ(INTb(3), SEQ(OIDb("1.2.840.113549.1.7.1"), CTX0(OCT(authSafe))), ...(extra ? [extra] : []));
}

await test("P1 ciphers: 3DES == OpenSSL, RC2 RFC 2268 vectors, RC4 RFC 6229, PKCS#7 unpad", C1, () => {
  for (let t = 0; t < 8; t++) {
    const k = randomBytes(t % 2 ? 16 : 24), iv = randomBytes(8), d = randomBytes(8 * (1 + t * 3));
    const c = createCipheriv(k.length === 24 ? "des-ede3-cbc" : "des-ede-cbc", k, iv); c.setAutoPadding(false); const ref = Buffer.concat([c.update(d), c.final()]);
    ok(hex(des3Cbc(k, iv, d, false)) === ref.toString("hex"), "3DES encrypt differs from OpenSSL"); ok(hex(des3Cbc(k, iv, ref, true)) === d.toString("hex"), "3DES decrypt differs");
  }
  const V: [string, number, string, string][] = [["0000000000000000", 63, "0000000000000000", "ebb773f993278eff"], ["ffffffffffffffff", 64, "ffffffffffffffff", "278b27e42e2f0d49"], ["3000000000000000", 64, "1000000000000001", "30649edf9be7d2c2"], ["88", 64, "0000000000000000", "61a8a244adacccf0"], ["88bca90e90875a", 64, "0000000000000000", "6ccf4308974c267f"], ["88bca90e90875a7f0f79c384627bafb2", 64, "0000000000000000", "1a807d272bbe5db1"], ["88bca90e90875a7f0f79c384627bafb2", 128, "0000000000000000", "2269552ab0f85ca6"]];
  for (const [k, e, p, c] of V) { const ct = rc2Ecb(h(k), e, h(p)); ok(hex(ct) === c, `RC2 ${k}/${e}: ${hex(ct)} ≠ ${c}`); ok(hex(rc2Ecb(h(k), e, ct, true)) === p, "RC2 decrypt"); }
  ok(hex(rc4(h("0102030405"), new Uint8Array(16))) === "b2396305f03dc027ccc3524a0a1118a8", "RC4 RFC 6229 key 0102030405");
  let bad = 0; for (const s of ["4142430000000000", "4142430304050603", "00", "4142434445464748"]) { try { unpad(h(s), 8); } catch { bad++; } }
  ok(bad === 4, `unpad accepted ${4 - bad} bad paddings`);
  ok(hex(unpad(h("4142430505050505"), 8)) === "414243", "unpad of a good pad");
});

await test("P2 every PFX variant parses: key == writer's key, certificates == leaf + chain, MAC + schemes named", C1, async () => {
  const want = new Set(["leaf", "inter", "root"].map((n) => hex(rd(n + ".der"))));
  for (const [f, m] of Object.entries(man)) {
    if (!m.key) continue;
    const c = await parsePkcs12(rd(f), m.password);
    ok(c.keys.length === 1, `${f}: ${c.keys.length} keys`);
    writeFileSync(join(T, "got.key.der"), c.keys[0].der);
    ok(py("keyeq", join(T, "got.key.der"), join(T, m.key)) === "same", `${f}: the decrypted key is not the writer's key`);
    const got = new Set(c.certs.map((x) => hex(x.der)));
    if (m.key === "leaf.key.der") ok(got.size === 3 && [...want].every((x) => got.has(x)), `${f}: certificates differ`);
    else ok(got.size === 3 && got.has(hex(rd("ec_leaf.der"))), `${f}: EC certificates differ`);
    if (f in MACS) ok(c.macAlg === MACS[f], `${f}: MAC ${c.macAlg}, want ${MACS[f]}`);
    if (SCHEMES[f]) ok(c.schemes.length > 0 && c.schemes.every((s) => SCHEMES[f].test(s) || (f === "os_legacy.p12" && /RC2|TripleDES/.test(s))), `${f}: schemes ${c.schemes.join(", ")}`);
    if (f === "os_legacy.p12") ok(c.schemes.some((s) => /40BitRC2/.test(s)) && c.schemes.some((s) => /3-KeyTripleDES/.test(s)), `legacy: ${c.schemes}`);
    if (f === "os_none.p12" || f === "cg_plain.p12") ok(c.schemes.length === 0, `${f}: unexpected encryption ${c.schemes}`);
    if (f.startsWith("os_")) ok(c.keys[0].friendlyName === "ada" && c.keys[0].localKeyId, `${f}: friendlyName/localKeyId not read`);
  }
});

await test("P3 wrong password refused everywhere; a flipped authSafe byte breaks the MAC; -nomac still refuses", C1, async () => {
  for (const [f, m] of Object.entries(man)) {
    if (f === "os_none.p12" || f === "cg_plain.p12") continue; // nothing encrypted: a MAC-less/plain file has no secret
    await throwsKind(() => parsePkcs12(rd(f), m.password + "x"), "password", `${f} wrong password`);
  }
  // the MAC catches a wrong password even when nothing is encrypted (os_none still has a MAC)
  await throwsKind(() => parsePkcs12(rd("os_none.p12"), "nope"), "password", "os_none wrong password (MAC)");
  const t = rd("os_default.p12"); t[200] ^= 1; await throwsKind(() => parsePkcs12(t, "open sesame"), "error", "flipped byte");
  let msg = ""; try { await parsePkcs12(t, "open sesame"); } catch (e) { msg = (e as Error).message; } ok(/MAC|DER|PKCS/.test(msg), `flipped byte message: ${msg}`);
  // PKCS#12 KDF sanity: the MAC key differs per ID and per password
  const s = h("0102030405060708"); ok(hex(p12kdf("SHA1", bmpPassword("a"), s, 3, 2, 20)) !== hex(p12kdf("SHA1", bmpPassword("b"), s, 3, 2, 20)), "kdf ignores the password");
  ok(hex(bmpPassword("✓")) === "27130000" && hex(bmpPassword("")) === "0000", "BMPString encoding");
  void hmac;
});

await test("P4 identityFromPkcs12: pairing proved, chain leaf→root, mismatched file refused", C1, async () => {
  const id = await identityFromPkcs12(rd("os_legacy.p12"), "open sesame");
  ok(id.alg === "RSA" && id.name === "Ada Signer", `identity ${id.alg} ${id.name}`);
  ok(hex(id.certDer) === hex(rd("leaf.der")), "the leaf is not the paired certificate");
  ok(id.chain.length === 2 && hex(id.chain[0]) === hex(rd("inter.der")) && hex(id.chain[1]) === hex(rd("root.der")), "chain order");
  ok(id.key.extractable === false, "the private key is extractable");
  const ec = await identityFromPkcs12(rd("cg_ec_unicode.p12"), "pässwörd✓"); ok(ec.alg === "ECDSA-P256" && ec.name === "Émile Signer", `EC identity ${ec.alg} ${ec.name}`);
  // a PFX whose certificate belongs to ANOTHER key: OpenSSL refuses to write one, so splice: key bag from A, cert bags from B
  // (both unencrypted: -keypbe NONE -certpbe NONE -nomac), rebuilt with the DER writer
  execFileSync("openssl", ["pkcs12", "-export", "-inkey", join(T, "other.key.pem"), "-nocerts", "-keypbe", "NONE", "-nomac", "-passout", "pass:", "-out", join(T, "keyonly.p12")], { stdio: "pipe" });
  const kc = await parsePkcs12(rd("keyonly.p12"), ""); ok(kc.keys.length === 1 && kc.certs.length === 0, "key-only file");
  await throwsKind(() => identityFromPkcs12(rd("keyonly.p12"), ""), "error", "no certificate");
  const mixed = pfxPlain([keyBag(kc.keys[0].der), ...[rd("leaf.der"), rd("inter.der")].map(certBag)]);
  let msg = ""; try { await identityFromPkcs12(mixed, ""); } catch (e) { msg = (e as Error).message; } ok(/matches its private key/.test(msg), `mismatched pair: ${msg || "accepted"}`);
});

const signed = new Map<string, string>();
const base = mkpdf([{ text: ["Contract page one"] }, { text: ["Page two — sign below"] }]); writeFileSync(join(T, "base.pdf"), base);
await test("P5 sign with PFX identities (visible, page 2) → pyHanko valid + trusted with the root; Fusion trust verdicts", { ...C1, ...C2, ...C3 }, async () => {
  for (const [f, pw] of [["os_legacy.p12", "open sesame"], ["cg_ec_unicode.p12", "pässwörd✓"]] as const) {
    const id = await identityFromPkcs12(rd(f), pw);
    const out = await signPdf(PdfDoc.open(base), id, { reason: "Approved by TT79", location: "Beachwood", visible: { page: 1, rect: [300, 60, 540, 140] } });
    const file = join(T, `signed-${f}.pdf`); writeFileSync(file, out); signed.set(f, file);
    const withRoot = JSON.parse(py("trust", file, join(T, "root.der")))[0], noRoot = JSON.parse(py("trust", file))[0];
    ok(!withRoot.error, `${f}: pyHanko ${withRoot.error}`);
    ok(withRoot.intact && withRoot.valid && withRoot.coverage === "ENTIRE_FILE" && withRoot.trusted && withRoot.bottom_line, `${f}: pyHanko with root ${JSON.stringify(withRoot)}`);
    ok(noRoot.intact && noRoot.valid && !noRoot.trusted, `${f}: pyHanko without root ${JSON.stringify(noRoot)}`);
    const doc = PdfDoc.open(out);
    const [r0] = await validateSignatures(doc); ok(r0.status === "valid" && r0.trust === "no-anchors", `${f}: ${r0.status}/${r0.trust}`);
    ok(r0.chain.length === 3 && r0.chain.every((c) => c.verifiedByIssuer), `${f}: chain ${JSON.stringify(r0.chain)}`);
    const [r1] = await validateSignatures(doc, { anchors: [rd("root.der")] }); ok(r1.trust === "trusted", `${f}: root anchor → ${r1.trust} (${r1.trustNote})`);
    const [r2] = await validateSignatures(doc, { anchors: [rd("inter.der")] }); ok(r2.trust === "trusted", `${f}: intermediate anchor → ${r2.trust} (${r2.trustNote})`);
    const [r3] = await validateSignatures(doc, { anchors: [rd("other_root.der")] }); ok(r3.trust === "untrusted" && r3.trustNote.length > 0, `${f}: unrelated anchor → ${r3.trust}`);
  }
});

await test("P6 visible appearance: PDFium ink only inside the rectangle on page 2, page 1 identical, text inside, qpdf clean", C2, () => {
  const file = signed.get("os_legacy.p12")!; ok(file, "P5 did not produce a file");
  const r = JSON.parse(execFileSync(PY, ["-c", `
import pypdfium2 as p, sys, json, pikepdf
def px(path, i):
    d = p.PdfDocument(path); d.init_forms(); pg = d[i]; im = pg.render(scale=1, may_draw_forms=True).to_pil().convert("L"); return d, pg, im
_, _, a1 = px(sys.argv[1], 0); _, _, b1 = px(sys.argv[2], 0)
d, pg, b2 = px(sys.argv[2], 1); _, _, a2 = px(sys.argv[1], 1)
H = b2.size[1]; inside = outside = 0
for y in range(b2.size[1]):
    for x in range(b2.size[0]):
        diff = abs(a2.getpixel((x, y)) - b2.getpixel((x, y))) > 24
        if not diff: continue
        if 300 <= x <= 540 and 60 <= H - y <= 140: inside += 1
        else: outside += 1
q = pikepdf.open(sys.argv[2]); probs = q.check_pdf_syntax()
# qpdf (independent of Fusion's parser) merges the widget appearance into the page; PDFium then extracts its text
q.flatten_annotations("all"); q.save(sys.argv[3])
fl = p.PdfDocument(sys.argv[3])[1]; txt = fl.get_textpage().get_text_bounded(300, 60, 540, 140)
print(json.dumps({"page1_same": a1.tobytes() == b1.tobytes(), "inside": inside, "outside": outside, "text": txt, "qpdf": [str(x) for x in probs]}))
`, join(T, "base.pdf"), file, join(T, "flat.pdf")], { encoding: "utf8" }).trim());
  ok(r.page1_same, "page 1 changed");
  ok(r.inside > 800, `too little ink inside the widget: ${r.inside}`); ok(r.outside === 0, `${r.outside} changed pixels outside the widget`);
  ok(/Digitally signed by/.test(r.text) && /Ada Signer/.test(r.text) && /Approved by TT79/.test(r.text) && /Beachwood/.test(r.text), `appearance text: ${JSON.stringify(r.text)}`);
  ok(r.qpdf.length === 0, `qpdf: ${r.qpdf.join("; ")}`);
});

await test("P8 rotated pages: the visible box lands in the seen corner and reads upright (PDFium, IoU vs unrotated)", C2, async () => {
  const id = await identityFromPkcs12(rd("os_legacy.p12"), "open sesame");
  const files: string[] = [];
  for (const rot of [0, 90, 180, 270]) {
    const src = join(T, `rot${rot}.pdf`);
    execFileSync(PY, ["-c", "import pikepdf,sys; p=pikepdf.open(sys.argv[1]); p.pages[0].Rotate=int(sys.argv[3]); p.save(sys.argv[2])", join(T, "base.pdf"), src, String(rot)]);
    const doc = PdfDoc.open(new Uint8Array(readFileSync(src))); const pg = doc.pages()[0]; ok(pg.rotate === rot, `fixture rotate ${pg.rotate}`);
    const rect = placeSignature(pg, "bottom-right", 200, 64, 30);
    const out = await signPdf(doc, id, { reason: "Rotation check", visible: { page: 0, rect } }); const f = join(T, `rot${rot}-signed.pdf`); writeFileSync(f, out); files.push(src, f);
  }
  const r = JSON.parse(execFileSync(PY, ["-c", `
import pypdfium2 as p, sys, json
def img(path):
    d = p.PdfDocument(path); d.init_forms(); return d[0].render(scale=1, may_draw_forms=True).to_pil().convert("L")
res = []; patches = []
args = sys.argv[1:]
for i in range(0, len(args), 2):
    a, b = img(args[i]), img(args[i + 1]); W, H = b.size
    xs = []; ys = []; n = 0
    for y in range(H):
        for x in range(W):
            if abs(a.getpixel((x, y)) - b.getpixel((x, y))) > 24: n += 1; xs.append(x); ys.append(y)
    box = [min(xs), min(ys), max(xs), max(ys)] if n else None
    res.append({"W": W, "H": H, "n": n, "box": box})
    if box:
        crop = b.crop((box[0], box[1], box[0] + 200, box[1] + 64)); patches.append([1 if v < 128 else 0 for v in crop.get_flattened_data()])
ious = []
for q in patches[1:]:
    inter = sum(1 for u, v in zip(patches[0], q) if u and v); uni = sum(1 for u, v in zip(patches[0], q) if u or v); ious.append(inter / max(1, uni))
print(json.dumps({"res": res, "ious": ious}))
`, ...files], { encoding: "utf8", maxBuffer: 1 << 24 }).trim());
  r.res.forEach((x: { W: number; H: number; n: number; box: number[] | null }, i: number) => {
    ok(x.n > 500 && x.box, `rotate ${i * 90}: no ink`);
    const [bx0, by0, bx1, by1] = x.box!; // image coordinates: y grows downward; the seen bottom-right corner, 30 pt in
    ok(bx0 >= x.W / 2 && by0 >= x.H / 2 && bx1 <= x.W - 28 && by1 <= x.H - 28, `rotate ${i * 90}: ink box ${x.box} not in the bottom-right of ${x.W}×${x.H}`);
    ok(Math.abs((bx1 - bx0) - 200) <= 3 && Math.abs((by1 - by0) - 64) <= 3, `rotate ${i * 90}: box ${bx1 - bx0}×${by1 - by0} is not upright 200×64`);
  });
  ok(r.ious.every((v: number) => v >= 0.9), `rotated appearances differ from the upright one: IoU ${r.ious.map((v: number) => v.toFixed(3))}`);
});

await test("P7 trust negatives agree with pyHanko: non-CA intermediate, expired signer, key usage without signing", C3, async () => {
  const base = mkpdf([{ text: ["Trust negatives"] }]);
  for (const f of ["notca.p12", "expired.p12", "nosign.p12"]) {
    const id = await identityFromPkcs12(rd(f), "correct horse");
    const out = await signPdf(PdfDoc.open(base), id, { visible: { page: 0, rect: [40, 40, 240, 100] } }); const file = join(T, `neg-${f}.pdf`); writeFileSync(file, out);
    const ph = JSON.parse(py("trust", file, join(T, "root.der")))[0];
    ok(!ph.bottom_line, `${f}: pyHanko bottom line is true (${JSON.stringify(ph)})`);
    const [r] = await validateSignatures(PdfDoc.open(out), { anchors: [rd("root.der")] });
    ok(r.trust === "untrusted", `${f}: Fusion trust ${r.trust} (${r.trustNote})`);
    ok(r.trustNote.length > 0, `${f}: no reason given`);
  }
  // control: the same path WITH a CA intermediate is trusted (so the negatives fail for their stated reason)
  ok(signed.size === 2, "P5 controls missing");
});

/* ---------------------------------------------------------------- hostile */
const hostile: [string, () => Uint8Array, string][] = [
  ["random bytes", () => new Uint8Array(randomBytes(4096)), "error"],
  ["truncated PFX", () => rd("os_default.p12").subarray(0, 700), "error"],
  ["iteration count 2^31 in the MAC", () => { const sc = pfxPlain([certBag(rd("leaf.der"))]); const k = parse(sc); return SEQ(k[0], k[1], SEQ(SEQ(SEQ(OIDb("1.3.14.3.2.26"), tlv(5, [])), OCT(new Uint8Array(20))), OCT(new Uint8Array(8)), INTb(2 ** 31))); }, "error"],
  ["larger than 1 MiB", () => { const b = new Uint8Array((1 << 20) + 10); b.set(rd("os_default.p12")); return b; }, "error"],
  ["PBMAC1 integrity", () => { const k = parse(pfxPlain([certBag(rd("leaf.der"))])); return SEQ(k[0], k[1], SEQ(SEQ(SEQ(OIDb("1.2.840.113549.1.5.14"), SEQ()), OCT(new Uint8Array(32))), OCT(new Uint8Array(8)), INTb(1))); }, "error"],
  ["envelopedData authSafe", () => SEQ(INTb(3), SEQ(OIDb("1.2.840.113549.1.7.3"), CTX0(SEQ()))), "error"],
  ["257 bags", () => pfxPlain(Array.from({ length: 257 }, () => certBag(new Uint8Array([0x30, 0])))), "error"],
  ["safeContents nested 6 deep", () => { let b = certBag(rd("leaf.der")); for (let i = 0; i < 6; i++) b = SEQ(OIDb("1.2.840.113549.1.12.10.1.6"), CTX0(SEQ(b))); return pfxPlain([b]); }, "error"],
  ["PBES2 with an unknown cipher", () => {
    const alg = SEQ(OIDb("1.2.840.113549.1.5.13"), SEQ(SEQ(OIDb("1.2.840.113549.1.5.12"), SEQ(OCT(new Uint8Array(8)), INTb(1))), SEQ(OIDb("1.2.3.4.5"), OCT(new Uint8Array(16)))));
    return pfxPlain([SEQ(OIDb("1.2.840.113549.1.12.10.1.2"), CTX0(SEQ(alg, OCT(new Uint8Array(32)))))]);
  }, "error"],
];
function parse(b: Uint8Array) { const out: Uint8Array[] = []; let p = 2 + (b[1] & 0x80 ? b[1] & 0x7f : 0); while (p < b.length) { const l0 = b[p + 1]; let len = l0, hl = 2; if (l0 & 0x80) { len = 0; for (let i = 0; i < (l0 & 0x7f); i++) len = len * 256 + b[p + 2 + i]; hl = 2 + (l0 & 0x7f); } out.push(b.subarray(p, p + hl + len)); p += hl + len; } return out; }
let n = 0;
for (const [label, mk, kind] of hostile) {
  n++;
  await test(`N${n} hostile PFX: ${label}`, C1, async () => {
    await throwsKind(() => parsePkcs12(mk(), ""), kind as "error", label);
    await throwsKind(() => identityFromPkcs12(mk(), ""), "error", label + " (identity)");
  });
}
void parseCert;
finish();
if (!have) console.log("(python oracle missing)");
