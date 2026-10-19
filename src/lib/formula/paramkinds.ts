/**
 * TT46 — which function parameters take a RANGE/ARRAY (no implicit intersection) vs a single VALUE.
 * Used for (a) legacy (pre-dynamic-array) formula semantics when reading .xlsx cells that carry no
 * dynamic-array metadata, and (b) deciding which formulas must be written WITH that metadata so Excel 365
 * evaluates them the way this engine does. Original table, derived from the published Excel function
 * signatures (value vs. reference/array arguments).
 */
import type { Node } from "./types";

type Kinds = "all" | ((i: number) => boolean);
const idx = (...xs: number[]) => (i: number) => xs.includes(i);
const from = (k: number) => (i: number) => i >= k;
const odd = (i: number) => i % 2 === 1;
const ALL: Kinds = "all";
export const ARRAY_PARAMS: Record<string, Kinds> = {};
const put = (names: string, k: Kinds) => { for (const n of names.split(/\s+/).filter(Boolean)) ARRAY_PARAMS[n] = k; };
put(`SUM AVERAGE AVERAGEA COUNT COUNTA COUNTBLANK MAX MAXA MIN MINA PRODUCT SUMSQ STDEV STDEV.S STDEV.P STDEVA STDEVP STDEVPA
  VAR VAR.S VAR.P VARA VARP VARPA MEDIAN MODE MODE.SNGL MODE.MULT AVEDEV DEVSQ GEOMEAN HARMEAN KURT SKEW SKEW.P AND OR XOR CONCAT
  SUMPRODUCT MMULT MDETERM MINVERSE TRANSPOSE SUMX2MY2 SUMX2PY2 SUMXMY2 CORREL PEARSON COVAR COVARIANCE.P COVARIANCE.S RSQ SLOPE
  INTERCEPT STEYX TREND GROWTH LINEST LOGEST FREQUENCY ROWS COLUMNS ROW COLUMN AREAS ISREF VSTACK HSTACK UNIQUE ARRAYTOTEXT
  ISFORMULA FORMULATEXT SHEET N T`, ALL);
put("TEXTJOIN", from(2)); put("NPV", from(1)); put("IRR MIRR", idx(0)); put("XNPV", idx(1, 2)); put("XIRR", idx(0, 1));
put("FORECAST FORECAST.LINEAR", idx(1, 2)); put("SUBTOTAL", from(1)); put("AGGREGATE", from(2));
put("SORT TOCOL TOROW WRAPROWS WRAPCOLS EXPAND CHOOSECOLS CHOOSEROWS TAKE DROP INDEX OFFSET LARGE SMALL PERCENTILE PERCENTILE.INC PERCENTILE.EXC QUARTILE QUARTILE.INC QUARTILE.EXC PERCENTRANK PERCENTRANK.INC PERCENTRANK.EXC TRIMMEAN ZTEST Z.TEST", idx(0));
put("SORTBY", (i) => i === 0 || odd(i)); put("FILTER", idx(0, 1)); put("XLOOKUP", idx(1, 2)); put("XMATCH MATCH VLOOKUP HLOOKUP RANK RANK.EQ RANK.AVG", idx(1));
put("LOOKUP", idx(1, 2)); put("CHOOSE", from(1)); put("IF", idx(1, 2)); put("IFERROR IFNA", idx(0, 1)); put("IFS", odd); put("SWITCH", from(1));
put("COUNTIF", idx(0)); put("SUMIF AVERAGEIF", idx(0, 2)); put("COUNTIFS", (i) => i % 2 === 0); put("SUMIFS AVERAGEIFS MAXIFS MINIFS", (i) => i === 0 || odd(i));
put("DSUM DAVERAGE DCOUNT DCOUNTA DGET DMAX DMIN DPRODUCT DSTDEV DSTDEVP DVAR DVARP", idx(0, 2));
put("PROB CHITEST CHISQ.TEST TTEST T.TEST FTEST F.TEST", idx(0, 1)); put("SERIESSUM", idx(3)); put("CELL", idx(1));
put("NETWORKDAYS WORKDAY", idx(2)); put("NETWORKDAYS.INTL WORKDAY.INTL", idx(3)); put("LET LAMBDA MAP REDUCE SCAN BYROW BYCOL MAKEARRAY", ALL);
/** Functions whose RESULT is an array (always need dynamic metadata when the result spills or feeds an operator). */
export const ARRAY_RESULT = new Set("FILTER SORT SORTBY UNIQUE SEQUENCE RANDARRAY TRANSPOSE MMULT MINVERSE FREQUENCY TREND GROWTH LINEST LOGEST TEXTSPLIT VSTACK HSTACK TOCOL TOROW WRAPROWS WRAPCOLS EXPAND CHOOSECOLS CHOOSEROWS TAKE DROP MAP SCAN BYROW BYCOL MAKEARRAY MODE.MULT".split(" "));

export function takesArray(fn: string, i: number): boolean {
  const k = ARRAY_PARAMS[fn];
  return k === "all" ? true : k ? k(i) : false;
}
const isRangeish = (n: Node) => n.t === "range" || n.t === "array" || (n.t === "call" && (n.name === "__SREF" || n.name === "__REF3D" || ARRAY_RESULT.has(n.name)));
/**
 * Would this formula evaluate differently under legacy implicit intersection than under dynamic arrays?
 * (a range/array as an operator operand, in a value parameter, or as the whole result).
 */
export function needsDynamic(node: Node, top = true): boolean {
  switch (node.t) {
    case "range": return top && !(node.v.from.col === node.v.to.col && node.v.from.row === node.v.to.row);
    case "array": return top;
    case "unary": case "percent": return isRangeish(node.arg) || needsDynamic(node.arg, false);
    case "binary": return isRangeish(node.left) || isRangeish(node.right) || needsDynamic(node.left, false) || needsDynamic(node.right, false);
    case "call": {
      if (ARRAY_RESULT.has(node.name) && top) return true;
      if (node.name === "__SREF") return top;
      return node.args.some((a, i) => (!takesArray(node.name, i) && isRangeish(a) && !(a.t === "call" && a.name === "__SREF" && false)) || needsDynamic(a, false));
    }
    default: return false;
  }
}
