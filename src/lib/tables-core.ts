/**
 * Tables engine (TT22) — an Airtable-style relational base, pure and hook-free so Node tests import it directly.
 *
 * Model: a Base holds Tables; a Table has typed Fields, Records (id → raw cell values) and Views (grid / kanban
 * with filter, sort, group and hidden fields). Computed fields (formula, lookup, rollup, count, autonumber) are never
 * stored — `computeTable` derives them, so a stale value can never be saved.
 *
 * Semantics (taken from how Airtable behaves, documented in the module help):
 *  - link fields are two-way: creating one creates the inverse field on the target table, and every edit keeps both
 *    sides in step; deleting a record removes it from every link cell that pointed at it.
 *  - lookups follow a link field and list the target field's values; rollups aggregate them (sum, avg, min, max,
 *    count, counta, concat, and, or).
 *  - formula fields reference other fields as {Field name}; cycles between formula fields evaluate to #CYCLE.
 *  - changing a field's type converts the stored values where a faithful conversion exists and reports how many
 *    cells could not be converted (they are cleared, never silently mangled).
 * Every operation returns a NEW base (structural sharing); the UI keeps those snapshots as its undo history.
 */

export type FieldType =
  | "text" | "longText" | "number" | "checkbox" | "singleSelect" | "multiSelect" | "date" | "url" | "email" | "rating"
  | "link" | "lookup" | "rollup" | "count" | "formula" | "autonumber";
export const COMPUTED: readonly FieldType[] = ["lookup", "rollup", "count", "formula", "autonumber"];
export const FIELD_TYPES: { id: FieldType; label: string }[] = [
  { id: "text", label: "Single line text" }, { id: "longText", label: "Long text" }, { id: "number", label: "Number" },
  { id: "checkbox", label: "Checkbox" }, { id: "singleSelect", label: "Single select" }, { id: "multiSelect", label: "Multiple select" },
  { id: "date", label: "Date" }, { id: "url", label: "URL" }, { id: "email", label: "Email" }, { id: "rating", label: "Rating" },
  { id: "link", label: "Link to another table" }, { id: "lookup", label: "Lookup" }, { id: "rollup", label: "Rollup" },
  { id: "count", label: "Count (linked records)" }, { id: "formula", label: "Formula" }, { id: "autonumber", label: "Autonumber" },
];
export type RollupFn = "sum" | "avg" | "min" | "max" | "count" | "counta" | "concat" | "and" | "or";
export const ROLLUP_FNS: RollupFn[] = ["sum", "avg", "min", "max", "count", "counta", "concat", "and", "or"];

export interface SelectOption { name: string; color: string }
export interface Field {
  id: string; name: string; type: FieldType;
  /** number: decimal places */ precision?: number;
  /** select fields */ options?: SelectOption[];
  /** rating: max stars */ max?: number;
  /** link: target table + the inverse link field on it */ linkTable?: string; inverseField?: string;
  /** lookup/rollup/count: which link field to follow, and (lookup/rollup) which field on the target */
  viaField?: string; targetField?: string; rollup?: RollupFn;
  /** formula source, e.g. `{Price} * {Qty}` */ formula?: string;
}
export type Cell = string | number | boolean | string[] | null;
export interface RecordRow { id: string; cells: Record<string, Cell>; seq: number }
export type FilterOp = "contains" | "notContains" | "is" | "isNot" | "isEmpty" | "isNotEmpty" | "gt" | "lt" | "gte" | "lte" | "hasAny";
export interface Filter { field: string; op: FilterOp; value?: string }
export interface Sort { field: string; dir: "asc" | "desc" }
export interface View {
  id: string; name: string; kind: "grid" | "kanban";
  filters: Filter[]; conjunction: "and" | "or"; sorts: Sort[]; groupBy?: string; hidden: string[];
  /** kanban: the single-select field that defines the columns */ stackBy?: string;
}
export interface Table { id: string; name: string; fields: Field[]; records: RecordRow[]; views: View[]; nextSeq: number }
export interface Base { format: "fusion-tables-1"; name: string; tables: Table[] }

export const PALETTE = ["#ffd166", "#06d6a0", "#4cc9f0", "#f78c6b", "#c77dff", "#ff8fab", "#90be6d", "#adb5bd"];

/* ------------------------------------------------------------------ ids */
let idCounter = 0;
/** Short unique ids; the random part keeps ids unique across sessions and merged bases. */
export const newId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/* ------------------------------------------------------------------ construction */
export function blankTable(name: string, id = newId("tbl")): Table {
  const primary: Field = { id: newId("fld"), name: "Name", type: "text" };
  return { id, name, fields: [primary], records: [], views: [defaultView(primary.id)], nextSeq: 1 };
}
export const defaultView = (_primary?: string, name = "Grid view"): View => ({ id: newId("viw"), name, kind: "grid", filters: [], conjunction: "and", sorts: [], hidden: [] });
export function blankBase(name = "Untitled base"): Base { return { format: "fusion-tables-1", name, tables: [blankTable("Table 1")] }; }

/* ------------------------------------------------------------------ lookup helpers */
export const tableById = (b: Base, id: string) => b.tables.find((t) => t.id === id);
export const fieldById = (t: Table, id: string) => t.fields.find((f) => f.id === id);
export const fieldByName = (t: Table, name: string) => t.fields.find((f) => f.name.toLowerCase() === name.toLowerCase());
const mapTable = (b: Base, id: string, fn: (t: Table) => Table): Base => ({ ...b, tables: b.tables.map((t) => (t.id === id ? fn(t) : t)) });
const asList = (v: Cell): string[] => (Array.isArray(v) ? v : v == null || v === "" ? [] : [String(v)]);

