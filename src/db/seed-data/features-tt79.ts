import { F, type SpecRow } from "./row";

/**
 * TT79 register additions. "One other core feature into class A": ZIP archives (forge grade B → A). Class A is raised
 * only on oracles independent of the app: Python zipfile / bz2 / lzma, pyzipper (WinZip AES), Info-ZIP zip 3.0 and
 * unzip 6.0, node:crypto (OpenSSL) and published vectors (FIPS-197, FIPS 180, RFC 6070), and a Windows-made Deflate64
 * archive from dotnet/runtime-assets (docs/DESIGN-TT79.md). 7-Zip / WinZip / Windows Explorer are not available here.
 * Also TT79: PDF signatures — PKCS#12, visible appearance, trust anchors (FF-73…75, oracles pyHanko / PDFium / qpdf /
 * OpenSSL); spreadsheet — OOXML Strict + ISO dates (FF-76, openpyxl) and Excel coercion semantics (FF-77, POI cached values).
 */
const A79 = "tt79-archive.mts", AE79 = "e2e-tt79-archive.mts";
const P79 = "tt79-pdf.mts", PE79 = "e2e-tt79-pdf.mts", S79 = "tt79-sheet.mts";
export const tt79Features: SpecRow[] = [
  F("FF-69", "FF", "ZIP engine: ZIP64 (records, locator, extra field), data descriptors, Deflate64, bzip2 and LZMA decoding, CP437 / UTF-8 / Info-ZIP Unicode Path names, Unix modes and timestamps, archive and entry comments, self-extractor offsets; writer with ZIP64 and UTF-8 names",
    "A", "P2", "src/lib/archive/zip.ts (APPNOTE 6.3.x container) + inflate.ts (RFC 1951 + Deflate64) + bunzip.ts (bzip2) + unlzma.ts (LZMA, method 14) — isomorphic, first-party, synchronous decoders with output bounded by the declared size",
    "Not supported: Zstandard / XZ / PPMd methods (listed by name, refused on read), PKWARE strong encryption, split / spanned archives (refused). Unmarked names: CP437 unless the archive was made on Unix / macOS and the bytes are valid UTF-8 (what Info-ZIP unzip does); the user can force either. Files kept in Files are capped at 8 MB each; archives opened from the device are limited by memory.",
    "built", `${A79} C1 (Python zipfile, 4 methods × 8 payloads), C2 (own inflater == zlib, 80 streams), C3 (Deflate64 == unzip), C4 (Info-ZIP bzip2 / ZIP64 / streamed / symlink / UTF-8), C5 (CP437 == Python, 0x7075 == unzip), W1, W2 (ZIP64 forced + 70 000 entries == Python + unzip -t), P1`),
  F("FF-70", "FF", "ZIP encryption: WinZip AES-128/192/256 (AE-1 / AE-2) and traditional PKWARE ZipCrypto, read and write; editing an encrypted archive without the password",
    "A", "P2", "src/lib/archive/zipcrypt.ts (FIPS-197 AES forward cipher for WinZip's little-endian CTR, SHA-1, HMAC, PBKDF2, ZipCrypto keys) + zip.ts framing (0x9901 extra, verifier, 10-byte MAC, check byte)",
    "ZipCrypto is weak by design and labelled as such. File names stay visible in every ZIP encryption scheme (no central-directory encryption). Passwords are UTF-8 encoded (identical for ASCII; legacy tools that used OEM code pages may differ for non-ASCII passwords).",
    "built", `${A79} V1 (FIPS-197 / FIPS 180 / RFC 6070 + 210 OpenSSL cross-checks), E1 (pyzipper AES × 4 methods), E2 (ours → pyzipper), E3 (Info-ZIP -P incl. data descriptor), E4 (ours → unzip -P + Python), X1 (edit without password), N12, N13; ${AE79} 1, 4, 5`),
  F("FF-71", "FF", "Archive app: browse folders inside a ZIP without extracting, preview text / images / hex, open an entry in its app, extract a selection or everything (to Files or a device folder), add files / folders, delete, rename, undo, test, create new and encrypted copies; Files opens .zip here and asks for passwords",
    "A", "P2", "src/components/modules/Archive.tsx + src/lib/archive/tree.ts (derived folders) + FilesPane (Extract here with password retry, Compress with password, Open in Archive) + /api/fs extract / compress on the new engine",
    "Extract to a device folder needs the File System Access API (Chromium); elsewhere one file downloads at a time. 'Open in its app' writes a copy under /Temp/Archive.",
    "built", `${AE79} 1–6 (real browser: navigation, modal-shortcut isolation, password retry, previews, keyboard delete / rename / undo, save checked by pyzipper, extraction, zip-slip, encrypted copies checked by pyzipper and unzip, Files routing, Test); ${A79} T1`),
  F("FF-72", "FF", "Archive safety guards: zip-slip (absolute, drive, '..', backslash), symlinks never extracted, duplicate names, overlapping entries (non-recursive bomb), local / central name mismatch, ratio / size / count limits, decoder output capped at the declared size, CRC-32 and AES MAC on every read, multi-volume refused",
    "A", "P1", "src/lib/archive/zip.ts readArchive / readEntry guards (directory-time, before any allocation) + extractable()",
    "Ratio guard applies to entries over 1 MiB (default 1100:1, the deflate ceiling); highly compressible legitimate files above that are refused and the limit is shown.",
    "built", `${A79} N1–N24; ${AE79} 3 (unsafe badges, only safe entries written), 6 (damaged entry named)`),
  F("FF-73", "FF", "PDF signing identities from PKCS#12 (.p12 / .pfx) files: password-based MAC and bag decryption (PBES2 AES / PBKDF2, PBE-SHA1 3DES / RC2 / RC4), certificate chain kept leaf → root, private key imported non-extractable; wrong passwords asked again",
    "A", "P2", "src/lib/pdf/pkcs12.ts (RFC 7292 container + PKCS#12 KDF, BMPString passwords) + legacyciphers.ts (3DES, RC2 RFC 2268, RC4 — decryption only for legacy PFX files) + sigstore.ts + PdfSignatures.tsx import",
    "Keys: RSA and EC P-256 only. Refused with a reason: PBMAC1, PBES1 DES, public-key-protected PFX. Size limits: 1 MiB, 256 bags, nesting 4, KDF iterations ≤ 10 million (hostile files refused in under 5 s).",
    "built", `${P79} P1 (cipher vectors: OpenSSL 3DES, RFC 2268, RFC 6229), P2–P4 (every OpenSSL / cryptography PFX variant: key, chain, MAC, wrong password, tamper), N1–N9 (hostile PFX); ${PE79} Q1 (real browser import with password retry, modal-shortcut isolation)`),
  F("FF-74", "FF", "Visible PDF signatures: an appearance box (signer, reason, date) drawn on the chosen page and corner, upright on rotated pages, saved as an incremental update",
    "A", "P2", "src/lib/pdf/pdfsig.ts signPdf opts.visible + placeSignature (widget /Rect, /AP /N form XObject, /Matrix for /Rotate)",
    "Fixed 220 × 70 pt box in one of the four page corners (no free placement, images or handwritten ink).",
    "built", `${P79} P5 (pyHanko valid), P6 (PDFium: ink only inside the box, other pages unchanged, qpdf --check clean), P8 (0 / 90 / 180 / 270° pages, IoU ≥ 0.9); ${PE79} Q2 (real browser, page 2, checked by pyHanko and PDFium)`),
  F("FF-75", "FF", "PDF signature trust: user trust anchors (add a root certificate or trust the signer's), chain building to an anchor, CA basic-constraints / key-usage / validity checks; each signature reports trusted / untrusted / unknown with the reason",
    "A", "P2", "src/lib/pdf/pdfsig.ts validateSignatures({ anchors }) + sigstore.ts anchors store (IndexedDB, local only) + PdfSignatures.tsx trust list",
    "Simplified path validation: no name constraints, certificate policies, OCSP or CRL; no RFC 3161 timestamps (validity is checked at the claimed signing time). Anchoring a leaf certificate directly counts as trusted. No operating-system trust store.",
    "built", `${P79} P5 (trusted only with the root, == pyHanko), P7 (non-CA intermediate, expired signer, key usage without signing → untrusted, == pyHanko); ${PE79} Q3 (anchor survives reload, removal), Q4 (unrelated root → untrusted)`),
  F("FF-76", "FF", "OOXML Strict workbooks and ISO 8601 date cells (t=\"d\"): Strict namespaces and relationships read, ISO dates / date-times / times converted to serials in the 1900 and 1904 date systems, including dateCompatibility",
    "A", "P2", "src/lib/formula/xml-ns.ts (Strict → Transitional namespace map) + xlsx.ts isoDateToSerial / readSheet t=\"d\"",
    "Read only: no 'Save as Strict'. dateCompatibility=\"0\" follows ECMA-376 as read (no Excel oracle). The zone designator of a t=\"d\" value is dropped (Excel stores local time); external-link caches with t=\"d\" are not converted. Impossible dates stay text.",
    "built", `${S79} X1 (the three POI Strict workbooks == openpyxl on a namespace-mapped copy, formulas == cached values), X2 (1900 / 1904 == openpyxl), X3 (edges); tt67-sheet-ns whole-corpus differential (only SimpleStrict.xlsx changes, ISO text → serial)`),
  F("FF-77", "FF", "Excel text-to-number coercion and argument semantics: \"$1,234.50\" / \"(5)\" / \"50%\" / exponents in arithmetic and numeric arguments; unary + as identity; text before #DIV/0!; blank IF condition; CHOOSE / OFFSET / ROUND / LARGE / SMALL / single-cell SUMPRODUCT edge cases",
    "A", "P2", "src/lib/formula/numtext.ts (first-party coercion grammar) + engine.ts (unary, '/', IF, CHOOSE, OFFSET legacy intersection) + functions.ts / ext/officeFunctions.ts",
    "en-US only ($ and , ). Date and time text (\"1/2/2020\", \"12:30\") is not coerced in arithmetic. Misplaced group separators (\"12,34\") are refused (not checked against Excel). Still open in POI EverythingTests: G716 / D872 / E872 (approximate lookup over mixed types), M936 (MODE with a blank reference).",
    "built", `tt74-office X1 (446 579 POI cells vs Excel's cached values; EverythingTests open cells 14 → 4, capped at 4); ${S79} X4 (coercion vectors), X5 (the 10 shapes + negative controls; 3 mutants killed)`),
];

