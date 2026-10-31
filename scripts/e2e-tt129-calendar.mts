/** Real HTTP, browser UI and PostgreSQL import preflight. Requires an exclusive
 * disposable database; random UIDs are checked absent and cleaned after use. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE, tag = randomBytes(10).toString("hex"), ids = [`tt129-${tag}-a@test`, `tt129-${tag}-b@test`];
const titles = [`tt129-${tag}-zoned`, `tt129-${tag}-invalid`];
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const browser = await launchChromium(); const { test, finish } = makeHarness("e2e-tt129-calendar");
async function call(method: string, path: string, body?: unknown) {
  const response = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`); return response.json();
}
const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTIMEZONE", "TZID:America/New_York", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0300", "TZOFFSETTO:+0300", "END:STANDARD", "END:VTIMEZONE", "BEGIN:VEVENT", `UID:${ids[0]}`, `SUMMARY:${titles[0]}`, "DTSTART;TZID=America/New_York:20261102T090000", "RRULE:FREQ=WEEKLY;COUNT=2", "EXDATE:20261109T090000Z", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:alert", "TRIGGER:-PT5M", "END:VALARM", "END:VEVENT", "BEGIN:VTODO", `UID:${ids[1]}`, `SUMMARY:${titles[1]}`, "DUE:20260230T100000Z", "END:VTODO", "END:VCALENDAR", ""].join("\r\n");
let original: unknown, stateChanged = false, own = false;
const createdIds: number[] = [];
try {
  assert.equal((await db.query("SELECT 1 FROM tasks WHERE uid=ANY($1)", [ids])).rowCount, 0);
  // Confirm the HTTP server and the specified database are the same one.
  const probe = await call("POST", "/api/tasks", { title: `tt129-probe-${tag}` });
  try { const row = await db.query("SELECT title FROM tasks WHERE id=$1", [probe.row.id]); assert.equal(row.rows[0]?.title, `tt129-probe-${tag}`); }
  finally { await call("DELETE", `/api/tasks?id=${probe.row.id}`); }
  own = true;
  const state = await call("GET", "/api/state?id=default"); original = state.row?.state;
  await call("PUT", "/api/state", { id: "default", revision: Number(state.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module: "planner", title: "Planner", x: 20, y: 16, w: 1100, h: 800, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } }); stateChanged = true;
  await test("preview reports known losses without inserting records", { "PR-04": "partial" }, async () => {
    const review = await call("POST", "/api/tasks", { ics, preview: true });
    assert.equal((await db.query("SELECT 1 FROM tasks WHERE uid=ANY($1)", [ids])).rowCount, 0, "preflight must not write any items");
    assert.equal(review.parsed, 2); assert.equal(typeof review.serverTimeZone, "string");
    const warnings = Object.fromEntries(review.warnings.map((w: { code: string; items: number }) => [w.code, w.items]));
    assert.deepEqual(warnings, { timezone: 1, recurrence: 1, exceptions: 1, alarms: 1, invalidDate: 1 });
  });
  await test("cancel is non-mutating, same-file retry imports only after confirmation, reimport deduplicates", { "PR-04": "partial" }, async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(20_000); await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const input = page.locator('input[type="file"][accept*=".ics"]');
      const file = { name: "calendar.ics", mimeType: "text/calendar", buffer: Buffer.from(ics) };
      await input.setInputFiles(file);
      await page.getByRole("button", { name: "Import anyway" }).waitFor();
      if (process.env.TT129_CAPTURE === "1") await page.screenshot({ path: "docs/screens/tt129-calendar-review.png" });
      assert.match(await page.locator("body").innerText(), /TZID and embedded timezone definitions are ignored/);
      assert.match(await page.locator("body").innerText(), /Invalid or unrepresentable dates may become undated/);
      assert.equal((await db.query("SELECT 1 FROM tasks WHERE uid=ANY($1)", [ids])).rowCount, 0);
      await page.getByRole("button", { name: "Cancel import" }).click();
      assert.equal((await db.query("SELECT 1 FROM tasks WHERE uid=ANY($1)", [ids])).rowCount, 0);
      await input.setInputFiles(file); await page.getByRole("button", { name: "Import anyway" }).waitFor();
      const imported = page.waitForResponse((r) => r.url().includes("/api/tasks") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Import anyway" }).click();
      const result = await (await imported).json(); assert.equal(result.added, 2); assert.equal(result.skipped, 0);
      await page.getByText(titles[0], { exact: true }).waitFor();
      const rows = await db.query("SELECT uid,due_at FROM tasks WHERE uid=ANY($1) ORDER BY uid", [ids]);
      assert.equal(rows.rowCount, 2); assert.equal(rows.rows.find((r) => r.uid === ids[1]).due_at, null);
      await input.setInputFiles(file); await page.getByRole("button", { name: "Import anyway" }).waitFor();
      const repeated = page.waitForResponse((r) => r.url().includes("/api/tasks") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Import anyway" }).click();
      const again = await (await repeated).json(); assert.equal(again.added, 0); assert.equal(again.skipped, 2);
      assert.equal((await db.query("SELECT 1 FROM tasks WHERE uid=ANY($1)", [ids])).rowCount, 2);
    } finally { await context.close(); }
  });
  await test("overdue status updates when the clock passes a due time without another interaction", { "PR-03": "partial" }, async () => {
    const title = `tt129-clock-${tag}`;
    const row = await call("POST", "/api/tasks", { title, dueAt: "2030-01-01T00:00:30.000Z" }); createdIds.push(row.row.id);
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(20_000);
      // Controlled browser clock; the HTTP server and PostgreSQL remain real.
      await page.clock.install({ time: new Date("2030-01-01T00:00:00.000Z") });
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      const task = page.locator(".fs-list-item").filter({ hasText: title }); await task.waitFor();
      assert.equal(await task.locator(".fs-badge").getAttribute("data-tone"), "info");
      await page.clock.fastForward("01:01");
      await page.waitForFunction((name) => {
        const row = [...document.querySelectorAll(".fs-list-item")].find((el) => el.textContent?.includes(name));
        return row?.querySelector(".fs-badge")?.getAttribute("data-tone") === "bad";
      }, title, { timeout: 5_000 });
    } finally { await context.close(); }
  });
} finally {
  await browser.close();
  for (const id of createdIds) await call("DELETE", `/api/tasks?id=${id}`);
  if (own) await db.query("DELETE FROM tasks WHERE uid=ANY($1)", [ids]);
  if (stateChanged && original) { const current = await call("GET", "/api/state?id=default"); await call("PUT", "/api/state", { id: "default", revision: Number(current.row?.revision ?? 1) + 1000, state: original }); }
  await db.end(); finish();
}
