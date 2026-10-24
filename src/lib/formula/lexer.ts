/**
 * Tokenizer for the formula grammar. Handles the three places real spreadsheet
 * grammars trip up naive implementations:
 *  - a cell reference regex that must not also swallow function-name prefixes
 *    (LOG10, A1, ROW — "A1" is a ref, "LOG10" is not, disambiguated by requiring
 *    the reference to end at a non-identifier boundary AND not be followed by "(")
 *  - string literals use doubled quotes for an embedded quote: "He said ""hi""" 
 *  - unary minus/percent/number literals with exponents (1.5e3)
 */
export type TokKind =
  | "num" | "str" | "ref" | "ident" | "op" | "lparen" | "rparen" | "comma" | "semicolon"
  | "lbrace" | "rbrace" | "colon" | "bang" | "err" | "eof"
  // TT46: whole-column (A:C), whole-row (1:3), 3-D (Sheet1:Sheet3!A1) and structured (Table1[Col], [@Col]) references
  | "colrange" | "rowrange" | "ref3d" | "sref" | "isect";
export interface Token { kind: TokKind; text: string; pos: number }

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/;
const SHEET_RE = /^([A-Za-z_][A-Za-z0-9_ .]*|'(?:[^']|'')+')!/;
const SHEET_OPT = "(?:(?:[A-Za-z_][A-Za-z0-9_.]*|'(?:[^']|'')+')!)?";
const COLRANGE_RE = new RegExp(`^${SHEET_OPT}\\$?[A-Za-z]{1,3}:\\$?[A-Za-z]{1,3}(?![A-Za-z0-9_(.!\\[])`);
const ROWRANGE_RE = new RegExp(`^${SHEET_OPT}\\$?\\d+:\\$?\\d+(?![0-9.A-Za-z_(!])`);
const REF3D_RE = /^(?:[A-Za-z_][A-Za-z0-9_.]*:[A-Za-z_][A-Za-z0-9_.]*|'(?:[^':]|'')+:(?:[^']|'')+')!/;
/** Structured reference: optional table name then one balanced [...] group ('-escapes honoured). Returns its length or 0. */
function structuredLen(s: string, i: number): number {
  const m = /^[A-Za-z_\\][A-Za-z0-9_.\\]*/.exec(s.slice(i));
  let j = i + (m ? m[0].length : 0);
  if (s[j] !== "[") return 0;
  if (!m && /^\[\d+\]/.test(s.slice(j))) return 0; // [1]Sheet!A1 external-workbook index, not a structured ref
  let depth = 0;
  for (; j < s.length; j++) {
    const ch = s[j];
    if (ch === "'") { j++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") { depth--; if (depth === 0) return j + 1 - i; }
  }
  return 0;
}

/** Is the ')' just emitted closing a parenthesised reference expression like (A1:B2) rather than a call? */
function isRefParen(toks: Token[]): boolean {
  let depth = 0;
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.kind === "rparen") depth++;
    else if (t.kind === "lparen") { depth--; if (depth === 0) { const before = toks[k - 1]; return !before || before.kind !== "ident"; } }
    else if (depth === 1 && !(t.kind === "ref" || t.kind === "colon" || t.kind === "colrange" || t.kind === "rowrange" || t.kind === "isect" || t.kind === "comma")) return false;
  }
  return false;
}
export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const s = src.trim().replace(/^=/, "");
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) {
      // TT46: whitespace between the end of a reference and the start of another is the intersection operator.
      let j = i; while (j < n && /\s/.test(s[j])) j++;
      const prev = toks[toks.length - 1];
      const prevRef = prev && (prev.kind === "ref" || prev.kind === "colrange" || prev.kind === "rowrange" || prev.kind === "rparen" || prev.kind === "sref");
      const nextRef = j < n && /^(?:\$?[A-Za-z]{1,3}\$?\d+|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}\b|\$?\d+:\$?\d+|(?:[A-Za-z_][A-Za-z0-9_.]*|'(?:[^']|'')+')!)/.test(s.slice(j)) && !/^[A-Za-z_][A-Za-z0-9_.]*\s*\(/.test(s.slice(j));
      const prevIsRangeEnd = prevRef && (prev.kind !== "rparen" || isRefParen(toks));
      if (prevIsRangeEnd && nextRef) toks.push({ kind: "isect", text: " ", pos: i });
      i = j; continue;
    }
    // TT15: error literals (#REF! is what reference repair writes after a delete; Excel stores and propagates it)
    if (c === "#") {
      const m = /^(#NULL!|#DIV\/0!|#VALUE!|#REF!|#NAME\?|#NUM!|#N\/A|#SPILL!|#CALC!)/i.exec(s.slice(i));
      if (m) { toks.push({ kind: "err", text: m[0].toUpperCase(), pos: i }); i += m[0].length; continue; }
    }
    if (c === "(") { toks.push({ kind: "lparen", text: c, pos: i }); i++; continue; }
    if (c === ")") { toks.push({ kind: "rparen", text: c, pos: i }); i++; continue; }
    if (c === "{") { toks.push({ kind: "lbrace", text: c, pos: i }); i++; continue; }
    if (c === "}") { toks.push({ kind: "rbrace", text: c, pos: i }); i++; continue; }
    if (c === ",") { toks.push({ kind: "comma", text: c, pos: i }); i++; continue; }
    if (c === ";") { toks.push({ kind: "semicolon", text: c, pos: i }); i++; continue; }
    if (c === ":") { toks.push({ kind: "colon", text: c, pos: i }); i++; continue; }

    if (c === '"') {
      let j = i + 1; let out = "";
      for (;;) {
        if (j >= n) throw new Error("unterminated string literal");
        if (s[j] === '"') {
          if (s[j + 1] === '"') { out += '"'; j += 2; continue; }
          j += 1; break;
        }
        out += s[j]; j += 1;
      }
      toks.push({ kind: "str", text: out, pos: i }); i = j; continue;
    }

    // TT46 reference forms that must be recognised before plain refs/numbers/identifiers.
    {
      const rest = s.slice(i);
      const r3 = REF3D_RE.exec(rest);
      if (r3) {
        const cm = CELL_RE.exec(rest.slice(r3[0].length));
        if (cm) { const full = r3[0] + cm[0]; toks.push({ kind: "ref3d", text: full, pos: i }); i += full.length; continue; }
      }
      const cr = COLRANGE_RE.exec(rest);
      if (cr) { toks.push({ kind: "colrange", text: cr[0], pos: i }); i += cr[0].length; continue; }
      const rr = ROWRANGE_RE.exec(rest);
      if (rr) { toks.push({ kind: "rowrange", text: rr[0], pos: i }); i += rr[0].length; continue; }
      const sl = /[A-Za-z_\\[]/.test(c) ? structuredLen(s, i) : 0;
      if (sl) { toks.push({ kind: "sref", text: s.slice(i, i + sl), pos: i }); i += sl; continue; }
    }

    // sheet-qualified reference: Sheet1!A1 or 'My Sheet'!$A$1
    const sheetMatch = SHEET_RE.exec(s.slice(i));
    if (sheetMatch) {
      const rest = s.slice(i + sheetMatch[0].length);
      const cellMatch = CELL_RE.exec(rest);
      if (cellMatch && !/^\(/.test(rest.slice(cellMatch[0].length))) {
        const full = sheetMatch[0] + cellMatch[0];
        toks.push({ kind: "ref", text: full, pos: i }); i += full.length; continue;
      }
      // TT46: sheet-qualified defined name (Defines!NR_To_A1)
      const nm = /^[A-Za-z_\\][A-Za-z0-9_.\\]*/.exec(rest);
      if (nm && !/^\(/.test(rest.slice(nm[0].length))) { const full = sheetMatch[0] + nm[0]; toks.push({ kind: "ident", text: full, pos: i }); i += full.length; continue; }
    }

    // bare cell reference: must not be immediately followed by '(' (that would be a function call like LOG10())
    const cellMatch = CELL_RE.exec(s.slice(i));
    if (cellMatch) {
      const after = s.slice(i + cellMatch[0].length);
      if (!/^\(/.test(after) && !/^[A-Za-z0-9_.]/.test(after)) {
        toks.push({ kind: "ref", text: cellMatch[0], pos: i }); i += cellMatch[0].length; continue;
      }
    }

    if (/[0-9.]/.test(c)) {
      const m = /^\d+(\.\d+)?([eE][+-]?\d+)?%?/.exec(s.slice(i));
      if (m) { toks.push({ kind: "num", text: m[0], pos: i }); i += m[0].length; continue; }
    }

    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(s.slice(i));
      if (m) { toks.push({ kind: "ident", text: m[0], pos: i }); i += m[0].length; continue; }
    }

    if ("+-*/^&=%".includes(c)) { toks.push({ kind: "op", text: c, pos: i }); i++; continue; }
    if (c === "<" || c === ">") {
      const two = s.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "<>") { toks.push({ kind: "op", text: two, pos: i }); i += 2; continue; }
      toks.push({ kind: "op", text: c, pos: i }); i++; continue;
    }
    throw new Error(`unexpected character '${c}' at ${i} in formula`);
  }
  toks.push({ kind: "eof", text: "", pos: n });
  return toks;
}
