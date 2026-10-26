import type { SpecRow, Status } from "./row";

/**
 * TT46 + TT47 register changes — Writer and Spreadsheet as lossless OOXML editors. Every claim names its evidence
 * (scripts + independent oracles); remaining gaps are listed in the nuance. Oracles are test-only: openpyxl 3.1,
 * python-docx, lxml, msoffcrypto-tool (MIT), node:crypto (OpenSSL), Apache POI test-data files with Excel-cached values.
 */
type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };

const ENC = "Password-protected files (MS-OFFCRYPTO Agile SHA-1…SHA-512/AES-128…256 with HMAC integrity check, and Standard AES) open after a masked in-app prompt; decryption runs on the device with original SHA/HMAC/AES code (400 random vectors equal OpenSSL; FIPS-197 known answers) and a from-scratch MS-CFB reader (25 malformed shapes refused, 240-mutant fuzz). Saving never writes plaintext over the protected original: an explicit, differently named unencrypted copy is required and the server refuses plaintext over an encrypted file. Re-encrypting on save is NOT implemented.";

export const UPDATES_TT47: Record<string, Patch> = {
  "FF-20": { status: "built",
    route: "src/lib/formula/xlsx-patch.ts lossless patch writer (keeps the original package, rewrites only edited sheets/styles/CF) + xlsx.ts writer for new workbooks",
    nuance: "TT46/47: editing a real Excel file keeps every part it does not change byte-identical (no-edit save = original bytes, 321/324 corpus workbooks; the 3 others are refused corrupt/ambiguous packages) and openpyxl sees exactly the intended edits in 309/309 corpus edit sessions. Charts, comments, pivots, drawings and existing conditional formats survive; new and edited CF rules (cellIs, 2/3-colour scales) are written into <conditionalFormatting> with dxfs. Theme/indexed/tinted colours are kept. Limits: new strings are written inline; shared formulas are expanded; calcChain is dropped with fullCalcOnLoad; an unhinted sheet rename is delete+add; Strict OOXML is verified only by our reader; 8 MiB guard.",
    test: "tt46-xlsx-patch.mts; tt47-sheet.mts; e2e-tt46.mts; e2e-tt47.mts" },
  "FF-21": { status: "built",
    route: "src/lib/formula/xlsx.ts reader: relationships, shared strings, styles incl. theme/indexed/tint colours, merges, validations, conditional formats, panes; engine re-evaluates formulas",
    nuance: "TT46/47: verified on 353 real workbooks from Apache POI's test data. Formula results equal Excel's cached values for 97.64% of 26,946 formula cells (TEXT/number-format gaps listed in the PR); 249,341 coloured cells in 319 workbooks match an independent colour oracle; 227,790 string cells (33,917 that look like numbers, booleans or formulas) stay text exactly as openpyxl reads them, so a text cell can never become a live formula. Conditional formats are rendered for cellIs and colour scales; iconSet/dataBar/formula rules are preserved but not drawn. " + ENC,
    test: "tt47-sheet.mts; tt47-crypto.mts; scripts/diag/xlsx-corpus.mts; e2e-tt47.mts" },
  "FF-22": { status: "built",
    route: "src/lib/office/wordml.ts + wordedit.ts + Writer module: paged WYSIWYG editing of real .docx in the browser, lossless save",
    nuance: "TT46/47: 113/113 valid corpus documents save byte-identically when unedited; editing one paragraph leaves every other paragraph's XML identical; forcing every paragraph to regenerate keeps text, styles and formatting for 112/113 (python-docx oracle). Styles, runs, lists from numbering.xml, tables (insert/delete rows and columns), pictures (resize), hyperlinks, comments, page breaks, page setup, find/replace and accept/reject of tracked insertions/deletions are supported. Limits: formatting revisions (pPrChange/rPrChange) are refused; headers/footers are view-only; no in-paragraph page split; single column; 2,000-page cap. " + ENC,
    test: "tt46-writer.mts; e2e-tt46.mts; tt47-crypto.mts; e2e-tt47.mts" },
  "FF-11": { status: "built",
    route: "Writer status/Save-As fidelity note; Spreadsheet lossless-save report (parts kept / rewritten / cells written); explicit unencrypted-copy confirmation",
    nuance: "TT46/47: every save states what was kept and what was rewritten; a lossy fallback (.fworkbook or a NEW .xlsx) is announced in a warning before it is used, and a decrypted document can only be saved as a confirmed unencrypted copy under a different name." },
  "PR-11": { status: "partial",
    route: "Writer (.docx) and Spreadsheet (.xlsx) are lossless OOXML editors; Slides remains a PresentationML subset",
    nuance: "TT46/47: Writer and Spreadsheet edit real Office files in place (see FF-20/21/22), including password-protected ones (decrypt only). Still partial because Slides is a text/layout subset, there is no Excel/Word/LibreOffice open check in this sandbox, and encrypted files cannot be re-encrypted on save." },
};
