# Tables (TT22)

Tables is an Airtable-style relational base. It opens from the launcher (Create → Tables) or from any `*.ftable` file in Files.

The engine is pure TypeScript in `src/lib/tables-core.ts`, which the Node unit suite imports directly. The UI is `src/components/modules/Tables.tsx`.

## What works

| Area | Behaviour |
|---|---|
| **Field types** | Single line text, long text, number (0–8 decimals), checkbox, single select, multiple select, date, URL, email, rating, link to another table, lookup, rollup, count, formula, autonumber |
| **Validation** | Bad input is refused with a message and the cell keeps its value. Examples: an impossible date (Feb 30), a non-number, a `javascript:` or `file:` URL. New select options are added once, with a colour; case-insensitive matches map onto the existing spelling. |
| **Links** | Two-way. Adding a link field creates the inverse field on the other table, and both sides stay in step. Deleting a record removes it from every link cell. Deleting a link field removes its inverse, and dependent lookups and rollups show an error instead of a stale number. |
| **Lookup / rollup / count** | Follow a link field. Rollups support SUM, AVG, MIN, MAX, COUNT, COUNTA, CONCAT, AND and OR. They recompute when the linked record changes. |
| **Formulas** | `{Field name}` references; `+ - * / %`, `&` (join text), `= != < > <= >=`; 32 functions (`IF AND OR NOT SUM AVERAGE MIN MAX COUNT COUNTA ROUND ABS INT MOD BLANK ISBLANK CONCATENATE LEN UPPER LOWER TRIM LEFT RIGHT FIND SUBSTITUTE ARRAYJOIN DATETIME_DIFF DATEADD YEAR MONTH DAY VALUE`). Cycles show `#CYCLE`; errors show `Error: …` in the cell. Renaming a field rewrites the formulas that use it. |
| **Type conversion** | Values are converted where a faithful conversion exists. The rest are cleared, and the count is reported; Undo brings them back. |
| **Views** | Each table can have several grid and kanban views. Each view has AND/OR filters, multi-level sort (empty cells always last), one group level, hidden fields, search and a summary footer. |
| **Kanban** | Columns come from a single-select field. Cards move by drag-and-drop or with the "Move to" select on each card, which works from the keyboard. |
| **Editing** | Arrow keys move between cells; Enter or F2 edits; Delete clears; Space expands the record. The expanded record panel has a link picker. Each field's header menu can rename, convert, sort, hide and delete it. Undo/redo is exact and keeps 100 steps. |
| **Files** | Native `.ftable` JSON (`format: "fusion-tables-1"`, checked on load). CSV import infers types; CSV export writes the current view to `/Documents`. The export guards against formula injection (OWASP): cells starting with `= + - @` get a `'` prefix unless they are plain numbers. Re-import removes the prefix. |

## Not built (honest scope)

- No gallery, calendar, form, timeline or Gantt views.
- Only one group level.
- No attachment, user or created/modified-time fields.
- No `REGEX_*`, `SWITCH`, time-zone or record-metadata formula functions.
- No collaboration, comments, revision history, automations, extensions or API.

## Verification

| Suite | What it checks |
|---|---|
| `scripts/tables-engine.mts` (9 tests) | The engine directly. Expected values are worked out by hand, e.g. 12.5 × 8 + 2 − 2 = 100, 80 + 65.5 = 145.5, and Oct 31 + 1 month = Dec 1. |
| `scripts/e2e-tables.mts` (8 tests) | The UI in headless Chromium: editing with refusal and undo, a new formula field, filter + sort + search, the link picker and the rollup on the other table, kanban by select and by drag-and-drop, save/reopen, CSV export/import. Also axe-core on the deeper UI states. |

The engine tests found two real bugs before release:
1. Two new multi-select spellings ("Blue", "blue") were not de-duplicated against each other.
2. The CSV injection guard also prefixed negative numbers, which broke number columns on re-import.
