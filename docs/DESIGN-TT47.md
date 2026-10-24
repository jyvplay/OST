# TT46 + TT47: Writer and Spreadsheet as lossless OOXML editors

All code is original TypeScript. The test oracles are used only in tests, never shipped: openpyxl, python-docx, lxml, msoffcrypto-tool (MIT), node:crypto/OpenSSL, and the Apache POI test-data corpus (Apache-2.0) with Excel-cached values.

## Lossless model
- **Keep the original package; rewrite only what changed.**
  - Writer: each paragraph keeps its source XML until it is edited (`wordml.ts`, `wordedit.ts`).
  - Spreadsheet: `xlsx-patch.ts` rewrites only edited worksheets and styles, plus `<conditionalFormatting>`. It drops calcChain and sets fullCalcOnLoad.
- **No-edit save returns the original bytes.** Results: docx 113/113, xlsx 321/324. The remaining 3 are corrupt or ambiguous packages, which are refused.

## Spreadsheet (TT47)
- **Colour context** (`xlsxcolor.ts`): theme index order (lt1, dk1, lt2, dk2, accents, hyperlinks), HLS tint, indexed palette and custom `<indexedColors>`. The reader and the patcher share it.
- **Conditional formats** (`sheetmeta.ts`): cellIs (including ≥ and ≤) and 2/3-colour scales (min, percentile, max) are rendered and edited in the CF panel. Other rule types are preserved verbatim.
- **Text cells stay text.** String cells (`s`, `inlineStr`, `str`) go through `textInput()`, which quote-prefixes anything that would re-parse as a number, boolean or formula. This closes a formula-injection path for imported text.
- **TEXT() fixes** (`numfmt.ts`):
  - values are normalised to 15 significant digits before rounding;
  - round half away from zero;
  - a comma before the first placeholder is a literal;
  - a value no section matches is shown in General.

## Password-protected files (TT47)
| Layer | File | Spec |
|---|---|---|
| SHA-1/256/384/512, HMAC, AES-128/192/256 (ECB/CBC) | `src/lib/office/cryptoprims.ts` | FIPS 180-4, RFC 2104, FIPS 197 |
| Compound file reader | `src/lib/office/offcrypto.ts` `readCfb` | MS-CFB |
| Agile and Standard decryption | `src/lib/office/offcrypto.ts` `decryptOffice` | MS-OFFCRYPTO §2.3.4.5–15 |
| Prompt and confirmed copy | `src/lib/office/unlock.ts` | — |

- **Why synchronous pure-TS crypto:** the 100,000-round SHA-512 password spin takes ~0.9 s. Chained async WebCrypto digests took 6.8 s.
- **Decryption happens on the device.**
  - Writer: entirely in the browser.
  - Spreadsheet: the decrypted package goes to the app's own server for parsing, the same path as "Import .xlsx". It is not stored.
  - The password is never sent.
- **Integrity:** Agile files are checked with their HMAC before decryption. A wrong password raises `OfficePasswordError("wrong")`, and the dialog stays open with an inline alert.
- **CFB guards:**
  - DIFAT/FAT counts must match the header, and the FAT must mark its own sectors as FATSECT and the DIFAT's as DIFSECT;
  - cycle detection;
  - bounds on every sector;
  - a 256 MiB package cap and a 64 MiB client cap.
- **No silent plaintext:** Fusion can't re-encrypt, so any save from a decrypted document requires an explicit "Save unencrypted copy" under a *different* name.
  - This includes Download and Export. Autosave is disabled.
  - A cancelled password prompt still marks the document as protected.
  - The server refuses plaintext over an encrypted `.docx/.xlsx/.pptx` (`refuseEncryptedOverwrite`) in fs write/upload and the sheet patch route.
- **Finding:** msoffcrypto-tool 6.0.0's encrypt mode writes a defective container for packages under 4 KiB: the stream is longer than the mini stream it writes, and msoffcrypto can't decrypt it either. Our reader refuses it; this is negative shape 25.

## Not implemented (disclosed)
- **Encryption:**
  - re-encrypting save (Agile writer, CFB writer, DataSpaces);
  - RC4/CryptoAPI (legacy binary formats);
  - IRM/DRM.
- **Spreadsheet CF drawing:** iconSet, dataBar and formula rules; x14 extensions.
- **Patch writer:** shared formulas are expanded; new strings are written inline.
- **Writer:** formatting revisions; header/footer editing; in-paragraph page split; multi-column layout.
- **Verification:** no Excel, Word or LibreOffice is available in this sandbox for an open check.
