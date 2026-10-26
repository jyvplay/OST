/**
 * TT76: AutoFilter criteria beyond value lists — evaluated, edited and written back (original code).
 *
 * TT74/75 kept custom / top-10 / dynamic / colour / icon / date-group criteria as sanitised <filterColumn> XML ("raw")
 * and never re-applied them. Here that XML stays the single source of truth (it is what workbook JSON, structural
 * edits and both writers already carry); this module parses it into typed criteria, evaluates it over the data rows
 * and regenerates canonical XML (with Excel's recomputed cut-offs: top10@filterVal, dynamicFilter@val/@maxVal).
 *
 * Semantics (ECMA-376 §18.3.2 + the behaviour Excel shows, as documented by ClosedXML's Excel-checked test-suite and
 * PhpSpreadsheet's evaluation tests — both read as specifications, no code taken):
 *   customFilters  1–2 rules, and="1" → both, else either.
 *     <, <=, >, >=  compare only against cells of the criterion's own type: number (dates are numbers), text
 *                   (case-insensitive; "" is text, an empty cell is not), logical (FALSE < TRUE), error (by error
 *                   number #NULL!=1 … #N/A=7).
 *     equal         a value with * or ? (~ escapes) is a wildcard over TEXT cells only; otherwise the cell's
 *                   DISPLAYED text is compared case-insensitively (so 1 shown as "1.00" equals "1.00").
 *     notEqual      wildcard → hides matching text cells only; otherwise hides cells of the same type and value.
 *                   A whitespace-only value is Excel's "(NonBlanks)" spelling: equal → blanks, notEqual → non-blanks.
 *   top10          numbers only; N items (percent: max(1, floor(count·N/100))); the N-th value is the cut-off and
 *                  every value at or beyond it stays (ties included).
 *   dynamicFilter  above/belowAverage: numbers only, strict; no number → every row hidden. Relative dates use the
 *                  half-open range [val, maxVal) from TODAY (weeks start on Sunday); yearToDate = 1 Jan … today; M1–M12
 *                  and Q1–Q4 match that month / quarter of any year.
 *   filters        displayed values (case-insensitive), blank="1" for empty cells, and <dateGroupItem> (OR-ed):
 *                  a date-formatted number whose year[/month/day/hour/minute/second] equals the item's.
 *   colorFilter    the cell's fill (cellColor="1", default) or font colour (cellColor="0") — conditional-format
 *                  colours first, like Excel's "Filter by Color" — equals the dxf's colour (resolved at read time).
 *   iconFilter     the conditional-format icon shown in the cell is the set's iconId; no iconId = "No Cell Icon".
 * Anything else (non-Gregorian calendarType, unknown dynamic type, unresolved colour, unknown icon set) is reported as
 * unsupported: those columns keep the file's hidden rows, as before (no silent change of what is shown).
 */
import type { Workbook } from "./engine";
import { formatValue } from "./numfmt";
import { ERROR_CODES, isError, type Scalar } from "./types";
import { dateToSerial, serialToDate, setDate1904 } from "./dates";
import { ICON_SETS } from "./cficons";
import { evalCondFormats, type CfStyle } from "./sheetmeta";

export type CustomOp = "equal" | "notEqual" | "lessThan" | "lessThanOrEqual" | "greaterThan" | "greaterThanOrEqual";
export const CUSTOM_OPS: readonly CustomOp[] = ["equal", "notEqual", "lessThan", "lessThanOrEqual", "greaterThan", "greaterThanOrEqual"];
export interface CustomRule { op: CustomOp; val: string }
export interface DateGroup { grouping: "year" | "month" | "day" | "hour" | "minute" | "second"; year: number; month?: number; day?: number; hour?: number; minute?: number; second?: number }
export const DYNAMIC_TYPES = ["null", "aboveAverage", "belowAverage", "tomorrow", "today", "yesterday", "nextWeek", "thisWeek", "lastWeek", "nextMonth", "thisMonth", "lastMonth",
  "nextQuarter", "thisQuarter", "lastQuarter", "nextYear", "thisYear", "lastYear", "yearToDate", "Q1", "Q2", "Q3", "Q4",
  "M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10", "M11", "M12"] as const;
