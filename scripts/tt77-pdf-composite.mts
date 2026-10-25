/**
 * TT77 — PDF transparency compositing in real Chromium: soft masks (Alpha / Luminosity, /BC, /TR), transparency groups
 * (isolated / non-isolated, group alpha), knockout groups, blend modes, fill+stroke as a knockout pair (§11.7.4.4),
 * /Matte un-premultiplication and the page/paper split.
 *
 * Each case is a hand-built PDF whose expected pixels were computed BY HAND from ISO 32000-2 §11 (the arithmetic is in
 * the comment of each case), rendered by the real engine (pdfcanvas.ts) on a Chromium canvas. Tolerance ±3 per
 * channel (canvas 8-bit rounding). Where PDFium departs from the spec the case says so (PDFium ignores /K and
 * /SMaskInData 2), and the spec value is what is asserted.
 */
import { build } from "esbuild";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { onePage } from "./tt77/rawpdf.ts";

const H = makeHarness("tt77-pdf-composite");
const bundle = await build({ entryPoints: ["scripts/tt52/render-entry.ts"], bundle: true, write: false, format: "iife", target: "es2022", logLevel: "silent" });
const js = bundle.outputFiles[0].text;
const browser = await launchChromium(); const page = await browser.newPage();
await page.setContent("<html><body></body></html>"); await page.addScriptTag({ content: js });

type Px = number[];
async function probe(pdf: Uint8Array, pts: [number, number][]): Promise<Px[]> {
  const b64 = Buffer.from(pdf).toString("base64");
  const r = await page.evaluate(([b, p]) => (window as unknown as { __pdf: { probe: (b: string, p: [number, number][]) => Promise<{ px?: Px[]; error?: string }> } }).__pdf.probe(b, p), [b64, pts] as const);
  if (r.error || !r.px) throw new Error(r.error ?? "no pixels");
  return r.px;
}
function near(got: Px, want: number[], tol = 3, what = "") {
  for (let k = 0; k < want.length; k++) if (Math.abs(got[k] - want[k]) > tol) throw new Error(`${what} got (${got.slice(0, want.length).join(",")}) want (${want.join(",")})`);
}
// page is 100×100 pt at scale 1: device (x, 100 − y)
const C = { "FF-03": "full" as const, "PR-08": "partial" as const, "FF-68": "full" as const };
const WHITE_BG = "1 g 0 0 100 100 re f ";

await H.test("C1 fill+stroke at ca=CA=.5 is a knockout pair: interior = fill over backdrop, stroke over backdrop (not over fill)", C, async () => {
  // interior: green .5 over white = (127.5, 255, 127.5). Stroke band (x=20): stroke (0,127,0) at .5 over WHITE (the fill is knocked
  // out under the stroke) = (127.5, 191, 127.5). Without the knockout pair the inner half of the stroke would be (63.5, 159, 63.5).
  const pdf = onePage(WHITE_BG + "/G1 gs 0 1 0 rg 0 0.498 0 RG 10 w 20 20 60 60 re B", "<< /ExtGState << /G1 << /ca 0.5 /CA 0.5 >> >> >>");
  const [inside, onStroke] = await probe(pdf, [[50, 50], [22, 50]]);
  near(inside, [128, 255, 128], 3, "interior"); near(onStroke, [128, 191, 128], 3, "stroke");
});
await H.test("C1b the same knockout pair straight on the (transparent) page, nothing under it: identical result once the paper goes under", C, async () => {
  const pdf = onePage("/G1 gs 0 1 0 rg 0 0.498 0 RG 10 w 20 20 60 60 re B", "<< /ExtGState << /G1 << /ca 0.5 /CA 0.5 >> >> >>");
  const [inside, onStroke] = await probe(pdf, [[50, 50], [22, 50]]);
  near(inside, [128, 255, 128], 3, "interior"); near(onStroke, [128, 191, 128], 3, "stroke");
});
await H.test("C2 fill+stroke with BM Difference over white: both halves are the complement (yellow → blue)", C, async () => {
  const pdf = onePage(WHITE_BG + "/G1 gs 1 1 0 rg 1 1 0 RG 10 w 20 20 60 60 re B", "<< /ExtGState << /G1 << /BM /Difference >> >> >>");
  const [inside, onStroke] = await probe(pdf, [[50, 50], [22, 50]]);
  near(inside, [0, 0, 255], 3, "interior"); near(onStroke, [0, 0, 255], 3, "stroke");
});
await H.test("C3 page backdrop is transparent: Difference straight on the page (nothing under it) is Normal; paper goes under afterwards", C, async () => {
  const pdf = onePage("/G1 gs 1 1 0 rg 20 20 60 60 re f", "<< /ExtGState << /G1 << /BM /Difference >> >> >>");
  near((await probe(pdf, [[50, 50]]))[0], [255, 255, 0], 3);
});
await H.test("C4 blend Multiply: cyan × yellow = green; Screen: red ⊕ blue = magenta", C, async () => {
  const pdf = onePage(WHITE_BG + "0 1 1 rg 10 10 40 80 re f /M gs 1 1 0 rg 10 10 40 80 re f /N gs 0 0 1 rg 50 10 40 80 re f /S gs 1 0 0 rg 50 10 40 80 re f", "<< /ExtGState << /M << /BM /Multiply >> /S << /BM /Screen >> /N << /BM /Normal >> >> >>");
  const [m, s] = await probe(pdf, [[30, 50], [70, 50]]);
  near(m, [0, 255, 0], 3, "multiply"); near(s, [255, 0, 255], 3, "screen");
});

