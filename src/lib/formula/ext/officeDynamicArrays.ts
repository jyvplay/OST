/**
 * Modern spreadsheet dynamic array and array manipulation functions for Fusion Office Engine.
 *
 * Implements modern leading office suite standard functions:
 * - Array Generation: SEQUENCE, RANDARRAY
 * - Array Reshaping & Slicing: CHOOSEROWS, CHOOSECOLS, TAKE, DROP, EXPAND, TOCOL, TOROW, WRAPROWS, WRAPCOLS, VSTACK, HSTACK
 * - Array Filtering & Sorting: FILTER, SORT, SORTBY, UNIQUE
 * - Text Array Splitting & Formatting: TEXTSPLIT, ARRAYTOTEXT, VALUETOTEXT
 *
 * Pure TypeScript, zero external dependencies, deterministic random handling.
 */

import {
  ERR, isErr, toNum, toStr, toBool, isGridValue, unwrapScalar,
  type ArgAccessor, type CellValue, type EvalEnv, type FnImpl,
} from "./officeFunctions";

/** Hard output bound. Refuse an oversized request instead of silently truncating it. */
export const MAX_ARRAY_CELLS = 20000;
function checkedSize(rows: number, cols: number) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows * cols > MAX_ARRAY_CELLS) throw ERR("#NUM!");
}
function extractGrid(a: ArgAccessor): CellValue[][] {
  const g = a.grid();
  if (g.length > 0 && g[0].length > 0) return g;
  const l = a.list();
  return l.map((v) => [v]);
}

/* Helper to normalize 1-based indexing with negative values indexing from end */
function normalizeIndex(idx: number, length: number): number {
  if (idx > 0 && idx <= length) return idx - 1;
  if (idx < 0 && idx >= -length) return length + idx;
  throw ERR("#VALUE!");
}

/** Excel sort ordering: numbers < text (case-insensitive) < logicals < errors; blanks always last. */
function typeRank(v: CellValue): number {
  if (v === null || v === undefined || v === "") return 9;
  if (typeof v === "number") return 0;
  if (typeof v === "boolean") return 2;
  if (isErr(v)) return 3;
  return 1;
}
export function excelCompare(x: CellValue, y: CellValue): number {
  const rx = typeRank(x), ry = typeRank(y);
  if (rx !== ry) return rx - ry;
  if (rx === 0) return (x as number) - (y as number);
  if (rx === 2) return Number(x) - Number(y);
  if (rx === 1) return String(x).localeCompare(String(y), "en", { sensitivity: "base" });
  return 0;
}
/** Indices 0..n-1 ordered by multi-key comparison; ties keep original order; blanks last regardless of direction. */
function stableOrder(n: number, keyOf: (i: number) => CellValue[], orders: number[]): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  return idx.sort((i, j) => {
    const ki = keyOf(i), kj = keyOf(j);
    for (let k = 0; k < orders.length; k++) {
      const bi = typeRank(ki[k]) === 9, bj = typeRank(kj[k]) === 9;
      if (bi !== bj) return bi ? 1 : -1;
      const c = excelCompare(ki[k], kj[k]) * orders[k];
      if (c) return c;
    }
    return i - j;
  });
}

