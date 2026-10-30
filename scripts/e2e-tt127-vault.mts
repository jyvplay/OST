/** Two real Chromium contexts against an exclusive disposable PostgreSQL server. */
import assert from "node:assert/strict";
import pg from "pg";
import { randomBytes } from "node:crypto";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable database and matching server required");
const base = process.env.BASE, path = "/System/vault.fvault";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("e2e-tt127-vault");
const browser = await launchChromium();
const read = async () => fetch(`${base}/api/fs?op=read&path=${encodeURIComponent(path)}`);
async function call(method: string, url: string, body?: unknown) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return r.json();
}
async function page(origin = base) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await context.newPage(); p.setDefaultTimeout(20000);
  await p.goto(origin, { waitUntil: "domcontentloaded" }); await p.waitForSelector('[data-win-id="w1"]');
  await p.getByLabel("Passphrase").waitFor(); return { context, p };
}
async function ready() {
  const cur = await call("GET", "/api/state?id=default");
  await call("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "vault", title: "vault", x: 20, y: 16, w: 1000, h: 800, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
}
async function add(p: import("playwright").Page, title: string) {
  await p.getByRole("button", { name: "Add item" }).click(); await p.getByLabel("Title", { exact: true }).fill(title);
  await p.getByLabel("Username", { exact: true }).fill("tester"); await p.getByLabel("Secret", { exact: true }).fill(`secret-${title}`);
  await p.getByRole("button", { name: "Add", exact: true }).click();
}
const nonce = randomBytes(12).toString("hex"), probe = `/System/tt127-db-probe-${nonce}`;
let ownVault = false;
try {
  if ((await read()).status !== 404 || (await db.query("SELECT 1 FROM vfs_nodes WHERE path=$1", [path])).rowCount) throw new Error("Refusing: vault path already occupied");
  // Prove HTTP and DATABASE_URL point to the same disposable database before cleanup.
  await call("POST", "/api/fs", { op: "writeIfUnchanged", path: probe, content: nonce, expected: null });
  assert.equal((await db.query("SELECT content FROM vfs_nodes WHERE path=$1", [probe])).rows[0]?.content, nonce);
  await db.query("DELETE FROM vfs_nodes WHERE path=$1", [probe]); await db.query("DELETE FROM index_docs WHERE source='file' AND ref=$1", [probe]);
  await ready();
  await test("simultaneous create: one wins, the other must recheck before continuing", {}, async () => {
    const a = await page(), b = await page();
    try {
      await a.p.getByLabel("Passphrase").fill("tt127-passphrase"); await b.p.getByLabel("Passphrase").fill("tt127-passphrase");
      await Promise.all([a.p.getByRole("button", { name: "Create", exact: true }).click(), b.p.getByRole("button", { name: "Create", exact: true }).click()]);
      await Promise.all([a.p.waitForFunction(() => document.body.textContent?.includes("Add item") || document.body.textContent?.includes("Creation was not confirmed")), b.p.waitForFunction(() => document.body.textContent?.includes("Add item") || document.body.textContent?.includes("Creation was not confirmed"))]);
      const winners = await Promise.all([a.p.getByRole("button", { name: "Add item" }).count(), b.p.getByRole("button", { name: "Add item" }).count()]);
      assert.equal(winners[0] + winners[1], 1); assert.equal((await read()).status, 200); ownVault = true;
    } finally { await a.context.close(); await b.context.close(); }
  });
  await test("stale unlocked tab refuses to overwrite the newer saved item", {}, async () => {
    if (!ownVault) throw new Error("Create did not complete; refusing test");
    const a = await page(), b = await page();
    try {
      for (const p of [a.p, b.p]) { await p.getByLabel("Passphrase").fill("tt127-passphrase"); await p.getByRole("button", { name: "Unlock", exact: true }).click(); await p.getByRole("button", { name: "Add item" }).waitFor(); }
      await add(a.p, "First 127"); await a.p.getByText("First 127", { exact: true }).waitFor();
      await add(b.p, "Second 127"); await b.p.getByText(/Vault changed elsewhere/).waitFor();
      await b.p.getByRole("button", { name: "Retry" }).click(); await b.p.getByRole("button", { name: "Unlock", exact: true }).waitFor();
      await b.p.getByLabel("Passphrase").fill("tt127-passphrase"); await b.p.getByRole("button", { name: "Unlock", exact: true }).click();
      await b.p.getByText("First 127", { exact: true }).waitFor(); assert.equal(await b.p.getByText("Second 127", { exact: true }).count(), 0);
    } finally { await a.context.close(); await b.context.close(); }
  });
  await test("a dropped write response reports uncertainty and reopening finds committed data", {}, async () => {
    if (!ownVault) throw new Error("Create did not complete; refusing test");
    let dropWrite = false, dropped = false;
    const a = await page();
    await a.p.route("**/api/fs", async (route) => {
      const req = route.request();
      const payload = req.method() === "POST" ? req.postData() ?? "" : "";
      if (dropWrite && !dropped && payload.includes('"writeIfUnchanged"')) {
        const response = await route.fetch(); // the real server and DB process the write
        if (response.status() === 200) { dropped = true; await route.abort("failed"); return; }
        await route.fulfill({ response }); return;
      }
      await route.continue();
    });
    try {
      await a.p.getByLabel("Passphrase").fill("tt127-passphrase"); await a.p.getByRole("button", { name: "Unlock", exact: true }).click();
      await a.p.getByRole("button", { name: "Add item" }).waitFor(); dropWrite = true;
      await add(a.p, "Committed 127"); await a.p.getByText(/Save not confirmed/).waitFor(); assert.equal(dropped, true);
      await a.p.getByRole("button", { name: "Retry" }).click(); await a.p.getByRole("button", { name: "Unlock", exact: true }).waitFor();
      await a.p.getByLabel("Passphrase").fill("tt127-passphrase"); await a.p.getByRole("button", { name: "Unlock", exact: true }).click();
      await a.p.getByText("Committed 127", { exact: true }).waitFor();
    } finally { await a.context.close(); }
  });
} finally {
  await browser.close();
  if (ownVault) { await call("POST", "/api/fs", { op: "trash", path }); await call("POST", "/api/fs", { op: "purge", path }); }
  await db.end(); finish();
}