export type DynamicType = (typeof DYNAMIC_TYPES)[number];

export type ColumnCrit =
  | { kind: "values"; vals: string[]; blank: boolean; dates: DateGroup[] }
  | { kind: "custom"; and: boolean; rules: CustomRule[] }
  | { kind: "top10"; top: boolean; percent: boolean; val: number; filterVal?: number }
  | { kind: "dynamic"; type: DynamicType; val?: number; maxVal?: number }
  | { kind: "color"; cell: boolean; dxfId: number }
  | { kind: "icon"; iconSet: string; iconId: number | null };

/** Resolved colour of a colorFilter's dxf per column offset: "#RRGGBB", or null = "No Fill" / automatic. */
export type FilterColors = Record<number, string | null>;

/* ------------------------------------------------------------------ parse (canonical, sanitised XML) */
const attrOf = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unesc(m[1]) : undefined;
};
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const bool = (s: string | undefined, dflt: boolean) => (s === undefined ? dflt : s === "1" || s === "true");
const num = (s: string | undefined): number | undefined => { if (s === undefined || !/^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(s)) return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; };
const int = (s: string | undefined, lo: number, hi: number): number | undefined => { const n = num(s); return n !== undefined && Number.isInteger(n) && n >= lo && n <= hi ? n : undefined; };

/** Typed criteria of one sanitised <filterColumn> (sheetfilter.sanitizeFilterColumnXml output), or null when unsupported. */
export function parseCrit(xml: string): ColumnCrit | null {
  const body = /^<filterColumn\b[^>]*?(?:\/>|>([\s\S]*)<\/filterColumn>)$/.exec(xml)?.[1] ?? "";
  const first = /^<(\w+)\b/.exec(body)?.[1];
  if (first === "filters") {
    const open = /^<filters\b[^>]*>/.exec(body)?.[0] ?? body;
    const cal = attrOf(open, "calendarType"); if (cal !== undefined && cal !== "none" && cal !== "gregorian" && cal !== "gregorianUs") return null;
    const vals = [...body.matchAll(/<filter\b([^>]*?)\/?>/g)].map((m) => attrOf(m[0], "val")).filter((v): v is string => v !== undefined);
    const dates: DateGroup[] = [];
    for (const m of body.matchAll(/<dateGroupItem\b[^>]*?\/?>/g)) {
      const g = attrOf(m[0], "dateTimeGrouping"); const year = int(attrOf(m[0], "year"), 0, 9999);
      if (!g || !["year", "month", "day", "hour", "minute", "second"].includes(g) || year === undefined) return null;
      const d: DateGroup = { grouping: g as DateGroup["grouping"], year };
      const parts: [keyof DateGroup, number, number][] = [["month", 1, 12], ["day", 1, 31], ["hour", 0, 23], ["minute", 0, 59], ["second", 0, 59]];
      const need = ["year", "month", "day", "hour", "minute", "second"].indexOf(g);
      for (let i = 0; i < need; i++) { const [k, lo, hi] = parts[i]; const v = int(attrOf(m[0], k), lo, hi); if (v === undefined) return null; (d as unknown as Record<string, number>)[k] = v; }
      dates.push(d);
    }
    return { kind: "values", vals, blank: bool(attrOf(open, "blank"), false), dates };
  }
  if (first === "customFilters") {
    const open = /^<customFilters\b[^>]*>/.exec(body)?.[0] ?? body;
    const rules = [...body.matchAll(/<customFilter\b[^>]*?\/?>/g)].map((m) => ({ op: (attrOf(m[0], "operator") ?? "equal") as CustomOp, val: attrOf(m[0], "val") ?? "" }));
    if (!rules.length || rules.length > 2 || rules.some((r) => !CUSTOM_OPS.includes(r.op))) return null;
    return { kind: "custom", and: bool(attrOf(open, "and"), false), rules };
  }
  if (first === "top10") {
    const t = /^<top10\b[^>]*>/.exec(body)![0]; const val = num(attrOf(t, "val"));
    if (val === undefined || val <= 0) return null;
    if (bool(attrOf(t, "percent"), false) && val > 100) return null; // a percentage past 100 is not an Excel criterion
    const fv = num(attrOf(t, "filterVal"));
    return { kind: "top10", top: bool(attrOf(t, "top"), true), percent: bool(attrOf(t, "percent"), false), val, ...(fv !== undefined ? { filterVal: fv } : {}) };
  }
  if (first === "dynamicFilter") {
    const t = /^<dynamicFilter\b[^>]*>/.exec(body)![0]; const type = attrOf(t, "type") as DynamicType | undefined;
    if (!type || !(DYNAMIC_TYPES as readonly string[]).includes(type)) return null;
    const val = num(attrOf(t, "val")), maxVal = num(attrOf(t, "maxVal"));
    return { kind: "dynamic", type, ...(val !== undefined ? { val } : {}), ...(maxVal !== undefined ? { maxVal } : {}) };
  }
  if (first === "colorFilter") {
    const t = /^<colorFilter\b[^>]*>/.exec(body)![0]; const dxfId = int(attrOf(t, "dxfId"), 0, 1e6);
    if (dxfId === undefined) return null;
    return { kind: "color", cell: bool(attrOf(t, "cellColor"), true), dxfId };
  }
  if (first === "iconFilter") {
    const t = /^<iconFilter\b[^>]*>/.exec(body)![0]; const iconSet = attrOf(t, "iconSet") ?? "";
    const set = ICON_SETS[iconSet]; if (!set) return null;
    const idS = attrOf(t, "iconId"); const iconId = idS === undefined ? null : int(idS, 0, set.length - 1);
    if (iconId === undefined) return null;
    return { kind: "icon", iconSet, iconId };
  }
  return null;
}

