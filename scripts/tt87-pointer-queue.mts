import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import { createPointerSampleQueue, MAX_POINTER_SAMPLES_PER_FRAME, type PointerSample } from "../src/lib/pointer-triggers.ts";
const { test, finish } = makeHarness("tt87-pointer-queue");
const sample = (x: number): PointerSample => ({ x, y: 20, width: 800, height: 600, at: x });

await test("SH-06 bounded pointer queue preserves all 256 samples in order and drains exactly once", { "SH-06": "partial" }, () => {
  const q = createPointerSampleQueue();
  for (let i = 0; i < MAX_POINTER_SAMPLES_PER_FRAME; i++) q.push(sample(i));
  assert.equal(q.size, MAX_POINTER_SAMPLES_PER_FRAME);
  const r = q.drain(); assert.equal(r.reset, false); assert.deepEqual(r.batch.map((s) => s.x), Array.from({ length: MAX_POINTER_SAMPLES_PER_FRAME }, (_, i) => i));
  assert.equal(q.size, 0); assert.deepEqual(q.drain(), { batch: [], reset: false });
});
await test("SH-06 the 257th sample discards the whole path, caps storage through 100,000 events and resets once", { "SH-06": "partial" }, () => {
  const q = createPointerSampleQueue(); let max = 0;
  for (let i = 0; i < 100_000; i++) { q.push(sample(i)); max = Math.max(max, q.size); }
  assert.equal(max, MAX_POINTER_SAMPLES_PER_FRAME); assert.equal(q.size, 0);
  assert.deepEqual(q.drain(), { batch: [], reset: true });
  q.push(sample(42)); assert.deepEqual(q.drain(), { batch: [sample(42)], reset: false });
  q.push(sample(1)); q.clear(); assert.deepEqual(q.drain(), { batch: [], reset: false });
});
finish();