const UP: Record<string, { note: string; test: string; tier?: SpecRow["tier"]; status?: SpecRow["status"]; replaceNuance?: boolean }> = {
  "FF-66": {
    replaceNuance: true,
    note: "TT79: trust anchors (FF-75), PKCS#12 identities (FF-73) and visible signatures (FF-74) added. 'Valid' still means the bytes and the CMS signature check and cover the whole file; 'trusted' additionally means a chain to a certificate the user chose to trust. No timestamps, OCSP / CRL or operating-system trust store.",
    test: `${P79}; ${PE79}`,
  },
  "FM-05": {
    tier: "A", status: "built",
    note: "TT79 class A: the Archive app (FF-71) on a new isomorphic engine (FF-69) — ZIP64, Deflate64 / bzip2 / LZMA, CP437 / Unicode names, WinZip AES + ZipCrypto (FF-70), guards (FF-72); Files' Extract here asks for passwords and Compress with password writes AES-256.",
    test: `${A79}; ${AE79}`,
  },
  "FF-12": { note: "TT79: archives gain overlap, name-mismatch, duplicate, symlink and output-cap guards (FF-72).", test: `${A79} N1–N24` },
};

export function patchTT79(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, tier: u.tier ?? f.tier, status: u.status ?? f.status, nuance: u.replaceNuance ? u.note : `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
