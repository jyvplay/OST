/** Real Chromium offline queue + PostgreSQL replay. EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing offline photo tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt94-ui-offline-${id}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("e2e-tt94-photos-offline"), cov = { "MD-03": "partial", "SC-10": "partial" } as const;
const call = async (method: string, path: string, body?: object) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json() };
};
const write = async (path: string, content: string, mime = "text/plain", encoding = "utf8") => { const r = await call("POST", "/api/fs", { op: "write", path, content, mime, encoding }); assert.equal(r.status, 200, JSON.stringify(r.json)); };
const node = async (p: string) => (await db.query("SELECT id,version,sha256,content FROM vfs_nodes WHERE path=$1", [p])).rows[0];
const side = (p: string) => `${p.slice(0, p.lastIndexOf("/") + 1)}.${p.slice(p.lastIndexOf("/") + 1)}.edit.json`;
let own = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  await write(`${root}/identity.txt`, id); assert.equal((await node(`${root}/identity.txt`))?.content, id, "server/database mismatch"); own = true;
  const photo = readFileSync("/tmp/tt54-photos/o6.jpg").toString("base64"), browser = await launchChromium();
  try {
    const open = async (path: string) => {
      const state = await call("GET", "/api/state?id=default"), rev = Number(state.json.row?.revision ?? 1) + 1000;
      assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } })).status, 200);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await ctx.newPage();
      await page.goto(`${BASE}/?open=photos&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("photos-editor").waitFor({ timeout: 30_000 }); await page.getByRole("button", { name: "Reset", exact: true }).waitFor({ timeout: 30_000 });
      // The shell polls in the background, so networkidle is not a valid readiness condition.
      return { ctx, page };
    };
    await test("an offline guarded edit really queues and replays successfully when the owner is unchanged", cov, async () => {
      const p = `${root}/replay.jpg`; await write(p, photo, "image/jpeg", "base64"); const before = await node(p); const { ctx, page } = await open(p);
      try {
        await page.getByRole("button", { name: "Rotate right", exact: true }).click(); await ctx.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); await page.getByText(/queued for replay/i).waitFor({ timeout: 8000 });
        const q = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]")); assert.equal(q.length, 1); assert.equal(q[0].body.expectedPhoto.id, before.id); assert.equal(await node(side(p)), undefined);
        const response = page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.expectedPhoto?.path === p);
        await ctx.setOffline(false); assert.equal((await response).status(), 200); await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length === 0);
        assert.ok((await node(side(p)))?.content); await page.getByText(/Back online: replayed 1 queued write/i).waitFor({ timeout: 8000 });
      } finally { await ctx.close(); }
    });
    await test("a stale offline edit is rejected and retained ahead of later queued work on reconnect", cov, async () => {
      const p = `${root}/stale.jpg`, dest = `${root}/moved.jpg`; await write(p, photo, "image/jpeg", "base64"); const before = await node(p); const { ctx, page } = await open(p);
      try {
        await page.getByRole("button", { name: "Rotate right", exact: true }).click(); await ctx.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); await page.getByText(/queued for replay/i).waitFor({ timeout: 8000 });
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length === 2);
        assert.equal((await call("POST", "/api/fs", { op: "move", src: p, dst: dest })).status, 200); await write(p, photo, "image/jpeg", "base64"); assert.notEqual((await node(p)).id, before.id);
        // Match the target, not the very guard whose absence this test must detect.
        const response = page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.op === "write" && r.request().postDataJSON()?.path === side(p));
        await ctx.setOffline(false); assert.equal((await response).status(), 409); await page.getByText(/queued write\(s\) were rejected by the server and kept in the queue/i).waitFor({ timeout: 8000 });
        const q = await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]")); assert.equal(q.length, 2); assert.equal(q[0].body.expectedPhoto.id, before.id);
        assert.equal(await node(side(p)), undefined); assert.equal((await node(dest)).id, before.id);
      } finally { await ctx.close(); }
    });
    await test("a dequeue storage failure after a server commit warns of an ambiguous replay", cov, async () => {
      const p = `${root}/dequeue.jpg`; await write(p, photo, "image/jpeg", "base64"); const { ctx, page } = await open(p);
      try {
        await page.getByRole("button", { name: "Rotate right", exact: true }).click(); await ctx.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); await page.getByText(/queued for replay/i).waitFor({ timeout: 8000 });
        await page.evaluate(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === "fusion.queue") throw new DOMException("quota denied", "QuotaExceededError"); return orig.call(this, key, value); }; });
        const response = page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.expectedPhoto?.path === p);
        await ctx.setOffline(false); assert.equal((await response).status(), 200); await page.getByText(/offline queue could not be updated after a server response/i).waitFor({ timeout: 8000 });
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length), 1); assert.ok((await node(side(p)))?.content, "server did commit the recipe");
        assert.equal(await page.getByText(/Back online: replayed 1 queued write/i).count(), 0, "must not claim the queue was drained");
      } finally { await ctx.close(); }
    });
    await test("a corrupt persisted queue is neither overwritten nor silently replayed", cov, async () => {
      const p = `${root}/corrupt.jpg`; await write(p, photo, "image/jpeg", "base64"); const { ctx, page } = await open(p);
      try {
        await page.getByRole("button", { name: "Rotate right", exact: true }).click(); await page.evaluate(() => localStorage.setItem("fusion.queue", "{bad-json"));
        await ctx.setOffline(true); await page.waitForFunction(() => !navigator.onLine); await page.getByRole("button", { name: "Save edit", exact: true }).click();
        await page.getByText(/could not be queued/i).waitFor({ timeout: 8000 }); assert.equal(await page.evaluate(() => localStorage.getItem("fusion.queue")), "{bad-json");
        await ctx.setOffline(false); await page.getByText(/offline queue could not be read/i).waitFor({ timeout: 8000 });
        assert.equal(await page.evaluate(() => localStorage.getItem("fusion.queue")), "{bad-json"); assert.equal(await node(side(p)), undefined);
      } finally { await ctx.close(); }
    });
    await test("single-tab offline replay still works when Web Locks is unavailable", cov, async () => {
      const p = `${root}/nolocks.jpg`; await write(p, photo, "image/jpeg", "base64"); const { ctx, page } = await open(p);
      try {
        await page.evaluate(() => Object.defineProperty(navigator, "locks", { configurable: true, value: undefined }));
        await page.getByRole("button", { name: "Rotate right", exact: true }).click(); await ctx.setOffline(true); await page.waitForFunction(() => !navigator.onLine);
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); await page.getByText(/queued for replay/i).waitFor({ timeout: 8000 });
        const response = page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.path === side(p));
        await ctx.setOffline(false); assert.equal((await response).status(), 200); await page.waitForFunction(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length === 0);
        assert.ok((await node(side(p)))?.content);
      } finally { await ctx.close(); }
    });
    await test("storage quota denial cannot masquerade as a queued photo save", cov, async () => {
      const p = `${root}/quota.jpg`; await write(p, photo, "image/jpeg", "base64"); const { ctx, page } = await open(p);
      try {
        await page.getByRole("button", { name: "Rotate right", exact: true }).click();
        await page.evaluate(() => { const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === "fusion.queue") throw new DOMException("quota denied", "QuotaExceededError"); return orig.call(this, key, value); }; });
        await ctx.setOffline(true); await page.waitForFunction(() => !navigator.onLine); await page.getByRole("button", { name: "Save edit", exact: true }).click();
        await page.getByText(/could not be (queued|stored)/i).waitFor({ timeout: 8000 }); assert.equal(await page.evaluate(() => localStorage.getItem("fusion.queue")), null);
        assert.equal(await node(side(p)), undefined); assert.equal(await page.getByRole("button", { name: "Save edit", exact: true }).isEnabled(), true);
      } finally { await ctx.close(); }
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
