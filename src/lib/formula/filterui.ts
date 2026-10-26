/**
 * TT76 — the AutoFilter "Condition" dialog's model (pure; the Spreadsheet filter panel renders it).
 *
 * Mirrors Excel's filter menu: Custom AutoFilter (two rules joined by And/Or; "begins with / ends with / contains" and
 * their negations are stored as `*` wildcard equal / notEqual rules, exactly as Excel writes them), Top 10 (items or
 * percent, top or bottom), Above / Below Average, Date Filters (every ECMA-376 dynamic type), Filter by Colour (cell
 * fill or font colour, conditional-format colours included) and Filter by Icon. `draftToCrit` validates — the dialog's
 * OK stays disabled while it returns an error string, so Enter on an untouched dialog never hides every row.
 */
import type { ColumnCrit, CustomOp, DynamicType } from "./filtereval";
import { DYNAMIC_TYPES } from "./filtereval";
import { ICON_SETS, type IconGlyph } from "./cficons";

export type UiOp = "eq" | "ne" | "gt" | "ge" | "lt" | "le" | "bw" | "nbw" | "ew" | "new" | "ct" | "nct";
export const UI_OPS: readonly [UiOp, string][] = [
  ["eq", "equals"], ["ne", "does not equal"], ["gt", "is greater than"], ["ge", "is greater than or equal to"],
  ["lt", "is less than"], ["le", "is less than or equal to"], ["bw", "begins with"], ["nbw", "does not begin with"],
  ["ew", "ends with"], ["new", "does not end with"], ["ct", "contains"], ["nct", "does not contain"],
];
export type CondMode = "custom" | "top10" | "average" | "date" | "color" | "icon";
export const DATE_LABELS: Record<string, string> = {
  today: "Today", yesterday: "Yesterday", tomorrow: "Tomorrow", thisWeek: "This week", lastWeek: "Last week", nextWeek: "Next week",
  thisMonth: "This month", lastMonth: "Last month", nextMonth: "Next month", thisQuarter: "This quarter", lastQuarter: "Last quarter",
  nextQuarter: "Next quarter", thisYear: "This year", lastYear: "Last year", nextYear: "Next year", yearToDate: "Year to date",
  Q1: "Quarter 1", Q2: "Quarter 2", Q3: "Quarter 3", Q4: "Quarter 4",
  M1: "January", M2: "February", M3: "March", M4: "April", M5: "May", M6: "June", M7: "July", M8: "August", M9: "September", M10: "October", M11: "November", M12: "December",
};
export const DATE_CHOICES = DYNAMIC_TYPES.filter((t) => t in DATE_LABELS) as DynamicType[];

export interface CondDraft {
  mode: CondMode;
  op1: UiOp; v1: string; and: boolean; op2: UiOp | ""; v2: string;
  top: boolean; n: string; pct: boolean;
  above: boolean;
  date: DynamicType;
  cell: boolean; color: string | null | undefined; // undefined = nothing picked yet
  icon: number; // index into the column's icon options, -1 = none picked
}
export const emptyDraft = (): CondDraft => ({ mode: "custom", op1: "eq", v1: "", and: true, op2: "", v2: "", top: true, n: "10", pct: false, above: true, date: "thisMonth", cell: true, color: undefined, icon: -1 });

const OPS: Record<"eq" | "ne" | "gt" | "ge" | "lt" | "le", CustomOp> = { eq: "equal", ne: "notEqual", gt: "greaterThan", ge: "greaterThanOrEqual", lt: "lessThan", le: "lessThanOrEqual" };
/** One dialog rule → the stored customFilter (Excel's encoding: wildcards for the text operators). */
export function uiRule(op: UiOp, v: string): { op: CustomOp; val: string } {
  switch (op) {
    case "bw": return { op: "equal", val: `${v}*` };
    case "nbw": return { op: "notEqual", val: `${v}*` };
    case "ew": return { op: "equal", val: `*${v}` };
    case "new": return { op: "notEqual", val: `*${v}` };
    case "ct": return { op: "equal", val: `*${v}*` };
    case "nct": return { op: "notEqual", val: `*${v}*` };
    default: return { op: OPS[op], val: v };
  }
}
/** The stored rule → the dialog's operator + text (inverse of uiRule; a rule with inner wildcards stays equals / does not equal). */
export function ruleUi(r: { op: CustomOp; val: string }): { op: UiOp; v: string } {
  const lead = r.val.startsWith("*") && r.val.length > 1, trail = /(^|[^~])\*$/.test(r.val) && r.val.length > 1;
  const inner = (s: string) => /(^|[^~])[*?]/.test(s);
  if (r.op === "equal" || r.op === "notEqual") {
    const neg = r.op === "notEqual";
    if (lead && trail && r.val.length > 2 && !inner(r.val.slice(1, -1))) return { op: neg ? "nct" : "ct", v: r.val.slice(1, -1) };
    if (trail && !lead && !inner(r.val.slice(0, -1))) return { op: neg ? "nbw" : "bw", v: r.val.slice(0, -1) };
    if (lead && !trail && !inner(r.val.slice(1))) return { op: neg ? "new" : "ew", v: r.val.slice(1) };
  }
  const back = (Object.entries(OPS) as [UiOp, CustomOp][]).find(([, o]) => o === r.op)![0];
  return { op: back, v: r.val };
}

export interface IconOption { set: string; id: number; glyph: IconGlyph }

