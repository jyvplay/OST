/** Real Chromium + axe against selected Files server badges, all shipped style tokens. Disposable DB only. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { STYLE_IDS } from "../src/lib/style-core.ts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Refusing Files contrast test without a disposable database, matching server and BASE.");
const BASE = process.env.BASE, { test, finish } = makeHarness("e2e-tt96-files-contrast");
const path = `/Documents/tt96-contrast-${randomBytes(8).toString("hex")}.txt`;
const api = async (method: string, url: string, body?: object) => {
  const r = await fetch(BASE + url, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(r.ok, `${method} ${url}: ${r.status}`); return r.json();
};
const settings = (await api("GET", "/api/settings")).rows as { key: string; value: string }[];
const originals = Object.fromEntries(["appearance.layout", "appearance.desktopView", "appearance.textScale"].map((key) => [key, settings.find((x) => x.key === key)?.value]));
const browser = await launchChromium(); let created = false;
try {
  for (const [key, value] of Object.entries({ "appearance.layout": "fusion", "appearance.desktopView": "classic", "appearance.textScale": "125" })) await api("PUT", "/api/settings", { key, value });
  await api("POST", "/api/fs", { op: "write", path, content: "contrast fixture", reason: "tt96-test" }); created = true;
  const state = await api("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(state.row?.revision ?? 1) + 1000, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page = await ctx.newPage(); await page.goto(`${BASE}/?open=files&path=%2FDocuments`, { waitUntil: "domcontentloaded" });
    const win = page.locator('.fs-window[aria-label="Files"]').first(); await win.waitFor({ timeout: 30_000 });
    const row = win.locator('[role="option"]').filter({ has: page.locator(`[data-origin="server"]`) }).filter({ hasText: path.split("/").pop()! });
    await row.waitFor({ timeout: 30_000 }); await row.click(); assert.equal(await row.getAttribute("aria-selected"), "true");
    const badge = row.locator('[data-origin="server"]'); assert.equal(await badge.isVisible(), true);
    const badgeBox = await badge.boundingBox(); assert.ok(badgeBox && badgeBox.x >= 0 && badgeBox.x + badgeBox.width <= 1440 && badgeBox.y >= 0 && badgeBox.y + badgeBox.height <= 900);
    await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
    for (const theme of ["dark", "light"]) for (const hovered of [false, true]) {
      await test(`${theme} ${hovered ? "hovered" : "unhovered"} selected server badge is readable across all 13 styles`, { "AX-08": "partial", "FM-09": "partial" }, async () => {
        const failures: string[] = [];
        for (const style of STYLE_IDS) {
          await page.evaluate(({ style, theme }) => { document.documentElement.dataset.style = style; document.documentElement.dataset.theme = theme; }, { style, theme });
          if (hovered) await row.hover(); else await page.mouse.move(10, 10);
          await page.waitForTimeout(80);
          const findings = await row.evaluate(async (element) => {
            const axe = (window as unknown as { axe: { run: (el: Element, opts: object) => Promise<{ violations: { id: string; nodes: { target: string[]; failureSummary?: string }[] }[] }> } }).axe;
            const r = await axe.run(element, { runOnly: ["color-contrast"] });
            return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(" ")} ${n.failureSummary ?? ""}`));
          });
          if (findings.length) failures.push(`${style}: ${findings.join("; ")}`);
        }
        assert.deepEqual(failures, []);
      });
    }
    await test("axe detects the injected old muted colour on dark Silver and accepts the restored colour", { "AX-08": "partial", "FM-09": "partial" }, async () => {
      await page.evaluate(() => { document.documentElement.dataset.style = "silver"; document.documentElement.dataset.theme = "dark"; });
      await page.mouse.move(10, 10); await badge.evaluate((node) => { (node as HTMLElement).style.color = "var(--fs-muted)"; });
      const violations = async () => row.evaluate(async (element) => {
        const axe = (window as unknown as { axe: { run: (el: Element, opts: object) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
        const r = await axe.run(element, { runOnly: ["color-contrast"] }); return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(" ")}`));
      });
      assert.ok((await violations()).some((x) => x.includes("color-contrast") && x.includes('data-origin="server"')), "axe must catch the injected selected-badge regression");
      await badge.evaluate((node) => { (node as HTMLElement).style.removeProperty("color"); }); assert.deepEqual(await violations(), []);
    });
  } finally { await ctx.close(); }
} finally {
  await browser.close(); if (created) await api("POST", "/api/fs", { op: "purge", path });
  for (const [key, value] of Object.entries(originals)) if (value !== undefined) await api("PUT", "/api/settings", { key, value });
}
finish();