/* ------------------------------------------------------------------ validation of raw values */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Coerce user input into the stored representation for a field; `ok:false` means the value is refused. */
export function coerce(f: Field, input: unknown): { ok: true; value: Cell; addOptions?: string[] } | { ok: false; error: string } {
  if (input === null || input === undefined || input === "") return { ok: true, value: f.type === "checkbox" ? false : null };
  const s = typeof input === "string" ? input.trim() : input;
  switch (f.type) {
    case "text": case "longText": return { ok: true, value: f.type === "text" ? String(s).replace(/[\r\n]+/g, " ") : String(input) };
    case "number": {
      const n = typeof s === "number" ? s : Number(String(s).replace(/[, _]/g, "").replace(/^\$/, ""));
      if (!Number.isFinite(n)) return { ok: false, error: `“${String(s)}” is not a number` };
      const p = f.precision ?? 0; return { ok: true, value: Math.round(n * 10 ** p) / 10 ** p };
    }
    case "rating": {
      const n = Math.round(Number(s)); const max = f.max ?? 5;
      if (!Number.isFinite(n) || n < 0 || n > max) return { ok: false, error: `rating must be 0–${max}` };
      return { ok: true, value: n === 0 ? null : n };
    }
    case "checkbox": {
      if (typeof s === "boolean") return { ok: true, value: s };
      const t = String(s).toLowerCase();
      if (["true", "yes", "1", "x", "✓", "checked", "on"].includes(t)) return { ok: true, value: true };
      if (["false", "no", "0", "", "off", "unchecked"].includes(t)) return { ok: true, value: false };
      return { ok: false, error: `“${String(s)}” is not yes/no` };
    }
    case "date": {
      const t = String(s);
      if (ISO_DATE.test(t) && !Number.isNaN(Date.parse(t + "T00:00:00Z")) && new Date(t + "T00:00:00Z").toISOString().startsWith(t)) return { ok: true, value: t };
      const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t); // US m/d/yyyy, as Airtable's default locale
      if (m) { const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`; if (new Date(iso + "T00:00:00Z").toISOString().startsWith(iso)) return { ok: true, value: iso }; }
      return { ok: false, error: `“${t}” is not a date (use YYYY-MM-DD)` };
    }
    case "email": return EMAIL.test(String(s)) ? { ok: true, value: String(s) } : { ok: false, error: `“${String(s)}” is not an email address` };
    case "url": {
      const t = String(s); const u = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`;
      try { const p = new URL(u); if (!/^https?:$|^mailto:$/.test(p.protocol)) return { ok: false, error: "only http(s) and mailto links" }; return { ok: true, value: u }; }
      catch { return { ok: false, error: `“${t}” is not a URL` }; }
    }
    case "singleSelect": {
      const name = String(Array.isArray(s) ? s[0] ?? "" : s); if (!name) return { ok: true, value: null };
      const known = f.options?.find((o) => o.name.toLowerCase() === name.toLowerCase());
      return known ? { ok: true, value: known.name } : { ok: true, value: name, addOptions: [name] };
    }
    case "multiSelect": {
      const names = (Array.isArray(s) ? s.map(String) : String(s).split(",")).map((x) => x.trim()).filter(Boolean);
      const out: string[] = []; const add: string[] = [];
      for (const n of names) {
        const known = f.options?.find((o) => o.name.toLowerCase() === n.toLowerCase());
        // de-duplicate case-insensitively, including between two NEW spellings ("Blue", "blue")
        const v = known ? known.name : out.find((o) => o.toLowerCase() === n.toLowerCase()) ?? n;
        if (!out.includes(v)) out.push(v); if (!known && !add.some((a) => a.toLowerCase() === n.toLowerCase())) add.push(n);
      }
      return { ok: true, value: out.length ? out : null, addOptions: add };
    }
    case "link": return { ok: true, value: Array.isArray(s) ? [...new Set(s.map(String))] : asList(s as Cell) };
    default: return { ok: false, error: `${f.name} is computed and cannot be edited` };
  }
}

const withOptions = (f: Field, names: string[] | undefined): Field => {
  if (!names?.length) return f;
  const opts = [...(f.options ?? [])];
  for (const n of names) if (!opts.some((o) => o.name.toLowerCase() === n.toLowerCase())) opts.push({ name: n, color: PALETTE[opts.length % PALETTE.length] });
  return { ...f, options: opts };
};

/* ------------------------------------------------------------------ record operations */
export function addRecord(b: Base, tableId: string, cells: Record<string, unknown> = {}): { base: Base; id: string } {
  const id = newId("rec");
  let base = mapTable(b, tableId, (t) => ({ ...t, records: [...t.records, { id, cells: {}, seq: t.nextSeq }], nextSeq: t.nextSeq + 1 }));
  for (const [fid, v] of Object.entries(cells)) { const r = setCell(base, tableId, id, fid, v); if (!r.ok) throw new Error(r.error); base = r.base; }
  return { base, id };
}

/** Set one cell. Link cells also update the inverse link on the target table. */
export function setCell(b: Base, tableId: string, recId: string, fieldId: string, input: unknown): { ok: true; base: Base } | { ok: false; error: string } {
  const t = tableById(b, tableId); const f = t && fieldById(t, fieldId);
  if (!t || !f) return { ok: false, error: "no such field" };
  if (!t.records.some((r) => r.id === recId)) return { ok: false, error: "no such record" };
  const c = coerce(f, input);
  if (!c.ok) return c;
  if (f.type === "link") {
    const target = f.linkTable ? tableById(b, f.linkTable) : undefined;
    if (!target) return { ok: false, error: "link target table is missing" };
    const ids = (c.value as string[] | null) ?? [];
    const missing = ids.filter((id) => !target.records.some((r) => r.id === id));
    if (missing.length) return { ok: false, error: `unknown linked record(s): ${missing.join(", ")}` };
    return { ok: true, base: setLinks(b, t, f, recId, ids) };
  }
  let base = c.addOptions?.length ? mapTable(b, tableId, (tt) => ({ ...tt, fields: tt.fields.map((x) => (x.id === f.id ? withOptions(x, c.addOptions) : x)) })) : b;
  base = mapTable(base, tableId, (tt) => ({ ...tt, records: tt.records.map((r) => (r.id === recId ? { ...r, cells: { ...r.cells, [fieldId]: c.value } } : r)) }));
  return { ok: true, base };
}

function setLinks(b: Base, t: Table, f: Field, recId: string, ids: string[]): Base {
  const before = asList(t.records.find((r) => r.id === recId)!.cells[f.id] ?? null);
  const added = ids.filter((x) => !before.includes(x)), removed = before.filter((x) => !ids.includes(x));
  let base = mapTable(b, t.id, (tt) => ({ ...tt, records: tt.records.map((r) => (r.id === recId ? { ...r, cells: { ...r.cells, [f.id]: ids.length ? ids : null } } : r)) }));
  if (f.linkTable && f.inverseField) {
    const inv = f.inverseField; const self = f.linkTable === t.id && inv === f.id;
    if (!self) base = mapTable(base, f.linkTable, (tt) => ({
      ...tt, records: tt.records.map((r) => {
        if (!added.includes(r.id) && !removed.includes(r.id)) return r;
        const cur = asList(r.cells[inv] ?? null);
        const next = added.includes(r.id) ? (cur.includes(recId) ? cur : [...cur, recId]) : cur.filter((x) => x !== recId);
        return { ...r, cells: { ...r.cells, [inv]: next.length ? next : null } };
      }),
    }));
  }
  return base;
}

