/** TT119 — mechanism e2e. Same contract as e2e-tt118: real Chromium, real
 * production server, real VFS data, controls by accessible name/testid. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt119");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return await r.json() as T;
}
const browser = await launchChromium();
async function openModule(module: string, props: Record<string, unknown> = {}) {
  const cur = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(cur.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
  const context = await browser.newContext({ viewport: { width: 1500, height: 1040 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-win-id="w1"]');
  await page.waitForTimeout(1200);
  return { page, context };
}
import { readFileSync } from "node:fs";
const PNG_A = readFileSync(new URL("../docs/screens/tt118-clock.png", import.meta.url)).toString("base64");
const PNG_B = readFileSync(new URL("../docs/screens/tt118-calculator.png", import.meta.url)).toString("base64");

await test("ED-03/TM-03: editor replaces all; terminal wc counts a real file", { "ED-03": "full", "TM-03": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/tt119.txt", content: "alpha beta\nbeta gamma\n", reason: "e2e-tt119" });
  const ed = await openModule("editor", { path: "/tt119.txt" });
  const win = ed.page.locator('[data-win-id="w1"]');
  await ed.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value.includes("beta gamma"));
  await win.getByLabel("Find text").fill("beta");
  await win.getByRole("button", { name: "Count", exact: true }).click();
  await ed.page.waitForFunction(() => document.querySelector('[data-testid="editor-findbar"]')?.textContent?.includes("2 matches"));
  await win.getByLabel("Replace with").fill("BETA");
  await win.getByRole("button", { name: "Replace all" }).click();
  await ed.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value === "alpha BETA\nBETA gamma\n");
  await ed.context.close();

  const term = await openModule("terminal");
  const input = term.page.locator('[data-win-id="w1"] input').last();
  await input.click();
  await input.fill("wc /tt119.txt");
  await input.press("Enter");
  await term.page.waitForFunction(() => /2\s+4\s+22\s+\/tt119\.txt/.test(document.querySelector('[data-win-id="w1"]')?.textContent ?? ""));
  await term.context.close();
});

await test("CK-04/WD-03: a zone can be added; the converter answers with a date", { "CK-04": "full", "WD-03": "full" }, async () => {
  const clock = await openModule("clock");
  const conv = clock.page.getByTestId("clock-zone-convert");
  await conv.waitFor();
  assert.match(await conv.innerText(), /\d{2}:\d{2}/, "converted time rendered");
  const sel = clock.page.getByLabel("Add world zone");
  await sel.selectOption("Pacific/Auckland");
  await clock.page.getByRole("button", { name: "Add zone" }).click();
  await clock.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("Pacific/Auckland"));
  await clock.context.close();
  const again = await openModule("clock");
  await again.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("Pacific/Auckland"), null, { timeout: 10_000 });
  await again.context.close();
});

await test("PL-04: filtering to gibberish reports no match, not an empty planner", { "PL-04": "full" }, async () => {
  await api("POST", "/api/tasks", { title: "TT119 filter probe", dueAt: null });
  const planner = await openModule("planner");
  await planner.page.getByLabel("Filter tasks").fill("zzz-no-such-task");
  await planner.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("No tasks match the filter."));
  await planner.page.getByLabel("Filter tasks").fill("TT119");
  await planner.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("TT119 filter probe"));
  await planner.context.close();
});

await test("PH-03/SR-09: slideshow starts on a seeded library; a search becomes recent", { "PH-03": "full", "SR-09": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt119-a.png", content: PNG_A, encoding: "base64", mime: "image/png", reason: "e2e-tt119" });
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt119-b.png", content: PNG_B, encoding: "base64", mime: "image/png", reason: "e2e-tt119" });
  const photos = await openModule("photos");
  const play = photos.page.getByRole("button", { name: "Play slideshow" });
  await play.waitFor({ timeout: 15_000 });
  await play.click();
  await photos.page.getByRole("button", { name: "Pause show" }).waitFor();
  await photos.context.close();

  const find = await openModule("find");
  const win = find.page.locator('[data-win-id="w1"]');
  await win.getByLabel("Search query").fill("tt119probe");
  await win.getByRole("button", { name: "Search", exact: true }).click();
  await find.page.getByTestId("find-recents").waitFor();
  assert.match(await find.page.getByTestId("find-recents").innerText(), /tt119probe/);
  await find.context.close();
});

await browser.close();
finish();