/* ------------------------------------------------------------------ write (canonical) */
const fmtNum = (n: number) => String(Number(n.toPrecision(15)));
export function critXml(c: ColumnCrit, colId: number): string {
  const open = `<filterColumn colId="${colId}">`, close = "</filterColumn>";
  switch (c.kind) {
    case "values": {
      const items = c.vals.map((v) => `<filter val="${esc(v)}"/>`).join("") + c.dates.map((d) => {
        const keys = (["year", "month", "day", "hour", "minute", "second"] as const).slice(0, ["year", "month", "day", "hour", "minute", "second"].indexOf(d.grouping) + 1);
        return `<dateGroupItem ${keys.map((k) => `${k}="${d[k]}"`).join(" ")} dateTimeGrouping="${d.grouping}"/>`;
      }).join("");
      return `${open}<filters${c.blank ? ' blank="1"' : ""}${items ? `>${items}</filters>` : "/>"}${close}`;
    }
    case "custom": return `${open}<customFilters${c.and ? ' and="1"' : ""}>${c.rules.map((r) => `<customFilter${r.op === "equal" ? "" : ` operator="${r.op}"`} val="${esc(r.val)}"/>`).join("")}</customFilters>${close}`;
    case "top10": return `${open}<top10${c.top ? "" : ' top="0"'}${c.percent ? ' percent="1"' : ""} val="${fmtNum(c.val)}"${c.filterVal !== undefined ? ` filterVal="${fmtNum(c.filterVal)}"` : ""}/>${close}`;
    case "dynamic": return `${open}<dynamicFilter type="${c.type}"${c.val !== undefined ? ` val="${fmtNum(c.val)}"` : ""}${c.maxVal !== undefined ? ` maxVal="${fmtNum(c.maxVal)}"` : ""}/>${close}`;
    case "color": return `${open}<colorFilter dxfId="${c.dxfId}"${c.cell ? "" : ' cellColor="0"'}/>${close}`;
    case "icon": return `${open}<iconFilter iconSet="${c.iconSet}"${c.iconId === null ? "" : ` iconId="${c.iconId}"`}/>${close}`;
  }
}

