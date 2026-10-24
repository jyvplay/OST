import { F, type SpecRow, type Status } from "./row";

/**
 * TT22 register additions — USER-DIRECTED EXTENSION ROWS. The user asked for a chic 2026 "poolside Miami" look with
 * all three palette directions selectable, and for large text to be an option rather than the default.
 */
export const tt22Features: SpecRow[] = [
  F("AX-11", "AX", "Selectable visual style: Poolside (default, pastel), Vice (neon), Ocean Drive (art-deco) and Bubbly (TT21) — each recolours every icon tile, the logo, wallpaper ('auto'), accent ('auto'), surfaces and chrome",
    "A", "P2", "src/lib/style-core.ts (single source: palettes, logo, chrome, dark/light tokens, styleCss) + layout.tsx SSR <style id=fs-style-tokens> and html[data-style] + appearance.style setting (validated) + Settings style picker + Quick panel + 'style' routine command + public/wallpapers/{poolside,vice,oceandrive}.svg",
    "Every glyph/tile pair, every chrome pair (launcher pill, window buttons, desk labels) and the dark/light text tokens of every style are checked numerically (WCAG 1.4.3 / 1.4.11). The user's explicit accent still overrides the style accent; the high-contrast and forced-colours modes still win over every style. Existing installs are migrated once (v3.10: 200 % → 125 %, the TT21 accent/wallpaper defaults → 'auto'); a user-chosen value is never overwritten.",
    "built", "a11y-unit.mts 'style system'; e2e-a11y.mts 'style switch'"),
  // ---- Tables module (TT22: "add more modules after the UI/UX work") — an Airtable-class relational base ----
  F("TB-01", "TB", "Tables: typed fields (text, long text, number with precision, checkbox, single/multi select, date, URL, email, rating) with validation, type conversion and CSV import/export",
    "A", "P2", "src/lib/tables-core.ts (coerce, changeFieldType, parseCsv/toCsv/importCsv, inferType) + src/components/modules/Tables.tsx; native .ftable documents in the VFS",
    "Refused input is reported, never silently mangled: an impossible date (Feb 30), a non-number or a javascript: URL is rejected; a type change clears and COUNTS unconvertible cells (Undo restores them). CSV is RFC 4180 with an OWASP formula-injection guard on export (=, +, -, @ prefixed with ' unless the cell is a plain number) that is stripped on re-import.",
    "built", "tables-engine.mts 'typed cells', 'select fields', 'type conversion', 'CSV', 'integrity'; e2e-tables.mts"),
  F("TB-02", "TB", "Tables relations: two-way link fields, lookups, rollups (sum/avg/min/max/count/counta/concat/and/or) and linked-record counts",
    "A", "P2", "tables-core addField (creates the inverse link), setCell → setLinks, deleteRecords (scrubs references), computeTable (lookup/rollup/count across tables)",
    "Like Airtable, a link field creates its inverse on the target table and every edit keeps both sides in step; deleting a record removes it from every link cell; deleting a link field removes its inverse and dependants show an error rather than a stale number.",
    "built", "tables-engine.mts 'two-way links', 'lookup / rollup / count'; e2e-tables.mts 'link picker'"),
  F("TB-03", "TB", "Tables formulas: {Field} references, arithmetic/comparison/& concatenation, 32 functions (IF, AND, ROUND, SUM, CONCATENATE, DATETIME_DIFF, DATEADD, ARRAYJOIN…), cycle detection",
    "A", "P2", "tables-core parseFormula / evalNode / computeTable (dependency-ordered evaluation per record); Add-field panel validates live and lists fields/functions",
    "Not Airtable's full function library (no REGEX_*, no SWITCH, no time-zone functions, no record-metadata functions such as CREATED_TIME). Renaming a field rewrites {Old} → {New} in formulas. Errors (#ERROR: division by zero, unknown field) and #CYCLE are shown in the cell.",
    "built", "tables-engine.mts 'formulas'; e2e-tables.mts 'formula field'"),
  F("TB-04", "TB", "Tables views: multiple grid and kanban views per table, each with AND/OR filters, multi-level sort (empties last), grouping, hidden fields, search and a summary footer",
    "A", "P2", "tables-core runView / kanbanColumns / summarize; Tables.tsx view tabs, Filter/Sort/Group/Hide panels, kanban drag-and-drop plus a keyboard 'Move to' select on every card",
    "No gallery, calendar, form or Gantt views; no per-view row colouring; one group level (Airtable allows three).",
    "built", "tables-engine.mts 'views'; e2e-tables.mts 'filter + sort', 'kanban'"),
  F("TB-05", "TB", "Tables editing UX: spreadsheet-style grid (arrow keys, Enter/F2 edit, Delete clears, Space expands), expanded record panel, link picker, field menu (rename/convert/sort/hide/delete), exact undo/redo, save/open .ftable from Files",
    "A", "P2", "src/components/modules/Tables.tsx (immutable snapshots as the undo history, 100 steps) + Files opens *.ftable in Tables",
    "Single user, no real-time collaboration, comments, revision history, attachments field, automations or API — a local-first base, honestly scoped.",
    "built", "e2e-tables.mts; e2e-a11y.mts 'axe per module' (Tables window)"),
];

type Patch = Partial<Pick<SpecRow, "name" | "route" | "nuance" | "test">> & { status: Status };
export const UPDATES_TT22: Record<string, Patch> = {
  "AX-09": {
    status: "built",
    name: "Text size setting: default 125 % of the TT20 sizes (body ≈16 px at a 16 px browser default), an opt-in Large text mode (200 %), 100–300 % in Settings, Quick panel A−/A+ and the 'textsize' routine command",
    test: "a11y-unit.mts 'text-scale maths'; e2e-a11y.mts 'computed sizes', 'large text mode', '300 % and reflow'",
  },
};
