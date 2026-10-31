/** TT129 sidecar matching: independent quadratic reference plus edge cases. */
import { strict as assert } from "node:assert";
import { makeHarness } from "./harness.mts";
import { selectPhotoSidecars } from "../src/lib/photo-sidecars.ts";

const { test, finish } = makeHarness("tt129-core");
const reference = (photos: { path: string }[], candidates: string[], limit: number) =>
  candidates.filter((path) => photos.some((photo) => photo.path === path)).slice(0, limit);

await test("sidecar intersection preserves order and duplicate candidates", { "PH-03": "partial" }, () => {
  const photos = [{ path: "/a" }, { path: "/b" }, { path: "/a" }];
  assert.deepEqual(selectPhotoSidecars(photos, ["/c", "/b", "/a", "/b"]), ["/b", "/a", "/b"]);
});
await test("sidecar intersection handles empty collections and zero limit", { "PH-03": "partial" }, () => {
  assert.deepEqual(selectPhotoSidecars([], ["/a"]), []);
  assert.deepEqual(selectPhotoSidecars([{ path: "/a" }], []), []);
  assert.deepEqual(selectPhotoSidecars([{ path: "/a" }], ["/a"], 0), []);
});
await test("sidecar limit does not consume candidates after the requested matches", { "PH-03": "partial" }, () => {
  function* candidates() { yield "/no"; yield "/a"; yield "/b"; throw new Error("not needed"); }
  assert.deepEqual(selectPhotoSidecars([{ path: "/a" }, { path: "/b" }], candidates(), 2), ["/a", "/b"]);
});
await test("sidecar limits reject negative, fractional and non-finite values", { "PH-03": "partial" }, () => {
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => selectPhotoSidecars([], [], n));
});
await test("small Set fast path agrees with the reference at its boundary", { "PH-03": "partial" }, () => {
  const photos = [{ path: "/a" }, { path: "/b" }, { path: "/c" }];
  for (const candidates of [[], ["/a"], ["/missing", "/b"], ["/a", "/b", "/c", "/none"], ["/a", "/b", "/c", "/none", "/other"]]) {
    for (const limit of [0, 1, 5]) assert.deepEqual(selectPhotoSidecars(photos, new Set(candidates), limit), reference(photos, candidates, limit));
  }
});
await test("seeded adversarial intersections agree with the independent reference", { "PH-03": "partial" }, () => {
  let state = 72939;
  const next = (n: number) => { state = (state * 1664525 + 1013904223) >>> 0; return state % n; };
  for (let run = 0; run < 1000; run++) {
    const photos = Array.from({ length: next(45) }, () => ({ path: `/${next(70)}` }));
    const candidates = Array.from({ length: next(65) }, () => `/${next(70)}`);
    const limit = next(70);
    assert.deepEqual(selectPhotoSidecars(photos, candidates, limit), reference(photos, candidates, limit), `seeded case ${run}`);
  }
});
await test("default 2000-read bound and input order match the old selection", { "PH-03": "partial" }, () => {
  const photos = Array.from({ length: 5000 }, (_, i) => ({ path: `/${i}` }));
  const candidates = Array.from({ length: 6500 }, (_, i) => `/${6499 - i}`);
  const result = selectPhotoSidecars(photos, candidates);
  assert.equal(result.length, 2000); assert.equal(result[0], "/4999"); assert.equal(result[1999], "/3000");
  assert.deepEqual(result, reference(photos, candidates, 2000));
});
finish();
