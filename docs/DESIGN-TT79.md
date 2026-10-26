# TT79: ZIP archives to class A (FF-69…72), PDF signatures to class A (FF-73…75), spreadsheet OOXML Strict / ISO dates (FF-76) and Excel coercion semantics (FF-77)

## Runtime honesty

**Used (all in this sandbox):**
- Node 22, tsc, eslint, Next 16.2.6 (production build), Playwright 1.64.1 with Chromium 143, embedded PostgreSQL 17.10.
- Test-only external oracles (never shipped):
  - ZIP: Python `zipfile` / `bz2` / `lzma`, pyzipper (WinZip AES), Info-ZIP `zip` 3.0 and `unzip` 6.0, node:crypto (OpenSSL) and published vectors (FIPS-197, FIPS 180, RFC 6070); a Windows-made Deflate64 archive from dotnet/runtime-assets (MIT).
  - PDF: OpenSSL 3.0.20 CLI and `cryptography` (PFX writers), pyHanko 0.38.0 (signature validity and trust), pypdfium2 5.14.0 / PDFium (rendering), qpdf 10.17 (structure), pycryptodome ARC2 (BSD-2; RC2 with arbitrary effective key bits).
  - Spreadsheet: openpyxl (MIT) on a namespace-mapped copy of each Strict file; Excel's own cached values in the Apache POI corpus (`FormulaEvalTestData_Copy.xlsx`, sheet EverythingTests).

**Not available:** 7-Zip, WinZip, Windows Explorer, Acrobat, Excel, LibreOffice, a timestamp authority, OCSP / CRL responders. Nothing here claims agreement with them.

**Not re-run this tier:** the full 188-suite gate. The suites touched by TT79 and their neighbours were run individually (section H).

## A. Formal model

**ZIP (FF-69…72).** An archive is a central directory D (entries e with name bytes, flags, method, sizes, CRC, offsets, extras) plus local records. `readArchive` is total: every input either yields D, with every guard satisfied, or a named refusal. The guards (directory-time, before any allocation) are: spans must not overlap, local name = central name, ratio ≤ 1100 for entries over 1 MiB, and caps on count, size and per-entry size. `readEntry(e)` returns exactly `e.usize` bytes whose CRC-32 (and the AES MAC, if encrypted) match, or throws. Names: bit 11 → UTF-8; otherwise CP437 unless the host is Unix and the bytes are valid UTF-8. `safePath` is a pure function, and unsafe names never become folders or files.

**PKCS#12 (FF-73).** PFX = authSafe ‖ optional MAC. The MAC is accepted iff HMAC(KDF₃(pw)) = digest, where KDF is RFC 7292 B.2 (diversifier id ∈ {1 key, 2 IV, 3 MAC}) over the BMPString password with its 00 00 terminator. Bags are decrypted with PBES2 (PBKDF2 + AES) or PBE-SHA1 (3DES / RC2 / RC4). Then `identityFromPkcs12` proves the key pairing (sign and verify) and orders the certificates leaf → root. The key is imported non-extractable. Limits: 1 MiB, 256 bags, depth 4, iterations ≤ 10⁷.

**Trust (FF-75).** trusted(sig) ⇔ status ∈ {valid, modified} ∧ ∃ path leaf = c₀ → … → cₙ where each cᵢ₊₁ verifies cᵢ's signature (matched by signature, not by name), each issuer is a CA (basicConstraints cA, keyCertSign if keyUsage is present), every cᵢ is valid at the signing time, the leaf's keyUsage allows digitalSignature or nonRepudiation, and cₙ is (or is issued by) a user anchor. No anchors gives "no-anchors"; never "trusted".

**Visible appearance (FF-74).** For a page with crop box C and rotation r, the box is placed in displayed coordinates (u, v) in corner k and mapped back to user space by the inverse of r. The form XObject carries /Matrix = R(r), so the text reads upright.

