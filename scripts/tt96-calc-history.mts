/** Storage fault doubles; the companion Chromium suite exercises real Web Storage. */
import assert from "node:assert/strict";
import { appendCalculatorHistory, CALC_HISTORY_KEEP, CALC_HISTORY_LIMIT, CALC_HISTORY_PREFIX, deleteCalculatorHistory, readCalculatorHistory, type CalculatorEntry } from "../src/lib/calc-history.ts";
import { makeHarness } from "./harness.mts";
const { test, finish } = makeHarness("tt96-calc-history");
const cov = { "PR-09": "partial" } as const;
class FakeStorage implements Storage {
  [name: string]: unknown;
  data = new Map<string, string>();
  failSet = false;
  failRemove = false;
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { if (this.failRemove) throw Error("remove denied"); this.data.delete(key); }
  setItem(key: string, value: string) { if (this.failSet) throw Error("quota denied"); this.data.set(key, value); }
}
const entry = (i: number): CalculatorEntry => ({ id: `entry-${i}`, expr: `${i}+1`, text: String(i + 1), mode: "programmer", width: 64, signed: false, at: i });
await test("bounded independent records retain the newest forty", cov, () => {
  const storage = new FakeStorage(); for (let i = 0; i < 50; i++) appendCalculatorHistory(storage, entry(i));
  const values = readCalculatorHistory(storage); assert.equal(values.length, CALC_HISTORY_LIMIT);
  assert.equal(values[0].id, "entry-49"); assert.equal(values.at(-1)?.id, "entry-10");
  assert.equal(storage.length, CALC_HISTORY_LIMIT);
});
await test("duplicate ids never overwrite a saved entry", cov, () => {
  const storage = new FakeStorage(); appendCalculatorHistory(storage, entry(1));
  const original = storage.getItem(CALC_HISTORY_PREFIX + "entry-1");
  assert.throws(() => appendCalculatorHistory(storage, { ...entry(1), expr: "different" }), /collision/);
  assert.equal(storage.getItem(CALC_HISTORY_PREFIX + "entry-1"), original);
});
await test("malformed, mismatched and oversized records are not repaired or overwritten silently", cov, () => {
  const shapes = ["{bad", "null", "[]", JSON.stringify({ ...entry(1), id: "wrong" }), JSON.stringify({ ...entry(1), mode: "other" }), JSON.stringify({ ...entry(1), width: 7 }), JSON.stringify({ ...entry(1), signed: "no" }), JSON.stringify({ ...entry(1), at: -1 }), JSON.stringify({ ...entry(1), expr: "x".repeat(513) })];
  for (const raw of shapes) {
    const storage = new FakeStorage(); const key = CALC_HISTORY_PREFIX + "entry-1"; storage.setItem(key, raw);
    assert.throws(() => readCalculatorHistory(storage)); assert.throws(() => appendCalculatorHistory(storage, entry(2)));
    assert.equal(storage.getItem(key), raw); assert.equal(storage.getItem(CALC_HISTORY_PREFIX + "entry-2"), null);
  }
});
await test("explicit deletion removes only calculator records, including corrupt ones", cov, () => {
  const storage = new FakeStorage(); storage.setItem(CALC_HISTORY_KEEP, "1"); storage.setItem("unrelated", "keep"); storage.setItem(CALC_HISTORY_PREFIX + "bad", "{");
  deleteCalculatorHistory(storage); assert.equal(storage.getItem(CALC_HISTORY_KEEP), "1"); assert.equal(storage.getItem("unrelated"), "keep"); assert.equal(storage.getItem(CALC_HISTORY_PREFIX + "bad"), null);
});
await test("write refusal preserves older data and pruning failure can leave the new entry", cov, () => {
  const storage = new FakeStorage(); for (let i = 0; i < 40; i++) appendCalculatorHistory(storage, entry(i));
  storage.failSet = true; assert.throws(() => appendCalculatorHistory(storage, entry(40)), /quota/);
  assert.equal(readCalculatorHistory(storage).length, 40); assert.equal(storage.getItem(CALC_HISTORY_PREFIX + "entry-40"), null);
  storage.failSet = false; storage.failRemove = true; assert.throws(() => appendCalculatorHistory(storage, entry(40)), /remove denied/);
  assert.notEqual(storage.getItem(CALC_HISTORY_PREFIX + "entry-40"), null); assert.equal(readCalculatorHistory(storage).length, 41);
});
await test("excessive or invalid input is rejected without discarding prior records", cov, () => {
  const storage = new FakeStorage(); appendCalculatorHistory(storage, entry(1));
  for (const invalid of [{ ...entry(2), expr: "" }, { ...entry(2), expr: "x".repeat(513) }, { ...entry(2), text: "x".repeat(1025) }, { ...entry(2), id: "../bad" }, { ...entry(2), width: 128 }]) {
    assert.throws(() => appendCalculatorHistory(storage, invalid));
  }
  assert.equal(readCalculatorHistory(storage).length, 1);
  const excessive = new FakeStorage(); for (let i = 0; i < 1001; i++) excessive.setItem(CALC_HISTORY_PREFIX + i, "{}");
  assert.throws(() => readCalculatorHistory(excessive), /Too many/);
  deleteCalculatorHistory(excessive); assert.equal(excessive.length, 0);
});
finish();
