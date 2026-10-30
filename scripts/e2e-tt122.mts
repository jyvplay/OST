/** TT122 — mechanism e2e. Same contract as e2e-tt121: real Chromium, real
 * production server, real VFS data, controls by accessible name/testid. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt122");
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

await test("PK-01/ED-06: peek facts agree with wc; editor wrap changes the textarea style", { "PK-01": "full", "ED-06": "full" }, async () => {
  await api("POST", "/api/fs", { op: "write", path: "/tt122.txt", content: "alpha beta\ngamma\n", reason: "e2e-tt122" });
  const peek = await openModule("peek", { path: "/tt122.txt" });
  await peek.page.waitForFunction(() => document.querySelector('[data-testid="peek-facts"]')?.textContent?.includes("2 lines · 3 words"));
  await peek.context.close();

  const ed = await openModule("editor", { path: "/tt122.txt" });
  await ed.page.waitForFunction(() => (document.querySelector('[data-win-id="w1"] textarea') as HTMLTextAreaElement)?.value.includes("gamma"));
  const before = await ed.page.evaluate(() => getComputedStyle(document.querySelector('[data-win-id="w1"] textarea')!).whiteSpace);
  await ed.page.getByRole("button", { name: "Wrap", exact: true }).click();
  const after = await ed.page.evaluate(() => getComputedStyle(document.querySelector('[data-win-id="w1"] textarea')!).whiteSpace);
  assert.notEqual(after, before, "wrap toggle changes white-space");
  assert.equal(after, "pre-wrap");
  await ed.context.close();
});

await test("NT-06/MD-11/CK-06: bundle export lands in Files; loop toggles the element; laps copy appears", { "NT-06": "full", "MD-11": "full", "CK-06": "full" }, async () => {
  const notes = await openModule("notes");
  await notes.page.getByTestId("notes-bundle").click();
  await notes.page.waitForTimeout(800);
  const bundle = await api<{ node?: { content?: string } }>("GET", "/api/fs?op=read&path=" + encodeURIComponent("/notes-bundle.md"));
  assert.ok((bundle.node?.content ?? "").includes("# Notes bundle"), "bundle file written to the VFS root");
  await notes.context.close();

  const media = await openModule("media");
  await media.page.getByTestId("media-loop").click();
  const loop = await media.page.evaluate(() => document.querySelector('[data-win-id="w1"] video')?.loop);
  assert.equal(loop, true, "the toggle drives the element's loop property");
  await media.context.close();

  const clock = await openModule("clock");
  await clock.page.getByRole("button", { name: "Start stopwatch" }).click();
  await clock.page.waitForTimeout(1300);
  await clock.page.getByRole("button", { name: "Lap" }).click();
  await clock.page.waitForFunction(() => document.querySelector('[data-testid="clock-copy-laps"]') !== null);
  await clock.context.close();
});

await test("DV-01/CP-01/BK-10/SP-02 controls render: battery card, capture delay, backup inventory, family progress", { "DV-01": "full", "CP-01": "full", "BK-10": "full", "SP-02": "full" }, async () => {
  const devices = await openModule("devices");
  await devices.page.waitForFunction(() => {
    const t = document.querySelector('[data-win-id="w1"]')?.textContent ?? "";
    return t.includes("Battery") && (t.includes("%") || t.includes("not offered") || t.includes("checking"));
  });
  await devices.context.close();

  const capture = await openModule("capture");
  await capture.page.getByTestId("capture-delay").selectOption("3");
  const delayVal = await capture.page.getByTestId("capture-delay").inputValue();
  assert.equal(delayVal, "3");
  await capture.context.close();

  const backup = await openModule("backup");
  const invText = await backup.page.evaluate(() => document.querySelector('[data-win-id="w1"]')?.textContent ?? "");
  assert.match(invText, /Backups saved in Files/, "inventory section renders");
  await backup.context.close();

  const spec = await openModule("spec");
  await spec.page.waitForFunction(() => document.querySelector('[data-testid="spec-family-progress"]')?.textContent?.includes("%"), null, { timeout: 15_000 });
  await spec.context.close();
});

await browser.close();
finish();
