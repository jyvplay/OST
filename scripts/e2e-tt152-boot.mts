/** Strict Mode boot race: delay the live bootstrap while allowing the cancelled
 * setup to finish. Requires the actual development server (production React
 * does not replay effects), and a disposable database for shell state writes. */
import assert from "node:assert/strict";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import pg from "pg";
if (!process.env.BASE || !process.env.DATABASE_URL || process.env.TT89_DISPOSABLE_DATABASE !== "1") throw new Error("BASE, DATABASE_URL and exclusive disposable database required");
const { test, finish } = makeHarness("e2e-tt152-boot");
const browser = await launchChromium();
await test("superseded bootstrap cannot consume a cold-start launch intent", { "SH-13": "partial" }, async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let second!: () => void;
  const secondSeen = new Promise<void>(resolve => { second = resolve; });
  let calls = 0;
  const desk = `tt152-${Date.now().toString(36)}`;
  try {
    await page.route("**/api/bootstrap", async route => {
      calls++;
      if (calls === 2) { second(); await gate; }
      await route.continue().catch(() => undefined);
    });
    const errors: string[] = [];
    page.on("pageerror", e => errors.push(e.message));
    const oldStateRead = page.waitForResponse(r => r.url().includes(`/api/state?id=${desk}`) && r.request().method() === "GET", { timeout: 30000 });
    await page.goto(`${process.env.BASE}/?desk=${desk}&open=sheet`, { waitUntil: "domcontentloaded" });
    await Promise.race([secondSeen, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("React Strict Mode did not issue two bootstraps; run against next dev")), 20_000))]);
    // The first setup has read its state; the live setup is still blocked.
    await oldStateRead;
    await page.waitForTimeout(500);
    assert.equal(new URL(page.url()).searchParams.get("open"), "sheet", "cancelled setup consumed the intent");
    assert.equal(await page.getByRole("dialog", { name: "Spreadsheet", exact: true }).count(), 0, "cancelled setup opened a window");
    const saved = page.waitForResponse(r => r.url().endsWith("/api/state") && r.request().method() === "PUT" && r.status() === 200 && r.request().postData()?.includes(desk) === true, { timeout: 30000 }).then(() => null, error => error as Error);
    release();
    const sheet = page.getByRole("dialog", { name: "Spreadsheet", exact: true });
    await sheet.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 30000 });
    assert.equal(await sheet.count(), 1, "live setup must open exactly one window");
    assert.equal(new URL(page.url()).searchParams.has("open"), false, "live setup consumes the intent");
    assert.equal(new URL(page.url()).searchParams.get("desk"), desk, "named desktop survives intent consumption");
    const saveError = await saved;
    if (saveError) throw saveError;
    await page.reload({ waitUntil: "domcontentloaded" });
    await sheet.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 30000 });
    assert.equal(await sheet.count(), 1, "reload restores exactly one window on the named desktop");
    assert.equal(new URL(page.url()).searchParams.get("desk"), desk);
    assert.deepEqual(errors, []);
  } finally {
    release();
    await context.close();
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    try { await pool.query("delete from desktop_state where id=$1", [desk]); }
    finally { await pool.end(); }
  }
});
await browser.close();
finish();
