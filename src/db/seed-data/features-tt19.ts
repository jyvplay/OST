import { F, type SpecRow, type Status } from "./row";
import { tt16Features } from "./features-tt16";

/**
 * TT19 register additions — USER-DIRECTED EXTENSION ROWS (the spec has no row for these; the user asked to keep
 * expanding the office suite + vector toward incumbent parity and to keep improving Tails-like privacy).
 */
export const tt19Features: SpecRow[] = [
  F("FF-36", "FF", "Spreadsheet defined names: workbook- and sheet-scoped names for ranges, constants and formulas; Name Box define/jump; Name Manager; autocomplete; xlsx + JSON round trip",
    "A", "P2", "src/lib/formula/names.ts (Excel name rules) + engine.ts Workbook.defineName/lookupName/expandNames (AST substitution before evaluation) + sheetops.insertDelete (names move with rows/cols) + xlsx.ts <definedNames> + Spreadsheet.tsx Name Box / Names panel (Ctrl+F3)",
    "Excel rules web-checked: first char letter or _, then letters/digits/._; no spaces; ≤255; not A1- or R1C1-like (XFD1048576 is the A1 ceiling, so XFE1 is a legal name); C/R reserved; case-insensitive and unique per scope; a sheet-scoped name shadows the workbook name on its sheet. Unknown or deleted names give #NAME? (and recover when defined); cyclic names give #NAME? without hanging; deleting a name's whole range gives #REF!. Two independent checks: an openpyxl-authored workbook (workbook/sheet/formula/constant names, plus hidden and _xlnm.Print_Area names that are skipped) evaluates to Python-computed values, and OUR written file is read by openpyxl (names, scopes, destinations) and recalculated by the PyPI `formulas` engine (equal results; `formulas` 1.3.4 cannot resolve sheet-scoped names on ANY file, openpyxl's included — asserted symmetrically). Declared gaps: relative references inside a name are treated as fixed (Excel makes them relative to the active cell); `Sheet1!Name` qualified references are not parsed; names starting with \\ or using non-ASCII letters are refused (Excel allows them); hidden/_xlnm built-in names are dropped on import, not preserved.",
    "built", "names.mts (7); e2e-sheet-layout.mts 'TT19 defined names'"),
  F("FF-37", "FF", "Vector Pathfinder shape modes: Unite, Minus Front, Intersect, Exclude on any number of shapes (rect/ellipse/polygon/path/group, with transforms and fill rules)",
    "A", "P2", "src/lib/vector/boolean.ts (polygon-clipping 0.15.7, MIT — Martinez–Rueda–Feito sweep with robust predicates) + Vector.tsx Pathfinder buttons",
    "Illustrator semantics checked against Adobe's Pathfinder panel doc: Unite/Intersect/Exclude take the FRONTMOST paint, Minus Front subtracts every front shape from the BACKMOST and keeps its paint; Exclude fills odd coverage (even-odd compound path); the result takes the stacking slot of the paint donor. Independent oracle: GEOS via shapely 2.2 rebuilds operands from their primitive parameters — rectangles match exactly (symmetric difference < 1e-6), rotated rect × ellipse IoU ≥ 0.9995 for every mode, three-way Minus Front/Exclude IoU ≥ 0.999, donut-minus-bar exact, group transforms honoured. Fill rules: even-odd exact; nonzero exact when subpaths share a direction (= union) or nest without crossing; crossing mixed-direction nonzero subpaths are computed approximately and FLAGGED in the status line. Declared gaps: results are polygonal (curves flattened to 0.05 units; Illustrator keeps Béziers); no Divide/Trim/Merge/Crop/Outline/Minus Back; no live compound shapes; text and open paths are refused (no glyph outlines, no fill area).",
    "built", "vector-boolean.mts (6); e2e-vector.mts 'TT19 Pathfinder'"),
  F("SC-16", "SC", "Private search: /Private is searchable by name and content from an index built in the tab after unlock; scoped queries never reach the host; amnesic RAM files searchable in place",
    "A", "P2", "src/lib/privacy/psearch.ts (PrivateIndex, memory only) + layer.ts GET /api/search interception (merge with host hits, hostQueried flag) + Find '/Private only' chip and badges",
    "Closes the TT18 gap 'search queries go to the host and /Private is not searchable'. The index is built from decrypted reads (≤5 000 files, ≤2 MiB each, 64 MiB total; binaries indexed by name only), updated incrementally on write/move/trash (no rebuild), and discarded on lock, any key change (checked on every request — a defect found by its own test: clearing keys outside session.lock() previously kept the plaintext index until the next unlocked search) and emergency wipe. Verified by a network spy and SQL: a /Private-scoped search sends zero /api/search requests and index_docs never holds the token. Declared limits: UNscoped searches still send the query text to the host (to search host files); private ranking is substring-count based, not ts_rank, so private hits sort first; the index lives in JS strings, which cannot be zeroised.",
    "built", "privacy-layer.mts 'TT19 private search', 'TT19 amnesic search'; e2e-privacy.mts 'TT19 private search in the UI'"),
];

type Patch = Partial<Pick<SpecRow, "route" | "nuance" | "test">> & { status: Status };
const ff32 = tt16Features.find((f) => f.code === "FF-32");
export const UPDATES_TT19: Record<string, Patch> = ff32 ? {
  "FF-32": { status: ff32.status, nuance: ff32.nuance.replace("Gaps: no boolean path operations, ", "Gaps: boolean operations exist since TT19 (FF-37) but produce polygonal results, ") },
} : {};