export function deleteRecords(b: Base, tableId: string, ids: string[]): Base {
  const gone = new Set(ids);
  let base = mapTable(b, tableId, (t) => ({ ...t, records: t.records.filter((r) => !gone.has(r.id)) }));
  // scrub every link cell anywhere that pointed at a deleted record
  base = { ...base, tables: base.tables.map((t) => {
    const links = t.fields.filter((f) => f.type === "link" && f.linkTable === tableId);
    if (!links.length) return t;
    return { ...t, records: t.records.map((r) => {
      let cells = r.cells;
      for (const f of links) { const cur = asList(r.cells[f.id] ?? null); if (cur.some((x) => gone.has(x))) { const n = cur.filter((x) => !gone.has(x)); cells = { ...cells, [f.id]: n.length ? n : null }; } }
      return cells === r.cells ? r : { ...r, cells };
    }) };
  }) };
  return base;
}

export function duplicateRecord(b: Base, tableId: string, recId: string): { base: Base; id: string } {
  const t = tableById(b, tableId)!; const src = t.records.find((r) => r.id === recId)!;
  const cells: Record<string, unknown> = {};
  for (const f of t.fields) if (!COMPUTED.includes(f.type) && src.cells[f.id] != null) cells[f.id] = src.cells[f.id];
  return addRecord(b, tableId, cells);
}

/* ------------------------------------------------------------------ field operations */
export function addField(b: Base, tableId: string, spec: Omit<Field, "id"> & { id?: string }): { base: Base; id: string } {
  const t = tableById(b, tableId); if (!t) throw new Error("no such table");
  const name = uniqueName(t, spec.name || "Field");
  const id = spec.id ?? newId("fld");
  const f: Field = { ...spec, id, name };
  if (f.type === "link") {
    const target = f.linkTable ? tableById(b, f.linkTable) : undefined; if (!target) throw new Error("link needs a target table");
    if (target.id === tableId) { f.inverseField = id; return { base: mapTable(b, tableId, (tt) => ({ ...tt, fields: [...tt.fields, f] })), id }; }
    const invId = newId("fld");
    f.inverseField = invId;
    const inv: Field = { id: invId, name: uniqueName(target, t.name), type: "link", linkTable: tableId, inverseField: id };
    let base = mapTable(b, tableId, (tt) => ({ ...tt, fields: [...tt.fields, f] }));
    base = mapTable(base, target.id, (tt) => ({ ...tt, fields: [...tt.fields, inv] }));
    return { base, id };
  }
  if (f.type === "singleSelect" || f.type === "multiSelect") f.options = f.options ?? [];
  if (f.type === "rating") f.max = f.max ?? 5;
  return { base: mapTable(b, tableId, (tt) => ({ ...tt, fields: [...tt.fields, f] })), id };
}

const uniqueName = (t: Table, name: string, except?: string) => {
  let n = name.trim() || "Field", i = 2;
  while (t.fields.some((f) => f.id !== except && f.name.toLowerCase() === n.toLowerCase())) n = `${name.trim()} ${i++}`;
  return n;
};

export function renameField(b: Base, tableId: string, fieldId: string, name: string): Base {
  const t = tableById(b, tableId)!; const old = fieldById(t, fieldId)!;
  const nn = uniqueName(t, name, fieldId);
  // keep formulas pointing at the renamed field: {Old} → {New}
  const re = new RegExp(`\\{${old.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}`, "gi");
  return mapTable(b, tableId, (tt) => ({ ...tt, fields: tt.fields.map((f) => (f.id === fieldId ? { ...f, name: nn } : f.type === "formula" && f.formula ? { ...f, formula: f.formula.replace(re, `{${nn}}`) } : f)) }));
}

export function updateField(b: Base, tableId: string, fieldId: string, patch: Partial<Omit<Field, "id" | "type" | "name">>): Base {
  return mapTable(b, tableId, (t) => ({ ...t, fields: t.fields.map((f) => (f.id === fieldId ? { ...f, ...patch } : f)) }));
}

/** Delete a field. The primary (first) field cannot be deleted; a link's inverse goes with it. */
export function deleteField(b: Base, tableId: string, fieldId: string): Base {
  const t = tableById(b, tableId)!;
  if (t.fields[0]?.id === fieldId) throw new Error("the primary field cannot be deleted");
  const f = fieldById(t, fieldId)!;
  const strip = (tt: Table, fid: string): Table => ({
    ...tt,
    fields: tt.fields.filter((x) => x.id !== fid).map((x) => ((x.viaField === fid || x.targetField === fid) ? { ...x, viaField: x.viaField === fid ? undefined : x.viaField, targetField: x.targetField === fid ? undefined : x.targetField } : x)),
    records: tt.records.map((r) => { if (!(fid in r.cells)) return r; const { [fid]: _drop, ...rest } = r.cells; void _drop; return { ...r, cells: rest }; }),
    views: tt.views.map((v) => ({ ...v, filters: v.filters.filter((x) => x.field !== fid), sorts: v.sorts.filter((x) => x.field !== fid), hidden: v.hidden.filter((x) => x !== fid), groupBy: v.groupBy === fid ? undefined : v.groupBy, stackBy: v.stackBy === fid ? undefined : v.stackBy })),
  });
  let base = mapTable(b, tableId, (tt) => strip(tt, fieldId));
  if (f.type === "link" && f.linkTable && f.inverseField && !(f.linkTable === tableId && f.inverseField === fieldId)) base = mapTable(base, f.linkTable, (tt) => strip(tt, f.inverseField!));
  // lookups on OTHER tables that targeted this field
  base = { ...base, tables: base.tables.map((tt) => ({ ...tt, fields: tt.fields.map((x) => (x.targetField === fieldId ? { ...x, targetField: undefined } : x)) })) };
  return base;
}

/**
 * Change a field's type, converting stored values. Returns how many non-empty cells could not be converted (those
 * are cleared). Link fields are not convertible in either direction (the relation would be lost) — refused.
 */
export function changeFieldType(b: Base, tableId: string, fieldId: string, type: FieldType, extra: Partial<Field> = {}): { base: Base; lost: number } {
  const t = tableById(b, tableId)!; const f = fieldById(t, fieldId)!;
  if (f.type === type) return { base: updateField(b, tableId, fieldId, extra), lost: 0 };
  if (f.type === "link" || type === "link") throw new Error("convert to/from a link by adding a new link field");
  if (t.fields[0]?.id === fieldId && COMPUTED.includes(type) && type !== "formula" && type !== "autonumber") throw new Error("the primary field cannot be a lookup/rollup/count");
  const shown = computeTable(b, tableId);
  let nf: Field = { ...f, ...extra, type };
  if ((type === "singleSelect" || type === "multiSelect")) {
    const names = new Set<string>(nf.options?.map((o) => o.name));
    for (const r of t.records) { const v = displayValue(f, shown.get(r.id)?.[fieldId] ?? null, b); for (const p of (type === "multiSelect" ? v.split(",") : [v])) if (p.trim()) names.add(p.trim()); }
    nf = { ...nf, options: [...names].map((n, i) => nf.options?.find((o) => o.name === n) ?? { name: n, color: PALETTE[i % PALETTE.length] }) };
  }
  if (type === "rating") nf.max = nf.max ?? 5;
  let lost = 0;
  const records = t.records.map((r) => {
    const { [fieldId]: _old, ...rest } = r.cells; void _old;
    if (COMPUTED.includes(type)) return { ...r, cells: rest };
    const raw = shown.get(r.id)?.[fieldId] ?? null;
    if (raw === null || raw === "" || (Array.isArray(raw) && !raw.length)) return { ...r, cells: rest };
    const src = f.type === "checkbox" ? (raw ? "true" : "") : displayValue(f, raw, b);
    if (src === "") return { ...r, cells: rest };
    const c = coerce(nf, type === "multiSelect" ? src : src);
    if (!c.ok) { lost++; return { ...r, cells: rest }; }
    return { ...r, cells: { ...rest, [fieldId]: c.value } };
  });
  return { base: mapTable(b, tableId, (tt) => ({ ...tt, fields: tt.fields.map((x) => (x.id === fieldId ? nf : x)), records })), lost };
}

