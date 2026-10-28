/** Independent Chromium editors and injected read errors against an EXCLUSIVE disposable server/database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing recipe browser tests without an exclusive disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", run = randomBytes(8).toString("hex"), root = `/Documents/tt95-ui-recipes-${run}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("e2e-tt95-photo-concurrency"), cov = { "MD-03": "partial", "FM-03": "partial" } as const;
const call = async (method: string, path: string, body?: object) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, json: await r.json() }; };
const write = async (path: string, content: string, mime = "text/plain", encoding = "utf8") => { const r = await call("POST", "/api/fs", { op: "write", path, content, mime, encoding }); assert.equal(r.status, 200, JSON.stringify(r.json)); };
const node = async (p: string) => (await db.query("SELECT id,version,sha256,content FROM vfs_nodes WHERE path=$1", [p])).rows[0];
const side = (p: string) => `${p.slice(0, p.lastIndexOf("/") + 1)}.${p.slice(p.lastIndexOf("/") + 1)}.edit.json`;
let own = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  await write(`${root}/identity.txt`, run); assert.equal((await node(`${root}/identity.txt`))?.content, run, "server/database mismatch"); own = true;
  const image = readFileSync("/tmp/tt54-photos/o6.jpg").toString("base64"), browser = await launchChromium();
  try {
    const open = async (path: string, readFault = false) => {
      const state = await call("GET", "/api/state?id=default"), rev = Number(state.json.row?.revision ?? 1) + 1000;
      assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } })).status, 200);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await ctx.newPage();
      if (readFault) await page.route("**/api/fs?**", async (route) => {
        const u = new URL(route.request().url());
        if (route.request().method() === "GET" && u.searchParams.get("op") === "read" && u.searchParams.get("path") === side(path)) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "injected recipe read failure" }) });
        else await route.continue();
      });
      await page.goto(`${BASE}/?open=photos&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" }); return { ctx, page };
    };
    const ready = async (page: Awaited<ReturnType<typeof open>>["page"]) => { await page.getByTestId("photos-editor").waitFor({ timeout: 30_000 }); await page.getByRole("button", { name: "Reset", exact: true }).waitFor({ timeout: 30_000 }); };
    const response = (page: Awaited<ReturnType<typeof open>>["page"], op: string) => page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.op === op);
    await test("two open editors cannot silently overwrite the first saved recipe", cov, async () => {
      const p = `${root}/two.jpg`; await write(p, image, "image/jpeg", "base64"); const a = await open(p); await ready(a.page); const b = await open(p); await ready(b.page);
      try {
        await a.page.getByRole("button", { name: "Rotate right", exact: true }).click(); await b.page.getByRole("button", { name: "Rotate left", exact: true }).click();
        const first = response(a.page, "write"); await a.page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.equal((await first).status(), 200);
        const stale = response(b.page, "write"); await b.page.getByRole("button", { name: "Save edit", exact: true }).click(); const r = await stale; assert.equal(r.status(), 409);
        assert.equal(r.request().postDataJSON().expectedRecipe, null); await b.page.getByText(/Save failed:.*reopen/i).waitFor({ timeout: 8000 });
        assert.equal(JSON.parse((await node(side(p))).content).rotate, 1); assert.equal(await b.page.getByRole("button", { name: "Save edit", exact: true }).isEnabled(), true);
      } finally { await a.ctx.close(); await b.ctx.close(); }
    });
    await test("a stale reset cannot clear a newer edit of the same photo", cov, async () => {
      const p = `${root}/reset.jpg`; await write(p, image, "image/jpeg", "base64"); await write(side(p), '{"v":1,"rotate":1}', "application/json");
      const a = await open(p); await ready(a.page); const b = await open(p); await ready(b.page);
      try {
        await a.page.getByRole("button", { name: "Reset", exact: true }).click(); await b.page.getByRole("button", { name: "Rotate right", exact: true }).click();
        const newer = response(b.page, "write"); await b.page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.equal((await newer).status(), 200);
        const stale = response(a.page, "purge"); await a.page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.equal((await stale).status(), 409);
        await a.page.getByText(/Save failed:.*reopen/i).waitFor({ timeout: 8000 }); assert.equal(JSON.parse((await node(side(p))).content).rotate, 2);
      } finally { await a.ctx.close(); await b.ctx.close(); }
    });
    await test("a newer favorite cannot be lost to a stale pixel edit", cov, async () => {
      const p = `${root}/favorite.jpg`; await write(p, image, "image/jpeg", "base64"); const a = await open(p); await ready(a.page); const b = await open(p); await ready(b.page);
      try {
        await b.page.getByRole("button", { name: "Rotate right", exact: true }).click(); const flag = response(a.page, "write"); await a.page.getByRole("button", { name: "Favorite", exact: true }).click(); assert.equal((await flag).status(), 200);
        const stale = response(b.page, "write"); await b.page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.equal((await stale).status(), 409);
        assert.equal(JSON.parse((await node(side(p))).content).favorite, true); assert.equal(await b.page.getByRole("button", { name: "Save edit", exact: true }).isEnabled(), true);
      } finally { await a.ctx.close(); await b.ctx.close(); }
    });
    await test("one editor can save successive edits and then clear the recipe", cov, async () => {
      const p = `${root}/success.jpg`; await write(p, image, "image/jpeg", "base64"); const a = await open(p); await ready(a.page);
      try {
        for (let i = 0; i < 2; i++) { await a.page.getByRole("button", { name: "Rotate right", exact: true }).click(); const pending = response(a.page, "write"); await a.page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.equal((await pending).status(), 200); await a.page.getByText(/Edit saved/).last().waitFor({ timeout: 8000 }); }
        assert.equal(JSON.parse((await node(side(p))).content).rotate, 2); await a.page.getByRole("button", { name: "Reset", exact: true }).click();
        const pending = response(a.page, "purge"); await a.page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.equal((await pending).status(), 200); assert.equal(await node(side(p)), undefined);
      } finally { await a.ctx.close(); }
    });
    await test("a queued stale recipe is rejected on reconnect and retained for the user", cov, async () => {
      const p = `${root}/offline.jpg`; await write(p, image, "image/jpeg", "base64"); await write(side(p), '{"v":1,"rotate":1}', "application/json");
      const old = await node(side(p)), a = await open(p); await ready(a.page);
      try {
        await a.page.getByRole("button", { name: "Rotate right", exact: true }).click(); await a.ctx.setOffline(true); await a.page.waitForFunction(() => !navigator.onLine);
        await a.page.getByRole("button", { name: "Save edit", exact: true }).click(); await a.page.getByText(/queued for replay/i).waitFor({ timeout: 8000 });
        const queued = await a.page.evaluate(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]"));
        assert.equal(queued.length, 1); assert.deepEqual(queued[0].body.expectedRecipe, { id: old.id, version: old.version, sha256: old.sha256 });
        await write(side(p), '{"v":1,"favorite":true}', "application/json");
        const replay = response(a.page, "write"); await a.ctx.setOffline(false); assert.equal((await replay).status(), 409);
        await a.page.getByText(/queued write\(s\) were rejected by the server and kept in the queue/i).waitFor({ timeout: 8000 });
        assert.equal(await a.page.evaluate(() => JSON.parse(localStorage.getItem("fusion.queue") || "[]").length), 1); assert.equal(JSON.parse((await node(side(p))).content).favorite, true);
      } finally { await a.ctx.close(); }
    });
    await test("a corrupt recipe is reported rather than opened as the original", cov, async () => {
      const p = `${root}/corrupt.jpg`; await write(p, image, "image/jpeg", "base64"); await write(side(p), "{not JSON", "application/json"); const a = await open(p);
      try { await a.page.getByText("Photo recipe is unreadable or invalid; it was not opened for editing.", { exact: true }).waitFor({ timeout: 12_000 }); assert.equal(await a.page.getByTestId("photos-editor").count(), 0); assert.equal((await node(side(p))).content, "{not JSON"); }
      finally { await a.ctx.close(); }
    });
    await test("an injected read failure is not mistaken for an absent recipe", cov, async () => {
      const p = `${root}/read-fault.jpg`; await write(p, image, "image/jpeg", "base64"); await write(side(p), '{"v":1,"rotate":1}', "application/json"); const a = await open(p, true);
      try { await a.page.getByText("Photo recipe could not be read; it was not opened for editing.", { exact: true }).waitFor({ timeout: 12_000 }); assert.equal(await a.page.getByTestId("photos-editor").count(), 0); assert.equal((await node(side(p))).content, '{"v":1,"rotate":1}'); }
      finally { await a.ctx.close(); }
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
