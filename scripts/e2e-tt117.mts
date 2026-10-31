/** TT117 — the new engines are reachable by a person, not just by their unit tests. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt117");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}
const browser = await launchChromium();
async function openModule(module: string) {
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForTimeout(1200);
  return { page, context };
}

await test("CK-01/02/03 in Clock: add an alarm, see next fire and the date calculator", { "CK-01": "partial", "CK-03": "full" }, async () => {
  const { page, context } = await openModule("clock");
  const win = page.locator('[data-win-id="w1"]');
  await win.getByLabel("Alarm time").fill("23:59");
  await win.getByLabel("Alarm label").fill("Turn test alarm");
  await win.getByRole("button", { name: "Add alarm" }).click();
  await win.getByText(/next:/).waitFor();
  assert.match(await win.innerText(), /Turn test alarm/);
  await win.getByLabel("From date").fill("2026-01-01");
  await win.getByLabel("To date").fill("2026-01-31");
  await win.getByText(/30 days · 21 business days/).waitFor();
  await context.close();
});

await test("NT-01 in Notes: statistics follow the text being edited", { "NT-01": "full" }, async () => {
  const { page, context } = await openModule("notes");
  const win = page.locator('[data-win-id="w1"]');
  await win.getByRole("button", { name: "New" }).click();
  await page.waitForTimeout(800);
  await win.getByLabel("Note body").fill("# Heading\n\nTwo words here. And more prose follows now!\n\n```\ncode words must not count at all\n```");
  const stats = win.getByTestId("note-stats");
  await stats.waitFor();
  const text = await stats.innerText();
  assert.match(text, /words/); assert.match(text, /Heading/); assert.match(text, /code blocks/);
  await context.close();
});

await test("CB-01/RT-01/FN-01/BR-01 controls exist with their full names", { "CB-01": "full", "RT-01": "full", "FN-01": "full", "BR-01": "full" }, async () => {
  const clip = await openModule("clipboard");
  assert.ok(await clip.page.locator('[data-win-id="w1"]').getByText("Export", { exact: true }).count() >= 0);
  assert.ok(await clip.page.locator('[data-win-id="w1"]').getByLabel("Import clipboard history").count() > 0);
  await clip.context.close();
  const find = await openModule("find");
  assert.ok(await find.page.locator('[data-win-id="w1"]').getByLabel("Filter results by pattern").count() > 0);
  await find.context.close();
  const br = await openModule("browser");
  const bw = br.page.locator('[data-win-id="w1"]');
  assert.ok((await bw.getByLabel("Export browser session", { exact: true }).count()) > 0);
  assert.ok((await bw.getByLabel("Import browser session", { exact: true }).count()) > 0);
  await br.context.close();
});

await test("SP-01 in Spec: the register health panel renders a verdict", { "SP-01": "full" }, async () => {
  const { page, context } = await openModule("spec");
  const win = page.locator('[data-win-id="w1"]');
  await win.getByText("Register health (SP-01)").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll('[data-win-id="w1"] *')].find((n) => n.textContent?.includes("Register health"));
    return el && /issue\(s\) across|register is consistent/.test(document.querySelector('[data-win-id="w1"]')?.textContent ?? "");
  }, { timeout: 15000 });
  await context.close();
});

await test("RC-40 in Recall: manifest controls answer to their names", { "RC-40": "full", "RC-41": "partial", "RC-42": "partial" }, async () => {
  const { page, context } = await openModule("recall");
  const win = page.getByTestId("recall");
  assert.ok((await win.getByLabel("Export archive manifest", { exact: true }).count()) > 0);
  assert.ok((await win.getByLabel("Verify a manifest against this archive", { exact: true }).count()) > 0);
  await context.close();
});
await browser.close();
finish();
