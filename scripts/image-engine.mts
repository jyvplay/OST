/**
 * Suite "image": headless tests for src/lib/image (FF-24 raster ops, FF-30 layers/paint, FF-31 PSD codec).
 * Expected values are hand-derived from the W3C Compositing-1 formulas, Apple TN1023 (PackBits), and
 * round-trip / cross-implementation identities (e.g. our rotateDoc vs the ported raster.rotate90).
 * External oracles live in scripts/oracle-psd.mts (psd-tools) and scripts/e2e-image.mts (Chromium/Skia).
 */
import assert from "node:assert/strict";
import { makeHarness } from "./harness.mts";
import {
  BLEND_FN, BLEND_MODES, composite, compositeRegion, cropCanvas, duplicateLayer, flatten, flipDoc, makeLayer, mergeDown,
  newDoc, addLayer, patchLayer, removeLayer, reorderLayer, resizeImage, rotateDoc, growLayerTo, contentBounds, validateDoc, mergeChangesAppearance,
  type ImageDoc, type Layer,
} from "../src/lib/image/doc.ts";
import {
  dab, strokeSegment, floodFill, regionMask, selectRect, selectEllipse, invertSelection, combineSelections, magicWand,
  clearSelection, copySelection, linearGradient, sampleAverage, dabProfile,
} from "../src/lib/image/paint.ts";
import { packBits, unpackBits, readPsd, writePsd } from "../src/lib/image/psd.ts";
import { createHistory, pushHistory, undoHistory, redoHistory, uniqueBufferBytes } from "../src/lib/image/history.ts";
import * as R from "../src/lib/image/raster.ts";

