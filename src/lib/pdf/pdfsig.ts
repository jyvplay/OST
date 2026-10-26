/**
 * TT77 — PDF digital signatures: validation and signing. Original code for Fusion.
 *
 * VALIDATION (ISO 32000-2 §12.8): for each signature field (/FT /Sig with a /V signature dictionary):
 *   1. ByteRange sanity: two ranges, the gap is exactly the /Contents hex string, ranges inside the file; whether the
 *      signed revision covers the whole file or later incremental updates were appended (reported, not hidden);
 *   2. digest of the signed byte ranges vs the CMS messageDigest attribute (adbe.pkcs7.detached / ETSI.CAdES.detached),
 *      vs the encapsulated digest (adbe.pkcs7.sha1), or directly signed (adbe.x509.rsa_sha1);
 *   3. the CMS signer's signature over the DER of the signed attributes (re-tagged as SET, RFC 5652 §5.4), checked with
 *      WebCrypto: RSASSA-PKCS1-v1_5, RSA-PSS, ECDSA (P-256/384/521, DER→raw conversion), Ed25519;
 *   4. the embedded certificate chain: each certificate's signature checked against its issuer in the bag.
 *   TRUST: Fusion ships no trust store (privacy / lightweight constraint), so identity is reported as "not verified"
 *   with the chain's root named — never as trusted. Revocation (OCSP/CRL) and timestamps are not checked (disclosed).
 *
 * SIGNING: an incremental update adds an invisible signature field and a /Sig dictionary (adbe.pkcs7.detached) whose
 * /ByteRange and /Contents are written over fixed-width sentinels after layout, so no offset moves; the CMS
 * SignedData (SHA-256, signed attributes contentType / signingTime / messageDigest / signingCertificateV2) is built
 * here with a DER writer. Identities: a self-signed ECDSA P-256 certificate generated on the device (the private key
 * never leaves the browser), or an imported PKCS#8 key + X.509 certificate (PEM/DER).
 *
 * Verified against pyHanko (MIT, test-only oracle): its signatures validate here and ours validate there
 * (scripts/tt77-pdfsig.mts).
 */
import type { PdfDoc } from "./pdfdoc";
import { N, PDict, PName, PRef, PStr, PStream, isArr, isDict, isRef, isStream, textString, type PObj, type Bytes } from "./pdfobj";
import { helvWidth, pdfLiteral, winAnsiBytes } from "./pdftextfit";
/** a PDF text string: PDFDocEncoding-safe ASCII as bytes, anything else UTF-16BE with BOM (§7.9.2.2) */
const txt = (s: string) => { if (/^[\x20-\x7e]*$/.test(s)) return new PStr(new TextEncoder().encode(s)); const b = [0xfe, 0xff]; for (const ch of s) { const c = ch.codePointAt(0)!; if (c > 0xffff) { const v = c - 0x10000; b.push(0xd8 | (v >> 18), (v >> 10) & 255, 0xdc | ((v >> 8) & 3), v & 255); } else b.push(c >> 8, c & 255); } return new PStr(Uint8Array.from(b)); };
import { PdfEditor } from "./pdfedit";

/* ------------------------------------------------------------------ DER reading */
/** a TLV. `cend` is the end of the contents (= end, except for BER indefinite lengths where `end` also skips the
 *  00 00 end-of-contents marker). Real-world PDF signatures are often BER (Windows CryptoAPI, some smart-card
 *  middleware emit indefinite lengths), so the reader accepts them — bounded by nesting depth and the data limit. */
export interface Der { tag: number; cons: boolean; start: number; hlen: number; len: number; cend: number; end: number; d: Bytes }
export function der(d: Bytes, p = 0, lim = d.length, depth = 0): Der {
  if (depth > 48) throw new Error("DER: nesting too deep");
  if (p + 2 > lim) throw new Error("DER: truncated");
  const tag = d[p]; if ((tag & 0x1f) === 0x1f) throw new Error("DER: high tag numbers unsupported");
  let len = d[p + 1], hlen = 2;
  if (len === 0x80) {
    // BER indefinite length: constructed only; children until 00 00
    if (!(tag & 0x20)) throw new Error("BER: indefinite length on a primitive");
    let q = p + 2;
    for (let g = 0; ; g++) {
      if (g > 100000) throw new Error("BER: too many elements");
      if (q + 2 > lim) throw new Error("BER: missing end-of-contents");
      if (d[q] === 0 && d[q + 1] === 0) break;
      q = der(d, q, lim, depth + 1).end;
    }
    return { tag, cons: true, start: p, hlen: 2, len: q - (p + 2), cend: q, end: q + 2, d };
  }
  if (len & 0x80) {
    const n = len & 0x7f; if (n > 4) throw new Error("DER: bad length");
    if (p + 2 + n > lim) throw new Error("DER: truncated");
    len = 0; for (let i = 0; i < n; i++) len = len * 256 + d[p + 2 + i]; hlen = 2 + n;
  }
  const end = p + hlen + len; if (end > lim) throw new Error("DER: length beyond data");
  return { tag, cons: !!(tag & 0x20), start: p, hlen, len, cend: end, end, d };
}
export function kids(n: Der, depth = 0): Der[] { const out: Der[] = []; let p = n.start + n.hlen; for (let g = 0; p < n.cend && g < 100000; g++) { const k = der(n.d, p, n.cend, depth); out.push(k); p = k.end; } return out; }
/** contents; a constructed (BER-chunked) OCTET/BIT STRING is flattened */
const body = (n: Der): Bytes => {
  if (n.cons && (n.tag === 0x24 || n.tag === 0x23)) { const parts = kids(n).map(body); const o = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let k = 0; for (const x of parts) { o.set(x, k); k += x.length; } return o; }
  return n.d.subarray(n.start + n.hlen, n.cend);
};
const whole = (n: Der) => n.d.subarray(n.start, n.end);
export function oid(n: Der): string {
  const b = body(n); if (!b.length) return "";
  const parts = [Math.floor(b[0] / 40) > 2 ? 2 : Math.floor(b[0] / 40), b[0] >= 80 ? b[0] - 80 : b[0] % 40]; let v = 0;
  for (let i = 1; i < b.length; i++) { v = v * 128 + (b[i] & 0x7f); if (!(b[i] & 0x80)) { parts.push(v); v = 0; } }
  return parts.join(".");
}
const eq = (a: Bytes, b: Bytes) => a.length === b.length && a.every((v, i) => v === b[i]);

