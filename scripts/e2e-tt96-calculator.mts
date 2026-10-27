/** Real Chromium + PostgreSQL calculator/privacy tests; use only an exclusive disposable server/database. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { BrowserContext, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { CALC_HISTORY_KEEP, CALC_HISTORY_PREFIX } from "../src/lib/calc-history.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Refusing calculator browser tests without a disposable database, matching server and BASE.");
const BASE = process.env.BASE, suffix = randomBytes(4).readUInt32BE().toString(), { test, finish } = makeHarness("e2e-tt96-calculator");
const cov = { "PR-09": "partial" } as const;
const db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const api = async (method: string, path: string, body?: object) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await r.json(); assert.ok(r.ok, `${method} ${path}: ${r.status}`); return json;
};
async function resetDesktop() {
  const state = await api("GET", "/api/state?id=default"), revision = Number(state.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 1000 }, icons: [], focusMode: false } });
}
const settings = (await api("GET", "/api/settings")).rows as { key: string; value: string }[];
const resetSettings = { "appearance.layout": "fusion", "appearance.desktopView": "classic", "appearance.textScale": "125", "appearance.style": "poolside", "appearance.theme": "dark", "shell.hotCorners": "off" };
const previousSettings = Object.fromEntries(Object.keys(resetSettings).map((key) => [key, settings.find((row) => row.key === key)?.value]));
const browser = await launchChromium();
const pageErrors: string[] = [];
async function open(context: BrowserContext, query = "open=calculator"): Promise<{ page: Page; calc: Locator }> {
  const page = await context.newPage(); page.on("pageerror", (error) => pageErrors.push(error.message)); await page.goto(`${BASE}/?${query}`, { waitUntil: "domcontentloaded" });
  const calc = page.locator('[role="dialog"][aria-label="Calculator"]').first(); await calc.waitFor({ timeout: 30_000 });
  await calc.getByLabel("Expression").waitFor({ timeout: 30_000 }); return { page, calc };
}
const localEntries = (page: Page) => page.evaluate((prefix) => Object.keys(localStorage).filter((key) => key.startsWith(prefix)).map((key) => localStorage.getItem(key)), CALC_HISTORY_PREFIX);
const hostCounts = async (needle: string) => (await db.query("SELECT (SELECT count(*)::int FROM notes WHERE title LIKE $1 OR body LIKE $1) AS notes, (SELECT count(*)::int FROM index_docs WHERE title LIKE $1 OR body LIKE $1) AS indexed", [`%${needle}%`])).rows[0];

try {
  for (const [key, value] of Object.entries(resetSettings)) await api("PUT", "/api/settings", { key, value });
  await test("programmer controls compute exact 64-bit and signed fixed-width expressions in the real UI", cov, async () => {
    await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const { calc } = await open(ctx); const input = calc.getByLabel("Expression");
      await input.fill("2^3^2"); assert.equal((await calc.getByTestId("calculator-result").innerText()).trim(), "= 512");
      await calc.getByRole("button", { name: "Programmer", exact: true }).click(); await calc.getByLabel("Word size").selectOption("64");
      await input.fill("0xffffffffffffffff"); assert.equal((await calc.getByTestId("calculator-result").innerText()).trim(), "= 18446744073709551615");
      assert.match(await calc.getByTestId("programmer-bases").innerText(), /HEX FFFFFFFFFFFFFFFF/);
      await calc.getByLabel("Word size").selectOption("8"); await calc.getByLabel("Signed").check(); await input.fill("0x80 >> 7");
      assert.equal((await calc.getByTestId("calculator-result").innerText()).trim(), "= -1");
      await input.fill("1 << 8"); assert.match(await calc.getByTestId("calculator-result").innerText(), /Shift count/i);
      await calc.getByRole("button", { name: "Scientific", exact: true }).click(); await input.fill("0xffffffffffffffff");
      assert.match(await calc.getByTestId("calculator-result").innerText(), /exceeds exact range/i);
    } finally { await ctx.close(); }
  });

  await test("history is session-only by default, then explicit local opt-in survives reload, filters, restores mode and deletes", cov, async () => {
    await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      let { page, calc } = await open(ctx); const secret = `${suffix}+3571`, before = await hostCounts(secret);
      await calc.getByLabel("Expression").fill(secret); await calc.getByLabel("Expression").press("Enter");
      await calc.getByTestId("calculator-history-entry").getByText(secret, { exact: true }).waitFor();
      assert.deepEqual(await localEntries(page), []); assert.deepEqual(await hostCounts(secret), before);
      await page.reload({ waitUntil: "domcontentloaded" }); calc = page.locator('[role="dialog"][aria-label="Calculator"]').first(); await calc.getByLabel("Expression").waitFor({ timeout: 30_000 });
      assert.equal(await calc.getByText(secret, { exact: true }).count(), 0);
      await calc.getByRole("button", { name: "Keep new history locally" }).click(); await calc.getByRole("button", { name: "Stop saving history" }).waitFor();
      await calc.getByRole("button", { name: "Programmer", exact: true }).click(); await calc.getByLabel("Word size").selectOption("64");
      const expression = `0x${suffix} & 0xff`; await calc.getByLabel("Expression").fill(expression); await calc.getByLabel("Expression").press("Enter");
      await calc.getByRole("status").getByText(/Calculation saved in this browser/).waitFor();
      assert.equal((await localEntries(page)).length, 1); assert.deepEqual(await hostCounts(secret), before);
      await page.reload({ waitUntil: "domcontentloaded" }); calc = page.locator('[role="dialog"][aria-label="Calculator"]').first();
      await calc.getByTestId("calculator-history-entry").getByText(expression, { exact: true }).waitFor({ timeout: 30_000 });
      await calc.getByLabel("Filter calculator history").fill("no-match-value"); assert.equal(await calc.getByTestId("calculator-history-entry").count(), 0);
      await calc.getByLabel("Filter calculator history").fill(suffix); const entry = calc.getByTestId("calculator-history-entry");
      await entry.click(); assert.equal(await calc.getByRole("button", { name: "Programmer", exact: true }).getAttribute("aria-pressed"), "true");
      assert.equal(await calc.getByLabel("Word size").inputValue(), "64"); assert.equal(await calc.getByLabel("Expression").inputValue(), expression);
      page.once("dialog", (dialog) => void dialog.accept()); await calc.getByRole("button", { name: "Delete history" }).click();
      await calc.getByRole("status").getByText(/history deleted/i).waitFor(); assert.deepEqual(await localEntries(page), []);
    } finally { await ctx.close(); }
  });

  await test("quota denial is visible and never reported as a confirmed saved history entry", cov, async () => {
    await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const { page, calc } = await open(ctx); await calc.getByRole("button", { name: "Keep new history locally" }).click();
      await calc.getByRole("button", { name: "Stop saving history" }).waitFor();
      await page.evaluate((prefix) => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { if (k.startsWith(prefix)) throw new DOMException("quota", "QuotaExceededError"); return original.call(this, k, v); }; }, CALC_HISTORY_PREFIX);
      await calc.getByLabel("Expression").fill("12345+9"); await calc.getByLabel("Expression").press("Enter");
      await calc.getByRole("status").getByText(/Could not confirm browser-history storage/).waitFor();
      assert.equal(await calc.getByTestId("calculator-history-entry").count(), 1); assert.deepEqual(await localEntries(page), []);
    } finally { await ctx.close(); }
  });

  await test("corrupt stored history is preserved and prevents opt-in until explicit deletion", cov, async () => {
    await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      let { page, calc } = await open(ctx); const key = `${CALC_HISTORY_PREFIX}corrupt`;
      await page.evaluate((k) => localStorage.setItem(k, "{broken"), key); await page.reload({ waitUntil: "domcontentloaded" });
      calc = page.locator('[role="dialog"][aria-label="Calculator"]').first(); await calc.getByRole("status").getByText(/unreadable/i).waitFor({ timeout: 30_000 });
      await calc.getByRole("button", { name: "Keep new history locally" }).click(); await calc.getByRole("status").getByText(/Could not change/).waitFor();
      assert.equal(await page.evaluate((k) => localStorage.getItem(k), key), "{broken");
      assert.notEqual(await page.evaluate((k) => localStorage.getItem(k), CALC_HISTORY_KEEP), "1");
      page.once("dialog", (dialog) => void dialog.accept()); await calc.getByRole("button", { name: "Delete history" }).click();
      await calc.getByRole("status").getByText(/history deleted/i).waitFor(); assert.equal(await page.evaluate((k) => localStorage.getItem(k), key), null);
    } finally { await ctx.close(); }
  });

  await test("amnesic and offline use can calculate without persisting history to the host or browser", cov, async () => {
    await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const secret = `${suffix}+947123`, before = await hostCounts(secret);
      const observer = await ctx.newPage(); await observer.goto(BASE, { waitUntil: "domcontentloaded" });
      await observer.evaluate(({ keepKey, prefix }) => {
        localStorage.setItem(keepKey, "1");
        localStorage.setItem(prefix + "existing", JSON.stringify({ id: "existing", expr: "2+2", text: "4", mode: "scientific", width: 32, signed: false, at: 1 }));
      }, { keepKey: CALC_HISTORY_KEEP, prefix: CALC_HISTORY_PREFIX });
      const beforeStorage = await localEntries(observer); const { page, calc } = await open(ctx, "amnesia=1&open=calculator");
      await calc.getByRole("button", { name: "Keep new history locally" }).waitFor();
      await page.waitForFunction(() => document.querySelector('[role="dialog"][aria-label="Calculator"] button[disabled]') !== null, null, { timeout: 10_000 });
      assert.equal(await calc.getByRole("button", { name: "Keep new history locally" }).isDisabled(), true);
      assert.equal(await calc.getByTestId("calculator-history-entry").count(), 0, "amnesia must not load previous browser history");
      await ctx.setOffline(true); await calc.getByLabel("Expression").fill(secret); await calc.getByLabel("Expression").press("Enter");
      await calc.getByTestId("calculator-history-entry").getByText(secret, { exact: true }).waitFor(); await ctx.setOffline(false);
      let prompt = ""; page.once("dialog", (dialog) => { prompt = dialog.message(); void dialog.accept(); });
      await calc.getByRole("button", { name: "Delete history" }).click(); await calc.getByRole("status").getByText(/browser storage was not changed/i).waitFor();
      assert.match(prompt, /Browser storage will not be changed/);
      assert.deepEqual(await localEntries(observer), beforeStorage); assert.equal(await observer.evaluate((key) => localStorage.getItem(key), CALC_HISTORY_KEEP), "1");
      assert.deepEqual(await hostCounts(secret), before);
    } finally { await ctx.close(); }
  });

  await test("the programmer controls and history remain reachable in a narrow viewport", cov, async () => {
    await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const { calc } = await open(ctx); await calc.getByRole("button", { name: "Programmer", exact: true }).click();
      await calc.getByLabel("Word size").selectOption("8"); await calc.getByLabel("Expression").fill("0xff & 3");
      await calc.getByLabel("Expression").press("Enter"); const entry = calc.getByTestId("calculator-history-entry").getByText("0xff & 3", { exact: true });
      await entry.waitFor(); await entry.click(); assert.equal(await calc.getByLabel("Expression").inputValue(), "0xff & 3");
    } finally { await ctx.close(); }
  });

  await test("axe finds no serious or critical violations in active programmer controls and history", { "PR-09": "partial", "AX-08": "partial" }, async () => {
    await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const { page, calc } = await open(ctx); await calc.getByRole("button", { name: "Programmer", exact: true }).click();
      await calc.getByLabel("Word size").selectOption("8"); await calc.getByLabel("Signed").check();
      await calc.getByLabel("Expression").fill("0x80 >> 7"); await calc.getByLabel("Expression").press("Enter");
      await calc.getByTestId("calculator-history-entry").waitFor(); await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
      const violations = await calc.evaluate(async (element) => {
        const axe = (window as unknown as { axe: { run: (el: Element, options: object) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
        const result = await axe.run(element, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
        return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      });
      assert.deepEqual(violations, []);
    } finally { await ctx.close(); }
  });

  await test("a held Web Lock forces two cooperating tabs to queue and keep both local appends", cov, async () => {
    await resetDesktop(); const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      const a = await open(ctx); const b = await open(ctx);
      await a.calc.getByRole("button", { name: "Keep new history locally" }).click(); await b.calc.getByRole("button", { name: "Stop saving history" }).waitFor({ timeout: 10_000 });
      assert.equal(await a.page.evaluate(() => typeof navigator.locks?.request), "function");
      await a.page.evaluate(async () => {
        await new Promise<void>((acquired) => {
          void navigator.locks.request("fusion.calculator.history.v1", async () => {
            const gate = new Promise<void>((release) => { (window as unknown as { releaseTT96: () => void }).releaseTT96 = release; });
            acquired(); await gate;
          });
        });
      });
      const aExpr = `${suffix}+101`, bExpr = `${suffix}+202`;
      await Promise.all([a.calc.getByLabel("Expression").fill(aExpr), b.calc.getByLabel("Expression").fill(bExpr)]);
      await Promise.all([a.calc.getByLabel("Expression").press("Enter"), b.calc.getByLabel("Expression").press("Enter")]);
      assert.deepEqual(await localEntries(a.page), [], "both writes must still be queued behind the held lock");
      await a.page.evaluate(() => (window as unknown as { releaseTT96: () => void }).releaseTT96());
      await a.calc.getByTestId("calculator-history-entry").getByText(bExpr, { exact: true }).waitFor({ timeout: 10_000 });
      await b.calc.getByTestId("calculator-history-entry").getByText(aExpr, { exact: true }).waitFor({ timeout: 10_000 });
      const values = (await localEntries(a.page)).join("\n"); assert.match(values, new RegExp(aExpr.replace("+", "\\+"))); assert.match(values, new RegExp(bExpr.replace("+", "\\+")));
    } finally { await ctx.close(); }
  });
  await test("calculator browser scenarios produce no uncaught page errors", cov, () => { assert.deepEqual(pageErrors, []); });
} finally {
  await browser.close(); await db.end();
  for (const [key, value] of Object.entries(previousSettings)) if (value !== undefined) await api("PUT", "/api/settings", { key, value });
}
finish();
