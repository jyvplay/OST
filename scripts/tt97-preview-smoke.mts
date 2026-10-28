/** Read-only preview smoke: no database assertions, no writes except an in-memory calculation. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
const BASE = process.env.PREVIEW_BASE ?? "http://127.0.0.1:3000";
const browser = await launchChromium();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  const response = await page.goto(`${BASE}/?open=calculator`, { waitUntil: "domcontentloaded" });
  assert.equal(response?.status(), 200);
  const calc = page.locator('.fs-window[aria-label="Calculator"]'); await calc.getByLabel("Expression").waitFor({ timeout: 30_000 });
  await calc.getByLabel("Expression").fill("1e308 km to km");
  assert.equal((await calc.getByTestId("calculator-result").innerText()).trim(), "= 1e+308 km");
  await calc.getByLabel("Expression").fill("1e308 km to mm");
  assert.match(await calc.getByTestId("calculator-result").innerText(), /not a finite number/);
  await calc.getByRole("button", { name: "Programmer", exact: true }).click();
  await calc.getByLabel("Word size").selectOption("64");
  await calc.getByLabel("Expression").fill("0xffffffffffffffff");
  assert.equal((await calc.getByTestId("calculator-result").innerText()).trim(), "= 18446744073709551615");
  await page.getByTitle("Command palette (Ctrl+Space)").click();
  const palette = page.getByRole("dialog", { name: "Command palette" }); await palette.waitFor();
  await palette.getByRole("button", { name: "actions", exact: true }).click();
  await palette.locator("input").fill("focus on");
  assert.ok(await palette.locator('[data-palette-action="focus"]').count() === 1, "palette offers the focus action");
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(`preview smoke ok: HTTP ${response?.status()}, conversions, 64-bit programmer, actions scope, 0 page errors`);
  await context.close();
} finally { await browser.close(); }
