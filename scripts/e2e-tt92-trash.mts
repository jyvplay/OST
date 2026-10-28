/** Real Chromium + HTTP/PostgreSQL Trash metadata and restore UI; exclusive disposable environment only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing trash UI tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt92-ui-trash-${id}`, a = `${root}/a.txt`, b = `${root}/nested/b.txt`;
const { test, finish } = makeHarness("e2e-tt92-trash"), cov = { "FM-11": "partial", "SR-01": "partial" } as const;
const call = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, json: await r.json() as any }; };
const post = async (body: object) => { const r = await call("POST", "/api/fs", body); assert.equal(r.status, 200, JSON.stringify(r.json)); };
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const scope = (col: string) => `(${col}=$1 OR left(${col},char_length($1)+1)=$1||'/')`;
const old = await call("GET", "/api/state?id=default"), settings = await call("GET", "/api/settings");
const view = settings.json.rows?.find((x: { key: string }) => x.key === "appearance.desktopView")?.value;
let own = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]]) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${scope(col)} LIMIT 1`, [root])).rowCount, 0);
  own = true; await post({ op: "write", path: a, content: "hello" }); await post({ op: "write", path: b, content: "world!!!" });
  assert.equal((await db.query("SELECT content FROM vfs_nodes WHERE path=$1", [a])).rows[0]?.content, "hello", "server/database mismatch");
  await post({ op: "trash", path: root });
  if (view && view !== "classic") await call("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
  const current = await call("GET", "/api/state?id=default"), rev = Number(current.json.row?.revision ?? 1) + 1000;
  const win = { id: `tt92-${id}`, module: "files", title: "Files", x: 40, y: 40, w: 1180, h: 700, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: { path: "/Documents", trash: true } };
  assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [win], focus: win.id, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } })).status, 200);
  const browser = await launchChromium(), ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage(); await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const files = page.getByRole("dialog", { name: "Files", exact: true }).last(); await files.waitFor({ timeout: 40000 });
    const row = files.locator(`[role="option"][data-path="${root}"]`); await row.waitFor({ timeout: 40000 });
    await test("Trash exposes origin, recorded deletion date, real folder bytes and its manual-retention/backup boundary", cov, async () => {
      assert.match(await files.getByTestId("trash-retention").innerText(), /until restored or permanently deleted.*backups do not include Trash.*does not erase/s);
      assert.match(await row.innerText(), /— \/Documents/); assert.equal(await row.locator("[data-size]").getAttribute("data-size"), "13");
      assert.match(await row.locator("[data-size]").getAttribute("title") ?? "", /2 file\(s\).*1 folder\(s\)/);
      assert.equal(await row.locator('[title^="Recorded when moved to Trash"]').count(), 1);
      await files.getByRole("button", { name: /Trashed/ }).waitFor();
    });
    await test("restoring the selected folder in Files reveals the original files and rebuilds search", cov, async () => {
      await row.click(); await files.getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: "Restore", exact: true }).click();
      await row.waitFor({ state: "detached", timeout: 15000 });
      const nodes = (await db.query("SELECT path,trashed FROM vfs_nodes WHERE path=ANY($1::text[]) ORDER BY path", [[a, b]])).rows;
      assert.equal(nodes.length, 2); assert.ok(nodes.every((n: { trashed: boolean }) => !n.trashed));
      const idx = (await db.query("SELECT ref,body FROM index_docs WHERE source='file' AND ref=ANY($1::text[]) ORDER BY ref", [[a, b]])).rows;
      assert.deepEqual(idx, [{ ref: a, body: "hello" }, { ref: b, body: "world!!!" }]);
    });
  } finally { await ctx.close(); await browser.close(); }
} finally {
  if (own) { await call("POST", "/api/fs", { op: "purge", path: root }).catch(() => undefined);
    await db.query(`DELETE FROM vfs_versions WHERE ${scope("path")}`, [root]); await db.query(`DELETE FROM vfs_nodes WHERE ${scope("path")}`, [root]); await db.query(`DELETE FROM index_docs WHERE source='file' AND ${scope("ref")}`, [root]); }
  const current = await call("GET", "/api/state?id=default").catch(() => null);
  if (current && old.json.row?.state) await call("PUT", "/api/state", { id: "default", revision: Number(current.json.row?.revision ?? 0) + 1000, state: old.json.row.state }).catch(() => undefined);
  if (view && view !== "classic") await call("PUT", "/api/settings", { key: "appearance.desktopView", value: view }).catch(() => undefined);
  await db.end();
}
finish();
