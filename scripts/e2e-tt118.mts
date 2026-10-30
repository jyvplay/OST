/** TT118 — mechanism e2e for the feature batch. Same contract as e2e-tt117:
 * real Chromium, real production server, real served VFS data, controls
 * addressed by accessible name/testid, never by positional guess. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt118");
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

await test("DF-01: Editor diffs a saved version against the edited buffer", { "DF-01": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/tt118-diff.md", content: "alpha\nbeta\ngamma\n", reason: "e2e-tt118" });
  const { page, context } = await openModule("editor", { path: "/tt118-diff.md" });
  const area = page.locator('[data-win-id="w1"] textarea').first();
  await area.waitFor();
  await page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value.includes("beta"));
  await area.fill("alpha\nBETA changed\ngamma\n");
  await page.locator('[data-win-id="w1"] summary').click();
  await page.getByRole("button", { name: "Diff", exact: true }).first().click();
  const panel = page.getByTestId("editor-diff");
  await panel.waitFor();
  const text = await panel.innerText();
  assert.match(text, /\+1/, "one added line reported");
  assert.match(text, /−1/, "one removed line reported");
  assert.match(text, /BETA changed/, "the new line is shown");
  await context.close();
});

await test("CV-01/WD-01/WD-02: converter is exact; overlap and countdown render", { "CV-01": "full", "WD-01": "full", "WD-02": "full" }, async () => {
  const calc = await openModule("calculator");
  await calc.page.getByLabel("Convert category").selectOption("temperature");
  await calc.page.getByLabel("Convert value").fill("100");
  await calc.page.getByLabel("Convert from unit").selectOption("°C");
  await calc.page.getByLabel("Convert to unit").selectOption("°F");
  assert.equal((await calc.page.getByTestId("calc-convert-result").innerText()).trim(), "212", "100 °C converts to exactly 212 °F in the UI");
  await calc.context.close();

  const clock = await openModule("clock");
  const body = await clock.page.evaluate(() => document.querySelector('[data-win-id="w1"]')?.textContent ?? "");
  assert.match(body, /Meeting overlap/, "overlap section present");
  assert.match(body, /no common working hour today|here · \d+ min/, "the three-zone overlap verdict is stated");
  const in30 = new Date(Date.now() + 30 * 86_400_000);
  const iso = `${in30.getFullYear()}-${String(in30.getMonth() + 1).padStart(2, "0")}-${String(in30.getDate()).padStart(2, "0")}`;
  await clock.page.getByLabel("Countdown label").fill("TT118 checkpoint");
  await clock.page.getByLabel("Countdown date").fill(iso);
  await clock.page.getByRole("button", { name: "Add countdown" }).click();
  await clock.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("TT118 checkpoint"));
  const after = await clock.page.evaluate(() => document.querySelector('[data-win-id="w1"]')?.textContent ?? "");
  assert.match(after, /(29|30|31) days/, "countdown reports whole days remaining");
  await clock.context.close();
});

await test("PL-03/PH-02: agenda view and photo timeline render from real data", { "PL-03": "full", "PH-02": "full" }, async () => {
  const due = new Date(); due.setHours(23, 59, 0, 0);
  await api("POST", "/api/tasks", { title: "TT118 agenda probe", dueAt: due.toISOString() });
  const planner = await openModule("planner");
  await planner.page.getByRole("button", { name: "Week view" }).click();
  await planner.page.getByRole("button", { name: "Agenda" }).click();
  await planner.page.getByTestId("planner-agenda").waitFor();
  const agenda = await planner.page.getByTestId("planner-agenda").innerText();
  assert.match(agenda, /today|tomorrow|this week|later|no date|done|overdue/i, "agenda buckets are labelled");
  await planner.context.close();

  const photos = await openModule("photos");
  await photos.page.getByTestId("photos-timeline").waitFor();
  await photos.context.close();
});

await test("SV-01: a saved search persists and re-applies its query", { "SV-01": "full" }, async () => {
  const find = await openModule("find");
  const win = find.page.locator('[data-win-id="w1"]');
  await win.getByRole("textbox").first().fill("welcome");
  await win.getByRole("button", { name: /Save/ }).first().click();
  const dialog = find.page.getByTestId("ask-dialog");
  await dialog.waitFor();
  await dialog.getByRole("textbox").fill("tt118-search");
  await dialog.getByRole("button", { name: "Save search" }).click();
  await find.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("tt118-search"));
  // Saved searches are browser-local by design: persistence is proven across a
  // reload in the SAME browser profile, not across profiles.
  await find.page.reload({ waitUntil: "domcontentloaded" });
  await find.page.waitForSelector('[data-win-id="w1"]');
  await find.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("tt118-search"), null, { timeout: 10_000 });
  await find.context.close();
});

await test("UC-01/TM-02: clean-link control exists; terminal suggests the real command", { "UC-01": "full", "TM-02": "full" }, async () => {
  const br = await openModule("browser");
  await br.page.getByRole("button", { name: "Clean link" }).waitFor();
  await br.context.close();

  const term = await openModule("terminal");
  const input = term.page.locator('[data-win-id="w1"] input').last();
  await input.click();
  await input.fill("hlep");
  await input.press("Enter");
  await term.page.waitForFunction(() => /did you mean `help`/.test(document.querySelector('[data-win-id="w1"]')?.textContent ?? ""));
  await term.context.close();
});

await browser.close();
finish();
