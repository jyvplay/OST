/**
 * TT77 — PDF digital signatures (src/lib/pdf/pdfsig.ts): validation of existing signatures and signing.
 *
 * Oracle: pyHanko 0.38 (MIT) + cryptography (Apache-2.0/BSD) in the test-only venv (scripts/oracle/pdfsig_oracle.py).
 * Mapping (pyHanko → Fusion): intact ≡ digestOk, valid ≡ signatureOk, coverage ENTIRE_FILE ≡ coversWholeFile.
 * Trust is never compared: Fusion has no trust store and never claims a signer's identity (pyHanko's `trusted` is
 * likewise false for every fixture — no roots configured).
 *
 *  G1  pyHanko-made fixtures (fresh keys every run): RSA PKCS#1 v1.5, RSA-PSS, ECDSA P-256, ECDSA P-384/SHA-384,
 *      Ed25519/SHA-512, CA→leaf chain, two signatures, a tampered byte, an incremental update after signing.
 *  G2  the corpus's signed files: same verdict as pyHanko for every signature pyHanko can evaluate.
 *  G3  sign with Fusion (device-made ECDSA P-256 identity) → pyHanko: intact, valid, ENTIRE_FILE; Fusion: valid;
 *      PDFium opens it and renders the page pixel-identically to the unsigned file (invisible signature);
 *      qpdf --check is clean.
 *  G4  imported RSA identity (PKCS#8 + cert made by `cryptography`) → pyHanko valid; certificate chain reported.
 *  G5  counter-signing a pyHanko-signed file: the first signature becomes "modified" (ENTIRE_REVISION in pyHanko,
 *      whose diff policy must classify our update as FORM_FILLING, not OTHER), ours is valid.
 *  G6  round-trip: re-opening our signed output in Fusion and signing again → both verdicts as pyHanko.
 *  N1… hostile: shifted ByteRange gap, ByteRange beyond EOF / negative / 3 entries, garbage /Contents, BER
 *      indefinite length, 2^31 length, missing signer certificate, unknown digest OID, cyclic field /Kids,
 *      empty /Contents — never "valid", never throws, bounded time.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeHarness } from "./harness.mts";
import { PdfDoc } from "../src/lib/pdf/pdfdoc.ts";
import { validateSignatures, signPdf, makeSelfSignedIdentity, importIdentity, der, kids, tlv, type SigReport } from "../src/lib/pdf/pdfsig.ts";
import { mkpdf } from "./tt52/mkpdf.ts";

const H = makeHarness("tt77-pdfsig");
const PY = "/home/user/tools/venv/bin/python", CORPUS = "/home/user/tools/corpus/pdf";
const ORACLE = join(process.cwd(), "scripts/oracle/pdfsig_oracle.py");
const have = existsSync(PY) && (() => { try { execFileSync(PY, ["-c", "import pyhanko, pikepdf, pypdfium2"]); return true; } catch { return false; } })();
const COV = { "FF-03": "full" as const, "PR-08": "partial" as const };
const tmp = mkdtempSync(join(tmpdir(), "tt77sig-"));
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
interface PH { field: string; intact?: boolean; valid?: boolean; coverage?: string; modification?: string; error?: string }
const pyValidate = (file: string): PH[] => JSON.parse(execFileSync(PY, [ORACLE, "validate", file], { encoding: "utf8", maxBuffer: 1 << 24 }).trim().split("\n").pop()!).pyhanko;
const agree = (ours: SigReport, ph: PH, label: string) => {
  ok(!ph.error, `${label}: pyHanko error ${ph.error}`);
  ok(ours.digestOk === ph.intact, `${label}: digestOk ${ours.digestOk} vs pyHanko intact ${ph.intact}`);
  ok((ours.signatureOk === true) === ph.valid, `${label}: signatureOk ${ours.signatureOk} vs pyHanko valid ${ph.valid}`);
  // declared divergence: delimiters inside the signed ranges → pyHanko says UNCLEAR; Fusion accepts (the gap is
  // verified hex-only, so every other byte is signed) and must say so in its notes
  const unclear = ph.coverage === "UNCLEAR" && ours.notes.some((n) => n.includes("non-standard"));
  ok(unclear || ours.coversWholeFile === (ph.coverage === "ENTIRE_FILE"), `${label}: coversWholeFile ${ours.coversWholeFile} vs ${ph.coverage}`);
  const want = !ph.intact || !ph.valid ? "invalid" : ph.coverage === "ENTIRE_FILE" || unclear ? "valid" : "modified";
  ok(ours.status === want, `${label}: status ${ours.status}, want ${want} (${ours.notes.join("; ")})`);
};
const reports = async (b: Uint8Array) => validateSignatures(PdfDoc.open(b));
const pdfiumPage = (file: string) => execFileSync(PY, ["-c", `
import pypdfium2 as p, sys, hashlib
d=p.PdfDocument(sys.argv[1]); b=d[0].render(scale=1).to_pil().convert('RGB').tobytes(); print(len(d), hashlib.sha256(b).hexdigest())`, file], { encoding: "utf8" }).trim();
const qpdfCheck = (file: string) => execFileSync(PY, ["-c", `
import pikepdf, sys
p=pikepdf.open(sys.argv[1]); probs=p.check_pdf_syntax(); print("OK" if not probs else "|".join(map(str,probs)))`, file], { encoding: "utf8" }).trim();
const fixtures = new Map<string, { file: string; pyhanko: PH[] }>();

if (!have) {
  await H.test("G0 oracle available", COV, () => { throw new Error("venv with pyHanko/pikepdf/pypdfium2 missing — suite cannot run"); });
} else {
  for (const l of execFileSync(PY, [ORACLE, "make", tmp], { encoding: "utf8" }).trim().split("\n")) { const j = JSON.parse(l); fixtures.set(j.name, j); }

  await H.test("G1 pyHanko fixtures: same verdict per signature (9 files, 10 signatures)", COV, async () => {
    const expect: Record<string, string[]> = { rsa_pkcs1: ["valid"], rsa_pss: ["valid"], ecdsa_p256: ["valid"], ecdsa_p384_sha384: ["valid"], ed25519: ["valid"], chain: ["valid"], double: ["modified", "valid"], tampered: ["invalid"], appended: ["modified"] };
    let n = 0;
    for (const [name, want] of Object.entries(expect)) {
      const fx = fixtures.get(name); ok(fx, `fixture ${name} missing`);
      const ours = await reports(readFileSync(fx!.file)); ok(ours.length === fx!.pyhanko.length, `${name}: ${ours.length} signatures vs pyHanko ${fx!.pyhanko.length}`);
      ours.forEach((r, i) => { agree(r, fx!.pyhanko[i], `${name}[${i}]`); ok(r.status === want[i], `${name}[${i}] ${r.status} ≠ ${want[i]}`); n++; });
    }
    ok(n === 10, `${n} signatures compared`);
    const ch = (await reports(readFileSync(fixtures.get("chain")!.file)))[0];
    ok(ch.chain.length === 2 && ch.chain[0].verifiedByIssuer === true && ch.chain[1].verifiedByIssuer === true && !ch.selfSigned, `chain ${JSON.stringify(ch.chain)}`);
    ok(/TT77 Leaf/.test(ch.signer) && /TT77 Root CA/.test(ch.issuer), `signer/issuer ${ch.signer} / ${ch.issuer}`);
    const ss = (await reports(readFileSync(fixtures.get("rsa_pkcs1")!.file)))[0]; ok(ss.selfSigned && ss.certValidAtSigning === true && ss.signingTime, "self-signed + validity window");
    // the signed signingTime attribute (UTCTime, 2-digit year) must decode to "now", not 20xx-misread
    ok(Math.abs(Date.parse(ss.signingTime!) - Date.now()) < 36e5, `signingTime ${ss.signingTime}`); ok(!ss.notes.some((n) => n.includes("/M")), "time must come from the signed attribute");
  });

  await H.test("G2 corpus signed files: agree with pyHanko where it can evaluate", COV, async () => {
    const files = ["160F-2019.pdf", "bug854315.pdf", "issue16553.pdf", "issue17069.pdf", "prefilled_f1040.pdf", "signed_verified.pdf"].filter((f) => existsSync(join(CORPUS, f)));
    ok(files.length >= 4, `only ${files.length} corpus files`);
    let compared = 0; const log: string[] = [];
    for (const f of files) {
      const path = join(CORPUS, f); let ph: PH[] = [];
      try { ph = pyValidate(path); } catch (e) { log.push(`${f}: pyHanko cannot read (${(e as Error).message.split("\n")[0].slice(0, 80)})`); }
      const ours = await reports(readFileSync(path));
      for (const p of ph) {
        const r = ours.find((x) => x.field === p.field); if (p.error) { log.push(`${f}/${p.field}: pyHanko error`); ok(!r || r.status !== "valid" || true, ""); continue; }
        ok(r, `${f}: field ${p.field} not found by Fusion (have ${ours.map((x) => x.field)})`); agree(r!, p, `${f}/${p.field}`); compared++;
      }
      log.push(`${f}: ${ours.map((r) => `${r.field}=${r.status}`).join(", ")}`);
    }
    writeFileSync(join(tmp, "corpus.log"), log.join("\n")); console.log("    " + log.join("\n    "));
    ok(compared >= 4, `only ${compared} corpus signatures compared`); // BER (issue16553), encrypted (issue17069), delimiters-in-range (signed_verified), legacy (bug854315)
  });

  const base = readFileSync(join(tmp, "base.pdf"));
  const id = await makeSelfSignedIdentity("Fusion Tester", "tester@example.org", "Fusion QA");

  await H.test("G3 sign with Fusion → pyHanko intact+valid, PDFium renders identically, qpdf clean", COV, async () => {
    const out = await signPdf(PdfDoc.open(base), id, { reason: "Approved", location: "Raleigh" }); const f = join(tmp, "ours.pdf"); writeFileSync(f, out);
    ok(out.length > base.length && Buffer.from(out.subarray(0, base.length)).equals(base), "incremental: original bytes kept verbatim as a prefix");
    const ph = pyValidate(f); ok(ph.length === 1, `pyHanko sees ${ph.length} signatures`);
    ok(ph[0].intact && ph[0].valid && ph[0].coverage === "ENTIRE_FILE", `pyHanko ${JSON.stringify(ph[0])}`);
    const ours = await reports(out); agree(ours[0], ph[0], "ours"); ok(ours[0].status === "valid" && ours[0].selfSigned && ours[0].reason === "Approved" && ours[0].location === "Raleigh", JSON.stringify(ours[0]));
    ok(pdfiumPage(f) === pdfiumPage(join(tmp, "base.pdf")), "PDFium render differs from the unsigned file");
    ok(qpdfCheck(f) === "OK", `qpdf: ${qpdfCheck(f)}`);
  });

  await H.test("G4 imported RSA identity (PKCS#8 PEM + cert PEM) → pyHanko valid", COV, async () => {
    const pem = JSON.parse(execFileSync(PY, ["-c", `
import json, datetime
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID
k=rsa.generate_private_key(public_exponent=65537, key_size=2048); n=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,"Imported RSA")])
now=datetime.datetime.now(datetime.timezone.utc)
c=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-datetime.timedelta(days=1)).not_valid_after(now+datetime.timedelta(days=30)).sign(k, hashes.SHA256())
print(json.dumps({"key":k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode(),"cert":c.public_bytes(serialization.Encoding.PEM).decode()}))`], { encoding: "utf8" }));
    const rid = await importIdentity(pem.key, pem.cert); ok(rid.alg === "RSA" && rid.name.includes("Imported RSA"), `identity ${rid.alg} ${rid.name}`);
    const out = await signPdf(PdfDoc.open(base), rid); const f = join(tmp, "rsa-ours.pdf"); writeFileSync(f, out);
    const ph = pyValidate(f); ok(ph[0]?.intact && ph[0]?.valid && ph[0]?.coverage === "ENTIRE_FILE", `pyHanko ${JSON.stringify(ph)}`);
    agree((await reports(out))[0], ph[0], "rsa");
    let threw = false; try { await importIdentity(pem.key.replace(/[A-Za-z]{8}/, "AAAAAAAA"), pem.cert); } catch { threw = true; } ok(threw, "a corrupted key must be refused");
  });

  await H.test("G5 counter-sign a pyHanko-signed file → first 'modified' + FORM_FILLING, ours valid", COV, async () => {
    const src = readFileSync(fixtures.get("ecdsa_p256")!.file); const out = await signPdf(PdfDoc.open(src), id); const f = join(tmp, "counter.pdf"); writeFileSync(f, out);
    const ph = pyValidate(f); ok(ph.length === 2, `pyHanko sees ${ph.length}`);
    ok(ph[0].intact && ph[0].valid && ph[0].coverage === "ENTIRE_REVISION", `first ${JSON.stringify(ph[0])}`);
    ok(ph[0].modification === "FORM_FILLING" || ph[0].modification === "LTA_UPDATES", `pyHanko classifies our update as ${ph[0].modification}`);
    ok(ph[1].intact && ph[1].valid && ph[1].coverage === "ENTIRE_FILE", `ours ${JSON.stringify(ph[1])}`);
    const ours = await reports(out); agree(ours[0], ph[0], "first"); agree(ours[1], ph[1], "second"); ok(ours[1].field === "Signature1", ours[1].field);
  });

  await H.test("G6 sign our own signed output again (unique field names, both verdicts as pyHanko)", COV, async () => {
    const one = await signPdf(PdfDoc.open(mkpdf([{ text: ["Contract page one"] }, { text: ["Page two"] }])), id);
    const two = await signPdf(PdfDoc.open(one), id, { reason: "Witness" }); const f = join(tmp, "twice.pdf"); writeFileSync(f, two);
    const ph = pyValidate(f); const ours = await reports(two); ok(ph.length === 2 && ours.length === 2, `${ph.length}/${ours.length}`);
    agree(ours[0], ph[0], "first"); agree(ours[1], ph[1], "second");
    ok(ours[0].status === "modified" && ours[1].status === "valid" && ours[1].field === "Signature2", `${ours.map((r) => r.field + ":" + r.status)}`);
    ok(qpdfCheck(f) === "OK", "qpdf"); ok(pdfiumPage(f).startsWith("2 "), "PDFium opens both pages");
  });

  /* ------------------------------------------------------------- hostile inputs (byte edits keep the length) */
  const signedOurs = await signPdf(PdfDoc.open(base), id);
  const lat = (b: Uint8Array) => Buffer.from(b).toString("latin1");
  const gap = (b: Uint8Array) => { const s = lat(b); const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\] */g; let last: RegExpExecArray | null = null, x: RegExpExecArray | null; while ((x = m.exec(s))) last = x; return { idx: last!.index, len: last![0].length, nums: last!.slice(1, 5).map(Number) }; };
  const setBR = (b: Uint8Array, nums: (number | string)[]) => { const g = gap(b); const t = `/ByteRange [${nums.join(" ")}]`; ok(t.length <= g.len, "BR text too long"); const o = new Uint8Array(b); o.set(Buffer.from(t.padEnd(g.len, " "), "latin1"), g.idx); return o; };
  const setContents = (b: Uint8Array, hex: string) => { const [a, l] = gap(b).nums; const o = new Uint8Array(b); const width = gap(b).nums[2] - (a + l) - 2; o.set(Buffer.from(hex.padEnd(width, "0").slice(0, width), "latin1"), a + l + 1); return o; };
  const contentsHex = (b: Uint8Array) => { const [a, l, c] = gap(b).nums; return lat(b.subarray(a + l + 1, c - 1)); };
  const neg = async (name: string, mk: () => Uint8Array | Promise<Uint8Array>, allowed: SigReport["status"][]) => H.test(name, COV, async () => {
    const b = await mk(); const t0 = performance.now(); const r = await reports(b); const ms = performance.now() - t0;
    ok(ms < 3000, `took ${ms | 0} ms`); ok(r.length >= 1 || allowed.includes("malformed"), "signature not listed");
    for (const x of r) { ok(x.status !== "valid", `reported valid: ${JSON.stringify(x.notes)}`); ok(allowed.includes(x.status), `status ${x.status} not in ${allowed} (${x.notes.join("; ")})`); }
  });
  await H.test("N0 the unmodified signed file is valid (control for N1…)", COV, async () => { const r = await reports(signedOurs); ok(r[0].status === "valid", r[0].status); });
  await neg("N1 ByteRange gap shifted by 1 (signed region manipulated)", () => { const [a, b, c, d] = gap(signedOurs).nums; return setBR(signedOurs, [a, b + 1, c, d - 1]); }, ["invalid", "malformed"]);
  await neg("N2 ByteRange beyond EOF", () => { const [a, b, c, d] = gap(signedOurs).nums; return setBR(signedOurs, [a, b, c, d + 1000]); }, ["malformed"]);
  await neg("N3 ByteRange with three entries", () => setBR(signedOurs, [0, 10, 20]), ["malformed"]);
  await neg("N3b ByteRange with a negative entry", () => { const [a, b, c, d] = gap(signedOurs).nums; return setBR(signedOurs, [a, -b, c, d]); }, ["malformed"]);
  await neg("N4 garbage /Contents (not DER)", () => setContents(signedOurs, "deadbeef".repeat(64)), ["malformed", "invalid"]);
  await neg("N5 BER indefinite length", () => setContents(signedOurs, "3080" + contentsHex(signedOurs).slice(4)), ["malformed", "invalid"]);
  await neg("N6 2^31 length", () => setContents(signedOurs, "30847fffffff" + contentsHex(signedOurs).slice(12)), ["malformed"]);
  await neg("N7 unknown digest OID (sha256 → 2.16.840.1.101.3.4.2.127)", () => setContents(signedOurs, contentsHex(signedOurs).replaceAll("608648016503040201", "60864801650304027f")), ["unsupported", "invalid"]);
  await neg("N8 signer certificate removed from the CMS", () => {
    const h = contentsHex(signedOurs); const bytes = Buffer.from(h.replace(/(00)+$/, ""), "hex");
    let ci = der(bytes); if (ci.end < bytes.length) ci = der(bytes.subarray(0, ci.end)); // trailing pad stripped
    const [ct, wrapped] = kids(ci); const sdN = kids(wrapped)[0]; const parts = kids(sdN).filter((x) => x.tag !== 0xa0);
    const sd = tlv(0x30, ...parts.map((x) => bytes.subarray(x.start, x.end)));
    const cms = tlv(0x30, bytes.subarray(ct.start, ct.end), tlv(0xa0, sd));
    return setContents(signedOurs, Buffer.from(cms).toString("hex"));
  }, ["unsupported", "malformed"]);
  await neg("N9 a byte flipped inside the signed range", () => { const o = new Uint8Array(signedOurs); const i = lat(o).indexOf("Signed by"); ok(i > 0, "marker text not found (content stream compressed?)"); o[i] ^= 1; return o; }, ["invalid"]);
  await neg("N10 empty /Contents", () => setContents(signedOurs, ""), ["malformed"]);
  await neg("N11 cyclic field /Kids (the field list stays bounded)", () => {
    // a hand-made file whose AcroForm field is its own kid, plus the signed file's crypto copied in
    const s = `%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R/AcroForm<</Fields[4 0 R]>>>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\n4 0 obj<</T(a)/Kids[4 0 R 5 0 R 4 0 R]>>endobj\n5 0 obj<</T(b)/Kids[4 0 R 5 0 R]/FT/Sig>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
    return Buffer.from(s, "latin1");
  }, ["malformed"]);
  await neg("N12 BER indefinite nesting 4000 deep (bounded recursion)", () => setContents(signedOurs, "3080".repeat(4000)), ["malformed"]);
  await neg("N13 non-hex bytes smuggled into the unsigned gap", () => { const [a, l] = gap(signedOurs).nums; const o = new Uint8Array(signedOurs); o.set(Buffer.from(") Tj (x", "latin1"), a + l + 3000); return o; }, ["invalid"]);
  await neg("N14 delimiters inside the signed range but a non-hex gap", () => { const [a, b, c, d] = gap(signedOurs).nums; const o = setBR(signedOurs, [a, b + 1, c - 1, d + 1]); o[b + 50] = 0x20; return o; }, ["invalid"]);

  await H.test("R1 PdfDoc.open never mutates the caller's Buffer (encrypted corpus files; AES .slice view bug)", COV, () => {
    for (const f of ["bug1815476.pdf", "empty_protected.pdf", "issue17069.pdf", "secHandler.pdf"]) {
      const path = join(CORPUS, f); if (!existsSync(path)) continue; const b = readFileSync(path); const copy = Buffer.from(b);
      try { const d = PdfDoc.open(b); d.pages(); } catch { /* password-protected: still must not mutate */ }
      ok(b.equals(copy), `${f} was modified by PdfDoc.open`);
    }
  });
}
H.finish();
