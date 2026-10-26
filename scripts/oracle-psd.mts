/**
 * Suite "oracle-psd": the PSD codec and compositor against psd-tools (independent Python implementation).
 *   A. psd-tools reads OUR files (raw / RLE / ZIP): names, geometry, opacity, blend keys, visibility, masks,
 *      exact layer pixels, our merged image; and psd-tools' OWN compositor vs ours (all 12 blend modes).
 *   B. our reader on files WRITTEN by psd-tools: structure + exact pixels; our compositor vs theirs.
 *   C. layer-less (flattened) RGB and Grayscale files written by psd-tools → our fallback path.
 * Requires ORACLE_PY = a Python with psd-tools (default /home/user/tools/venv/bin/python). Dev-time only.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { makeHarness } from "./harness.mts";
import { BLEND_MODES, composite, makeLayer, type ImageDoc, type Layer, type LayerGroup } from "../src/lib/image/doc.ts";
import { BLEND_KEYS, readPsd, writePsd } from "../src/lib/image/psd.ts";
import { formatFor } from "../src/lib/forge.ts";

const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
const DIR = "/tmp/psd-oracle";
mkdirSync(DIR, { recursive: true });
const { test, finish } = makeHarness("oracle-psd");
const py = (...args: string[]) => JSON.parse(execFileSync(PY, ["scripts/oracles/psd_oracle.py", ...args], { encoding: "utf8", maxBuffer: 64 << 20 }));

function rnd(seed: number) { let x = seed >>> 0 || 1; return () => ((x = (1664525 * x + 1013904223) >>> 0) / 4294967296); }
function noise(name: string, w: number, h: number, seed: number, opaque = false): Layer {
  const l = makeLayer(name, w, h); const r = rnd(seed);
  for (let i = 0; i < l.data.length; i++) l.data[i] = Math.floor(r() * 256);
  if (opaque) for (let i = 3; i < l.data.length; i += 4) l.data[i] = 255;
  return l;
}
const G_ISO: LayerGroup = { id: "g-iso", name: "Isolated ✓", opacity: 180 / 255, blend: "multiply", visible: true };
const G_PASS: LayerGroup = { id: "g-pass", name: "Pass nested", opacity: 150 / 255, blend: "pass-through", visible: true, open: false };
const G_HIDDEN: LayerGroup = { id: "g-hid", name: "Hidden group", opacity: 1, blend: "pass-through", visible: false };
const G_TOP: LayerGroup = { id: "g-top", name: "Top pass", opacity: 200 / 255, blend: "pass-through", visible: true };
const groupRec = (g: LayerGroup) => ({ name: g.name, opacity: Math.round(g.opacity * 255), blend: g.blend === "pass-through" ? "pass" : BLEND_KEYS[g.blend], visible: g.visible });
/** One layer per blend mode at pseudo-random offsets (some partly off-canvas), varied opacity, a hidden one, masks. */
function oracleDoc(): ImageDoc {
  const r = rnd(77);
  const layers: Layer[] = [noise("Background", 64, 48, 1, true)];
  BLEND_MODES.forEach((m, i) => {
    const w = 8 + Math.floor(r() * 24), h = 8 + Math.floor(r() * 20);
    const l = { ...noise(`${m} — ${i} ✓`, w, h, 100 + i), x: Math.floor(r() * 70) - 6, y: Math.floor(r() * 52) - 6, blend: m, opacity: Math.round((0.35 + r() * 0.65) * 255) / 255 };
    if (i === 4) l.visible = false;
    if (i === 6 || i === 9) { l.mask = new Uint8ClampedArray(w * h); for (let k = 0; k < l.mask.length; k++) l.mask[k] = Math.floor(r() * 256); }
    if (i === 9) l.maskEnabled = false;
    // TT78: clipping masks (2, 3 clip to 1; 14 clips to 13) and groups — isolated multiply group 5..8 with a nested
    // pass-through group 7..8, a hidden group 10, a pass-through group 15 at the top
    if (i === 2 || i === 3 || i === 14 || i === 8) l.clip = true;
    if (i >= 5 && i <= 8) l.groups = i >= 7 ? [G_ISO, G_PASS] : [G_ISO];
    if (i === 10) l.groups = [G_HIDDEN];
    if (i === 15) l.groups = [G_TOP];
    layers.push(l);
  });
  // clipped layers overlap their base partly (inside and outside), so clipping is actually exercised
  for (let i = 1; i < layers.length; i++) if (layers[i].clip) { let b = i - 1; while (layers[b].clip) b--; layers[i].x = layers[b].x + 3; layers[i].y = layers[b].y - 2; }
  return { width: 64, height: 48, layers };
}

