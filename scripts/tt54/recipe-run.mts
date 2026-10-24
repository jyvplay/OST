/**
 * TT54 (MD-03) — drives the photo recipe engine (src/lib/photos/recipe.ts) over raw RGBA sources written by
 * scripts/oracle/recipe_check.py, plus in-process property checks. Usage: node … recipe-run.mts DIR
 * Reads DIR/src_<name>.rgba + DIR/sources.json; writes DIR/rec/<case>.rgba + DIR/rec/report.json.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { renderRecipe, outputSize, parseRecipe, effectiveTone, toneCurve, rotateQuarter, flipRaster, isIdentity, recipeKey, sidecarPath, isSidecar, photoOfSidecar, PRESETS, type PhotoRecipe } from "../../src/lib/photos/recipe.ts";

type Raster = { width: number; height: number; data: Uint8ClampedArray };
const dir = process.argv[2]; const out = join(dir, "rec"); mkdirSync(out, { recursive: true });
const sources = JSON.parse(readFileSync(join(dir, "sources.json"), "utf8")) as { name: string; w: number; h: number }[];
const load = (n: string): Raster => { const s = sources.find((x) => x.name === n)!; return { width: s.w, height: s.h, data: new Uint8ClampedArray(readFileSync(join(dir, `src_${n}.rgba`))) }; };
const same = (a: Raster, b: Raster) => a.width === b.width && a.height === b.height && a.data.every((v, i) => v === b.data[i]);

const cases: Record<string, PhotoRecipe> = {
  identity: { v: 1 }, ratingOnly: { v: 1, rating: 4, favorite: true },
  rot1: { v: 1, rotate: 1 }, rot2: { v: 1, rotate: 2 }, rot3: { v: 1, rotate: 3 }, flipH: { v: 1, flipH: true }, flipV: { v: 1, flipV: true },
  rot1flipH: { v: 1, rotate: 1, flipH: true }, rot3flipV: { v: 1, rotate: 3, flipV: true },
  cropAligned: { v: 1, crop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }, cropOdd: { v: 1, crop: { x: 0.1, y: 0.05, w: 0.6, h: 0.7 } },
  rot1crop: { v: 1, rotate: 1, crop: { x: 0.5, y: 0, w: 0.5, h: 0.5 } },
  st5: { v: 1, straighten: 5 }, stm12: { v: 1, straighten: -12 }, st30crop: { v: 1, straighten: 30, crop: { x: 0.2, y: 0.2, w: 0.6, h: 0.6 } },
  expP1: { v: 1, exposure: 1 }, expM15: { v: 1, exposure: -1.5 }, conP: { v: 1, contrast: 0.6 }, conM: { v: 1, contrast: -0.6 },
  shP: { v: 1, shadows: 0.8 }, shM: { v: 1, shadows: -0.8 }, hiP: { v: 1, highlights: 0.7 }, hiM: { v: 1, highlights: -0.7 },
  warm: { v: 1, warmth: 0.8 }, cool: { v: 1, warmth: -0.8 }, tint: { v: 1, tint: -0.6 }, mono: { v: 1, saturation: -1 }, satP: { v: 1, saturation: 0.7 },
  vib: { v: 1, vibrance: 0.9 }, vign: { v: 1, vignette: 0.9 },
  combo: { v: 1, rotate: 1, flipV: true, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.75 }, exposure: 0.4, contrast: 0.3, shadows: 0.3, highlights: -0.4, saturation: 0.2, vibrance: 0.3, warmth: 0.2, tint: 0.1, vignette: 0.4 },
};
for (const p of Object.keys(PRESETS)) cases[`preset_${p}`] = { v: 1, preset: p as PhotoRecipe["preset"] };
cases.presetPlusSlider = { v: 1, preset: "warm", warmth: 0.9, exposure: 0.5 };

const report: { cases: unknown[]; props: Record<string, boolean | string> } = { cases: [], props: {} };
for (const src of sources) {
  const s = load(src.name);
  for (const [k, r] of Object.entries(cases)) {
    const o = renderRecipe(s, r); const sz = outputSize(s.width, s.height, r);
    writeFileSync(join(out, `${src.name}.${k}.rgba`), o.data);
    report.cases.push({ src: src.name, case: k, recipe: r, w: o.width, h: o.height, outputSize: [sz.width, sz.height], tone: effectiveTone(r), identity: isIdentity(r), sameAsSource: same(o, s) });
  }
  // resolution independence: the same recipe on a 2× smaller source (Python downsamples the full render to compare)
  if (src.name === "photo") {
    const half = load("photo_half");
    for (const k of ["combo", "preset_vivid", "st5"]) { const o = renderRecipe(half, cases[k]); writeFileSync(join(out, `photo_half.${k}.rgba`), o.data); report.cases.push({ src: "photo_half", case: k, w: o.width, h: o.height, half: true }); }
  }
}

// ---- properties -------------------------------------------------------------------------------------------------
const p = report.props; const s0 = load("odd");
let r4 = s0; for (let i = 0; i < 4; i++) r4 = rotateQuarter(r4, 1); p.rotate4IsIdentity = same(r4, s0);
p.rotate1x3EqualsRotate3 = same(rotateQuarter(rotateQuarter(rotateQuarter(s0, 1), 1), 1), rotateQuarter(s0, 3));
p.flipHTwiceIsIdentity = same(flipRaster(flipRaster(s0, true, false), true, false), s0);
p.flipHVEqualsRotate2 = same(flipRaster(s0, true, true), rotateQuarter(s0, 2));
let mono = true, ends = true; const grid = [-1, -0.6, -0.25, 0, 0.3, 0.7, 1];
for (const sh of grid) for (const hi of grid) for (const c of grid) {
  let prev = -1;
  for (let i = 0; i <= 255; i++) { const v = toneCurve(i / 255, sh, hi, c); if (v < prev - 1e-12 || !(v >= 0 && v <= 1)) mono = false; prev = v; }
  if (c >= 0 && (toneCurve(0, sh, hi, c) !== 0 || Math.abs(toneCurve(1, sh, hi, c) - 1) > 1e-12)) ends = false;
}
p.toneCurveMonotoneOn343Combos = mono; p.toneCurveFixesEndpointsWhenContrastNonNegative = ends;
p.identityCurve = [0, 0.25, 0.5, 0.9, 1].every((v) => toneCurve(v, 0, 0, 0) === v);
// hostile sidecars: anything goes in, a well-formed bounded recipe comes out
const hostile: unknown[] = [null, 42, "x", [], { v: 9, rotate: 7, exposure: 1e9, contrast: -Infinity, crop: { x: -5, y: 2, w: 50, h: NaN }, preset: "__proto__", rating: 99, favorite: "yes", straighten: "12" },
  { rotate: 2.5, flipH: 1, vignette: -3 }, { crop: { x: 0.9, y: 0.9, w: 0.9, h: 0.9 } }, JSON.parse('{"__proto__":{"rotate":1},"exposure":2}')];
p.hostileRecipesBounded = hostile.every((h) => {
  const r = parseRecipe(h); const t = effectiveTone(r);
  const okC = !r.crop || (r.crop.x >= 0 && r.crop.y >= 0 && r.crop.x + r.crop.w <= 1 + 1e-9 && r.crop.y + r.crop.h <= 1 + 1e-9 && r.crop.w > 0 && r.crop.h > 0);
  const okT = Object.values(t).every((v) => Number.isFinite(v) && Math.abs(v) <= 3);
  const okR = r.rotate === undefined || [1, 2, 3].includes(r.rotate);
  const o = renderRecipe(s0, r); const sz = outputSize(s0.width, s0.height, r);
  return r.v === 1 && okC && okT && okR && (r.rating === undefined || (r.rating >= 1 && r.rating <= 5)) && (r.favorite === undefined || r.favorite === true) && o.width === sz.width && o.height === sz.height && o.data.length === o.width * o.height * 4;
});
p.protoNotPolluted = ({} as Record<string, unknown>).rotate === undefined && parseRecipe(JSON.parse('{"__proto__":{"rotate":1}}')).rotate === undefined;
p.presetsKnown = parseRecipe({ preset: "vivid" }).preset === "vivid" && parseRecipe({ preset: "toString" }).preset === undefined;
p.recipeKeyOrigForRatingOnly = recipeKey({ v: 1, rating: 5, favorite: true }) === "orig" && recipeKey(null) === "orig";
p.recipeKeyChangesWithEdit = recipeKey({ v: 1, exposure: 0.5 }) !== recipeKey({ v: 1, exposure: 0.6 }) && recipeKey({ v: 1, exposure: 0.5 }) === recipeKey({ v: 1, exposure: 0.5, rating: 3 });
p.sidecarPaths = sidecarPath("/Pictures/a b.jpg") === "/Pictures/.a b.jpg.edit.json" && sidecarPath("/x.png") === "/.x.png.edit.json" && isSidecar("/P/.a.jpg.edit.json") && !isSidecar("/P/a.jpg") && !isSidecar("/P/.hidden") && photoOfSidecar("/P/.a.jpg.edit.json") === "/P/a.jpg" && photoOfSidecar("/P/a.jpg") === null;
p.outputSizeMatchesRender = (report.cases as { w: number; h: number; outputSize?: number[] }[]).every((c) => !c.outputSize || (c.outputSize[0] === c.w && c.outputSize[1] === c.h));
writeFileSync(join(out, "report.json"), JSON.stringify(report));
console.log(JSON.stringify({ cases: report.cases.length, props: p }));
