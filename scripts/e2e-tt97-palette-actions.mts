/** Real browser/DB checks of explicit palette actions. Use an exclusive disposable server/database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { BrowserContext, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Refusing palette tests without an exclusive disposable database and matching server.");
const BASE = process.env.BASE, key = `tt97${randomBytes(8).toString("hex")}`;
const { test, finish } = makeHarness("e2e-tt97-palette-actions"), cov = { "SR-06": "partial", "PR-02": "partial", "AU-01": "partial", "ST-01": "partial" } as const;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const api = async (method: string, path: string, body?: object) => {
  const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`); return response.json();
};
const startState = await api("GET", "/api/state?id=default"), browser = await launchChromium();
const errors: string[] = [], routineIds: number[] = [];
async function resetDesktop() {
  const state = await api("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(state.row?.revision ?? 1) + 1000, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
async function boot(amnesic = false): Promise<{ context: BrowserContext; page: Page }> {
  await resetDesktop(); const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/${amnesic ? "?amnesia=1" : ""}`, { waitUntil: "domcontentloaded" });
  await page.getByTitle("Command palette (Ctrl+Space)").waitFor({ timeout: 30_000 });
  // The title bar may be server-rendered before the shell binds handlers.
  await page.locator("html[data-focus-mode]").waitFor({ timeout: 30_000 });
  await page.getByTitle("Command palette (Ctrl+Space)").click();
  const palette = page.getByRole("dialog", { name: "Command palette" }); await palette.waitFor();
  await palette.getByRole("button", { name: "actions", exact: true }).click({ timeout: 6_000 });
  return { context, page };
}
const countNote = async (text: string) => Number((await db.query("select count(*)::int as n from notes where body = $1", [text])).rows[0].n);
const query = (page: Page) => page.getByRole("dialog", { name: "Command palette" }).locator("input");
const action = (page: Page, id: string) => page.getByRole("dialog", { name: "Command palette" }).locator(`[data-palette-action="${id}"]`);
try {
  await test("register keeps palette actions partial and discloses native Cast and privacy limits", cov, async () => {
    const row = (await api("GET", "/api/features")).rows.find((item: { code: string }) => item.code === "SR-06");
    assert.ok(row); assert.equal(row.status, "partial"); assert.match(row.nuance, /Google Cast is not implemented/i);
    assert.match(row.nuance, /not sent to the search endpoint/i); assert.match(row.nuance, /not an atomic transaction/i);
  });
  await test("action-mode quick note is inert while typing, stays out of search requests and creates an indexed note only on selection", cov, async () => {
    const { context, page } = await boot(); const text = `${key}-normal`, requests: string[] = [];
    try {
      page.on("request", (r) => { if (r.url().includes("/api/search")) requests.push(r.url()); });
      await query(page).fill(`note ${text}`); await action(page, "note").waitFor(); await page.waitForTimeout(300);
      assert.equal(await countNote(text), 0); assert.ok(!requests.some((url) => decodeURIComponent(url).includes(text)), requests.join("\n"));
      await action(page, "note").click();
      const notes = page.locator('.fs-window[aria-label="Notes"]').last(); await notes.getByLabel("Note body").waitFor({ timeout: 20_000 });
      assert.equal(await notes.getByLabel("Note body").inputValue(), text); assert.equal(await countNote(text), 1);
      const indexed = await db.query("select count(*)::int as n from index_docs where source='note' and body=$1", [text]); assert.equal(indexed.rows[0].n, 1);
    } finally { await context.close(); }
  });
  await test("composition Enter cannot trigger a note action; a subsequent real Enter can", cov, async () => {
    const { context, page } = await boot(); const text = `${key}-ime`;
    try {
      await query(page).fill(`note ${text}`); await action(page, "note").waitFor();
      // Inject composition flags on real DOM events; this is not a physical IME test.
      await query(page).dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 13, bubbles: true });
      await query(page).dispatchEvent("keydown", { key: "Enter", isComposing: false, keyCode: 229, bubbles: true });
      await page.waitForTimeout(250); assert.equal(await countNote(text), 0); assert.equal(await query(page).inputValue(), `note ${text}`);
      await query(page).press("Enter"); await page.locator('.fs-window[aria-label="Notes"]').last().getByLabel("Note body").waitFor();
      assert.equal(await countNote(text), 1);
    } finally { await context.close(); }
  });
  await test("amnesic quick note is refused before any host write", cov, async () => {
    const { context, page } = await boot(true); const text = `${key}-amnesia`, writes: string[] = [];
    try {
      page.on("request", (r) => { if (r.method() === "POST" && r.url().includes("/api/notes")) writes.push(r.url()); });
      await query(page).fill(`note ${text}`); await action(page, "note").click();
      await page.getByTestId("toasts").getByText(/amnesic.*not.*saved/i).waitFor();
      assert.equal(await countNote(text), 0); assert.deepEqual(writes, []);
    } finally { await context.close(); }
  });
  await test("offline quick note remains unsaved and unqueued with its text retained", cov, async () => {
    const { context, page } = await boot(); const text = `${key}-offline`;
    try {
      await context.setOffline(true); await query(page).fill(`note ${text}`); await action(page, "note").click();
      await page.getByTestId("toasts").getByText(/could not confirm/i).waitFor();
      assert.equal(await query(page).inputValue(), `note ${text}`); assert.equal(await countNote(text), 0);
      assert.ok(!(await page.evaluate(() => localStorage.getItem("fusion.queue") ?? "")).includes(text));
    } finally { await context.setOffline(false); await context.close(); }
  });
  await test("repeated activation while a real note response is held creates only one row", cov, async () => {
    const { context, page } = await boot(); const text = `${key}-double`; let posts = 0;
    try {
      await page.route("**/api/notes", async (route) => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        posts += 1; const response = await route.fetch(); await page.waitForTimeout(600); await route.fulfill({ response });
      });
      await query(page).fill(`note ${text}`); await action(page, "note").waitFor();
      await query(page).press("Enter"); await query(page).press("Enter");
      await page.locator('.fs-window[aria-label="Notes"]').last().getByLabel("Note body").waitFor({ timeout: 20_000 });
      assert.equal(posts, 1); assert.equal(await countNote(text), 1);
    } finally { await context.close(); }
  });
  await test("lost reply after a real committed note reports uncertainty and does not automatically retry", cov, async () => {
    const { context, page } = await boot(); const text = `${key}-uncertain`;
    try {
      await page.route("**/api/notes", async (route) => { if (route.request().method() === "POST") { await route.fetch(); await route.abort("failed"); } else await route.continue(); });
      await query(page).fill(`note ${text}`); await action(page, "note").click();
      await page.getByTestId("toasts").getByText(/could not confirm.*may.*created/i).waitFor();
      assert.equal(await countNote(text), 1); await page.waitForTimeout(300); assert.equal(await countNote(text), 1);
      assert.equal(await query(page).inputValue(), `note ${text}`);
    } finally { await context.close(); }
  });
  await test("focus on/off and settings commands operate through the actual shell", cov, async () => {
    const { context, page } = await boot();
    try {
      await query(page).fill("focus on"); await action(page, "focus").click();
      await page.waitForFunction(() => document.documentElement.dataset.focusMode === "on");
      await page.getByTitle("Command palette (Ctrl+Space)").click(); await page.getByRole("dialog", { name: "Command palette" }).getByRole("button", { name: "actions", exact: true }).click();
      await query(page).fill("focus off"); await action(page, "focus").click(); await page.waitForFunction(() => document.documentElement.dataset.focusMode === "off");
      await page.getByTitle("Command palette (Ctrl+Space)").click(); await page.getByRole("dialog", { name: "Command palette" }).getByRole("button", { name: "actions", exact: true }).click();
      await query(page).fill("setting appearance.theme"); await action(page, "setting").click();
      const setting = page.locator('.fs-window[aria-label="Settings"]').last().getByLabel("Search settings"); await setting.waitFor(); assert.equal(await setting.inputValue(), "appearance.theme");
    } finally { await context.close(); }
  });
  await test("only an explicitly selected enabled routine runs and records its execution", cov, async () => {
    const enabled = (await api("POST", "/api/routines", { name: `${key} enabled`, trigger: "manual", actions: [{ cmd: "focusMode", arg: "on" }] })).row;
    const disabled = (await api("POST", "/api/routines", { name: `${key} disabled`, trigger: "manual", actions: [{ cmd: "focusMode", arg: "off" }] })).row;
    routineIds.push(enabled.id, disabled.id); await api("PATCH", "/api/routines", { id: disabled.id, enabled: false });
    const { context, page } = await boot();
    try {
      await query(page).fill(`run ${key}`); await action(page, `routine:${enabled.id}`).waitFor({ timeout: 10_000 });
      assert.equal(await action(page, `routine:${disabled.id}`).count(), 0); assert.equal(await page.locator("html").getAttribute("data-focus-mode"), "off");
      assert.equal((await db.query("select last_run from routines where id=$1", [enabled.id])).rows[0].last_run, null);
      // Focus changes before the asynchronous execution record commits. Bind this assertion to the actual
      // POST response; an absent row/property must not satisfy an optional-chain `!== null` predicate.
      const recorded = page.waitForResponse(r => r.url().endsWith("/api/routines") && r.request().method() === "POST" && r.request().postDataJSON()?.ranId === enabled.id);
      await action(page, `routine:${enabled.id}`).click(); await page.waitForFunction(() => document.documentElement.dataset.focusMode === "on");
      assert.ok((await recorded).ok(), "execution record POST must commit successfully");
      await page.waitForFunction(async (id) => { const res = await fetch('/api/routines'); const data = await res.json(); return typeof data.rows.find((row: { id: number; lastRun: string | null }) => row.id === id)?.lastRun === "string"; }, enabled.id);
      assert.ok((await db.query("select last_run from routines where id=$1", [enabled.id])).rows[0].last_run);
    } finally { await context.close(); }
  });
  await test("a routine disabled after being listed is rechecked and not run", cov, async () => {
    const routine = (await api("POST", "/api/routines", { name: `${key} stale`, trigger: "manual", actions: [{ cmd: "focusMode", arg: "on" }] })).row;
    routineIds.push(routine.id); const { context, page } = await boot();
    try {
      await query(page).fill(`run ${key} stale`); await action(page, `routine:${routine.id}`).waitFor({ timeout: 10_000 });
      await api("PATCH", "/api/routines", { id: routine.id, enabled: false }); await action(page, `routine:${routine.id}`).click();
      await page.getByTestId("toasts").getByText(/no longer available.*nothing was run/i).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-focus-mode"), "off");
      assert.equal((await db.query("select last_run from routines where id=$1", [routine.id])).rows[0].last_run, null);
    } finally { await context.close(); }
  });
  await test("palette action scenarios have no uncaught page errors", cov, () => { assert.deepEqual(errors, []); });
} finally {
  for (const id of routineIds) await api("DELETE", `/api/routines?id=${id}`);
  const rows = await db.query("select id from notes where body like $1", [`${key}%`]);
  for (const row of rows.rows) await api("DELETE", `/api/notes?id=${row.id}`);
  const state = await api("GET", "/api/state?id=default");
  if (startState.row?.state) await api("PUT", "/api/state", { id: "default", revision: Number(state.row?.revision ?? 1) + 1000, state: startState.row.state });
  await browser.close(); await db.end();
}
finish();