await test("psd-tools available", {}, () => {
  assert.ok(existsSync(PY), `no python at ${PY}`);
  execFileSync(PY, ["-c", "import psd_tools, numpy"], { stdio: "pipe" });
});

const tolerance = { rgbMax: 1, alphaMax: 1 }; // measured: float32 (psd-tools) vs our float rounding differ by ≤ 1/255
for (const compression of ["raw", "rle", "zip"] as const) {
  await test(`A/${compression}: psd-tools reads our PSD — structure, exact pixels, masks, merged image, independent composite`, { "FF-31": "full", "FF-08": "full", "FF-30": compression === "rle" ? "full" : "partial" }, async () => {
    const doc = oracleDoc();
    const bytes = await writePsd(doc, { compression });
    const file = `${DIR}/ours_${compression}.psd`;
    writeFileSync(file, bytes);
    const back = (await readPsd(bytes)).doc; // quantised opacities, exactly as stored
    const expect = { width: doc.width, height: doc.height, layers: doc.layers.map((l, i) => {
      const pf = `${file}.${i}.bin`; writeFileSync(pf, l.data);
      const mf = l.mask ? `${file}.${i}.mask.bin` : undefined; if (mf && l.mask) writeFileSync(mf, l.mask);
      return { name: l.name, x: l.x, y: l.y, w: l.w, h: l.h, opacity255: Math.round(l.opacity * 255), blendKey: BLEND_KEYS[l.blend], visible: l.visible, pixels: pf, mask: mf, maskEnabled: l.maskEnabled !== false, clip: !!l.clip, groups: (l.groups ?? []).map(groupRec) };
    }) };
    writeFileSync(`${file}.json`, JSON.stringify(expect));
    const ours = composite(back);
    writeFileSync(`${file}.rgba`, ours);
    const r = py("check", file, `${file}.json`, `${file}.rgba`);
    console.log(`    psd-tools: merged Δmax ${r.mergedMaxDiff}; composite α Δmax ${r.compositeAlphaMaxDiff}, rgb Δmax ${r.compositeRgbMaxDiff}, mean ${r.compositeRgbMeanDiff.toFixed(4)}, p99 ${r.compositeRgbP99}`);
    assert.deepEqual(r.problems, []);
    assert.equal(r.mergedMaxDiff, 0, "our merged image as decoded by psd-tools must equal our composite exactly");
    assert.ok(r.compositeAlphaMaxDiff <= tolerance.alphaMax, `alpha Δ ${r.compositeAlphaMaxDiff}`);
    assert.ok(r.compositeRgbMaxDiff <= tolerance.rgbMax, `rgb Δ ${r.compositeRgbMaxDiff} > ${tolerance.rgbMax}`);
  });
}

const made = await (async () => { try { return py("make", DIR) as { files: { path: string; width: number; height: number; compression: string; composite: string; layers: { name: string; x: number; y: number; w: number; h: number; opacity255: number; blendKey: string; visible: boolean; pixels: string }[] }[]; flat: { path: string; width: number; height: number; rgb: string; layers: number }; gray: { path: string; width: number; height: number; l: string } }; } catch (e) { return { error: (e as Error).message }; } })();

