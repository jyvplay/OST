/** Native production ownership attacks. Real PostgreSQL locks delay real
 * requests; no request fulfilment, substituted storage, fake clock, replaced
 * scheduler or injected application state. Run only on an exclusive disposable DB. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { expect } from "playwright/test";
import type { Page, Locator, Request } from "playwright";
import pg from "pg";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt134-ownership");
const RUN = `tt134-${randomBytes(6).toString("hex")}`, own = new Set<number>(), errors: string[] = [];
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
async function create(title: string, body: string) { const row = (await fx.api("POST", "/api/notes", { title, body, tags: "" })).row; own.add(row.id); return row; }
async function module(id: string, fn: (page: Page, win: Locator) => Promise<void>) {
  await fx.windows(id); const ctx = await fx.context(), page = await ctx.newPage(); page.on("pageerror", e => errors.push(e.message));
  try { await fx.ready(page, id); const win = page.locator('[data-win-id="w1"]'); if (id === "notes") await win.getByLabel("Note title", { exact: true }).waitFor(); else await win.getByTestId("writer-body").locator("[data-pid]").first().waitFor(); await fn(page, win); }
  catch (error) {
    mkdirSync("docs/screens/tt134-failures", { recursive: true });
    await page.screenshot({ path: `docs/screens/tt134-failures/${RUN}-${id}.png` }).catch(() => undefined);
    const text = await page.locator("body").innerText().catch(() => "page unavailable");
    writeFileSync(`docs/evidence/${RUN}-${id}-failure.txt`, text.slice(0, 20_000));
    throw error;
  }
  finally { await ctx.close(); }
}
async function choose(win: Locator, title: string) { await win.getByLabel("Notes list").getByRole("button").filter({ hasText: title }).first().click(); await expect(win.getByLabel("Note title", { exact: true })).toHaveValue(title); }
async function orbit(page: Page, win: Locator, title: string, action: string) {
  await win.getByLabel("Notes list").getByRole("button").filter({ hasText: title }).first().click({ button: "right" });
  await page.getByRole("menu", { name: "Orbit actions", exact: true }).getByRole("menuitem", { name: action, exact: true }).click();
}
async function saveLeave(page: Page) { await page.getByTestId("close-confirm-save").click(); await expect(page.getByTestId("close-confirm")).toHaveCount(0); }
const PY = process.env.ORACLE_PY ?? "/home/user/tools/venv/bin/python";
function independentBody(bytes: Buffer) {
  return execFileSync(PY, ["-c", "import io,sys,zipfile,xml.etree.ElementTree as E\nz=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nr=E.fromstring(z.read('word/document.xml'))\nprint(''.join(t.text or '' for t in r.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t')))"] , { input: bytes, encoding: "utf8" }).trimEnd();
}
try {
  const cleanOrbit = await create(`${RUN} clean Orbit`, "unchanged clean body");
  await test("Notes Orbit clean-load attack: Pin, Duplicate and Delete work without a prior editor Save, and do not adopt unrelated revisions", { "NT-08": "partial", "NT-10": "partial" }, () => module("notes", async (page, win) => {
    await choose(win, cleanOrbit.title); await orbit(page, win, cleanOrbit.title, "Pin note");
    await expect(win.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
    const pinned = (await fx.api("GET", `/api/notes?id=${cleanOrbit.id}`)).row;
    assert.equal(pinned.revision, cleanOrbit.revision + 1); assert.equal(pinned.body, cleanOrbit.body);
    const made = page.waitForResponse(r => new URL(r.url()).pathname === "/api/notes" && r.request().method() === "POST"); void made.catch(() => undefined);
    await orbit(page, win, cleanOrbit.title, "Duplicate note"); const reply = await made; assert.equal(reply.status(), 200);
    const copy = (await reply.json()).row; own.add(copy.id); assert.equal(copy.body, pinned.body);
    await expect(win.getByLabel("Note title", { exact: true })).toHaveValue(copy.title);
    await orbit(page, win, copy.title, "Delete note…"); await page.getByTestId("ask-dialog").getByRole("button", { name: "Delete note", exact: true }).click();
    await expect.poll(async () => (await fx.api("GET", "/api/notes")).rows.some((row: any) => row.id === copy.id)).toBe(false);
    assert.equal((await fx.api("GET", `/api/notes?id=${cleanOrbit.id}`)).row.revision, pinned.revision);
  }));
  const pin = await create(`${RUN} pin`, "before pin");
  await test("Notes Orbit Save→Pin uses its own acknowledged new revision, retains edited text and performs exactly two commits", { "NT-08": "partial", "NT-10": "partial" }, () => module("notes", async (page, win) => {
    await choose(win, pin.title); await win.getByLabel("Note body").fill("edited before pin μ 🧭");
    await orbit(page, win, pin.title, "Pin note"); await saveLeave(page);
    await expect(win.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
    const saved = (await fx.api("GET", `/api/notes?id=${pin.id}`)).row;
    assert.equal(saved.body, "edited before pin μ 🧭"); assert.equal(saved.pinned, true); assert.equal(saved.revision, pin.revision + 2);
    await expect(win.getByLabel("Note body")).toHaveValue(saved.body); await expect(win.getByRole("alert")).toHaveCount(0);
    await orbit(page, win, pin.title, "Unpin note"); await expect(win.getByRole("button", { name: "Pin", exact: true })).toBeVisible();
    const clean = (await fx.api("GET", `/api/notes?id=${pin.id}`)).row; assert.equal(clean.revision, saved.revision + 1); assert.equal(clean.pinned, false); assert.equal(clean.body, saved.body);
  }));
  const prefix = RUN + "x".repeat(494 - RUN.length), title = prefix + "🧭" + "y".repeat(4);
  const duplicate = await create(title, "before duplicate");
  await test("Notes Orbit Save→Duplicate copies the newly saved body and a 500-code-unit Unicode title without splitting its last surrogate pair", { "NT-08": "partial", "NT-13": "partial" }, () => module("notes", async (page, win) => {
    await choose(win, duplicate.title); await win.getByLabel("Note body").fill("newly saved duplicate μ 🧭");
    const made = page.waitForResponse(r => new URL(r.url()).pathname === "/api/notes" && r.request().method() === "POST"); void made.catch(() => undefined);
    await orbit(page, win, duplicate.title, "Duplicate note"); await saveLeave(page);
    const response = await made; assert.equal(response.status(), 200); const copy = (await response.json()).row; own.add(copy.id);
    assert.equal(copy.title, prefix + " copy"); assert.equal(copy.body, "newly saved duplicate μ 🧭"); assert.notEqual(copy.id, duplicate.id);
    await expect(win.getByLabel("Note title")).toHaveValue(copy.title); await expect(win.getByLabel("Note body")).toHaveValue(copy.body);
    assert.equal((await fx.api("GET", `/api/notes?id=${duplicate.id}`)).row.body, copy.body);
  }));
  const deletion = await create(`${RUN} delete`, "before delete");
  await test("Notes Orbit Save→Delete: Cancel keeps the just-saved record, a genuine writer during confirmation is not adopted as delete consent, and a later confirmed delete succeeds", { "NT-08": "partial", "NT-10": "partial" }, () => module("notes", async (page, win) => {
    await choose(win, deletion.title); await win.getByLabel("Note body").fill("saved before cancelled delete");
    await orbit(page, win, deletion.title, "Delete note…"); await saveLeave(page);
    await page.getByTestId("ask-dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    let row = (await fx.api("GET", `/api/notes?id=${deletion.id}`)).row; assert.equal(row.body, "saved before cancelled delete");
    await win.getByLabel("Note body").fill("saved before stale delete"); await orbit(page, win, deletion.title, "Delete note…"); await saveLeave(page);
    const ask = page.getByTestId("ask-dialog"); await ask.getByRole("button", { name: "Delete note", exact: true }).waitFor();
    row = (await fx.api("GET", `/api/notes?id=${deletion.id}`)).row;
    await fx.api("PUT", "/api/notes", { id: row.id, expectedRevision: row.revision, body: "independent winner during confirmation" });
    await ask.getByRole("button", { name: "Delete note", exact: true }).click();
    await expect(win.getByRole("alert")).toContainText(/changed|conflict/i);
    assert.equal((await fx.api("GET", `/api/notes?id=${deletion.id}`)).row.body, "independent winner during confirmation");
    await win.getByRole("button", { name: "Refresh notes", exact: true }).click(); await expect(win.getByLabel("Note body")).toHaveValue("independent winner during confirmation");
    await win.getByLabel("Note body").fill("explicitly save then delete"); await orbit(page, win, deletion.title, "Delete note…"); await saveLeave(page);
    await page.getByTestId("ask-dialog").getByRole("button", { name: "Delete note", exact: true }).click();
    await expect.poll(async () => (await fx.api("GET", "/api/notes")).rows.some((r: any) => r.id === deletion.id)).toBe(false);
  }));
  await test("Native Writer: a real blocked recovery write exceeds the four-second close timeout; Cancel/edit/unlock cannot late-close the window or lose the newer recovery bytes", { "FF-15": "partial" }, () => module("writer", async (page, win) => {
    const lock = await pool.connect(); let inTx = false, completed = false; const writes: { path: string; request: Request; draft: any }[] = [], recoveryIo: string[] = [];
    const observe = (request: Request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/api/fs") return;
      try {
        const body = request.postDataJSON();
        if (typeof body.path === "string" && body.path.startsWith("/System/Recovery")) recoveryIo.push(`${body.op} ${body.path}`);
        if (body.op === "write" && /^\/System\/Recovery\/writer_untitled-[a-z0-9-]+\.draft$/.test(body.path)) writes.push({ path: body.path, request, draft: JSON.parse(body.content) });
      } catch { /* unrelated non-JSON request */ }
    };
    page.on("request", observe);
    try {
      const body = win.getByTestId("writer-body"); await body.locator("[data-pid]").first().click();
      await lock.query("BEGIN"); inTx = true; await lock.query("LOCK TABLE vfs_nodes IN SHARE MODE");
      await page.keyboard.press("Control+a"); await page.keyboard.type("FIRST_BLOCKED_RECOVERY");
      await expect(body.locator("[data-pid]").first()).toHaveText("FIRST_BLOCKED_RECOVERY");
      await expect(body.locator("[data-pid]")).toHaveCount(1); // no deleted demo/table paragraphs may remain in the live DOM
      await win.getByRole("button", { name: "Close window", exact: true }).click();
      const start = performance.now(); await page.getByTestId("close-confirm-discard").click();
      await expect.poll(async () => Number((await pool.query("select count(*) from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%vfs_nodes%'")).rows[0].count), { timeout: 3000 }).toBeGreaterThan(0);
      await expect(page.getByTestId("close-confirm-error")).toContainText(/Recovery failed|timed out/i, { timeout: 8000 });
      assert.ok(performance.now() - start >= 3800, "must observe the real close timeout, not an immediate unrelated failure");
      assert.ok(recoveryIo.length > 0, "the observed real lock must belong to this page's recovery I/O");
      await page.getByTestId("close-confirm-cancel").click();
      await body.locator("[data-pid]").first().click(); await page.keyboard.press("Control+End");
      const readCaret = () => body.evaluate(el => {
        const sel = window.getSelection(), focus = sel?.focusNode; let prefix: string | null = null;
        if (focus && el.contains(focus)) { const r = document.createRange(); r.selectNodeContents(el); r.setEnd(focus, sel!.focusOffset); prefix = r.toString(); }
        return { active: document.activeElement?.getAttribute("data-testid"), prefix, offset: sel?.focusOffset, parent: focus?.parentElement?.outerHTML, html: el.innerHTML };
      });
      const beforeTyping = await readCaret();
      await page.keyboard.type(" SECOND_AFTER_TIMEOUT");
      writeFileSync("docs/evidence/tt134-native-writer-caret-diagnostic.json", JSON.stringify({ beforeTyping, afterTyping: await readCaret() }, null, 2) + "\n");
      await lock.query("COMMIT"); inTx = false;
      await expect.poll(() => writes.length, { timeout: 12000 }).toBeGreaterThanOrEqual(2);
      assert.equal(independentBody(Buffer.from(writes[0].draft.payload, "base64")), "FIRST_BLOCKED_RECOVERY", "first actual write must retain the pre-timeout capture");
      for (const write of writes) { const response = await write.request.response(); assert.ok(response); assert.equal(response.status(), 200); await response.finished(); }
      const final = (await fx.api("GET", `/api/fs?op=read&path=${encodeURIComponent(writes[0].path)}`)).node;
      const draft = JSON.parse(final.content); assert.equal(draft.encoding, "base64");
      assert.equal(independentBody(Buffer.from(draft.payload, "base64")), "FIRST_BLOCKED_RECOVERY SECOND_AFTER_TIMEOUT");
      await expect(win).toBeVisible(); await expect(body).toContainText("FIRST_BLOCKED_RECOVERY SECOND_AFTER_TIMEOUT");
      console.log(`  real lock/close timeout observed in ${Math.round(performance.now() - start)} ms; ${writes.length} acknowledged native recovery writes; independent ZIP/XML reader retained newer text`);
      completed = true;
    } finally {
      if (inTx) await lock.query("ROLLBACK"); lock.release(); page.off("request", observe);
      // Unknown write outcomes retain their own fixture rather than deleting
      // something that an outstanding real request might recreate afterward.
      if (completed) for (const path of new Set(writes.map(w => w.path))) {
        await fx.api("POST", "/api/fs", { op: "trash", path }); await fx.api("POST", "/api/fs", { op: "purge", path });
      }
    }
  }));
  await test("No uncaught browser exceptions during native note/Writer ownership checks", {}, () => assert.deepEqual(errors, []));
} finally {
  for (const id of own) await fx.api("DELETE", `/api/notes?id=${id}`).catch(() => undefined);
  await pool.end(); await fx.close(); finish();
}
