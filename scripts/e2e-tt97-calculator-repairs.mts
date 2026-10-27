/** Recheck calculator ARIA and scientific conversion repairs in a real disposable app. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { STYLE_IDS } from "../src/lib/style-core.ts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Refusing TT97 calculator checks without an exclusive disposable database and matching server.");
const BASE = process.env.BASE;
const { test, finish } = makeHarness("e2e-tt97-calculator-repairs");
const cov = { "PR-09": "partial", "SR-06": "partial", "AX-08": "partial" } as const;
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`); return response.json();
};
const saved = (await api("GET", "/api/settings")).rows as { key: string; value: string }[];
const settings = { "appearance.layout": "fusion", "appearance.desktopView": "classic", "appearance.textScale": "125", "appearance.style": "poolside", "appearance.theme": "dark" };
const previous = Object.fromEntries(Object.keys(settings).map((key) => [key, saved.find((row) => row.key === key)?.value]));
const currentState = await api("GET", "/api/state?id=default");
const initialRevision = Number(currentState.row?.revision ?? 1);
const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage(), pageErrors: string[] = [];
page.on("pageerror", (error) => pageErrors.push(error.message));
const scan = async (page: Page) => page.evaluate(async () => {
  const axe = (window as unknown as { axe: { run: (context: unknown, options: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
  const result = await axe.run({ include: ['.fs-window[aria-label="Calculator"]'] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
  return result.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, targets: v.nodes.map((n) => n.target.join(" ")) }));
});
try {
  for (const [key, value] of Object.entries(settings)) await api("PUT", "/api/settings", { key, value });
  const win = { id: "tt97-calculator", module: "calculator", title: "Calculator", x: 40, y: 20, w: 1100, h: 760, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} };
  await api("PUT", "/api/state", { id: "default", revision: initialRevision + 1000, state: { windows: [win], focus: win.id, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const calc = page.locator('.fs-window[aria-label="Calculator"]'); await calc.getByLabel("Expression").waitFor({ timeout: 30_000 });
  await page.addScriptTag({ content: readFileSync("node_modules/axe-core/axe.min.js", "utf8") });

  await test("empty history is a named region; removing its role reintroduces the original axe violation", cov, async () => {
    const region = calc.getByRole("region", { name: "Calculator history" }); await region.waitFor();
    assert.equal(await calc.getByTestId("calculator-history-entry").count(), 0);
    assert.deepEqual(await scan(page), []);
    await region.evaluate((element) => element.removeAttribute("role"));
    try {
      const broken = await scan(page);
      assert.ok(broken.some((v) => v.id === "aria-prohibited-attr" && v.targets.some((t) => t.includes("fs-scroll"))), JSON.stringify(broken));
    } finally { await calc.locator('[aria-label="Calculator history"]').evaluate((element) => element.setAttribute("role", "region")); }
    assert.deepEqual(await scan(page), []);
  });

  await test("empty and populated programmer history remain axe-clean", cov, async () => {
    await calc.getByRole("button", { name: "Programmer", exact: true }).click();
    assert.deepEqual(await scan(page), []);
    await calc.getByLabel("Expression").fill("1<<3"); await calc.getByLabel("Expression").press("Enter");
    await calc.getByTestId("calculator-history-entry").waitFor(); assert.deepEqual(await scan(page), []);
  });

  await test("mode colors change atomically; injecting a slow background-only transition is detected", cov, async () => {
    const buttons = calc.locator('.fs-calc-modes .fs-btn'); assert.equal(await buttons.count(), 2);
    for (const button of await buttons.all()) assert.equal(await button.evaluate((el) => getComputedStyle(el).transitionDuration), "0s");
    await buttons.evaluateAll((els) => els.forEach((el) => { (el as HTMLElement).style.transition = "background 10s linear"; }));
    try {
      await calc.getByRole("button", { name: "Scientific", exact: true }).click();
      const broken = await scan(page); assert.ok(broken.some((v) => v.id === "color-contrast" && v.targets.some((t) => t.includes("fs-btn"))), JSON.stringify(broken));
    } finally { await buttons.evaluateAll((els) => els.forEach((el) => { (el as HTMLElement).style.removeProperty("transition"); })); }
    assert.deepEqual(await scan(page), []);
  });

  await test("calculator mode controls retain contrast across 13 styles and both themes", cov, async () => {
    const failures: string[] = [];
    for (const theme of ["dark", "light"]) for (const style of STYLE_IDS) {
      await page.evaluate(({ theme, style }) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.style = style; }, { theme, style });
      for (const mode of ["Programmer", "Scientific"]) {
        await calc.getByRole("button", { name: mode, exact: true }).click();
        const bad = await calc.locator(".fs-calc-modes").evaluate(async (element) => {
          const axe = (window as unknown as { axe: { run: (context: Element, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
          const result = await axe.run(element, { runOnly: ["color-contrast"] });
          return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
        });
        if (bad.length) failures.push(`${theme}/${style}/${mode}: ${bad.join("; ")}`);
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.dataset.style = "poolside"; });
    assert.deepEqual(failures, []);
  });

  await test("calculator and command palette agree on finite and overflowing unit conversions", cov, async () => {
    await calc.getByRole("button", { name: "Scientific", exact: true }).click();
    const input = calc.getByLabel("Expression"), result = calc.getByTestId("calculator-result");
    await input.fill("1e308 km to km"); assert.equal((await result.innerText()).trim(), "= 1e+308 km");
    await input.fill("1e308 km to mm"); assert.match(await result.innerText(), /not a finite number/);
    await page.getByTitle("Command palette (Ctrl+Space)").click();
    const palette = page.getByRole("dialog", { name: "Command palette" }); const search = palette.locator("input");
    await search.fill("1e308 km to km"); await palette.getByText("= 1e+308 km", { exact: true }).waitFor();
    await search.fill("1e308 km to mm"); assert.equal(await palette.getByText(/Infinity/).count(), 0);
    await search.fill("1 in to cm"); await palette.getByText("= 2.54 cm", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
  });
  await test("palette scope buttons retain contrast immediately across 13 styles and both themes", cov, async () => {
    await page.getByTitle("Command palette (Ctrl+Space)").click();
    const palette = page.getByRole("dialog", { name: "Command palette" }); const failures: string[] = [];
    for (const theme of ["dark", "light"]) for (const style of STYLE_IDS) {
      await page.evaluate(({ theme, style }) => { document.documentElement.dataset.theme = theme; document.documentElement.dataset.style = style; }, { theme, style });
      for (const scope of ["actions", "all"]) {
        await palette.getByRole("button", { name: scope, exact: true }).click();
        const bad = await palette.locator(".fs-palette-scopes").evaluate(async (element) => {
          const axe = (window as unknown as { axe: { run: (context: Element, options: unknown) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe;
          const result = await axe.run(element, { runOnly: ["color-contrast"] });
          return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
        });
        if (bad.length) failures.push(`${theme}/${style}/${scope}: ${bad.join("; ")}`);
      }
    }
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.dataset.style = "poolside"; });
    await page.keyboard.press("Escape"); assert.deepEqual(failures, []);
  });
  await test("calculator repair scenarios have no uncaught page errors", cov, () => { assert.deepEqual(pageErrors, []); });
} finally {
  await context.close(); await browser.close();
  for (const [key, value] of Object.entries(previous)) if (value !== undefined) await api("PUT", "/api/settings", { key, value });
  const latest = await api("GET", "/api/state?id=default");
  if (currentState.row?.state) await api("PUT", "/api/state", { id: "default", revision: Number(latest.row?.revision ?? initialRevision + 1000) + 1000, state: currentState.row.state });
}
finish();
