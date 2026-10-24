import type { SpecRow } from "./row";

/**
 * TT73 register changes (no new rows).
 *  · FF-22 Writer, FF-23 Slides and FF-29 Charts / CF are raised to class A. The class is raised ONLY on a passing,
 *    measurable whole-corpus gate whose oracle is independent of the app (docs/DESIGN-TT73.md §Class A criteria):
 *      1. every readable corpus file, EDITED in the app's own engine, saves with no schema error the input did not
 *         already have (ECMA-376 transitional XSDs via lxml), and
 *      2. an independent reader (python-docx / python-pptx / Excel's own caches) sees the edit, and
 *      3. unedited saves stay lossless and the feature suites pass.
 *    Known limits stay in the nuance; class A here means "ordinary-app grade on the measurable corpus", not
 *    "verified in Microsoft Office" (Office is not available in this sandbox).
 *  · FF-19 / FF-21 / FF-52: number formats, Unicode names, external workbook links, Excel numeric-argument rules.
 */
type Up = { note: string; test: string; tier?: SpecRow["tier"]; route?: string };
const UP: Record<string, Up> = {
  "FF-22": {
    tier: "A",
    note: "TT73 class A: gate passed — all 111 readable corpus Word documents (17 damaged / encrypted fuzz files are refused with a clear error) were edited (text typed into the body AND a picture added to the header), saved, and every one adds no schema error the input lacked, opens in python-docx with the typed text and the header picture, and re-reads in Writer. New: pictures (logos) in headers / footers (Header & footer panel → Insert picture…), with the relationship in that part's own .rels; a header or footer taller than its margin now pushes the body down / up as in Word (the page view used to draw the body under it); WordprocessingML 2003 w:type=\"odd\" header references read as the default header and are rewritten to the valid \"default\" when that header is edited (TT72 added a 7th reference → schema error). Limits: no OOXML Strict WML; an edited part read through prefix canonicalisation is written canonically (unedited saves stay byte-identical); pictures are inserted inline (floating pictures from files are kept, not created); not opened in Microsoft Word here.",
    test: "tt73-office.mts W1 (header / footer picture: own-part rels, python-docx sees the bytes, XSD-valid, re-read, Track Changes w:ins, a header root without xmlns:r, 3 corpus headers) and W2 (whole-corpus edit gate: 111 documents, 0 new schema errors, 0 python-docx misses, 0 re-read misses)",
  },
  "FF-23": {
    tier: "A",
    note: "TT73 class A: gate passed — the schema oracle now validates PresentationML (pml.xsd: deck, slides, layouts, masters, notes, handouts, properties, comments) and is shown to reject an unknown element and wrong child order; all 83 openable corpus decks (12 fuzz / truncated files refused, as python-pptx also refuses them) were edited (text box + preset shape + picture, speaker notes, a duplicated slide, a slide from a layout) and saved with no schema error the input lacked, and python-pptx sees every edit. Limits: SmartArt / charts are shown from their cached drawing only (as before); not opened in PowerPoint here.",
    test: "tt73-office.mts P1 (PML schema oracle is a real verifier) and P2 (whole-corpus edit gate: 83 decks, 0 new schema errors, 0 python-pptx misses)",
  },
  "FF-29": {
    tier: "A",
    note: "TT73 class A: gate passed — every chart in the xlsx corpus (36 charts with data, 76 series) evaluates in Fusion to exactly what Excel cached in the chart part: 1,828 / 1,828 values (blank where Excel cached no point), 183 / 183 categories and scatter x values, 19 / 19 cached series names (lxml reads c:numCache / c:strCache; independent of the app). The one workbook that disagreed during the probe exposed a real bug (Unicode table names, fixed — FF-21). Limits (from chartxml.ts): 3-D charts are drawn flat; radar / stock / bubble / surface charts are drawn as the nearest 2-D type (with a note); the gate checks the plotted data, not Excel's rendering pixels.",
    test: "tt73-office.mts C1 (chart-cache gate over the corpus; scripts/oracle/chart_cache.py + scripts/tt73-chartcache.mts)",
  },
  "FF-21": {
    note: "TT73: Unicode sheet, table and defined names (Excel writes Лист1!A1 and Таблица1[Col] unquoted; TT72 failed with \"unexpected character\" and showed #NAME?); external workbook links ([1]Sheet!A1, [1]!Name, sheet-scoped [1]Sheet!Name, [0]!Name) resolve from the cached externalLink parts as Excel shows them before Update Links (a missing book is #REF!). Limit: external values are not persisted when a workbook is reloaded from the app's own JSON format — only xlsx keeps them.",
    test: "tt73-office.mts S3 (external links: ref2-56737, 56737, bug67784, missing book) and S4 (Unicode names + the Russian corpus workbook's SUBTOTAL over Таблица1 = Excel's cached 19239.04)",
  },
  "FF-19": {
    note: "TT73: number formats match Excel on all 806 corpus TEXT() results (TT72: 300) and 163 of 189 Apache POI dfUS assertions (TT72: 120; the rest are POI-specific behaviours listed in DESIGN-TT73); Excel's numeric-argument rule (refs count numbers only, literal text → #VALUE!, TRUE → 1) applied across statistics functions; MODE without a repeat → #N/A; ROUND / TRUNC digits truncate; PRODUCT of no numbers → 0.",
    test: "tt73-office.mts S1 (TEXT 806 / 806), S2 (POI 163 / 189), S5 (numeric-argument rules)",
  },
  "FF-52": {
    note: "TT73: the held-out probe (26,946 Excel-cached formula cells in 330 workbooks) now agrees on 26,869 (TT72: 26,295); 0 cells that agreed before disagree now. 77 remain (listed by function in DESIGN-TT73: mostly CELL(), clone-sheet formulas and file-specific edge cases).",
    test: "tt73-office.mts H1 (held-out floor ≥ 26,869 / 26,946)",
  },
};

export function patchTT73(f: SpecRow): SpecRow {
  const u = UP[f.code];
  if (!u) return f;
  return { ...f, tier: u.tier ?? f.tier, route: u.route ?? f.route, nuance: `${f.nuance ? f.nuance + " " : ""}${u.note}`, test: `${f.test ? f.test + "; " : ""}${u.test}` };
}