/** dxf body for a colour criterion (fill: solid pattern whose bgColor is the colour, §18.8.17; font: <color>). */
export function colorDxfXml(rgb: string | null, cell: boolean): string {
  const argb = rgb ? `FF${rgb.replace("#", "").toUpperCase()}` : null;
  if (cell) return argb ? `<dxf><fill><patternFill patternType="solid"><fgColor rgb="${argb}"/><bgColor rgb="${argb}"/></patternFill></fill></dxf>` : `<dxf><fill><patternFill patternType="none"/></fill></dxf>`;
  return argb ? `<dxf><font><color rgb="${argb}"/></font></dxf>` : `<dxf><font><color auto="1"/></font></dxf>`;
}

/* ------------------------------------------------------------------ evaluation */
type Kind = "blank" | "number" | "text" | "bool" | "error";
const kindOf = (present: boolean, v: Scalar | undefined | null): Kind =>
  !present || v === undefined || v === null ? "blank" : typeof v === "number" ? "number" : typeof v === "string" ? "text" : typeof v === "boolean" ? "bool" : isError(v) ? "error" : "text";
const errNo = (code: string) => { const i = (ERROR_CODES as readonly string[]).indexOf(code.toUpperCase()); return i >= 0 && i < 7 ? i + 1 : 0; };
const coll = new Intl.Collator("en-US", { sensitivity: "base" });
const fold = (s: string) => s.toLocaleLowerCase("en-US");

/**
 * Excel wildcard match (* any run, ? one character, ~ escapes the next), case-insensitive, WITHOUT a RegExp: a
 * `*a*a*a…*b` pattern compiled to [\s\S]* groups backtracks polynomially in the number of stars (a hostile file's
 * criterion could freeze the tab). Two-pointer match with one resume point: O(|text|·|pattern|) worst case, O(1) memory.
 */
export function matchWildcard(pattern: string, text: string): boolean {
  type Tok = { star: true } | { star: false; ch: string | null }; // ch null = "?"
  const toks: Tok[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "~" && i + 1 < pattern.length) toks.push({ star: false, ch: fold(pattern[++i]) });
    else if (c === "*") { if (!toks.length || !toks[toks.length - 1].star) toks.push({ star: true }); }
    else toks.push({ star: false, ch: c === "?" ? null : fold(c) });
  }
  const t = [...fold(text)]; // code points, so ? matches one character even outside the BMP
  let ti = 0, pi = 0, starP = -1, starT = 0;
  while (ti < t.length) {
    const tk = toks[pi];
    if (tk && !tk.star && (tk.ch === null || tk.ch === t[ti])) { ti++; pi++; continue; }
    if (tk && tk.star) { starP = pi++; starT = ti; continue; }
    if (starP < 0) return false;
    pi = starP + 1; ti = ++starT;
  }
  while (pi < toks.length && toks[pi].star) pi++;
  return pi === toks.length;
}
export const hasWildcard = (s: string) => /(^|[^~])[*?]/.test(s);

type Typed = { k: "number"; n: number } | { k: "bool"; b: boolean } | { k: "error"; e: number } | { k: "text"; s: string };
function typedVal(val: string): Typed {
  const n = num(val); if (n !== undefined) return { k: "number", n };
  if (/^(true|false)$/i.test(val)) return { k: "bool", b: /^true$/i.test(val) };
  const e = errNo(val.trim()); if (e) return { k: "error", e };
  return { k: "text", s: val };
}

