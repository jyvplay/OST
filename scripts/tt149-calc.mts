/**
 * TT149 — Calculator breadth, against an independent oracle (PR-09).
 *
 * The row's stated gap was "full scientific/keypad/unit breadth ... is not
 * established". Breadth is a claim about coverage, so it needs a corpus bigger
 * than a handful of examples, and the corpus needs an implementation to compare
 * against that is not the one under test:
 *
 *   scientific   Python's `math` (glibc libm) vs this engine's `Math`. Two
 *                different implementations of the same IEEE-754 operations;
 *                agreement inside 1e-12 relative is evidence. Constants are
 *                compared against the oracle's value too, so a literal 3.14159
 *                in the app would fail.
 *   units        exact rational factors (`fractions.Fraction`) — 1 in is 2.54 cm
 *                by definition, not by measurement, so the expectation carries
 *                zero float error and the tolerance can stay at 1e-15.
 *   programmer   400 deterministic pairs against Python big integers with
 *                explicit two's-complement masks, across 8/16/32/64 bits and
 *                both signednesses, including truncating division and remainder.
 *   refusals     eight inputs that must be refused rather than answered with
 *                NaN, Infinity or a fabricated conversion.
 *
 * The oracle is a frozen fixture (`docs/test-fixtures/calc-oracle.json`, made by
 * `scripts/oracle/calc_oracle.py`), so this suite needs no Python at test time
 * and cannot drift with the sandbox.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { evaluate } from "../src/lib/calc";
import { evaluateProgrammer } from "../src/lib/programmer";

const { test, finish } = makeHarness("tt149-calc");

type Vec = { expr: string; value: number; rel: number; exact?: string };
type Prog = { expr: string; width: number; signed: boolean; unsignedText: string; unsignedHex: string; signedText: string };
const oracle = JSON.parse(readFileSync("docs/test-fixtures/calc-oracle.json", "utf8")) as {
  generator: string; python: string;
  scientific: Vec[]; units: Vec[]; programmer: Prog[]; refusals: { expr: string; why: string }[];
};

/** The app's own formatting rounds non-integers to 12 significant digits, so
 *  compare the numeric value it reports to the oracle within a stated band. */
function close(got: number, want: number, rel: number): boolean {
  if (Number.isNaN(got) || Number.isNaN(want)) return false;
  if (want === 0) return Math.abs(got) <= Math.max(rel, 1e-12);
  return Math.abs(got - want) / Math.abs(want) <= rel;
}

await test("PR-09 scientific functions agree with libm across the grid", { "PR-09": "full" }, () => {
  assert.ok(oracle.scientific.length >= 100, `the corpus shrank to ${oracle.scientific.length}`);
  const failures: string[] = [];
  for (const v of oracle.scientific) {
    const r = evaluate(v.expr);
    if (!r.ok || typeof r.value !== "number") { failures.push(`${v.expr} → refused (${r.text})`); continue; }
    if (!close(r.value, v.value, Math.max(v.rel, 1e-12))) failures.push(`${v.expr} → ${r.value} vs ${v.value}`);
  }
  assert.deepEqual(failures, [], `${failures.length} of ${oracle.scientific.length} disagreed with libm`);
});

await test("PR-09 integer-valued scientific expressions are exact, not merely close", { "PR-09": "full" }, () => {
  for (const v of oracle.scientific.filter((x) => x.exact && Number.isInteger(x.value))) {
    const r = evaluate(v.expr);
    assert.equal(r.ok, true, `${v.expr} was refused: ${r.text}`);
    assert.equal(r.value, v.value, `${v.expr} = ${r.value}, oracle says ${v.value} (exactly ${v.exact})`);
  }
  // Precedence, stated as the cases that are usually wrong.
  assert.equal(evaluate("2+3*4").value, 14);
  assert.equal(evaluate("(2+3)*4").value, 20);
  assert.equal(evaluate("2-3-4").value, -5);
  assert.equal(evaluate("2^3^2").value, 512, "power is right-associative");
  assert.equal(evaluate("-2^2").value, -4, "unary minus binds looser than power");
});

await test("PR-09 unit conversions match exact rational definitions", { "PR-09": "full" }, () => {
  assert.ok(oracle.units.length >= 10);
  for (const v of oracle.units) {
    const r = evaluate(v.expr);
    assert.equal(r.ok, true, `${v.expr} was refused: ${r.text}`);
    assert.ok(close(r.value!, v.value, 1e-15), `${v.expr} → ${r.value} vs exact ${v.value} (${v.exact})`);
  }
});

await test("PR-09 programmer mode matches Python integers over 400 pairs and four word widths", { "PR-09": "full" }, () => {
  // Two independent assertions per pair, because either alone could pass by
  // formatting luck: the hex field must be the exact two's-complement pattern,
  // and the decimal field must be the signed or unsigned reading of it.
  const failures: string[] = [];
  for (const v of oracle.programmer) {
    const r = evaluateProgrammer(v.expr, v.width, v.signed);
    const tag = `${v.expr} (${v.width}${v.signed ? "s" : "u"})`;
    if (!r.ok) { failures.push(`${tag} refused: ${r.text}`); continue; }
    // Compare strings, not numbers: a 64-bit unsigned result above 2^53 is not
    // representable as a float64, so a numeric comparison would silently pass a
    // wrong answer (the first version of this suite did exactly that).
    // BigInt, not Number: exact for 64 bits, and it tolerates the app's
    // zero-padded fixed-width hex without weakening the comparison.
    const hex = BigInt("0x" + r.hex.replace(/^0x/i, ""));
    if (hex !== BigInt("0x" + v.unsignedHex)) { failures.push(`${tag} hex ${r.hex} ≠ ${v.unsignedHex}`); continue; }
    const expectedDecimal = v.signed ? v.signedText : v.unsignedText;
    if (r.text !== expectedDecimal) failures.push(`${tag} text ${r.text} ≠ ${expectedDecimal}`);
  }
  assert.deepEqual(failures.slice(0, 6), [], `${failures.length} of ${oracle.programmer.length} disagreed with Python`);
});

await test("PR-09 refusals: eight impossible inputs are refused instead of answered with NaN", { "PR-09": "full" }, () => {
  for (const v of oracle.refusals) {
    const r = evaluate(v.expr);
    assert.equal(r.ok, false, `${v.expr} (${v.why}) was answered as ${r.text}`);
    assert.doesNotMatch(r.text, /NaN|Infinity/i, `${v.expr} leaked a non-finite value in its message: ${r.text}`);
    assert.ok(r.text.length > 0, `${v.expr} was refused with no explanation`);
  }
});

await test("PR-09 the oracle fixture is the artefact this suite claims (and it says who made it)", { "PR-09": "full" }, () => {
  assert.equal(oracle.generator, "scripts/oracle/calc_oracle.py");
  assert.match(oracle.python, /^3\./);
  assert.ok(oracle.programmer.length >= 400, "the programmer corpus is a fixed size, not a sample of convenience");
});

finish();
