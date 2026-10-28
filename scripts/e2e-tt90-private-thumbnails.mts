/** Disposable DB only: a real encrypted /Private image, real Files grid and host-side SQL checks. */
import assert from "node:assert/strict";
import pg from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing destructive private-thumbnail tests without TT89_DISPOSABLE_DATABASE=1 for a disposable server/database.");
const { test, finish } = makeHarness("e2e-tt90-private-thumbnails");
const cov = { "SC-10": "partial", "FF-13": "partial" } as const;
const BASE = process.env.BASE ?? "http://localhost:3000";
const RUN = `private-thumb-${Date.now().toString(36)}`; const PASS = "horse orbit ordinary test privacy words";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:5432/app_db" }); await db.connect();
const host = async (method: string, url: string, body?: unknown) => {
  const r = await fetch(BASE + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) };
};
const pre = await host("GET", "/api/fs?op=read&path=/Private/.keyslots.json");
const ls = await host("GET", "/api/fs?op=list&path=/Private");
const existing = (await db.query(`SELECT EXISTS (SELECT 1 FROM vfs_nodes WHERE path LIKE '/Private/%') AS nodes, EXISTS (SELECT 1 FROM vfs_versions WHERE path = '/Private' OR path LIKE '/Private/%') AS versions`)).rows[0];
if (pre.status !== 404 || ls.status !== 200 || !Array.isArray(ls.json.nodes) || ls.json.nodes.length || existing.nodes || existing.versions) {
  await db.end(); throw new Error("Existing /Private data or versions found — refusing destructive private-thumbnail tests.");
}
const old = await host("GET", "/api/state?id=default"); const rev = Number(old.json.row?.revision ?? 1) + 1000;
const win = (id: string, module: string, x: number, props: Record<string, unknown> = {}) => ({ id, module, title: module === "files" ? "Files" : "Privacy", x, y: 30, w: 680, h: 740, z: 11 + (module === "privacy" ? 1 : 0), minimized: false, maximized: false, workspace: 1, host: "tab", props });
await host("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [win("private-test-files", "files", 700, { path: "/Private" }), win("private-test-privacy", "privacy", 20)], focus: "private-test-privacy", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
const browser = await launchChromium(); const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
// Fault injection only: delay selected worker messages so lock-while-rendering is reproducible.
await context.addInitScript(() => {
  const Native = window.Worker; const w = window as any; w.__holdThumb = false; w.__heldThumb = []; w.__terminatedThumb = 0;
  window.Worker = class extends Native {
    private thumb: boolean;
    constructor(url: string | URL, options?: WorkerOptions) { super(url, options); this.thumb = options?.name === "fusion-thumbs"; }
    postMessage(message: any, options?: Transferable[] | StructuredSerializeOptions) {
      const send = () => { if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options); };
      if (this.thumb && w.__holdThumb) w.__heldThumb.push(send); else send();
    }
    terminate() { if (this.thumb) w.__terminatedThumb++; super.terminate(); }
  };
});
const page = await context.newPage(); page.setDefaultTimeout(25_000);
let created = false, hash = "", imageUrl = "";
const outside = `/System/Cache/thumbs-other-${RUN}.txt`, orphan = `/System/Cache/thumbs/orphan-${RUN}.webp`;
const path = `/Private/${RUN}.png`;
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  const root = page.locator('[data-testid="privacy"]').first(); await root.locator('[data-testid="pp1"]').waitFor({ timeout: 40_000 });
  await root.locator('[data-testid="pp1"]').fill(PASS); await root.locator('[data-testid="pp2"]').fill(PASS);
  created = true; await root.locator('[data-testid="create"]').click(); await root.locator('[data-testid="recovery-key"]').waitFor({ timeout: 40_000 });
  const png = await page.evaluate(async (label) => {
    const c = document.createElement("canvas"); c.width = 80; c.height = 60; const g = c.getContext("2d")!; g.fillStyle = "rgb(215,35,140)"; g.fillRect(0, 0, 80, 60); g.fillStyle = "black"; g.fillText(label, 0, 10);
    const b = await new Promise<Blob>((resolve) => c.toBlob((v) => resolve(v!), "image/png")); const u = new Uint8Array(await b.arrayBuffer()); return btoa(Array.from(u, (x) => String.fromCharCode(x)).join(""));
  }, RUN);
  const write = await page.evaluate(async ({ path, png }) => {
    const r = await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "upload", path, content: png, mime: "image/png" }) }); return { status: r.status, json: await r.json() };
  }, { path, png }); assert.equal(write.status, 200, JSON.stringify(write.json));
  const listed = await page.evaluate(async () => (await (await fetch("/api/fs?op=list&path=/Private")).json()).nodes);
  const node = listed.find((n: any) => n.path === path); assert.ok(node); hash = String(node.sha256).slice(0, 32);
  await page.evaluate(() => { const c = new BroadcastChannel("fusion.refresh"); c.postMessage(1); c.close(); });
  const files = page.getByRole("dialog", { name: "Files", exact: true }).first(); await files.getByRole("button", { name: "Grid", exact: true }).click();
  const image = files.getByRole("option", { name: new RegExp(`${RUN}\\.png`) }).locator('[data-thumb="ready"] img');
  await image.waitFor({ timeout: 40_000 }); imageUrl = (await image.getAttribute("src"))!;
  await test("encrypted private image renders real pixels without a plaintext host thumbnail cache", cov, async () => {
    const px = await image.evaluate(async (img: HTMLImageElement) => { await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d")!; g.drawImage(img, 0, 0); return Array.from(g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data).slice(0, 3); });
    assert.ok(px[0] > 180 && px[1] < 75 && px[2] > 100, `private rendered pixel ${px}`);
    await page.waitForTimeout(1300); // allow any fire-and-forget cache POST to reach PostgreSQL
    const cached = (await db.query("SELECT path FROM vfs_nodes WHERE path LIKE $1", [`/System/Cache/thumbs/${hash}-%`])).rows;
    assert.deepEqual(cached, [], `private plaintext thumbnail persisted outside /Private: ${JSON.stringify(cached)}`);
    const leakedNames = (await db.query("SELECT path FROM vfs_nodes WHERE path LIKE $1 OR name LIKE $1", [`%${RUN}%`])).rows; assert.deepEqual(leakedNames, []);
  });
  await test("locking removes the displayed private thumbnail and revokes its blob URL", cov, async () => {
    assert.ok(imageUrl.startsWith("blob:"));
    await page.locator('[data-testid="storage-badge"]').click();
    await page.waitForFunction((url) => !Array.from(document.querySelectorAll("img")).some((img) => img.src === url), imageUrl, { timeout: 15_000 });
    const stillReadable = await page.evaluate(async (url) => { try { return (await fetch(url)).ok; } catch { return false; } }, imageUrl);
    assert.equal(stillReadable, false, "private blob URL remained readable after lock");
  });
  await test("private requests ignore even a pre-existing host cache entry and redraw after unlock", cov, async () => {
    const green = await page.evaluate(async () => {
      const c = document.createElement("canvas"); c.width = 80; c.height = 60; const g = c.getContext("2d")!; g.fillStyle = "rgb(10,240,20)"; g.fillRect(0, 0, 80, 60);
      const b = await new Promise<Blob>((resolve) => c.toBlob((v) => resolve(v!), "image/webp")); return btoa(Array.from(new Uint8Array(await b.arrayBuffer()), (x) => String.fromCharCode(x)).join(""));
    });
    const stale = `/System/Cache/thumbs/${hash}-${node.size}-256-orig-r2.webp`;
    assert.equal((await host("POST", "/api/fs", { op: "write", path: stale, content: green, encoding: "base64", mime: "image/webp" })).status, 200);
    await root.locator('[data-testid="unlock-pass"]').fill(PASS); await root.locator('[data-testid="unlock"]').click();
    await page.locator('[data-testid="storage-badge"]').waitFor({ timeout: 40_000 }); await image.waitFor({ timeout: 40_000 });
    const px = await image.evaluate(async (img: HTMLImageElement) => { await img.decode(); const c = document.createElement("canvas"); c.width = img.naturalWidth; c.height = img.naturalHeight; const g = c.getContext("2d")!; g.drawImage(img, 0, 0); return Array.from(g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data).slice(0, 3); });
    assert.ok(px[0] > 180 && px[1] < 75 && px[2] > 100, `read stale green thumbnail instead of private source: ${px}`);
    assert.equal((await host("GET", `/api/fs?op=read&path=${encodeURIComponent(stale)}`)).json.node.content, green, "private work changed the stale cache");
  });
  await test("cleanup needs explicit confirmation, refuses amnesia, and removes only cache rows and orphan versions", cov, async () => {
    assert.equal((await host("POST", "/api/fs", { op: "write", path: outside, content: "outside-one" })).status, 200);
    assert.equal((await host("POST", "/api/fs", { op: "write", path: outside, content: "outside-two" })).status, 200);
    await db.query("INSERT INTO vfs_versions(path,version,encoding,content,size,sha256,reason) VALUES($1,1,'utf8','old-cache',9,'test','test')", [orphan]);
    assert.equal((await host("POST", "/api/privacy/thumbnail-cache", { confirm: "not confirmed" })).status, 400);
    for (const body of ["", "  ", "null", "[]", "42", "{oops", JSON.stringify({ confirm: "CLEAR THUMBNAIL CACHE", extra: true })]) {
      const bad = await fetch(BASE + "/api/privacy/thumbnail-cache", { method: "POST", headers: { "content-type": "application/json" }, body }); assert.equal(bad.status, 400, JSON.stringify(body));
    }
    const wrongType = await fetch(BASE + "/api/privacy/thumbnail-cache", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }); assert.equal(wrongType.status, 400);
    const large = await fetch(BASE + "/api/privacy/thumbnail-cache", { method: "POST", headers: { "content-type": "application/json" }, body: `"${"a".repeat(2048)}"` }); assert.equal(large.status, 413);
    const chunks = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`"${"b".repeat(2048)}"`)); c.close(); } });
    const chunked = await fetch(BASE + "/api/privacy/thumbnail-cache", { method: "POST", headers: { "content-type": "application/json" }, body: chunks, duplex: "half" } as RequestInit); assert.equal(chunked.status, 413);
    const wrongOrigin = await fetch(BASE + "/api/privacy/thumbnail-cache", { method: "POST", headers: { "content-type": "application/json", origin: "https://example.invalid" }, body: JSON.stringify({ confirm: "CLEAR THUMBNAIL CACHE" }) });
    assert.equal(wrongOrigin.status, 403);
    const amnesia = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const ap = await amnesia.newPage(); await ap.goto(`${BASE}/?amnesia=1`, { waitUntil: "domcontentloaded" }); await ap.locator('[data-shell-ready="true"]').waitFor({ timeout: 40_000 });
      const blocked = await ap.evaluate(async () => (await fetch("/api/privacy/thumbnail-cache", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "CLEAR THUMBNAIL CACHE" }) })).status);
      assert.equal(blocked, 423);
      await ap.locator('[data-testid="amnesic-badge"]').click(); const ar = ap.locator('[data-testid="privacy"]').first();
      await ar.getByRole("tab", { name: "Audit & speed", exact: true }).click(); assert.ok(await ar.locator('[data-testid="clear-old-thumbnails"]').isDisabled());
    } finally { await amnesia.close(); }
    await root.getByRole("tab", { name: "Audit & speed", exact: true }).click();
    page.once("dialog", (d) => void d.dismiss()); await root.locator('[data-testid="clear-old-thumbnails"]').click();
    assert.equal((await db.query("SELECT count(*)::int n FROM vfs_versions WHERE path=$1", [orphan])).rows[0].n, 1, "cancelled dialog deleted data");
    page.once("dialog", (d) => void d.accept()); await root.locator('[data-testid="clear-old-thumbnails"]').click();
    await root.locator('[data-testid="thumbnail-cache-result"]').waitFor({ timeout: 40_000 });
    assert.equal((await db.query("SELECT count(*)::int n FROM vfs_versions WHERE path=$1", [orphan])).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int n FROM vfs_nodes WHERE path LIKE $1", [`/System/Cache/thumbs/${hash}-%`])).rows[0].n, 0);
    assert.equal((await host("GET", `/api/fs?op=read&path=${encodeURIComponent(outside)}`)).json.node.content, "outside-two");
    assert.equal((await db.query("SELECT count(*)::int n FROM vfs_versions WHERE path=$1", [outside])).rows[0].n, 1);
    const privateRead = await page.evaluate(async (p) => (await (await fetch(`/api/fs?op=read&path=${encodeURIComponent(p)}`)).json()).node.content, path); assert.equal(privateRead, png);
  });
  await test("locking while a worker is stalled cancels it without publishing a late private preview", cov, async () => {
    await page.evaluate(() => { (window as any).__holdThumb = true; (window as any).__heldThumb = []; });
    const slow = `/Private/${RUN}-slow.png`;
    const write = await page.evaluate(async ({ slow, png }) => (await fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "upload", path: slow, content: png, mime: "image/png" }) })).status, { slow, png });
    assert.equal(write, 200);
    const listedSlow = await page.evaluate(async () => (await (await fetch("/api/fs?op=list&path=/Private")).json()).nodes);
    const slowHash = String(listedSlow.find((n: any) => n.path === slow).sha256).slice(0, 32);
    await page.evaluate(() => { const c = new BroadcastChannel("fusion.refresh"); c.postMessage(1); c.close(); });
    await page.waitForFunction(() => (window as any).__heldThumb.length > 0, null, { timeout: 40_000 });
    const before = await page.evaluate(() => (window as any).__terminatedThumb);
    await page.locator('[data-testid="storage-badge"]').click();
    await page.waitForFunction((n) => (window as any).__terminatedThumb > n, before, { timeout: 10_000 });
    await page.evaluate(() => { const w = window as any; for (const send of w.__heldThumb) { try { send(); } catch {} } w.__heldThumb = []; });
    await page.waitForTimeout(500);
    assert.equal(await page.getByRole("option", { name: new RegExp(`${RUN}-slow\\.png`) }).locator('[data-thumb="ready"]').count(), 0);
    assert.equal((await db.query("SELECT count(*)::int n FROM vfs_nodes WHERE path LIKE $1", [`/System/Cache/thumbs/${slowHash}-%`])).rows[0].n, 0);
  });
} finally {
  await context.close(); await browser.close();
  if (created) {
    await db.query("DELETE FROM vfs_versions WHERE path LIKE '/Private/%'");
    await db.query("DELETE FROM vfs_nodes WHERE path LIKE '/Private/%'");
    if (hash) { await db.query("DELETE FROM vfs_versions WHERE path LIKE $1", [`/System/Cache/thumbs/${hash}-%`]); await db.query("DELETE FROM vfs_nodes WHERE path LIKE $1", [`/System/Cache/thumbs/${hash}-%`]); }
    await db.query("DELETE FROM vfs_versions WHERE path=$1 OR path=$2", [outside, orphan]);
    await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR path=$2", [outside, orphan]);
    await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR ref=$2)", [outside, orphan]);
  }
  const current = await host("GET", "/api/state?id=default");
  if (old.json.row?.state) await host("PUT", "/api/state", { id: "default", revision: Number(current.json.row?.revision ?? 0) + 1000, state: old.json.row.state });
  await db.end();
}
finish();