/** Is a number format a date/time format (date tokens outside quoted text, escapes and [colour]/[$-locale] blocks)? */
export function isDateFormat(fmt: string | undefined): boolean {
  if (!fmt || fmt === "General") return false;
  const s = fmt.split(";")[0].replace(/"[^"]*"/g, "").replace(/\\./g, "").replace(/\[(?![hms]+\])[^\]]*\]/gi, "");
  return /[ymdhs]/i.test(s);
}

export interface Cell { kind: Kind; v: Scalar | undefined; text: string; numFmt?: string; fill?: string; color?: string }

/** One column's predicate over its data rows (precomputed cut-offs). `crit` updated in place with recomputed values. */
function predicate(crit: ColumnCrit, cells: Cell[], ctx: { today: number; colors?: FilterColors; colOff: number; cf: () => Map<string, CfStyle> | undefined; keys: string[] }): ((i: number) => boolean) | null {
  switch (crit.kind) {
    case "values": {
      const set = new Set(crit.vals.map(fold));
      return (i) => {
        const c = cells[i];
        if (c.kind === "blank") return crit.blank;
        if (set.has(fold(c.text))) return true;
        if (c.kind === "number" && crit.dates.length && isDateFormat(c.numFmt)) {
          const n = c.v as number; const d = serialToDate(n); const secs = Math.round((n - Math.floor(n)) * 86400);
          const parts = { year: d.y, month: d.m, day: d.d, hour: Math.floor(secs / 3600) % 24, minute: Math.floor(secs / 60) % 60, second: secs % 60 };
          return crit.dates.some((g) => { const keys = (["year", "month", "day", "hour", "minute", "second"] as const).slice(0, ["year", "month", "day", "hour", "minute", "second"].indexOf(g.grouping) + 1); return keys.every((k) => parts[k] === g[k]); });
        }
        return false;
      };
    }
    case "custom": {
      const tests = crit.rules.map((r) => rulePred(r));
      return (i) => (crit.and ? tests.every((t) => t(cells[i])) : tests.some((t) => t(cells[i])));
    }
    case "top10": {
      const nums = cells.filter((c) => c.kind === "number").map((c) => c.v as number).sort((a, b) => (crit.top ? b - a : a - b));
      if (!nums.length) { delete crit.filterVal; return () => false; }
      const n = crit.percent ? Math.max(1, Math.floor((nums.length * crit.val) / 100)) : Math.max(1, Math.floor(crit.val));
      const cut = nums[Math.min(n, nums.length) - 1]; crit.filterVal = cut;
      return (i) => cells[i].kind === "number" && (crit.top ? (cells[i].v as number) >= cut : (cells[i].v as number) <= cut);
    }
    case "dynamic": {
      if (crit.type === "null") return () => true;
      if (crit.type === "aboveAverage" || crit.type === "belowAverage") {
        const nums = cells.filter((c) => c.kind === "number").map((c) => c.v as number);
        if (!nums.length) { delete crit.val; return () => false; }
        const avg = nums.reduce((a, b) => a + b, 0) / nums.length; crit.val = avg; delete crit.maxVal;
        return (i) => cells[i].kind === "number" && (crit.type === "aboveAverage" ? (cells[i].v as number) > avg : (cells[i].v as number) < avg);
      }
      const mq = /^([MQ])(\d+)$/.exec(crit.type);
      if (mq) {
        delete crit.val; delete crit.maxVal; const k = Number(mq[2]);
        return (i) => { if (cells[i].kind !== "number") return false; const m = serialToDate(Math.floor(cells[i].v as number)).m; return mq[1] === "M" ? m === k : Math.floor((m - 1) / 3) + 1 === k; };
      }
      const [lo, hi] = dateRange(crit.type, ctx.today); crit.val = lo; crit.maxVal = hi;
      return (i) => cells[i].kind === "number" && (cells[i].v as number) >= lo && (cells[i].v as number) < hi;
    }
    case "color": {
      if (!ctx.colors || !(ctx.colOff in ctx.colors)) return null;
      const want = ctx.colors[ctx.colOff]; const W = want ? want.toUpperCase() : undefined; const cf = ctx.cf();
      return (i) => { const s = cf?.get(ctx.keys[i]); const got = crit.cell ? s?.fill ?? cells[i].fill : s?.color ?? cells[i].color; return (got ? got.toUpperCase() : undefined) === W; };
    }
    case "icon": {
      const want = crit.iconId === null ? undefined : ICON_SETS[crit.iconSet][crit.iconId]; const cf = ctx.cf();
      return (i) => cf?.get(ctx.keys[i])?.icon === want;
    }
  }
}

