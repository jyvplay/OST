/** Real thumbnail workers, Chromium canvas, Fusion HTTP and PostgreSQL; display is headless. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing browser state tests without TT89_DISPOSABLE_DATABASE=1 for a disposable server/database.");
const { test, finish } = makeHarness("e2e-tt90-thumbnails");
const cov = { "FF-13": "partial" } as const; // canonical HW-02 is Android ADPF, not a browser worker pool
const BASE = process.env.BASE ?? "http://localhost:3000";
const RUN = `tt90-thumbs-${Date.now().toString(36)}`;
const DIR = `/Pictures/${RUN}`;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`); return json;
};
const oldDesktop = await api("GET", "/api/state?id=default");
const rev = Number(oldDesktop.row?.revision ?? 1) + 1000;
await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
// Test-only Pillow makes valid PNGs with unique hashes, so an older cache cannot satisfy the assertions.
const fixtures: Record<string, { png: string; rgb: number[] }> = JSON.parse(execFileSync(process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python", ["-c", `
from PIL import Image
import io, base64, hashlib, json, sys
run=sys.argv[1]
colors={'red':(230,30,40),'green':(20,190,70),'blue':(35,70,225),'purple':(165,50,190),'late':(220,140,30),'fallback':(40,185,190)}
out={}
for name, color in colors.items():
 im=Image.new('RGB',(80,60),color)
 digest=hashlib.sha256((run+name).encode()).digest()
 for i in range(0,30,3): im.putpixel((i//3,0),tuple(digest[i:i+3]))
 b=io.BytesIO(); im.save(b,format='PNG'); out[name]={'png':base64.b64encode(b.getvalue()).decode(),'rgb':color}
print(json.dumps(out))`, RUN], { encoding: "utf8" }));
const hashes: string[] = [];
const upload = async (name: string) => {
  const path = `${DIR}/${name}.png`;
  await api("POST", "/api/fs", { op: "upload", path, content: fixtures[name].png, mime: "image/png" });
  const node = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).node;
  hashes.push(String(node.sha256).slice(0, 32));
  assert.equal(node.content, fixtures[name].png); return path;
};
const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); context.setDefaultTimeout(20_000);
// Wrap the *real* Worker only to observe constructor/termination; force reported cores/memory for a deterministic cap.
await context.addInitScript(() => {
  const Native = window.Worker; const w = window as any; w.__thumbnailWorkers = [];
  Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, get: () => 8 });
  Object.defineProperty(navigator, "deviceMemory", { configurable: true, get: () => 8 });
  window.Worker = class extends Native {
    private record: { terminated: boolean } | null = null;
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options);
      if (options?.name === "fusion-thumbs") { this.record = { terminated: false }; w.__thumbnailWorkers.push(this.record); }
    }
    terminate() { if (this.record) this.record.terminated = true; super.terminate(); }
  };
});
const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
const thumb = (name: string) => page.getByRole("option", { name: new RegExp(`${name}\\.png`) }).locator('[data-thumb]');
const checkColor = async (name: string) => {
  const t = thumb(name); await t.locator("img").waitFor({ timeout: 40_000 });
  const px = await t.locator("img").evaluate(async (img: HTMLImageElement) => {
    await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight;
    const g = c.getContext("2d")!; g.drawImage(img, 0, 0); return Array.from(g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data).slice(0, 3);
  });
  assert.ok(px.every((v, i) => Math.abs(v - fixtures[name].rgb[i]) < 20), `${name}: ${px} vs ${fixtures[name].rgb}`);
};
try {
  await test("Files grid renders independent PNG pixels in bounded real Chromium workers", cov, async () => {
    for (const name of ["red", "green", "blue", "purple"]) await upload(name);
    await page.goto(`${BASE}/?open=files&path=${encodeURIComponent(DIR)}`, { waitUntil: "domcontentloaded" });
    await page.locator('[data-shell-ready="true"]').waitFor({ timeout: 40_000 });
    const files = page.getByRole("dialog", { name: "Files", exact: true }).last(); await files.waitFor();
    await files.getByRole("button", { name: "Grid", exact: true }).click();
    for (const name of ["red", "green", "blue", "purple"]) await checkColor(name);
    const records = await page.evaluate(() => (window as any).__thumbnailWorkers);
    assert.ok(records.length >= 1 && records.length <= 2, `worker count ${records.length}`);
    for (const name of ["red", "green", "blue", "purple"]) {
      const node = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(`${DIR}/${name}.png`)}`)).node;
      assert.equal(node.content, fixtures[name].png, `${name} original was modified`);
    }
  });
  await test("SVG, text and real recorded WebM keep their main-thread or worker preview paths", cov, async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 60"><rect width="80" height="60" fill="#d33a24"/></svg>`;
    const text = `Preview text ${RUN}\nA second real line.`;
    const media = await page.evaluate(async () => {
      if (!MediaRecorder.isTypeSupported("video/webm;codecs=vp8")) throw new Error("VP8 MediaRecorder unavailable");
      const c = document.createElement("canvas"); c.width = 96; c.height = 64; const g = c.getContext("2d")!;
      const stream = c.captureStream(10); const rec = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" }); const parts: Blob[] = [];
      const ended = new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("recording timed out")), 8000); rec.onstop = () => { clearTimeout(timer); resolve(); }; rec.onerror = () => { clearTimeout(timer); reject(new Error("recording failed")); }; }); rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); }; rec.start();
      for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? "rgb(25,150,75)" : "rgb(20,130,65)"; g.fillRect(0, 0, c.width, c.height); await new Promise((r) => setTimeout(r, 150)); }
      rec.stop(); await ended; stream.getTracks().forEach((t) => t.stop());
      const bytes = new Uint8Array(await new Blob(parts, { type: "video/webm" }).arrayBuffer()); return btoa(Array.from(bytes, (v) => String.fromCharCode(v)).join(""));
    });
    assert.ok(media.length > 100);
    for (const [name, content, encoding, mime] of [["vector.svg", svg, "utf8", "image/svg+xml"], ["notes.txt", text, "utf8", "text/plain"], ["clip.webm", media, "base64", "video/webm"]]) {
      const path = `${DIR}/${name}`;
      await api("POST", "/api/fs", { op: "write", path, content, encoding, mime });
      const node = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).node; hashes.push(String(node.sha256).slice(0, 32));
    }
    await page.evaluate(() => { const c = new BroadcastChannel("fusion.refresh"); c.postMessage(1); c.close(); });
    for (const name of ["vector.svg", "notes.txt", "clip.webm"]) await page.getByRole("option", { name: new RegExp(name.replace(".", "\\.")) }).locator('[data-thumb="ready"] img').waitFor({ timeout: 40_000 });
    const rgb = await page.getByRole("option", { name: /vector\.svg/ }).locator("[data-thumb] img").evaluate(async (img: HTMLImageElement) => { await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d")!; g.drawImage(img, 0, 0); return Array.from(g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data).slice(0, 3); });
    assert.ok(rgb[0] > 170 && rgb[1] < 100 && rgb[2] < 100, `SVG preview pixel ${rgb}`);
  });
  await test("real workers terminate after 30 seconds idle and a new image starts a new worker", cov, async () => {
    await page.waitForFunction(() => {
      const a = (window as any).__thumbnailWorkers; return a.length > 0 && a.every((r: any) => r.terminated);
    }, null, { timeout: 38_000 });
    const oldCount = await page.evaluate(() => (window as any).__thumbnailWorkers.length);
    await upload("late");
    await page.evaluate(() => { const c = new BroadcastChannel("fusion.refresh"); c.postMessage(1); c.close(); });
    await checkColor("late");
    const records = await page.evaluate(() => (window as any).__thumbnailWorkers);
    assert.ok(records.length > oldCount && records.some((r: any) => !r.terminated), JSON.stringify(records));
  });
  await test("if the real browser refuses worker construction, main-thread fallback still renders pixels", cov, async () => {
    await upload("fallback");
    const fallback = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await fallback.addInitScript(() => {
        const Native = window.Worker; const w = window as any; w.__blockedThumbAttempts = 0;
        window.Worker = class extends Native {
          constructor(url: string | URL, options?: WorkerOptions) {
            if (options?.name === "fusion-thumbs") { w.__blockedThumbAttempts++; throw new DOMException("blocked", "SecurityError"); }
            super(url, options);
          }
        };
      });
      const p = await fallback.newPage();
      await p.goto(`${BASE}/?open=files&path=${encodeURIComponent(DIR)}`, { waitUntil: "domcontentloaded" });
      await p.locator('[data-shell-ready="true"]').waitFor({ timeout: 40_000 });
      const files = p.getByRole("dialog", { name: "Files", exact: true }).last(); await files.waitFor();
      await files.getByRole("button", { name: "Grid", exact: true }).click();
      const t = files.getByRole("option", { name: /fallback\.png/ }).locator('[data-thumb="ready"] img'); await t.waitFor({ timeout: 40_000 });
      const rgb = await t.evaluate(async (img: HTMLImageElement) => { await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d")!; g.drawImage(img, 0, 0); return Array.from(g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data).slice(0, 3); });
      assert.ok(rgb.every((v, i) => Math.abs(v - fixtures.fallback.rgb[i]) < 20));
      assert.equal(await p.evaluate(() => (window as any).__blockedThumbAttempts), 1);
    } finally { await fallback.close(); }
  });
  await test("no uncaught page errors during thumbnail work", cov, () => assert.deepEqual(errors, []));
} finally {
  await context.close(); await browser.close();
  await api("POST", "/api/fs", { op: "purge", path: DIR }).catch(() => undefined);
  const entries = (await api("GET", "/api/fs?op=list&path=/System/Cache/thumbs").catch(() => ({ nodes: [] }))).nodes ?? [];
  for (const node of entries) if (hashes.some((h) => node.name.startsWith(`${h}-`))) await api("POST", "/api/fs", { op: "purge", path: node.path }).catch(() => undefined);
  const current = await api("GET", "/api/state?id=default");
  if (oldDesktop.row?.state) await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 0) + 1000, state: oldDesktop.row.state }).catch(() => undefined);
}
finish();
