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
  | "lbrace" | "rbrace" | "colon" | "bang" | "eof";
export interface Token { kind: TokKind; text: string; pos: number }

const CELL_RE = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)/;
const SHEET_RE = /^([A-Za-z_][A-Za-z0-9_ ]*|'[^']+')!/;

export function tokenize(src: string): Token[] {
  const toks: Token[] = [];
  let i = 0;
  const s = src.trim().replace(/^=/, "");
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
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

    // sheet-qualified reference: Sheet1!A1 or 'My Sheet'!$A$1
    const sheetMatch = SHEET_RE.exec(s.slice(i));
    if (sheetMatch) {
      const rest = s.slice(i + sheetMatch[0].length);
      const cellMatch = CELL_RE.exec(rest);
      if (cellMatch && !/^\(/.test(rest.slice(cellMatch[0].length))) {
        const full = sheetMatch[0] + cellMatch[0];
        toks.push({ kind: "ref", text: full, pos: i }); i += full.length; continue;
      }
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