const { test, finish } = makeHarness("image");
const px = (d: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(d.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
function rnd(seed: number) { let x = seed >>> 0 || 1; return () => ((x = (1664525 * x + 1013904223) >>> 0) / 4294967296); }
function noiseLayer(name: string, w: number, h: number, seed: number, alpha = true): Layer {
  const l = makeLayer(name, w, h); const r = rnd(seed);
  for (let i = 0; i < l.data.length; i++) l.data[i] = Math.floor(r() * 256);
  if (!alpha) for (let i = 3; i < l.data.length; i += 4) l.data[i] = 255;
  return l;
}

await test("W3C separable blend functions: hand-computed pins", { "FF-30": "partial" }, () => {
  const f = BLEND_FN;
  near(f.multiply(0.5, 0.5), 0.25); near(f.screen(0.5, 0.5), 0.75);
  near(f.overlay(0.25, 0.5), 0.25);           // = hardLight(Cs=.5→backdrop, .25): multiply(.5, .5)
  near(f.overlay(0.75, 0.5), 0.75);           // screen(.5, 2·.75−1=.5)
  near(f["hard-light"](0.4, 0.8), 0.4 + 0.6 - 0.4 * 0.6);
  near(f["color-dodge"](0.5, 0.5), 1); near(f["color-dodge"](0.25, 0.5), 0.5); near(f["color-dodge"](0, 1), 0);
  near(f["color-burn"](0.5, 0.5), 0); near(f["color-burn"](0.75, 0.5), 0.5); near(f["color-burn"](1, 0), 1);
  near(f["soft-light"](0.2, 0.75), 0.324);    // D(.2) = ((16·.2−12)·.2+4)·.2 = .448 → .2 + .5·(.448−.2)
  near(f["soft-light"](0.64, 0.75), 0.64 + 0.5 * (0.8 - 0.64));
  near(f["soft-light"](0.5, 0.25), 0.5 - 0.5 * 0.5 * 0.5);
  near(f.difference(0.2, 0.7), 0.5); near(f.exclusion(0.5, 0.5), 0.5); near(f.darken(0.3, 0.6), 0.3); near(f.lighten(0.3, 0.6), 0.6);
  assert.equal(BLEND_MODES.length, 12);
});

await test("composite: source-over with opacity, blend over transparent backdrop, mask, off-canvas offsets", { "FF-30": "partial" }, () => {
  const doc = newDoc(4, 4, [255, 255, 255, 255]);
  const red = makeLayer("red", 4, 4, [255, 0, 0, 255]); red.opacity = 0.5;
  let d = addLayer(doc, red);
  assert.deepEqual(px(composite(d), 4, 0, 0), [255, 128, 128, 255]);
  // multiply over a transparent backdrop = the source colour (W3C: (1−αb)·Cs term)
  const t: ImageDoc = { width: 2, height: 1, layers: [{ ...makeLayer("m", 2, 1, [10, 200, 30, 255]), blend: "multiply" }] };
  assert.deepEqual(px(composite(t), 2, 0, 0), [10, 200, 30, 255]);
  // multiply over opaque grey: 128/255 · 200/255
  const g: ImageDoc = { width: 1, height: 1, layers: [makeLayer("g", 1, 1, [128, 128, 128, 255]), { ...makeLayer("m", 1, 1, [200, 100, 0, 255]), blend: "multiply" }] };
  assert.deepEqual(px(composite(g), 1, 0, 0), [Math.round(128 * 200 / 255), Math.round(128 * 100 / 255), 0, 255]);
  // mask hides half
  const masked = makeLayer("k", 4, 4, [0, 0, 255, 255]); masked.mask = new Uint8ClampedArray(16); masked.mask.fill(255, 0, 8);
  d = addLayer(newDoc(4, 4, [255, 255, 255, 255]), masked);
  assert.deepEqual(px(composite(d), 4, 0, 0), [0, 0, 255, 255]); assert.deepEqual(px(composite(d), 4, 0, 3), [255, 255, 255, 255]);
  // mask disabled → visible everywhere
  d = patchLayer(d, masked.id, { maskEnabled: false });
  assert.deepEqual(px(composite(d), 4, 0, 3), [0, 0, 255, 255]);
  // off-canvas offset: layer at (-2,-2) size 4 covers only the top-left 2×2
  const off = { ...makeLayer("o", 4, 4, [0, 0, 0, 255]), x: -2, y: -2 };
  const c = composite({ width: 4, height: 4, layers: [off] });
  assert.equal(px(c, 4, 1, 1)[3], 255); assert.equal(px(c, 4, 2, 2)[3], 0);
  // compositeRegion equals the corresponding window of the full composite
  const big: ImageDoc = { width: 9, height: 7, layers: [noiseLayer("a", 9, 7, 1), { ...noiseLayer("b", 5, 5, 2), x: 3, y: 1, blend: "overlay", opacity: 0.7 }] };
  const full = composite(big), win = compositeRegion(big, { x: 2, y: 1, w: 5, h: 4 });
  for (let y = 0; y < 4; y++) for (let x = 0; x < 5; x++) assert.deepEqual(px(win, 5, x, y), px(full, 9, x + 2, y + 1));
});

await test("structural ops: rotate×4 = id, rotate matches raster.rotate90 of the composite, flips, crop keeps pixels", { "FF-30": "partial", "FF-24": "partial" }, () => {
  const doc: ImageDoc = { width: 7, height: 5, layers: [noiseLayer("bg", 7, 5, 3, false), { ...noiseLayer("o", 3, 4, 4), x: 5, y: -1, blend: "screen" }] };
  const before = composite(doc);
  let d = doc; for (let i = 0; i < 4; i++) d = rotateDoc(d, 1);
  assert.deepEqual(Array.from(composite(d)), Array.from(before));
  for (const turns of [1, 2, 3]) {
    const ours = composite(rotateDoc(doc, turns));
    const theirs = R.rotate90({ width: 7, height: 5, data: before }, turns); // independent implementation (ported)
    assert.deepEqual(Array.from(ours), Array.from(theirs.data), `rotate ${turns}`);
  }
  const fh = composite(flipDoc(doc, "horizontal")), rf = R.flip({ width: 7, height: 5, data: before }, "horizontal");
  assert.deepEqual(Array.from(fh), Array.from(rf.data));
  assert.deepEqual(Array.from(composite(flipDoc(flipDoc(doc, "vertical"), "vertical"))), Array.from(before));
  const cropped = cropCanvas(doc, { x: 2, y: 1, w: 3, h: 3 });
  assert.equal(cropped.layers[0].w, 7, "crop is non-destructive to layer pixels");
  const cc = composite(cropped);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) assert.deepEqual(px(cc, 3, x, y), px(before, 7, x + 2, y + 1));
});

await test("merge down / flatten preserve the composite; duplicate/reorder/remove; growLayerTo; validation", { "FF-30": "partial" }, () => {
  const doc: ImageDoc = { width: 8, height: 6, layers: [noiseLayer("bg", 8, 6, 5, false), { ...noiseLayer("mid", 5, 3, 6), x: 2, y: 2, blend: "multiply", opacity: 0.6 }, { ...noiseLayer("top", 4, 4, 7), x: -1, y: 3, blend: "difference" }] };
  const ref = Array.from(composite(doc));
  const worst = (d: ImageDoc) => { const c = composite(d); let w = 0; for (let i = 0; i < c.length; i++) w = Math.max(w, Math.abs(c[i] - ref[i])); return w; };
  // Precondition false (lower is multiply @60 %): merge may change the picture, and the predicate says so.
  assert.equal(mergeChangesAppearance(doc, doc.layers[2].id), true);
  assert.ok(worst(mergeDown(doc, doc.layers[2].id)) > 1, "this configuration is expected to change (Photoshop semantics)");
  // Precondition true: upper "difference" over an opaque normal lower layer → exact (±1 quantisation).
  const ok1: ImageDoc = { ...doc, layers: [doc.layers[0], { ...doc.layers[2], x: 1, y: 1 }] };
  const ref1 = Array.from(composite(ok1));
  assert.equal(mergeChangesAppearance(ok1, ok1.layers[1].id), false);
  const m = mergeDown(ok1, ok1.layers[1].id);
  assert.equal(m.layers.length, 1);
  assert.ok(Array.from(composite(m)).every((v, i) => Math.abs(v - ref1[i]) <= 1));
  // Precondition true: normal upper over a translucent-pixel normal lower (opacity 1) → exact.
  const ok2: ImageDoc = { ...doc, layers: [doc.layers[0], { ...doc.layers[1], blend: "normal", opacity: 1 }, { ...doc.layers[2], blend: "normal" }] };
  const ref2 = Array.from(composite(ok2));
  assert.equal(mergeChangesAppearance(ok2, ok2.layers[2].id), false);
  assert.ok(Array.from(composite(mergeDown(ok2, ok2.layers[2].id))).every((v, i) => Math.abs(v - ref2[i]) <= 1));
  assert.deepEqual(Array.from(composite(flatten(doc))), ref);
  const dup = duplicateLayer(doc, doc.layers[0].id);
  assert.equal(dup.doc.layers[1].name, "bg copy"); assert.notEqual(dup.doc.layers[1].data, doc.layers[0].data);
  const up = reorderLayer(doc, doc.layers[0].id, 1); assert.equal(up.layers[1].name, "bg");
  assert.equal(removeLayer(doc, doc.layers[1].id).layers.length, 2);
  assert.throws(() => removeLayer({ ...doc, layers: [doc.layers[0]] }, doc.layers[0].id));
  const g = growLayerTo(doc.layers[1], { x: 0, y: 0, w: 8, h: 6 });
  assert.deepEqual([g.x, g.y, g.w, g.h], [0, 0, 8, 6]);
  assert.deepEqual(Array.from(composite({ ...doc, layers: [doc.layers[0], g, doc.layers[2]] })), ref);
  assert.throws(() => validateDoc({ ...doc, layers: [{ ...doc.layers[0], opacity: 2 }] }));
  assert.throws(() => validateDoc({ ...doc, layers: [{ ...doc.layers[0], data: new Uint8ClampedArray(3) }] }));
});

await test("brush: AA profile, continuous evenly spaced stroke, erase, mask painting, selection clipping", { "FF-30": "partial" }, () => {
  assert.equal(dabProfile(0, 5, 1), 1); assert.equal(dabProfile(6, 5, 1), 0); near(dabProfile(5, 5, 1), 0.5);
  assert.equal(dabProfile(2, 5, 0.5), 1); assert.ok(dabProfile(4, 5, 0.5) < 0.5 && dabProfile(4, 5, 0.5) > 0);
  const l = makeLayer("p", 60, 20);
  const o = { size: 6, hardness: 1, flow: 1, color: [255, 0, 0] as [number, number, number], mode: "paint" as const };
  strokeSegment(l, { x: 10, y: 10 }, { x: 50, y: 10 }, o, -1, null);
  for (let x = 10; x <= 50; x++) assert.equal(px(l.data, 60, x, 10)[3], 255, `gap at x=${x}`);
  assert.deepEqual(px(l.data, 60, 30, 10), [255, 0, 0, 255]);
  assert.equal(px(l.data, 60, 30, 15)[3], 0); assert.equal(px(l.data, 60, 55, 10)[3], 0);
  // symmetric dab
  const s = makeLayer("s", 21, 21); dab(s, 10.5, 10.5, { ...o, size: 9, hardness: 0.3 }, null);
  for (let k = 0; k < 10; k++) assert.equal(px(s.data, 21, 10 - k, 10)[3], px(s.data, 21, 10 + k, 10)[3]);
  // erase
  dab(l, 30.5, 10.5, { ...o, mode: "erase" }, null); assert.equal(px(l.data, 60, 30, 10)[3], 0);
  // translucent paint over opaque blue: straight-alpha source-over
  const b = makeLayer("b", 3, 3, [0, 0, 255, 255]); dab(b, 1.5, 1.5, { ...o, size: 1, flow: 0.5 }, null);
  assert.deepEqual(px(b.data, 3, 1, 1), [128, 0, 128, 255]);
  // mask paint
  const mk = makeLayer("m", 10, 10, [0, 0, 0, 255]); mk.mask = new Uint8ClampedArray(100).fill(255);
  dab(mk, 5, 5, { ...o, size: 4, mode: "mask-hide" }, null);
  assert.equal(mk.mask[5 * 10 + 5], 0); assert.equal(mk.data[(5 * 10 + 5) * 4 + 3], 255, "mask paint leaves pixels alone");
  // selection clipping
  const doc = newDoc(20, 20, null); const sel = selectRect(doc, { x: 0, y: 0, w: 10, h: 20 });
  const c = doc.layers[0]; strokeSegment(c, { x: 2, y: 5 }, { x: 18, y: 5 }, o, -1, sel);
  assert.equal(px(c.data, 20, 5, 5)[3], 255); assert.equal(px(c.data, 20, 15, 5)[3], 0);
});

await test("flood fill: contiguity, tolerance boundary, selection; magic wand; clear/copy selection; ellipse area", { "FF-30": "partial" }, () => {
  const l = makeLayer("f", 10, 4, [100, 100, 100, 255]);
  for (let y = 0; y < 4; y++) { const i = (y * 10 + 5) * 4; l.data.set([0, 0, 0, 255], i); }            // wall at x=5
  l.data.set([110, 100, 100, 255], (0 * 10 + 1) * 4);                                                  // Δ = 10
  floodFill(l, 0, 0, [255, 0, 0], { tolerance: 9, contiguous: true }, null);
  assert.deepEqual(px(l.data, 10, 0, 0), [255, 0, 0, 255]); assert.deepEqual(px(l.data, 10, 1, 0), [110, 100, 100, 255], "Δ10 > tol 9");
  assert.deepEqual(px(l.data, 10, 8, 2), [100, 100, 100, 255], "wall stops contiguous fill");
  const l2 = makeLayer("g", 10, 4, [100, 100, 100, 255]); for (let y = 0; y < 4; y++) l2.data.set([0, 0, 0, 255], (y * 10 + 5) * 4);
  l2.data.set([110, 100, 100, 255], 4);
  floodFill(l2, 0, 0, [0, 255, 0], { tolerance: 10, contiguous: false }, null);
  assert.deepEqual(px(l2.data, 10, 1, 0), [0, 255, 0, 255]); assert.deepEqual(px(l2.data, 10, 8, 2), [0, 255, 0, 255]);
  assert.deepEqual(px(l2.data, 10, 5, 2), [0, 0, 0, 255]);
  // region count
  const m = regionMask(l.data, 10, 4, 7, 1, 0, true); assert.equal(m.filter((v) => v).length, 16);
  const doc: ImageDoc = { width: 10, height: 4, layers: [l] };
  const wand = magicWand(composite(doc), doc, 7, 1, 0, true);
  assert.deepEqual(wand.bounds, { x: 6, y: 0, w: 4, h: 4 });
  const piece = copySelection(l, wand)!; assert.equal(piece.w, 4); assert.equal(piece.data[3], 255);
  clearSelection(l, wand); assert.equal(px(l.data, 10, 7, 1)[3], 0); assert.equal(px(l.data, 10, 0, 0)[3], 255);
  const inv = invertSelection(wand); assert.equal(inv.bounds.w, 6);
  const both = combineSelections(wand, inv, "add"); assert.equal(both.mask.filter((v) => v === 255).length, 40);
  const big = newDoc(200, 100, null); const e = selectEllipse(big, { x: 0, y: 0, w: 200, h: 100 });
  const area = e.mask.reduce((a, v) => a + v / 255, 0);
  assert.ok(Math.abs(area - Math.PI * 100 * 50) / (Math.PI * 5000) < 0.002, `ellipse area ${area}`);
});

await test("gradient endpoints/midpoint; eyedropper average; blur is premultiplied (no dark fringe)", { "FF-30": "partial", "FF-24": "partial" }, () => {
  const l = makeLayer("g", 101, 1);
  linearGradient(l, { x: 0.5, y: 0.5 }, { x: 100.5, y: 0.5 }, [0, 0, 0, 255], [255, 255, 255, 255], null);
  assert.deepEqual(px(l.data, 101, 0, 0), [0, 0, 0, 255]); assert.deepEqual(px(l.data, 101, 100, 0), [255, 255, 255, 255]);
  assert.equal(px(l.data, 101, 50, 0)[0], 128);
  const buf = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  assert.deepEqual(sampleAverage(buf, 2, 2, 0, 0, 3), [128, 128, 128, 255]);
  const r = R.createRaster(9, 9); for (let y = 3; y < 6; y++) for (let x = 3; x < 6; x++) r.data.set([255, 0, 0, 255], (y * 9 + x) * 4);
  const b = R.blur(r, 1, 1);
  for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3] > 0) assert.deepEqual([b.data[i], b.data[i + 1], b.data[i + 2]], [255, 0, 0], "fringe colour must stay red");
});

