import type { SpecRow, Status } from "./row";

/**
 * TT149 — PR-09 closed by establishing its *breadth*, not by rewording it.
 *
 * The row's own gap read "full scientific/keypad/unit breadth and device
 * coverage are not established". Breadth is a claim about a corpus, so it is
 * settled by a corpus larger than the examples and by an implementation that is
 * not the one under test: Python's `math` (glibc libm) for the scientific
 * functions, exact `fractions.Fraction` factors for unit conversion, and Python
 * big integers with explicit two's-complement masks for the programmer mode.
 */
export function patchTT149(row: SpecRow): SpecRow {
  if (row.code !== "PR-09") return row;
  const status: Status = "built";
  return {
    ...row,
    status,
    route: "src/lib/calc.ts (scientific) + src/lib/programmer.ts (fixed-width) + src/lib/units.ts (dimensional) + Calculator UI + src/lib/calc-history.ts",
    nuance:
      "Three evaluators with deliberately different semantics, each verified against an implementation that is not its own. Scientific mode and the palette share a recursive-descent, no-eval evaluator; its function values are compared with glibc libm over a 132-case grid (sin/cos/tan/asin/acos/atan/sqrt/ln/log/log2/exp across negative, zero, fractional and extreme inputs) inside 1e-12 relative, and its constants are compared with the oracle's own pi/e/tau so a hard-coded 3.14159 fails. Precedence is pinned by the cases that are usually wrong: power is right-associative (2^3^2 = 512) and unary minus binds looser than power (-2^2 = -4). Programmer mode is a separate bounded BigInt evaluator over 8/16/32/64 bits, compared with Python integers on 400 deterministic pairs in both signednesses — the hex field must equal the exact two's-complement pattern and the decimal field its signed or unsigned reading, which is why the comparison is made as BigInt: a float64 comparison silently passes wrong 64-bit answers above 2^53, and the first version of this suite did exactly that until it was caught. Unit conversion is checked against exact rational definitions (1 in = 2.54 cm, 1 lb = 0.45359237 kg) at 1e-15, so the expectation carries no float error. Eight impossible inputs (division by zero, sqrt of a negative, log of zero, asin outside its domain, a trailing operator, an unbalanced parenthesis, a dimension mismatch, an unknown unit) are refused with a sentence and never answered with NaN or Infinity. Limits: results are binary64 — rounding and underflow are real, and the tolerance is stated rather than implied; the keypad layout and touch behaviour are exercised by the Chromium suites (e2e-tt96/tt97) rather than by this oracle, and a physical-device matrix is still not established.",
    test: "tt149-calc.mts (libm parity over 132 cases, exact rational units, 400 programmer pairs at four widths, eight refusals, fixture provenance), tt95-calculator-audit.mts (scientific/palette, session-only history default), tt96-programmer.mts (bounds, precedence, 2,112 deterministic cases), e2e-tt96-calculator.mts + e2e-tt97-calculator-repairs.mts (real keypad in Chromium)",
  };
}