function rulePred(r: CustomRule): (c: Cell) => boolean {
  if (!r.val.trim()) return r.op === "equal" ? (c) => c.kind === "blank" || (c.kind === "text" && !String(c.v).trim()) : r.op === "notEqual" ? (c) => !(c.kind === "blank" || (c.kind === "text" && !String(c.v).trim())) : () => false;
  if ((r.op === "equal" || r.op === "notEqual") && hasWildcard(r.val)) {
    const m = (c: Cell) => c.kind === "text" && matchWildcard(r.val, String(c.v));
    return r.op === "equal" ? m : (c) => !m(c);
  }
  if (r.op === "equal") { const want = fold(r.val); return (c) => fold(c.text) === want; }
  const t = typedVal(r.val);
  const cmp = (c: Cell): number | null => {
    if (t.k === "number") return c.kind === "number" ? Math.sign((c.v as number) - t.n) : null;
    if (t.k === "bool") return c.kind === "bool" ? Number(c.v as boolean) - Number(t.b) : null;
    if (t.k === "error") return c.kind === "error" ? Math.sign(errNo((c.v as { error: string }).error) - t.e) : null;
    return c.kind === "text" ? Math.sign(coll.compare(String(c.v), t.s)) : null;
  };
  switch (r.op) {
    case "notEqual": return (c) => cmp(c) !== 0;
    case "lessThan": return (c) => { const x = cmp(c); return x !== null && x < 0; };
    case "lessThanOrEqual": return (c) => { const x = cmp(c); return x !== null && x <= 0; };
    case "greaterThan": return (c) => { const x = cmp(c); return x !== null && x > 0; };
    case "greaterThanOrEqual": return (c) => { const x = cmp(c); return x !== null && x >= 0; };
  }
  return () => false;
}

/** [lo, hi) serials of a relative-date dynamic filter evaluated on day `today` (a whole serial). */
export function dateRange(type: string, today: number): [number, number] {
  const d = serialToDate(today);
  const month = (y: number, m: number) => dateToSerial(y + Math.floor((m - 1) / 12), ((m - 1) % 12 + 12) % 12 + 1, 1);
  const q0 = Math.floor((d.m - 1) / 3) * 3 + 1; const ws = today - d.weekday0;
  switch (type) {
    case "today": return [today, today + 1];
    case "yesterday": return [today - 1, today];
    case "tomorrow": return [today + 1, today + 2];
    case "thisWeek": return [ws, ws + 7];
    case "lastWeek": return [ws - 7, ws];
    case "nextWeek": return [ws + 7, ws + 14];
    case "thisMonth": return [month(d.y, d.m), month(d.y, d.m + 1)];
    case "lastMonth": return [month(d.y, d.m - 1), month(d.y, d.m)];
    case "nextMonth": return [month(d.y, d.m + 1), month(d.y, d.m + 2)];
    case "thisQuarter": return [month(d.y, q0), month(d.y, q0 + 3)];
    case "lastQuarter": return [month(d.y, q0 - 3), month(d.y, q0)];
    case "nextQuarter": return [month(d.y, q0 + 3), month(d.y, q0 + 6)];
    case "thisYear": return [month(d.y, 1), month(d.y + 1, 1)];
    case "lastYear": return [month(d.y - 1, 1), month(d.y, 1)];
    case "nextYear": return [month(d.y + 1, 1), month(d.y + 2, 1)];
    case "yearToDate": return [month(d.y, 1), today + 1];
  }
  throw new Error(`not a relative date filter: ${type}`);
}

