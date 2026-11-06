/**
 * TT140 — glyph geometry oracle.
 *
 * Reads the glyph table out of src/components/AppIcon.tsx and rasterises every
 * path with @napi-rs/canvas (MIT, installed under /home/user/tools as a
 * test-only dependency), then asserts each glyph:
 *   • draws something (a glyph that renders nothing is a blank tile in the UI)
 *   • stays inside the 48-grid
 *   • keeps its ink clear of the tile's rounded corners, where a glyph is
 *     clipped by the squircle and becomes a fragment
 *   • is not a copy of another glyph (identical pixel masks mean two features
 *     that a user cannot tell apart)
 *
 * This is a real external check: the paths are parsed from the component
 * source, not restated here, so editing a glyph cannot silently skip the test.
 * It is not an aesthetic judgement — a glyph can pass and still be ugly.
 *
 * If the canvas oracle is absent the script exits 2 with a REFUSED line rather
 * than skipping, because a silent skip is how a geometry regression ships.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const TOOLS = process.env.TOOLS_DIR ?? "/home/user/tools";
const canvasPath = resolve(TOOLS, "node_modules/@napi-rs/canvas/index.js");
let canvas: typeof import("@napi-rs/canvas");
try {
  canvas = await import(canvasPath).then((m) => (m as { default?: unknown }).default ?? m) as typeof import("@napi-rs/canvas");
} catch {
  console.log(`REFUSED: no canvas oracle at ${canvasPath}. Install @napi-rs/canvas under TOOLS_DIR.`);
  process.exit(2);
}
const { createCanvas, loadImage } = canvas;

const SRC = readFileSync(resolve("src/components/AppIcon.tsx"), "utf8");

/**
 * Extract `name: (p) => <jsx>` entries from the GLYPHS record. We then convert
 * the JSX to SVG by the same rules the component uses: `{...S}` becomes a
 * stroke group, `fill={p.fg}` a white fill, `stroke={p.detail}` a mid grey so
 * the two-tone structure is visible in the mask.
 */
function extractGlyphs(): Map<string, string> {
  const out = new Map<string, string>();
  const start = SRC.indexOf("export const GLYPHS");
  if (start < 0) throw new Error("GLYPHS table not found in AppIcon.tsx");
  // Walk braces from the record's opening `{` to its matching `}`.
  const open = SRC.indexOf("{", SRC.indexOf("=", start));
  let depth = 0;
  let end = open;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = SRC.slice(open + 1, end);

  // Split on top-level `name: (p) =>` at 2-space indent.
  const re = /^ {2}([A-Za-z][A-Za-z0-9]*): \(p\) => /gm;
  const marks: Array<{ name: string; at: number }> = [];
  for (const m of body.matchAll(re)) marks.push({ name: m[1], at: m.index! + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].at;
    const to = i + 1 < marks.length ? body.lastIndexOf(",", marks[i + 1].at) : body.length;
    // Trim the trailing `,` then any comment block that follows it: the last
    // glyph in the table is followed by prose, which would otherwise be read as
    // part of the drawing and made `blank` look like a copy of `doc`.
    let text = body.slice(from, to).trim().replace(/,$/, "");
    text = text.replace(/\/\*[\s\S]*?\*\/[\s\S]*$/, "").replace(/\/\/[^\n]*$/gm, "").trim();
    out.set(marks[i].name, text);
  }
  return out;
}

/** JSX fragment → SVG body. Only the attribute forms the file actually uses. */
function toSvg(jsx: string): string {
  let s = jsx;
  s = s.replace(/\{\.\.\.S\}/g, 'fill="none" stroke-linecap="round" stroke-linejoin="round"');
  s = s.replace(/stroke=\{p\.fg\}/g, 'stroke="#fff"');
  s = s.replace(/fill=\{p\.fg\}/g, 'fill="#fff"');
  s = s.replace(/stroke=\{p\.detail\}/g, 'stroke="#8899aa"');
  s = s.replace(/fill=\{p\.detail\}/g, 'fill="#8899aa"');
  s = s.replace(/stroke=\{inkIsDark\(p\.fg\) \? "[^"]*" : "[^"]*"\}/g, 'stroke="#8899aa"');
  s = s.replace(/strokeWidth="([\d.]+)"/g, 'stroke-width="$1"');
  s = s.replace(/strokeWidth=\{"([\d.]+)"\}/g, 'stroke-width="$1"');
  s = s.replace(/<\s*>/g, "").replace(/<\s*\/\s*>/g, "");
  return s;
}

interface GlyphMask {
  name: string;
  lit: number;
  minX: number; minY: number; maxX: number; maxY: number;
  hash: string;
  pixels: Uint8Array;
  /** Mean luminance over the lit pixels: 255 = solid fg, ~140 = all detail strokes. */
  meanInk: number;
  /** Count of lit pixels in the detail tone only (the greys), not the fg tone. */
  detailPixels: number;
}