/* ------------------------------------------------------------------ tables */
export function addTable(b: Base, name: string): { base: Base; id: string } {
  let n = name.trim() || "Table", i = 2; while (b.tables.some((t) => t.name.toLowerCase() === n.toLowerCase())) n = `${name.trim() || "Table"} ${i++}`;
  const t = blankTable(n); return { base: { ...b, tables: [...b.tables, t] }, id: t.id };
}
export function renameTable(b: Base, tableId: string, name: string): Base { return mapTable(b, tableId, (t) => ({ ...t, name: name.trim() || t.name })); }
export function deleteTable(b: Base, tableId: string): Base {
  if (b.tables.length <= 1) throw new Error("a base needs at least one table");
  // remove link fields elsewhere that pointed here (and their lookups lose their via)
  let base: Base = { ...b, tables: b.tables.filter((t) => t.id !== tableId) };
  for (const t of base.tables) for (const f of t.fields) if (f.type === "link" && f.linkTable === tableId) base = mapTable(base, t.id, (tt) => ({ ...tt, fields: tt.fields.filter((x) => x.id !== f.id).map((x) => (x.viaField === f.id ? { ...x, viaField: undefined } : x)), records: tt.records.map((r) => { const { [f.id]: _d, ...rest } = r.cells; void _d; return { ...r, cells: rest }; }) }));
  return base;
}

/* ------------------------------------------------------------------ views */
export function updateView(b: Base, tableId: string, viewId: string, patch: Partial<Omit<View, "id">>): Base {
  return mapTable(b, tableId, (t) => ({ ...t, views: t.views.map((v) => (v.id === viewId ? { ...v, ...patch } : v)) }));
}
export function addView(b: Base, tableId: string, kind: View["kind"], name?: string): { base: Base; id: string } {
  const t = tableById(b, tableId)!;
  const v = defaultView(undefined, name ?? (kind === "kanban" ? "Kanban" : `Grid view ${t.views.length + 1}`));
  v.kind = kind;
  if (kind === "kanban") v.stackBy = t.fields.find((f) => f.type === "singleSelect")?.id;
  return { base: mapTable(b, tableId, (tt) => ({ ...tt, views: [...tt.views, v] })), id: v.id };
}
export function deleteView(b: Base, tableId: string, viewId: string): Base {
  const t = tableById(b, tableId)!; if (t.views.length <= 1) throw new Error("a table needs at least one view");
  return mapTable(b, tableId, (tt) => ({ ...tt, views: tt.views.filter((v) => v.id !== viewId) }));
}

/* ================================================================== formulas */
type Tok = { k: "num"; v: number } | { k: "str"; v: string } | { k: "ref"; v: string } | { k: "id"; v: string } | { k: "op"; v: string };
export type FVal = number | string | boolean | null | FVal[];
export class FormulaError extends Error {}

function lex(src: string): Tok[] {
  const out: Tok[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "{") { const j = src.indexOf("}", i); if (j < 0) throw new FormulaError("unclosed {field}"); out.push({ k: "ref", v: src.slice(i + 1, j) }); i = j + 1; continue; }
    if (c === '"' || c === "'") { let j = i + 1, s = ""; while (j < src.length && src[j] !== c) { if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; } else s += src[j++]; } if (j >= src.length) throw new FormulaError("unclosed string"); out.push({ k: "str", v: s }); i = j + 1; continue; }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i)); if (num) { out.push({ k: "num", v: Number(num[0]) }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i)); if (id) { out.push({ k: "id", v: id[0].toUpperCase() }); i += id[0].length; continue; }
    const op = /^(<=|>=|!=|<>|[-+*/&=<>(),%])/.exec(src.slice(i)); if (op) { out.push({ k: "op", v: op[0] === "<>" ? "!=" : op[0] }); i += op[0].length; continue; }
    throw new FormulaError(`unexpected “${c}”`);
  }
  return out;
}
export type Node =
  | { t: "lit"; v: FVal } | { t: "ref"; name: string } | { t: "call"; fn: string; args: Node[] }
  | { t: "bin"; op: string; a: Node; b: Node } | { t: "neg"; a: Node };
