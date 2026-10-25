/**
 * Real-browser suite "e2e-image" (TT16): Image Studio over a running production server, Playwright + headless
 * Chromium, real mouse/keyboard. Pixel assertions read the studio canvas with getImageData (no component internals).
 * Test 1 is an independent ORACLE: Chromium/Skia's canvas globalCompositeOperation (W3C Compositing-1) vs our
 * compositor, all 12 separable blend modes.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-image.mts
 */
import { type Browser, type Locator, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { CANVAS_BLENDS, compositeRegion, makeLayer, type ImageDoc } from "../src/lib/image/doc.ts";
import { readPsd } from "../src/lib/image/psd.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `img${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-image");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default");
  const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}

const browser: Browser = await launchChromium();
const errors: string[] = [];
interface Studio { page: Page; dlg: Locator; root: Locator; canvas: Locator; px: (x: number, y: number) => Promise<number[]>; at: (x: number, y: number) => Promise<{ x: number; y: number }>; drag: (a: [number, number], b: [number, number], steps?: number) => Promise<void>; click: (x: number, y: number) => Promise<void>; tool: (n: string) => Promise<void>; attr: (k: string) => Promise<string | null>; close: () => Promise<void> }
async function openStudio(path?: string): Promise<Studio> {
  await resetDesktop();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/?open=imageedit${path ? `&path=${encodeURIComponent(path)}` : ""}`, { waitUntil: "domcontentloaded" });
  const dlg = page.locator('[role=dialog][aria-label="Image Editor"]').first();
  await dlg.waitFor({ state: "visible", timeout: 20_000 });
  const root = dlg.locator('[data-testid="image-studio"]');
  await root.waitFor({ timeout: 20_000 });
  const canvas = root.locator('[data-testid="studio-canvas"]');
  const attr = (k: string) => root.getAttribute(`data-${k}`);
  const at = async (x: number, y: number) => {
    const b = (await canvas.boundingBox())!; const w = Number(await attr("doc-w")), h = Number(await attr("doc-h"));
    return { x: b.x + (x + 0.5) / w * b.width, y: b.y + (y + 0.5) / h * b.height };
  };
  const px = (x: number, y: number) => canvas.evaluate((c: HTMLCanvasElement, [x, y]) => Array.from(c.getContext("2d")!.getImageData(x, y, 1, 1).data), [x, y]);
  const drag = async (a: [number, number], b: [number, number], steps = 12) => { const p = await at(...a), q = await at(...b); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps }); await page.mouse.up(); };
  const click = async (x: number, y: number) => { const p = await at(x, y); await page.mouse.click(p.x, p.y); };
  const tool = (n: string) => root.getByRole("toolbar", { name: "Tools" }).getByRole("button", { name: n, exact: true }).click();
  return { page, dlg, root, canvas, px, at, drag, click, tool, attr, close: () => ctx.close() };
}
const setRange = (l: Locator, v: number) => l.evaluate((el: HTMLInputElement, v) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, v);
const waitMsg = async (s: { root: Locator; page: Page }, re: RegExp) => { for (let i = 0; i < 100; i++) { const t = await s.root.locator('[data-testid="studio-message"]').innerText(); if (re.test(t)) return t; await s.page.waitForTimeout(100); } throw new Error(`message never matched ${re}`); };
const near = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const waitAttr = async (s: Studio, k: string, v: string) => { for (let i = 0; i < 100; i++) { if ((await s.attr(k)) === v) return; await s.page.waitForTimeout(100); } throw new Error(`data-${k} never became ${v} (is ${await s.attr(k)})`); };

await test("ORACLE: our compositor vs Chromium/Skia globalCompositeOperation — the 16 canvas blend modes (incl. hue/saturation/color/luminosity), opaque and translucent backdrops", { "FF-30": "full" }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto("about:blank");
  let seed = 7; const r = () => ((seed = (1664525 * seed + 1013904223) >>> 0) / 4294967296);
  const W = 48, H = 32;
  const report: string[] = [];
  for (const backdropAlpha of ["opaque", "translucent"] as const) {
    const back = new Uint8ClampedArray(W * H * 4), src = new Uint8ClampedArray(W * H * 4);
    // Inputs chosen to survive canvas' premultiplied-8-bit storage EXACTLY (c·a/255 integral), so any difference is
    // the compositor, not input quantisation. (With arbitrary inputs Skia differs by up to 3/255 in color-dodge: we
    // reproduced its value exactly by quantising the source as putImageData does — see the TT16 report.)
    const ALPHAS = [51, 85, 102, 153, 170, 204, 255];
    const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
    const px = (alpha: number) => { const k = 255 / gcd(alpha, 255); return [0, 1, 2].map(() => Math.min(255, Math.round(r() * 255 / k) * k)).concat(alpha); };
    for (let i = 0; i < W * H; i++) {
      back.set(px(backdropAlpha === "opaque" ? 255 : ALPHAS[Math.floor(r() * 6) + 1]), i * 4);
      src.set(px(ALPHAS[Math.floor(r() * ALPHAS.length)]), i * 4);
    }
    for (const mode of CANVAS_BLENDS) {
      const skia = await page.evaluate(([W, H, back, src, mode]) => {
        const mk = (d: number[]) => { const c = new OffscreenCanvas(W, H); c.getContext("2d")!.putImageData(new ImageData(Uint8ClampedArray.from(d), W, H), 0, 0); return c; };
        const out = new OffscreenCanvas(W, H); const g = out.getContext("2d")!;
        g.drawImage(mk(back), 0, 0); g.globalCompositeOperation = (mode === "normal" ? "source-over" : mode) as GlobalCompositeOperation; g.drawImage(mk(src), 0, 0);
        return Array.from(g.getImageData(0, 0, W, H).data);
      }, [W, H, Array.from(back), Array.from(src), mode] as const);
      const bl = makeLayer("b", W, H); bl.data.set(back);
      const sl = { ...makeLayer("s", W, H), blend: mode }; sl.data.set(src);
      const ours = compositeRegion({ width: W, height: H, layers: [bl, sl] } as ImageDoc);
      let worst = 0;
      for (let i = 0; i < ours.length; i += 4) {
        worst = Math.max(worst, Math.abs(ours[i + 3] - skia[i + 3]));
        // Output side: Skia stores the RESULT premultiplied in 8 bits, so reading it back straight carries ±(127.5/α)
        // rounding; for an opaque result that is exactly ±1.
        const tol = skia[i + 3] === 255 ? 1 : Math.ceil(127.5 / Math.max(1, skia[i + 3])) + 1;
        for (let k = 0; k < 3; k++) { const d = Math.abs(ours[i + k] - skia[i + k]); if (d > tol) throw new Error(`${mode}/${backdropAlpha} px ${i / 4} ch ${k}: ours ${ours[i + k]} skia ${skia[i + k]} (α ${skia[i + 3]}, tol ${tol})`); worst = Math.max(worst, d); }
      }
      report.push(`${mode}/${backdropAlpha[0]}:${worst}`);
    }
  }
  console.log(`    worst |Δ| vs Skia per mode/backdrop: ${report.join(" ")}`);
  await ctx.close();
});

await test("new doc renders; brush drag paints a continuous line in the foreground colour; undo/redo", { "FF-30": "full" }, async () => {
  const s = await openStudio();
  eq([await s.attr("doc-w"), await s.attr("doc-h"), await s.attr("layers")], ["800", "600", "1"]);
  eq(await s.px(200, 100), [255, 255, 255, 255], "white background");
  await s.tool("Brush");
  await s.drag([100, 100], [300, 100]);
  await waitAttr(s, "undo", "1");
  for (const x of [100, 150, 200, 250, 299]) ok(near(await s.px(x, 100), [229, 72, 77, 255], 1), `line at x=${x}: ${await s.px(x, 100)}`);
  eq(await s.px(200, 140), [255, 255, 255, 255], "outside the stroke");
  await s.root.focus(); await s.page.keyboard.press("Control+z");
  await waitAttr(s, "undo", "0");
  eq(await s.px(200, 100), [255, 255, 255, 255], "undone");
  await s.page.keyboard.press("Control+Shift+z");
  await waitAttr(s, "undo", "1");
  ok(near(await s.px(200, 100), [229, 72, 77, 255], 1), "redone");
  await s.close();
});

await test("layers: new layer, paint, blend=multiply changes composite, opacity, visibility toggle, reorder, merge", { "FF-30": "full" }, async () => {
  const s = await openStudio();
  await s.tool("Bucket"); await s.root.getByLabel("Foreground colour").fill("#808080"); await s.click(10, 10); // grey background
  await waitAttr(s, "undo", "1");
  eq(await s.px(400, 300), [128, 128, 128, 255]);
  await s.root.getByRole("button", { name: "New", exact: true }).nth(1).click();
  await waitAttr(s, "layers", "2"); eq(await s.attr("active"), "Layer 2");
  await s.root.getByLabel("Foreground colour").fill("#ff8000"); await s.click(400, 300); // bucket on empty layer fills it all
  eq(await s.px(400, 300), [255, 128, 0, 255]);
  await s.root.getByLabel("Blend mode").selectOption("multiply");
  ok(near(await s.px(400, 300), [128, 64, 0, 255], 1), `multiply: ${await s.px(400, 300)}`);
  await setRange(s.root.getByLabel("Layer opacity"), 50);
  ok(near(await s.px(400, 300), [128, 96, 64, 255], 1), `multiply @50%: ${await s.px(400, 300)}`);
  await s.root.getByLabel("Visible Layer 2").uncheck();
  eq(await s.px(400, 300), [128, 128, 128, 255], "hidden layer");
  await s.root.getByLabel("Visible Layer 2").check();
  await s.root.getByRole("button", { name: "Down", exact: true }).click();
  eq(await s.root.locator('[data-testid="layer-row"]').first().getAttribute("data-name"), "Background", "Layer 2 moved below Background (rows are top-first)");
  eq(await s.px(400, 300), [128, 128, 128, 255], "covered by opaque background");
  await s.root.getByRole("button", { name: "Up", exact: true }).click();
  s.page.once("dialog", (d) => d.accept());
  await s.root.getByRole("button", { name: "Merge down" }).click();
  await waitAttr(s, "layers", "1");
  ok(near(await s.px(400, 300), [128, 96, 64, 255], 1), "merge preserved the opaque-backdrop multiply result");
  await s.close();
});

await test("TT78 clipping mask in the UI: 'Clip to layer below' limits a layer to the brush stroke beneath it; non-separable modes offered", { "FF-30": "full", "FF-08": "partial" }, async () => {
  const s = await openStudio();
  eq(await s.root.getByTestId("layer-clip").isDisabled(), true, "the bottom layer has nothing to clip to");
  await s.root.getByRole("button", { name: "New", exact: true }).nth(1).click(); await waitAttr(s, "layers", "2");
  await s.tool("Brush"); await s.root.getByLabel("Foreground colour").fill("#ff0000");
  await s.drag([100, 100], [300, 100]); // base: a red stroke on Layer 2
  await s.root.getByRole("button", { name: "New", exact: true }).nth(1).click(); await waitAttr(s, "layers", "3");
  await s.tool("Bucket"); await s.root.getByLabel("Foreground colour").fill("#00c000"); await s.click(600, 400); // Layer 3: all green
  eq(await s.px(600, 400), [0, 192, 0, 255], "unclipped: green everywhere");
  await s.root.getByTestId("layer-clip").check();
  eq(await s.px(600, 400), [255, 255, 255, 255], "clipped: nothing outside the stroke");
  eq(await s.px(200, 100), [0, 192, 0, 255], "clipped: green inside the stroke");
  ok((await s.root.locator('[data-testid="layer-row"][data-name="Layer 3"]').innerText()).includes("clip"), "row shows the clip badge");
  await s.root.getByLabel("Blend mode").selectOption("color");
  // SetLum(green (0,.753,0), Lum(red) = .3) → (−.144,.609,−.144) → ClipColor → (0, .508, 0)
  const c = await s.px(200, 100); ok(near(c, [0, 130, 0, 255], 2), `color mode: green's hue+saturation at red's luminosity: ${c}`);
  for (const m of ["hue", "saturation", "luminosity"]) eq(await s.root.getByLabel("Blend mode").locator(`option[value="${m}"]`).count(), 1, m);
  await s.dlg.screenshot({ path: "docs/screens/tt78-image-clip.png" });
  // (focus is on the blend <select>, where the studio deliberately ignores Ctrl+Z — use the Undo button)
  const undo = s.root.getByRole("button", { name: "Undo", exact: true });
  await undo.click(); await undo.click();
  eq(await s.px(600, 400), [0, 192, 0, 255], "undo (blend, then clip) removes the clip");
  await s.close();
});

await test("bucket tolerance/contiguity on real pixels; eyedropper sets the foreground; wand selection + Delete clears", { "FF-30": "full" }, async () => {
  const s = await openStudio();
  await s.tool("Brush"); await s.root.getByLabel("Foreground colour").fill("#000000");
  await s.drag([400, 0], [400, 599], 40); // vertical wall splits the canvas
  await waitAttr(s, "undo", "1");
  await s.tool("Bucket"); await s.root.getByLabel("Foreground colour").fill("#00ff00");
  await s.click(100, 300);
  eq(await s.px(100, 300), [0, 255, 0, 255]); eq(await s.px(700, 300), [255, 255, 255, 255], "wall stops contiguous fill");
  await s.tool("Eyedropper"); await s.click(700, 300);
  eq(await s.root.getByLabel("Foreground colour").inputValue(), "#ffffff");
  await s.tool("Magic wand"); await s.click(100, 300);
  const selAttr = (await s.attr("selection"))!.split(",").map(Number);
  ok(selAttr[0] === 0 && selAttr[2] > 350 && selAttr[2] < 400, `wand bounds ${selAttr}`);
  await s.root.focus(); await s.page.keyboard.press("Delete");
  eq((await s.px(100, 300))[3], 0, "cleared to transparent");
  eq(await s.px(700, 300), [255, 255, 255, 255]);
  await s.close();
});

await test("marquee → crop to selection changes canvas size; image rotate; Ctrl+Z restores; invert filter through selection", { "FF-30": "full", "FF-24": "full" }, async () => {
  const s = await openStudio();
  await s.tool("Rect select"); await s.drag([100, 100], [300, 250]);
  const sel = (await s.attr("selection"))!.split(",").map(Number);
  ok(Math.abs(sel[2] - 200) <= 2 && Math.abs(sel[3] - 150) <= 2, `selection ${sel}`);
  await s.root.getByLabel("Filter", { exact: true }).selectOption("invert");
  await s.root.getByRole("button", { name: "Apply to selection" }).click();
  await waitAttr(s, "undo", "1");
  eq(await s.px(200, 200), [0, 0, 0, 255], "inverted inside"); eq(await s.px(50, 50), [255, 255, 255, 255], "untouched outside");
  await s.root.getByRole("button", { name: "Crop to selection" }).click();
  await waitAttr(s, "doc-w", String(sel[2]));
  eq(await s.attr("doc-h"), String(sel[3]));
  await s.root.getByRole("button", { name: "Rotate 90° CW" }).click();
  await waitAttr(s, "doc-w", String(sel[3]));
  await s.root.focus(); await s.page.keyboard.press("Control+z"); await s.page.keyboard.press("Control+z");
  await waitAttr(s, "doc-w", "800");
  await s.close();
});

await test("layer mask: paint on mask hides, disable mask reveals; keyboard tool switching, [ ] size, X swap", { "FF-30": "full" }, async () => {
  const s = await openStudio();
  await s.root.getByRole("button", { name: "New", exact: true }).nth(1).click(); await waitAttr(s, "layers", "2");
  await s.tool("Bucket"); await s.root.getByLabel("Foreground colour").fill("#0000ff"); await s.click(10, 10);
  eq(await s.px(400, 300), [0, 0, 255, 255]);
  await s.root.getByRole("button", { name: "Add mask" }).click();
  await s.tool("Brush"); await s.root.getByRole("button", { name: "Mask", exact: true }).click();
  await s.drag([300, 300], [500, 300]);
  eq(await s.px(400, 300), [255, 255, 255, 255], "mask hides the blue layer → white background shows");
  eq(await s.px(400, 100), [0, 0, 255, 255]);
  await s.root.getByRole("button", { name: "Disable mask" }).click();
  eq(await s.px(400, 300), [0, 0, 255, 255], "mask disabled");
  await s.root.focus();
  await s.page.keyboard.press("e"); eq(await s.attr("tool"), "eraser");
  await s.page.keyboard.press("v"); eq(await s.attr("tool"), "move");
  await s.page.keyboard.press("b"); eq(await s.attr("tool"), "brush");
  const fg = await s.root.getByLabel("Foreground colour").inputValue(), bg = await s.root.getByLabel("Background colour").inputValue();
  await s.page.keyboard.press("x");
  eq([await s.root.getByLabel("Foreground colour").inputValue(), await s.root.getByLabel("Background colour").inputValue()], [bg, fg], "X swaps");
  await s.page.keyboard.press("[");
  eq(await s.root.getByLabel("Size").inputValue(), String(Math.max(1, Math.round(24 / 1.25))));
  await s.close();
});

await test("Save PSD → VFS file decodes with our reader (layers/blend/mask) → deep-link reopen restores layers and pixels", { "FF-31": "full", "FF-30": "full" }, async () => {
  const s = await openStudio();
  await s.root.getByLabel("Document name").fill(RUN);
  await s.tool("Bucket"); await s.root.getByLabel("Foreground colour").fill("#336699"); await s.click(5, 5);
  await s.root.getByRole("button", { name: "New", exact: true }).nth(1).click(); await waitAttr(s, "layers", "2");
  await s.tool("Brush"); await s.root.getByLabel("Foreground colour").fill("#ffcc00"); await s.drag([100, 100], [600, 400]);
  await s.root.getByLabel("Blend mode").selectOption("screen");
  await s.root.getByRole("button", { name: "Add mask" }).click();
  const before = [await s.px(350, 250), await s.px(10, 590)];
  await s.root.getByRole("button", { name: "Save PSD" }).click();
  const path = `/Pictures/${RUN}.psd`;
  await waitMsg(s, /saved/);
  const node = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`);
  ok(node.json.node?.encoding === "base64", `saved file missing: ${JSON.stringify(node.json).slice(0, 120)}`);
  const { doc } = await readPsd(new Uint8Array(Buffer.from(node.json.node.content, "base64")));
  eq(doc.layers.map((l) => [l.name, l.blend, !!l.mask]), [["Background", "normal", false], ["Layer 2", "screen", true]]);
  await s.close();
  const t = await openStudio(path);
  await waitMsg(t, /opened/);
  eq(await t.attr("layers"), "2");
  eq(await t.attr("active"), "Layer 2");
  for (const [i, [x, y]] of [[350, 250], [10, 590]].entries()) ok(near(await t.px(x, y), before[i], 1), `pixel ${x},${y}: ${await t.px(x, y)} vs ${before[i]}`);
  await t.close();
});

