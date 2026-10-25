import { F, type SpecRow } from "./row";

/**
 * TT77 + TT78 register additions and changes. User direction: "turn both the spreadsheet apps and the pdf reader/editor
 * to Class A features this turn … complete one other core feature into class A … increase the number of features in a
 * testable state". Class A is raised ONLY on a passing gate whose oracle is independent of the app:
 *  - PDF: PDFium (pypdfium2) renders + image extraction, OpenJPEG (glymur / Pillow) codestreams, pyHanko signature
 *    validation, qpdf/pikepdf structure checks (docs/DESIGN-TT77.md).
 *  - Spreadsheet: openpyxl (reader AND writer), pandas groupby, the ECMA-376 XSDs, Excel-written corpus files (Apache
 *    POI test data) (docs/DESIGN-TT78.md).
 * Acrobat / Excel are not available in this sandbox; "A" means ordinary-app grade on the measurable corpus.
 */
const P77 = "tt77-pdf.mts", PC77 = "tt77-pdf-composite.mts", PS77 = "tt77-pdfsig.mts", PSE77 = "e2e-tt77-pdfsig.mts";
const S78 = "tt78-sheet.mts", SE78 = "e2e-tt78-sheet.mts";
export const tt78Features: SpecRow[] = [
  F("FF-64", "FF", "Spreadsheet outlines: Group / Ungroup rows and columns (8 levels, Alt+Shift+→/←), +/− and 1-2-3 level buttons, Show / Hide detail, summary rows below or above, Auto Outline, Clear Outline, Data ▸ Subtotal (Sum, Count, Average, Max, Min, Product, StdDev, Var …) and Remove All; kept in .xlsx both ways",
    "A", "P2", "src/lib/formula/sheetoutline.ts (formal model: levels λ, collapsed set K, summary placement; groups = maximal runs at level ≥ L) + Spreadsheet.tsx gutters / toolbar + xlsx.ts / xlsx-patch.ts (row / col outlineLevel + collapsed, sheetPr/outlinePr, sheetFormatPr outlineLevelRow/Col) + workbook-json (undo snapshots)",
    "Collapsed rows are ordinary hidden rows (the file cannot tell them apart); expanding never shows rows the AutoFilter hid; expanding a parent keeps nested collapsed groups collapsed; ungrouping leaves hidden rows hidden (Microsoft). Auto Outline is a declared heuristic (summary formulas aggregating an adjacent single-column / single-row block); Subtotal offers summary-below only and no page breaks.",
    "built", `${S78} O1 (corpus: every Excel-written outline agrees with openpyxl), O3 (openpyxl-written outlines read identically; Fusion's patch read back by openpyxl), M1, M2 (Subtotal == pandas for 4 functions), M4, R1–R3, N1–N17; ${SE78} 1–2 (Subtotal dialog, level buttons, +/−, modal shortcut, saved file checked by openpyxl)`),
  F("FF-65", "FF", "Excel table calculated columns and auto-expansion: a formula typed into a table column fills the column (one undo), consistent columns refill, constants become exceptions, typing below / right of a table grows it, inserted rows are filled; calculatedColumnFormula kept in .xlsx both ways",
    "A", "P2", "src/lib/formula/sheettablecalc.ts (rules F1–F3, E1, X1, X2, S1; calc stored relative to the first body row) + Spreadsheet.tsx enter / commit + sheetops insertDelete + xlsx / xlsx-patch (calculatedColumnFormula) + workbook-json",
    "Only typed single-cell entries trigger the rules (paste / fill / sort do not, as in Excel's AutoCorrect). The AutoCorrect 'Overwrite all cells' offer is a status note; array calculated columns are kept verbatim but not modelled; renaming a column header drops its calc (declared).",
    "built", `${S78} O2 (8 corpus files: calc == openpyxl, and calc shifted per body row == every cell formula Excel wrote), M3, R1–R3, N6, N7, N11–N13, N18; ${SE78} 3 (fill, grow, one-step undo, saved file checked by openpyxl)`),
  F("FF-66", "FF", "PDF digital signatures: validate every signature (digest, CMS signature, byte-range coverage, later modifications), show signer / issuer / time, and sign (adbe.pkcs7.detached, incremental update) with a local identity kept as a non-extractable key",
    "A", "P2", "src/lib/pdf/pdfsig.ts (ByteRange / CMS / X.509 / RSA-PSS-PKCS1-ECDSA verification, BER tolerant, signing) + sigstore.ts (IndexedDB identities) + PdfSignatures.tsx panel",
    "Trust is never claimed: no trust store, OCSP / CRL, timestamps or PKCS#12 import; signatures are invisible (no appearance stream). 'Valid' means the bytes and the CMS signature check and cover the whole file.",
    "built", `${PS77} (23 cases; every corpus signature agrees with pyHanko; hostile CMS / ByteRange shapes); ${PSE77} S1–S7 (real browser: panel, sign, save, reopen, tamper)`),
  F("FF-67", "FF", "PDF JBIG2 and JPEG 2000 (JPX) images decoded by first-party code (generic / refinement / text / halftone regions, symbol dictionaries; JPX tiles, all progression orders, code-block modes, sYCC, palettes, SMaskInData)",
    "A", "P2", "src/lib/pdf/pdfjbig2.ts + pdfjpx.ts (written from the specifications; reviewed against SerenityOS LibGfx (BSD-2) behaviour only)",
    "Declared divergences: jbig2_file_header (embedded file header), jpx_smaskindata (PDFium pre-composites). No JBIG2 generic-region MMR edge cases beyond the corpus.",
    "built", `${P77} J1 (102/103 corpus JBIG2 images bit-exact vs PDFium), J2 (JPX within ±2), J3 (40 OpenJPEG codestreams), J4, N1–N7`),
  F("FF-68", "FF", "PDF transparency: isolated / non-isolated and knockout groups, luminosity and alpha soft masks, blend modes over the backdrop, page group composited onto the paper",
    "A", "P2", "src/lib/pdf/pdfcanvas.ts (group layers, backdrop copy, destination-out / lighter compositing, soft-mask scratch)",
    "Overprint is not simulated. PDFium ignores /K (knockout); Fusion follows ISO 32000 there, so those pages differ from PDFium by design.",
    "built", `${PC77} (17 cases); full PDFium differential over 944 pages (scripts/tt52-render.mts): 0.976 similarity / 0.769 ink vs 0.957 / 0.744 before TT77`),
];

