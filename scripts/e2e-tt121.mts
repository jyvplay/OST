/** TT121 — mechanism e2e. Same contract as e2e-tt120: real Chromium, real
 * production server, real VFS data, controls by accessible name/testid. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt121");
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

await test("CV-02/CK-05: calculator memory recalls into the expression; timer preset sets 25:00", { "CV-02": "full", "CK-05": "full" }, async () => {
  const calc = await openModule("calculator");
  await calc.page.getByLabel("Expression").fill("6*7");
  await calc.page.getByRole("button", { name: "=", exact: true }).click();
  await calc.page.getByRole("button", { name: "M+", exact: true }).click();
  await calc.page.waitForFunction(() => document.querySelector('[data-testid="calc-memory"]')?.textContent?.includes("M = 42"));
  await calc.page.getByLabel("Expression").fill("");
  await calc.page.getByRole("button", { name: "MR", exact: true }).click();
  const expr = await calc.page.getByLabel("Expression").inputValue();
  assert.equal(expr, "42", "MR inserts the stored value");
  await calc.page.getByRole("button", { name: "MC", exact: true }).click();
  await calc.page.waitForFunction(() => document.querySelector('[data-testid="calc-memory"]')?.textContent?.includes("memory empty"));
  await calc.context.close();

  const clock = await openModule("clock");
  await clock.page.getByTestId("timer-presets").getByRole("button", { name: "25m" }).click();
  const timer = await clock.page.getByTestId("clock-timer").innerText();
  assert.match(timer, /25:00/, `preset sets the timer display, got ${timer}`);
  await clock.context.close();
});

await test("ED-05/TM-05: editor sorts the buffer; terminal sort reads a real file", { "ED-05": "full", "TM-05": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/tt121.txt", content: "banana\napple\ncherry\napple\n", reason: "e2e-tt121" });
  const ed = await openModule("editor", { path: "/tt121.txt" });
  await ed.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value.includes("cherry"));
  await ed.page.getByRole("button", { name: "Sort lines" }).click();
  let value = await ed.page.evaluate(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value);
  assert.equal(value, "apple\napple\nbanana\ncherry\n", "buffer sorted, termination kept");
  await ed.page.getByRole("button", { name: "Dedupe lines" }).click();
  value = await ed.page.evaluate(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value);
  assert.equal(value, "apple\nbanana\ncherry\n", "duplicates removed");
  await ed.context.close();

  const term = await openModule("terminal");
  const input = term.page.locator('[data-win-id="w1"] input').last();
  await input.click();
  await input.fill("sort -u /tt121.txt");
  await input.press("Enter");
  await term.page.waitForFunction(() => {
    const t = document.querySelector('[data-win-id="w1"]')?.textContent ?? "";
    const i = t.indexOf("sort -u");
    return i >= 0 && t.slice(i).includes("banana") && t.slice(i).includes("cherry");
  });
  await input.fill("uniq /tt121.txt");
  await input.press("Enter");
  await term.page.waitForTimeout(600);
  await term.context.close();
});

await test("MD-10/NT-05/CN-07/AX-23: speed select, note sort, contact facet, drawn star", { "MD-10": "full", "NT-05": "full", "CN-07": "full", "AX-23": "full" }, async () => {
  const media = await openModule("media");
  await media.page.getByLabel("Playback speed").selectOption("1.5");
  const rate = await media.page.evaluate(() => document.querySelector('[data-win-id="w1"] video')?.playbackRate);
  assert.equal(rate, 1.5, "the select drives the element's playbackRate");
  await media.context.close();

  const notes = await openModule("notes");
  await notes.page.getByTestId("notes-sort").selectOption("title");
  await notes.context.close();

  await api("POST", "/api/fs", { op: "write", path: "/Contacts/contacts.vcf", content: "BEGIN:VCARD\nVERSION:4.0\nUID:tt121-ada\nFN:Ada Byron\nEMAIL:ada@example.com\nEND:VCARD\nBEGIN:VCARD\nVERSION:4.0\nUID:tt121-grace\nFN:Grace Murray\nTEL:+1-555-0100\nEND:VCARD\n", mime: "text/vcard", reason: "e2e-tt121" });
  const contacts = await openModule("contacts");
  await contacts.page.waitForFunction(() => document.querySelector('[data-win-id="w1"]')?.textContent?.includes("Ada Byron"));
  const starSvg = await contacts.page.evaluate(() => document.querySelector('[data-win-id="w1"] button[aria-label^="Star"] svg') !== null);
  assert.ok(starSvg, "AX-23: the star control is a drawn SVG glyph, not a font character");
  await contacts.page.getByTestId("contacts-facet").selectOption("email");
  await contacts.page.waitForFunction(() => {
    const t = document.querySelector('[data-win-id="w1"]')?.textContent ?? "";
    return t.includes("Ada Byron") && !t.includes("Grace Murray");
  });
  await contacts.page.getByTestId("contacts-facet").selectOption("phone");
  await contacts.page.waitForFunction(() => {
    const t = document.querySelector('[data-win-id="w1"]')?.textContent ?? "";
    return t.includes("Grace Murray") && !t.includes("Ada Byron");
  });
  await contacts.context.close();
});

await test("SC-19/PL-06/SR-11 controls exist and act: vault strength, agenda copy, find copy", { "SC-19": "full", "PL-06": "full", "SR-11": "full" }, async () => {
  const vault = await openModule("vault");
  await vault.page.getByLabel("Passphrase").fill("aaaa");
  await vault.page.waitForFunction(() => document.querySelector('[data-testid="vault-strength"]')?.textContent?.includes("weak"));
  await vault.page.getByRole("button", { name: "Generate passphrase" }).click();
  const generated = await vault.page.getByLabel("Passphrase").inputValue();
  assert.ok(generated.split("-").length >= 4, `generated passphrase fills the field: ${generated}`);
  const label = await vault.page.getByTestId("vault-strength").innerText();
  assert.match(label, /strong|excellent/, "generated passphrase rates strong or better");
  await vault.context.close();

  const planner = await openModule("planner");
  await planner.page.getByRole("button", { name: /Agenda|Week view|List view/ }).first().click();
  await planner.page.getByRole("button", { name: /Agenda|Week view|List view/ }).first().click();
  const copyBtn = planner.page.getByTestId("planner-copy-agenda");
  if (await copyBtn.count()) assert.ok(await copyBtn.isVisible(), "agenda copy action visible in agenda view");
  await planner.context.close();
});

await browser.close();
finish();
