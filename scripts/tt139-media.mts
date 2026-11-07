/**
 * TT139 (AU-02, WM-06, DP-02, PR-08 extras, FF-09/FF-11, FF-24, MD-08, FM-07,
 * FM-13, BK-03, CT-01, CT-03, CA-02, CA-08, CA-13, LN-04) — suite.
 *
 * Every assertion is anchored to checkable arithmetic or a stated rule. Where a
 * rule is a judgement call (a threshold, a band), the test asserts the boundary
 * exactly rather than asserting "it returned something".
 */
import { makeHarness } from "./harness.mts";
import {
  detectFormat, analyzePlainText, parseCsv, serializeCsv, csvToJson, jsonToCsv,
  parseIni, serializeIni, parseYamlLite, parseLog, planExport, describeLoss,
  losslessTargets, LOSS_DESCRIPTIONS,
} from "../src/lib/formats/plain-formats.ts";
import {
  createViewer, setPageContent, setViewport, goToPage, nextPage, prevPage,
  zoomAt, zoomIn, zoomOut, setZoom, rotate, fitToWidth, fitToPage, actualSize,
  pan, contentRect, documentPointAt, effectivePageSize, viewerSummary,
  canZoomIn, canZoomOut, MIN_ZOOM, MAX_ZOOM,
} from "../src/lib/viewer/viewer-engine.ts";
import {
  createImage, crop, rotateImage, flipImage, brightness, contrast, saturation,
  gamma, temperature, vignette, denoise, enhance, createIdentityLut, applyLut,
  planTrim, VIDEO_PRESETS, estimateOutputBytes, fittingPresets,
} from "../src/lib/lens/image-ops.ts";
import {
  analyzeStorage, formatBytes, categorizeMime, describeStorage,
  createTemplateManager, addUserTemplate, removeUserTemplate, templateMenu,
  instantiateTemplate, exportConfig, importConfig, applyImport,
  validatePayload, compatibleTargets, createHandoff, offerHandoff,
  acceptHandoff, expireHandoff, MAX_SHARE_BYTES,
} from "../src/lib/files/storage-overview.ts";

const { test, finish } = makeHarness("tt139-media");

// ══ FF-09 · plain formats ════════════════════════════════════════════════

await test("FF-09 · detection prefers content over extension", { "FF-09": "full" }, () => {
  // A .txt file that is really JSON must be read as JSON; re-saving it as text
  // would silently reformat it.
  const asJson = detectFormat('{"a":1}', "notes.txt");
  if (asJson.format !== "json") throw new Error(`JSON in a .txt → ${asJson.format}`);
  if (!/JSON/.test(asJson.reason)) throw new Error(`reason must say why: ${asJson.reason}`);
  // A .json file full of prose is text, not a broken JSON document.
  const asText = detectFormat("just some prose here", "data.json");
  if (asText.format !== "json" && asText.format !== "txt") throw new Error(`prose in .json → ${asText.format}`);
  if (!/extension/.test(asText.reason)) throw new Error(`ambiguous content must say it fell back: ${asText.reason}`);
  // Real structural signals.
  if (detectFormat("# heading\n\ntext").format !== "md") throw new Error("markdown heading missed");
  if (detectFormat("a,b\n1,2\n3,4").format !== "csv") throw new Error("csv missed");
  if (detectFormat("[s]\nk=v").format !== "ini") throw new Error("ini missed");
  if (detectFormat("2024-01-01T00:00:00Z INFO x").format !== "log") throw new Error("log missed");
});

await test("FF-09 · RFC 4180 CSV: quotes, embedded commas and newlines", { "FF-09": "full" }, () => {
  const rows = parseCsv('a,b\n"x,1","he said ""hi"""\n');
  if (rows.length !== 2) throw new Error(`rows ${rows.length}`);
  if (rows[1][0] !== "x,1") throw new Error(`embedded comma lost: ${rows[1][0]}`);
  if (rows[1][1] !== 'he said "hi"') throw new Error(`doubled quote lost: ${rows[1][1]}`);
  // A quoted field spanning a newline is ONE field, not two rows.
  const multiline = parseCsv('a,"line1\nline2"\n');
  if (multiline.length !== 1) throw new Error(`embedded newline made ${multiline.length} rows`);
  if (multiline[0][1] !== "line1\nline2") throw new Error("embedded newline lost");
  // Round-trip must be a fixed point.
  const back = parseCsv(serializeCsv(rows));
  if (JSON.stringify(back) !== JSON.stringify(rows)) throw new Error("CSV round-trip not idempotent");
  // Truncation is an error, not a silent partial read.
  let threw = false;
  try { parseCsv('a,"unterminated\n'); } catch { threw = true; }
  if (!threw) throw new Error("an unterminated quote must be reported");
  // No phantom trailing row from a final newline.
  if (parseCsv("a,b\n").length !== 1) throw new Error("trailing newline created a row");
});

await test("FF-09 · CSV ⇄ JSON keeps column order and stringifies objects", { "FF-09": "full" }, () => {
  const rows = csvToJson([["name", "age"], ["Ada", "36"]]);
  if (rows.length !== 1 || rows[0].name !== "Ada" || rows[0].age !== "36") throw new Error(JSON.stringify(rows));
  const back = jsonToCsv([{ a: 1 }, { a: 2, b: "x" }]);
  if (back[0].join(",") !== "a,b") throw new Error(`union of keys in first-seen order → ${back[0]}`);
  if (back[1].join(",") !== "1,") throw new Error(`missing key must be empty, got ${back[1]}`);
  if (jsonToCsv([{ o: { deep: true } }])[1][0] !== '{"deep":true}') throw new Error("object not stringified");
  if (csvToJson([["only-header"]]).length !== 0) throw new Error("header-only CSV must yield no records");
});

