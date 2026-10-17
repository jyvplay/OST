/**
 * Recursive-descent parser. Precedence (loosest → tightest), reproduced exactly
 * from the published OOXML/ODFF operator table AND re-verified against the real
 * oracle for every ambiguous case (left-assoc `^`, unary-minus-binds-tighter-
 * than-`^`, postfix `%`):
 *
 *   comparison  = <> < <= > >=
 *   concatenate &
 *   additive    + -
 *   multiply    * /
 *   power       ^            (left-associative: 2^3^2 = (2^3)^2 = 64, verified)
 *   unary       - +          (binds TIGHTER than ^: -2^2 = (-2)^2 = 4, verified)
 *   percent     n%           (postfix, tighter than unary: -5% = -0.05, verified)
 *   atom        number | string | ref | range | "(" expr ")" | call | array
 *
 * Known, declared gap: the reference UNION operator (bare comma used as a
 * reference operator outside a function's argument list, e.g. `=(A1,B1)`) and
 * the INTERSECTION operator (a space between two ranges) are not implemented —
 * they are rare, and comma is unambiguous here because it is reserved for
 * function-argument and array-row separation (documented negative space).
 */
import { tokenize, type Token } from "./lexer";
import { lettersToCol, type BinOp, type CellAddr, type ErrorCode, type Node } from "./types";