export interface FilterEvalResult {
  /** data rows (absolute indices) the criteria reject */ hidden: Set<number>;
  /** column offsets whose criteria could not be evaluated (their rows keep the file's state) */ unsupported: number[];
  /** canonical XML per evaluated non-value column, with recomputed filterVal / val / maxVal */ raw: Record<number, string>;
}

/**
 * Evaluate the criteria of a filter range. `rng.r0` is the header row; data rows are r0+1 … r1. `cols` = value lists
 * (sheetfilter's model), `raw` = sanitised <filterColumn> XML per column offset. `today` = the serial day relative dates
 * use (injectable; default = the local date now).
 */
export function evaluateFilter(wb: Workbook, sheetName: string, rng: { c0: number; r0: number; c1: number; r1: number }, cols: Record<number, string[]>, raw: Record<number, string> | undefined,
  opts: { today?: number; colors?: FilterColors } = {}): FilterEvalResult {
  // Dates (relative ranges, Mn/Qn, dateGroupItem) are serials in the WORKBOOK's epoch: run under its date system and
  // restore the caller's, even on a throw (the epoch is module state shared with every other open workbook).
  const prev = setDate1904(!!wb.date1904);
  try { return evaluateIn(wb, sheetName, rng, cols, raw, opts); } finally { setDate1904(prev); }
}

function evaluateIn(wb: Workbook, sheetName: string, rng: { c0: number; r0: number; c1: number; r1: number }, cols: Record<number, string[]>, raw: Record<number, string> | undefined,
  opts: { today?: number; colors?: FilterColors }): FilterEvalResult {
  const sheet = wb.sheet(sheetName); const out: FilterEvalResult = { hidden: new Set(), unsupported: [], raw: {} };
  const today = opts.today ?? (() => { const n = new Date(); return dateToSerial(n.getFullYear(), n.getMonth() + 1, n.getDate()); })();
  let cfMap: Map<string, CfStyle> | undefined; let cfDone = false;
  const cf = () => { if (!cfDone) { cfDone = true; try { cfMap = evalCondFormats(wb, sheetName, wb.condFormats); } catch { cfMap = undefined; } } return cfMap; };
  const rows: number[] = []; for (let r = rng.r0 + 1; r <= rng.r1; r++) rows.push(r);
  const preds: ((i: number) => boolean)[] = [];
  const offs = new Set<number>([...Object.keys(cols), ...Object.keys(raw ?? {})].map(Number).filter((k) => Number.isInteger(k) && k >= 0 && k <= rng.c1 - rng.c0));
  for (const k of offs) {
    const col = rng.c0 + k;
    const cells: Cell[] = rows.map((r) => {
      const cell = sheet.get(col, r); const v = wb.valueAt(sheetName, col, r) as Scalar | undefined;
      const kind = kindOf(!!cell, v); const st = cell?.style;
      let text = ""; if (kind !== "blank") { try { text = formatValue(v, st?.numFmt).text; } catch { text = String(v); } }
      return { kind, v, text, numFmt: st?.numFmt, fill: st?.fill, color: st?.color };
    });
    const keys = rows.map((r) => `${col},${r}`);
    let crit: ColumnCrit | null;
    if (k in cols && !(raw && k in raw)) crit = { kind: "values", vals: cols[k].filter((v) => v !== ""), blank: cols[k].includes(""), dates: [] };
    else crit = parseCrit(raw![k]);
    const p = crit ? predicate(crit, cells, { today, colors: opts.colors, colOff: k, cf, keys }) : null;
    if (!crit || !p) { out.unsupported.push(k); continue; }
    if (raw && k in raw) out.raw[k] = critXml(crit, k);
    preds.push(p);
  }
  if (preds.length) rows.forEach((r, i) => { if (!preds.every((p) => p(i))) out.hidden.add(r); });
  return out;
}
