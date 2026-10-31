/** Real Chromium + actual VFS. Route delays withhold real reads, then release
 * them; no fabricated API data. Requires an exclusive disposable database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { injectExifPng } from "../src/lib/image/encode.ts";
import { readMetadata } from "../src/lib/meta/index.ts";
import { crc32 } from "../src/lib/office/zipkit.ts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE, tag = randomBytes(8).toString("hex");
const paths = [`/Pictures/tt128-${tag}-a.png`, `/Pictures/tt128-${tag}-b.png`, `/Pictures/tt128-${tag}-c.png`];
const names = paths.map((p) => p.split("/").pop()!);
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const browser = await launchChromium(); const { test, finish } = makeHarness("e2e-tt128-photos");
async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${path} ${r.status}: ${await r.text()}`); return r.json();
}
async function photosState(props: Record<string, unknown> = {}) {
  const current = await call("GET", "/api/state?id=default");
  await call("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "photos", title: "Photos", x: 20, y: 16, w: 1100, h: 800, z: 10, workspace: 1, props }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
}
// Tiny TIFF with DateTimeOriginal; the PNG and pixels are real, not a mock.
function exif(date: string) {
  const b = Buffer.alloc(64); b.write("II", 0); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  b.writeUInt16LE(1, 8); b.writeUInt16LE(0x8769, 10); b.writeUInt16LE(4, 12); b.writeUInt32LE(1, 14); b.writeUInt32LE(26, 18);
  b.writeUInt16LE(1, 26); b.writeUInt16LE(0x9003, 28); b.writeUInt16LE(2, 30); b.writeUInt32LE(20, 32); b.writeUInt32LE(44, 36); b.write(date, 44, "ascii"); return b;
}
const source = readFileSync("docs/screens/tt118-clock.png");
const a = injectExifPng(source, exif("2041:01:03 12:00:00"));
const b = injectExifPng(source, exif("2020:01:02 12:00:00"));
// Add an ordinary PNG tEXt chunk so this undated image has its own content
// hash, rather than sharing the existing screenshot fixture's cache entry.
const text = Buffer.from(`Comment\0tt128-${tag}`), body = Buffer.concat([Buffer.from("tEXt"), text]);
const length = Buffer.alloc(4), checksum = Buffer.alloc(4); length.writeUInt32BE(text.length); checksum.writeUInt32BE(crc32(body));
const c = Buffer.concat([source.subarray(0, source.length - 12), length, body, checksum, source.subarray(source.length - 12)]);
assert.equal((await readMetadata(c, "c.png")).tags.dateTaken, undefined);
assert.equal((await readMetadata(a, "a.png")).tags.dateTaken, "2041-01-03T12:00:00");
assert.equal((await readMetadata(b, "b.png")).tags.dateTaken, "2020-01-02T12:00:00");
const owned: string[] = [];
let originalState: unknown, stateChanged = false;
try {
  if ((await db.query("SELECT 1 FROM vfs_nodes WHERE path=ANY($1)", [paths])).rowCount) throw new Error("Refusing pre-existing fixtures");
  for (const [i, image] of [a, b, c].entries()) {
    const result = await call("POST", "/api/fs", { op: "writeIfUnchanged", path: paths[i], content: Buffer.from(image).toString("base64"), encoding: "base64", mime: "image/png", expected: null });
    const match = await db.query("SELECT id,sha256 FROM vfs_nodes WHERE path=$1", [paths[i]]);
    assert.equal(match.rowCount, 1, "server and database must match");
    assert.equal(match.rows[0].id, result.id); assert.equal(match.rows[0].sha256, result.sha256);
    owned.push(paths[i]);
  }
  const rows = await db.query("SELECT path,sha256 FROM vfs_nodes WHERE path=ANY($1)", [paths]); assert.equal(rows.rowCount, 3);
  await db.query("UPDATE vfs_nodes SET created_at=CASE path WHEN $1 THEN '2030-01-01T12:00:00Z'::timestamptz WHEN $2 THEN '2031-01-01T12:00:00Z'::timestamptz ELSE '2029-01-01T12:00:00Z'::timestamptz END WHERE path=ANY($3)", [paths[0], paths[1], paths]);
  const hashes = Object.fromEntries(rows.rows.map((r) => [r.path, r.sha256]));
  const cur = await call("GET", "/api/state?id=default"); originalState = cur.row?.state;
  await call("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "photos", title: "Photos", x: 20, y: 16, w: 1100, h: 800, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  stateChanged = true;
  await test("delayed EXIF reordering cannot change an active editor walk; reopening takes the new order", { "PH-04": "partial", "PH-05": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); let holding = true;
    await page.route("**/api/fs?**", async (route) => {
      const u = new URL(route.request().url());
      if (holding && u.searchParams.get("op") === "read" && paths.includes(u.searchParams.get("path") ?? "")) await wait;
      await route.continue().catch(() => undefined);
    });
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.locator(`[data-photo="${names[0]}"]`).waitFor(); await page.locator(`[data-photo="${names[1]}"]`).waitFor();
      const order = () => page.locator("[data-photo]").evaluateAll((els, wanted) => els.map((e) => e.getAttribute("data-photo")).filter((n) => wanted.includes(n!)), names.slice(0, 2));
      assert.deepEqual(await order(), [names[1], names[0]], "file-date order before delayed metadata");
      await page.locator(`[data-photo="${names[1]}"]`).click(); await page.getByRole("button", { name: "Next photo" }).waitFor();
      holding = false; release();
      await page.waitForFunction(([aHash, bHash]) => {
        const ix = JSON.parse(localStorage.getItem("fusion.photos.index.v1") ?? "{}"); return ix[aHash]?.dateSource === "exif" && ix[bHash]?.dateSource === "exif";
      }, [hashes[paths[0]], hashes[paths[1]]], { timeout: 30_000 });
      await page.getByRole("button", { name: "Next photo" }).click();
      await page.getByTestId("photos-editor").getByText(names[0], { exact: true }).waitFor();
      await page.getByRole("button", { name: "Back to library" }).click();
      await page.waitForFunction((wanted) => {
        const got = [...document.querySelectorAll("[data-photo]")].map((el) => el.getAttribute("data-photo")).filter((n) => wanted.includes(n!));
        return JSON.stringify(got) === JSON.stringify(wanted);
      }, [names[0], names[1]]);
      assert.deepEqual(await order(), [names[0], names[1]], "library updates to EXIF order");
      if (process.env.TT129_CAPTURE === "1") await page.screenshot({ path: "docs/screens/tt129-photos-library.png" });
      await page.locator(`[data-photo="${names[0]}"]`).click();
      if (process.env.TT129_CAPTURE === "1") {
        await page.waitForFunction(() => document.querySelector('[data-testid="photos-canvas"]')?.hasAttribute("width"));
        await page.screenshot({ path: "docs/screens/tt129-photos-viewer.png" });
      }
      await page.getByRole("button", { name: "Next photo" }).click();
      // A third image may be between them after sorting. It must match the new
      // shown list, so only assert that the previous photo is A after stepping.
      await page.getByRole("button", { name: "Previous photo" }).click(); await page.getByTestId("photos-editor").getByText(names[0], { exact: true }).waitFor();
    } finally { release(); await context.close(); }
  });
  await test("a navigation click survives the current image finishing its real load between pointer down and up", { "PH-04": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); let holding = true;
    await page.route("**/api/fs?**", async (route) => {
      const u = new URL(route.request().url());
      if (holding && u.searchParams.get("op") === "read" && u.searchParams.get("path") === paths[0]) await wait;
      await route.continue().catch(() => undefined);
    });
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.locator(`[data-photo="${names[0]}"]`).waitFor();
      await page.getByLabel("Sort photos").selectOption("name");
      await page.locator(`[data-photo="${names[0]}"]`).click();
      const next = page.getByRole("button", { name: "Next photo" });
      await next.waitFor(); assert.equal(await next.isEnabled(), true);
      await next.evaluate((el) => { (window as Window & { __tt128Nav?: Element }).__tt128Nav = el; });
      const box = await next.boundingBox(); assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      holding = false; release();
      await page.getByTestId("photos-canvas").waitFor(); // the real read/decode completed while the button is held
      assert.equal(await next.evaluate((el) => el === (window as Window & { __tt128Nav?: Element }).__tt128Nav), true, "loading must not replace the navigation button under a pressed pointer");
      await page.mouse.up();
      await page.getByTestId("photos-editor").getByText(names[1], { exact: true }).waitFor();
    } finally { release(); await page.mouse.up().catch(() => undefined); await context.close(); }
  });
  await test("a failed real image read is not cached as missing metadata and a reload retries", { "PH-07": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(25_000); let fail = true, intercepted = 0;
    await page.route("**/api/fs?**", async (route) => {
      const url = new URL(route.request().url());
      if (fail && url.searchParams.get("op") === "read" && url.searchParams.get("path") === paths[2]) { intercepted++; await route.abort("failed"); }
      else await route.continue();
    });
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(([aHash, bHash]) => {
        const ix = JSON.parse(localStorage.getItem("fusion.photos.index.v1") ?? "{}"); return ix[aHash]?.dateSource === "exif" && ix[bHash]?.dateSource === "exif";
      }, [hashes[paths[0]], hashes[paths[1]]], { timeout: 30_000 });
      assert.ok(intercepted > 0, "an actual file read was deliberately failed");
      const cached = await page.evaluate((hash) => JSON.parse(localStorage.getItem("fusion.photos.index.v1") ?? "{}")[hash] ?? null, hashes[paths[2]]);
      assert.equal(cached, null);
      fail = false; await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction((hash) => JSON.parse(localStorage.getItem("fusion.photos.index.v1") ?? "{}")[hash]?.dateSource === "file", hashes[paths[2]], { timeout: 30_000 });
    } finally { await context.close(); }
  });
  await test("No date retains a PNG with no capture metadata after indexing", { "PH-07": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(25_000); await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForFunction((hash) => { const ix = JSON.parse(localStorage.getItem("fusion.photos.index.v1") ?? "{}"); return ix[hash]?.dateSource === "file"; }, hashes[paths[2]]);
      await page.getByRole("button", { name: /No date/ }).click(); await page.locator(`[data-photo="${names[2]}"]`).waitFor();
      assert.equal(await page.locator(`[data-photo="${names[0]}"]`).count(), 0);
    } finally { await context.close(); }
  });
  await test("a thumbnail completing between pointer down and up keeps its tile geometry and click", { "PH-01": "partial" }, async () => {
    await photosState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let holding = true, intercepted = 0;
    await page.route("**/api/fs?**", async (route) => {
      const url = new URL(route.request().url());
      if (holding && url.searchParams.get("op") === "read" && (url.searchParams.get("path") ?? "").startsWith("/System/Cache/thumbs/")) { intercepted++; await held; }
      await route.continue().catch(() => undefined);
    });
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Sort photos").selectOption("name");
      const tile = page.locator(`[data-photo="${names[0]}"]`); await tile.scrollIntoViewIfNeeded();
      await tile.locator('[data-thumb="pending"]').waitFor();
      const before = await tile.boundingBox(); assert.ok(before);
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2); await page.mouse.down();
      holding = false; release();
      await tile.locator('[data-thumb="ready"]').waitFor({ timeout: 25_000 });
      const after = await tile.boundingBox(); assert.ok(after); assert.ok(intercepted > 0, "genuine thumbnail-cache reads were delayed");
      assert.ok(Math.abs(before.height - after.height) <= 1 && Math.abs(before.y - after.y) <= 1,
        `tile moved during the pointer gesture: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
      await page.mouse.up();
      await page.getByTestId("photos-editor").getByText(names[0], { exact: true }).waitFor();
    } finally { release(); await context.close(); }
  });
  await test("photo tiles retain keyboard activation and cancel a drag away", { "PH-01": "partial" }, async () => {
    await photosState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Sort photos").selectOption("name");
      const tile = page.locator(`[data-photo="${names[0]}"]`); await tile.scrollIntoViewIfNeeded();
      const box = await tile.boundingBox(); assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(4, 45); await page.mouse.up();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      assert.equal(await page.getByTestId("photos-library").count(), 1, "dragging away must not activate the tile");
      await tile.focus(); await page.keyboard.press("Enter");
      await page.getByTestId("photos-editor").getByText(names[0], { exact: true }).waitFor();
    } finally { await context.close(); }
  });
  await test("a deep-linked viewer snapshots the library before delayed EXIF reordering", { "PH-04": "partial" }, async () => {
    await photosState({ path: paths[0] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let holding = true;
    await page.route("**/api/fs?**", async (route) => {
      const u = new URL(route.request().url());
      if (holding && u.searchParams.get("op") === "read" && paths.includes(u.searchParams.get("path") ?? "")) await held;
      await route.continue().catch(() => undefined);
    });
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const pos = page.getByTestId("photos-position"); await pos.waitFor();
      assert.match(await pos.innerText(), /^2 of \d+$/, "the deep link opens at its file-date position");
      holding = false; release();
      await page.waitForFunction(([aHash, bHash]) => {
        const ix = JSON.parse(localStorage.getItem("fusion.photos.index.v1") ?? "{}"); return ix[aHash]?.dateSource === "exif" && ix[bHash]?.dateSource === "exif";
      }, [hashes[paths[0]], hashes[paths[1]]], { timeout: 30_000 });
      await page.getByRole("button", { name: "Previous photo" }).click();
      await page.getByTestId("photos-editor").getByText(names[1], { exact: true }).waitFor();
      await page.getByRole("button", { name: "Back to library" }).click();
      // localStorage is written before React commits the reordered library.
      // Wait for the visible order itself before clicking a potentially moved tile.
      await page.waitForFunction((wanted) => {
        const visible = [...document.querySelectorAll("[data-photo]")].map((el) => el.getAttribute("data-photo")).filter((name) => wanted.includes(name!));
        return JSON.stringify(visible) === JSON.stringify(wanted);
      }, [names[0], names[1]]);
      await page.evaluate((photo) => {
        const trace: string[] = []; (window as Window & { __tt129ClickTrace?: string[] }).__tt129ClickTrace = trace;
        for (const type of ["pointerdown", "pointerup", "click"]) document.addEventListener(type, (event) => {
          const target = event.target as Element, tile = document.querySelector(`[data-photo="${photo}"]`)?.getBoundingClientRect();
          const mouse = event as PointerEvent;
          trace.push(`${type}:${target.tagName}:${target.closest("[data-photo]")?.getAttribute("data-photo") ?? "none"} pointer=${mouse.clientX},${mouse.clientY} tile=${tile && [tile.x, tile.y, tile.width, tile.height].map((n) => Math.round(n)).join(",")}`);
        }, true);
      }, names[0]);
      await page.locator(`[data-photo="${names[0]}"]`).click();
      let reopened: string;
      try { reopened = await page.getByTestId("photos-position").innerText(); }
      catch (error) {
        console.error("deep-link reopen diagnostics:", await page.evaluate(() => ({ trace: (window as Window & { __tt129ClickTrace?: string[] }).__tt129ClickTrace, library: !!document.querySelector('[data-testid="photos-library"]'), editor: !!document.querySelector('[data-testid="photos-editor"]'), photos: [...document.querySelectorAll("[data-photo]")].map((el) => el.getAttribute("data-photo")) })));
        if (process.env.HARNESS_STACK) await page.screenshot({ path: "/home/user/.cache/tt129-photos-deep-failure.png" });
        throw error;
      }
      assert.match(reopened, /^1 of \d+$/, "reopening takes the EXIF order");
      assert.equal(await page.getByRole("button", { name: "Previous photo" }).isEnabled(), false);
    } finally { release(); await context.close(); }
  });
  await test("a deep-linked viewer keeps its original order across a real trash and restore", { "PH-04": "partial" }, async () => {
    const current = await call("GET", "/api/state?id=default");
    await call("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 1) + 1000, state: {
      windows: [
        { id: "w1", module: "photos", title: "Photos", x: 20, y: 16, w: 760, h: 800, z: 10, workspace: 1, props: { path: paths[0] } },
        { id: "w2", module: "terminal", title: "Terminal", x: 790, y: 16, w: 460, h: 500, z: 11, workspace: 1, props: {} },
      ], focus: "w2", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
    } });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; }); let holding = true;
    await page.route("**/api/fs?**", async (route) => {
      const u = new URL(route.request().url());
      if (holding && u.searchParams.get("op") === "read" && paths.includes(u.searchParams.get("path") ?? "")) await held;
      await route.continue().catch(() => undefined);
    });
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByTestId("photos-position").waitFor();
      assert.match(await page.getByTestId("photos-position").innerText(), /^2 of \d+$/);
      holding = false; release();
      await page.waitForFunction(([aHash, bHash]) => {
        const ix = JSON.parse(localStorage.getItem("fusion.photos.index.v1") ?? "{}"); return ix[aHash]?.dateSource === "exif" && ix[bHash]?.dateSource === "exif";
      }, [hashes[paths[0]], hashes[paths[1]]], { timeout: 30_000 });
      const terminal = page.getByLabel("Terminal input");
      await terminal.fill(`rm ${paths[0]}`); await terminal.press("Enter");
      await page.getByTestId("photos-library").waitFor();
      await terminal.fill(`restore ${paths[0]}`); await terminal.press("Enter");
      await page.getByTestId("photos-position").waitFor();
      assert.match(await page.getByTestId("photos-position").innerText(), /^2 of \d+$/, "the same deep-link session must retain the pre-EXIF order");
      await page.getByRole("button", { name: "Previous photo" }).click();
      await page.getByTestId("photos-editor").getByText(names[1], { exact: true }).waitFor();
    } finally { release(); await call("POST", "/api/fs", { op: "restore", path: paths[0] }); await context.close(); }
  });
  await test("a failed library read exposes a retry and recovers without reloading the shell", { "PH-01": "partial" }, async () => {
    await photosState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(20_000); let fail = true, requests = 0;
    await page.route("**/api/fs?**", async (route) => {
      const u = new URL(route.request().url());
      if (u.searchParams.get("op") === "media") { requests++; if (fail) { await route.abort("failed"); return; } }
      await route.continue();
    });
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Retry library" }).waitFor({ timeout: 7_000 });
      if (process.env.TT129_CAPTURE === "1") await page.screenshot({ path: "docs/screens/tt129-photos-error.png" });
      assert.equal(await page.getByText("Loading library…").count(), 0, "failure is not still presented as loading");
      fail = false; await page.getByRole("button", { name: "Retry library" }).click();
      await page.locator(`[data-photo="${names[0]}"]`).waitFor();
      assert.ok(requests >= 2, "retry issues a new real request");
      assert.equal(await page.getByRole("button", { name: "Retry library" }).count(), 0);
    } finally { await context.close(); }
  });
  await test("a refresh result is not replaced by an older delayed real media response", { "PH-01": "partial" }, async () => {
    await photosState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    let release!: () => void, arrived!: () => void, delivered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const firstCaptured = new Promise<void>((resolve) => { arrived = resolve; });
    const firstDelivered = new Promise<void>((resolve) => { delivered = resolve; });
    let holding = true, captured = 0;
    await page.route("**/api/fs?**", async (route) => {
      const u = new URL(route.request().url());
      if (holding && u.searchParams.get("op") === "media") {
        const response = await route.fetch(); captured++; arrived(); await hold;
        await route.fulfill({ response }).catch(() => undefined); delivered();
      } else await route.continue();
    });
    const extra = `/Pictures/tt129-${tag}-new.png`, name = extra.split("/").pop()!;
    try {
      await page.goto(BASE, { waitUntil: "domcontentloaded" }); await firstCaptured;
      const made = await call("POST", "/api/fs", { op: "writeIfUnchanged", path: extra, content: source.toString("base64"), encoding: "base64", mime: "image/png", expected: null });
      const row = await db.query("SELECT id,sha256 FROM vfs_nodes WHERE path=$1", [extra]);
      assert.equal(row.rowCount, 1); assert.equal(row.rows[0].id, made.id); assert.equal(row.rows[0].sha256, made.sha256); owned.push(extra);
      holding = false;
      await page.getByRole("button", { name: "Refresh photos" }).click({ timeout: 7_000 });
      await page.locator(`[data-photo="${name}"]`).waitFor();
      release(); await firstDelivered;
      await page.waitForTimeout(500); // permit a deliberately released stale response to commit if unguarded
      assert.equal(await page.locator(`[data-photo="${name}"]`).count(), 1, "the old response must not erase the newer listing");
      assert.ok(captured >= 1);
    } finally { release(); await context.close(); }
  });
  await test("slideshow advances through the captured name order and pauses", { "PH-04": "partial" }, async () => {
    await photosState();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(20_000); await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.locator(`[data-photo="${names[0]}"]`).waitFor();
      await page.getByLabel("Sort photos").selectOption("name");
      await page.getByLabel("Slideshow seconds per photo").fill("1");
      await page.locator(`[data-photo="${names[0]}"]`).click();
      await page.getByRole("button", { name: "Play slideshow" }).click();
      await page.getByTestId("photos-editor").getByText(names[1], { exact: true }).waitFor({ timeout: 5_000 });
      await page.getByRole("button", { name: "Pause show" }).click();
      await page.waitForTimeout(1_300); // observation window longer than the selected interval
      await page.getByTestId("photos-editor").getByText(names[1], { exact: true }).waitFor({ timeout: 2_000 });
    } finally { await context.close(); }
  });
} finally {
  await browser.close();
  for (const path of owned) { await call("POST", "/api/fs", { op: "trash", path }); await call("POST", "/api/fs", { op: "purge", path }); }
  if (owned.length) {
    await db.query("DELETE FROM file_ops WHERE src=ANY($1) OR dst=ANY($1)", [owned]);
    await db.query("DELETE FROM audit_log WHERE detail=ANY($1)", [owned]);
  }
  if (stateChanged && originalState) {
    const cur = await call("GET", "/api/state?id=default");
    await call("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: originalState });
  }
  await db.end(); finish();
}
