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
      await page.locator(`[data-photo="${names[0]}"]`).click(); await page.getByRole("button", { name: "Next photo" }).click();
      // A third image may be between them after sorting. It must match the new
      // shown list, so only assert that the previous photo is A after stepping.
      await page.getByRole("button", { name: "Previous photo" }).click(); await page.getByTestId("photos-editor").getByText(names[0], { exact: true }).waitFor();
    } finally { release(); await context.close(); }
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
