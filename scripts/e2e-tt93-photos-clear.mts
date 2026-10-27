/** Real Photos UI + PostgreSQL purge fault. EXCLUSIVE disposable server/database only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL) throw new Error("Refusing Photos purge-fault tests without TT89_DISPOSABLE_DATABASE=1 and an exclusive matching disposable database/server.");
const BASE = process.env.BASE ?? "http://localhost:3000", id = randomBytes(8).toString("hex"), root = `/Documents/tt93-clear-${id}`, fn = `tt93_clear_${id}`;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const { test, finish } = makeHarness("e2e-tt93-photos-clear"), cov = { "MD-03": "partial" } as const;
const call = async (method: string, path: string, body?: object) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, json: await r.json() };
};
const write = async (path: string, content: string, mime = "text/plain", encoding = "utf8") => {
  const r = await call("POST", "/api/fs", { op: "write", path, content, mime, encoding }); assert.equal(r.status, 200, JSON.stringify(r.json));
};
const node = async (p: string) => (await db.query("SELECT content FROM vfs_nodes WHERE path=$1", [p])).rows[0];
let own = false, trigger = false;
try {
  for (const [table, col] of [["vfs_nodes", "path"], ["vfs_versions", "path"], ["index_docs", "ref"]])
    assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE ${col}=$1 OR left(${col},char_length($1)+1)=$1||'/' LIMIT 1`, [root])).rowCount, 0);
  await write(`${root}/identity.txt`, id); assert.equal((await node(`${root}/identity.txt`))?.content, id, "server/database mismatch"); own = true;
  const photo = readFileSync("/tmp/tt54-photos/o6.jpg").toString("base64");
  const editPath = `${root}/edit.jpg`, ratingPath = `${root}/rating.jpg`, editSide = `${root}/.edit.jpg.edit.json`, ratingSide = `${root}/.rating.jpg.edit.json`;
  await write(editPath, photo, "image/jpeg", "base64"); await write(ratingPath, photo, "image/jpeg", "base64");
  await write(editSide, '{"v":1,"rotate":1}', "application/json"); await write(ratingSide, '{"v":1,"rating":1}', "application/json");
  const state = await call("GET", "/api/state?id=default"), rev = Number(state.json.row?.revision ?? 1) + 1000;
  assert.equal((await call("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } })).status, 200);
  const browser = await launchChromium();
  try {
    const open = async (path: string) => {
      // Each shell writes its windows back to the shared disposable desktop.
      // Reset before every independent tab so a previous editor cannot match.
      const current = await call("GET", "/api/state?id=default"), next = Number(current.json.row?.revision ?? 1) + 1000;
      assert.equal((await call("PUT", "/api/state", { id: "default", revision: next, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } })).status, 200);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); const page = await ctx.newPage();
      await page.goto(`${BASE}/?open=photos&path=${encodeURIComponent(path)}`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("photos-editor").waitFor({ timeout: 30_000 });
      await page.getByRole("button", { name: "Reset", exact: true }).waitFor({ timeout: 30_000 }); return { ctx, page };
    };
    const waitFs = (page: Awaited<ReturnType<typeof open>>["page"], op: string) => page.waitForResponse((r) => r.url().includes("/api/fs") && r.request().method() === "POST" && r.request().postDataJSON()?.op === op);
    const waitPurge = (page: Awaited<ReturnType<typeof open>>["page"]) => waitFs(page, "purge");
    await db.query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('fs.purge','fs.write') AND (NEW.detail='${editSide}' OR NEW.detail='${ratingSide}') THEN RAISE EXCEPTION 'tt93 forced recipe failure'; END IF; RETURN NEW; END $$`);
    await db.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${fn}()`); trigger = true;
    await test("a failed identity-edit purge keeps the recipe and reports failure, not success", cov, async () => {
      const { ctx, page } = await open(editPath);
      try {
        await page.getByRole("button", { name: "Reset", exact: true }).click();
        const response = waitPurge(page); await page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.notEqual((await response).status(), 200);
        assert.equal((await node(editSide)).content, '{"v":1,"rotate":1}');
        await page.getByText(/Save failed:/).waitFor({ timeout: 4000 });
        assert.equal(await page.getByRole("button", { name: "Save edit", exact: true }).isEnabled(), true, "failed edit remains retryable");
      } finally { await ctx.close(); }
    });
    await test("a failed rating-clear purge leaves both the persisted and displayed rating unchanged", cov, async () => {
      const { ctx, page } = await open(ratingPath);
      try {
        const star = page.getByRole("radio", { name: "1 star", exact: true }); assert.equal(await star.getAttribute("aria-checked"), "true");
        const response = waitPurge(page); await star.click(); assert.notEqual((await response).status(), 200);
        assert.equal((await node(ratingSide)).content, '{"v":1,"rating":1}');
        await page.getByText(/Could not save the rating:/).waitFor({ timeout: 4000 }); assert.equal(await star.getAttribute("aria-checked"), "true");
      } finally { await ctx.close(); }
    });
    await test("a failed rating write does not display the uncommitted new rating", cov, async () => {
      const { ctx, page } = await open(ratingPath);
      try {
        const one = page.getByRole("radio", { name: "1 star", exact: true }), two = page.getByRole("radio", { name: "2 stars", exact: true });
        assert.equal(await one.getAttribute("aria-checked"), "true"); const response = waitFs(page, "write"); await two.click();
        assert.notEqual((await response).status(), 200); assert.equal((await node(ratingSide)).content, '{"v":1,"rating":1}');
        await page.getByText(/Could not save the rating:/).waitFor({ timeout: 4000 });
        assert.equal(await one.getAttribute("aria-checked"), "true"); assert.equal(await two.getAttribute("aria-checked"), "false");
      } finally { await ctx.close(); }
    });
    await test("a failed edited-recipe write remains dirty and retryable", cov, async () => {
      const { ctx, page } = await open(editPath);
      try {
        await page.getByRole("button", { name: "Rotate right", exact: true }).click(); const response = waitFs(page, "write");
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.notEqual((await response).status(), 200);
        assert.equal((await node(editSide)).content, '{"v":1,"rotate":1}'); await page.getByText(/Save failed:/).waitFor({ timeout: 4000 });
        assert.equal(await page.getByRole("button", { name: "Save edit", exact: true }).isEnabled(), true);
      } finally { await ctx.close(); }
    });
    await db.query(`DROP TRIGGER ${fn} ON audit_log`); trigger = false; await db.query(`DROP FUNCTION ${fn}()`);
    await test("after the fault is removed, an identity edit clears the recipe", cov, async () => {
      const { ctx, page } = await open(editPath);
      try {
        await page.getByRole("button", { name: "Reset", exact: true }).click(); const response = waitPurge(page);
        await page.getByRole("button", { name: "Save edit", exact: true }).click(); assert.equal((await response).status(), 200);
        await page.getByText(/Saved \(original pixels\)/).waitFor({ timeout: 8000 }); assert.equal(await node(editSide), undefined);
      } finally { await ctx.close(); }
    });
    await test("after the fault is removed, clearing a rating updates the saved recipe and UI", cov, async () => {
      const { ctx, page } = await open(ratingPath);
      try {
        const star = page.getByRole("radio", { name: "1 star", exact: true }); assert.equal(await star.getAttribute("aria-checked"), "true");
        const response = waitPurge(page); await star.click(); assert.equal((await response).status(), 200);
        await page.waitForFunction(() => document.querySelector('[role="radio"][aria-label="1 star"]')?.getAttribute("aria-checked") === "false", null, { timeout: 8000 });
        assert.equal(await node(ratingSide), undefined);
      } finally { await ctx.close(); }
    });
    await test("a blocked rating save excludes overlapping metadata writes and preserves later pixel edits", cov, async () => {
      await write(ratingSide, '{"v":1,"rating":1}', "application/json");
      const { ctx, page } = await open(ratingPath); let transaction = false;
      try {
        const star = page.getByRole("radio", { name: "1 star", exact: true }); assert.equal(await star.getAttribute("aria-checked"), "true");
        await db.query("BEGIN"); transaction = true; await db.query("SELECT pg_advisory_xact_lock(1179997001,1447449413)");
        const response = waitPurge(page); await star.click();
        await page.waitForFunction(() => (document.querySelector('[role="radio"][aria-label="1 star"]') as HTMLButtonElement | null)?.disabled === true, null, { timeout: 8000 });
        assert.equal(await page.getByRole("button", { name: "Favorite", exact: true }).isDisabled(), true);
        let waiting = false;
        for (let i = 0; i < 100 && !waiting; i++) {
          waiting = Boolean((await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=1179997001 AND objid=1447449413 AND NOT granted LIMIT 1")).rowCount);
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(waiting, true, "server never waited on the real PostgreSQL gate");
        await page.getByRole("button", { name: "Rotate right", exact: true }).click();
        assert.equal(await page.getByRole("button", { name: "Save edit", exact: true }).isDisabled(), true);
        await db.query("COMMIT"); transaction = false; assert.equal((await response).status(), 200);
        await page.waitForFunction(() => (document.querySelector('[role="radio"][aria-label="1 star"]') as HTMLButtonElement | null)?.disabled === false, null, { timeout: 8000 });
        assert.equal(await star.getAttribute("aria-checked"), "false"); assert.equal(await node(ratingSide), undefined);
        const writeResponse = waitFs(page, "write"); const save = page.getByRole("button", { name: "Save edit", exact: true });
        assert.equal(await save.isEnabled(), true, "the in-flight pixel change must remain unsaved"); await save.click(); assert.equal((await writeResponse).status(), 200);
        const saved = JSON.parse((await node(ratingSide)).content); assert.equal(saved.rotate, 1); assert.ok(!saved.rating);
      } finally { if (transaction) await db.query("ROLLBACK"); await ctx.close(); }
    });
  } finally { await browser.close(); }
} finally {
  if (trigger) await db.query(`DROP TRIGGER IF EXISTS ${fn} ON audit_log`);
  await db.query(`DROP FUNCTION IF EXISTS ${fn}()`);
  if (own) {
    await db.query("DELETE FROM vfs_versions WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
    await db.query("DELETE FROM vfs_nodes WHERE path=$1 OR left(path,char_length($1)+1)=$1||'/'", [root]);
    await db.query("DELETE FROM index_docs WHERE source='file' AND (ref=$1 OR left(ref,char_length($1)+1)=$1||'/')", [root]);
  }
  await db.end(); finish();
}