function parseCellToken(text: string): CellAddr {
  const m = /^(?:('[^']+'|[A-Za-z_][A-Za-z0-9_ ]*)!)?(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(text);
  if (!m) throw new Error(`bad reference token: ${text}`);
  const [, sheetRaw, colAbs, colLetters, rowAbs, rowDigits] = m;
  const sheet = sheetRaw ? sheetRaw.replace(/^'|'$/g, "") : null;
  return { sheet, col: lettersToCol(colLetters.toUpperCase()), row: Number(rowDigits) - 1, colAbs: colAbs === "$", rowAbs: rowAbs === "$" };
}

class Parser {
  private i = 0;
  private toks: Token[];
  constructor(toks: Token[]) { this.toks = toks; }
  private peek() { return this.toks[this.i]; }
  private eat(kind?: string) {
    const t = this.toks[this.i];
    if (kind && t.kind !== kind) throw new Error(`expected ${kind} but found "${t.text || "<end>"}" at ${t.pos}`);
    this.i++; return t;
  }
  private at(kind: string) { return this.peek().kind === kind; }
  private opIs(...ops: string[]) { const t = this.peek(); return t.kind === "op" && ops.includes(t.text); }

  parseFormula(): Node {
    const node = this.comparison();
    if (!this.at("eof")) throw new Error(`unexpected trailing token "${this.peek().text}"`);
    return node;
  }

  private comparison(): Node {
    let left = this.concat();
    while (this.opIs("=", "<>", "<", ">", "<=", ">=")) {
      const op = this.eat().text as BinOp;
      left = { t: "binary", op, left, right: this.concat() };
    }
    return left;
  }
  private concat(): Node {
    let left = this.additive();
    while (this.opIs("&")) { this.eat(); left = { t: "binary", op: "&", left, right: this.additive() }; }
    return left;
  }
  private additive(): Node {
    let left = this.multiplicative();
    while (this.opIs("+", "-")) {
      const op = this.eat().text as BinOp;
      left = { t: "binary", op, left, right: this.multiplicative() };
    }
    return left;
  }
  private multiplicative(): Node {
    let left = this.power();
    while (this.opIs("*", "/")) {
      const op = this.eat().text as BinOp;
      left = { t: "binary", op, left, right: this.power() };
    }
    return left;
  }
  /** Left-associative ^ chain; each side goes through unary() so -2^2 and 2^-2 both work. */
  private power(): Node {
    let left = this.unary();
    while (this.opIs("^")) { this.eat(); left = { t: "binary", op: "^", left, right: this.unary() }; }
    return left;
  }
  /** Unary binds to a single percent/atom, NOT to a whole power expression. */
  private unary(): Node {
    if (this.opIs("-")) { this.eat(); return { t: "unary", op: "-", arg: this.unary() }; }
    if (this.opIs("+")) { this.eat(); return { t: "unary", op: "+", arg: this.unary() }; }
    return this.percent();
  }
  private percent(): Node {
    let node = this.atom();
    while (this.opIs("%")) { this.eat(); node = { t: "percent", arg: node }; }
    return node;
  }

  private atom(): Node {
    const t = this.peek();
    if (t.kind === "num") {
      this.eat();
      // BUG FIX (found by the oracle verification run): the lexer folds a
      // trailing '%' into the number TOKEN TEXT for lookahead convenience, but
      // the parser was silently stripping it instead of emitting a percent
      // node, so "10%" parsed as the plain number 10 instead of 0.1.
      if (t.text.endsWith("%")) return { t: "percent", arg: { t: "num", v: Number(t.text.slice(0, -1)) } };
      return { t: "num", v: Number(t.text) };
    }
    if (t.kind === "str") { this.eat(); return { t: "str", v: t.text }; }
    if (t.kind === "err") { this.eat(); return { t: "err", v: t.text as ErrorCode }; }
    if (t.kind === "lparen") { this.eat(); const inner = this.comparison(); this.eat("rparen"); return inner; }
    if (t.kind === "lbrace") return this.array();
    if (t.kind === "ref") {
      this.eat();
      const from = parseCellToken(t.text);
      if (this.at("colon")) {
        this.eat();
        const toTok = this.eat("ref");
        const to = parseCellToken(toTok.text);
        return { t: "range", v: { from, to } };
      }
      return { t: "ref", v: from };
    }
    if (t.kind === "ident") {
      this.eat();
      const upper = t.text.toUpperCase();
      if ((upper === "TRUE" || upper === "FALSE") && !this.at("lparen")) return { t: "bool", v: upper === "TRUE" };
      if (this.at("lparen")) {
        this.eat();
        const args: Node[] = [];
        if (!this.at("rparen")) {
          args.push(this.comparison());
          while (this.at("comma")) { this.eat(); args.push(this.comparison()); }
        }
        this.eat("rparen");
        if (upper === "TRUE" && args.length === 0) return { t: "bool", v: true };
        if (upper === "FALSE" && args.length === 0) return { t: "bool", v: false };
        return { t: "call", name: upper, args };
      }
      // TT19: a bare identifier is a defined name; an unknown one evaluates to #NAME? (as in Excel)
      return { t: "name", name: t.text };
    }
    throw new Error(`unexpected token "${t.text || "<end>"}" at ${t.pos}`);
  }

  /** {1,2;3,4}: comma separates columns, semicolon separates rows (verified). */
  private array(): Node {
    this.eat("lbrace");
    const rows: Node[][] = [[]];
    rows[0].push(this.arrayCell());
    for (;;) {
      if (this.at("comma")) { this.eat(); rows[rows.length - 1].push(this.arrayCell()); continue; }
      if (this.at("semicolon")) { this.eat(); rows.push([this.arrayCell()]); continue; }
      break;
    }
    this.eat("rbrace");
    return { t: "array", rows };
  }
  /** Array literal cells are constants only (no nested formulas), per the grammar. */
  private arrayCell(): Node {
    const t = this.peek();
    if (t.kind === "num") { this.eat(); return { t: "num", v: Number(t.text) }; }
    if (t.kind === "str") { this.eat(); return { t: "str", v: t.text }; }
    if (t.kind === "err") { this.eat(); return { t: "err", v: t.text as ErrorCode }; }
    if (t.kind === "ident" && (t.text.toUpperCase() === "TRUE" || t.text.toUpperCase() === "FALSE")) {
      this.eat(); return { t: "bool", v: t.text.toUpperCase() === "TRUE" };
    }
    if (this.opIs("-")) { this.eat(); const inner = this.arrayCell(); return { t: "unary", op: "-", arg: inner }; }
    throw new Error(`array literals may only contain constants, found "${t.text}"`);
  }
}

export function parseFormula(src: string): Node {
  return new Parser(tokenize(src)).parseFormula();
}