**ISO dates (FF-76).** serial(d) = days(d − 1899-12-30) + fraction; 1904 system: −1462; 1900 system with dateCompatibility on and serial < 61: −1 (Lotus' phantom 1900-02-29); negative → stays text; impossible calendar dates → stay text.

**Coercion (FF-77).** `numericText`: the grammar `[sign][$][sign](d{1,3}(,ddd)+ | d*)[.d*][e±d][%]`, or a parenthesised negative, with exponent excluded from `$` and `%` forms. Hex, Infinity, dates and times → null. Engine rules: unary + is the identity (BLANK → 0); `/` converts both operands before the zero test; a blank IF condition is FALSE; CHOOSE propagates an index error; OFFSET's range arguments intersect implicitly (legacy mode); a LARGE / SMALL literal logical counts; SUMPRODUCT over all-1×1 arguments with text gives #VALUE!.

## B. Hypotheses

- **H+** (should hold, tested): every PFX variant OpenSSL and `cryptography` write is read with the same key and chain; signatures we make are valid in pyHanko and trusted exactly when the root is supplied; Strict workbooks read the same as openpyxl; 10 of 14 open EverythingTests cells now match Excel.
- **H−** (must not hold, tested): wrong password or tampered PFX accepted; non-CA, expired, no-signing-usage or impostor-root chains trusted; ink outside the box or on other pages; impossible dates turned into numbers; hex or Infinity text coerced.
- **H∂** (boundary): rotated pages (0 / 90 / 180 / 270°); the empty password (00 00 vs nothing); 1900-02-28 / 03-01 around the phantom day; multi-cell SUMPRODUCT with text (text = 0) vs single-cell (#VALUE!); LARGE over a range containing TRUE (ignored) vs a literal TRUE (1).

## C. Frontier

- **ZIP:** archives over ~2–4 GB (memory); ZIP64 tested only via forced records and 70 000 entries.
- **PDF:** PBMAC1, PBES1 DES, public-key PFX; RFC 3161 timestamps; revocation; free placement of the box.
- **Strict:** writing Strict.
- **Coercion:** locale-specific text, and date / time text in arithmetic.

## D. Negative shapes (≥ 15) and the modal-shortcut test

- **ZIP:** N1–N24 in `tt79-archive` (zip-slip forms, symlinks, overlaps, name mismatch, ratio / count / size, CRC, MAC, multi-volume, …).
- **PFX:** N1–N9 in `tt79-pdf` (random, truncated, 2³¹ iterations, > 1 MiB checked to be refused *by the size guard*, PBMAC1, enveloped authSafe, 257 bags, nesting 6, unknown PBES2 cipher), each refused in under 5 s.
- **Trust:** P7: non-CA intermediate, expired signer, encipher-only signer, and an **impostor root** (same subject name, different key), with the real root as a control.
- **Spreadsheet:** X3 (impossible dates, bare times); X4 (15 non-numbers); X5 negative controls (multi-cell SUMPRODUCT, a LARGE range with TRUE, `"0x10"+0`, text+1).
- **Modal shortcuts:** e2e-tt79-pdf Q1 presses Ctrl+S and Delete behind the password dialog; both are inert. e2e-tt79-archive 1 does the same for the archive password prompt.

## E. Mechanism-distinct approaches (≥ 6)

1. Differential against independent readers (zipfile / unzip, pyHanko, openpyxl).
2. Writer round trips (our writer → their reader; their writer → our reader).
3. Published vectors (FIPS-197, FIPS 180, RFC 6070, RFC 2268, RFC 6229).
4. Rendering oracle (PDFium ink inside or outside the box; IoU on rotated pages).
5. Excel's own cached values (446 579 POI cells).
6. Mutation testing (ZIP 28/28, PDF 17/17, formula 3/3).
7. Real-browser end-to-end runs against the production build.
8. A whole-corpus reader differential (tt67: 338 workbooks; the only change is SimpleStrict.xlsx, ISO text → serial).

## F. Artifacts

- **Code:** `src/lib/archive/*`, `src/components/modules/Archive.tsx`; `src/lib/pdf/{pkcs12,legacyciphers}.ts`, `pdfsig.ts` (trust, visible), `sigstore.ts` v2; `PdfSignatures.tsx`; `src/lib/formula/numtext.ts`, `xlsx.ts` (`isoDateToSerial`), `engine.ts`, `functions.ts`, `ext/officeFunctions.ts`.
- **Tests:** `scripts/tt79-archive.mts`, `e2e-tt79-archive.mts`, `tt79-mutants.py`; `tt79-pdf.mts`, `e2e-tt79-pdf.mts`, `tt79-pdf-mutants.py`, `oracle/p12_oracle.py`; `tt79-sheet.mts` (X1–X5).
- **Screens:** `docs/screens/tt79-pdf-visible-sig.png`, `tt79-pdf-trusted.png`.

## G. Second-order adversary

**PDF mutants (`scripts/tt79-pdf-mutants.py`): 17 plausible wrong implementations, all killed.** The first pass left 3 survivors, each a gap in the tests:

| Survivor | Gap | Fix |
|---|---|---|
| Size cap removed | The oversized fixture also failed parsing, so it was refused for the wrong reason. | N4 now asserts the size-guard message. |
| RC2 effective-bits mask skipped | RFC 2268's only odd-bit vector (all-zero key, 63 bits) never touches the mask. | 5 vectors at 41 / 57 / 63 / 100 / 127 bits from pycryptodome ARC2, which reproduces RFC vector 1. |
| Issuer accepted by name alone | No impostor certificate in the tests. | An impostor root (same DN, different key); pyHanko and Fusion both say untrusted, while the real root is still trusted. |

The iteration-cap mutant is counted as killed because the suite hangs; that hang is the denial of service the cap prevents.

**ZIP mutants:** 28/28 (`scripts/tt79-mutants.py`). The 28th, Deflate64 length code 285, needed a hand-built Deflate64 stream (C3).

**Formula mutants:** reverting the LARGE literal rule, the SUMPRODUCT single-cell rule or the unary-+ identity each fails X5.

## H. External verification (runs this tier)

| Suite | Result |
|---|---|
| tt79-archive / e2e-tt79-archive | 16/16, 7/7 |
| tt79-pdf / e2e-tt79-pdf | 17/17, 5/5 (build 80) |
| tt79-sheet | 5/5 |
| tt77-pdfsig / e2e-tt77-pdfsig | 23/23, 7/7 |
| tt74-office | 32/32 (X1 446 579 cells; agree 446 498; allowlisted 77; EverythingTests open **4**, cap lowered to 4) |
| office-engine, oracle-parity, oracle-xlsx, unit | 35/35, 5/5, 5/5, 23/23 |
| tt46-xlsx-patch, tt47, tt48, tt49, tt56, tt57, tt58, tt69 | all green |
| tt72, tt73, tt75 office, tt76-sheet, tt78-sheet, tables-engine | all green |
| tt67-sheet-ns | 13/13 after registering the SimpleStrict change as explained |
| e2e-tt78-sheet, e2e-tt55-files | 3/3, 13/13 |

## I. Repair, with a new attack on the patch

- **SUMPRODUCT 1×1 rule.** Attack: does it break normal SUMPRODUCT over ranges with text? X5 checks `SUMPRODUCT(C1:C2,D1:D2)` = 15 (text counts as 0) and a numeric 1×1 product = 6.
- **LARGE literal logical.** Attack: does TRUE inside a range now count? `LARGE(D1:F1,1)` = 2 with TRUE in F1.
- **Coercion.** Attack: does it leak into comparisons or sort? `toNumberStrict` callers are arithmetic, percent and numeric arguments only (grep-audited); the tt56–tt58 paste / link / pivot suites stay green.
- **Trust.** Attack: an impostor anchor (section G).
- **The size guard.** Attack: refused for the wrong reason (section G).

## J. Stopping

Stopped with:
- every class-A claim for ZIP, PDF signatures and the Strict / coercion work backed by an external oracle plus a mutant that the suite kills;
- 4 EverythingTests cells still open and disclosed: G716, D872, E872 (approximate LOOKUP / HLOOKUP over mixed types; Excel's rule is not documented and the POI corpus alone does not pin it down), and M936 (MODE with a blank direct reference).

**Declared limits:**
- **ZIP:** no multi-volume, PKWARE strong encryption, Zstd, XZ or PPMd; passwords UTF-8.
- **PDF:**
  - P-256 and RSA keys only; no TSA, OCSP or CRL; simplified path validation; a leaf anchor counts as trusted;
  - fixed 220 × 70 pt box in four corners;
  - the e2e canvas check assumes a MediaBox at the origin.
- **Strict:** read only; main part path fixed to `xl/workbook.xml`; zone designator dropped; external-link caches with `t="d"` not converted.
- **Coercion:** en-US only; date and time text not coerced in arithmetic.