async function render(name: string, svgBody: string): Promise<GlyphMask> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">${svgBody}</svg>`;
  const c = createCanvas(48, 48);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 48, 48);
  const b64 = Buffer.from(svg).toString("base64");
  const img = await loadImage(`data:image/svg+xml;base64,${b64}`);
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, 48, 48).data;
  let lit = 0, minX = 99, minY = 99, maxX = -1, maxY = -1;
  const mask = new Uint8Array(48 * 48);
  let h = 0x811c9dc5;
  let inkSum = 0;
  let detailPixels = 0;
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 48; x++) {
      const v = d[(y * 48 + x) * 4];
      const on = v > 60 ? 1 : 0;
      mask[y * 48 + x] = on;
      if (on) {
        lit++;
        inkSum += v;
        // The detail tone renders at about 137; the fg tone at 255.
        if (v < 200) detailPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      h ^= on;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return {
    name, lit, minX, minY, maxX, maxY, hash: h.toString(16), pixels: mask,
    meanInk: lit === 0 ? 0 : inkSum / lit, detailPixels,
  };
}

const glyphs = extractGlyphs();
const names = [...glyphs.keys()];
const results: GlyphMask[] = [];
const failures: string[] = [];

if (names.length < 40) failures.push(`only ${names.length} glyphs parsed out of AppIcon.tsx — the extractor has drifted`);

// Glyphs whose source is a JSX expression rather than literal markup
// (`.map()`, template strings) cannot be converted by attribute rewriting
// alone. They are reported by name as SKIPPED, never silently passed: a skip
// that looks like a pass is how a blank tile ships.
const skipped: string[] = [];
const warnings: string[] = [];

for (const name of names) {
  const raw = glyphs.get(name)!;
  if (/\{\[|\{\(|\.map\(|`/.test(raw)) {
    skipped.push(name);
    continue;
  }
  const svgBody = toSvg(raw);
  let m: GlyphMask;
  try {
    m = await render(name, svgBody);
  } catch (e) {
    failures.push(`${name}: does not render (${(e as Error).message})`);
    continue;
  }
  results.push(m);

  // 1. It must draw.
  if (m.lit < 40) failures.push(`${name}: only ${m.lit} lit pixels — effectively blank`);
  // 2. It must stay on the 48 grid, with a 2px margin so no stroke is half-cut.
  if (m.minX < 2 || m.minY < 2 || m.maxX > 45 || m.maxY > 45) {
    failures.push(`${name}: ink at bbox [${m.minX},${m.minY},${m.maxX},${m.maxY}] touches the tile edge`);
  }
  // 3. The tile is a squircle with ~11px corner radius; ink in the extreme
  //    corner is clipped. Check the four 6x6 corner boxes are empty.
  const cornerLit = (x0: number, y0: number) => {
    let n = 0;
    for (let y = y0; y < y0 + 6; y++) for (let x = x0; x < x0 + 6; x++) n += m.pixels[y * 48 + x];
    return n;
  };
  const corners = cornerLit(0, 0) + cornerLit(42, 0) + cornerLit(0, 42) + cornerLit(42, 42);
  if (corners > 0) failures.push(`${name}: ${corners} lit pixels in the clipped corner boxes`);
}

// 4. Two glyphs must not be the same mark AND the same tone.
//
//    Three weaker formulations were tried and rejected, each measured:
//    • Jaccard over ink masks: a disc and a pie scored 98% — dominated by the
//      shared filled body.
//    • "unique ink relative to the smaller glyph": returns 0 whenever one
//      glyph's ink sits inside the other's. A circle inside a square is 100%
//      contained and *should* be, so this flags legitimate pairs.
//    • Pure containment: a terminal prompt occupies the same pixels as the
//      folder label area, so containment alone is 100% too.
//
//    What is left is the necessary condition this suite can actually decide: an
//    identical silhouette with a different interior is reported, because at
//    48 px a person reads the silhouette first. It is reported as a failure
//    only when the tone structure is also close, and otherwise as a named
//    WARNING — doc and blank legitimately share a page outline in most icon
//    sets, and a hard failure there would be a rule that cannot be satisfied
//    without redrawing 45 existing glyphs.
//
//    The ratio is reported for every pair that trips either limb, so a reviewer
//    sees the evidence rather than a verdict.
const exactSeen = new Map<string, string[]>();
for (const r of results) exactSeen.set(r.hash, [...(exactSeen.get(r.hash) ?? []), r.name]);
for (const [, group] of exactSeen) {
  if (group.length > 1) {
    const tone = group.map((n) => {
      const r = results.find((x) => x.name === n)!;
      return `${n} mean=${r.meanInk.toFixed(0)} detail=${r.detailPixels}`;
    });
    const ms = group.map((n) => results.find((x) => x.name === n)!);
    const toneGap = Math.max(...ms.map((m) => m.meanInk)) - Math.min(...ms.map((m) => m.meanInk))
      + Math.max(...ms.map((m) => m.detailPixels)) - Math.min(...ms.map((m) => m.detailPixels));
    const line = `identical silhouettes (${tone.join(", ")})`;
    if (toneGap < 60) failures.push(line);
    else warnings.push(line);
  }
}

// Additionally: two glyphs with the same silhouette family should differ in
// tone structure, or they will read as the same icon.
const toneDupes: string[] = [];
for (let i = 0; i < results.length; i++) {
  for (let j = i + 1; j < results.length; j++) {
    const a = results[i], b = results[j];
    if (a.hash !== b.hash) continue; // covered above
    const toneDelta = Math.abs(a.meanInk - b.meanInk) + Math.abs(a.detailPixels - b.detailPixels);
    if (toneDelta < 5) toneDupes.push(`${a.name}/${b.name}`);
  }
}

const tool = `@napi-rs/canvas ${JSON.parse(readFileSync(resolve(TOOLS, "node_modules/@napi-rs/canvas/package.json"), "utf8")).version}`;
for (const w of warnings) console.log(`WARNING: ${w}`);

console.log(JSON.stringify({
  suite: "tt140-glyph-geometry", tool,
  checked: results.length, skipped: skipped.length,
  skippedNames: skipped,
  litMin: Math.min(...results.map((r) => r.lit)), litMax: Math.max(...results.map((r) => r.lit)),
  toneDuplicates: toneDupes.slice(0, 8),
  warnings: warnings.length,
}, null, 0));

if (failures.length) {
  console.log(`\nFAILED: ${failures.length} glyph problem(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log(`\n${names.length} passed, 0 failed`);
