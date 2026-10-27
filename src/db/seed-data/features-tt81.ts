import { F, type SpecRow } from "./row";
/** Narrow, independently testable capabilities; no application-wide Class-A claim. */
export const tt81Features: SpecRow[] = [
  F("FF-78", "FF", "MODE family: legacy scalar/reference rejection, no-duplicate errors, first-encountered ties, MODE.MULT vertical dynamic spill and OOXML export",
    "A", "P2", "src/lib/formula/ext/officeFunctions3.ts + engine accessor provenance + sheetops XLFN",
    "Ranges and arrays ignore nonnumbers and propagate errors. Legacy MODE scalar arguments, including direct cell references, must be numeric. MODE.MULT returns all tied modes in encounter order. Integer-vector oracle is independent brute force; openpyxl checks the exported formula, not recalculation. No claim of all Excel formula parity.", "built", "tt81-core S1–S5; e2e-tt81 E1"),
  F("FF-79", "FF", "PDF visible signature custom rectangle: displayed top-left coordinates and size, rotated CropBox mapping, invalid/off-page box refusal",
    "A", "P2", "src/lib/pdf/sigplacement.ts + PdfSignatures Custom box",
    "Numeric placement, not pointer drawing. Units are default PDF user-space units, normally points. Page rotation must be a multiple of 90 degrees. Corner placement remains available. No new trust/revocation/timestamp claim. pyHanko checks cryptographic integrity; PDFium checks visible ink placement at all four rotations.", "built", "tt81-core P1–P3; e2e-tt81 E2"),
  F("FF-80", "FF", "Slides literal Find/Replace: slide/all-deck scope, case option, table/group text, cross-run matching with first-run formatting, undo/redo and lossless package save",
    "A", "P2", "src/lib/office/pmlsearch.ts + Slides Find pane (Ctrl+F, Tweak)",
    "Does not search notes, masters, dynamic fields, images or charts. Matches do not cross paragraphs, hard breaks or dynamic fields. One-line replacements only, 4096-character query, 65536-character replacement, 100000 hits, 16 MiB growth cap; first 100 hits navigable. Existing core-properties modified timestamp may update on save. Native PowerPoint rendering not tested.", "built", "tt81-core L1–L4 (python-pptx independent readback); e2e-tt81 E3"),
  F("FF-81", "FF", "PDF /UserUnit scaling in the live viewer: direct and indirect /UserUnit, CropBox offsets and 4 quarter-turn rotations render scaled, text-search highlights and the info panel share the same transform",
    "A", "P2", "src/lib/pdf/pdfdoc.ts + src/lib/pdf/pdfcanvas.ts + Pdf / PdfPreview",
    "Render scale comes from page-local /UserUnit (1..75000, default 1; invalid or out-of-range values fall back to 1 with a warning; parent /Pages values are not inherited). Adjacent default-unit pages are unaffected. Text search highlights share the scaled transform. Verified against pypdf dictionary readback and MuPDF 1.28 (pymupdf) physical rendering across all 4 rotations.", "built", "tt81-core P4 (pypdf + MuPDF physical raster/ink); e2e-tt81 E4"),
  F("FF-82", "FF", "Writer word count: model-aware document + selection counts of words, characters (with and without spaces), paragraphs, lines and referenced footnotes/endnotes",
    "A", "P2", "src/lib/office/wordcount.ts + Writer status bar and Word count dialog",
    "Tokenizer groups Unicode letters/numbers/marks with internal apostrophes and hyphens (\"don't\" and decomposed \"re\\u0301sume\\u0301\" = one word each) and counts CJK Unified Ideographs per ideograph; standalone punctuation is not a word. Characters count grapheme clusters. Model-aware countWordDoc and countWordRange exclude tracked deletions (w:del runs, deleted table rows, deleted paragraph marks), inline image labels, bookmark/comment tokens and covered vertical-merge cells, and report referenced footnotes/endnotes.", "built", "tt84-wordcount W1–W12 (python-docx oracle); e2e-tt81 E5"),
];

export function patchTT84(f: SpecRow): SpecRow {
  if (f.code === "AP-02") {
    return {
      ...f,
      status: "built",
      route: "src/lib/storage-core.ts + /api/storage (preview/purge) + StorageModule Uninstall & data assistant",
      nuance: "TT84: per-bucket uninstall assistant across 8 server PostgreSQL buckets (vfs_user, trash, versions, notes, alerts, planner, settings, sessions) and browser localStorage/sessionStorage. Computes a live verifiable preview (exact row counts, byte totals and sample items) before any deletion, refuses purge requests without the exact confirmation token 'DELETE', protects /System and spec tables, and verifies post-purge invariants.",
      test: "tt84-wordcount U1–U4; e2e-tt81 E6",
    };
  }
  if (f.code === "FM-07") {
    return {
      ...f,
      test: "tt84-wordcount U2; e2e-tt81 E6",
    };
  }
  return f;
}
