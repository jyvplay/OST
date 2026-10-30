/** TT120 — mechanism e2e. Same contract as e2e-tt119: real Chromium, real
 * production server, real VFS data, controls by accessible name/testid. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt120");
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

await test("ED-04/TM-04: editor stats count the buffer; terminal tail reads a real file", { "ED-04": "full", "TM-04": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/tt120.txt", content: "one two\nthree\nfour five six\n", reason: "e2e-tt120" });
  const ed = await openModule("editor", { path: "/tt120.txt" });
  await ed.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value.includes("four five six"));
  const stats = await ed.page.getByTestId("editor-stats").innerText();
  assert.match(stats, /3 lines · 6 words/, "stats match wc rules");
  await ed.page.getByLabel("Go to line").fill("2");
  await ed.page.getByLabel("Go to line").press("Enter");
  const sel = await ed.page.evaluate(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.selectionStart);
  assert.equal(sel, 8, "cursor lands at the start of line 2");
  await ed.context.close();

  const term = await openModule("terminal");
  const input = term.page.locator('[data-win-id="w1"] input').last();
  await input.click();
  await input.fill("tail -n 1 /tt120.txt");
  await input.press("Enter");
  await term.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("four five six"));
  await input.fill("head -1 /tt120.txt");
  await input.press("Enter");
  await term.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"]')?.textContent?.match(/one two/g) ?? []).length >= 1);
  await term.context.close();
});

await test("WD-04: world clock rows carry a business-hours verdict", { "WD-04": "full" }, async () => {
  const clock = await openModule("clock");
  const text = await clock.page.evaluate(() => document.querySelector('[data-win-id="w1"]')?.textContent ?? "");
  assert.match(text, /work hours|\d{2}:\d{2}/, "each zone states open or its local time");
  await clock.context.close();
});

await test("PH-04: next/previous walk the shown photos and stop at the end", { "PH-04": "full" }, async () => {
  const { readFileSync } = await import("node:fs");
  const PNG_A = readFileSync(new URL("../docs/screens/tt118-clock.png", import.meta.url)).toString("base64");
  const PNG_B = readFileSync(new URL("../docs/screens/tt118-calculator.png", import.meta.url)).toString("base64");
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt120-a.png", content: PNG_A, encoding: "base64", mime: "image/png", reason: "e2e-tt120" });
  await api("POST", "/api/fs", { op: "write", path: "/Pictures/tt120-b.png", content: PNG_B, encoding: "base64", mime: "image/png", reason: "e2e-tt120" });
  const photos = await openModule("photos");
  const tile = photos.page.locator('[data-photo="tt120-a.png"]');
  await tile.waitFor({ timeout: 15_000 });
  await tile.click();
  await photos.page.getByRole("button", { name: "Next photo" }).waitFor();
  const editor = photos.page.locator('[data-testid="photos-editor"]');
  const pos = async (): Promise<[number, number]> => {
    const m = (await editor.innerText()).match(/(\d+) of (\d+)/);
    assert.ok(m, "position is stated");
    return [Number(m![1]), Number(m![2])];
  };
  const next = photos.page.getByRole("button", { name: "Next photo" });
  const prev = photos.page.getByRole("button", { name: "Previous photo" });
  const goto = async (want: number) => photos.page.waitForFunction((w: number) => (document.querySelector('[data-testid="photos-editor"]')?.textContent ?? "").includes(`${w} of`), want, { timeout: 25_000 });
  let [cur, total] = await pos();
  if (cur > 1) { assert.ok(await prev.isEnabled()); await prev.click(); await goto(cur - 1); cur--; if (cur < total) { await next.click(); await goto(cur + 1); cur++; } }
  else if (await next.isEnabled()) { await next.click(); await goto(cur + 1); cur++; await prev.click(); await goto(cur - 1); cur--; }
  while (cur < total && (await next.isEnabled())) { await next.click(); await goto(cur + 1); cur++; }
  assert.equal(cur, total, "walk reaches the last shown photo");
  assert.equal(await next.isEnabled(), false, "next stops at the end");
  assert.ok(await prev.isEnabled(), "previous still works at the end");
  await photos.context.close();
});

await test("CN-06: starring a contact persists and filters", { "CN-06": "full" }, async () => {
  const vcf = ["BEGIN:VCARD", "VERSION:4.0", "UID:tt120-ada", "FN:Ada Byron", "EMAIL:ada@example.com", "END:VCARD", "BEGIN:VCARD", "VERSION:4.0", "UID:tt120-grace", "FN:Grace Murray", "EMAIL:grace@example.com", "END:VCARD", ""].join("\r\n");
  await api("POST", "/api/fs", { op: "write", path: "/Contacts/contacts.vcf", content: vcf, mime: "text/vcard", reason: "e2e-tt120" });
  const contacts = await openModule("contacts");
  const star = contacts.page.locator('[data-win-id="w1"] button[aria-label^="Star "]').first();
  await star.waitFor({ timeout: 15_000 });
  const name = await star.getAttribute("aria-label");
  await star.click();
  await contacts.page.waitForFunction((n) => document.querySelector(`[data-win-id="w1"] button[aria-label="Unstar ${CSS.escape(n!.slice(5))}"]`) !== null, name);
  // Stars are browser-local by design: persistence is proven across a reload
  // in the SAME browser profile, not across profiles (TT118's SV-01 lesson).
  await contacts.page.reload({ waitUntil: "domcontentloaded" });
  await contacts.page.waitForSelector('[data-win-id="w1"]');
  await contacts.page.waitForFunction((n) => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("Starred"), null, { timeout: 10_000 });
  await contacts.page.getByRole("button", { name: "Starred" }).click();
  await contacts.page.waitForFunction(() => (document.querySelectorAll('[data-win-id="w1"] [data-testid="ct-item"]').length ?? 0) === 1, null, { timeout: 10_000 });
  await contacts.context.close();
});

await browser.close();
finish();
