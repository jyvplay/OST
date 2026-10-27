/** Bounded programmer-mode contract; the Python oracle is separate from the JS parser. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { evaluate } from "../src/lib/calc.ts";
import { makeHarness } from "./harness.mts";

const { test, finish } = makeHarness("tt96-programmer");
const covers = { "PR-09": "partial" } as const;
type R = { ok: boolean; text: string; hex?: string; oct?: string; bin?: string };
// Before implementation this deliberately exercises the existing calculator,
// rather than treating a missing module/import crash as an informative baseline.
const program = existsSync(new URL("../src/lib/programmer.ts", import.meta.url)) ? await import("../src/lib/programmer.ts") : null;
const run = (s: string, width = 32, signed = false): R => program ? program.evaluateProgrammer(s, width, signed) : evaluate(s);
const eq = (s: string, width: number, signed: boolean, expected: string) => {
  const r = run(s, width, signed); assert.equal(r.ok, true, `${s}: ${r.text}`); assert.equal(r.text, expected, s);
};

await test("the original scientific evaluator and rounding policy stay available", covers, () => {
  assert.equal(evaluate("2+2*3").text, "8"); assert.equal(evaluate("2^3^2").text, "512");
  assert.equal(evaluate("sqrt(144)").text, "12"); assert.equal(evaluate("0.1+0.2").text, "0.3");
  assert.equal(evaluate("12 cm to in").ok, true); assert.equal(evaluate("1/0").ok, false);
  assert.equal(evaluate("0x1fffffffffffff").text, "9007199254740991");
  assert.equal(evaluate("0xffffffffffffffff").ok, false, "standard mode must not silently round a large radix literal");
});
await test("bitwise AND, OR, XOR and NOT use the selected fixed width", covers, () => {
  eq("0xff & 0x0f", 8, false, "15"); eq("0b1010 | 0b0101", 8, false, "15");
  eq("0b1010 ^ 0b1100", 8, false, "6"); eq("~0", 8, false, "255"); eq("~0", 8, true, "-1");
});
await test("word arithmetic wraps at 8, 16, 32 and 64 bits", covers, () => {
  for (const bits of [8, 16, 32, 64]) {
    const max = (1n << BigInt(bits)) - 1n;
    eq(`0x${max.toString(16)} + 1`, bits, false, "0");
    eq("0 - 1", bits, false, max.toString());
    eq("0 - 1", bits, true, "-1");
  }
});
await test("64-bit values remain exact beyond Number.MAX_SAFE_INTEGER", covers, () => {
  eq("0xffffffffffffffff", 64, false, "18446744073709551615");
  eq("0x20000000000001 + 1", 64, false, "9007199254740994");
  const r = run("0xffffffffffffffff", 64, false); assert.equal(r.hex?.toLowerCase(), "ffffffffffffffff"); assert.equal(r.bin?.length, 64);
  assert.equal(run("1", 64, false).bin, "0".repeat(63) + "1");
});
await test("signed division truncates toward zero and right shift sign-extends only when signed", covers, () => {
  eq("0xfb / 2", 8, true, "-2"); eq("0xfb % 2", 8, true, "-1");
  eq("0x80 >> 7", 8, true, "-1"); eq("0x80 >> 7", 8, false, "1");
  eq("1 << 7", 8, false, "128"); eq("1 << 7", 8, true, "-128");
  eq("1 << 256", 8, false, "1"); // count wraps to zero as an 8-bit intermediate
});
await test("operator precedence and grouping follow the documented programmer grammar", covers, () => {
  eq("1 + 2 << 3 & 0x1f ^ 1 | 2", 8, false, "27");
  eq("(1 + 2) * 4", 8, false, "12"); eq("~(1 | 2)", 8, false, "252");
  eq("0o17 + 0b1", 8, false, "16");
});
await test("invalid or resource-abusive programmer expressions fail closed", covers, () => {
  for (const s of ["1 / 0", "1 % 0", "1 << 8", "1 >> -1", "1 >>> 1", "1.5", "0x", "0xzz", "0b2", "0o8", "1 2", "1<<<<2", "1;alert(1)", "sqrt(4)", "2**3", "process.exit()", "constructor", "1 |", "(".repeat(90) + "1" + ")".repeat(90), "~".repeat(70) + "1", "9".repeat(600), " ".repeat(513) + "1"]) {
    assert.equal(run(s, 8, false).ok, false, s.slice(0, 30));
  }
  assert.equal(run("1", 7, false).ok, false);
});
await test("fixed-width operations match an independent deterministic Python oracle", covers, () => {
  const cases = JSON.parse(execFileSync("python3", ["scripts/oracle/tt96-programmer.py"], { encoding: "utf8", maxBuffer: 8_000_000 })) as { expression: string; bits: number; signed: boolean; result: string }[];
  assert.ok(cases.length >= 1000);
  for (const c of cases) eq(c.expression, c.bits, c.signed, c.result);
});
finish();
