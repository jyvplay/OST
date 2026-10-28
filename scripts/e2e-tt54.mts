/**
 * TT54 e2e — FF-13 thumbnail + metadata service, MD-03 Photos, FF-07 export, through the real UI (Chromium 143).
 * Independent checks: Pillow (libavif / libjpeg / libwebp) + numpy via python (test-only), our Node recipe renderer
 * for the bit-exact browser-vs-Node comparison. Fixtures: scripts/oracle/photos_fixtures.py, meta_fixtures.py,
 * media_fixtures.py (TT53). Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings
 *   --import ./scripts/register-hook.mjs scripts/e2e-tt54.mts
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { renderRecipe, sidecarPath, type PhotoRecipe } from "../src/lib/photos/recipe.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing photo/cache browser tests without TT89_DISPOSABLE_DATABASE=1 and an explicit exclusive matching disposable server/database.");
const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `p${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt54");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const PY = "/home/user/tools/venv/bin/python"; const SHOTS = process.env.SHOTS ?? "/tmp";
const PF = "/tmp/tt54-photos", MF = "/tmp/tt54-meta", VF = "/tmp/tt53-media"; const OUT = join(PF, "e2e"); mkdirSync(OUT, { recursive: true });
// A generator may have failed after producing its first file. Only treat the
// fixture set as ready when all files consumed by this suite exist.
if (!["o6.jpg", "photo.png", "photo.rgba", "cam.jpg"].every((name) => existsSync(join(PF, name)))) execFileSync(PY, ["scripts/oracle/photos_fixtures.py", PF], { stdio: "inherit" });
if (!["v23.mp3", "song.m4a", "anim.gif", "vector.svg", "expected.json"].every((name) => existsSync(join(MF, name)))) execFileSync(PY, ["scripts/oracle/meta_fixtures.py", MF], { stdio: "inherit" });
if (!existsSync(join(VF, "vp9-opus.webm"))) execFileSync(PY, ["scripts/oracle/media_fixtures.py", VF], { stdio: "inherit" });
const PDF = "/home/user/tools/corpus/pdf/Embedded_font.pdf";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) as Record<string, any> }; };
const created: string[] = [];
async function upload(path: string, bytes: Uint8Array, mime: string) { created.push(path); const r = await api("POST", "/api/fs", { op: "upload", path, content: Buffer.from(bytes).toString("base64"), mime }); ok(r.status < 300, `upload ${path}: ${r.status} ${JSON.stringify(r.json)}`); }
async function writeText(path: string, content: string) { created.push(path); const r = await api("POST", "/api/fs", { op: "write", path, content, reason: "e2e" }); ok(r.status < 300, `write ${path}: ${r.status}`); }
async function exists(path: string) { const r = await api("GET", `/api/fs?op=stat&path=${encodeURIComponent(path)}`); return r.status === 200 && !!r.json.node && !r.json.node.trashed; }
async function readBytes(path: string): Promise<Uint8Array> { const r = await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`); ok(r.json.node, `read ${path}`); return r.json.node.encoding === "base64" ? Uint8Array.from(Buffer.from(r.json.node.content, "base64")) : new TextEncoder().encode(r.json.node.content); }
async function list(path: string): Promise<{ path: string; name: string; size: number; kind: string }[]> { const r = await api("GET", `/api/fs?op=list&path=${encodeURIComponent(path)}`); return r.json.nodes ?? []; }
async function resetDesktop() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
const py = (code: string, ...args: string[]) => JSON.parse(execFileSync(PY, ["-c", code, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
const PIL_INFO = `
import sys, json, io
from PIL import Image
im = Image.open(sys.argv[1]); im.load(); ex = im.getexif(); sub = ex.get_ifd(0x8769); gps = ex.get_ifd(0x8825)
print(json.dumps({"format": im.format, "size": im.size, "mode": im.mode, "make": ex.get(0x010F), "model": ex.get(0x0110), "orientation": ex.get(0x0112), "software": ex.get(0x0131), "dto": sub.get(0x9003), "px": [sub.get(0xA002), sub.get(0xA003)], "gps": bool(gps), "exif_tags": len(ex)}))`;

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function openPage(url: string): Promise<Page> {
  await resetDesktop(); // a window persisted by the previous test would otherwise swallow the deep link
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + url, { waitUntil: "domcontentloaded" }); return page;
}
const setRange = (page: Page, label: string, v: number) => page.getByLabel(label, { exact: true }).evaluate((el, val) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(el, String(val)); el.dispatchEvent(new Event("input", { bubbles: true }));
}, v);

const DIR = `/Pictures/${RUN}`;
const FILES: [string, string, string][] = [
  ["o6.jpg", join(PF, "o6.jpg"), "image/jpeg"], ["photo.png", join(PF, "photo.png"), "image/png"], ["cam.jpg", join(PF, "cam.jpg"), "image/jpeg"],
  ["anim.gif", join(MF, "anim.gif"), "image/gif"], ["vector.svg", join(MF, "vector.svg"), "image/svg+xml"], ["song.mp3", join(MF, "v23.mp3"), "audio/mpeg"],
  ["song.m4a", join(MF, "song.m4a"), "audio/mp4"], ["scan.tiff", "/home/user/tools/corpus/exif/tiff__Picoawards.tiff", "image/tiff"], ["doc.pdf", PDF, "application/pdf"], ["clip.webm", join(VF, "vp9-opus.webm"), "video/webm"],
];

await test("FF-13 Files grid: real thumbnails for JPEG (EXIF orientation applied), TIFF (own decoder), PNG, GIF, SVG, MP3/M4A cover art, PDF page 1, WebM frame, text; no-preview types keep the icon with a reason", { "FF-13": "full" }, async () => {
  for (const [n, f, m] of FILES) await upload(`${DIR}/${n}`, readFileSync(f), m);
  // a thumbnail left by an older renderer (no -rN suffix): the first cache write of the session must sweep it away
  await upload("/System/Cache/thumbs/0123456789abcdef0123456789abcdef-99-256-orig.webp", new Uint8Array(64), "image/webp");
  await writeText(`${DIR}/notes.txt`, "# Shopping\n- lemons\n- mint\n- soda water\n");
  await upload(`${DIR}/blob.bin`, new Uint8Array(4096).map((_, i) => (i * 37) & 255), "application/octet-stream");
  await resetDesktop();
  const page = await openPage(`/?open=files&path=${encodeURIComponent(DIR)}`);
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  const thumbOf = (name: string) => page.locator('[role="option"]', { hasText: name }).locator("[data-thumb]");
  const want = ["scan.tiff", "o6.jpg", "photo.png", "cam.jpg", "anim.gif", "vector.svg", "song.mp3", "song.m4a", "doc.pdf", "clip.webm", "notes.txt"];
  for (const n of want) await thumbOf(n).and(page.locator('[data-thumb="ready"]')).waitFor({ timeout: 30_000 }).catch(async () => { throw new Error(`${n}: thumb ${await thumbOf(n).getAttribute("data-thumb")} ${await thumbOf(n).getAttribute("title")}`); });
  await thumbOf("blob.bin").and(page.locator('[data-thumb="none"]')).waitFor({ timeout: 20_000 });
  ok(/no preview/i.test(await thumbOf("blob.bin").getAttribute("title") ?? ""), "reason for the icon fallback");
  // orientation: stored 120×80 left RED / right BLUE + EXIF 6 → displayed portrait, top RED, bottom BLUE
  const px = await thumbOf("o6.jpg").locator("img").evaluate(async (img: HTMLImageElement) => {
    await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
    // Avoid a nested named arrow here: tsx's __name helper is not serialized
    // into Playwright's browser-side evaluate callback.
    const top = Array.from(g.getImageData(Math.floor(0.5 * c.width), Math.floor(0.15 * c.height), 1, 1).data);
    const bottom = Array.from(g.getImageData(Math.floor(0.5 * c.width), Math.floor(0.85 * c.height), 1, 1).data);
    return { w: c.width, h: c.height, top, bottom };
  });
  ok(px.h > px.w && px.top[0] > 150 && px.top[2] < 90 && px.bottom[2] > 150 && px.bottom[0] < 90, `orientation not applied: ${JSON.stringify(px)}`);
  // transparent SVG drawn on white paper (regression: a black-on-transparent drawing was invisible on the dark grid) —
  // and NOT served from a thumbnail cached by an older renderer (the renderer version is part of the key)
  const svg = await thumbOf("vector.svg").locator("img").evaluate(async (img: HTMLImageElement) => {
    await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d")!; g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data; let white = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 250 && d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) white++;
    return white / (d.length / 4);
  });
  ok(svg > 0.5, `SVG thumbnail has no white paper (opaque-white share ${svg.toFixed(2)})`);
  await page.screenshot({ path: join(SHOTS, "e2e54-files-grid.png") });
  await page.context().close();
});

await test("FF-13 thumbnail cache: WebP nodes under /System/Cache/thumbs (content-addressed, written once); a fresh session is served from the cache without re-rendering", { "FF-13": "full" }, async () => {
  let prev = -1, now = 0;
  for (let i = 0; i < 40; i++) { now = (await list("/System/Cache/thumbs")).length; if (now === prev && now > 0) break; prev = now; await new Promise((r) => setTimeout(r, 500)); }
  let entries = await list("/System/Cache/thumbs");
  for (let i = 0; i < 40 && entries.some((e) => !/-r\d+\.webp$/.test(e.name)); i++) { await new Promise((r) => setTimeout(r, 250)); entries = await list("/System/Cache/thumbs"); }
  ok(!entries.some((e) => e.name.startsWith("0123456789abcdef")), "entry of an older renderer was not swept");
  ok(entries.length >= 10, `cache entries ${entries.length}`);
  const one = entries.find((e) => e.name.endsWith(".webp"))!; const b = await readBytes(one.path);
  ok(Buffer.from(b.subarray(0, 4)).toString() === "RIFF" && Buffer.from(b.subarray(8, 12)).toString() === "WEBP", "cached thumbnail is a WebP");
  ok(entries.every((e) => /^[0-9a-zp]+-\d+-\d+-[0-9a-z]+-r\d+\.webp$/.test(e.name)), `cache key format: ${entries.map((e) => e.name).slice(0, 3)}`);
  const before = new Set(entries.map((e) => e.path));
  const page = await openPage(`/?open=files&path=${encodeURIComponent(DIR)}`);
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page.locator('[role="option"]', { hasText: "doc.pdf" }).locator('[data-thumb="ready"]').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(1500);
  const after = await list("/System/Cache/thumbs"); const fresh = after.filter((e) => !before.has(e.path));
  ok(fresh.length === 0, `re-rendered instead of cache hit: ${fresh.map((e) => e.name)}`);
  await page.context().close();
});

await test("MD-03 sidecars follow their photo on rename / copy / move / trash / restore / purge and batch rename (server-side, any client); op=media lists photos + sidecars and nothing under /System", { "MD-03": "full" }, async () => {
  const a = `${DIR}/side-a.jpg`; await upload(a, readFileSync(join(PF, "o6.jpg")), "image/jpeg");
  await writeText(sidecarPath(a), JSON.stringify({ v: 1, exposure: 0.5, rating: 3 }));
  const media = await api("GET", "/api/fs?op=media"); const paths: string[] = media.json.items.map((i: { path: string }) => i.path);
  ok(paths.includes(a) && paths.includes(sidecarPath(a)) && !paths.some((p) => p.startsWith("/System/")), "op=media contents");
  const r1 = await api("POST", "/api/fs", { op: "rename", path: a, name: "side-b.jpg" }); const b = `${DIR}/side-b.jpg`;
  ok(r1.json.sidecar === "followed" && await exists(sidecarPath(b)) && !await exists(sidecarPath(a)), `rename: ${JSON.stringify(r1.json)}`);
  const c = `${DIR}/sub/side-c.jpg`; const r2 = await api("POST", "/api/fs", { op: "copy", src: b, dst: c }); created.push(c, sidecarPath(c));
  ok(r2.json.sidecar === "followed" && await exists(sidecarPath(c)) && await exists(sidecarPath(b)), "copy");
  const d = `${DIR}/side-d.jpg`; const r3 = await api("POST", "/api/fs", { op: "move", src: c, dst: d }); created.push(d, sidecarPath(d));
  ok(r3.json.sidecar === "followed" && await exists(sidecarPath(d)) && !await exists(sidecarPath(c)), "move");
  await api("POST", "/api/fs", { op: "trash", path: d }); ok(!await exists(sidecarPath(d)), "trash takes the sidecar");
  await api("POST", "/api/fs", { op: "restore", path: d }); ok(await exists(d) && await exists(sidecarPath(d)), "restore brings it back");
  await api("POST", "/api/fs", { op: "purge", path: d }); const st = await api("GET", `/api/fs?op=stat&path=${encodeURIComponent(sidecarPath(d))}`); ok(st.status === 404 || !st.json.node, "purge removes the sidecar");
  const sideJson = JSON.parse(new TextDecoder().decode(await readBytes(sidecarPath(b)))); ok(sideJson.exposure === 0.5 && sideJson.rating === 3, "content preserved");
  // batch rename in a folder with sidecars: photos renamed, sidecars follow, sidecars are not renamed as files
  const bd = `${DIR}/batch`; await upload(`${bd}/x.jpg`, readFileSync(join(PF, "o6.jpg")), "image/jpeg"); await writeText(sidecarPath(`${bd}/x.jpg`), JSON.stringify({ v: 1, flipH: true }));
  const br = await api("POST", "/api/fs", { op: "batchRename", path: bd, pattern: "trip-{n}.{ext}", start: 1 });
  ok(br.json.results.length === 1 && await exists(`${bd}/trip-01.jpg`) && await exists(sidecarPath(`${bd}/trip-01.jpg`)), `batch: ${JSON.stringify(br.json)}`);
  created.push(bd);
});

await test("Hidden files: sidecars never show in Files (until 'Hidden' is toggled) or on the desktop", { "MD-03": "full" }, async () => {
  const doc = `/Documents/${RUN}-desk.jpg`; await upload(doc, readFileSync(join(PF, "o6.jpg")), "image/jpeg"); await writeText(sidecarPath(doc), JSON.stringify({ v: 1, rotate: 1 }));
  await resetDesktop();
  const page = await openPage("/");
  await page.getByText(`${RUN}-desk.jpg`, { exact: true }).first().waitFor({ timeout: 20_000 });
  ok(await page.getByText(`.${RUN}-desk.jpg.edit.json`).count() === 0, "sidecar shown on the desktop");
  await page.context().close();
  const fp = await openPage(`/?open=files&path=${encodeURIComponent(DIR)}`);
  await fp.locator('[role="option"]', { hasText: "side-b.jpg" }).first().waitFor({ timeout: 20_000 });
  ok(await fp.locator('[role="option"]', { hasText: ".side-b.jpg.edit.json" }).count() === 0, "sidecar visible by default");
  await fp.getByRole("button", { name: "Hidden", exact: true }).click();
  await fp.locator('[role="option"]', { hasText: ".side-b.jpg.edit.json" }).waitFor({ timeout: 10_000 });
  await fp.context().close();
  await api("POST", "/api/fs", { op: "purge", path: doc });
  ok(!await exists(sidecarPath(doc)), "purge took the desktop sidecar");
});

await test("FF-13 Info panel: metadata of the selected file (camera, capture date, exposure, GPS) from the first-party readers", { "FF-13": "full" }, async () => {
  const page = await openPage(`/?open=files&path=${encodeURIComponent(DIR)}`);
  await page.locator('[role="option"]', { hasText: "cam.jpg" }).click();
  await page.getByRole("button", { name: "Info", exact: true }).click();
  const panel = page.locator('[data-testid="files-info"]'); await panel.getByText(/NIKON/i).first().waitFor({ timeout: 20_000 });
  const t = await panel.innerText();
  ok(/2008/.test(t) && /f\/|ƒ|F\d/.test(t) && /4[3]\.\d+|43°|Latitude|GPS|Location/i.test(t), `info panel: ${t.slice(0, 600)}`);
  await page.screenshot({ path: join(SHOTS, "e2e54-files-info.png") }); await page.context().close();
});

await test("MD-03 Photos library + editor: timeline by capture date, edit (rotate + exposure + preset) saved as a sidecar recipe, original bytes untouched, rating saved, library thumbnail shows the edit", { "MD-03": "full" }, async () => {
  const origBytes = await readBytes(`${DIR}/photo.png`);
  const page = await openPage(`/?open=photos`);
  await page.locator('[data-testid="photos-library"]').waitFor({ timeout: 30_000 });
  await page.locator('[data-photo="cam.jpg"]').first().waitFor({ timeout: 30_000 });
  // capture-date grouping: the camera sample (2008) sits under a 2008 heading once indexed
  await page.getByRole("heading", { name: /2008/ }).first().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(SHOTS, "e2e54-photos-library.png") });
  await page.locator('[data-photo="photo.png"]').first().click();
  await page.locator('[data-testid="photos-editor"]').waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Rotate right", exact: true }).click();
  await setRange(page, "Exposure", 0.5);
  await page.getByRole("button", { name: "Vivid", exact: true }).click();
  await page.getByRole("button", { name: "Save edit", exact: true }).click();
  await page.getByText(/Edit saved/).first().waitFor({ timeout: 10_000 });
  await page.getByRole("radio", { name: "4 stars" }).click(); await page.waitForTimeout(800);
  const side = JSON.parse(new TextDecoder().decode(await readBytes(sidecarPath(`${DIR}/photo.png`)))) as PhotoRecipe;
  created.push(sidecarPath(`${DIR}/photo.png`));
  ok(side.v === 1 && side.rotate === 1 && side.exposure === 0.5 && side.preset === "vivid" && side.rating === 4, `sidecar: ${JSON.stringify(side)}`);
  ok(Buffer.from(await readBytes(`${DIR}/photo.png`)).equals(Buffer.from(origBytes)), "original bytes changed");
  const cw = await page.locator('[data-testid="photos-canvas"]').evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
  ok(cw[1] > cw[0], `preview not rotated: ${cw}`);
  await page.screenshot({ path: join(SHOTS, "e2e54-photos-editor.png") });
  await page.getByRole("button", { name: "Back to library" }).click();
  const tile = page.locator('[data-photo="photo.png"]').first();
  await tile.locator('[data-thumb="ready"]').waitFor({ timeout: 20_000 });
  ok(await tile.getByText("edited").count() === 1 && await tile.getByLabel("4 stars").count() === 1, "edited badge / stars");
  const dims = await tile.locator("img").evaluate(async (img: HTMLImageElement) => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; });
  ok(dims[1] > dims[0], `library thumbnail does not show the rotation: ${dims}`);
  const keys = (await list("/System/Cache/thumbs")).map((e) => e.name); ok(keys.some((k) => !/-orig-r\d+\.webp$/.test(k)), "no recipe-keyed cache entry");
  await page.getByRole("button", { name: /Edited/ }).click(); await page.locator('[data-photo="photo.png"]').first().waitFor({ timeout: 5000 });
  ok(await page.locator('[data-photo="cam.jpg"]').count() === 0, "Edited view filters");
  await page.context().close();
});

await test("FF-07 export PNG from Photos is BIT-EXACT to the Node recipe renderer on the same pixels (browser decode → recipe → encode)", { "FF-07": "full", "MD-03": "full" }, async () => {
  const R: PhotoRecipe = { v: 1, rotate: 3, flipH: true, crop: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 }, exposure: 0.3, contrast: 0.4, shadows: 0.2, highlights: -0.3, saturation: 0.25, vibrance: 0.2, warmth: 0.3, tint: -0.1, vignette: 0.5 };
  const p = `${DIR}/exact.png`; await upload(p, readFileSync(join(PF, "photo.png")), "image/png"); await writeText(sidecarPath(p), JSON.stringify(R));
  const page = await openPage(`/?open=photos&path=${encodeURIComponent(p)}`);
  await page.locator('[data-testid="photos-editor"]').waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Export…" }).click();
  const dlg = page.locator('[data-testid="photos-export"]'); await dlg.locator("select").first().selectOption("png");
  await dlg.getByLabel("Include camera metadata").uncheck();
  await dlg.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByText(/Exported exact-edited\.png/).first().waitFor({ timeout: 30_000 });
  const outPath = `${DIR}/exact-edited.png`; created.push(outPath);
  writeFileSync(join(OUT, "exact.png"), await readBytes(outPath));
  const src = { width: 200, height: 150, data: new Uint8ClampedArray(readFileSync(join(PF, "photo.rgba"))) };
  const want = renderRecipe(src, R); writeFileSync(join(OUT, "exact.want.rgba"), want.data);
  const res = py(`
import sys, json, numpy as np
from PIL import Image
im = np.asarray(Image.open(sys.argv[1]).convert("RGBA")); w, h = int(sys.argv[3]), int(sys.argv[4])
want = np.frombuffer(open(sys.argv[2], "rb").read(), np.uint8).reshape(h, w, 4)
d = np.abs(im.astype(int) - want.astype(int)) if im.shape == want.shape else None
print(json.dumps({"shape": list(im.shape), "want": [h, w, 4], "max": None if d is None else int(d.max()), "diffpx": None if d is None else int((d.max(axis=2) > 0).sum())}))`, join(OUT, "exact.png"), join(OUT, "exact.want.rgba"), String(want.width), String(want.height));
  ok(res.max === 0, `browser export differs from the Node renderer: ${JSON.stringify(res)}`);
  await page.context().close();
});

await test("FF-07 export AVIF (WebCodecs AV1 + our AVIF writer) and JPEG / WebP with curated metadata: decoded by Pillow (libavif / libjpeg / libwebp); location only when asked; Orientation reset to 1", { "FF-07": "full" }, async () => {
  const p = `${DIR}/cam.jpg`;
  const exp = async (fmt: string, location: boolean, meta = true) => {
    const page = await openPage(`/?open=photos&path=${encodeURIComponent(p)}`);
    await page.locator('[data-testid="photos-editor"]').waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Export…" }).click();
    const dlg = page.locator('[data-testid="photos-export"]');
    const opt = dlg.locator(`option[value="${fmt}"]`); ok(!(await opt.isDisabled()), `${fmt} reported unavailable: ${await opt.innerText()}`);
    await dlg.locator("select").first().selectOption(fmt); // cam.jpg is 640×480: the size cap never upscales, so full resolution
    if (!meta) await dlg.getByLabel("Include camera metadata").uncheck(); else if (location) await dlg.getByLabel(/Include location/).check();
    await dlg.getByRole("button", { name: "Export", exact: true }).click();
    const toast = page.getByText(/Exported cam-edited/).first(); await toast.waitFor({ timeout: 60_000 });
    const name = /Exported (cam-edited[^ ]*)/.exec(await toast.innerText())![1]; const out = `${DIR}/${name}`; created.push(out);
    const local = join(OUT, name); writeFileSync(local, await readBytes(out)); await page.context().close();
    return { ...py(PIL_INFO, local), name };
  };
  const avif = await exp("avif", false);
  ok(avif.format === "AVIF" && avif.size[0] === 640 && avif.size[1] === 480 && /NIKON/i.test(avif.make ?? "") && avif.orientation === 1 && !avif.gps && avif.dto, `avif: ${JSON.stringify(avif)}`);
  const jpg = await exp("jpeg", true);
  ok(jpg.format === "JPEG" && jpg.size[0] === 640 && jpg.gps && jpg.orientation === 1 && jpg.software === "Fusion Photos" && jpg.px[0] === 640 && jpg.px[1] === 480, `jpeg: ${JSON.stringify(jpg)}`);
  const webp = await exp("webp", false, false);
  const again = await exp("webp", false, false);
  ok(webp.name === "cam-edited.webp" && again.name === "cam-edited-2.webp", `unique export names: ${webp.name} ${again.name}`);
  ok(webp.format === "WEBP" && webp.exif_tags === 0, `webp: ${JSON.stringify(webp)}`);
  const caps = await (await openPage("/")).evaluate(async () => {
    const VE = (globalThis as unknown as { VideoEncoder?: { isConfigSupported(c: unknown): Promise<{ supported?: boolean }> } }).VideoEncoder;
    return { hevc: !!VE && !!(await VE.isConfigSupported({ codec: "hvc1.1.6.L120.B0", width: 64, height: 64 }).catch(() => ({ supported: false }))).supported };
  });
  ok(caps.hevc === false, "this Chromium unexpectedly encodes HEVC — the HEIC option should then be tested");
});

if (errors.length) console.log("page errors:", errors.slice(0, 10));
finish();
await browser.close();
for (const p of created.reverse()) await api("POST", "/api/fs", { op: "purge", path: p }).catch(() => {});
await api("POST", "/api/fs", { op: "purge", path: DIR }).catch(() => {});