export function parseFormula(src: string): Node {
  const toks = lex(src); let p = 0;
  const peek = () => toks[p]; const isOp = (v: string) => peek()?.k === "op" && (peek() as { v: string }).v === v;
  const expect = (v: string) => { if (!isOp(v)) throw new FormulaError(`expected “${v}”`); p++; };
  const LEVELS = [["=", "!=", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/", "%"]];
  const level = (n: number): Node => {
    if (n >= LEVELS.length) return unary();
    let a = level(n + 1);
    while (peek()?.k === "op" && LEVELS[n].includes((peek() as { v: string }).v)) { const op = (toks[p++] as { v: string }).v; a = { t: "bin", op, a, b: level(n + 1) }; }
    return a;
  };
  const unary = (): Node => { if (isOp("-")) { p++; return { t: "neg", a: unary() }; } if (isOp("+")) { p++; return unary(); } return primary(); };
  const primary = (): Node => {
    const tk = toks[p++]; if (!tk) throw new FormulaError("unexpected end of formula");
    if (tk.k === "num" || tk.k === "str") return { t: "lit", v: tk.v };
    if (tk.k === "ref") return { t: "ref", name: tk.v };
    if (tk.k === "id") {
      if (tk.v === "TRUE" && !isOp("(")) return { t: "lit", v: true };
      if (tk.v === "FALSE" && !isOp("(")) return { t: "lit", v: false };
      expect("("); const args: Node[] = [];
      if (!isOp(")")) { do { args.push(level(0)); } while (isOp(",") && ++p); }
      expect(")");
      if (!(tk.v in FUNCS)) throw new FormulaError(`unknown function ${tk.v}()`);
      return { t: "call", fn: tk.v, args };
    }
    if (tk.k === "op" && tk.v === "(") { const e = level(0); expect(")"); return e; }
    throw new FormulaError(`unexpected “${tk.v}”`);
  };
  const e = level(0); if (p < toks.length) throw new FormulaError(`unexpected “${(toks[p] as { v: unknown }).v}”`);
  return e;
}
export function formulaRefs(n: Node, out = new Set<string>()): Set<string> {
  if (n.t === "ref") out.add(n.name.toLowerCase());
  else if (n.t === "call") n.args.forEach((a) => formulaRefs(a, out));
  else if (n.t === "bin") { formulaRefs(n.a, out); formulaRefs(n.b, out); } else if (n.t === "neg") formulaRefs(n.a, out);
  return out;
}

const flat = (v: FVal): FVal[] => (Array.isArray(v) ? v.flatMap(flat) : [v]);
const num = (v: FVal): number => { if (Array.isArray(v)) return flat(v).reduce<number>((s, x) => s + num(x), 0); if (typeof v === "number") return v; if (typeof v === "boolean") return v ? 1 : 0; if (v === null || v === "") return 0; const n = Number(v); if (Number.isNaN(n)) throw new FormulaError(`“${v}” is not a number`); return n; };
export const str = (v: FVal): string => (Array.isArray(v) ? flat(v).map(str).join(", ") : v === null ? "" : typeof v === "boolean" ? (v ? "true" : "false") : typeof v === "number" ? String(Math.round(v * 1e10) / 1e10) : v);
const truthy = (v: FVal): boolean => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v !== "" : Boolean(v));
const nums = (args: FVal[]) => args.flatMap(flat).filter((x) => x !== null && x !== "").map(num);
const day = (v: FVal) => { const s = str(v); const t = Date.parse(ISO_DATE.test(s) ? s + "T00:00:00Z" : s); if (Number.isNaN(t)) throw new FormulaError(`“${s}” is not a date`); return t; };
const FUNCS: Record<string, (a: FVal[], lazy?: never) => FVal> = {
  SUM: (a) => nums(a).reduce((s, x) => s + x, 0),
  AVERAGE: (a) => { const n = nums(a); return n.length ? n.reduce((s, x) => s + x, 0) / n.length : 0; },
  MIN: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; }, MAX: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; },
  COUNT: (a) => a.flatMap(flat).filter((x) => typeof x === "number").length,
  COUNTA: (a) => a.flatMap(flat).filter((x) => x !== null && x !== "").length,
  ROUND: (a) => { const p = a[1] === undefined ? 0 : num(a[1]); const f = 10 ** p; return Math.round(num(a[0]) * f + Math.sign(num(a[0])) * 1e-9) / f; },
  ABS: (a) => Math.abs(num(a[0])), INT: (a) => Math.floor(num(a[0])), MOD: (a) => { const d = num(a[1]); if (d === 0) throw new FormulaError("division by zero"); return num(a[0]) % d; },
  IF: (a) => (truthy(a[0]) ? a[1] ?? null : a[2] ?? null),
  AND: (a) => a.flatMap(flat).every(truthy), OR: (a) => a.flatMap(flat).some(truthy), NOT: (a) => !truthy(a[0]),
  BLANK: () => null, ISBLANK: (a) => a[0] === null || a[0] === "" || (Array.isArray(a[0]) && a[0].length === 0),
  CONCATENATE: (a) => a.map(str).join(""), LEN: (a) => str(a[0]).length, UPPER: (a) => str(a[0]).toUpperCase(), LOWER: (a) => str(a[0]).toLowerCase(),
  TRIM: (a) => str(a[0]).trim(), LEFT: (a) => str(a[0]).slice(0, Math.max(0, num(a[1] ?? 1))), RIGHT: (a) => { const s = str(a[0]); const n = Math.max(0, num(a[1] ?? 1)); return n ? s.slice(-n) : ""; },
  FIND: (a) => str(a[1]).indexOf(str(a[0])) + 1, SUBSTITUTE: (a) => str(a[0]).split(str(a[1])).join(str(a[2])),
  ARRAYJOIN: (a) => flat(a[0] ?? null).map(str).filter(Boolean).join(a[1] === undefined ? ", " : str(a[1])),
  DATETIME_DIFF: (a) => { const ms = day(a[0]) - day(a[1]); const u = str(a[2] ?? "days").toLowerCase(); const div = u.startsWith("week") ? 6048e5 : u.startsWith("hour") ? 36e5 : 864e5; return Math.trunc(ms / div); },
  DATEADD: (a) => { const d = new Date(day(a[0])); const n = num(a[1]); const u = str(a[2] ?? "days").toLowerCase(); if (u.startsWith("month")) d.setUTCMonth(d.getUTCMonth() + n); else if (u.startsWith("year")) d.setUTCFullYear(d.getUTCFullYear() + n); else d.setUTCDate(d.getUTCDate() + n * (u.startsWith("week") ? 7 : 1)); return d.toISOString().slice(0, 10); },
  YEAR: (a) => new Date(day(a[0])).getUTCFullYear(), MONTH: (a) => new Date(day(a[0])).getUTCMonth() + 1, DAY: (a) => new Date(day(a[0])).getUTCDate(),
  VALUE: (a) => num(str(a[0]).replace(/[,$\s]/g, "")),
};
export const FORMULA_FUNCTIONS = Object.keys(FUNCS);

function evalNode(n: Node, ref: (name: string) => FVal): FVal {
  switch (n.t) {
    case "lit": return n.v;
    case "ref": return ref(n.name);
    case "neg": return -num(evalNode(n.a, ref));
    case "call": {
      if (n.fn === "IF") { const c = evalNode(n.args[0] ?? { t: "lit", v: null }, ref); return truthy(c) ? (n.args[1] ? evalNode(n.args[1], ref) : null) : (n.args[2] ? evalNode(n.args[2], ref) : null); }
      return FUNCS[n.fn](n.args.map((a) => evalNode(a, ref)));
    }
    case "bin": {
      const a = evalNode(n.a, ref), b = evalNode(n.b, ref);
      switch (n.op) {
        case "+": return num(a) + num(b); case "-": return num(a) - num(b); case "*": return num(a) * num(b);
        case "/": { const d = num(b); if (d === 0) throw new FormulaError("division by zero"); return num(a) / d; }
        case "%": { const d = num(b); if (d === 0) throw new FormulaError("division by zero"); return num(a) % d; }
        case "&": return str(a) + str(b);
        default: {
          const both = typeof a === "number" || typeof b === "number" ? [num(a), num(b)] : [str(a).toLowerCase(), str(b).toLowerCase()];
          const [x, y] = both as [number | string, number | string];
          return n.op === "=" ? x === y : n.op === "!=" ? x !== y : n.op === "<" ? x < y : n.op === ">" ? x > y : n.op === "<=" ? x <= y : x >= y;
        }
      }
    }
  }
}

