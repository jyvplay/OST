/** Cross-tab replay/enqueue races with real Chromium and PostgreSQL row locks. EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import type { BrowserContext, Page, Request } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing offline race tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt94-queue-race-${id}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("e2e-tt94-offline-race"), cov = { "SH-14": "partial", "MD-03": "partial" } as const;
const call = async (method: string, path: string, body?: object) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json() };
};
const write = async (path: string, content: string, mime = "text/plain", encoding = "utf8") => { const r = await call("POST", "/api/fs", { op: "write", path, content, mime, encoding }); assert.equal(r.status, 200, JSON.stringify(r.json)); };
const node = async (p: string) => (await db.query("SELECT id,version,sha256,content FROM vfs_nodes WHERE path=$1", [p])).rows[0];
const side = (p: string) => `${p.slice(0, p.lastIndexOf("/") + 1)}.${p.slice(p.lastIndexOf("/") + 1)}.edit.json`;
const poll = async (f: () => Promise<boolean>, msg: string, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 40)); } throw new Error(msg); };
const waitPhotoLock = () => poll(async () => Number((await db.query("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query ILIKE '%for update%'")).rows[0].count) >= 1, "No actual PostgreSQL owner-row wait observed");
let own = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  await write(`${root}/identity.txt`, id); assert.equal((await node(`${root}/identity.txt`))?.content, id, "server/database mismatch"); own = true;
  const photo = readFileSync("/tmp/tt54-photos/o6.jpg").toString("base64"), browser = await launchChromium();
  try {
    const open = async (path: string): Promise<{ ctx: BrowserContext; page: Page }> => {
      const state = await call("GET", "/api/state?id=default"), rev = Number(state.json.row?.revision ?? 1) + 1000;
      assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } })).status, 200);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await ctx.newPage();
      await page.goto(`${BASE}/?open=photos&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" }); await page.getByTestId("photos-editor").waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Reset", exact: true }).waitFor({ timeout: 30_000 }); return { ctx, page };
    };
    const enqueuePhoto = async (ctx: BrowserContext, page: Page) => {
      await page.getByRole("button", { name: "Rotate right", exact: true }).click(); await ctx.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
      await page.getByRole("button", { name: "Save edit", exact: true }).click(); await page.getByText(/queued for replay/i).waitFor({ timeout: 8000 });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length), 1);
    };
    await test("a later queued Files write is not lost while a photo replay is waiting on the database", cov, async () => {
      const p = `${root}/append.jpg`, later = `${root}/later.txt`; await write(p, photo, "image/jpeg", "base64"); const { ctx, page } = await open(p);
      const locker = new Client({ connectionString: process.env.DATABASE_URL }); await locker.connect(); let held = false; const requests: Request[] = [];
      page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/fs")) requests.push(r); });
      try {
        await enqueuePhoto(ctx, page); await locker.query("BEGIN"); held = true; await locker.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [p]);
        await ctx.setOffline(false); await waitPhotoLock();
        const other = await ctx.newPage();
        // This one page's POSTs fail as a controlled network fault; its real UI uses the ordinary offline queue.
        await other.route("**/api/fs", (route) => route.request().method() === "POST" ? route.abort("failed") : route.continue());
        await other.goto(`${BASE}/?open=files&path=${encodeURIComponent(root)}`, { waitUntil: "domcontentloaded" });
        const files = other.locator('.fs-window[aria-label="Files"]').first(); await files.locator(`[data-cwd="${root}"]`).first().waitFor({ timeout: 30_000 });
        await files.getByRole("button", { name: "New file", exact: true }).click(); const dlg = other.getByTestId("ask-dialog"); await dlg.waitFor({ timeout: 8000 });
        await dlg.locator("input").first().fill("later.txt"); await dlg.getByRole("button", { name: "Create", exact: true }).click();
        await other.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length === 2, null, { timeout: 10000 });
        const q = await other.evaluate(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]")); assert.equal(q[1].body.path, later);
        await locker.query("COMMIT"); held = false;
        await poll(async () => !!(await node(side(p))), "first photo replay did not commit");
        await poll(async () => !!(await node(later)), "later queued Files write was lost or never replayed");
        // A database commit can precede delivery of the HTTP response and dequeue.
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length === 0, null, { timeout: 10000 });
      } finally {
        if (held) await locker.query("ROLLBACK").catch(() => undefined);
        await Promise.race([Promise.allSettled(requests.map((r) => r.response())), new Promise((r) => setTimeout(r, 10_000))]);
        await ctx.close(); await locker.end();
      }
    });
    await test("a noncooperating queue change during replay is retained and reported", cov, async () => {
      const p = `${root}/changed.jpg`, later = `${root}/changed-later.txt`; await write(p, photo, "image/jpeg", "base64"); const { ctx, page } = await open(p);
      const locker = new Client({ connectionString: process.env.DATABASE_URL }); await locker.connect(); let held = false; const requests: Request[] = [];
      page.on("request", (r) => { if (r.method() === "POST" && r.url().endsWith("/api/fs")) requests.push(r); });
      try {
        await enqueuePhoto(ctx, page); await locker.query("BEGIN"); held = true; await locker.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [p]);
        await ctx.setOffline(false); await waitPhotoLock();
        // Controlled uncooperative actor replaces the head; do not pretend this is coordinated queue usage.
        await page.evaluate((path) => localStorage.setItem("fusion.queue", JSON.stringify([{ path: "/api/fs", body: { op: "write", path, content: "keep" }, at: Date.now(), id: "external" }])), later);
        await locker.query("COMMIT"); held = false; await page.getByText(/offline queue could not be updated after a server response/i).waitFor({ timeout: 10000 });
        const q = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]")); assert.equal(q.length, 1); assert.equal(q[0].body.path, later);
        assert.ok(await node(side(p)), "original server write did commit"); assert.equal(await node(later), undefined);
      } finally {
        if (held) await locker.query("ROLLBACK").catch(() => undefined);
        await Promise.race([Promise.allSettled(requests.map((r) => r.response())), new Promise((r) => setTimeout(r, 10_000))]);
        await ctx.close(); await locker.end();
      }
    });
    await test("two online tabs do not replay the same queued recipe twice", cov, async () => {
      const p = `${root}/duplicate.jpg`; await write(p, photo, "image/jpeg", "base64"); const { ctx, page } = await open(p);
      const other = await ctx.newPage(); await other.goto(BASE, { waitUntil: "domcontentloaded" });
      await other.locator('[aria-label="Shelf"], [data-testid="taskbar"], [data-testid="dock"]').first().waitFor({ state: "attached", timeout: 30_000 });
      await other.getByText("Starting Fusion Shell…").waitFor({ state: "hidden", timeout: 30_000 });
      const locker = new Client({ connectionString: process.env.DATABASE_URL }); await locker.connect(); let held = false; const requests: Request[] = [];
      const observe = (r: Request) => { if (r.method() === "POST" && r.url().endsWith("/api/fs") && r.postDataJSON()?.path === side(p)) requests.push(r); };
      try {
        await enqueuePhoto(ctx, page); await locker.query("BEGIN"); held = true; await locker.query("SELECT path FROM vfs_nodes WHERE path=$1 FOR UPDATE", [p]);
        page.on("request", observe); other.on("request", observe); await ctx.setOffline(false); await waitPhotoLock();
        await other.evaluate(() => window.dispatchEvent(new Event("online"))); await new Promise((r) => setTimeout(r, 800));
        assert.equal(requests.length, 1, "two tabs issued the same queued request while the first was blocked");
        await locker.query("COMMIT"); held = false; await poll(async () => !!(await node(side(p))), "photo replay did not commit");
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length === 0, null, { timeout: 10000 });
        await Promise.all(requests.map((r) => r.response())); assert.equal((await node(side(p))).version, 1);
        assert.equal((await db.query("SELECT 1 FROM vfs_versions WHERE path=$1", [side(p)])).rowCount, 0, "duplicate replay created an extra version");
      } finally {
        if (held) await locker.query("ROLLBACK").catch(() => undefined);
        await Promise.race([Promise.allSettled(requests.map((r) => r.response())), new Promise((r) => setTimeout(r, 10_000))]);
        await ctx.close(); await locker.end();
      }
    });
  } finally { await browser.close(); }
} finally {
  if (own) {
    await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
    await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
    await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [root]);
  }
  await db.end(); finish();
}