await test("PackBits: Apple TN1023 vector decodes; encoder round-trips random/edge data and is ≤ TN1023 size", { "FF-31": "partial" }, () => {
  const packed = Uint8Array.from([0xfe, 0xaa, 0x02, 0x80, 0x00, 0x2a, 0xfd, 0xaa, 0x03, 0x80, 0x00, 0x2a, 0x22, 0xf7, 0xaa]);
  const expect = Uint8Array.from([0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0xaa, 0xaa, 0xaa, 0xaa, 0x80, 0x00, 0x2a, 0x22, ...Array(10).fill(0xaa)]);
  const out = new Uint8Array(expect.length); unpackBits(packed, 0, packed.length, out, 0, out.length);
  assert.deepEqual(Array.from(out), Array.from(expect));
  assert.ok(packBits(expect).length <= packed.length);
  const r = rnd(9);
  const cases = [new Uint8Array(0), Uint8Array.from([7]), Uint8Array.from([7, 7]), new Uint8Array(300).fill(5), Uint8Array.from({ length: 1000 }, () => Math.floor(r() * 256)),
    Uint8Array.from({ length: 777 }, (_, i) => (i % 7 < 3 ? 9 : i & 255)), Uint8Array.from({ length: 129 }, (_, i) => i), Uint8Array.from({ length: 260 }, (_, i) => (i < 130 ? 1 : i))];
  for (const c of cases) {
    const p = packBits(c), back = new Uint8Array(c.length);
    unpackBits(p, 0, p.length, back, 0, back.length);
    assert.deepEqual(Array.from(back), Array.from(c));
    assert.ok(p.length <= c.length + Math.ceil(c.length / 128) + 1);
  }
});

