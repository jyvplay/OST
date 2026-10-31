/** Shared, explicitly disposable real-shell fixture. No production imports. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright";

export async function disposableShell() {
  if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("exclusive disposable BASE and DATABASE_URL required");
  const BASE = process.env.BASE;
  async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(); if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
    return JSON.parse(text) as T;
  }
  const original = await api<{ row?: { state?: unknown } }>("GET", "/api/state?id=default");
  const browser = await launchChromium();
  console.log(`Actual browser: ${browser.version()}`);
  const contexts = new Set<BrowserContext>();
  const windows = async (module: string, count = 1, width = 1500) => {
    const w = Math.min(count > 1 ? 730 : 1150, Math.floor((width - 36) / count) - (count > 1 ? 10 : 0));
    const current = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
    await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 1) + 1000, state: {
      windows: Array.from({ length: count }, (_, i) => ({ id: `w${i + 1}`, module, title: module, x: 18 + i * (w + 14), y: 16, w, h: 810, z: 10 + i, workspace: 1, props: {} })),
      focus: `w${count}`, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
    } });
  };
  const context = async (options: BrowserContextOptions = {}) => {
    const value = await browser.newContext({ viewport: { width: 1500, height: 960 }, timezoneId: "UTC", serviceWorkers: "block", ...options });
    contexts.add(value); value.on("close", () => contexts.delete(value)); return value;
  };
  const ready = async (page: Page, module: string, suffix = "") => {
    page.setDefaultTimeout(12_000);
    await page.goto(BASE + suffix, { waitUntil: "domcontentloaded" });
    const window = page.locator('[data-win-id="w1"]');
    await window.waitFor();
    if (module === "clock") await window.getByRole("heading", { name: "World clock", exact: true }).waitFor();
    else if (module === "planner") await window.getByLabel("Task title", { exact: true }).waitFor();
    else await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] .fs-winbody')?.children.length ?? 0) > 0);
    assert.equal(await window.count(), 1);
  };
  const close = async () => {
    for (const ctx of contexts) await ctx.close();
    await browser.close();
    if (original.row?.state) {
      const current = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
      await api("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 1) + 1000, state: original.row.state });
    }
  };
  return { BASE, api, browser, windows, context, ready, close };
}
