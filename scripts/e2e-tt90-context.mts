/** Real Chromium + HTTP/PostgreSQL. CDP adds/removes VIRTUAL displays, not physical monitors. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { CONTEXT_PROFILE_KEY } from "../src/lib/context-profiles.ts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("Refusing browser state tests without TT89_DISPOSABLE_DATABASE=1 for a disposable server/database.");
const { test, finish } = makeHarness("e2e-tt90-context");
const BASE = process.env.BASE ?? "http://localhost:3000";
const cov = { "ST-09": "partial" } as const;
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(json)}`); return json;
};
const oldDesktop = await api("GET", "/api/state?id=default");
const rev = Number(oldDesktop.row?.revision ?? 1) + 1000;
await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
const settingsBefore = (await api("GET", "/api/settings")).rows.filter((r: { key: string }) => r.key === "appearance.density" || r.key === "appearance.textScale");
const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); context.setDefaultTimeout(15_000);
const page = await context.newPage(); const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
const panel = (p: Page) => p.getByTestId("context-profiles").last();
const openPanel = async (p: Page, url = `${BASE}/?open=settings`) => {
  await p.goto(url, { waitUntil: "domcontentloaded" });
  await p.locator('[data-shell-ready="true"]').waitFor({ timeout: 45_000 });
  const dialog = p.getByRole("dialog", { name: "Settings", exact: true }).last(); await dialog.waitFor({ timeout: 20_000 });
  await dialog.getByRole("tab", { name: "Context profiles", exact: true }).click(); await panel(p).waitFor();
};
const value = (p: Page) => p.evaluate(() => ({ density: document.documentElement.dataset.density, profile: document.documentElement.dataset.contextProfile, scale: document.documentElement.style.getPropertyValue("--fs-ts") }));
let original: Awaited<ReturnType<typeof value>>;
let screenId: string | null = null;
const cdp = await context.newCDPSession(page);
try {
  await test("profiles are off initially and editing them does not change the shared appearance", cov, async () => {
    await openPanel(page);
    original = await value(page); assert.equal(original.profile, "off");
    assert.equal(await panel(page).getByTestId("context-enabled").isChecked(), false);
    await panel(page).getByLabel("Single screen · primary pointer density").selectOption("compact");
    await panel(page).getByLabel("Single screen · primary pointer text size").selectOption("150");
    assert.deepEqual(await value(page), original);
    assert.deepEqual((await api("GET", "/api/settings")).rows.filter((r: { key: string }) => r.key === "appearance.density" || r.key === "appearance.textScale"), settingsBefore);
  });
  await test("opt-in applies the chosen profile, retains shared settings, and survives a reload", cov, async () => {
    await panel(page).getByTestId("context-enabled").check();
    await page.waitForFunction(() => document.documentElement.dataset.contextProfile === "single-pointer");
    assert.deepEqual(await value(page), { density: "compact", profile: "single-pointer", scale: "1.5" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-shell-ready="true"]').waitFor({ timeout: 40_000 });
    await page.waitForFunction(() => document.documentElement.dataset.contextProfile === "single-pointer");
    assert.deepEqual(await value(page), { density: "compact", profile: "single-pointer", scale: "1.5" });
    assert.deepEqual((await api("GET", "/api/settings")).rows.filter((r: { key: string }) => r.key === "appearance.density" || r.key === "appearance.textScale"), settingsBefore);
    // A fresh browser tab of this same profile sees the same persisted choice.
    const second = await context.newPage();
    try {
      await second.goto(BASE, { waitUntil: "domcontentloaded" });
      await second.locator('[data-shell-ready="true"]').waitFor({ timeout: 35_000 });
      await second.waitForFunction(() => document.documentElement.dataset.contextProfile === "single-pointer");
      assert.deepEqual(await value(second), { density: "compact", profile: "single-pointer", scale: "1.5" });
    } finally { await second.close(); await page.bringToFront(); }
  });
  await test("a real browser reacts to CDP virtual display add/remove, with an on-screen announcement", cov, async () => {
    // Reload may restore the Settings window but resets its selected tab.
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true }).last(); await dialog.waitFor();
    await dialog.getByRole("tab", { name: "Context profiles", exact: true }).click();
    await panel(page).getByLabel("Multiple screens density").selectOption("touch");
    await panel(page).getByLabel("Multiple screens text size").selectOption("200");
    const added = await cdp.send("Emulation.addScreen", { left: 1920, top: 0, width: 1280, height: 720, deviceScaleFactor: 1 });
    screenId = added.screenInfo.id;
    await page.waitForFunction(() => document.documentElement.dataset.contextProfile === "extended", null, { timeout: 10_000 });
    assert.deepEqual(await value(page), { density: "touch", profile: "extended", scale: "2" });
    await page.getByText("Context profile: multiple screens", { exact: true }).waitFor({ timeout: 5000 });
    await cdp.send("Emulation.removeScreen", { screenId }); screenId = null;
    await page.waitForFunction(() => document.documentElement.dataset.contextProfile === "single-pointer", null, { timeout: 10_000 });
    assert.deepEqual(await value(page), { density: "compact", profile: "single-pointer", scale: "1.5" });
    await page.getByText("Context profile: single screen / pointer", { exact: true }).waitFor({ timeout: 5000 });
  });
  await test("same-origin tabs react to preference changes; turning off restores the shared values", cov, async () => {
    const second = await context.newPage();
    try {
      await second.goto(BASE, { waitUntil: "domcontentloaded" });
      await second.locator('[data-shell-ready="true"]').waitFor({ timeout: 35_000 });
      await second.waitForFunction(() => document.documentElement.dataset.contextProfile === "single-pointer");
      await page.bringToFront(); await panel(page).getByTestId("context-enabled").uncheck();
      await second.waitForFunction(() => document.documentElement.dataset.contextProfile === "off");
      assert.deepEqual(await value(page), original); assert.deepEqual(await value(second), original);
      assert.deepEqual((await api("GET", "/api/settings")).rows.filter((r: { key: string }) => r.key === "appearance.density" || r.key === "appearance.textScale"), settingsBefore);
    } finally { await second.close(); await page.bringToFront(); }
  });
  await test("amnesia permits session-only choices without changing normal local storage or shared settings", { ...cov, "SC-13": "partial" }, async () => {
    const saved = await page.evaluate((key) => localStorage.getItem(key), CONTEXT_PROFILE_KEY);
    const am = await context.newPage();
    try {
      await openPanel(am, `${BASE}/?amnesia=1&open=settings`);
      await am.getByTestId("amnesic-badge").first().waitFor();
      await panel(am).getByText(/Changes are session-only/).waitFor();
      await panel(am).getByLabel("Single screen · primary pointer density").selectOption("touch");
      await panel(am).getByTestId("context-enabled").check();
      await am.waitForFunction(() => document.documentElement.dataset.contextProfile === "single-pointer");
      assert.equal((await value(am)).density, "touch");
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), CONTEXT_PROFILE_KEY), saved);
      assert.deepEqual((await api("GET", "/api/settings")).rows.filter((r: { key: string }) => r.key === "appearance.density" || r.key === "appearance.textScale"), settingsBefore);
    } finally { await am.close(); await page.bringToFront(); }
  });
  await test("a touch-emulated Chromium chooses the touch profile independent of viewport width", cov, async () => {
    const touch = await browser.newContext({ viewport: { width: 1440, height: 900 }, hasTouch: true });
    try {
      const p = await touch.newPage(); await openPanel(p);
      assert.equal(await p.evaluate(() => matchMedia("(pointer: coarse)").matches), true);
      await panel(p).getByTestId("context-enabled").check();
      await p.waitForFunction(() => document.documentElement.dataset.contextProfile === "single-touch");
      assert.equal((await value(p)).density, "touch");
      await p.setViewportSize({ width: 600, height: 900 });
      await p.waitForTimeout(200);
      assert.equal((await value(p)).profile, "single-touch");
      assert.equal((await value(p)).scale, original.scale);
    } finally { await touch.close(); await page.bringToFront(); }
  });
  await test("corrupt local storage fails closed and does not claim unavailable screen detection", cov, async () => {
    const isolated = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      await isolated.addInitScript((key) => {
        localStorage.setItem(key, '{"version":1,"enabled":true,"profiles":{"extended":{"density":"bogus","textScale":999}}}');
        Object.defineProperty(screen, "isExtended", { configurable: true, value: undefined });
      }, CONTEXT_PROFILE_KEY);
      const p = await isolated.newPage(); await openPanel(p);
      assert.equal(await panel(p).getByTestId("context-enabled").isChecked(), false);
      await panel(p).getByTestId("context-enabled").check();
      await panel(p).getByText(/cannot report extra screens/).waitFor();
      assert.equal((await value(p)).profile, "single-pointer");
    } finally { await isolated.close(); }
  });
  await test("context controls have no serious axe findings or uncaught page errors", cov, async () => {
    await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });
    const violations = await panel(page).evaluate(async (el) => (await (window as any).axe.run(el, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })).violations.filter((v: any) => v.impact === "critical" || v.impact === "serious").map((v: any) => v.id));
    assert.deepEqual(violations, []); assert.deepEqual(errors, []);
  });
} finally {
  if (screenId) await cdp.send("Emulation.removeScreen", { screenId }).catch(() => undefined);
  await context.close(); await browser.close();
  const current = await api("GET", "/api/state?id=default");
  if (oldDesktop.row?.state) await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 0) + 1000, state: oldDesktop.row.state }).catch(() => undefined);
}
finish();