await test("Export PNG → reopen the PNG from the VFS as a new document; Image size dialog resizes", { "FF-30": "full", "FF-24": "full" }, async () => {
  const s = await openStudio();
  await s.root.getByLabel("Document name").fill(`${RUN}-png`);
  await s.tool("Brush"); await s.drag([0, 0], [799, 599], 40);
  await s.root.getByRole("button", { name: "Export PNG" }).click();
  await waitMsg(s, /exported/);
  const mid = await s.px(400, 300);
  await s.close();
  const t = await openStudio(`/Pictures/${RUN}-png.png`);
  await waitMsg(t, /opened/);
  eq(await t.attr("doc-w"), "800");
  ok(near(await t.px(400, 300), mid, 0), `PNG round trip ${await t.px(400, 300)} vs ${mid}`);
  // TT28: Image size uses the in-app ask dialog (SH-15), not window.prompt
  await t.root.getByRole("button", { name: "Image size…" }).click();
  await t.page.getByTestId("ask-dialog").waitFor({ timeout: 5000 });
  await t.page.getByTestId("ask-input-value").fill("400x300");
  await t.page.getByTestId("ask-ok").click();
  await waitAttr(t, "doc-w", "400");
  eq(await t.attr("doc-h"), "300");
  await t.close();
});

await test("classic Quick edit mode is still available (additive merge)", { "FF-24": "partial", "MD-03": "partial" }, async () => {
  const s = await openStudio();
  await s.dlg.getByRole("tab", { name: "Quick edit (classic)" }).click();
  await s.dlg.getByText("Open image…").waitFor({ timeout: 5000 });
  await s.dlg.getByRole("tab", { name: "Layers" }).click();
  await s.root.waitFor();
  await s.close();
});

await test("no uncaught page errors during the image session", { "FF-30": "partial" }, () => { eq(errors, []); });

await browser.close();
finish();
