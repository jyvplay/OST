/** Independent scientific/units checks, including a nonfinite-result rejection baseline. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { evaluate } from "../src/lib/calc.ts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt96-scientific-units");
const cov = { "PR-09": "partial", "SR-06": "partial" } as const;
const near = (expression: string, expected: number, epsilon = 1e-12) => {
  const result = evaluate(expression); assert.equal(result.ok, true, `${expression}: ${result.text}`);
  assert.ok(typeof result.value === "number" && Math.abs(result.value - expected) <= epsilon * Math.max(1, Math.abs(expected)), `${expression}: ${result.value} vs ${expected}`);
};
await test("basic scientific precedence and finite-domain errors", cov, () => {
  near("-2^2", -4); near("(-2)^2", 4); near("2^3^2", 512); near("7%4", 3);
  for (const input of ["1/0", "1%0", "sqrt(-1)", "ln(0)", "10^1000", "1+", "constructor.constructor('x')()", "sin("]) assert.equal(evaluate(input).ok, false, input);
});
await test("trigonometric and logarithmic results agree with Python math", cov, () => {
  const code = "import json,math; print(json.dumps([math.sin(1.4),math.cos(-0.75),math.atan(2),math.log(2),math.log10(1000),math.log2(64),math.sqrt(7),math.exp(-2)]))";
  const expected = JSON.parse(execFileSync("python3", ["-c", code], { encoding: "utf8" })) as number[];
  ["sin(1.4)", "cos(-0.75)", "atan(2)", "ln(2)", "log(1000)", "log2(64)", "sqrt(7)", "exp(-2)"].forEach((expression, i) => near(expression, expected[i]));
});
await test("selected physical and binary-storage conversions use the declared dimensions", cov, () => {
  for (const [expression, expected] of [["1 in to cm", 2.54], ["1 mi to km", 1.609344], ["2 kg to g", 2000], ["60 s to min", 1], ["1 gb to mb", 1024], ["24 h to d", 1]] as const) near(expression, expected);
  assert.equal(evaluate("1 kg to m").ok, false); assert.equal(evaluate("1 nonexistent to m").ok, false);
  assert.equal(evaluate("1 constructor to constructor").ok, false); assert.equal(evaluate("1e309 m to m").ok, false);
});
await test("all configured unit pairs agree with an independent Decimal oracle", cov, () => {
  const rows = JSON.parse(execFileSync("python3", ["scripts/oracle/tt97-unit-conversions.py"], { encoding: "utf8", maxBuffer: 1024 * 1024 })) as { expression: string; expected: string }[];
  assert.equal(rows.length, 1300);
  for (const { expression, expected } of rows) {
    const result = evaluate(expression);
    if (expected === "overflow") { assert.equal(result.ok, false, `${expression}: ${result.text}`); continue; }
    const reference = Number(expected);
    assert.ok(result.ok && typeof result.value === "number" && Number.isFinite(result.value), `${expression}: ${result.text}`);
    // A small binary64 relative tolerance plus four minimum subnormals: the
    // runtime rounds the unit factors, whereas Decimal rounds only the final result.
    const tolerance = Math.abs(reference) * 3e-15 + Number.MIN_VALUE * 4;
    assert.ok(Math.abs(result.value - reference) <= tolerance, `${expression}: ${result.value} vs ${reference}`);
  }
});
await test("large identity conversion avoids intermediate overflow", cov, () => {
  near("1e308 km to km", 1e308);
  near("-1e308 km to km", -1e308);
  near("1e308 km to mi", 1e308 / 1.609344);
  near("1e308 mm to km", 1e302);
});
await test("unit conversion never claims an infinite result succeeded", cov, () => {
  for (const expression of ["1e308 km to mm", "-1e308 km to mm", "1e308 tb to b"]) {
    const result = evaluate(expression); assert.equal(result.ok, false, `${expression}: ${result.text}`);
  }
});
finish();