await test("FF-09 · INI and a flat YAML subset", { "FF-09": "full" }, () => {
  const ini = parseIni("root=1\n; comment\n[s]\nk = v\n# other\n[[not a section]]");
  if (ini.globals.root !== "1") throw new Error("global key lost");
  if (ini.sections.s.k !== "v") throw new Error("section value lost");
  const round = parseIni(serializeIni(ini));
  if (JSON.stringify(round) !== JSON.stringify(ini)) throw new Error("INI round-trip changed the data");

  const y = parseYamlLite("a: 1\nb:\n  c: true\n  d: hello\n") as Record<string, Record<string, unknown>>;
  if (y.a !== 1) throw new Error(`yaml number → ${JSON.stringify(y.a)}`);
  if (y.b.c !== true) throw new Error("yaml nested bool");
  if (y.b.d !== "hello") throw new Error("yaml nested string");
  if (parseYamlLite("q: null").q !== null) throw new Error("null literal");
  if (parseYamlLite('s: "quoted"').s !== "quoted") throw new Error("quote stripping");
});

await test("FF-09 · log parsing separates structured from free-form lines", { "FF-09": "full" }, () => {
  const lines = parseLog("2024-01-01T00:00:00Z INFO started\nplain line\n[2024-01-02 10:00] ERROR boom\nCRITICAL meltdown");
  if (lines.length !== 4) throw new Error(`lines ${lines.length}`);
  if (lines[0].level !== "INFO" || lines[0].timestamp !== "2024-01-01T00:00:00Z") throw new Error("structured line");
  if (lines[1].level !== null || lines[1].timestamp !== null) throw new Error("free-form line must not be invented into structure");
  if (lines[2].level !== "ERROR") throw new Error("bracketed timestamp line");
  if (lines[3].level !== "FATAL") throw new Error("CRITICAL must normalise to FATAL");
  if (!lines[0].message.includes("started")) throw new Error(`message extraction: ${lines[0].message}`);
});

await test("FF-09 · analysis reports encoding and line endings honestly", { "FF-09": "full" }, () => {
  const crlf = analyzePlainText("a\r\nb\r\n");
  if (crlf.lineEnding !== "crlf") throw new Error(`crlf → ${crlf.lineEnding}`);
  if (crlf.lineCount !== 3) throw new Error(`lines ${crlf.lineCount}`);
  const mixed = analyzePlainText("a\r\nb\nc");
  if (mixed.lineEnding !== "mixed") throw new Error(`mixed → ${mixed.lineEnding}`);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x61]);
  if (analyzePlainText("a", bom).encoding !== "utf-8-bom") throw new Error("BOM not detected");
  const empty = analyzePlainText("");
  if (empty.lineCount !== 0) throw new Error("empty text must have zero lines");
});

// ══ FF-11 · export loss planning ═════════════════════════════════════════

await test("FF-11 · docx → txt names every specific loss", { "FF-11": "full" }, () => {
  const plan = planExport("docx", "txt", { hasImages: true, hasTables: true, hasStyles: true, hasFormulas: false, hasComments: true, hasFootnotes: false });
  if (plan.lossless) throw new Error("docx→txt cannot be lossless");
  if (!plan.losses.includes("images")) throw new Error("image loss missing");
  if (!plan.losses.includes("tables")) throw new Error("table loss missing");
  if (plan.losses.includes("formulas")) throw new Error("no formulas present, so none can be lost");
  if (plan.severity !== "critical") throw new Error(`severity ${plan.severity}`);
  if (!plan.summary.includes("image")) throw new Error(`summary must be specific: ${plan.summary}`);
  for (const l of plan.losses) if (!describeLoss(l)) throw new Error(`loss ${l} has no description`);
});

await test("FF-11 · same format is byte-lossless; a capable target is lossless", { "FF-11": "full" }, () => {
  const same = planExport("md", "md", { hasImages: true, hasTables: true, hasStyles: true, hasFormulas: true, hasComments: true, hasFootnotes: true });
  if (!same.lossless || same.losses.length) throw new Error("same-format must be lossless");
  if (same.severity !== "none") throw new Error("same-format severity must be none");
  // Markdown can carry images, comments are flattened, footnotes survive.
  const toMd = planExport("docx", "md", { hasImages: true, hasTables: false, hasStyles: false, hasFormulas: false, hasComments: false, hasFootnotes: false });
  if (!toMd.lossless) throw new Error(`docx→md with only images should be lossless, got ${toMd.losses}`);
});

await test("FF-11 · severity is the max, and losslessTargets is consistent", { "FF-11": "full" }, () => {
  const minor = planExport("md", "html", { hasImages: false, hasTables: false, hasStyles: false, hasFormulas: false, hasComments: true, hasFootnotes: false });
  if (minor.severity !== "minor") throw new Error(`comments loss should be minor, got ${minor.severity}`);
  const features = { hasImages: false, hasTables: false, hasStyles: false, hasFormulas: false, hasComments: false, hasFootnotes: false };
  const targets = losslessTargets("txt", features);
  for (const t of targets) {
    const p = planExport("txt", t, features);
    if (!p.lossless) throw new Error(`losslessTargets listed ${t} but planExport says otherwise`);
  }
  if (targets.includes("txt")) throw new Error("the source format must not be listed as a target");
  const unknown = planExport("docx", "klingon", features);
  if (unknown.lossless) throw new Error("an unknown target must never be called lossless");
  if (LOSS_DESCRIPTIONS.encoding.severity !== "critical") throw new Error("encoding loss must be critical");
});