await test("fixtures exercise clipping (psd-tools: hiding the clipped layers changes the composite)", { "FF-31": "partial" }, () => {
  const n = (made as { clipEffectPixels?: number }).clipEffectPixels ?? 0;
  assert.ok(n >= 50, `clipped layers change only ${n} pixels`);
  const doc = oracleDoc(); const a = composite(doc);
  const b = composite({ ...doc, layers: doc.layers.map((l) => (l.clip ? { ...l, visible: false } : l)) });
  let d = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 6) d++;
  assert.ok(d >= 50, `our doc: clipped layers change only ${d} pixels`);
  return `psd-tools fixture ${n} px, our doc ${d} px affected by clipping`;
});

for (const f of "files" in made ? made.files : []) {
  await test(`B/${f.compression}: our reader on a psd-tools-written PSD — structure, exact pixels, composite vs psd-tools`, { "FF-31": "full", "FF-08": "full", "FF-30": "partial" }, async () => {
    const { doc, warnings } = await readPsd(new Uint8Array(readFileSync(f.path)));
    assert.deepEqual(warnings, []);
    assert.deepEqual([doc.width, doc.height], [f.width, f.height]);
    assert.equal(doc.layers.length, f.layers.length);
    f.layers.forEach((e, i) => {
      const l = doc.layers[i];
      assert.equal(l.name, e.name); assert.deepEqual([l.x, l.y, l.w, l.h], [e.x, e.y, e.w, e.h], e.name);
      assert.equal(Math.round(l.opacity * 255), e.opacity255); assert.equal(BLEND_KEYS[l.blend], e.blendKey); assert.equal(l.visible, e.visible);
      assert.ok(Buffer.from(l.data).equals(readFileSync(e.pixels)), `pixels of ${e.name}`);
      assert.equal(!!l.clip, !!e.clip, `clip of ${e.name}`);
      assert.deepEqual((l.groups ?? []).map(groupRec), e.groups ?? [], `groups of ${e.name}`);
    });
    const ours = composite(doc), theirs = new Uint8Array(readFileSync(f.composite));
    let a = 0, c = 0;
    for (let i = 0; i < ours.length; i += 4) {
      a = Math.max(a, Math.abs(ours[i + 3] - theirs[i + 3]));
      if (ours[i + 3] && theirs[i + 3]) for (let k = 0; k < 3; k++) c = Math.max(c, Math.abs(ours[i + k] - theirs[i + k]));
    }
    console.log(`    composite vs psd-tools: α Δmax ${a}, rgb Δmax ${c}`);
    assert.ok(a <= tolerance.alphaMax && c <= tolerance.rgbMax, `α ${a} rgb ${c}`);
  });
}

await test("forge row: PSD grade A, and every gap the codec reports is written into the boundary", { "FF-08": "full" }, () => {
  const f = formatFor("x.psd")!;
  assert.equal(f.grade, "A"); assert.ok(f.editable);
  for (const gap of [/layer effects/, /vector masks/, /dissolve/, /clipping to a group/, /PSB/, /CMYK/, /stored pixels/]) assert.match(f.boundary, gap);
  assert.ok(!f.dropsOnExport?.some((d) => /group/.test(d)), "groups are no longer dropped on export");
});

await test("C: layer-less RGB and Grayscale PSDs written by psd-tools open via the merged-image fallback", { "FF-31": "partial" }, async () => {
  assert.ok("flat" in made, String((made as { error?: string }).error));
  const m = made as Exclude<typeof made, { error: string }>;
  assert.equal(m.flat.layers, 0, "fixture really is layer-less");
  const { doc } = await readPsd(new Uint8Array(readFileSync(m.flat.path)));
  assert.equal(doc.layers.length, 1);
  const rgb = readFileSync(m.flat.rgb);
  for (let i = 0; i < m.flat.width * m.flat.height; i++) for (let k = 0; k < 3; k++) assert.equal(doc.layers[0].data[i * 4 + k], rgb[i * 3 + k]);
  const g = await readPsd(new Uint8Array(readFileSync(m.gray.path)));
  const L = readFileSync(m.gray.l);
  assert.equal(g.info.mode, 1);
  for (let i = 0; i < L.length; i++) assert.deepEqual(Array.from(g.doc.layers[0].data.subarray(i * 4, i * 4 + 4)), [L[i], L[i], L[i], 255]);
});

finish();
