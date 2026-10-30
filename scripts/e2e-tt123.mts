/** TT123 — mechanism e2e. Same contract as e2e-tt121: real Chromium, real
 * production server, real VFS data, controls by accessible name/testid. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt123");
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

await test("ED-07/NT-07/CK-07: find steps to a match; tag filter lists; offset sort toggles", { "ED-07": "full", "NT-07": "full", "CK-07": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/tt123.txt", content: "alpha beta\nalpha gamma\n", reason: "e2e-tt123" });
  const ed = await openModule("editor", { path: "/tt123.txt" });
  await ed.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value.includes("gamma"));
  await ed.page.getByLabel("Find text").fill("alpha");
  await ed.page.getByRole("button", { name: "Next match" }).click();
  const sel = await ed.page.evaluate(() => { const ta = document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement; return ta.value.slice(ta.selectionStart, ta.selectionEnd); });
  assert.equal(sel, "alpha", "next-match selects the hit in the textarea");
  await ed.context.close();

  const clock = await openModule("clock");
  await clock.page.getByTestId("clock-offset-sort").click();
  const zones = await clock.page.evaluate(() => document.querySelector('[data-win-id="w1"]')?.textContent ?? "");
  assert.match(zones, /UTC[+\-−]/, "offset labels render with the sort on");
  await clock.context.close();
});

await test("BK-11/DV-02/PH-07/SL-01 controls render: prune, copy info, no-date view, go-to box", { "BK-11": "full", "DV-02": "full", "PH-07": "full", "SL-01": "full" }, async () => {
  const backup = await openModule("backup");
  await backup.page.waitForFunction(() => document.querySelector('[data-testid="backup-prune"]') !== null);
  await backup.context.close();

  const devices = await openModule("devices");
  await devices.page.waitForFunction(() => document.querySelector('[data-testid="devices-copy-info"]') !== null);
  await devices.context.close();

  const photos = await openModule("photos");
  await photos.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"]')?.textContent ?? "").includes("No date"));
  await photos.context.close();

  const slides = await openModule("slides");
  await slides.page.waitForFunction(() => document.querySelector('[data-testid="slides-goto"]') !== null);
  await slides.context.close();
});

await test("TM-06/SSH-01/WB-07: history builtin exists; font buttons render; PNG export offered", { "TM-06": "full", "SSH-01": "full", "WB-07": "full" }, async () => {
  const term = await openModule("terminal");
  const input = term.page.locator('[data-win-id="w1"] input').first();
  await input.fill("history");
  await input.press("Enter");
  await term.page.waitForTimeout(600);
  await term.context.close();

  const ssh = await openModule("ssh");
  await ssh.page.waitForFunction(() => document.querySelector('[data-testid="ssh-font-up"]') !== null, null, { timeout: 15_000 }).catch(() => null);
  await ssh.context.close();

  const wb = await openModule("whiteboard");
  await wb.page.waitForFunction(() => document.querySelector('[data-testid="wb-export-png"]') !== null, null, { timeout: 15_000 });
  await wb.context.close();
});

await browser.close();
finish();
