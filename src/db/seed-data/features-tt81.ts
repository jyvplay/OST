import { F, type SpecRow } from "./row";
/** Narrow, independently testable capabilities; no application-wide Class-A claim. */
export const tt81Features: SpecRow[] = [
  F("FF-78", "FF", "MODE family: legacy scalar/reference rejection, no-duplicate errors, first-encountered ties, MODE.MULT vertical dynamic spill and OOXML export",
    "A", "P2", "src/lib/formula/ext/officeFunctions3.ts + engine accessor provenance + sheetops XLFN",
    "Ranges and arrays ignore nonnumbers and propagate errors. Legacy MODE scalar arguments, including direct cell references, must be numeric. MODE.MULT returns all tied modes in encounter order. Integer-vector oracle is independent brute force; openpyxl checks the exported formula, not recalculation. No claim of all Excel formula parity.", "built", "tt81-core S1–S3; e2e-tt81 E1"),
  F("FF-79", "FF", "PDF visible signature custom rectangle: displayed top-left coordinates and size, rotated CropBox mapping, invalid/off-page box refusal",
    "A", "P2", "src/lib/pdf/sigplacement.ts + PdfSignatures Custom box",
    "Numeric placement, not pointer drawing. Units are default PDF user-space units, normally points. Page rotation must be a multiple of 90 degrees. Corner placement remains available. No new trust/revocation/timestamp claim. pyHanko checks cryptographic integrity; PDFium checks visible ink placement at all four rotations.", "built", "tt81-core P1–P3; e2e-tt81 E2"),
  F("FF-80", "FF", "Slides literal Find/Replace: slide/all-deck scope, case option, table/group text, cross-run matching with first-run formatting, undo/redo and lossless package save",
    "A", "P2", "src/lib/office/pmlsearch.ts + Slides Find pane (Ctrl+F, Tweak)",
    "Does not search notes, masters, dynamic fields, images or charts. Matches do not cross paragraphs, hard breaks or dynamic fields. One-line replacements only, 4096-character query, 65536-character replacement, 100000 hits, 16 MiB growth cap; first 100 hits navigable. Existing core-properties modified timestamp may update on save. Native PowerPoint rendering not tested.", "built", "tt81-core L1–L4 (python-pptx independent readback); e2e-tt81 E3"),
];