const UP: Record<string, { note: string; test: string; tier?: SpecRow["tier"]; status?: SpecRow["status"] }> = {
  "FF-03": {
    tier: "A", status: "built",
    note: "TT77 class A: the first-party PDF engine now decodes JBIG2 and JPX (FF-67), composites transparency groups / soft masks / knockout (FF-68) and validates + creates digital signatures (FF-66), on top of TT52's viewer / editor. Gate: 966/972 corpus files open; full-page PDFium differential 0.976 similarity. Remaining gaps: overprint, signature trust (no trust store / OCSP / timestamps), visible signature appearances.",
    test: `${P77}; ${PC77}; ${PS77}; ${PSE77}`,
  },
  "PR-08": { note: "TT77: see FF-03 (JBIG2 / JPX / transparency / signatures).", test: `${PS77}; ${PSE77}` },
  "FF-19": { note: "TT78: outlines / Subtotal (FF-64) and table calculated columns + auto-expansion (FF-65).", test: `${S78}; ${SE78}` },
  "FF-21": { note: "TT78: row / column outlines, outlinePr and calculatedColumnFormula round-trip in both writers.", test: `${S78}` },
  // TT78 "one other core feature to class A": Photoshop documents
  "FF-08": {
    tier: "A", status: "built",
    note: "TT78 class A (supersedes the grade-E skeleton note): the Image Editor opens, renders, edits and saves PSD with layer groups (pass-through / isolated, nested, hidden, group opacity + blend), clipping masks and 26 of 27 Photoshop blend modes (12 W3C separable, hue / saturation / color / luminosity, linear burn / dodge, vivid / linear / pin light, hard mix, subtract, divide, darker / lighter colour). Verified in both directions against psd-tools' independent compositor (Δ ≤ 1/255 over every mode, groups and clipping), the 16 canvas modes also against Chromium/Skia; 33/33 second-order mutants killed (scripts/tt78-mutants.py). Gaps, each reported on open: layer effects, vector masks, adjustment / smart-object / type layers render from stored pixels, dissolve shown as normal, clipping to a group drawn unclipped, PSB / 16-32-bit / CMYK / Lab refused. No Photoshop available to verify; psd-tools is the oracle.",
    test: "oracle-psd.mts (A raw/rle/zip, B raw/rle/zip/groups, clipping-exercised); image-engine.mts TT78 pins / clipping / groups / PSD round-trip; e2e-image.mts clipping UI + Skia oracle (16 modes)",
  },
  "FF-30": { note: "TT78: non-separable (hue / saturation / color / luminosity) and 10 Photoshop-only blend modes, clipping masks ('Clip to layer below') and layer groups are now composited — supersedes the gap list above.", test: "image-engine.mts TT78; e2e-image.mts TT78 clipping" },
  "FF-31": { note: "TT78: groups (lsct, pass-through / isolated, nested), clipping byte and all 26 supported blend keys are read and written; see FF-08.", test: "oracle-psd.mts B/groups" },
};

export function patchTT78(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, tier: u.tier ?? f.tier, status: u.status ?? f.status, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
