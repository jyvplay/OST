/** Actual Files UI rename with photo sidecars. EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing Files sidecar browser tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt93-ui-${id}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("e2e-tt93-sidecar"), cov = { "FM-03": "partial", "MD-03": "partial" } as const;
const call = async (method: string, path: string, body?: object) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json() };
};
const write = async (path: string, content: string, mime = "text/plain", encoding = "utf8") => {
  const r = await call("POST", "/api/fs", { op: "write", path, content, mime, encoding }); assert.equal(r.status, 200, JSON.stringify(r.json));
};
const node = async (p: string) => (await db.query("SELECT id,content,version FROM vfs_nodes WHERE path=$1", [p])).rows[0];
const clean = async () => {
  await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
  await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [root]);
};
let own = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  await write(`${root}/identity.txt`, id); assert.equal((await node(`${root}/identity.txt`))?.content, id, "server/database mismatch"); own = true;
  const photo = readFileSync("/tmp/tt54-photos/o6.jpg").toString("base64");
  const browser = await launchChromium();
  try {
    const state = await call("GET", "/api/state?id=default"); const rev = Number(state.json.row?.revision ?? 1) + 1000;
    assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } })).status, 200);
    await write(`${root}/source.jpg`, photo, "image/jpeg", "base64");
    await write(`${root}/.source.jpg.edit.json`, "source edits"); await write(`${root}/.dest.jpg.edit.json`, "unrelated edits");
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await context.newPage();
    try {
      await page.goto(`${BASE}/?open=files&path=${encodeURIComponent(root)}`, { waitUntil: "domcontentloaded" });
      const w = page.locator('.fs-window[aria-label="Files"]'); await w.locator(`[data-cwd="${root}"]`).first().waitFor({ timeout: 30_000 });
      const row = w.locator(`[role="option"][data-path="${root}/source.jpg"]`); await row.waitFor({ timeout: 20_000 });
      const rename = async (name: string) => {
        await row.click(); await page.keyboard.press("F2"); const dialog = page.getByTestId("ask-dialog"); await dialog.waitFor();
        await dialog.locator("input").first().fill(name);
        const response = page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.op === "rename");
        await dialog.getByRole("button", { name: "Rename", exact: true }).click(); await dialog.waitFor({ state: "detached" }); return response;
      };
      await test("Files displays the destination-sidecar collision and keeps both the photo and edits intact", cov, async () => {
        const response = await rename("dest.jpg"); assert.equal(response.status(), 400); assert.match((await response.json()).error, /destination sidecar exists/i);
        await page.getByText(/rename:.*destination sidecar exists/i).waitFor({ timeout: 10_000 });
        assert.equal((await node(`${root}/source.jpg`)).content, photo); assert.equal(await node(`${root}/dest.jpg`), undefined);
        assert.equal((await node(`${root}/.source.jpg.edit.json`)).content, "source edits"); assert.equal((await node(`${root}/.dest.jpg.edit.json`)).content, "unrelated edits");
      });
      await test("Files successfully renames a photo and its versioned recipe together", cov, async () => {
        const before = await node(`${root}/source.jpg`), sideBefore = await node(`${root}/.source.jpg.edit.json`);
        await write(`${root}/.source.jpg.edit.json`, "updated edits");
        const response = await rename("renamed.jpg"); assert.equal(response.status(), 200); assert.equal((await response.json()).sidecar, "followed");
        await w.locator(`[role="option"][data-path="${root}/renamed.jpg"]`).waitFor({ timeout: 15_000 });
        const moved = await node(`${root}/renamed.jpg`), movedSide = await node(`${root}/.renamed.jpg.edit.json`);
        assert.equal(moved.id, before.id); assert.equal(moved.content, photo); assert.equal(movedSide.id, sideBefore.id); assert.equal(movedSide.content, "updated edits");
        assert.deepEqual((await db.query("SELECT content FROM vfs_versions WHERE path=$1", [`${root}/.renamed.jpg.edit.json`])).rows, [{ content: "source edits" }]);
        assert.equal(await node(`${root}/source.jpg`), undefined); assert.equal(await node(`${root}/.source.jpg.edit.json`), undefined);
      });
    } finally { await context.close(); }
  } finally { await browser.close(); }
} finally { if (own) await clean(); await db.end(); finish(); }
