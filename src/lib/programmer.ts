/**
 * Bounded, local fixed-width integer calculator. No eval, Function or network.
 *
 * Grammar, from lowest to highest precedence: |, ^ (XOR), &, << / >>,
 * + / -, * / / / %, unary + / - / ~, then parentheses and 0x/0b/0o/decimal
 * integer literals. Unlike the scientific calculator, ^ means XOR here.
 * Every intermediate result wraps modulo 2^width. Signed mode interprets
 * division, remainder, right shift and decimal output as two's complement;
 * unsigned mode uses logical right shift. Division truncates toward zero.
 * Shift counts are evaluated as word-sized values under the selected signedness;
 * counts outside [0,width) after wrapping are rejected rather than masked.
 */

export type ProgrammerResult =
  | { ok: true; text: string; hex: string; oct: string; bin: string }
  | { ok: false; text: string };

const WIDTHS = new Set([8, 16, 32, 64]);
const MAX_LENGTH = 512;
const MAX_NESTING = 64;

export function evaluateProgrammer(input: string, width = 32, signed = false): ProgrammerResult {
  if (typeof input !== "string") return { ok: false, text: "Expression must be text" };
  if (!WIDTHS.has(width) || typeof signed !== "boolean") return { ok: false, text: "Invalid word format" };
  if (input.length > MAX_LENGTH) return { ok: false, text: `Expression exceeds ${MAX_LENGTH} characters` };
  const source = input.trim();
  if (!source) return { ok: false, text: "" };
  try {
    const parser = new IntegerParser(source, width, signed);
    const value = parser.parse();
    const decimal = signed ? BigInt.asIntN(width, value) : value;
    return {
      ok: true,
      text: decimal.toString(10),
      hex: value.toString(16).padStart(width / 4, "0"),
      oct: value.toString(8).padStart(Math.ceil(width / 3), "0"),
      bin: value.toString(2).padStart(width, "0"),
    };
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : "Invalid expression" };
  }
}

class IntegerParser {
  private offset = 0;
  private depth = 0;
  private readonly source: string;
  private readonly width: number;
  private readonly signed: boolean;

  constructor(source: string, width: number, signed: boolean) {
    this.source = source;
    this.width = width;
    this.signed = signed;
  }

  private wrap(value: bigint) { return BigInt.asUintN(this.width, value); }
  private numeric(value: bigint) { return this.signed ? BigInt.asIntN(this.width, value) : value; }
  private space() { while (/\s/.test(this.source[this.offset] ?? "") && this.offset < this.source.length) this.offset++; }
  private take(token: string) {
    this.space();
    if (!this.source.startsWith(token, this.offset)) return false;
    this.offset += token.length;
    return true;
  }
  private nested<T>(f: () => T): T {
    if (++this.depth > MAX_NESTING) throw new Error(`Expression nesting exceeds ${MAX_NESTING}`);
    try { return f(); } finally { this.depth--; }
  }

  parse() {
    const value = this.or();
    this.space();
    if (this.offset !== this.source.length) throw new Error(`Unexpected input at ${this.offset + 1}`);
    return value;
  }
  private or(): bigint {
    let value = this.xor();
    while (this.take("|")) value = this.wrap(value | this.xor());
    return value;
  }
  private xor(): bigint {
    let value = this.and();
    while (this.take("^")) value = this.wrap(value ^ this.and());
    return value;
  }
  private and(): bigint {
    let value = this.shift();
    while (this.take("&")) value = this.wrap(value & this.shift());
    return value;
  }
  private shift(): bigint {
    let value = this.add();
    for (;;) {
      const direction = this.take("<<") ? "left" : this.take(">>") ? "right" : null;
      if (!direction) return value;
      const count = this.numeric(this.add());
      if (count < BigInt(0) || count >= BigInt(this.width)) throw new Error(`Shift count must be between 0 and ${this.width - 1}`);
      value = this.wrap(direction === "left" ? value << count : this.numeric(value) >> count);
    }
  }
  private add(): bigint {
    let value = this.multiply();
    for (;;) {
      if (this.take("+")) value = this.wrap(value + this.multiply());
      else if (this.take("-")) value = this.wrap(value - this.multiply());
      else return value;
    }
  }
  private multiply(): bigint {
    let value = this.unary();
    for (;;) {
      if (this.take("*")) value = this.wrap(value * this.unary());
      else if (this.take("/")) {
        const divisor = this.numeric(this.unary());
        if (divisor === BigInt(0)) throw new Error("Division by zero");
        value = this.wrap(this.numeric(value) / divisor);
      } else if (this.take("%")) {
        const divisor = this.numeric(this.unary());
        if (divisor === BigInt(0)) throw new Error("Division by zero");
        value = this.wrap(this.numeric(value) % divisor);
      } else return value;
    }
  }
  private unary(): bigint {
    if (this.take("+")) return this.nested(() => this.unary());
    if (this.take("-")) return this.nested(() => this.wrap(-this.unary()));
    if (this.take("~")) return this.nested(() => this.wrap(~this.unary()));
    return this.atom();
  }
  private atom(): bigint {
    if (this.take("(")) {
      const value = this.nested(() => this.or());
      if (!this.take(")")) throw new Error("Missing closing parenthesis");
      return value;
    }
    this.space();
    const number = /^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+)/.exec(this.source.slice(this.offset));
    if (!number) throw new Error(`Expected an integer at ${this.offset + 1}`);
    this.offset += number[0].length;
    return this.wrap(BigInt(number[0]));
  }
}