/* ================================================================== computation */
export type Computed = Map<string, Record<string, Cell | FVal>>;
export const ERR = (m: string) => `#ERROR: ${m}`;
export const isErr = (v: unknown): boolean => typeof v === "string" && (v.startsWith("#ERROR") || v === "#CYCLE");

/** Derive every cell (stored + computed) for a table. Lookups/rollups read the target table's computed values. */
export function computeTable(b: Base, tableId: string, depth = 0): Computed {
  const t = tableById(b, tableId)!; const out: Computed = new Map();
  if (depth > 4) { for (const r of t.records) out.set(r.id, { ...r.cells }); return out; } // guards lookup chains across tables
  const targets = new Map<string, Computed>();
  const targetComputed = (tid: string) => { if (!targets.has(tid)) targets.set(tid, tid === tableId ? new Map(t.records.map((r) => [r.id, { ...r.cells }])) : computeTable(b, tid, depth + 1)); return targets.get(tid)!; };
  const parsed = new Map<string, Node | FormulaError>();
  for (const f of t.fields) if (f.type === "formula") { try { parsed.set(f.id, parseFormula(f.formula ?? "")); } catch (e) { parsed.set(f.id, e as FormulaError); } }
  for (const r of t.records) {
    const row: Record<string, Cell | FVal> = { ...r.cells };
    for (const f of t.fields) {
      if (f.type === "autonumber") row[f.id] = r.seq;
      else if (f.type === "count") { const via = f.viaField ? fieldById(t, f.viaField) : undefined; row[f.id] = via ? asList(r.cells[via.id] ?? null).length : ERR("choose a link field"); }
      else if (f.type === "lookup" || f.type === "rollup") {
        const via = f.viaField ? fieldById(t, f.viaField) : undefined; const tt = via?.linkTable ? tableById(b, via.linkTable) : undefined; const tf = tt && f.targetField ? fieldById(tt, f.targetField) : undefined;
        if (!via || !tt || !tf) { row[f.id] = ERR("choose a link and a field"); continue; }
        const tc = targetComputed(tt.id);
        const vals: FVal[] = asList(r.cells[via.id] ?? null).flatMap((rid) => { const v = tc.get(rid)?.[tf.id]; return v === undefined || v === null || v === "" ? [] : Array.isArray(v) && tf.type === "link" ? [v.map((x) => primaryText(b, tf.linkTable!, String(x)))] : [v as FVal]; }).flatMap((v) => (Array.isArray(v) ? v : [v]));
        row[f.id] = f.type === "lookup" ? vals : rollupOf(f.rollup ?? "sum", vals);
      }
    }
    // formulas last, in dependency order with cycle detection (they may reference lookups/rollups)
    const state = new Map<string, "busy" | "done">();
    const byName = new Map(t.fields.map((f) => [f.name.toLowerCase(), f]));
    const evalField = (f: Field): FVal => {
      if (f.type !== "formula") { const v = row[f.id]; return f.type === "link" ? asList((v ?? null) as Cell).map((id) => primaryText(b, f.linkTable!, id)) : (v === undefined ? null : v as FVal); }
      if (state.get(f.id) === "done") return row[f.id] as FVal;
      if (state.get(f.id) === "busy") throw new FormulaError("#CYCLE");
      state.set(f.id, "busy");
      let v: FVal;
      const p = parsed.get(f.id)!;
      try {
        if (p instanceof FormulaError) throw p;
        v = evalNode(p, (name) => { const rf = byName.get(name.toLowerCase()); if (!rf) throw new FormulaError(`unknown field {${name}}`); const x = evalField(rf); if (isErr(x)) throw new FormulaError(x === "#CYCLE" ? "#CYCLE" : String(x).replace(/^#ERROR: /, "")); return x; });
        if (typeof v === "number" && !Number.isFinite(v)) throw new FormulaError("not a finite number");
      } catch (e) { const m = (e as Error).message; v = m === "#CYCLE" ? "#CYCLE" : ERR(m); }
      row[f.id] = v; state.set(f.id, "done"); return v;
    };
    for (const f of t.fields) if (f.type === "formula") evalField(f);
    out.set(r.id, row);
  }
  return out;
}

function rollupOf(fn: RollupFn, vals: FVal[]): FVal {
  const n = () => vals.map((v) => (typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : Number(v))).filter((x) => Number.isFinite(x));
  switch (fn) {
    case "sum": return n().reduce((s, x) => s + x, 0);
    case "avg": { const a = n(); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
    case "min": { const a = n(); return a.length ? Math.min(...a) : null; }
    case "max": { const a = n(); return a.length ? Math.max(...a) : null; }
    case "count": return n().length;
    case "counta": return vals.filter((v) => v !== null && v !== "").length;
    case "concat": return vals.map(str).join(", ");
    case "and": return vals.length > 0 && vals.every(truthy);
    case "or": return vals.some(truthy);
  }
}

/** The primary-field text of a record (what a link chip shows). */
export function primaryText(b: Base, tableId: string, recId: string): string {
  const t = tableById(b, tableId); const r = t?.records.find((x) => x.id === recId);
  if (!t || !r) return "(deleted)";
  const pf = t.fields[0]; const v = pf.type === "formula" || pf.type === "autonumber" ? computeTable(b, tableId).get(recId)?.[pf.id] : r.cells[pf.id];
  return v === null || v === undefined || v === "" ? "Unnamed record" : str(v as FVal);
}

/** Text shown in a cell / used for search, CSV export and grouping. */
export function displayValue(f: Field, v: Cell | FVal | undefined, b?: Base): string {
  if (v === null || v === undefined) return "";
  if (f.type === "checkbox") return v ? "checked" : "";
  if (f.type === "link") return asList(v as Cell).map((id) => (b && f.linkTable ? primaryText(b, f.linkTable, id) : id)).join(", ");
  if (f.type === "number" && typeof v === "number") return v.toFixed(f.precision ?? 0);
  if (f.type === "rollup" && typeof v === "number") return String(Math.round(v * 1e6) / 1e6);
  return str(v as FVal);
}

/* ------------------------------------------------------------------ views: filter / sort / group */
const cmpVal = (f: Field | undefined, a: Cell | FVal | undefined, b: Cell | FVal | undefined, base?: Base): number => {
  const ea = a === null || a === undefined || a === "" || (Array.isArray(a) && !a.length), eb = b === null || b === undefined || b === "" || (Array.isArray(b) && !b.length);
  if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1; // empties last, whatever the direction (as Airtable does)
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" || typeof b === "boolean") return Number(Boolean(a)) - Number(Boolean(b));
  if (f?.type === "singleSelect" && f.options) { const ia = f.options.findIndex((o) => o.name === a), ib = f.options.findIndex((o) => o.name === b); if (ia >= 0 && ib >= 0) return ia - ib; }
  if (f?.type === "rating") return Number(a) - Number(b);
  const sa = f ? displayValue(f, a, base) : String(a), sb = f ? displayValue(f, b, base) : String(b);
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: "base" });
};

export function matchFilter(f: Field, flt: Filter, v: Cell | FVal | undefined, b?: Base): boolean {
  const text = displayValue(f, v, b).toLowerCase(); const q = (flt.value ?? "").toLowerCase();
  const empty = text === "";
  const numeric = typeof v === "number" || f.type === "number" || f.type === "rating" || f.type === "autonumber" || f.type === "count";
  switch (flt.op) {
    case "isEmpty": return empty; case "isNotEmpty": return !empty;
    case "contains": return text.includes(q); case "notContains": return !text.includes(q);
    case "is": return f.type === "checkbox" ? Boolean(v) === ["true", "checked", "1", "yes"].includes(q) : numeric && q !== "" ? Number(v) === Number(q) : f.type === "multiSelect" || f.type === "lookup" ? asList(v as Cell).some((x) => String(x).toLowerCase() === q) : text === q;
    case "isNot": return !matchFilter(f, { ...flt, op: "is" }, v, b);
    case "hasAny": { const want = q.split(",").map((x) => x.trim()).filter(Boolean); const have = (Array.isArray(v) ? v.map((x) => str(x as FVal)) : [text]).map((x) => x.toLowerCase()); return want.some((w) => have.includes(w)); }
    case "gt": case "lt": case "gte": case "lte": {
      if (empty || q === "") return false;
      const [x, y] = numeric ? [Number(v), Number(q)] : [text, q];
      return flt.op === "gt" ? x > y : flt.op === "lt" ? x < y : flt.op === "gte" ? x >= y : x <= y;
    }
  }
}

export interface ViewResult { rows: string[]; groups: { key: string; rows: string[] }[] | null; computed: Computed }
export function runView(b: Base, tableId: string, view: View, search = ""): ViewResult {
  const t = tableById(b, tableId)!; const computed = computeTable(b, tableId);
  let ids = t.records.map((r) => r.id);
  const active = view.filters.filter((x) => fieldById(t, x.field));
  if (active.length) ids = ids.filter((id) => { const row = computed.get(id)!; const res = active.map((x) => matchFilter(fieldById(t, x.field)!, x, row[x.field], b)); return view.conjunction === "or" ? res.some(Boolean) : res.every(Boolean); });
  const q = search.trim().toLowerCase();
  if (q) ids = ids.filter((id) => t.fields.some((f) => !view.hidden.includes(f.id) && displayValue(f, computed.get(id)![f.id], b).toLowerCase().includes(q)));
  const sorts = view.sorts.filter((s) => fieldById(t, s.field));
  const seq = new Map(t.records.map((r) => [r.id, r.seq]));
  const groupField = view.groupBy ? fieldById(t, view.groupBy) : undefined;
  const allSorts: Sort[] = groupField ? [{ field: groupField.id, dir: "asc" }, ...sorts] : sorts;
  ids = [...ids].sort((x, y) => {
    for (const s of allSorts) {
      const f = fieldById(t, s.field); const c = cmpVal(f, computed.get(x)![s.field], computed.get(y)![s.field], b);
      const ex = computed.get(x)![s.field], ey = computed.get(y)![s.field];
      const emptyInvolved = [ex, ey].some((v) => v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length));
      if (c !== 0) return s.dir === "desc" && !emptyInvolved ? -c : c;
    }
    return seq.get(x)! - seq.get(y)!; // stable: creation order
  });
  let groups: ViewResult["groups"] = null;
  if (groupField) {
    groups = [];
    for (const id of ids) { const key = displayValue(groupField, computed.get(id)![groupField.id], b) || "(empty)"; const g = groups.at(-1); if (g && g.key === key) g.rows.push(id); else groups.push({ key, rows: [id] }); }
  }
  return { rows: ids, groups, computed };
}

/** Kanban columns: one per option of the stack field (in option order), plus "Uncategorized" first. */
export function kanbanColumns(b: Base, tableId: string, view: View, search = ""): { key: string | null; label: string; color?: string; rows: string[] }[] {
  const t = tableById(b, tableId)!; const f = view.stackBy ? fieldById(t, view.stackBy) : undefined;
  if (!f || f.type !== "singleSelect") return [];
  const { rows, computed } = runView(b, tableId, { ...view, groupBy: undefined }, search);
  const cols: { key: string | null; label: string; color?: string; rows: string[] }[] = [{ key: null, label: "Uncategorized", rows: [] }, ...(f.options ?? []).map((o) => ({ key: o.name, label: o.name, color: o.color, rows: [] as string[] }))];
  for (const id of rows) { const v = computed.get(id)![f.id]; (cols.find((c) => c.key === (v ?? null)) ?? cols[0]).rows.push(id); }
  return cols;
}

/** Summary row for a field over the visible rows (grid footer). */
export function summarize(f: Field, rows: string[], computed: Computed): string {
  const vals = rows.map((id) => computed.get(id)![f.id]);
  const filled = vals.filter((v) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length) && v !== false);
  if (["number", "rating", "rollup", "count", "autonumber"].includes(f.type) || (f.type === "formula" && filled.length && filled.every((v) => typeof v === "number"))) {
    const n = filled.filter((v) => typeof v === "number") as number[];
    if (!n.length) return "";
    const sum = n.reduce((s, x) => s + x, 0);
    return `Sum ${Math.round(sum * 1e6) / 1e6}`;
  }
  if (f.type === "checkbox") return `${filled.length} checked`;
  return `${filled.length} filled`;
}

/* ================================================================== CSV */
/** RFC 4180 parse: quoted fields, doubled quotes, CRLF/LF, embedded newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let q = false; let i = 0;
  const s = text.replace(/^\uFEFF/, "");
  while (i < s.length) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; } cell += c; i++; continue; }
    if (c === '"' && cell === "") { q = true; i++; continue; }
    if (c === ",") { row.push(cell); cell = ""; i++; continue; }
    if (c === "\r" || c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i += c === "\r" && s[i + 1] === "\n" ? 2 : 1; continue; }
    cell += c; i++;
  }
  if (q) throw new Error("unterminated quoted field");
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csvCell = (s: string) => {
  // formula-injection guard (OWASP): cells starting with = + - @ tab CR are prefixed with ' when exported
  // plain numbers ("-3", "+1.5") are data, not formulas — prefixing them would corrupt numeric columns
  const safe = /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function toCsv(b: Base, tableId: string, view?: View): string {
  const t = tableById(b, tableId)!; const v = view ?? t.views[0];
  const fields = t.fields.filter((f) => !v.hidden.includes(f.id));
  const { rows, computed } = runView(b, tableId, v);
  const lines = [fields.map((f) => csvCell(f.name)).join(",")];
  for (const id of rows) lines.push(fields.map((f) => csvCell(f.type === "checkbox" ? (computed.get(id)![f.id] ? "true" : "false") : displayValue(f, computed.get(id)![f.id], b))).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Infer a field type from a column of strings (all non-empty values must agree). */
export function inferType(values: string[]): FieldType {
  const v = values.map((x) => x.trim()).filter(Boolean);
  if (!v.length) return "text";
  if (v.every((x) => /^-?\$?[\d,]*\.?\d+$/.test(x) && Number.isFinite(Number(x.replace(/[$,]/g, ""))))) return "number";
  if (v.every((x) => /^(true|false|yes|no|checked|unchecked)$/i.test(x))) return "checkbox";
  if (v.every((x) => ISO_DATE.test(x) || /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(x))) return "date";
  if (v.every((x) => EMAIL.test(x))) return "email";
  if (v.every((x) => /^https?:\/\/\S+$/i.test(x))) return "url";
  const distinct = new Set(v.map((x) => x.toLowerCase()));
  if (v.length >= 4 && distinct.size <= Math.max(2, Math.floor(v.length / 3)) && [...distinct].every((x) => x.length <= 30)) return "singleSelect";
  if (v.some((x) => /\n/.test(x) || x.length > 120)) return "longText";
  return "text";
}

/** Import CSV as a new table: header row → field names, types inferred, values coerced (refusals reported). */
export function importCsv(b: Base, name: string, text: string): { base: Base; id: string; rejected: number; rows: number } {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (!rows.length) throw new Error("the CSV is empty");
  const header = rows[0].map((h, i) => h.trim() || `Field ${i + 1}`);
  const body = rows.slice(1);
  let { base, id } = addTable(b, name);
  const t0 = tableById(base, id)!;
  const fieldIds: string[] = [];
  header.forEach((h, i) => {
    const type = inferType(body.map((r) => (r[i] ?? "").replace(/^'(?=[=+\-@])/, "")));
    if (i === 0) { base = renameField(base, id, t0.fields[0].id, h); if (type !== "text") base = changeFieldType(base, id, t0.fields[0].id, type === "singleSelect" ? "text" : type).base; fieldIds.push(t0.fields[0].id); return; }
    const r = addField(base, id, { name: h, type, precision: type === "number" ? Math.min(4, Math.max(0, ...body.map((row) => ((row[i] ?? "").split(".")[1] ?? "").length))) : undefined });
    base = r.base; fieldIds.push(r.id);
  });
  let rejected = 0;
  for (const r of body) {
    const a = addRecord(base, id); base = a.base;
    fieldIds.forEach((fid, i) => { const v = r[i] ?? ""; if (v === "") return; const s = setCell(base, id, a.id, fid, v.replace(/^'(?=[=+\-@])/, "")); if (s.ok) base = s.base; else rejected++; });
  }
  return { base, id, rejected, rows: body.length };
}

/* ================================================================== (de)serialisation */
/** Validate a parsed .ftable document; throws with a message on anything structurally wrong. */
export function loadBase(json: unknown): Base {
  const b = json as Base;
  if (!b || b.format !== "fusion-tables-1" || !Array.isArray(b.tables) || !b.tables.length) throw new Error("not a Fusion Tables base (format fusion-tables-1)");
  for (const t of b.tables) {
    if (typeof t.id !== "string" || !Array.isArray(t.fields) || !t.fields.length || !Array.isArray(t.records)) throw new Error(`table ${t.name ?? "?"} is malformed`);
    if (!Array.isArray(t.views) || !t.views.length) t.views = [defaultView()];
    if (typeof t.nextSeq !== "number") t.nextSeq = t.records.reduce((m, r) => Math.max(m, r.seq ?? 0), 0) + 1;
    for (const f of t.fields) if (!FIELD_TYPES.some((x) => x.id === f.type)) throw new Error(`unknown field type ${String(f.type)}`);
  }
  return b;
}

/** Sample base used when the module opens without a file. */
export function sampleBase(): Base {
  let b: Base = { format: "fusion-tables-1", name: "Launch plan", tables: [blankTable("Tasks"), blankTable("People")] };
  const [tasks, people] = b.tables.map((t) => t.id);
  const pName = b.tables[1].fields[0].id, tName = b.tables[0].fields[0].id;
  let r = addField(b, people, { name: "Email", type: "email" }); b = r.base; const email = r.id;
  r = addField(b, people, { name: "Rate", type: "number", precision: 0 }); b = r.base; const rate = r.id;
  r = addField(b, tasks, { name: "Status", type: "singleSelect", options: [{ name: "Todo", color: PALETTE[0] }, { name: "Doing", color: PALETTE[2] }, { name: "Done", color: PALETTE[1] }] }); b = r.base; const status = r.id;
  r = addField(b, tasks, { name: "Owner", type: "link", linkTable: people }); b = r.base; const owner = r.id;
  r = addField(b, tasks, { name: "Hours", type: "number", precision: 1 }); b = r.base; const hours = r.id;
  r = addField(b, tasks, { name: "Due", type: "date" }); b = r.base; const due = r.id;
  r = addField(b, tasks, { name: "Owner rate", type: "lookup", viaField: owner, targetField: rate }); b = r.base;
  r = addField(b, tasks, { name: "Cost", type: "formula", formula: "{Hours} * SUM({Owner rate})" }); b = r.base;
  const ppl: string[] = [];
  for (const [n, e, rt] of [["Ana", "ana@example.com", 80], ["Bo", "bo@example.com", 65], ["Cy", "cy@example.com", 95]] as const) { const a = addRecord(b, people, { [pName]: n, [email]: e, [rate]: rt }); b = a.base; ppl.push(a.id); }
  const rows: [string, string, number, number, string][] = [["Write brief", "Done", 0, 3, "2026-10-01"], ["Design poolside theme", "Doing", 1, 6.5, "2026-10-20"], ["Accessibility pass", "Doing", 2, 4, "2026-10-22"], ["Ship release", "Todo", 0, 2, "2026-10-30"]];
  for (const [n, s, o, h, d] of rows) { const a = addRecord(b, tasks, { [tName]: n, [status]: s, [owner]: [ppl[o]], [hours]: h, [due]: d }); b = a.base; }
  const peopleT = tableById(b, people)!;
  r = addField(b, people, { name: "Open hours", type: "rollup", viaField: peopleT.fields.find((f) => f.type === "link")!.id, targetField: hours, rollup: "sum" }); b = r.base;
  r = addView(b, tasks, "kanban", "Board"); b = r.base;
  return b;
}