/* ------------------------------------------------------------------ DER writing */
const lenBytes = (n: number) => (n < 128 ? [n] : n < 256 ? [0x81, n] : n < 65536 ? [0x82, n >> 8, n & 255] : [0x83, n >> 16, (n >> 8) & 255, n & 255]);
export function tlv(tag: number, ...parts: (Bytes | number[])[]): Uint8Array {
  let n = 0; for (const p of parts) n += p.length; const h = [tag, ...lenBytes(n)]; const o = new Uint8Array(h.length + n); o.set(h); let k = h.length;
  for (const p of parts) { o.set(p, k); k += p.length; } return o;
}
const SEQ = (...p: Bytes[]) => tlv(0x30, ...p), SET = (...p: Bytes[]) => tlv(0x31, ...p);
function OID(s: string) { const a = s.split(".").map(Number); const out = [a[0] * 40 + a[1]]; for (const v of a.slice(2)) { const t: number[] = []; let x = v; do { t.unshift(x & 0x7f); x = Math.floor(x / 128); } while (x); for (let i = 0; i < t.length - 1; i++) t[i] |= 0x80; out.push(...t); } return tlv(6, out); }
function INT(b: Bytes | number) { let v: number[] = typeof b === "number" ? (b < 128 ? [b] : [b >> 8, b & 255]) : Array.from(b); while (v.length > 1 && v[0] === 0 && !(v[1] & 0x80)) v = v.slice(1); if (v[0] & 0x80) v = [0, ...v]; return tlv(2, v); }
const OCTET = (b: Bytes) => tlv(4, b), NULL = () => new Uint8Array([5, 0]), UTF8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
function TIME(d: Date) { const p = (n: number, w = 2) => String(n).padStart(w, "0"); const y = d.getUTCFullYear(); const s = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`; return y < 2050 ? tlv(0x17, Array.from(new TextEncoder().encode(p(y % 100) + s))) : tlv(0x18, Array.from(new TextEncoder().encode(p(y, 4) + s))); }
const CTX = (n: number, cons: boolean, ...p: Bytes[]) => tlv((cons ? 0xa0 : 0x80) | n, ...p);

/* ------------------------------------------------------------------ algorithms */
const O = {
  data: "1.2.840.113549.1.7.1", signedData: "1.2.840.113549.1.7.2", contentType: "1.2.840.113549.1.9.3", messageDigest: "1.2.840.113549.1.9.4", signingTime: "1.2.840.113549.1.9.5", signingCertV2: "1.2.840.113549.1.9.16.2.47",
  sha1: "1.3.14.3.2.26", sha256: "2.16.840.1.101.3.4.2.1", sha384: "2.16.840.1.101.3.4.2.2", sha512: "2.16.840.1.101.3.4.2.3",
  rsa: "1.2.840.113549.1.1.1", rsaSha1: "1.2.840.113549.1.1.5", rsaSha256: "1.2.840.113549.1.1.11", rsaSha384: "1.2.840.113549.1.1.12", rsaSha512: "1.2.840.113549.1.1.13", pss: "1.2.840.113549.1.1.10",
  ecPub: "1.2.840.10045.2.1", ecSha1: "1.2.840.10045.4.1", ecSha256: "1.2.840.10045.4.3.2", ecSha384: "1.2.840.10045.4.3.3", ecSha512: "1.2.840.10045.4.3.4",
  p256: "1.2.840.10045.3.1.7", p384: "1.3.132.0.34", p521: "1.3.132.0.35", ed25519: "1.3.101.112",
  cn: "2.5.4.3", o: "2.5.4.10", email: "1.2.840.113549.1.9.1", keyUsage: "2.5.29.15", basic: "2.5.29.19",
};
const HASH: Record<string, string> = { [O.sha1]: "SHA-1", [O.sha256]: "SHA-256", [O.sha384]: "SHA-384", [O.sha512]: "SHA-512" };
const subtle = () => { const s = globalThis.crypto?.subtle; if (!s) throw new Error("WebCrypto unavailable"); return s; };
const ab = (b: Bytes) => b.slice().buffer as ArrayBuffer;

/* ------------------------------------------------------------------ X.509 */
export interface Cert { der: Bytes; tbs: Bytes; serial: Bytes; issuer: Bytes; subject: Bytes; subjectName: string; issuerName: string; notBefore: Date | null; notAfter: Date | null; spki: Bytes; sigAlg: Der; sig: Bytes; keyAlg: string; curve: string | null }
function nameText(n: Der): string {
  const out: string[] = [];
  for (const rdn of kids(n)) for (const atv of kids(rdn)) {
    const [t, v] = kids(atv); const k = oid(t); const label = k === O.cn ? "CN" : k === O.o ? "O" : k === "2.5.4.6" ? "C" : k === "2.5.4.11" ? "OU" : k === O.email ? "E" : k === "2.5.4.7" ? "L" : null;
    if (!label || !v) continue; const b = body(v); const s = v.tag === 0x1e ? String.fromCharCode(...Array.from({ length: b.length / 2 }, (_, i) => (b[2 * i] << 8) | b[2 * i + 1])) : new TextDecoder().decode(b);
    out.push(`${label}=${s}`);
  }
  return out.join(", ");
}
function timeOf(n: Der): Date | null {
  // UTCTime (0x17) has a 2-digit year (RFC 5280: 50–99 → 19xx), GeneralizedTime (0x18) a 4-digit one
  const s = new TextDecoder().decode(body(n)); const yl = n.tag === 0x17 ? 2 : 4;
  const m = (yl === 2 ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?(Z|[+-]\d{4})?$/ : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?(Z|[+-]\d{4})?$/).exec(s); if (!m) return null;
  let y = Number(m[1]); if (yl === 2) y += y < 50 ? 2000 : 1900;
  let t = Date.UTC(y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (m[7] && m[7] !== "Z") t -= (m[7][0] === "-" ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3))) * 60000;
  return Number.isFinite(t) ? new Date(t) : null;
}
/** a PDF date (§7.9.4) "D:YYYYMMDDHHmmSSOHH'mm" → Date, or null */
export function pdfDateOf(s: string): Date | null {
  const m = /^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-])?(\d{2})?'?(\d{2})?/.exec(s.trim()); if (!m) return null;
  let t = Date.UTC(Number(m[1]), Number(m[2] ?? 1) - 1, Number(m[3] ?? 1), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0));
  if (m[7] === "+" || m[7] === "-") t -= (m[7] === "-" ? -1 : 1) * (Number(m[8] ?? 0) * 60 + Number(m[9] ?? 0)) * 60000;
  return Number.isFinite(t) ? new Date(t) : null;
}
export function parseCert(b: Bytes): Cert {
  const c = der(b); const [tbsN, alg, sig] = kids(c); const t = kids(tbsN); let i = 0; if (t[0].tag === 0xa0) i++;
  const serial = body(t[i]), issuer = t[i + 2], validity = kids(t[i + 3]), subject = t[i + 4], spki = t[i + 5];
  const ka = kids(kids(spki)[0]); const keyAlg = oid(ka[0]); const curve = ka[1]?.tag === 6 ? oid(ka[1]) : null;
  return { der: whole(c), tbs: whole(tbsN), serial, issuer: whole(issuer), subject: whole(subject), subjectName: nameText(subject), issuerName: nameText(issuer), notBefore: validity[0] ? timeOf(validity[0]) : null, notAfter: validity[1] ? timeOf(validity[1]) : null, spki: whole(spki), sigAlg: alg, sig: body(sig).subarray(1), keyAlg, curve };
}

/** verify `sig` over `data` with the certificate's key; `alg` is the AlgorithmIdentifier, `digestOid` the hash for plain rsaEncryption */
async function verifyWith(cert: Cert, alg: Der, digestOid: string | null, sig: Bytes, data: Bytes): Promise<boolean | "unsupported"> {
  const a = kids(alg); const o = oid(a[0]); const s = subtle();
  const rsaHash = ({ [O.rsaSha1]: "SHA-1", [O.rsaSha256]: "SHA-256", [O.rsaSha384]: "SHA-384", [O.rsaSha512]: "SHA-512" } as Record<string, string>)[o] ?? (o === O.rsa && digestOid ? HASH[digestOid] : undefined);
  if (rsaHash) { const k = await s.importKey("spki", ab(cert.spki), { name: "RSASSA-PKCS1-v1_5", hash: rsaHash }, false, ["verify"]); return s.verify("RSASSA-PKCS1-v1_5", k, ab(sig), ab(data)); }
  if (o === O.pss) {
    // RSASSA-PSS-params: [0] hashAlgorithm, [1] maskGenAlgorithm, [2] saltLength (defaults SHA-1 / 20)
    let hash = "SHA-1", salt = 20;
    if (a[1]) for (const p of kids(a[1])) { if (p.tag === 0xa0) hash = HASH[oid(kids(kids(p)[0])[0])] ?? hash; if (p.tag === 0xa2) { const v = body(kids(p)[0]); salt = v.reduce((x, y) => x * 256 + y, 0); } }
    const k = await s.importKey("spki", ab(cert.spki), { name: "RSA-PSS", hash }, false, ["verify"]); return s.verify({ name: "RSA-PSS", saltLength: salt }, k, ab(sig), ab(data));
  }
  const ecHash = ({ [O.ecSha1]: "SHA-1", [O.ecSha256]: "SHA-256", [O.ecSha384]: "SHA-384", [O.ecSha512]: "SHA-512" } as Record<string, string>)[o] ?? (o === O.ecPub && digestOid ? HASH[digestOid] : undefined);
  if (ecHash) {
    const curve = cert.curve === O.p256 ? "P-256" : cert.curve === O.p384 ? "P-384" : cert.curve === O.p521 ? "P-521" : null; if (!curve) return "unsupported";
    const size = curve === "P-256" ? 32 : curve === "P-384" ? 48 : 66;
    // CMS carries ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER }; WebCrypto wants r ‖ s, each left-padded to the curve size
    const [r, sv] = kids(der(sig)); const raw = new Uint8Array(2 * size);
    const put = (x: Bytes, at: number) => { let v = x; while (v.length > size && v[0] === 0) v = v.subarray(1); if (v.length > size) throw new Error("ECDSA: integer too long"); raw.set(v, at + size - v.length); };
    put(body(r), 0); put(body(sv), size);
    const k = await s.importKey("spki", ab(cert.spki), { name: "ECDSA", namedCurve: curve }, false, ["verify"]); return s.verify({ name: "ECDSA", hash: ecHash }, k, ab(raw), ab(data));
  }
  if (o === O.ed25519) { const k = await s.importKey("spki", ab(cert.spki), { name: "Ed25519" }, false, ["verify"]); return s.verify("Ed25519", k, ab(sig), ab(data)); }
  return "unsupported";
}

/* ------------------------------------------------------------------ validation */
export interface SigReport {
  field: string; subFilter: string; signer: string; issuer: string; signingTime: string | null; reason: string; location: string;
  /** the signed byte ranges hash to the value the signature commits to */
  digestOk: boolean | null;
  /** the signature verifies with the signer certificate's public key */
  signatureOk: boolean | "unsupported" | null;
  /** the signed revision covers the whole file (false: incremental updates were appended after signing) */
  coversWholeFile: boolean; appendedBytes: number;
  /** bytes of the signed revision (ByteRange c + d): file.subarray(0, signedLength) is exactly what was signed */
  signedLength: number;
  /** chain inside the signature: certificates whose signatures verified against an issuer in the bag; root named */
  chain: { subject: string; verifiedByIssuer: boolean | null; der: Bytes }[]; selfSigned: boolean;
  /** trust against the user's own anchors (Fusion ships no trust store): "trusted" = valid signature, every link of a
   *  path from the signer to one of `anchors` verified, issuers are CAs, all certificates valid at the signing time,
   *  and the signer's key usage allows signing; "untrusted" = anchors given but no such path; "no-anchors" = none set */
  trust: "trusted" | "untrusted" | "no-anchors"; trustNote: string;
  /** "valid" only when digest + signature hold; trust is reported separately (see `trust`) */
  status: "valid" | "modified" | "invalid" | "unsupported" | "malformed";
  certValidAtSigning: boolean | null; notes: string[];
}
const hexToBytes = (s: string) => { const h = s.replace(/[^0-9a-fA-F]/g, ""); const o = new Uint8Array(h.length >> 1); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(2 * i, 2), 16); return o; };

/** every signature field with a value, in field order */
export function signatureFields(doc: PdfDoc): { name: string; v: PDict; widget: PDict }[] {
  const root = doc.dict(doc.trailer.get("Root")); const af = root ? doc.dict(root.get("AcroForm")) : null; const out: { name: string; v: PDict; widget: PDict }[] = [];
  const seen = new Set<string>(); let visits = 0;
  const walk = (o: PObj | undefined, prefix: string, ft: string | null, depth: number) => {
    // refs are not interned: key the cycle guard on "num gen"; cap total visits so hostile fan-out stays linear
    if (depth > 32 || ++visits > 20000) return; if (o instanceof PRef) { const k = o.num + " " + o.gen; if (seen.has(k)) return; seen.add(k); }
    const d = doc.dict(o); if (!d) return; const t = doc.resolve(d.get("T")); const name = t instanceof PStr ? (prefix ? prefix + "." : "") + textString(t) : prefix;
    const f = doc.resolve(d.get("FT")); const type = f instanceof PName ? f.n : ft;
    const k = doc.resolve(d.get("Kids")); if (isArr(k) && k.some((x) => isDict(doc.resolve(x)) && doc.resolve((doc.resolve(x) as PDict).get("T")) !== undefined)) { for (const x of k) walk(x, name, type, depth + 1); return; }
    if (type === "Sig") { const v = doc.dict(d.get("V")); if (v) out.push({ name, v, widget: d }); }
  };
  const fields = af ? doc.resolve(af.get("Fields")) : undefined; if (isArr(fields)) for (const f of fields) walk(f, "", null, 0);
  return out;
}

export async function validateSignatures(doc: PdfDoc, opts: { anchors?: Bytes[] } = {}): Promise<SigReport[]> {
  const out: SigReport[] = []; const anchors: Cert[] = [];
  for (const a of opts.anchors ?? []) { try { anchors.push(parseCert(a)); } catch { /* an unreadable anchor is ignored */ } }
  for (const f of signatureFields(doc)) out.push(await validateOne(doc, f.name, f.v, anchors));
  return out;
}

async function validateOne(doc: PdfDoc, field: string, v: PDict, anchors: Cert[] = []): Promise<SigReport> {
  const file = doc.bytes; const notes: string[] = [];
  const str = (k: string) => { const x = doc.resolve(v.get(k)); return x instanceof PStr ? textString(x) : ""; };
  const sf = doc.resolve(v.get("SubFilter")); const subFilter = sf instanceof PName ? sf.n : "";
  const rep: SigReport = { field, subFilter, signer: str("Name"), issuer: "", signingTime: str("M") || null, reason: str("Reason"), location: str("Location"), digestOk: null, signatureOk: null, coversWholeFile: false, appendedBytes: 0, signedLength: 0, chain: [], selfSigned: false, trust: "no-anchors", trustNote: "", status: "malformed", certValidAtSigning: null, notes };
  try {
    const br = doc.arr(v.get("ByteRange")).map((x) => doc.num(x));
    if (br.length !== 4 || br.some((x) => !Number.isInteger(x) || x < 0)) { notes.push("ByteRange is not four non-negative integers"); return rep; }
    const [a, b, c, d] = br;
    if (a !== 0) notes.push("ByteRange does not start at 0");
    if (a + b > c || c + d > file.length) { notes.push("ByteRange outside the file or overlapping"); return rep; }
    // the gap must be exactly the hex string of /Contents: '<' at a+b and '>' at c-1
    // §12.8.1: the gap is the /Contents hex string. Standard: '<' at a+b and '>' at c-1. Some producers (and pyHanko's
    // reader) also accept the delimiters inside the signed ranges. Either way the unsigned gap must hold ONLY hex
    // digits — anything else could be unsigned content smuggled into the file.
    let g0: number, g1: number;
    if (file[a + b] === 0x3c && file[c - 1] === 0x3e) { g0 = a + b + 1; g1 = c - 1; }
    else if (a + b > 0 && file[a + b - 1] === 0x3c && file[c] === 0x3e) { g0 = a + b; g1 = c; notes.push("the /Contents delimiters lie inside the signed ranges (non-standard, accepted)"); }
    else { notes.push("the ByteRange gap is not the /Contents string — the signed region was manipulated"); rep.status = "invalid"; return rep; }
    for (let i = g0; i < g1; i++) { const ch = file[i]; if (!((ch >= 0x30 && ch <= 0x39) || ((ch | 0x20) >= 0x61 && (ch | 0x20) <= 0x66))) { notes.push("the unsigned gap holds non-hex bytes"); rep.status = "invalid"; return rep; } }
    const contents = hexToBytes(new TextDecoder("latin1").decode(file.subarray(g0, g1)));
    rep.signedLength = c + d; rep.appendedBytes = file.length - (c + d); rep.coversWholeFile = rep.appendedBytes <= 2; // a trailing EOL is tolerated
    const signed = new Uint8Array(b + d); signed.set(file.subarray(a, a + b)); signed.set(file.subarray(c, c + d), b);

    if (subFilter === "adbe.x509.rsa_sha1") {
      // legacy: /Contents is a DER OCTET STRING holding a PKCS#1 signature over SHA-1 of the ranges; certificates in /Cert
      const co = doc.resolve(v.get("Cert")); const certs = (isArr(co) ? co : [co]).map((x) => doc.resolve(x)).filter((x): x is PStr => x instanceof PStr).map((x) => parseCert(x.b));
      if (!certs.length) { notes.push("no /Cert"); return rep; }
      let sig: Bytes = contents; try { const n = der(contents); if (n.tag === 4) sig = body(n); } catch { /* raw */ }
      const k = await subtle().importKey("spki", ab(certs[0].spki), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" }, false, ["verify"]);
      rep.signatureOk = await subtle().verify("RSASSA-PKCS1-v1_5", k, ab(sig.subarray(0, sigLen(sig))), ab(signed)); rep.digestOk = rep.signatureOk;
      rep.signer = rep.signer || certs[0].subjectName; rep.issuer = certs[0].issuerName; await chainOf(certs, rep);
    } else {
      // CMS SignedData (PKCS #7). Trailing zero padding after the DER is normal (the placeholder is larger than needed)
      const ci = der(contents); const [ct, wrapped] = kids(ci); if (oid(ct) !== O.signedData) { notes.push("not CMS SignedData"); return rep; }
      const sd = kids(kids(wrapped)[0]); let i = 2; const encap = kids(sd[i++]);
      let certsN: Der | null = null; while (sd[i] && (sd[i].tag === 0xa0 || sd[i].tag === 0xa1)) { if (sd[i].tag === 0xa0) certsN = sd[i]; i++; }
      const signers = kids(sd[i]); if (!signers.length) { notes.push("no SignerInfo"); return rep; }
      const certs = certsN ? kids(certsN).filter((x) => x.tag === 0x30).map((x) => parseCert(whole(x))) : [];
      const si = kids(signers[0]); let j = 1; const sid = si[j++]; const digAlg = oid(kids(si[j++])[0]);
      let signedAttrs: Der | null = null; if (si[j].tag === 0xa0) signedAttrs = si[j++];
      const sigAlg = si[j++]; const sig = body(si[j++]);
      // the signer certificate: IssuerAndSerialNumber or [0] SubjectKeyIdentifier
      let cert: Cert | undefined;
      if (sid.tag === 0x30) { const [iss, ser] = kids(sid); cert = certs.find((c) => eq(c.issuer, whole(iss)) && eq(stripZero(c.serial), stripZero(body(ser)))); }
      else cert = certs.find((c) => { const ski = subjectKeyId(c); return !!ski && eq(ski, body(sid)); });
      if (!cert) { notes.push("signer certificate not included"); rep.status = "unsupported"; return rep; }
      rep.signer = cert.subjectName || rep.signer; rep.issuer = cert.issuerName;
      const hash = HASH[digAlg]; if (!hash) { notes.push(`digest ${digAlg} unsupported`); rep.status = "unsupported"; return rep; }
      let toSign: Bytes;
      if (signedAttrs) {
        let md: Bytes | null = null;
        for (const at of kids(signedAttrs)) { const [t, vals] = kids(at); const k = oid(t); if (k === O.messageDigest) md = body(kids(vals)[0]); if (k === O.signingTime) { const tm = timeOf(kids(vals)[0]); if (tm) rep.signingTime = tm.toISOString(); } }
        let expect: Bytes;
        if (subFilter === "adbe.pkcs7.sha1") { // the encapsulated content is the SHA-1 of the ranges; messageDigest hashes that content
          const content = encap[1] ? body(kids(encap[1])[0]) : new Uint8Array(0);
          const sha1 = new Uint8Array(await subtle().digest("SHA-1", ab(signed))); if (!eq(sha1, content)) { rep.digestOk = false; }
          expect = new Uint8Array(await subtle().digest(hash, ab(content)));
        } else expect = new Uint8Array(await subtle().digest(hash, ab(signed)));
        rep.digestOk = rep.digestOk === false ? false : !!md && eq(md, expect);
        toSign = new Uint8Array(whole(signedAttrs)); toSign[0] = 0x31; // RFC 5652 §5.4: the signature covers the attributes as a SET
      } else {
        toSign = subFilter === "adbe.pkcs7.sha1" && encap[1] ? body(kids(encap[1])[0]) : signed; rep.digestOk = null;
      }
      rep.signatureOk = await verifyWith(cert, sigAlg, digAlg, sig, toSign);
      if (!signedAttrs) rep.digestOk = rep.signatureOk === true;
      await chainOf([cert, ...certs.filter((c) => c !== cert)], rep);
      const at = rep.signingTime ? (/^D:/.test(rep.signingTime) ? pdfDateOf(rep.signingTime) : new Date(rep.signingTime)) : null;
      if (at && /^D:/.test(rep.signingTime ?? "")) { rep.signingTime = at.toISOString(); notes.push("signing time taken from /M (the signer's clock, unsigned)"); }
      if (at && cert.notBefore && cert.notAfter) rep.certValidAtSigning = at >= cert.notBefore && at <= cert.notAfter;
      if (anchors.length) { const t = await trustPath(cert, certs, anchors, at ?? new Date()); rep.trust = t.ok ? "trusted" : "untrusted"; rep.trustNote = t.note; }
    }
    rep.status = rep.signatureOk === "unsupported" ? "unsupported" : rep.digestOk && rep.signatureOk === true ? (rep.coversWholeFile ? "valid" : "modified") : "invalid";
    if (rep.trust === "trusted" && rep.status !== "valid" && rep.status !== "modified") { rep.trust = "untrusted"; rep.trustNote = "the signature itself does not verify"; }
    if (rep.status === "modified") notes.push(`${rep.appendedBytes} bytes were appended after signing (later revisions are not covered by this signature)`);
  } catch (e) { notes.push(`malformed: ${(e as Error).message}`); rep.status = "malformed"; }
  return rep;
}
const stripZero = (b: Bytes) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };
function sigLen(b: Bytes) { let n = b.length; while (n > 0 && b[n - 1] === 0) n--; return Math.max(n, b.length >= 128 ? 128 * Math.ceil(n / 128) : n); }
function subjectKeyId(c: Cert): Bytes | null {
  try { const t = kids(der(c.tbs)); const ext = t.find((x) => x.tag === 0xa3); if (!ext) return null; for (const e of kids(kids(ext)[0])) { const k = kids(e); if (oid(k[0]) === "2.5.29.14") return body(der(body(k[k.length - 1]))); } } catch { /* none */ }
  return null;
}
/** X.509 extensions of a certificate by OID → the extnValue contents */
function extensions(c: Cert): Map<string, Bytes> {
  const m = new Map<string, Bytes>();
  try { const t = kids(der(c.tbs)); const ext = t.find((x) => x.tag === 0xa3); if (ext) for (const e of kids(kids(ext)[0])) { const k = kids(e); m.set(oid(k[0]), body(k[k.length - 1])); } } catch { /* none */ }
  return m;
}
/** basicConstraints cA (RFC 5280 §4.2.1.9) */
function isCA(c: Cert): boolean { const v = extensions(c).get(O.basic); if (!v) return false; try { const k = kids(der(v)); return !!k[0] && k[0].tag === 1 && body(k[0])[0] !== 0; } catch { return false; } }
/** keyUsage (RFC 5280 §4.2.1.3): bit 0 digitalSignature, bit 1 nonRepudiation, bit 5 keyCertSign; null = extension absent */
function keyUsage(c: Cert): ((bit: number) => boolean) | null {
  const v = extensions(c).get(O.keyUsage); if (!v) return null;
  try { const b = body(der(v)); return (bit: number) => !!(b[1 + (bit >> 3)] & (0x80 >> (bit & 7))); } catch { return () => false; }
}
/** RFC 5280 §6-style path from the signer to a user anchor (simplified: no name constraints / policies / revocation) */
async function trustPath(leaf: Cert, bag: Cert[], anchors: Cert[], at: Date): Promise<{ ok: boolean; note: string }> {
  const inTime = (c: Cert) => !!c.notBefore && !!c.notAfter && at >= c.notBefore && at <= c.notAfter;
  const ku = keyUsage(leaf); if (ku && !ku(0) && !ku(1)) return { ok: false, note: "the signer certificate's key usage does not allow signing" };
  let cur = leaf; const seen = new Set<Cert>();
  for (let depth = 0; depth < 10; depth++) {
    if (!inTime(cur)) return { ok: false, note: `${cur.subjectName || "a certificate"} was not valid at the signing time` };
    if (anchors.some((a) => eq(a.der, cur.der))) return { ok: true, note: `chain ends at your trusted certificate ${cur.subjectName}` };
    seen.add(cur);
    const issuerOk = async (c: Cert) => { if (!eq(c.subject, cur.issuer)) return false; try { return (await verifyWith(c, cur.sigAlg, null, cur.sig, cur.tbs)) === true; } catch { return false; } };
    const caOk = (c: Cert) => { const k = keyUsage(c); return isCA(c) && (!k || k(5)); };
    for (const a of anchors) if (await issuerOk(a)) {
      if (!caOk(a)) return { ok: false, note: `your trusted certificate ${a.subjectName} is not a CA` };
      if (!inTime(a)) return { ok: false, note: `your trusted certificate ${a.subjectName} was not valid at the signing time` };
      return { ok: true, note: `issued under your trusted certificate ${a.subjectName}` };
    }
    let next: Cert | undefined; for (const c of bag) if (!seen.has(c) && c !== cur && (await issuerOk(c))) { next = c; break; }
    if (!next) return { ok: false, note: eq(cur.issuer, cur.subject) ? `the chain ends at ${cur.subjectName}, which is not in your trusted list` : `no issuer for ${cur.subjectName} in the signature or your trusted list` };
    if (!caOk(next)) return { ok: false, note: `${next.subjectName} issued a certificate but is not a CA` };
    cur = next;
  }
  return { ok: false, note: "certificate path too long" };
}
async function chainOf(certs: Cert[], rep: SigReport) {
  const seen = new Set<Cert>(); let cur: Cert | undefined = certs[0];
  for (let g = 0; cur && g < 10 && !seen.has(cur); g++) {
    seen.add(cur); const self = eq(cur.issuer, cur.subject);
    const iss: Cert | undefined = self ? cur : certs.find((c) => eq(c.subject, cur!.issuer));
    let ok: boolean | null = null; if (iss) { try { const r = await verifyWith(iss, cur.sigAlg, null, cur.sig, cur.tbs); ok = r === true; } catch { ok = false; } }
    rep.chain.push({ subject: cur.subjectName, verifiedByIssuer: ok, der: cur.der });
    if (self) { rep.selfSigned = rep.chain.length === 1; break; }
    cur = iss;
  }
}

/* ------------------------------------------------------------------ signing identities */
export interface Identity { name: string; key: CryptoKey; certDer: Uint8Array; alg: "ECDSA-P256" | "RSA"; /** issuer certificates embedded with the signature (leaf excluded) */ chain?: Uint8Array[] }
const ecdsaRawToDer = (raw: Bytes) => { const h = raw.length / 2; return SEQ(INT(raw.subarray(0, h)), INT(raw.subarray(h))); };
/** a self-signed ECDSA P-256 identity made on this device (the private key is non-extractable) */
export async function makeSelfSignedIdentity(name: string, email = "", org = "", years = 3): Promise<Identity> {
  const s = subtle(); const kp = await s.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]) as CryptoKeyPair;
  const spki = new Uint8Array(await s.exportKey("spki", kp.publicKey));
  const rdn = (o: string, v: Bytes) => SET(SEQ(OID(o), v));
  const nm = SEQ(rdn(O.cn, UTF8(name)), ...(org ? [rdn(O.o, UTF8(org))] : []), ...(email ? [rdn(O.email, tlv(0x16, Array.from(new TextEncoder().encode(email))))] : []));
  const serial = crypto.getRandomValues(new Uint8Array(16)); serial[0] &= 0x7f;
  const now = new Date(); const from = new Date(now.getTime() - 86400000), to = new Date(now.getTime() + years * 365 * 86400000);
  const alg = SEQ(OID(O.ecSha256));
  const exts = CTX(3, true, SEQ(SEQ(OID(O.keyUsage), tlv(1, [0xff]), OCTET(tlv(3, [6, 0xc0]))), SEQ(OID(O.basic), OCTET(SEQ()))));
  const tbs = SEQ(CTX(0, true, INT(2)), INT(serial), alg, nm, SEQ(TIME(from), TIME(to)), nm, spki, exts);
  const sig = new Uint8Array(await s.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, ab(tbs)));
  const certDer = SEQ(tbs, alg, tlv(3, [0], ecdsaRawToDer(sig)));
  return { name, key: kp.privateKey, certDer, alg: "ECDSA-P256" };
}
/** an imported identity: PKCS#8 private key (RSA or EC P-256) + its certificate, PEM or DER */
export async function importIdentity(keyPemOrDer: string | Bytes, certPemOrDer: string | Bytes): Promise<Identity> {
  const pem = (x: string | Bytes) => (typeof x === "string" ? Uint8Array.from(atob(x.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (ch) => ch.charCodeAt(0)) : x);
  const k = pem(keyPemOrDer), c = pem(certPemOrDer); const cert = parseCert(c);
  if (cert.keyAlg === O.rsa) return { name: cert.subjectName, key: await subtle().importKey("pkcs8", ab(k), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]), certDer: c, alg: "RSA" };
  if (cert.keyAlg === O.ecPub && cert.curve === O.p256) return { name: cert.subjectName, key: await subtle().importKey("pkcs8", ab(k), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]), certDer: c, alg: "ECDSA-P256" };
  throw new Error("only RSA and ECDSA P-256 keys can be imported");
}

/** CMS SignedData (detached) over `data`, signer = identity */
export async function buildCms(id: Identity, data: Bytes, when = new Date()): Promise<Uint8Array> {
  const s = subtle(); const cert = parseCert(id.certDer);
  const digest = new Uint8Array(await s.digest("SHA-256", ab(data))); const certHash = new Uint8Array(await s.digest("SHA-256", ab(id.certDer)));
  const sha256 = SEQ(OID(O.sha256)); // (parameters absent — RFC 5754)
  const attr = (o: string, v: Bytes) => SEQ(OID(o), SET(v));
  const essCertV2 = SEQ(SEQ(SEQ(OCTET(certHash), SEQ(SEQ(CTX(4, true, cert.issuer)), INT(cert.serial)))));
  // signed attributes are a DER SET OF: sorted by their encodings (X.690 §11.6)
  const attrs = [attr(O.contentType, OID(O.data)), attr(O.signingTime, TIME(when)), attr(O.messageDigest, OCTET(digest)), attr(O.signingCertV2, essCertV2)].sort(cmpBytes);
  const signedSet = SET(...attrs);
  const sigAlg = id.alg === "RSA" ? SEQ(OID(O.rsaSha256), NULL()) : SEQ(OID(O.ecSha256));
  const raw = new Uint8Array(await s.sign(id.alg === "RSA" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" }, id.key, ab(signedSet)));
  const sig = id.alg === "RSA" ? raw : ecdsaRawToDer(raw);
  const signedAttrsImplicit = new Uint8Array(signedSet); signedAttrsImplicit[0] = 0xa0;
  const signerInfo = SEQ(INT(1), SEQ(cert.issuer, INT(cert.serial)), sha256, signedAttrsImplicit, sigAlg, OCTET(sig));
  // CertificateSet is a DER SET OF: members sorted by encoding
  const certSet = [id.certDer, ...(id.chain ?? []).filter((c) => !eq(c, id.certDer))].sort(cmpBytes);
  const sd = SEQ(INT(1), SET(sha256), SEQ(OID(O.data)), CTX(0, true, ...certSet), SET(signerInfo));
  return SEQ(OID(O.signedData), CTX(0, true, sd));
}
function cmpBytes(a: Uint8Array, b: Uint8Array) { for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]; return a.length - b.length; }

/** sign the document: returns the new file (original bytes + one incremental update) */
export interface VisibleSig { /** 0-based page index */ page: number; /** [x0 y0 x1 y1] in the page's default user space */ rect: number[] }
export type SigCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";
/** a w × h box (as SEEN, i.e. after the page's /Rotate) in a corner of the crop box, `margin` pt in; returns the
 *  widget /Rect in default user space (§12.5.5 maps the rotated appearance onto it); w, h, and margin are also in
 *  default user-space units, so /UserUnit scales their physical size when the PDF is rendered. */
export function placeSignature(page: { crop: number[]; rotate: number }, corner: SigCorner, w = 220, h = 70, margin = 36): number[] {
  const [x0, y0, x1, y1] = page.crop; const rot = ((page.rotate % 360) + 360) % 360;
  const dw = rot === 90 || rot === 270 ? y1 - y0 : x1 - x0, dh = rot === 90 || rot === 270 ? x1 - x0 : y1 - y0;
  const bw = Math.min(w, dw - 2 * Math.min(margin, dw / 8)), bh = Math.min(h, dh - 2 * Math.min(margin, dh / 8)); const m = Math.min(margin, dw / 8, dh / 8);
  const u0 = corner.endsWith("right") ? dw - m - bw : m, v0 = corner.startsWith("top") ? dh - m - bh : m;
  // displayed (u, v) → user (x, y) for each /Rotate (the page is shown turned clockwise)
  const map = (u: number, v: number): [number, number] => rot === 90 ? [x1 - v, y0 + u] : rot === 180 ? [x1 - u, y1 - v] : rot === 270 ? [x0 + v, y1 - u] : [x0 + u, y0 + v];
  const [ax, ay] = map(u0, v0), [bx, by] = map(u0 + bw, v0 + bh);
  return [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
}
/** the appearance of a visible signature: a framed box with "Digitally signed by", the name, date, reason, location
 *  (Helvetica, WinAnsi; each line shrinks to fit the width) */
export function signatureAppearance(w: number, h: number, name: string, dateText: string, reason?: string, location?: string): string {
  const small = ["Digitally signed by"], after = [`Date: ${dateText}`, ...(reason ? [`Reason: ${reason}`] : []), ...(location ? [`Location: ${location}`] : [])];
  const units = small.length + after.length + 1.6; const fs = Math.max(3, Math.min(9, (h - 8) / (units * 1.2)));
  const fit = (t: string, size: number) => { const tw = helvWidth(t, size); return tw > w - 12 ? Math.max(2.5, (size * (w - 12)) / tw) : size; };
  // centre the text block vertically
  const total = [...small, ...after].reduce((n, t) => n + fit(t, fs) * 1.2, 0) + fit(name, fs * 1.6) * 1.2;
  let y = h - Math.max(4, (h - total) / 2); const parts: string[] = [`q 0.965 0.973 0.992 rg 0.30 0.40 0.60 RG 0.75 w 0.375 0.375 ${fmt(w - 0.75)} ${fmt(h - 0.75)} re B Q`, "BT"];
  const line = (t: string, size: number, color: string) => { y -= size * 1.2; parts.push(`/Helv ${fmt(size)} Tf ${color} rg 1 0 0 1 6 ${fmt(y + size * 0.22)} Tm (${pdfLiteral(winAnsiBytes(t))}) Tj`); };
  for (const t of small) line(t, fit(t, fs), "0.35 0.38 0.45");
  line(name, fit(name, fs * 1.6), "0.08 0.12 0.28");
  for (const t of after) line(t, fit(t, fs), "0.22 0.25 0.32");
  parts.push("ET"); return parts.join("\n");
}
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

export async function signPdf(doc: PdfDoc, id: Identity, opts: { reason?: string; location?: string; contact?: string; field?: string; when?: Date; reserve?: number; visible?: VisibleSig } = {}): Promise<Uint8Array> {
  const when = opts.when ?? new Date(); const reserve = opts.reserve ?? 8192; // bytes reserved for the CMS
  const ed = new PdfEditor(doc);
  const rootRef = doc.trailer.get("Root"); if (!isRef(rootRef)) throw new Error("pdf: no catalog reference");
  const vis = opts.visible; const page0 = doc.pages()[vis ? vis.page : 0]; if (!page0?.ref) throw new Error(vis ? `pdf: no page ${vis.page + 1}` : "pdf: no first page");
  const CONTENTS = "/" + "F".repeat(2 * reserve + 1); // same width as <hex…>
  const BYTERANGE = "/" + "B".repeat(59); // same width as the padded [a b c d]
  const pd = (n: number) => String(n).padStart(2, "0"); const tz = -when.getTimezoneOffset();
  const pdfDate = `D:${when.getFullYear()}${pd(when.getMonth() + 1)}${pd(when.getDate())}${pd(when.getHours())}${pd(when.getMinutes())}${pd(when.getSeconds())}${tz === 0 ? "Z" : `${tz > 0 ? "+" : "-"}${pd(Math.floor(Math.abs(tz) / 60))}'${pd(Math.abs(tz) % 60)}'`}`;
  const sigDict = new PDict().set("Type", N("Sig")).set("Filter", N("Adobe.PPKLite")).set("SubFilter", N("adbe.pkcs7.detached"))
    .set("ByteRange", new PName(BYTERANGE.slice(1))).set("Contents", new PName(CONTENTS.slice(1))).set("M", txt(pdfDate)).set("Name", txt(id.name));
  if (opts.reason) sigDict.set("Reason", txt(opts.reason)); if (opts.location) sigDict.set("Location", txt(opts.location)); if (opts.contact) sigDict.set("ContactInfo", txt(opts.contact));
  const sigRef = ed.add(sigDict);
  // a unique field name
  const taken = new Set(signatureFields(doc).map((f) => f.name)); let fname = opts.field ?? "Signature1"; for (let k = 2; taken.has(fname); k++) fname = `Signature${k}`;
  const widget = new PDict().set("Type", N("Annot")).set("Subtype", N("Widget")).set("FT", N("Sig")).set("T", txt(fname)).set("V", sigRef).set("Rect", [0, 0, 0, 0]).set("F", 132).set("P", page0.ref);
  if (vis) {
    const [x0, y0, x1, y1] = [Math.min(vis.rect[0], vis.rect[2]), Math.min(vis.rect[1], vis.rect[3]), Math.max(vis.rect[0], vis.rect[2]), Math.max(vis.rect[1], vis.rect[3])];
    if (!(x1 - x0 >= 24 && y1 - y0 >= 12) || ![x0, y0, x1, y1].every(Number.isFinite)) throw new Error("sign: the visible signature box must be at least 24 × 12 pt");
    // a rotated page shows the widget turned: lay the appearance out upright (visual w × h) and counter-rotate it
    const rot = ((page0.rotate % 360) + 360) % 360; const turned = rot === 90 || rot === 270;
    const w = turned ? y1 - y0 : x1 - x0, h = turned ? x1 - x0 : y1 - y0;
    const matrix = rot === 90 ? [0, 1, -1, 0, 0, 0] : rot === 180 ? [-1, 0, 0, -1, 0, 0] : rot === 270 ? [0, -1, 1, 0, 0, 0] : null;
    const off = -when.getTimezoneOffset(); const dateText = `${when.getFullYear()}-${pd(when.getMonth() + 1)}-${pd(when.getDate())} ${pd(when.getHours())}:${pd(when.getMinutes())} ${off >= 0 ? "+" : "-"}${pd(Math.floor(Math.abs(off) / 60))}:${pd(Math.abs(off) % 60)}`;
    const ap = signatureAppearance(w, h, id.name, dateText, opts.reason, opts.location);
    const helv = new PDict().set("Type", N("Font")).set("Subtype", N("Type1")).set("BaseFont", N("Helvetica")).set("Encoding", N("WinAnsiEncoding"));
    const fd = new PDict().set("Type", N("XObject")).set("Subtype", N("Form")).set("BBox", [0, 0, w, h]).set("Resources", new PDict().set("Font", new PDict().set("Helv", helv)));
    if (matrix) fd.set("Matrix", matrix);
    const form = new PStream(fd, new TextEncoder().encode(ap));
    widget.set("Rect", [x0, y0, x1, y1]).set("F", 4).set("AP", new PDict().set("N", ed.add(form)));
  }
  const wref = ed.add(widget);
  // page /Annots (+ widget) and catalog /AcroForm (+ field, SigFlags 3 = signatures exist, append only)
  const pg = ed.dict(page0.ref)!; const pcopy = new PDict(); for (const [k, x] of pg.m) pcopy.set(k, x);
  const annots = ed.get(pg.get("Annots")); pcopy.set("Annots", [...(isArr(annots) ? annots : []), wref]); ed.put(page0.ref.num, pcopy);
  const cat = ed.dict(rootRef)!; const ccopy = new PDict(); for (const [k, x] of cat.m) ccopy.set(k, x);
  const afOld = ed.dict(cat.get("AcroForm")); const af = new PDict(); if (afOld) for (const [k, x] of afOld.m) af.set(k, x);
  const fields = ed.get(af.get("Fields")); af.set("Fields", [...(isArr(fields) ? fields : []), wref]).set("SigFlags", 3);
  if (isRef(cat.get("AcroForm"))) { ed.put((cat.get("AcroForm") as PRef).num, af); } else ccopy.set("AcroForm", af);
  ed.put(rootRef.num, ccopy);
  const out = new Uint8Array(ed.save());
  // locate the sentinels (each occurs once) and fill them in place
  const find = (needle: string) => { const n = new TextEncoder().encode(needle); outer: for (let i = out.length - n.length; i >= 0; i--) { for (let k = 0; k < n.length; k++) if (out[i + k] !== n[k]) continue outer; return i; } return -1; };
  const ci = find(CONTENTS), bi = find(BYTERANGE); if (ci < 0 || bi < 0) throw new Error("sign: placeholder not found");
  const a = 0, b = ci, c = ci + CONTENTS.length, d = out.length - c;
  const brText = `[${a} ${b} ${c} ${d}]`.padEnd(BYTERANGE.length, " "); out.set(new TextEncoder().encode(brText), bi);
  const signed = new Uint8Array(b + d); signed.set(out.subarray(0, b)); signed.set(out.subarray(c), b);
  const cms = await buildCms(id, signed, when); if (cms.length > reserve) throw new Error(`sign: signature (${cms.length} B) exceeds the reserved ${reserve} B`);
  const hex = Array.from(cms, (x) => x.toString(16).padStart(2, "0")).join("").padEnd(2 * reserve, "0");
  out.set(new TextEncoder().encode(`<${hex}>`), ci);
  return out;
}
void isStream;