const maskForm = (content: string, extra = "") => ({ dict: `/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS /DeviceGray ${extra} >> /Resources << /ExtGState << /Q << /ca 0.25 >> >> >>`, data: content });
await H.test("C5 Luminosity soft mask: mask group paints gray .5 → red at 50% over white = (255,128,128)", C, async () => {
  const pdf = onePage(WHITE_BG + "/SM gs 1 0 0 rg 0 0 100 100 re f", "<< /ExtGState << /SM << /SMask << /S /Luminosity /G 4 0 R >> >> >> >>", [maskForm("0.5 g 0 0 100 100 re f")]);
  near((await probe(pdf, [[50, 50]]))[0], [255, 128, 128]);
});
await H.test("C6 Luminosity /BC: empty mask group over BC [1] → mask 1 (full red); without /BC the backdrop is black → nothing painted", C, async () => {
  const withBC = onePage(WHITE_BG + "/SM gs 1 0 0 rg 0 0 100 100 re f", "<< /ExtGState << /SM << /SMask << /S /Luminosity /G 4 0 R /BC [1] >> >> >> >>", [maskForm("")]);
  near((await probe(withBC, [[50, 50]]))[0], [255, 0, 0], 3, "BC [1]");
  const noBC = onePage(WHITE_BG + "/SM gs 1 0 0 rg 0 0 100 100 re f", "<< /ExtGState << /SM << /SMask << /S /Luminosity /G 4 0 R >> >> >> >>", [maskForm("")]);
  near((await probe(noBC, [[50, 50]]))[0], [255, 255, 255], 3, "no BC");
});
await H.test("C7 Luminosity mask in a DeviceCMYK group with no /BC: backdrop = zero components = WHITE → mask 1", C, async () => {
  const pdf = onePage(WHITE_BG + "/SM gs 1 0 0 rg 0 0 100 100 re f", "<< /ExtGState << /SM << /SMask << /S /Luminosity /G 4 0 R >> >> >> >>",
    [{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /CS /DeviceCMYK >>", data: "" }]);
  near((await probe(pdf, [[50, 50]]))[0], [255, 0, 0]);
});
await H.test("C8 Alpha soft mask: mask group paints at ca .25 → red at 25% over white = (255,191,191)", C, async () => {
  const pdf = onePage(WHITE_BG + "/SM gs 1 0 0 rg 0 0 100 100 re f", "<< /ExtGState << /SM << /SMask << /S /Alpha /G 4 0 R >> >> >> >>", [maskForm("/Q gs 0 g 0 0 100 100 re f")]);
  near((await probe(pdf, [[50, 50]]))[0], [255, 191, 191]);
});
await H.test("C9 soft mask /TR: an inverting transfer function maps luminosity 1 → 0 → nothing painted", C, async () => {
  const pdf = onePage(WHITE_BG + "/SM gs 1 0 0 rg 0 0 100 100 re f", "<< /ExtGState << /SM << /SMask << /S /Luminosity /G 4 0 R /TR << /FunctionType 2 /Domain [0 1] /C0 [1] /C1 [0] /N 1 >> >> >> >> >>", [maskForm("1 g 0 0 100 100 re f")]);
  near((await probe(pdf, [[50, 50]]))[0], [255, 255, 255]);
});
await H.test("C10 group alpha: two overlapping OPAQUE rects in a group drawn at ca .5 → overlap is blue at 50% (not blue over red)", C, async () => {
  // group result in the overlap is opaque blue; × .5 over white = (127.5,127.5,255). Per-object alpha would give (63.75,63.75,191)
  const pdf = onePage(WHITE_BG + "/H gs /F Do", "<< /ExtGState << /H << /ca 0.5 >> >> /XObject << /F 4 0 R >> >>",
    [{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency >>", data: "1 0 0 rg 10 10 50 50 re f 0 0 1 rg 40 40 50 50 re f" }]);
  const [overlap, redOnly] = await probe(pdf, [[50, 50], [20, 80]]);
  near(overlap, [128, 128, 255], 3, "overlap"); near(redOnly, [255, 128, 128], 3, "red only");
});
await H.test("C11 isolated knockout group: blue at .5 knocks out red at .5 → overlap = blue .5 over white (PDFium ignores /K: (128,64,191))", C, async () => {
  const pdf = onePage(WHITE_BG + "/F Do", "<< /XObject << /F 4 0 R >> >>",
    [{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true /K true >> /Resources << /ExtGState << /A << /ca 0.5 >> >> >>", data: "/A gs 1 0 0 rg 10 10 50 50 re f 0 0 1 rg 40 40 50 50 re f" }]);
  const [overlap, redOnly] = await probe(pdf, [[50, 50], [20, 80]]);
  near(overlap, [128, 128, 255], 3, "overlap"); near(redOnly, [255, 128, 128], 3, "red only");
});
await H.test("C12 non-isolated knockout group over a black backdrop: knocked-out area returns to the BACKDROP, not to transparent", C, async () => {
  // backdrop black; in the group red .5 then blue .5 overlapping: overlap = blue .5 over black = (0,0,127.5)
  const pdf = onePage("0 g 0 0 100 100 re f /F Do", "<< /XObject << /F 4 0 R >> >>",
    [{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /K true >> /Resources << /ExtGState << /A << /ca 0.5 >> >> >>", data: "/A gs 1 0 0 rg 10 10 50 50 re f 0 0 1 rg 40 40 50 50 re f" }]);
  const [overlap, redOnly] = await probe(pdf, [[50, 50], [20, 80]]);
  near(overlap, [0, 0, 128], 3, "overlap"); near(redOnly, [128, 0, 0], 3, "red only");
});
await H.test("C13 nested group inside a knockout group knocks out by its SHAPE: inner group of blue at .5 → overlap blue .5 over white", C, async () => {
  const pdf = onePage(WHITE_BG + "/O Do", "<< /XObject << /O 4 0 R >> >>", [
    { dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true /K true >> /Resources << /XObject << /C 5 0 R >> >>", data: "1 0 0 rg 10 10 50 50 re f /C Do" },
    { dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency /I true /K true >> /Resources << /ExtGState << /A << /ca 0.5 >> >> >>", data: "/A gs 0 0 1 rg 40 40 50 50 re f" },
  ]);
  near((await probe(pdf, [[50, 50]]))[0], [128, 128, 255]);
});
await H.test("C14 negative: a soft mask whose group is not a stream, a mask cycle-depth bomb and /SMask /None all render without throwing", C, async () => {
  const bad = onePage(WHITE_BG + "/SM gs 1 0 0 rg 0 0 100 100 re f /NN gs 0 0 1 rg 0 0 10 10 re f", "<< /ExtGState << /SM << /SMask << /S /Luminosity /G 99 0 R >> >> /NN << /SMask /None >> >> >>");
  const [a, b] = await probe(bad, [[50, 50], [5, 95]]);
  near(a, [255, 0, 0], 3, "missing group = no mask"); near(b, [0, 0, 255], 3, "/None");
  // a mask group that uses the same ExtGState (self-referential mask): bounded by the mask depth limit
  const self = onePage(WHITE_BG + "/SM gs 1 0 0 rg 0 0 100 100 re f", "<< /ExtGState << /SM << /SMask << /S /Luminosity /G 4 0 R >> >> >> >>",
    [{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency >> /Resources << /ExtGState << /SM << /SMask << /S /Luminosity /G 4 0 R >> >> >> >>", data: "/SM gs 1 g 0 0 100 100 re f" }]);
  const t0 = Date.now(); await probe(self, [[50, 50]]); if (Date.now() - t0 > 8000) throw new Error("self-referential mask not bounded");
});
await H.test("C15 /Matte: an image premultiplied against matte black, α .5, un-premultiplies to its true colour", C, async () => {
  // image sample (128,0,0) premultiplied with α=128/255 against black: true colour = 128·255/128 = 255 → red at .5 over white = (255,128,128)
  const img = { dict: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask 5 0 R", data: new Uint8Array([128, 0, 0]) };
  const sm = { dict: "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Matte [0 0 0]", data: new Uint8Array([128]) };
  const pdf = onePage(WHITE_BG + "q 100 0 0 100 0 0 cm /I Do Q", "<< /XObject << /I 4 0 R >> >>", [img, sm]);
  near((await probe(pdf, [[50, 50]]))[0], [255, 128, 128]);
});

await H.test("C16 non-isolated group over a SEMI-TRANSPARENT backdrop (transparent page): the backdrop is not counted twice", C, async () => {
  // page: green at .5 everywhere (no paper yet). Group (non-isolated, Do alpha 1 / .5) paints blue at the bottom-left only.
  // Away from the blue the result must stay green .5 over paper = (127.5,255,127.5); a source-over of the backdrop copy gives (63,255,63).
  for (const ga of ["1", "0.5"]) {
    const pdf = onePage(`/A gs 0 1 0 rg 0 0 100 100 re f /D${ga === "1" ? "1" : "2"} gs /F Do`, "<< /ExtGState << /A << /ca 0.5 >> /D1 << /ca 1 >> /D2 << /ca 0.5 >> >> /XObject << /F 4 0 R >> >>",
      [{ dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Group << /S /Transparency >>", data: "0 0 1 rg 0 0 20 20 re f" }]);
    const [away, blue] = await probe(pdf, [[70, 30], [10, 90]]);
    near(away, [128, 255, 128], 3, `ca ${ga} away`);
    // blue opaque inside the group over green .5: group result = blue; × k over the backdrop: k=1 → blue; k=.5 → lerp(green.5-over-paper, blue, .5)
    near(blue, ga === "1" ? [0, 0, 255] : [64, 128, 191], 4, `ca ${ga} blue`);
  }
});
await browser.close();
H.finish();
