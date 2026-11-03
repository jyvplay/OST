/** TT122 — mechanism e2e. Same contract as e2e-tt121: real Chromium, real
 * production server, real VFS data, controls by accessible name/testid. */
import assert from "node:assert/strict";
import { expect } from "playwright/test";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database and BASE required");
}
const BASE = process.env.BASE!;
const { test, finish } = makeHarness("e2e-tt122");
async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  assert.equal(r.ok, true, `${method} ${path}: HTTP ${r.status}`);
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
  await page.waitForFunction(() => {
    const body = document.querySelector('[data-win-id="w1"] .fs-winbody');
    return body && body.children.length > 0 && !/^Loading[.…\s]*$/.test(body.textContent?.trim() ?? "");
  });
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
  // A real persisted, non-heading Unicode title catches the old oracle's
  // incorrect assumption that titles are exported as Markdown headings.
  const owned = await api<{ row: { id: number; revision: number } }>("POST", "/api/notes", {
    title: `TT134 bundle: # literal μ 🧭 ${Date.now().toString(36)}`, body: "Bundle proof, not a heading.\nSecond line: μ 🧭\n", tags: "bundle,unicode",
  });
  const notes = await openModule("notes");
  try {
  const persisted = await api<{ rows: { title: string; body: string }[] }>("GET", "/api/notes");
  // Use the actual visible More disclosure, not a hidden or force-clicked button.
  const more = notes.page.locator('[data-testid="note-editor"] details').filter({ has: notes.page.getByTestId("notes-bundle") });
  await more.locator(":scope > summary").click();
  await expect(notes.page.getByTestId("notes-bundle")).toBeVisible();
  const written = notes.page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== "/api/fs" || response.request().method() !== "POST") return false;
    try { const b = response.request().postDataJSON(); return b.op === "write" && b.path === "/notes-bundle.md"; } catch { return false; }
  });
  await notes.page.getByTestId("notes-bundle").click(); assert.equal((await written).status(), 200);
  const bundle = await api<{ node?: { content?: string } }>("GET", "/api/fs?op=read&path=" + encodeURIComponent("/notes-bundle.md"));
  const content = bundle.node?.content ?? "";
  assert.ok(content.includes("# Notes bundle"), "bundle file written to the VFS root");
  assert.ok(content.includes(`· ${persisted.rows.length} note`), "bundle count matches the real persisted snapshot");
  for (const note of persisted.rows) { assert.ok(content.includes(`\ntitle: ${note.title}\n`), "saved front-matter title retained in real bundle"); assert.ok(content.includes(note.body), "saved body retained in real bundle"); }
  } finally {
    await notes.context.close(); await api("DELETE", `/api/notes?id=${owned.row.id}`, { expectedRevision: owned.row.revision });
  }

  const media = await openModule("media");
  await media.page.getByTestId("media-loop").click();
  await expect.poll(() => media.page.evaluate(() => {
    const element = document.querySelector('[data-win-id="w1"] video'); return element instanceof HTMLMediaElement && element.loop;
  }), { message: "the toggle drives the actual media element's loop property" }).toBe(true);
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
