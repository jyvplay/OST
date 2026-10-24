import { F, type SpecRow } from "./row";

/**
 * TT59 register additions + changes. USER-DIRECTED EXTENSION ROWS (the user asked for Class A Writer and Spreadsheet
 * apps; proofing is the largest gap left against Word / Excel). Every row names its code and the suite that verifies
 * it against ground truth outside our code (spylls — a Python port of Hunspell — as a black-box oracle; python-docx /
 * lxml / openpyxl reading saved bytes).
 */
export const tt59Features: SpecRow[] = [
  F("FF-38", "FF", "Writer proofing: spell check as you type (wavy underlines), repeated words, F7 Spelling pane, right-click suggestions, user dictionary",
    "A", "P2", "src/lib/spell/hunspell.ts (original Hunspell-format engine: affix rules, flags, REP / KEY / TRY suggestions) + client.ts (lazy dictionary, CSS Custom Highlight painting, per-browser user dictionary) + src/lib/office/wordspell.ts + writer/SpellPanel.tsx + Writer.tsx",
    "Dictionary: SCOWL / Hunspell en_US 2020.12.07 (npm dictionary-en 4.0.0, MIT AND BSD) served from /dict, checked on the device — nothing is sent anywhere. Differential test against spylls (MPL-2.0, test-only, never shipped or ported): 0 mismatches in 22,358 words; our suggestion list contains spylls' first suggestion for 97 % of the sampled misspellings (our first choice equals it for 92 %), ~85 ms per word. Honours w:noProof and skips non-English w:lang runs, URLs, e-mail addresses, ordinals, numbers and (option) UPPERCASE words; deleted tracked text is not checked. Change / Change All / Ignore Once / Ignore All / Add to Dictionary / Delete repeated word; F7 opens the pane, Alt+F7 jumps to the next issue; mode Fusion / browser built-in / off. Declared gaps: en_US only; headers, footers and notes are not checked (body + tables are); no grammar checking; Ignore All lasts for the session; COMPOUNDFLAG / CIRCUMFIX / two-level affix dictionaries are refused; underlines need the CSS Custom Highlight API (Chromium 105+, Safari 17.2+, Firefox 140+).",
    "built", "tt59-writer-spell.mts (8, 6 mutants killed); e2e-tt59.mts FF-38"),
  F("FF-39", "FF", "Spreadsheet spelling (F7): check text cells of the active sheet or the selection, suggestions, Change / Change All / Ignore / Add to Dictionary / Delete repeated word",
    "A", "P2", "src/lib/formula/sheetspell.ts + src/components/modules/sheet-spell.tsx + Spreadsheet.tsx (F7, Review ▸ Spelling)",
    "Excel's order (row by row); only text constants are checked — formulas, formula results, numbers and notes never are; a fix that would look like a number or formula is stored as text ('-prefixed); a stale issue (cell edited meanwhile) is refused; the dictionary and user words are shared with Writer. Verified with an openpyxl-authored workbook and the saved .xlsx read back by openpyxl (formulas untouched, other sheets untouched); 20,000 cells checked in ~0.15 s. Declared gaps: en_US only; no 'continue on the next sheet'; comments / notes, chart titles and shapes are not checked.",
    "built", "tt59-sheet-spell.mts (5, 4 mutants killed); e2e-tt59.mts FF-39"),
];

const UP: Record<string, { note: string; test: string; route?: string }> = {
  "FF-05": { route: "Photos.tsx (createImageBitmap decode of jpg/png/webp/gif/bmp) + src/lib/image/encode.ts (canvas PNG / JPEG / WebP) + src/lib/image/rasterenc.ts (TT59 GIF + BMP encoders)", note: "TT59 GIF and BMP export written from scratch (canvas encoders only produce PNG / JPEG / WebP): GIF89a with an exact palette for ≤ 255 colours, otherwise median cut over a 5-bit histogram + Floyd–Steinberg dithering, alpha < 128 as the transparent index, variable-length LZW with the 4096-code reset; BMP 24-bit bottom-up with row padding, transparency composited over white (as Paint does). Pillow decodes every file bit-exact where exact is possible; Chromium re-opens the exported GIF in Photos. Declared gaps: GIF export is a single frame (animated GIFs open as their first frame); neither format embeds metadata.", test: "tt59-raster.mts (5, 6 mutants killed); e2e-tt59.mts FF-05" },
  "FF-28": { note: "TT59 Paste Special ▸ All now carries hyperlinks (also with Transpose; Skip blanks keeps a target link under a blank source); Values / Formulas / Formats keep the target's links as Excel does. New Paste Link writes absolute references to the copied cells (=$C$1, ='Data 2026'!$B$2; sheet names that look like cells or R1C1 are quoted), so targets follow later source edits; a blank source shows 0. Not offered with Transpose / Skip blanks / an operation (Excel greys it out too).", test: "tt59-sheet-paste.mts (3, 5 mutants killed); e2e-tt59.mts FF-28" },
  "FF-29": { note: "TT59 Excel 2010 x14-only formula rules (cellIs / expression / text rules whose formulas refer to another sheet, with <xm:f> operands and an inline <x14:dxf>) are now read, drawn in priority order with stopIfTrue, and follow edits on the other sheet; the new-file writer emits cross-sheet formula rules in that x14 form (same-sheet rules stay in the 2007 schema), and a lossless save keeps them byte-identical. Gap: rules added in the app to an existing file are written to the 2007 schema by the lossless patcher.", test: "tt59-x14-cf.mts (3, 4 mutants killed)" },
  "FF-20": { note: "TT59 x14 cross-sheet conditional-format rules written as Excel 2010 does (openpyxl + lxml still open the file).", test: "tt59-x14-cf.mts" },
};

export function patchTT59(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
