/** Native production boundary attacks. Quota is genuinely exhausted in Chrome
 * sessionStorage; no Storage.prototype override, fake clock or intercepted API.
 * Other fixtures are real browser-local data and native file inputs. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { expect } from "playwright/test";
import type { Locator, Page } from "playwright";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
import { RECENT_SEARCHES_KEY } from "../src/lib/recent-searches.ts";
import { SAVED_SEARCH_KEY } from "../src/lib/saved-searches.ts";
import { EMPTY_SEARCH } from "../src/lib/search-query.ts";
import { noteDraftKey } from "../src/lib/note-drafts.ts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt133-boundaries");
const RUN = `tt133-boundary-${Date.now().toString(36)}`, owned = new Set<number>(), errors: string[] = [];
async function module(id: string, fn: (page: Page, win: Locator) => Promise<void>, init?: (page: Page) => Promise<void>) {
  await fx.windows(id); const context = await fx.context(), page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
  try { if (init) { await page.goto(`${fx.BASE}/api/state?id=default`); await init(page); } await fx.ready(page, id); await winReady(page, id); await fn(page, page.locator('[data-win-id="w1"]')); }
  finally { await context.close(); }
}
async function winReady(page: Page, id: string) { await page.locator('[data-win-id="w1"]').getByLabel(id === "notes" ? "Note title" : "Search query", { exact: true }).waitFor(); }
async function create(body = "saved original") { const row = (await fx.api("POST", "/api/notes", { title: `${RUN}-${owned.size}`, body, tags: "" })).row; owned.add(row.id); return row; }
async function choose(win: Locator, title: string) { await win.getByLabel("Notes list").getByRole("button").filter({ hasText: title }).first().click(); await expect(win.getByLabel("Note title", { exact: true })).toHaveValue(title); }
async function exhaust(page: Page) {
  const result = await page.evaluate(prefix => {
    let count = 0; const refusals: string[] = [];
    // Fill the remainder too: one failed 256 KiB write may leave enough room
    // for an ordinary draft, which would not actually test quota failure.
    for (const chars of [131_072, 8192, 512, 32, 1]) for (let n = 0; n < 2000; n++) {
      try { sessionStorage.setItem(`${prefix}-${count}`, "x".repeat(chars)); count++; }
      catch (error) { refusals.push((error as DOMException).name); break; }
    }
    return { count, refusals };
  }, RUN);
  assert.ok(result.count > 0); assert.deepEqual(result.refusals, Array(5).fill("QuotaExceededError")); console.log(`  actual native sessionStorage quota: ${result.count} real writes then ${result.refusals.length} quota refusals`);
}
async function more(win: Locator) { const details = win.getByTestId("note-editor").locator("details").first(); if (await details.getAttribute("open") === null) await details.locator("summary").click(); }
async function confirm(page: Page, label: string) { const dialog = page.getByTestId("ask-dialog"); await dialog.getByRole("button", { name: label, exact: true }).click(); await expect(dialog).toHaveCount(0); }
try {
  const save = await create();
  await test("Real quota: failed Don't save retains modal and dirty text; native modal shortcuts cannot save behind it; Cancel/export/Save still work", { "NT-08": "full", "NT-09": "full", "NT-18": "partial" }, () => module("notes", async (page, win) => {
    await choose(win, save.title); await exhaust(page); const body = "Quota must not destroy this μ 🧭 text";
    await win.getByLabel("Note body").fill(body); await expect(win.getByRole("status").filter({ hasText: "Draft recovery unavailable" })).toBeVisible();
    await win.getByRole("button", { name: "Close window", exact: true }).click();
    await page.getByTestId("close-confirm-discard").click(); await expect(page.getByTestId("close-confirm-error")).toContainText("Recovery failed");
    await expect(win).toBeVisible(); await expect(win.getByLabel("Note body")).toHaveValue(body);
    await page.keyboard.press("Control+s"); await page.keyboard.press("Alt+F4");
    assert.equal((await fx.api("GET", `/api/notes?id=${save.id}`)).row.body, "saved original"); await expect(page.getByTestId("close-confirm")).toBeVisible();
    await page.getByTestId("close-confirm-cancel").click(); await more(win);
    const download = page.waitForEvent("download"); await win.getByRole("button", { name: "Download .md", exact: true }).click();
    assert.ok(readFileSync((await (await download).path())!, "utf8").includes(body));
    await win.getByRole("button", { name: "Close window", exact: true }).click(); await page.getByTestId("close-confirm-save").click();
    await expect(win).toHaveCount(0); assert.equal((await fx.api("GET", `/api/notes?id=${save.id}`)).row.body, body);
  }));
  const discard = await create();
  await test("Real quota: explicit Discard edits is separately confirmed, preserves the saved note and cannot resurrect a delayed recovery draft", { "NT-08": "full", "NT-09": "full" }, () => module("notes", async (page, win) => {
    await choose(win, discard.title); await exhaust(page); await win.getByLabel("Note body").fill("discard only with my confirmation");
    await expect(win.getByRole("status").filter({ hasText: "Draft recovery unavailable" })).toBeVisible();
    await win.getByRole("button", { name: "Close window", exact: true }).click(); await page.getByTestId("close-confirm-discard").click(); await expect(page.getByTestId("close-confirm-error")).toContainText("Recovery failed");
    await page.getByTestId("close-confirm-cancel").click(); await more(win); await win.getByRole("button", { name: "Discard edits", exact: true }).click();
    await page.getByTestId("ask-dialog").getByRole("button", { name: "Cancel", exact: true }).click(); await expect(win.getByLabel("Note body")).toHaveValue("discard only with my confirmation");
    await win.getByRole("button", { name: "Discard edits", exact: true }).click(); await confirm(page, "Reload note");
    await expect(win.getByLabel("Note body")).toHaveValue("saved original"); await page.waitForTimeout(650);
    assert.equal(await page.evaluate(key => sessionStorage.getItem(key), noteDraftKey("w1", discard.id)), null);
    await win.getByRole("button", { name: "Close window", exact: true }).click(); await expect(win).toHaveCount(0); await expect(page.getByTestId("close-confirm")).toHaveCount(0);
    assert.equal((await fx.api("GET", `/api/notes?id=${discard.id}`)).row.body, "saved original");
  }));
  await test("Native Find mount purges canonical and malformed legacy Private history from actual localStorage but preserves a public neighbour", { "SR-19": "full" }, () => module("find", async (page, win) => {
    await expect(win.getByTestId("find-recents")).toContainText("public neighbour");
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), RECENT_SEARCHES_KEY);
    assert.equal(stored.length, 1); assert.equal(stored[0].q, "public neighbour");
  }, async page => { await page.evaluate(({ key, rows }) => localStorage.setItem(key, JSON.stringify(rows)), { key: RECENT_SEARCHES_KEY, rows: ["/Private", " //Private/a ", "/Private//b", "/a/../Private", "/Documents"].map((scope, i) => ({ q: i === 4 ? "public neighbour" : `legacy-secret-${i}`, scope, mode: "text", at: i })) }); }));
  await test("Native locked-Private search stays local and outside automatic history; saving a named Private query requires explicit plaintext-profile consent", { "SR-19": "full", "SV-02": "full" }, () => module("find", async (page, win) => {
    const query = `${RUN} private query`, exposed: string[] = []; page.on("request", r => { if (decodeURIComponent(r.url()).includes(query) || (r.postData() ?? "").includes(query)) exposed.push(r.url()); });
    await win.getByLabel("Search query", { exact: true }).fill(query); await win.getByLabel("Scope", { exact: true }).fill("/Private");
    await win.getByLabel("Search query", { exact: true }).press("Enter"); await expect(win.getByTestId("private-search-info")).toContainText("query never left this tab");
    assert.deepEqual(exposed, []); assert.equal(await page.evaluate(key => localStorage.getItem(key), RECENT_SEARCHES_KEY), null);
    await win.getByRole("button", { name: "Save this search", exact: true }).click(); const dialog = page.getByTestId("ask-dialog");
    await expect(dialog).toContainText("unencrypted"); await expect(dialog).toContainText("exported JSON"); await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), SAVED_SEARCH_KEY), null);
    await win.getByRole("button", { name: "Save this search", exact: true }).click();
    await dialog.getByRole("button", { name: "Save query locally", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Save search", exact: true })).toBeVisible();
    await expect(dialog).toHaveCount(1); // the second real prompt replaces the consent prompt
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), SAVED_SEARCH_KEY), null, "consent followed by cancelled naming must not save a profile");
    await win.getByRole("button", { name: "Save this search", exact: true }).click();
    await dialog.getByRole("button", { name: "Save query locally", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "Save search", exact: true })).toBeVisible();
    await dialog.locator("input").fill("Consented Private profile"); await confirm(page, "Save search");
    const list = await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), SAVED_SEARCH_KEY);
    assert.equal(list.length, 1); assert.equal(list[0].q, query); assert.equal(list[0].scope, "/Private");
    assert.equal(await page.evaluate(key => localStorage.getItem(key), RECENT_SEARCHES_KEY), null);
  }));
  await test("Native profile import warns about plaintext Private queries before replacing; cancel preserves the list, and malformed Unicode/unknown fields are refused atomically", { "SV-03": "full" }, () => module("find", async (page, win) => {
    const original = [{ ...EMPTY_SEARCH, id: "public-1", name: "Keep me", q: "public", savedAt: 1 }];
    // Seed only this isolated profile's browser storage, then perform the real
    // app reload, native file input, confirmation and persistence paths.
    await page.evaluate(({ key, original }) => localStorage.setItem(key, JSON.stringify(original)), { key: SAVED_SEARCH_KEY, original });
    await page.reload({ waitUntil: "domcontentloaded" }); await win.getByRole("button", { name: "Keep me", exact: true }).waitFor();
    const privateRow = { ...EMPTY_SEARCH, id: "private-1", name: "Imported Private", q: "private fixture", scope: "/Private", savedAt: 2 };
    const input = win.getByLabel("Import saved searches");
    const upload = async (data: unknown) => input.setInputFiles({ name: "profiles.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(data)) });
    await upload({ kind: "fusion.saved-searches.v2", searches: [privateRow] }); await expect(page.getByTestId("ask-dialog")).toContainText("Private queries, stored unencrypted");
    await page.getByTestId("ask-dialog").getByRole("button", { name: "Cancel", exact: true }).click(); await expect(win.getByRole("button", { name: "Keep me", exact: true })).toBeVisible();
    for (const bad of [{ ...privateRow, q: "bad\ud800" }, { ...privateRow, unsupportedField: "must not be dropped silently" }]) {
      await upload({ kind: "fusion.saved-searches.v2", searches: [original[0], bad] });
      await expect(win.getByRole("alert")).toBeVisible(); assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? "null"), SAVED_SEARCH_KEY), original);
      await expect(page.getByTestId("ask-dialog")).toHaveCount(0);
    }
    await upload({ kind: "fusion.saved-searches.v2", searches: [privateRow] }); await confirm(page, "Import searches");
    await expect(win.getByRole("button", { name: "Imported Private", exact: true })).toBeVisible(); await expect(win.getByRole("button", { name: "Keep me", exact: true })).toHaveCount(0);
  }));
  await test("Native corrupt-history attack: truncated JSON containing a Private query is erased rather than left as unparseable plaintext", { "SR-19": "partial" }, () => module("find", async page => {
    await expect.poll(() => page.evaluate(key => localStorage.getItem(key), RECENT_SEARCHES_KEY)).toBe(null);
  }, async page => { await page.evaluate(key => localStorage.setItem(key, '[{"q":"legacy private secret","scope":"/Private"'), RECENT_SEARCHES_KEY); }));
  await test("No uncaught browser errors during native quota/privacy/profile boundary attacks", {}, () => assert.deepEqual(errors, []));
} finally {
  for (const id of owned) { const current = (await fx.api("GET", `/api/notes?id=${id}`)).row; await fx.api("DELETE", `/api/notes?id=${id}`, { expectedRevision: current.revision }); }
  await fx.close(); finish();
}
