/** Real Chromium + VFS. Delayed frame callbacks are scheduling fault
 * injection, not a mocked editor or storage server. Run only against an
 * exclusive disposable database/server. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE, path = `/Documents/tt128-editor-${randomBytes(8).toString("hex")}.txt`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const browser = await launchChromium(); const { test, finish } = makeHarness("e2e-tt128-editor");
async function api(method: string, endpoint: string, body?: unknown) {
  const r = await fetch(BASE + endpoint, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) throw new Error(`${method} ${endpoint}: ${r.status} ${await r.text()}`); return await r.json();
}
let owned = false, originalState: unknown, changed = false;
try {
  if ((await db.query("SELECT 1 FROM vfs_nodes WHERE path=$1", [path])).rowCount) throw new Error("Refusing pre-existing fixture");
  const made = await api("POST", "/api/fs", { op: "writeIfUnchanged", path, content: "hello world", expected: null, reason: "e2e-tt128-editor" });
  const row = await db.query("SELECT id,sha256 FROM vfs_nodes WHERE path=$1", [path]);
  assert.equal(row.rowCount, 1, "server and database must match");
  assert.equal(row.rows[0].id, made.id); assert.equal(row.rows[0].sha256, made.sha256); owned = true;
  const state = await api("GET", "/api/state?id=default"); originalState = state.row?.state;
  await api("PUT", "/api/state", { id: "default", revision: Number(state.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "editor", title: "Editor", x: 20, y: 16, w: 1200, h: 850, z: 10, workspace: 1, props: { path } }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } }); changed = true;
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, serviceWorkers: "block" });
  try {
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    const ta = page.locator('[data-win-id="w1"] textarea').first();
    await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement | null)?.value === "hello world");
    await test("a delayed selection restore cannot undo a newer caret position or erase later text", { "ED-09": "partial", "ED-10": "partial" }, async () => {
      // Perturb real browser frame scheduling long enough to interleave a later
      // selection. Restore the native API before leaving this test.
      await page.evaluate(() => {
        const w = window as Window & { __tt128OriginalRaf?: typeof requestAnimationFrame };
        w.__tt128OriginalRaf = w.requestAnimationFrame;
        const original = w.requestAnimationFrame.bind(w);
        w.requestAnimationFrame = (cb) => original((ts) => { setTimeout(() => cb(ts), 300); });
      });
      try {
        await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, el.value.length); });
        await page.getByTestId("editor-case-upper").click();
        await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement | null)?.value === "HELLO WORLD");
        await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, 0); });
        await page.waitForTimeout(450); // let deliberately delayed frame callbacks run
        const selection = await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
        assert.deepEqual(selection, [0, 0], "the newer caret must not be replaced by an older selection");
        await page.getByTestId("editor-stamp").click();
        const stamped = await ta.inputValue();
        assert.match(stamped.slice(0, 16), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
        assert.equal(stamped.slice(16), "HELLO WORLD");
      } finally {
        await page.evaluate(() => { const w = window as Window & { __tt128OriginalRaf?: typeof requestAnimationFrame }; if (w.__tt128OriginalRaf) w.requestAnimationFrame = w.__tt128OriginalRaf; delete w.__tt128OriginalRaf; });
      }
    });
    await test("case expansion preserves the whole transformed selection", { "ED-09": "partial" }, async () => {
      await ta.fill("straße");
      await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, el.value.length); });
      await page.getByTestId("editor-case-upper").click();
      await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement | null)?.value === "STRASSE");
      const selection = await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
      assert.deepEqual(selection, [0, 7]);
      await page.getByTestId("editor-case-lower").click();
      assert.equal(await ta.inputValue(), "strasse");
    });
    await test("indent, dedent, and unchanged edits keep the affected selection", { "ED-08": "partial", "ED-09": "partial" }, async () => {
      await ta.fill("one\ntwo");
      await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(0, el.value.length); });
      await page.getByTestId("editor-indent").click();
      assert.equal(await ta.inputValue(), "  one\n  two");
      assert.deepEqual(await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]), [0, 11]);
      await page.getByTestId("editor-dedent").click();
      assert.equal(await ta.inputValue(), "one\ntwo");
      assert.deepEqual(await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]), [0, 7]);
      await page.getByTestId("editor-dedent").click(); // no-op: no text commit will run an effect
      assert.equal(await ta.inputValue(), "one\ntwo");
      assert.deepEqual(await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, document.activeElement === el]), [0, 7, true]);
      await ta.fill("HELLO");
      await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(1, 4); });
      await page.getByTestId("editor-case-upper").click(); // another no-op
      assert.deepEqual(await ta.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, document.activeElement === el]), [1, 4, true]);
    });
    await test("timestamp replaces only the selected span", { "ED-10": "partial" }, async () => {
      await ta.fill("prefix middle suffix");
      await ta.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(7, 13); });
      await page.getByTestId("editor-stamp").click();
      const value = await ta.inputValue();
      assert.equal(value.slice(0, 7), "prefix ");
      assert.match(value.slice(7, 23), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      assert.equal(value.slice(23), " suffix");
    });
  } finally { await context.close(); }
} finally {
  await browser.close();
  if (owned) {
    await api("POST", "/api/fs", { op: "trash", path }); await api("POST", "/api/fs", { op: "purge", path });
    await db.query("DELETE FROM file_ops WHERE src=$1 OR dst=$1", [path]);
    await db.query("DELETE FROM audit_log WHERE detail=$1", [path]);
  }
  if (changed && originalState) {
    const current = await api("GET", "/api/state?id=default");
    await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 1) + 1000, state: originalState });
  }
  await db.end(); finish();
}
