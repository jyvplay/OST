/** Real Chromium confirmation plus HTTP/PostgreSQL; fixtures require an exclusive disposable database/server. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing deletion UI tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3999", id = randomBytes(8).toString("hex");
const root = `/Documents/tt91-ui-${id}`, target = `${root}/target`, item = `${target}/nested/secret.txt`, neighbor = `${root}/keep.txt`;
const { test, finish } = makeHarness("e2e-tt91-purge");
const cov = { "FM-11": "partial" } as const;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json() as any };
};
const post = async (body: object) => { const r = await call("POST", "/api/fs", body); assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const matches = (column: string) => `(${column}=$1 OR left(${column},char_length($1)+1)=$1||'/')`;
const counts = async (p: string) => ({
  nodes: (await db.query(`SELECT count(*)::int n FROM vfs_nodes WHERE ${matches("path")}`, [p])).rows[0].n,
  versions: (await db.query(`SELECT count(*)::int n FROM vfs_versions WHERE ${matches("path")}`, [p])).rows[0].n,
  index: (await db.query(`SELECT count(*)::int n FROM index_docs WHERE source='file' AND ${matches("ref")}`, [p])).rows[0].n,
});
const old = await call("GET", "/api/state?id=default");
let own = false;
try {
  assert.deepEqual(await counts(root), { nodes: 0, versions: 0, index: 0 });
  assert.equal((await db.query(`SELECT count(*)::int n FROM index_docs WHERE ${matches("ref")}`, [root])).rows[0].n, 0); own = true;
  await post({ op: "write", path: item, content: "old secret" }); await post({ op: "write", path: item, content: "new secret" });
  await post({ op: "write", path: neighbor, content: "keep old" }); await post({ op: "write", path: neighbor, content: "keep new" });
  assert.deepEqual(await counts(target), { nodes: 3, versions: 1, index: 1 });
  const current = await call("GET", "/api/state?id=default"), rev = Number(current.json.row?.revision ?? 1) + 1000;
  assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } })).status, 200);
  const browser = await launchChromium(), ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage(); await page.goto(`${BASE}/?open=files&path=${encodeURIComponent(root)}`, { waitUntil: "domcontentloaded" });
    const files = page.getByRole("dialog", { name: "Files", exact: true }).last();
    await files.locator(`[data-cwd="${root}"]`).first().waitFor({ timeout: 40000 });
    const row = files.locator(`[role="option"][data-path="${target}"]`); await row.waitFor();
    const open = async () => { await row.click(); await page.keyboard.press("Shift+Delete"); await page.getByTestId("ask-dialog").waitFor({ timeout: 10000 }); };
    await test("confirmation states retention limits, rejects wrong text and cancellation leaves every row intact", cov, async () => {
      await open(); const dialog = page.getByTestId("ask-dialog");
      assert.match(await dialog.innerText(), /saved versions and search entries.*Backups.*not secure erasure/s);
      await dialog.locator("input").fill("erase"); await dialog.getByTestId("ask-ok").click();
      await dialog.getByTestId("ask-error").getByText(/Type delete to confirm/).waitFor();
      await dialog.getByTestId("ask-cancel").click(); await dialog.waitFor({ state: "detached" });
      assert.deepEqual(await counts(target), { nodes: 3, versions: 1, index: 1 });
    });
    await test("confirming permanent folder deletion removes live/history/index rows and preserves an unrelated file", cov, async () => {
      await open(); const dialog = page.getByTestId("ask-dialog");
      await dialog.locator("input").fill("delete"); await dialog.getByTestId("ask-ok").click(); await dialog.waitFor({ state: "detached" });
      await row.waitFor({ state: "detached", timeout: 15000 });
      assert.deepEqual(await counts(target), { nodes: 0, versions: 0, index: 0 });
      assert.deepEqual(await counts(neighbor), { nodes: 1, versions: 1, index: 1 });
    });
  } finally { await ctx.close(); await browser.close(); }
} finally {
  if (own) {
    await call("POST", "/api/fs", { op: "purge", path: root }).catch(() => undefined);
    await db.query(`DELETE FROM vfs_versions WHERE ${matches("path")}`, [root]);
    await db.query(`DELETE FROM vfs_nodes WHERE ${matches("path")}`, [root]);
    await db.query(`DELETE FROM index_docs WHERE ${matches("ref")}`, [root]);
  }
  const current = await call("GET", "/api/state?id=default").catch(() => null);
  if (current && old.json.row?.state) await call("PUT", "/api/state", { id: "default", revision: Number(current.json.row?.revision ?? 0) + 1000, state: old.json.row.state }).catch(() => undefined);
  await db.end();
}
finish();