export const DYNAMIC_ARRAY_FUNCTIONS: Record<string, FnImpl> = {
  /* SEQUENCE(rows, [columns], [start], [step]) */
  SEQUENCE: (a) => {
    if (a.length < 1) throw ERR("#VALUE!");
    const rows = toNum(a[0].value());
    const cols = a[1] ? toNum(a[1].value()) : 1;
    let start = a[2] ? toNum(a[2].value()) : 1;
    const step = a[3] ? toNum(a[3].value()) : 1;
    if (rows < 1 || cols < 1 || !Number.isFinite(rows) || !Number.isFinite(cols)) throw ERR("#VALUE!");
    checkedSize(rows, cols);
    const rCount = Math.floor(rows);
    const cCount = Math.floor(cols);
    let cur = start;
    const grid: CellValue[][] = [];
    for (let r = 0; r < rCount; r++) {
      const row: CellValue[] = [];
      for (let c = 0; c < cCount; c++) {
        row.push(cur);
        cur += step;
      }
      grid.push(row);
    }
    return grid;
  },

  /* RANDARRAY([rows], [columns], [min], [max], [whole_number]) */
  RANDARRAY: (a, env) => {
    const rows = a[0] ? toNum(a[0].value()) : 1;
    const cols = a[1] ? toNum(a[1].value()) : 1;
    const min = a[2] ? toNum(a[2].value()) : 0;
    const max = a[3] ? toNum(a[3].value()) : 1;
    const whole = a[4] ? toBool(a[4].value()) : false;
    if (rows < 1 || cols < 1 || min > max) throw ERR("#VALUE!");
    checkedSize(rows, cols);
    const rCount = Math.floor(rows);
    const cCount = Math.floor(cols);
    const grid: CellValue[][] = [];
    for (let r = 0; r < rCount; r++) {
      const row: CellValue[] = [];
      for (let c = 0; c < cCount; c++) {
        const rand = env.random();
        let val = min + rand * (max - min);
        if (whole) val = Math.floor(min + rand * (max - min + 1));
        row.push(val);
      }
      grid.push(row);
    }
    return grid;
  },

  /* CHOOSEROWS(array, row_num1, [row_num2], ...) */
  CHOOSEROWS: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    if (g.length === 0) throw ERR("#VALUE!");
    const result: CellValue[][] = [];
    for (let i = 1; i < a.length; i++) {
      const rIdx = normalizeIndex(toNum(a[i].value()), g.length);
      result.push([...g[rIdx]]);
    }
    return result;
  },

  /* CHOOSECOLS(array, col_num1, [col_num2], ...) */
  CHOOSECOLS: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    if (g.length === 0 || g[0].length === 0) throw ERR("#VALUE!");
    const numCols = g[0].length;
    const colIndices = a.slice(1).map((x) => normalizeIndex(toNum(x.value()), numCols));
    const result: CellValue[][] = g.map((row) => colIndices.map((ci) => row[ci] ?? null));
    return result;
  },

  /* TAKE(array, rows, [columns]) */
  TAKE: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    if (g.length === 0) throw ERR("#VALUE!");
    const rowParam = toNum(a[1].value());
    const colParam = a[2] ? toNum(a[2].value()) : g[0].length;
    let selectedRows: CellValue[][];
    if (rowParam > 0) selectedRows = g.slice(0, Math.min(g.length, rowParam));
    else if (rowParam < 0) selectedRows = g.slice(Math.max(0, g.length + rowParam));
    else throw ERR("#VALUE!");

    if (colParam === 0) throw ERR("#VALUE!");
    const result = selectedRows.map((row) => {
      if (colParam > 0) return row.slice(0, Math.min(row.length, colParam));
      return row.slice(Math.max(0, row.length + colParam));
    });
    return result;
  },

  /* DROP(array, rows, [columns]) */
  DROP: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    if (g.length === 0) throw ERR("#VALUE!");
    const rowParam = toNum(a[1].value());
    const colParam = a[2] ? toNum(a[2].value()) : 0;
    let remainingRows: CellValue[][];
    if (rowParam > 0) remainingRows = g.slice(rowParam);
    else if (rowParam < 0) remainingRows = g.slice(0, Math.max(0, g.length + rowParam));
    else remainingRows = [...g];

    if (remainingRows.length === 0) throw ERR("#CALC!");
    const result = remainingRows.map((row) => {
      if (colParam > 0) return row.slice(colParam);
      if (colParam < 0) return row.slice(0, Math.max(0, row.length + colParam));
      return [...row];
    });
    if (result.length === 0 || result[0].length === 0) throw ERR("#CALC!");
    return result;
  },

  /* EXPAND(array, rows, [columns], [pad_with]) */
  EXPAND: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    const targetRows = toNum(a[1].value());
    const targetCols = a[2] ? toNum(a[2].value()) : (g[0]?.length ?? 1);
    const pad = a[3] ? a[3].value() : "#N/A";
    const srcRows = g.length;
    const srcCols = g[0]?.length ?? 0;
    if (targetRows < srcRows || targetCols < srcCols) throw ERR("#VALUE!");
    checkedSize(targetRows, targetCols);
    const result: CellValue[][] = [];
    for (let r = 0; r < targetRows; r++) {
      const row: CellValue[] = [];
      for (let c = 0; c < targetCols; c++) {
        if (r < srcRows && c < srcCols) row.push(g[r][c]);
        else row.push(pad);
      }
      result.push(row);
    }
    return result;
  },

  /* TOCOL(array, [ignore], [scan_by_column]) */
  TOCOL: (a) => {
    if (a.length < 1) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    const ignore = a[1] ? toNum(a[1].value()) : 0;
    const byCol = a[2] ? toBool(a[2].value()) : false;
    const flat: CellValue[] = [];
    if (!byCol) {
      for (const row of g) for (const val of row) flat.push(val);
    } else {
      const numCols = Math.max(...g.map((r) => r.length), 0);
      for (let c = 0; c < numCols; c++) {
        for (let r = 0; r < g.length; r++) {
          if (c < g[r].length) flat.push(g[r][c]);
        }
      }
    }
    const filtered = flat.filter((v) => {
      const isBlank = v === null || v === "";
      const isError = isErr(v);
      if (ignore === 1) return !isBlank;
      if (ignore === 2) return !isError;
      if (ignore === 3) return !isBlank && !isError;
      return true;
    });
    if (filtered.length === 0) throw ERR("#CALC!");
    return filtered.map((x) => [x]);
  },

  /* TOROW(array, [ignore], [scan_by_column]) */
  TOROW: (a) => {
    const col = DYNAMIC_ARRAY_FUNCTIONS.TOCOL(a, { now: () => new Date(), random: () => 0.5, cursor: { row: 1, col: 1 } });
    if (isGridValue(col)) return [col.map((r) => r[0])];
    return col;
  },

  /* WRAPROWS(vector, wrap_count, [pad_with]) */
  WRAPROWS: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const list = a[0].list();
    const wrap = Math.floor(toNum(a[1].value()));
    const pad = a[2] ? a[2].value() : "#N/A";
    if (!Number.isFinite(wrap) || wrap < 1 || wrap > MAX_ARRAY_CELLS) throw ERR("#VALUE!");
    const result: CellValue[][] = [];
    let curRow: CellValue[] = [];
    for (const item of list) {
      curRow.push(item);
      if (curRow.length === wrap) {
        result.push(curRow);
        curRow = [];
      }
    }
    if (curRow.length > 0) {
      while (curRow.length < wrap) curRow.push(pad);
      result.push(curRow);
    }
    return result;
  },

  /* WRAPCOLS(vector, wrap_count, [pad_with]) */
  WRAPCOLS: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const list = a[0].list();
    const wrap = Math.floor(toNum(a[1].value()));
    const pad = a[2] ? a[2].value() : "#N/A";
    if (!Number.isFinite(wrap) || wrap < 1 || wrap > MAX_ARRAY_CELLS) throw ERR("#VALUE!");
    const numCols = Math.ceil(list.length / wrap);
    const result: CellValue[][] = Array.from({ length: wrap }, () => Array(numCols).fill(pad));
    for (let i = 0; i < list.length; i++) {
      const c = Math.floor(i / wrap);
      const r = i % wrap;
      result[r][c] = list[i];
    }
    return result;
  },

  /* VSTACK(array1, [array2], ...) */
  VSTACK: (a) => {
    if (a.length < 1) throw ERR("#VALUE!");
    const grids = a.map(extractGrid);
    const maxCols = Math.max(...grids.map((g) => Math.max(...g.map((r) => r.length), 0)), 1);
    checkedSize(grids.reduce((n, g) => n + g.length, 0), maxCols);
    const result: CellValue[][] = [];
    for (const g of grids) {
      for (const row of g) {
        const paddedRow = [...row];
        while (paddedRow.length < maxCols) paddedRow.push("#N/A");
        result.push(paddedRow);
      }
    }
    return result;
  },

  /* HSTACK(array1, [array2], ...) */
  HSTACK: (a) => {
    if (a.length < 1) throw ERR("#VALUE!");
    const grids = a.map(extractGrid);
    const maxRows = Math.max(...grids.map((g) => g.length), 1);
    checkedSize(maxRows, grids.reduce((n, g) => n + (g[0]?.length ?? 0), 0));
    const result: CellValue[][] = Array.from({ length: maxRows }, () => []);
    for (const g of grids) {
      const colsInG = Math.max(...g.map((r) => r.length), 1);
      for (let r = 0; r < maxRows; r++) {
        if (r < g.length) {
          const row = [...g[r]];
          while (row.length < colsInG) row.push("#N/A");
          result[r].push(...row);
        } else {
          result[r].push(...Array(colsInG).fill("#N/A"));
        }
      }
    }
    return result;
  },

  /* FILTER(array, include, [if_empty]) */
  FILTER: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    const inc = a[1].list().map(toBool);
    const ifEmpty = a[2] ? a[2].value() : "#CALC!";
    if (inc.length !== g.length) throw ERR("#VALUE!");
    const matched: CellValue[][] = [];
    for (let r = 0; r < g.length; r++) {
      if (inc[r]) matched.push([...g[r]]);
    }
    if (matched.length === 0) {
      if (isErr(ifEmpty)) throw ERR(String(ifEmpty));
      return ifEmpty;
    }
    return matched;
  },

  /* SORT(array, [sort_index], [sort_order], [by_col]) — TT15: Excel ordering (numbers < text (case-insensitive) < logicals < errors, blanks last), index/order validation */
  SORT: (a) => {
    if (a.length < 1) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    if (g.length === 0) return null;
    const sortIndex = a[1] ? Math.trunc(toNum(a[1].value())) : 1;
    const sortOrder = a[2] ? toNum(a[2].value()) : 1;
    const byCol = a[3] ? toBool(a[3].value()) : false;
    if (sortOrder !== 1 && sortOrder !== -1) throw ERR("#VALUE!");
    if (!byCol) {
      if (sortIndex < 1 || sortIndex > g[0].length) throw ERR("#VALUE!");
      return stableOrder(g.length, (i) => [g[i][sortIndex - 1]], [sortOrder]).map((i) => [...g[i]]);
    }
    if (sortIndex < 1 || sortIndex > g.length) throw ERR("#VALUE!");
    const order = stableOrder(g[0].length, (c) => [g[sortIndex - 1][c]], [sortOrder]);
    return g.map((row) => order.map((c) => row[c] ?? null));
  },

  /* SORTBY(array, by_array1, [sort_order1], [by_array2, sort_order2], …) — TT15 (was documented but missing → #NAME?, found by e2e) */
  SORTBY: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    if (g.length === 0) return null;
    const keys: CellValue[][] = []; const orders: number[] = []; let byCol: boolean | null = null;
    for (let i = 1; i < a.length; i += 2) {
      const k = extractGrid(a[i]);
      const order = a[i + 1] ? toNum(a[i + 1].value()) : 1;
      if (order !== 1 && order !== -1) throw ERR("#VALUE!");
      const isColVec = k[0].length === 1 && k.length === g.length;
      const isRowVec = k.length === 1 && k[0].length === g[0].length;
      const thisByCol: boolean | null = isColVec && !(isRowVec && byCol === true) ? false : isRowVec ? true : null;
      if (thisByCol === null || (byCol !== null && thisByCol !== byCol)) throw ERR("#VALUE!");
      byCol = thisByCol;
      keys.push(byCol ? k[0] : k.map((r) => r[0])); orders.push(order);
    }
    if (!byCol) return stableOrder(g.length, (i) => keys.map((k) => k[i]), orders).map((i) => [...g[i]]);
    const order = stableOrder(g[0].length, (c) => keys.map((k) => k[c]), orders);
    return g.map((row) => order.map((c) => row[c] ?? null));
  },

  /* UNIQUE(array, [by_col], [exactly_once]) */
  UNIQUE: (a) => {
    if (a.length < 1) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    if (g.length === 0) return null;
    const byCol = a[1] ? toBool(a[1].value()) : false;
    const exactlyOnce = a[2] ? toBool(a[2].value()) : false;

    if (!byCol) {
      const rowStrings = g.map((r) => JSON.stringify(r));
      const counts = new Map<string, number>();
      for (const rs of rowStrings) counts.set(rs, (counts.get(rs) ?? 0) + 1);
      const seen = new Set<string>();
      const result: CellValue[][] = [];
      for (let i = 0; i < g.length; i++) {
        const rs = rowStrings[i];
        if (exactlyOnce) {
          if (counts.get(rs) === 1) result.push([...g[i]]);
        } else {
          if (!seen.has(rs)) {
            seen.add(rs);
            result.push([...g[i]]);
          }
        }
      }
      if (result.length === 0) throw ERR("#CALC!");
      return result;
    } else {
      const numCols = g[0].length;
      const colKeys = Array.from({ length: numCols }, (_, c) => JSON.stringify(g.map((r) => r[c])));
      const counts = new Map<string, number>();
      for (const ck of colKeys) counts.set(ck, (counts.get(ck) ?? 0) + 1);
      const chosenCols: number[] = [];
      const seen = new Set<string>();
      for (let c = 0; c < numCols; c++) {
        const ck = colKeys[c];
        if (exactlyOnce) {
          if (counts.get(ck) === 1) chosenCols.push(c);
        } else {
          if (!seen.has(ck)) {
            seen.add(ck);
            chosenCols.push(c);
          }
        }
      }
      if (chosenCols.length === 0) throw ERR("#CALC!");
      const result = g.map((row) => chosenCols.map((c) => row[c]));
      return result;
    }
  },

  /* TEXTSPLIT(text, col_delimiter, [row_delimiter], [ignore_empty], [match_mode], [pad_with]) */
  TEXTSPLIT: (a) => {
    if (a.length < 2) throw ERR("#VALUE!");
    const text = toStr(a[0].value());
    const colDelim = toStr(a[1].value());
    const rowDelim = a[2] && a[2].value() !== "" ? toStr(a[2].value()) : "";
    const ignoreEmpty = a[3] ? toBool(a[3].value()) : false;
    const padWith = a[5] ? a[5].value() : "#N/A";

    const rows = rowDelim ? text.split(rowDelim) : [text];
    const filteredRows = ignoreEmpty ? rows.filter((r) => r !== "") : rows;
    const grid: CellValue[][] = filteredRows.map((r) => {
      const cols = colDelim ? r.split(colDelim) : [r];
      const filteredCols: CellValue[] = ignoreEmpty ? cols.filter((c) => c !== "") : cols;
      return filteredCols;
    });
    const maxCols = Math.max(...grid.map((r) => r.length), 1);
    const result: CellValue[][] = grid.map((r) => {
      const row: CellValue[] = [...r];
      while (row.length < maxCols) row.push(padWith);
      return row;
    });
    return result;
  },

  /* ARRAYTOTEXT(array, [format]) */
  ARRAYTOTEXT: (a) => {
    if (a.length < 1) throw ERR("#VALUE!");
    const g = extractGrid(a[0]);
    const format = a[1] ? toNum(a[1].value()) : 0;
    if (format === 0) {
      return g.flatMap((r) => r.map((c) => (c === null ? "" : String(c)))).join(", ");
    } else {
      const rows = g.map((r) => r.map((c) => (typeof c === "string" ? `"${c}"` : c === null ? "" : String(c))).join(", "));
      return `{${rows.join("; ")}}`;
    }
  },

  /* VALUETOTEXT(value, [format]) */
  VALUETOTEXT: (a) => {
    if (a.length < 1) throw ERR("#VALUE!");
    const v = a[0].value();
    const format = a[1] ? toNum(a[1].value()) : 0;
    if (format === 1 && typeof v === "string") return `"${v}"`;
    return toStr(v);
  },
};

// Output-shape and arity gate; limits are part of the supported web contract, not Excel limits.
const ARRAY_ARITY: Record<string, [number, number]> = {
 SEQUENCE:[1,4], RANDARRAY:[0,5], CHOOSEROWS:[2,255], CHOOSECOLS:[2,255], TAKE:[2,3], DROP:[2,3], EXPAND:[2,4],
 TOCOL:[1,3], TOROW:[1,3], WRAPROWS:[2,3], WRAPCOLS:[2,3], VSTACK:[1,255], HSTACK:[1,255], FILTER:[2,3], SORT:[1,4], SORTBY:[2,255], UNIQUE:[1,3], TEXTSPLIT:[2,6], ARRAYTOTEXT:[1,2], VALUETOTEXT:[1,2],
};
for (const [name, [min, max]] of Object.entries(ARRAY_ARITY)) {
 const impl = DYNAMIC_ARRAY_FUNCTIONS[name];
 DYNAMIC_ARRAY_FUNCTIONS[name] = (args, env) => {
  if(args.length < min || args.length > max) throw ERR("#VALUE!");
  const result = impl(args, env);
  if(isGridValue(result)) checkedSize(result.length, result[0].length);
  return result;
 };
}