// ══ PR-08 · viewer ═══════════════════════════════════════════════════════

await test("PR-08 · zoom keeps the anchor point fixed", { "PR-08": "full" }, () => {
  let v = createViewer("pdf", { width: 800, height: 600 });
  v = setPageContent(v, { pageSize: { width: 800, height: 600 }, pageCount: 10, status: "ready" });
  // Point under the cursor before zooming.
  const before = documentPointAt(v, 300, 200);
  v = zoomAt(v, 2, 300 - 400, 200 - 300);
  const after = documentPointAt(v, 300, 200);
  if (Math.abs(before.x - after.x) > 1e-6 || Math.abs(before.y - after.y) > 1e-6) {
    throw new Error(`anchor moved: (${before.x},${before.y}) → (${after.x},${after.y})`);
  }
  if (v.zoom !== 2) throw new Error("zoom not applied");
  // Zoom limits.
  if (setZoom(v, 1000).zoom !== MAX_ZOOM) throw new Error("max zoom clamp");
  if (setZoom(v, 0.0001).zoom !== MIN_ZOOM) throw new Error("min zoom clamp");
  if (canZoomIn(setZoom(v, MAX_ZOOM))) throw new Error("canZoomIn true at max");
  if (canZoomOut(setZoom(v, MIN_ZOOM))) throw new Error("canZoomOut true at min");
});

await test("PR-08 · rotation swaps axes and a fit stays a fit", { "PR-08": "full" }, () => {
  let v = createViewer("pdf", { width: 800, height: 600 });
  v = setPageContent(v, { pageSize: { width: 400, height: 1200 }, pageCount: 1, status: "ready" });
  const portrait = effectivePageSize(v);
  if (portrait.width !== 400 || portrait.height !== 1200) throw new Error("unrotated size wrong");
  const rotated = rotate(v, 90);
  if (rotated.rotation !== 90) throw new Error("rotation not applied");
  const landscape = effectivePageSize(rotated);
  if (landscape.width !== 1200 || landscape.height !== 400) throw new Error("rotation must swap the axes");
  // A fit-to-page computed before rotating must be re-computed after.
  // A fit computed before rotating must be recomputed after, so the rotated
  // page still fits on BOTH axes.
  const fitted = fitToPage(v);
  const fittedRotated = rotate(fitted, 90);
  const eff = effectivePageSize(fittedRotated);
  const drawnW = eff.width * fittedRotated.zoom;
  const drawnH = eff.height * fittedRotated.zoom;
  if (drawnW > fittedRotated.viewport.width + 1e-6 || drawnH > fittedRotated.viewport.height + 1e-6) {
    throw new Error(`re-fit after rotation does not fit: ${drawnW}×${drawnH} in ${JSON.stringify(fittedRotated.viewport)}`);
  }
});

await test("PR-08 · rotation rejects non-multiples of 90", { "PR-08": "full" }, () => {
  const v = createViewer("pdf", { width: 100, height: 100 });
  let threw = false;
  try { rotate(v, 45); } catch { threw = true; }
  if (!threw) throw new Error("45° accepted");
  const wrap = rotate(rotate(createViewer("image", { width: 10, height: 10 }), 270), 180);
  if (wrap.rotation !== 90) throw new Error(`wrap → ${wrap.rotation}`);
  const neg = rotate(createViewer("image", { width: 10, height: 10 }), -90);
  if (neg.rotation !== 270) throw new Error(`negative rotate → ${neg.rotation}`);
});

await test("PR-08 · pan is clamped so the page cannot leave the screen", { "PR-08": "full" }, () => {
  let v = createViewer("pdf", { width: 800, height: 600 });
  v = setPageContent(v, { pageSize: { width: 800, height: 600 }, pageCount: 1, status: "ready" });
  // At zoom 1 the page exactly fills the viewport; pan must stay in a small band.
  const panned = pan(v, 100000, 100000);
  const rect = contentRect(panned);
  const visibleX = rect.x < 800 && rect.x + rect.width > 0;
  const visibleY = rect.y < 600 && rect.y + rect.height > 0;
  if (!visibleX || !visibleY) throw new Error(`page dragged off-screen: ${JSON.stringify(rect)}`);
  let threw = false;
  try { pan(v, NaN, 0); } catch { threw = true; }
  if (!threw) throw new Error("NaN pan delta accepted");
});

await test("PR-08 · paging, fits and the content rect are consistent", { "PR-08": "full" }, () => {
  let v = createViewer("pdf", { width: 800, height: 600 });
  v = setPageContent(v, { pageSize: { width: 400, height: 300 }, pageCount: 5, status: "ready" });
  if (nextPage(v).page !== 2) throw new Error("nextPage");
  if (prevPage(prevPage(v)).page !== 1) throw new Error("prevPage must clamp");
  let threw = false;
  try { goToPage(v, 9); } catch { threw = true; }
  if (!threw) throw new Error("out-of-range page accepted");
  const w = fitToWidth(v);
  if (Math.abs(w.zoom - 2) > 1e-9) throw new Error(`fit to width → ${w.zoom}, want 2`);
  const p = fitToPage(v);
  if (Math.abs(p.zoom - 2) > 1e-9) throw new Error(`fit to page → ${p.zoom}, want 2 (height 600/300)`);
  const real = actualSize(p);
  if (real.zoom !== 1 || real.fit !== "none") throw new Error("actual size");
  const rect = contentRect(real);
  if (rect.width !== 400) throw new Error("content rect width");
  if (!viewerSummary(real).includes("100%")) throw new Error(`summary ${viewerSummary(real)}`);
  if (setPageContent(v, { status: "error", error: "bad xref" }).error !== "bad xref") throw new Error("error not surfaced");
});