/** Validated criterion for the draft, or a user-facing reason the dialog cannot be applied yet. */
export function draftToCrit(d: CondDraft, icons: IconOption[]): ColumnCrit | string {
  switch (d.mode) {
    case "custom": {
      if (d.v1 === "") return "Type a value for the first rule";
      const rules = [uiRule(d.op1, d.v1)];
      if (d.op2) { if (d.v2 === "") return "Type a value for the second rule (or choose no second rule)"; rules.push(uiRule(d.op2, d.v2)); }
      if (rules.some((r) => r.val.length > 255)) return "A rule value is limited to 255 characters";
      return { kind: "custom", and: rules.length === 2 && d.and, rules };
    }
    case "top10": {
      const n = Number(d.n.trim());
      if (!/^\d+$/.test(d.n.trim()) || !Number.isInteger(n) || n < 1 || n > (d.pct ? 100 : 500)) return d.pct ? "Percent must be a whole number from 1 to 100" : "Items must be a whole number from 1 to 500";
      return { kind: "top10", top: d.top, percent: d.pct, val: n };
    }
    case "average": return { kind: "dynamic", type: d.above ? "aboveAverage" : "belowAverage" };
    case "date": return DATE_CHOICES.includes(d.date) ? { kind: "dynamic", type: d.date } : "Choose a date period";
    case "color": return d.color === undefined ? "Pick a colour" : { kind: "color", cell: d.cell, dxfId: 0 };
    case "icon": {
      if (d.icon === -2) return { kind: "icon", iconSet: icons[0]?.set ?? "3TrafficLights1", iconId: null };
      const o = icons[d.icon]; return o ? { kind: "icon", iconSet: o.set, iconId: o.id } : "Pick an icon";
    }
  }
}

/** Draft pre-filled from the criterion already on the column (so reopening the dialog shows what is applied). */
export function critToDraft(c: ColumnCrit | null, colour: string | null | undefined, icons: IconOption[]): CondDraft {
  const d = emptyDraft(); if (!c) return d;
  switch (c.kind) {
    case "custom": { const a = ruleUi(c.rules[0]); const b = c.rules[1] ? ruleUi(c.rules[1]) : null; return { ...d, mode: "custom", op1: a.op, v1: a.v, and: c.and, op2: b?.op ?? "", v2: b?.v ?? "" }; }
    case "top10": return { ...d, mode: "top10", top: c.top, pct: c.percent, n: String(c.val) };
    case "dynamic": return c.type === "aboveAverage" || c.type === "belowAverage" ? { ...d, mode: "average", above: c.type === "aboveAverage" } : { ...d, mode: "date", date: c.type };
    case "color": return { ...d, mode: "color", cell: c.cell, color: colour };
    case "icon": return { ...d, mode: "icon", icon: c.iconId === null ? -2 : icons.findIndex((o) => o.set === c.iconSet && o.id === c.iconId) };
    default: return d;
  }
}

/**
 * Distinct colours shown in a column's data rows, in first-seen order (Excel lists the colours present). `fills` /
 * `fonts` are the effective per-row colours (conditional format over cell style), undefined = none.
 */
export function colourOptions(fills: (string | undefined)[], fonts: (string | undefined)[], cap = 24): { cell: (string | null)[]; font: (string | null)[] } {
  const uniq = (xs: (string | undefined)[], noneLast: boolean) => {
    const seen = new Set<string>(); const out: (string | null)[] = []; let none = false;
    for (const x of xs) { if (!x) { none = true; continue; } const u = x.toUpperCase(); if (/^#[0-9A-F]{6}$/.test(u) && !seen.has(u)) { seen.add(u); out.push(u); } }
    const res = out.slice(0, cap); if (none && noneLast && res.length) res.push(null); return res;
  };
  return { cell: uniq(fills, true), font: uniq(fonts, true) };
}

/** Icons shown in a column (CF icon sets), first-seen order; `prefer` = icon sets used by this sheet's rules. */
export function iconOptions(glyphs: (string | undefined)[], prefer: string[]): IconOption[] {
  const out: IconOption[] = []; const seen = new Set<string>();
  const sets = [...prefer.filter((s) => ICON_SETS[s]), ...Object.keys(ICON_SETS)];
  for (const g of glyphs) {
    if (!g || seen.has(g)) continue; seen.add(g);
    for (const s of sets) { const id = ICON_SETS[s].indexOf(g as IconGlyph); if (id >= 0) { out.push({ set: s, id, glyph: g as IconGlyph }); break; } }
  }
  return out;
}

/** Status-bar summary of an applied criterion. */
export function describeCrit(c: ColumnCrit, colour?: string | null): string {
  switch (c.kind) {
    case "custom": return c.rules.map((r) => { const u = ruleUi(r); return `${UI_OPS.find(([k]) => k === u.op)![1]} "${u.v}"`; }).join(c.and ? " and " : " or ");
    case "top10": return `${c.top ? "top" : "bottom"} ${c.val}${c.percent ? "%" : ""}`;
    case "dynamic": return c.type === "aboveAverage" ? "above average" : c.type === "belowAverage" ? "below average" : (DATE_LABELS[c.type] ?? c.type).toLowerCase();
    case "color": return `${c.cell ? "cell colour" : "font colour"} ${colour ?? "none"}`;
    case "icon": return c.iconId === null ? "no cell icon" : `icon ${c.iconSet} #${c.iconId + 1}`;
    case "values": return `${c.vals.length} value(s)`;
  }
}
