import assert from "node:assert/strict";
import { disposableShell } from "./tt132-fixture.mts";
import { makeHarness } from "./harness.mts";
const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt155-window-fit");
try {
  await test("an oversized restored terminal fits the desk and its input accepts native pointer and keyboard actions", {}, async () => {
    const old = await fx.api("GET", "/api/state?id=default");
    await fx.api("PUT", "/api/state", { id: "default", revision: Number(old.row?.revision ?? 1) + 1000, state: {
      windows: [{ id: "w1", module: "terminal", title: "Terminal", x: 20, y: 16, w: 1440, h: 1200, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
    } });
    const ctx = await fx.context({ viewport: { width: 1500, height: 1040 } });
    try {
      const page = await ctx.newPage(); await fx.ready(page, "terminal");
      const input = page.getByLabel("Terminal input"), win = page.locator('[data-win-id="w1"]'), desk = page.locator('[data-desktop-id]');
      await input.waitFor();
      const measure = async () => { const w = (await win.boundingBox())!, d = (await desk.boundingBox())!; return { bottom: w.y + w.height, deskBottom: d.y + d.height }; };
      const rect = await measure(); assert.ok(rect.bottom <= rect.deskBottom + 1, JSON.stringify(rect));
      await input.click({ timeout: 5000 }); await input.fill("echo TT155"); await input.press("Enter");
      await win.getByText("TT155", { exact: true }).waitFor();
      const maximize = win.getByRole("button", { name: "Maximise or restore" });
      const full = async () => page.waitForFunction(() => {
        const w = document.querySelector('[data-win-id="w1"]')?.getBoundingClientRect();
        const d = document.querySelector('[data-desktop-id]')?.getBoundingClientRect();
        return !!w && !!d && Math.abs(w.width - d.width) <= 1 && Math.abs(w.height - d.height) <= 1;
      });
      await maximize.click(); await full(); await maximize.click();
      const restored = await measure(); assert.ok(restored.bottom <= restored.deskBottom + 1, JSON.stringify(restored));
      await input.click(); assert.equal(await input.evaluate(e => document.activeElement === e), true);
      await page.setViewportSize({ width: 1100, height: 700 });
      await page.waitForFunction(() => {
        const w = document.querySelector('[data-win-id="w1"]')?.getBoundingClientRect();
        const d = document.querySelector('[data-desktop-id]')?.getBoundingClientRect();
        return !!w && !!d && w.bottom <= d.bottom + 1 && w.right <= d.right + 1;
      });
      await input.click(); await input.fill("echo SHRUNK"); await input.press("Enter");
      await win.getByText("SHRUNK", { exact: true }).waitFor();
      await maximize.click(); await full();
      await page.setViewportSize({ width: 800, height: 600 });
      await page.waitForFunction(() => {
        const w = document.querySelector('[data-win-id="w1"]')?.getBoundingClientRect();
        const d = document.querySelector('[data-desktop-id]')?.getBoundingClientRect();
        return !!w && !!d && Math.abs(w.width - d.width) <= 1 && Math.abs(w.height - d.height) <= 1;
      });
      await maximize.click();
      await page.waitForFunction(() => {
        const w = document.querySelector('[data-win-id="w1"]')?.getBoundingClientRect();
        const d = document.querySelector('[data-desktop-id]')?.getBoundingClientRect();
        return !!w && !!d && w.bottom <= d.bottom + 1 && w.right <= d.right + 1;
      });
      await input.click(); assert.equal(await input.evaluate(e => document.activeElement === e), true);
      await page.screenshot({ path: "docs/screens/tt155-terminal-fit.png", animations: "disabled" });
    } finally { await ctx.close(); }
  });
  await test("a title action raises an inactive window without starting a drag", {}, async () => {
    const old = await fx.api("GET", "/api/state?id=default");
    await fx.api("PUT", "/api/state", { id: "default", revision: Number(old.row?.revision ?? 1) + 1000, state: {
      windows: [
        { id: "w1", module: "terminal", title: "Terminal", x: 20, y: 20, w: 550, h: 500, z: 10, workspace: 1, props: {} },
        { id: "w2", module: "files", title: "Files", x: 800, y: 20, w: 550, h: 500, z: 11, workspace: 1, props: {} },
      ], focus: "w2", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30,
    } });
    const ctx = await fx.context();
    try {
      const page = await ctx.newPage(); await fx.ready(page, "terminal");
      const w = page.locator('[data-win-id="w1"]');
      assert.equal(await w.getAttribute("data-focused"), "false");
      await w.getByRole("button", { name: "Maximise or restore" }).click();
      await page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.getAttribute("data-focused") === "true");
      await w.getByRole("button", { name: "Maximise or restore" }).click();
      await page.waitForFunction(() => {
        const r = document.querySelector('[data-win-id="w1"]')?.getBoundingClientRect();
        return !!r && Math.abs(r.width - 550) <= 1 && Math.abs(r.height - 500) <= 1;
      });
    } finally { await ctx.close(); }
  });
} finally { await fx.close(); finish(); }