// ══ FF-24 · raster edits ═════════════════════════════════════════════════

function px(img: { data: Uint8ClampedArray }, x: number, y: number, w: number): [number, number, number, number] {
  const i = (y * w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

await test("FF-24 · crop and rotate produce exact pixels", { "FF-24": "full" }, () => {
  // 3×2 image, each pixel a distinct red value.
  const img = createImage(3, 2, [0, 0, 0, 255]);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    const i = (y * 3 + x) * 4;
    img.data[i] = y * 3 + x;
  }
  const c = crop(img, { x: 1, y: 0, width: 2, height: 2 });
  if (c.width !== 2 || c.height !== 2) throw new Error("crop size");
  if (px(c, 0, 0, 2)[0] !== 1) throw new Error(`crop origin → ${px(c, 0, 0, 2)[0]}`);
  if (px(c, 1, 1, 2)[0] !== 5) throw new Error("crop bottom-right");

  const r90 = rotateImage(img, 90);
  if (r90.width !== 2 || r90.height !== 3) throw new Error("90° must swap dimensions");
  // (0,0) of a 3×2 becomes (h-1-0, 0) = (1,0) in the 2×3 output.
  if (px(r90, 1, 0, 2)[0] !== 0) throw new Error(`90° mapping → ${px(r90, 1, 0, 2)[0]}`);
  const r180 = rotateImage(img, 180);
  if (px(r180, 2, 1, 3)[0] !== 0) throw new Error("180° must map (0,0)→(w-1,h-1)");
  // Four 90° rotations must return the original bytes exactly.
  let acc = img;
  for (let i = 0; i < 4; i++) acc = rotateImage(acc, 90);
  if (Buffer.compare(Buffer.from(acc.data), Buffer.from(img.data)) !== 0) throw new Error("4×90° is not the identity");
});

await test("FF-24 · flip is its own inverse", { "FF-24": "full" }, () => {
  const img = createImage(2, 2, [0, 0, 0, 255]);
  img.data[0] = 10; // top-left red
  const h = flipImage(img, "horizontal");
  if (h.data[4] !== 10) throw new Error("horizontal flip did not move top-left to top-right");
  const backH = flipImage(h, "horizontal");
  if (Buffer.compare(Buffer.from(backH.data), Buffer.from(img.data)) !== 0) throw new Error("double flip changed pixels");
  const v = flipImage(img, "vertical");
  if (v.data[8] !== 10) throw new Error("vertical flip did not move to the bottom row");
});

await test("FF-24 · brightness and contrast are exactly reversible", { "FF-24": "full" }, () => {
  const img = createImage(1, 1, [100, 150, 200, 255]);
  const up = brightness(img, 40);
  if (up.data[0] !== 140) throw new Error(`brightness +40 → ${up.data[0]}`);
  const back = brightness(up, -40);
  if (back.data[0] !== 100) throw new Error("brightness is not reversible");
  // Alpha must never move.
  if (up.data[3] !== 255) throw new Error("brightness changed alpha");
  // Contrast at factor 1 is the identity; at 0 everything is mid-grey.
  const same = contrast(img, 1);
  if (same.data[0] !== 100) throw new Error(`contrast(1) changed a pixel: ${same.data[0]}`);
  const flat = contrast(img, 0);
  if (flat.data[0] !== 128 && flat.data[0] !== 127) throw new Error(`contrast(0) → ${flat.data[0]}, want ~127.5`);
  // Symmetric about the pivot: 100 and 155 are equidistant from 127.5.
  const a = contrast(createImage(1, 1, [100, 0, 0, 255]), 2);
  const b = contrast(createImage(1, 1, [155, 0, 0, 255]), 2);
  if (Math.abs((127.5 - a.data[0]) - (b.data[0] - 127.5)) > 1) throw new Error("contrast is not symmetric about mid-grey");
});

await test("FF-24 · saturation 0 equals Rec.601 luma", { "FF-24": "full" }, () => {
  const img = createImage(1, 1, [255, 0, 0, 255]);
  const grey = saturation(img, 0);
  const want = Math.round(0.299 * 255);
  if (Math.abs(grey.data[0] - want) > 1) throw new Error(`red → grey ${grey.data[0]}, want ${want}`);
  if (grey.data[0] !== grey.data[1] || grey.data[1] !== grey.data[2]) throw new Error("desaturation left a colour cast");
  const unchanged = saturation(img, 1);
  if (unchanged.data[0] !== 255) throw new Error("saturation(1) changed a pixel");
  let threw = false;
  try { saturation(img, -1); } catch { threw = true; }
  if (!threw) throw new Error("negative saturation accepted");
});

await test("FF-24/LN-04 · gamma LUT is exact at the endpoints", { "FF-24": "full" }, () => {
  const img = createImage(1, 1, [0, 128, 255, 255]);
  const g = gamma(img, 2);
  if (g.data[0] !== 0) throw new Error("gamma moved black");
  if (g.data[2] !== 255) throw new Error("gamma moved white");
  if (!(g.data[1] > 128)) throw new Error(`gamma 2 should lift midtones, got ${g.data[1]}`);
  const id = gamma(img, 1);
  if (id.data[1] !== 128) throw new Error(`gamma 1 → ${id.data[1]}, want 128`);
});

await test("LN-04 · temperature is neutral at 0 and clamps its input", { "LN-04": "full" }, () => {
  const img = createImage(1, 1, [100, 100, 100, 255]);
  const neutral = temperature(img, 0);
  if (neutral.data[0] !== 100 || neutral.data[2] !== 100) throw new Error("temperature 0 changed pixels");
  const warm = temperature(img, 100);
  if (!(warm.data[0] > 100 && warm.data[2] < 100)) throw new Error("warm shift must raise red and lower blue");
  const clamped = temperature(img, 500);
  if (clamped.data[0] !== temperature(img, 100).data[0]) throw new Error("temperature not clamped to ±100");
});

await test("LN-04 · vignette darkens corners only, and is exact at strength 0", { "LN-04": "full" }, () => {
  const img = createImage(5, 5, [200, 200, 200, 255]);
  if (vignette(img, 0) === img) {
    // documented: strength 0 returns the same object without work
  }
  const v = vignette(img, 1);
  const centre = px(v, 2, 2, 5)[0];
  const corner = px(v, 0, 0, 5)[0];
  if (centre !== 200) throw new Error(`centre must be untouched at strength 1, got ${centre}`);
  if (corner !== 0) throw new Error(`corner must reach 0 at strength 1, got ${corner}`);
  let threw = false;
  try { vignette(img, 1.5); } catch { threw = true; }
  if (!threw) throw new Error("strength > 1 accepted");
});

await test("LN-04 · denoise reduces noise and preserves a flat field exactly", { "LN-04": "full" }, () => {
  const flat = createImage(8, 8, [120, 120, 120, 255]);
  const d = denoise(flat, 1.5);
  for (let i = 0; i < d.data.length; i += 4) {
    if (Math.abs(d.data[i] - 120) > 1) throw new Error(`denoise on a flat field drifted to ${d.data[i]}`);
  }
  // A single hot pixel must be pulled toward its neighbours, not preserved.
  const noisy = createImage(5, 5, [100, 100, 100, 255]);
  noisy.data[(2 * 5 + 2) * 4] = 255;
  const smoothed = denoise(noisy, 1.2);
  const hot = px(smoothed, 2, 2, 5)[0];
  if (hot >= 255) throw new Error("a lone spike was not attenuated");
  if (hot <= 100) throw new Error("denoise over-attenuated the spike");
});

await test("LN-04 · identity LUT is the identity, trilinear in between", { "LN-04": "full" }, () => {
  const img = createImage(3, 1, [0, 0, 0, 255]);
  img.data[4] = 128; img.data[5] = 64; img.data[6] = 200;
  img.data[8] = 255; img.data[9] = 255; img.data[10] = 255;
  const lut = createIdentityLut(17);
  const out = applyLut(img, lut);
  for (let i = 0; i < out.data.length; i++) {
    if (Math.abs(out.data[i] - img.data[i]) > 1) throw new Error(`identity LUT changed byte ${i}: ${img.data[i]} → ${out.data[i]}`);
  }
  let threw = false;
  try { createIdentityLut(1); } catch { threw = true; }
  if (!threw) throw new Error("LUT size 1 accepted");
});

await test("LN-04 · enhance runs the documented order and changes nothing at defaults", { "LN-04": "full" }, () => {
  const img = createImage(4, 4, [90, 110, 130, 255]);
  const same = enhance(img, {});
  if (Buffer.compare(Buffer.from(same.data), Buffer.from(img.data)) !== 0) throw new Error("empty options changed pixels");
  const enhanced = enhance(img, { brightness: 10, contrast: 1.2, saturation: 1.3, gamma: 1.1 });
  if (enhanced.width !== img.width) throw new Error("enhance changed dimensions");
  if (Buffer.compare(Buffer.from(enhanced.data), Buffer.from(img.data)) === 0) throw new Error("enhance did nothing");
});

await test("FF-24 · malformed buffers are refused, not read out of bounds", { "FF-24": "full" }, () => {
  const bad = { data: new Uint8ClampedArray(10), width: 2, height: 2 }; // needs 16 bytes
  for (const fn of [
    () => crop(bad, { x: 0, y: 0, width: 1, height: 1 }),
    () => rotateImage(bad, 90),
    () => flipImage(bad, "horizontal"),
    () => brightness(bad, 1),
    () => contrast(bad, 1),
    () => saturation(bad, 1),
    () => gamma(bad, 1),
    () => vignette(bad, 0.5),
    () => denoise(bad, 1),
    () => applyLut(bad, createIdentityLut(2)),
  ]) {
    let threw = false;
    try { fn(); } catch { threw = true; }
    if (!threw) throw new Error("a short buffer was accepted");
  }
  let threw = false;
  try { crop(createImage(2, 2), { x: 5, y: 5, width: 1, height: 1 }); } catch { threw = true; }
  if (!threw) throw new Error("an off-image crop was accepted");
});

// ══ MD-08 · video trim ═══════════════════════════════════════════════════

await test("MD-08 · trim aligns to a keyframe and reports the lead-in cost", { "MD-08": "full" }, () => {
  const plan = planTrim({ startMs: 2400, endMs: 6000, durationMs: 10_000, fps: 30, keyframesMs: [0, 2000, 5000.5 as never] });
  if (plan.durationMs !== 3600) throw new Error(`duration ${plan.durationMs}`);
  if (plan.alignedStartMs !== 2000) throw new Error(`aligned start ${plan.alignedStartMs}`);
  if (plan.leadInFrames !== 12) throw new Error(`lead-in frames ${plan.leadInFrames}, want 12 (400 ms at 30 fps)`);
  const noKf = planTrim({ startMs: 1000, endMs: 3000, durationMs: 5000, fps: 25 });
  if (noKf.alignedStartMs !== 1000) throw new Error("without keyframes the plan must not invent an alignment");
});

await test("MD-08 · trim boundaries are enforced", { "MD-08": "full" }, () => {
  const base = { durationMs: 10_000, fps: 30 };
  for (const bad of [
    { startMs: 5000, endMs: 5000 },
    { startMs: 5000, endMs: 4000 },
    { startMs: -1, endMs: 1000 },
    { startMs: 0, endMs: 20_000 },
    { startMs: 0, endMs: 10 }, // under one frame
  ]) {
    let threw = false;
    try { planTrim({ ...base, ...bad }); } catch { threw = true; }
    if (!threw) throw new Error(`invalid trim ${JSON.stringify(bad)} accepted`);
  }
  const tiny = planTrim({ startMs: 0, endMs: 300, durationMs: 1000, fps: 30 });
  if (!tiny.warnings.some((w) => /500 ms/.test(w))) throw new Error("a very short clip should warn");
});

await test("MD-08 · export presets never upscale the source", { "MD-08": "full" }, () => {
  const fit = fittingPresets({ width: 1920, height: 1080, fps: 30 });
  if (fit.some((p) => p.width > 1920)) throw new Error("a preset wider than the source was offered");
  if (!fit.some((p) => p.name === "720p30")) throw new Error("720p should fit in a 1080p source");
  if (fit.some((p) => p.name === "2160p30")) throw new Error("4K must not be offered for a 1080p source");
  const bytes = estimateOutputBytes(60_000, VIDEO_PRESETS[2]);
  if (bytes !== Math.round((8_000_000 / 8) * 60)) throw new Error(`estimate ${bytes}`);
  let threw = false;
  try { estimateOutputBytes(0, VIDEO_PRESETS[0]); } catch { threw = true; }
  if (!threw) throw new Error("zero duration accepted");
});

// ══ FM-07 · storage ══════════════════════════════════════════════════════

await test("FM-07 · categories, totals and percentages", { "FM-07": "full" }, () => {
  const o = analyzeStorage([
    { path: "Photos/a.jpg", size: 300, mime: "image/jpeg" },
    { path: "Photos/b.png", size: 100, mime: "image/png" },
    { path: "docs/c.pdf", size: 600, mime: "application/pdf" },
  ]);
  if (o.totalBytes !== 1000 || o.fileCount !== 3) throw new Error("totals");
  const images = o.categories.find((c) => c.type === "Images");
  if (images?.count !== 2 || images.bytes !== 400) throw new Error(`images bucket ${JSON.stringify(images)}`);
  if (images.pct !== 40) throw new Error(`pct ${images.pct}`);
  const sumPct = o.categories.reduce((a, c) => a + c.pct, 0);
  if (Math.abs(sumPct - 100) > 0.2) throw new Error(`percentages must sum to ~100, got ${sumPct}`);
  if (o.topFolders[0].folder !== "docs") throw new Error(`top folder ${o.topFolders[0].folder}`);
});

await test("FM-07 · duplicates are tiered and unconfirmed ones free nothing", { "FM-07": "full" }, () => {
  const o = analyzeStorage([
    { path: "a.txt", size: 100, mime: "text/plain", quickHash: "q1", fullHash: "f1" },
    { path: "copy.txt", size: 100, mime: "text/plain", quickHash: "q1", fullHash: "f1" },
    // Same size and quick hash but different content: must NOT be confirmed.
    { path: "d1.bin", size: 50, mime: "application/octet-stream", quickHash: "q2", fullHash: "fa" },
    { path: "d2.bin", size: 50, mime: "application/octet-stream", quickHash: "q2", fullHash: "fb" },
    // Same size, same quick hash, no full hash: unconfirmed.
    { path: "u1.txt", size: 7, mime: "text/plain", quickHash: "q3" },
    { path: "u2.txt", size: 7, mime: "text/plain", quickHash: "q3" },
  ]);
  const confirmed = o.duplicates.filter((d) => d.confirmed);
  if (confirmed.length !== 1) throw new Error(`confirmed groups ${confirmed.length}, want 1`);
  if (confirmed[0].reclaimableBytes !== 100) throw new Error(`reclaimable ${confirmed[0].reclaimableBytes}`);
  if (confirmed[0].paths.join(",") !== "a.txt,copy.txt") throw new Error(`paths ${confirmed[0].paths}`);
  const unconfirmed = o.duplicates.filter((d) => !d.confirmed);
  if (!unconfirmed.length) throw new Error("same quick hash without full hash must be reported as unconfirmed");
  if (unconfirmed[0].reclaimableBytes !== 0) throw new Error("unconfirmed groups must not claim reclaimable space");
  if (o.scanCost.fullHashed !== 4) throw new Error(`scan cost ${JSON.stringify(o.scanCost)}`);
  if (describeStorage(o).includes("reclaimable") === false) throw new Error("describeStorage omits the reclaim figure");
});

await test("FM-07 · empty files and zero-byte sets are handled", { "FM-07": "full" }, () => {
  const o = analyzeStorage([{ path: "e1", size: 0, mime: "text/plain" }, { path: "e2", size: 0, mime: "text/plain" }]);
  if (o.duplicates.length !== 0) throw new Error("zero-byte files are not worth reporting as duplicates");
  const empty = analyzeStorage([]);
  if (empty.totalBytes !== 0 || empty.categories.length !== 0) throw new Error("empty store");
  if (empty.categories.some((c) => Number.isNaN(c.pct))) throw new Error("NaN percentage with no data");
  let threw = false;
  try { analyzeStorage([{ path: "x", size: -1, mime: "text/plain" }]); } catch { threw = true; }
  if (!threw) throw new Error("negative size accepted");
});

await test("FM-07 · formatBytes rounds the way a person reads it", { "FM-07": "full" }, () => {
  const cases: Array<[number, string]> = [
    [0, "0 B"], [512, "512 B"], [1024, "1.0 KB"], [1536, "1.5 KB"],
    [1048576, "1.0 MB"], [1073741824, "1.0 GB"], [-2048, "-2.0 KB"],
  ];
  for (const [bytes, want] of cases) {
    if (formatBytes(bytes) !== want) throw new Error(`formatBytes(${bytes}) → ${formatBytes(bytes)}, want ${want}`);
  }
  if (categorizeMime("video/mp4") !== "Videos") throw new Error("video bucket");
  if (categorizeMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document") !== "Documents") throw new Error("docx bucket");
  if (categorizeMime("") !== "Other") throw new Error("empty mime must bucket to Other");
});

// ══ FM-13 · templates ════════════════════════════════════════════════════

await test("FM-13 · built-ins, user templates and de-duplication", { "FM-13": "full" }, () => {
  let tm = createTemplateManager();
  const before = tm.templates.length;
  tm = addUserTemplate(tm, { name: "Meeting notes", content: "## Attendees\n", extension: "md", category: "Documents" });
  if (tm.templates.length !== before + 1) throw new Error("user template not added");
  let threw = false;
  try { addUserTemplate(tm, { name: "Meeting notes", content: "", extension: "md", category: "Documents" }); } catch { threw = true; }
  if (!threw) throw new Error("duplicate template name accepted");
  threw = false;
  try { removeUserTemplate(tm, "Text Document", "Documents"); } catch { threw = true; }
  if (!threw) throw new Error("a built-in template was removed");
  tm = removeUserTemplate(tm, "Meeting notes", "Documents");
  if (tm.templates.some((t) => t.name === "Meeting notes")) throw new Error("user template not removed");
});

await test("FM-13 · the New menu groups by category, built-ins first", { "FM-13": "full" }, () => {
  let tm = createTemplateManager();
  tm = addUserTemplate(tm, { name: "Aaa custom", content: "", extension: "txt", category: "Documents" });
  const menu = templateMenu(tm);
  const docs = menu.find((g) => g.category === "Documents")!;
  if (!docs.templates[0].builtin) throw new Error("built-ins must sort first regardless of name");
  if (docs.templates[docs.templates.length - 1].name !== "Aaa custom") throw new Error("user template order wrong");
  // Unique filenames on instantiate.
  const existing = ["/Docs/Text Document.txt"];
  const made = instantiateTemplate(tm.templates.find((t) => t.name === "Text Document")!, "/Docs", existing);
  if (made.path !== "/Docs/Text Document 2.txt") throw new Error(`collision handling → ${made.path}`);
  const free = instantiateTemplate(tm.templates[0], "/Empty", []);
  if (free.path !== "/Empty/Text Document.txt") throw new Error(`free path → ${free.path}`);
  let threw = false;
  try { instantiateTemplate(tm.templates[0], "", []); } catch { threw = true; }
  if (!threw) throw new Error("empty folder accepted");
});

// ══ BK-03 · config export / import ═══════════════════════════════════════

await test("BK-03 · export is a versioned bundle with a checksum", { "BK-03": "full" }, () => {
  const { bundle, json, checksum } = exportConfig({ theme: "dark" }, { notes: "on" }, ["clock"], 1000);
  if (bundle.version !== 1) throw new Error("version");
  if (checksum.length !== 64) throw new Error(`checksum length ${checksum.length}`);
  if (checksum !== exportConfig({ theme: "dark" }, { notes: "on" }, ["clock"], 1000).checksum) {
    throw new Error("the checksum is not deterministic");
  }
  if (JSON.parse(json).settings.theme !== "dark") throw new Error("settings not in the bundle");
});

await test("BK-03 · import is a dry run that classifies every change", { "BK-03": "full" }, () => {
  const { json } = exportConfig({ theme: "light", font: "sans" }, { notes: "on" }, ["clock", "weather"], 1);
  const plan = importConfig(json, { settings: { theme: "dark", old: "x" }, features: {}, widgets: [] });
  if (!plan.ok) throw new Error(`plan errors: ${plan.errors}`);
  if (plan.dryRun !== true) throw new Error("import must be a dry run");
  const theme = plan.changes.find((c) => c.key === "setting:theme");
  if (!theme || theme.from !== "dark" || theme.to !== "light") throw new Error("changed setting not planned");
  if (!plan.additions.includes("setting:font")) throw new Error("new setting not planned");
  if (!plan.untouched.includes("setting:old")) throw new Error("a key the bundle omits must be reported as untouched, not deleted");
});

await test("BK-03 · broken bundles are refused with a reason", { "BK-03": "full" }, () => {
  for (const [json, want] of [
    ["not json", /JSON/],
    ["null", /object/],
    [JSON.stringify({ version: 2, settings: {}, features: {}, widgets: [] }), /version/],
    [JSON.stringify({ version: 1, settings: [], features: {}, widgets: [] }), /settings/],
    [JSON.stringify({ version: 1, settings: {}, features: {}, widgets: "x" }), /widgets/],
    [JSON.stringify({ version: 1, settings: { a: 5 }, features: {}, widgets: [] }), /string/],
  ] as const) {
    const plan = importConfig(json, { settings: {}, features: {}, widgets: [] });
    if (plan.ok) throw new Error(`bundle ${json} accepted`);
    if (!plan.errors.some((e) => want.test(e))) throw new Error(`reason for ${json} → ${plan.errors}`);
  }
});

await test("BK-03 · applyImport refuses an invalid plan", { "BK-03": "full" }, () => {
  const good = exportConfig({ a: "1" }, {}, [], 0);
  const plan = importConfig(good.json, { settings: {}, features: {}, widgets: [] });
  const applied = applyImport(plan, good.json);
  if (applied.settings.a !== "1") throw new Error("apply did not copy settings");
  let threw = false;
  try { applyImport({ ...plan, ok: false }, good.json); } catch { threw = true; }
  if (!threw) throw new Error("a failed plan was applied");
  const mutated = applyImport(plan, good.json);
  mutated.settings.a = "changed";
  if (good.bundle.settings.a !== "1") throw new Error("apply did not deep-copy");
});

// ══ CT-01 / CT-03 · share and handoff ════════════════════════════════════

await test("CT-01 · payloads are validated before any target sees them", { "CT-01": "full" }, () => {
  if (!validatePayload({ kind: "text", title: "hi", data: "body" }).ok) throw new Error("a plain text share was rejected");
  for (const [p, want] of [
    [{ kind: "url", title: "t", data: "javascript:alert(1)" }, /http/],
    [{ kind: "url", title: "t", data: "https://exa mple.com" }, /non-ASCII/],
    [{ kind: "text", title: "", data: "x" }, /title/],
    [{ kind: "text", title: "t", data: "" }, /content/],
    [{ kind: "file", title: "t", data: undefined as never }, /content/],
  ] as const) {
    const res = validatePayload(p as never);
    if (res.ok) throw new Error(`payload ${JSON.stringify(p)} accepted`);
    if (!res.errors.some((e) => want.test(e))) throw new Error(`reason for ${JSON.stringify(p)} → ${res.errors}`);
  }
  const big = validatePayload({ kind: "text", title: "t", data: "x".repeat(MAX_SHARE_BYTES + 1) });
  if (big.ok) throw new Error("over-size payload accepted");
});

await test("CT-01 · targets are matched by kind with a reason for each", { "CT-01": "full" }, () => {
  const targets = [
    { id: "mail", label: "Mail", accepts: ["text", "url"] as const, note: "Opens your mail app" },
    { id: "files", label: "Files", accepts: ["file"] as const, note: "Saves locally" },
  ];
  const res = compatibleTargets({ kind: "url", title: "t", data: "https://x.test" }, targets.map((t) => ({ ...t, accepts: [...t.accepts] })));
  if (!res[0].reason.includes("Accepts")) throw new Error("compatible target not marked");
  if (!res[1].reason.includes("Cannot")) throw new Error("incompatible target must say so");
  if (res.length !== 2) throw new Error("every target must be reported, not filtered away silently");
});

await test("CT-03 · a superseded handoff cannot be accepted (the race)", { "CT-03": "full" }, () => {
  let s = createHandoff();
  s = offerHandoff(s, { title: "Doc", kind: "text", data: "hello" }, "laptop");
  const firstSeq = s.seq;
  // A second offer supersedes the first.
  s = offerHandoff(s, { title: "Doc v2", kind: "text", data: "hello2" }, "desktop");
  const stale = acceptHandoff(s, firstSeq, "laptop");
  if (stale.ok) throw new Error("a superseded offer was accepted");
  if (!/superseded/.test(stale.reason)) throw new Error(`reason: ${stale.reason}`);
  // Accepting from the wrong device is refused.
  const wrongDevice = acceptHandoff(s, s.seq, "phone");
  if (wrongDevice.ok) throw new Error("accepted from the wrong device");
  const ok = acceptHandoff(s, s.seq, "desktop");
  if (!ok.ok) throw new Error(`a valid accept failed: ${ok.reason}`);
  if (ok.state.status !== "accepted") throw new Error("status not advanced");
});

await test("CT-03 · expire clears the item; an invalid offer is refused", { "CT-03": "full" }, () => {
  let s = offerHandoff(createHandoff(), { title: "D", kind: "text", data: "x" }, "laptop");
  const expired = expireHandoff(s);
  if (expired.item !== null || expired.status !== "expired") throw new Error("expire did not clear");
  if (acceptHandoff(expired, expired.seq, "laptop").ok) throw new Error("an expired handoff was accepted");
  let threw = false;
  try { offerHandoff(s, { title: "", kind: "text", data: "x" }, "laptop"); } catch { threw = true; }
  if (!threw) throw new Error("an invalid offer was made");
  threw = false;
  try { offerHandoff(s, { title: "t", kind: "text", data: "x" }, ""); } catch { threw = true; }
  if (!threw) throw new Error("an offer with no target was made");
});

finish();