const psdDoc = (): ImageDoc => {
  const bg = noiseLayer("Background", 40, 30, 11, false);
  const a = { ...noiseLayer("Ébauche ✓", 20, 18, 12), x: -5, y: 4, blend: "soft-light" as const, opacity: 0.6 };
  const b = { ...noiseLayer("hidden", 10, 10, 13), x: 30, y: 25, visible: false, blend: "color-burn" as const };
  const c = { ...noiseLayer("masked", 25, 12, 14), x: 8, y: 10, blend: "multiply" as const };
  c.mask = new Uint8ClampedArray(25 * 12); for (let i = 0; i < c.mask.length; i++) c.mask[i] = (i * 7) & 255;
  const d = { ...noiseLayer("mask off", 6, 6, 15), x: 1, y: 1, mask: new Uint8ClampedArray(36), maskEnabled: false };
  return { width: 40, height: 30, layers: [bg, a, b, c, d] };
};

await test("PSD write → read (raw / RLE / ZIP): names (Unicode), offsets incl. negative, opacity, blend, visibility, masks, exact pixels", { "FF-31": "partial", "FF-30": "partial" }, async () => {
  const doc = psdDoc();
  for (const compression of ["raw", "rle", "zip"] as const) {
    const bytes = await writePsd(doc, { compression });
    const { doc: back, warnings } = await readPsd(bytes);
    assert.deepEqual(warnings, [], compression);
    assert.equal(back.layers.length, doc.layers.length);
    doc.layers.forEach((l, i) => {
      const k = back.layers[i];
      assert.equal(k.name, l.name); assert.deepEqual([k.x, k.y, k.w, k.h], [l.x, l.y, l.w, l.h]);
      assert.equal(k.blend, l.blend); assert.equal(k.visible, l.visible); near(k.opacity, Math.round(l.opacity * 255) / 255);
      assert.ok(Buffer.from(k.data).equals(Buffer.from(l.data)), `${compression} pixels of ${l.name}`);
      if (l.mask) { assert.ok(Buffer.from(k.mask!).equals(Buffer.from(l.mask))); assert.equal(k.maskEnabled !== false, l.maskEnabled !== false); }
    });
    if (compression === "rle") assert.ok(bytes.length < 40 * 30 * 4 * 3, "RLE file is bounded");
  }
});

