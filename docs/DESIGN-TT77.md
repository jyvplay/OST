# TT77: PDF reader/editor to class A (JBIG2, JPX, transparency, digital signatures)

## Runtime honesty

**Used:**
- Node 22, tsc, eslint, Next 16.2.6 (production build), Playwright 1.64.1 with Chromium 143.
- A Python 3.11 venv with the oracles, all test-only and never shipped:
  - pypdfium2 5.14 (PDFium) for page renders and image extraction;
  - Pillow/glymur (OpenJPEG) to generate JPX codestreams;
  - pyHanko 0.38 for signature validation;
  - pikepdf/qpdf 10.17 for structure checks;
  - cryptography.

**Corpus:** 972 PDFs (pdf.js test corpus and others). Not in git.

**Not available:** Acrobat, poppler/mupdf, a trust store service, OCSP/TSA servers, Safari/Firefox.

"Class A" means ordinary-app grade on the measurable corpus, judged against independent oracles. It does not mean "verified in Acrobat".

## A. Formal model (summary)

**JBIG2 (FF-67):**
- Implements T.88 segment parsing: generic, refinement, text and halftone regions, plus symbol and pattern dictionaries.
- MQ arithmetic decoding and MMR.
- The page buffer is combined with the region operators.
- Output follows the pdf.js convention: 1 = black is inverted to 0 = black.

**JPX (FF-67):**
- Implements T.800:
  - SIZ/COD/QCD/POC/PPM/PPT;
  - tag-tree packet headers;
  - EBCOT with every code-block mode bit;
  - 5/3 and 9/7 DWT;
  - RCT and ICT;
  - sYCC for three subsampled components without a `colr` box (the OpenJPEG/PDFium convention);
  - palettes;
  - SMaskInData.

**Transparency (FF-68):**
- Groups render on their own layer.
- A non-isolated group starts from a copy of the backdrop and is composited back with the backdrop removed once (`destination-out`, then `lighter`).
- Knockout replaces per element (bounding box, `destination-out`, backdrop refill).
- Luminosity and alpha soft masks go through a scratch canvas with `destination-in`.
- The page group's backdrop is transparent, and the paper colour goes underneath at the end (`destination-over`).

**Signatures (FF-66):** a signature is **valid** when all three hold:
- `digestOk`: the digest over the ByteRange equals `messageDigest`;
- `signatureOk === true`: the CMS SignerInfo verifies with the certificate key (RSA PKCS#1 v1.5, RSA-PSS or ECDSA);
- `coversWholeFile`: the ByteRange covers everything except the hex gap, with ≤2 trailing bytes tolerated.

If the crypto passes but later bytes were appended, the signature is **modified**. Trust is never claimed. Signing writes `adbe.pkcs7.detached` as an incremental update, and identities are non-extractable WebCrypto keys stored in IndexedDB.

## B–C. Hypotheses and frontier

- **H+:** a spec-faithful decoder matches PDFium bit-exactly on the corpus.
- **H−:** PDFium deviates from the spec in places: `/K` knockout is ignored, `jpx_smaskindata` is pre-composited, and annotations are composited over white. Where they disagree, the spec value is asserted and the divergence is declared.
- **H∂:** BER-encoded CMS (real files) versus DER-only readers. Ours accepts bounded BER.

## D. Negative shapes

| Suite | Negative cases |
|---|---|
| `tt77-pdf.mts` | N1–N7: garbage, truncated, oversize SIZ, 70 000 tiles, truncated real codestreams, JBIG2 garbage |
| `tt77-pdfsig.mts` | 23 cases, including hostile CMS, delimiters inside the ByteRange, appended bytes, and an encrypted signed file |
| `e2e-tt77-pdfsig.mts` | Modal shortcut checks and tamper-then-reopen |

## E. Approaches (mechanism-distinct)

1. PDFium pixel differential over full pages.
2. PDFium image extraction, compared bit-exactly.
3. OpenJPEG-generated codestreams with known source pixels.
4. Hand-computed ISO 32000 §11 compositing arithmetic (17 cases plus C17).
5. pyHanko verdicts per signature.
6. qpdf structure checks after signing.
7. A real-browser sign/save/reopen flow.

## F. Artifacts

- `docs/test-results/tt77-*.json` and `e2e-tt77-pdfsig.json`
- `docs/screens/tt77-sig-*.png`

## G. Second-order adversary

Each mutant must be killed:

| Mutant | Killed by |
|---|---|
| `copy16` returns a view instead of a copy (AES mutates the caller's Buffer) | R1, G2 |
| UTCTime read with a 4-digit year | G1 |
| Page clip left active when the paper is composited (C17) | C17 |

**The full differential found a real TT77 regression.** The paper fill was composited while the page's leftover clip (`W n`, or text render modes 4–7 outside `q`/`Q`) was still active. Outside the clip the page stayed transparent:

| File | Similarity |
|---|---|
| `clippath` | 0.36 |
| `issue3584` | 0.02 |
| `glyph_accent` | 0.04 |
| `issue7101` | 0.10 |

**Repair (TT78):** the page runs inside one canvas `save()`. `Interpreter.unwind()` pops any `q` the page left open, and the paper goes under afterwards. All four files are back to their pre-TT77 scores (`clippath` 1.000), and C17 kills the reverted mutant.

## H. External verification

Full PDFium differential over 944 pages, same refs for both trees:

| | Similarity | Ink |
|---|---|---|
| Before TT77 | 0.9565 | 0.7444 |
| After TT77, before the clip repair | 0.9762 | 0.7691 |
| After the clip repair (TT78 rerun) | **0.9799** | **0.7727** |

- Before the repair: 132 pages improved by more than 0.02 ink, 11 regressed. After it: **133 improved, 6 regressed**.
- The 6 remaining:
  - 4 knockout files: PDFium ignores `/K`, and we follow ISO 32000 §11.4.6.
  - `jbig2_file_header`: PDFium renders the page **blank**. Fusion decodes the stand-alone T.88 file header (Annex D) and shows the image, three black rectangles at 128×96, checked visually. Fusion is the more capable reader here.
  - `issue19326`: ink −0.04, but similarity rises from 0.761 to 0.935.
- `issue18036` no longer regresses. Only `issue13520` and `personwithdog` were not compared, because PDFium times out on them.

## J. Stopping / remaining gaps

- No overprint simulation.
- Signatures: no trust store, OCSP/CRL, timestamps or PKCS#12 import; invisible signatures only.
- JBIG2: only what the corpus exercises.
