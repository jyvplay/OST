/**
 * One evaluator, used by both the Calculator module and the command palette
 * (PR-09 / SR-06) so the two surfaces can never disagree.
 * Recursive descent: no eval(), no Function(), no dependency.
 */

const FUNCS: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sqrt: Math.sqrt, ln: Math.log, log: Math.log10, log2: Math.log2, abs: Math.abs,
  round: Math.round, floor: Math.floor, ceil: Math.ceil, exp: Math.exp, sign: Math.sign,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const UNITS: Record<string, { base: string; f: number }> = {
  mm: { base: "m", f: 0.001 }, cm: { base: "m", f: 0.01 }, m: { base: "m", f: 1 }, km: { base: "m", f: 1000 },
  in: { base: "m", f: 0.0254 }, ft: { base: "m", f: 0.3048 }, yd: { base: "m", f: 0.9144 }, mi: { base: "m", f: 1609.344 },
  g: { base: "kg", f: 0.001 }, kg: { base: "kg", f: 1 }, lb: { base: "kg", f: 0.45359237 }, oz: { base: "kg", f: 0.028349523 },
  b: { base: "B", f: 1 }, kb: { base: "B", f: 1024 }, mb: { base: "B", f: 1024 ** 2 }, gb: { base: "B", f: 1024 ** 3 }, tb: { base: "B", f: 1024 ** 4 },
  ms: { base: "s", f: 0.001 }, s: { base: "s", f: 1 }, min: { base: "s", f: 60 }, h: { base: "s", f: 3600 }, d: { base: "s", f: 86400 },
};

export interface CalcResult { ok: boolean; value?: number; text: string; detail?: string }

export function evaluate(input: string): CalcResult {
  const src = input.trim();
  if (!src) return { ok: false, text: "" };

  // unit conversion:  "12 cm to in" / "4 gb in mb"
  const conv = /^([-\d.eE+]+)\s*([a-zA-Z]+)\s+(?:to|in)\s+([a-zA-Z]+)$/.exec(src);
  if (conv) {
    const [, nRaw, fromU, toU] = conv;
    const a = UNITS[fromU.toLowerCase()];
    const b = UNITS[toU.toLowerCase()];
    const n = Number(nRaw);
    if (a && b && a.base === b.base && Number.isFinite(n)) {
      const value = (n * a.f) / b.f;
      return { ok: true, value, text: `${trim(value)} ${toU}`, detail: `${nRaw} ${fromU} → ${toU}` };
    }
    if (a && b) return { ok: false, text: `cannot convert ${a.base} to ${b.base}` };
  }

  // radix literals
  if (/^0x[0-9a-f]+$/i.test(src)) {
    const v = parseInt(src.slice(2), 16);
    return { ok: true, value: v, text: String(v), detail: `hex ${src} · bin 0b${v.toString(2)}` };
  }
  if (/^0b[01]+$/i.test(src)) {
    const v = parseInt(src.slice(2), 2);
    return { ok: true, value: v, text: String(v), detail: `bin ${src} · hex 0x${v.toString(16)}` };
  }

  try {
    const p = new Parser(src);
    const v = p.parseExpression();
    p.expectEnd();
    if (!Number.isFinite(v)) return { ok: false, text: "not a finite number" };
    return {
      ok: true, value: v, text: trim(v),
      detail: Number.isInteger(v) && Math.abs(v) < 2 ** 32 ? `hex 0x${(v >>> 0).toString(16)} · bin 0b${(v >>> 0).toString(2)}` : undefined,
    };
  } catch (err) {
    return { ok: false, text: String((err as Error).message) };
  }
}

/** Fixed rounding policy, stated in the UI: 12 significant digits, trailing zeros removed. */
function trim(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(12)));
}

class Parser {
  private i = 0;
  private s: string;
  constructor(s: string) { this.s = s; }
  private ws() { while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1; }
  private peek() { this.ws(); return this.s[this.i]; }
  private eat(ch: string) { this.ws(); if (this.s[this.i] === ch) { this.i += 1; return true; } return false; }
  expectEnd() { this.ws(); if (this.i < this.s.length) throw new Error(`unexpected "${this.s.slice(this.i, this.i + 8)}"`); }

  parseExpression(): number {
    let v = this.parseTerm();
    for (;;) {
      if (this.eat("+")) v += this.parseTerm();
      else if (this.eat("-")) v -= this.parseTerm();
      else return v;
    }
  }
  private parseTerm(): number {
    let v = this.parseUnary();
    for (;;) {
      if (this.eat("*")) v *= this.parseUnary();
      else if (this.eat("/")) {
        const d = this.parseUnary();
        if (d === 0) throw new Error("division by zero");
        v /= d;
      } else if (this.eat("%")) {
        const d = this.parseUnary();
        v %= d;
      } else return v;
    }
  }
  private parseUnary(): number {
    if (this.eat("-")) return -this.parseUnary();
    if (this.eat("+")) return this.parseUnary();
    return this.parsePower();
  }
  private parsePower(): number {
    const base = this.parseAtom();
    if (this.eat("^")) return base ** this.parseUnary();
    return base;
  }
  private parseAtom(): number {
    this.ws();
    if (this.eat("(")) {
      const v = this.parseExpression();
      if (!this.eat(")")) throw new Error("missing )");
      return v;
    }
    const num = /^[0-9]*\.?[0-9]+(e[-+]?[0-9]+)?/i.exec(this.s.slice(this.i));
    if (num) { this.i += num[0].length; return Number(num[0]); }
    const word = /^[a-z_][a-z0-9_]*/i.exec(this.s.slice(this.i));
    if (word) {
      const name = word[0].toLowerCase();
      this.i += word[0].length;
      if (this.peek() === "(") {
        this.eat("(");
        const arg = this.parseExpression();
        if (!this.eat(")")) throw new Error("missing )");
        const fn = FUNCS[name];
        if (!fn) throw new Error(`unknown function ${name}`);
        return fn(arg);
      }
      if (name in CONSTS) return CONSTS[name];
      throw new Error(`unknown name ${name}`);
    }
    throw new Error("expected a number");
  }
}