await test("PSD reader rejects PSB, 16-bit, CMYK, truncated/garbage input with explicit messages", { "FF-31": "partial" }, async () => {
  const good = await writePsd(newDoc(4, 4));
  const mut = (f: (b: Uint8Array) => void) => { const b = good.slice(); f(b); return b; };
  await assert.rejects(readPsd(mut((b) => { b[5] = 2; })), /PSB/);
  await assert.rejects(readPsd(mut((b) => { b[23] = 16; })), /16-bit/);
  await assert.rejects(readPsd(mut((b) => { b[25] = 4; })), /colour mode 4/);
  await assert.rejects(readPsd(new TextEncoder().encode("hello world, not a psd at all")), /8BPS/);
});

await test("history: undo/redo, state cap, unique-buffer byte budget", { "FF-30": "partial" }, () => {
  const a = newDoc(100, 100); const b = { ...a, layers: [{ ...a.layers[0], data: new Uint8ClampedArray(a.layers[0].data) }] };
  let h = createHistory(a); h = pushHistory(h, b);
  assert.equal(undoHistory(h).present, a); assert.equal(redoHistory(undoHistory(h)).present, b);
  assert.equal(uniqueBufferBytes([a, a, b]), 2 * 40000);
  let hh = createHistory(a);
  for (let i = 0; i < 10; i++) hh = pushHistory(hh, { ...a, layers: [{ ...a.layers[0], data: new Uint8ClampedArray(40000) }] }, { maxBytes: 200_000, sizeOf: uniqueBufferBytes });
  assert.ok(uniqueBufferBytes([...hh.past, hh.present]) <= 200_000);
  assert.ok(hh.past.length >= 3);
});

await test("resizeImage 2× then ½ ≈ identity on smooth content; layer offsets scale", { "FF-30": "partial" }, () => {
  const l = makeLayer("s", 16, 16); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) l.data.set([x * 16, y * 16, 128, 255], (y * 16 + x) * 4);
  const doc: ImageDoc = { width: 16, height: 16, layers: [l, { ...makeLayer("o", 4, 4, [1, 2, 3, 255]), x: 4, y: 6 }] };
  const up = resizeImage(doc, 32, 32); assert.deepEqual([up.layers[1].x, up.layers[1].y, up.layers[1].w], [8, 12, 8]);
  const down = resizeImage(up, 16, 16);
  const a = composite({ ...doc, layers: [l] }), b = composite({ ...down, layers: [down.layers[0]] });
  let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  assert.ok(worst <= 8, `worst ${worst}`);
  assert.equal(contentBounds(down.layers[1])!.w, 4);
});

finish();
