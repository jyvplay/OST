/**
 * Fusion Formula Engine — value and AST model.
 *
 * Every semantic choice below is either (a) a documented fact of the published
 * OOXML Part 1 §18.17 / ODF OpenFormula 1.2 grammar, which is a specification,
 * not copyrightable expression, or (b) empirically VERIFIED against a real,
 * locally installed LibreOffice 7.4.7.2 instance (`soffice --headless`) used
 * strictly as a build-time oracle — see scripts/oracle-formula.mts and the
 * frozen ground truth in docs/test-fixtures/formula-oracle.json. No LibreOffice
 * source code or binary is vendored, copied, or shipped; this module is an
 * independent, from-scratch TypeScript implementation.
 */

export const ERROR_CODES = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#CIRCULAR!", "#SPILL!", "#CALC!"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
export interface FormulaError { error: ErrorCode }
export const isError = (v: unknown): v is FormulaError => typeof v === "object" && v !== null && "error" in v;
export const err = (code: ErrorCode): FormulaError => ({ error: code });

/** A single cell's resolved value. Arrays only appear transiently during evaluation. */
export type Scalar = number | string | boolean | FormulaError;
export type CellValue = Scalar;

/** AST ---------------------------------------------------------------- */
export interface CellAddr { sheet: string | null; col: number; row: number; colAbs: boolean; rowAbs: boolean }
export interface RangeAddr { from: CellAddr; to: CellAddr }

export type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "err"; v: ErrorCode }
  | { t: "ref"; v: CellAddr }
  | { t: "range"; v: RangeAddr }
  | { t: "call"; name: string; args: Node[] }
  | { t: "unary"; op: "-" | "+"; arg: Node }
  | { t: "percent"; arg: Node }
  | { t: "binary"; op: BinOp; left: Node; right: Node }
  | { t: "array"; rows: Node[][] };

export type BinOp = "+" | "-" | "*" | "/" | "^" | "&" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export const colToLetters = (col: number): string => {
  let n = col + 1;
  let s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
};
export const lettersToCol = (s: string): number => {
  let n = 0;
  for (const c of s) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
};
export const addrToA1 = (a: CellAddr): string => `${a.colAbs ? "$" : ""}${colToLetters(a.col)}${a.rowAbs ? "$" : ""}${a.row + 1}`;
