import type { SpecRow } from "./row";

/**
 * TT52 register changes — a first-party PDF engine replaces the browser's <embed> viewer (which the app's own CSP
 * `object-src 'none'` blocks, and which headless/mobile browsers without a PDF viewer do not have). Evidence:
 * scripts/tt52-pdf.mts (PDFium + qpdf oracles over the 972-file pdf.js test corpus), scripts/tt52-mutants.py and
 * scripts/e2e-tt52-pdf.mts (real UI, Chromium 143, saved files re-read by PDFium and pypdf).
 */
const ENGINE = "TT52: src/lib/pdf is a from-scratch PDF engine (no pdf.js/PDFium code): lexer/parser with xref tables, xref streams, "
  + "object streams and damaged-file recovery; Flate/LZW/ASCII85/ASCIIHex/RunLength filters, CCITT G3/G4 fax (first-party, bit-exact against libtiff), DCT (browser decoder) with predictors; Standard "
  + "security handler R2–R6 (RC4, AES-128, AES-256, SASLprep passwords); fonts: TrueType, CFF/CID-keyed CFF, Type 1 (eexec), Type 3, the 14 "
  + "standard fonts with Adobe AFM metrics, CMaps and ToUnicode; colour spaces incl. ICC (as N-component), Indexed, Separation/DeviceN, Lab; "
  + "function shadings types 1–7; transparency groups (blend modes, constant alpha); annotation appearances (synthesised when a file has none). "
  + "Measured against PDFium (Chrome's engine, test-only): 966/972 corpus files open (+5 need a password; the rest are broken in every engine), "
  + "page count agrees 954/954; text bigram-F1 0.9398 mean over 1,078 pages (979 ≥ 0.95); page renders 0.9565 mean pixel similarity, "
  + "0.7446 mean ink agreement (strict any-channel metric) over 947 pages; edits re-opened by PDFium + qpdf: 1,153/1,157 verifiable jobs pass (4 documented disagreements). "
  + "Not rendered: JPEG 2000 and JBIG2 images (hatched placeholder + warning), soft masks set through ExtGState, overprint, knockout "
  + "groups; text of CID fonts without ToUnicode and of GBK-named simple fonts can differ from PDFium; signatures are neither created nor validated.";
const EDIT = " Viewer/editor (PDF app): lazy page canvases with fit/zoom/view-rotation, thumbnails with multi-select, find with highlighted "
  + "hits, copy/export text, highlight/underline/strike-out on text, pen, box, ellipse, text box, sticky note (all written as real PDF annotations "
  + "with appearance streams, so other readers show them), form filling (text, checkbox, radio, choice) with generated appearances, document "
  + "info editing, rotate/delete/move/insert pages, merge and extract, undo/redo; saves are incremental updates (the original bytes stay an exact "
  + "prefix, encrypted files stay encrypted) or a clean rewrite that drops deleted content; Peek previews PDFs with the same renderer.";

export function patchTT52(f: SpecRow): SpecRow {
  if (f.code === "FF-03" || f.code === "PR-08") {
    return {
      ...f,
      status: "built",
      route: "src/lib/pdf (first-party engine: pdfobj/pdfdoc/pdfcrypt/pdffilters/pdffont/pdfglyph/pdfinterp/pdfcanvas/pdftext/pdfedit) + PDF app (src/components/modules/Pdf.tsx) + Peek preview",
      nuance: ENGINE + EDIT,
      test: `${f.test ? f.test + "; " : ""}tt52-pdf.mts; tt52-mutants.py; e2e-tt52-pdf.mts`,
    };
  }
  return f;
}
