/** Real Chromium against an explicitly disposable shell and PostgreSQL.
 * The browser storage getter is deliberately made to throw; this is a fault
 * injection, not a claim about every storage-denial implementation. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) {
  throw new Error("Exclusive disposable server/database required");
}
const BASE = process.env.BASE;
const title = `tt130-storage-denied-${randomUUID()}`;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const browser = await launchChromium();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const { test, finish } = makeHarness("e2e-tt130-privacy");
try {
  await test("explicit amnesic boot refuses host writes when localStorage access throws", { "SC-11": "partial" }, async () => {
    assert.equal((await db.query("select count(*)::int n from notes where title=$1", [title])).rows[0].n, 0, "fixture must be unoccupied");
    await context.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() { throw new DOMException("storage denied by test", "SecurityError"); },
      });
    });
    const page = await context.newPage(); page.setDefaultTimeout(15_000);
    await page.goto(`${BASE}/?amnesia=1`, { waitUntil: "domcontentloaded" });
    // A working interactive launcher establishes client hydration regardless of
    // whether the amnesic badge exists on a broken build.
    await page.getByTestId("launcher-button").click();
    await page.getByRole("dialog", { name: "Launcher" }).waitFor();
    const response = await page.evaluate(async (name) => {
      const r = await fetch("/api/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: name, body: "fault-injection fixture" }) });
      return r.status;
    }, title);
    const hostCount = (await db.query("select count(*)::int n from notes where title=$1", [title])).rows[0].n;
    assert.equal(response, 423, `the page must refuse the write; host rows=${hostCount}`);
    assert.equal(hostCount, 0, "the private write must not reach PostgreSQL");
    await page.getByTestId("amnesic-badge").first().waitFor();
  });
} finally {
  await context.close(); await browser.close();
  // The deliberately vulnerable baseline can create this one unique fixture.
  await db.query("delete from index_docs where source='note' and ref in (select id::text from notes where title=$1)", [title]);
  await db.query("delete from notes where title=$1", [title]);
  await db.end();
}
finish();
