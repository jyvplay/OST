/** Real Photos UI against a concurrent HTTP photo move/replacement. EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing stale-photo browser tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt94-ui-stale-${id}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("e2e-tt94-photo-stale"), cov = { "MD-03": "partial", "FM-03": "partial" } as const;
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
      await page.getByTestId("photos-editor").waitFor({ timeout: 30_000 }); await page.getByRole("button", { name: "Reset", exact: true }).waitFor({ timeout: 30_000 }); return { ctx, page };
    };
    await test("a stale editor cannot attach edits to an identical replacement after another client moves its photo", cov, async () => {
      const p = `${root}/save.jpg`, dest = `${root}/saved-moved.jpg`; await write(p, photo, "image/jpeg", "base64"); const before = await node(p);
      const { ctx, page } = await open(p);
      try {
        await page.getByRole("button", { name: "Rotate right", exact: true }).click();
        assert.equal((await call("POST", "/api/fs", { op: "move", src: p, dst: dest })).status, 200); await write(p, photo, "image/jpeg", "base64"); assert.notEqual((await node(p)).id, before.id);
        const pending = page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.op === "write");
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); const response = await pending;
        assert.equal(response.status(), 409); assert.deepEqual(response.request().postDataJSON().expectedPhoto, { path: p, id: before.id, version: before.version, sha256: before.sha256 });
        await page.getByText(/Save failed:.*reopen/i).waitFor({ timeout: 8000 }); assert.equal(await node(side(p)), undefined); assert.equal((await node(dest)).id, before.id);
        assert.equal(await page.getByRole("button", { name: "Save edit", exact: true }).isEnabled(), true, "failed edit must remain dirty");
      } finally { await ctx.close(); }
    });
    await test("a stale reset cannot delete the new occupant's edits after a move and replacement", cov, async () => {
      const p = `${root}/clear.jpg`, dest = `${root}/clear-moved.jpg`; await write(p, photo, "image/jpeg", "base64"); await write(side(p), '{"v":1,"rotate":1}', "application/json"); const before = await node(p);
      const { ctx, page } = await open(p);
      try {
        await page.getByRole("button", { name: "Reset", exact: true }).click(); assert.equal((await call("POST", "/api/fs", { op: "move", src: p, dst: dest })).status, 200);
        await write(p, photo, "image/jpeg", "base64"); await write(side(p), '{"v":1,"rotate":2}', "application/json");
        const pending = page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.op === "purge");
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); const response = await pending;
        assert.equal(response.status(), 409); assert.equal(response.request().postDataJSON().expectedPhoto.id, before.id);
        await page.getByText(/Save failed:.*reopen/i).waitFor({ timeout: 8000 }); assert.equal((await node(side(p))).content, '{"v":1,"rotate":2}'); assert.equal((await node(side(dest))).content, '{"v":1,"rotate":1}');
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
