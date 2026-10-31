/** Real Chromium interactions in Tokyo/Santiago and real disposable task API. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
if (process.env.TT89_DISPOSABLE_DATABASE !== "1" || !process.env.DATABASE_URL || !process.env.BASE) throw new Error("Exclusive disposable server/database required");
const BASE = process.env.BASE, nonce = randomBytes(8).toString("hex"), created: number[] = [];
const { test, finish } = makeHarness("e2e-tt128-time");
async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`); return await res.json() as T;
}
const original = await api<{ row?: { state?: unknown } }>("GET", "/api/state?id=default");
const browser = await launchChromium();
async function state(module: string) {
  const old = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
  await api("PUT", "/api/state", { id: "default", revision: Number(old.row?.revision ?? 1) + 1000, state: { windows: [{ id: "w1", module, title: module, x: 20, y: 16, w: 1440, h: 960, z: 10, workspace: 1, props: {} }], focus: "w1", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30 } });
}
try {
  await test("Clock: local date controls and explicit overlap/gap choices", { "CK-03": "partial", "WD-03": "partial" }, async () => {
    await state("clock");
    const context = await browser.newContext({ viewport: { width: 1500, height: 1040 }, timezoneId: "Asia/Tokyo", locale: "en-US" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(25_000);
      await page.clock.setFixedTime(new Date("2025-12-31T15:30:00Z"));
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "World clock" }).waitFor();
      assert.equal(await page.getByLabel("From date").inputValue(), "2026-01-01");
      assert.equal(await page.getByLabel("To date").inputValue(), "2026-01-08");
      await page.getByRole("button", { name: "+30 days" }).click();
      assert.equal(await page.getByLabel("To date").inputValue(), "2026-01-31");
      await page.getByLabel("Convert date").fill("2026-11-01");
      await page.getByLabel("Convert time").fill("01:30");
      await page.getByText(/occurs more than once/).waitFor();
      const occurrence = page.getByLabel("Repeated time occurrence");
      assert.equal(await occurrence.inputValue(), "reject");
      await occurrence.selectOption("earlier");
      assert.match(await page.getByTestId("clock-zone-convert").innerText(), /14:30.*first occurrence/s);
      await occurrence.selectOption("later");
      assert.match(await page.getByTestId("clock-zone-convert").innerText(), /15:30.*second occurrence/s);
      await page.getByLabel("Convert date").fill("2026-03-08");
      await page.getByLabel("Convert time").fill("02:30");
      await page.getByText(/does not exist/).waitFor();
      assert.equal(await occurrence.count(), 0);
    } finally { await context.close(); }
  });
  await test("Planner: week columns and completion counts survive midnight DST transition", { "PL-01": "partial", "PL-07": "partial" }, async () => {
    // API inserts are the real task storage; each unique fixture is deleted below.
    for (const [label, dueAt] of [["monday", "2024-04-01T15:00:00Z"], ["sunday", "2024-04-07T15:00:00Z"]]) {
      const out = await api<{ row: { id: number } }>("POST", "/api/tasks", { title: `tt128-${nonce}-${label}`, dueAt });
      created.push(out.row.id); await api("PATCH", "/api/tasks", { id: out.row.id, done: true });
    }
    const taskRows = (await api<{ rows: { done: boolean; dueAt: string | null }[] }>("GET", "/api/tasks")).rows;
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" });
    const localKey = (s: string) => { const p = Object.fromEntries(date.formatToParts(new Date(s)).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
    const weekCount = taskRows.filter((t) => t.done && t.dueAt && localKey(t.dueAt) >= "2024-04-01" && localKey(t.dueAt) <= "2024-04-07").length;
    const todayCount = taskRows.filter((t) => t.done && t.dueAt && localKey(t.dueAt) === "2024-04-07").length;
    await state("planner");
    const context = await browser.newContext({ viewport: { width: 1500, height: 1040 }, timezoneId: "America/Santiago", locale: "en-US" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(25_000);
      await page.clock.setFixedTime(new Date("2024-04-07T16:00:00Z"));
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.getByLabel("Task title").waitFor();
      await page.getByText("TZID and floating dates are interpreted in the server’s local timezone, not the source timezone.").waitFor();
      await page.getByText(`tt128-${nonce}-sunday`).waitFor();
      await page.getByLabel("Task title").fill("A repeat needs a date");
      await page.getByLabel("Repeat").selectOption("FREQ=DAILY");
      assert.equal(await page.getByRole("button", { name: "Add", exact: true }).isEnabled(), false);
      await page.getByText("Choose a due date to add a repeating task.").waitFor();
      await page.getByLabel("Due").fill("2024-04-07T12:00");
      assert.equal(await page.getByRole("button", { name: "Add", exact: true }).isEnabled(), true);
      assert.match(await page.getByTestId("planner-repeat-preview").innerText(), /UTC export may shift local times/);
      await page.getByRole("button", { name: "Week view" }).click();
      const days = page.getByTestId("planner-day"); assert.equal(await days.count(), 7);
      const headings = await days.locator(":scope > div:first-child").allTextContents();
      assert.deepEqual(headings.map((s) => Number(s.match(/\d+/)?.[0])), [1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual(headings.map((s) => s.match(/Mon|Tue|Wed|Thu|Fri|Sat|Sun/)?.[0]), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
      assert.match(await days.nth(0).innerText(), new RegExp(`tt128-${nonce}-monday`));
      assert.match(await days.nth(6).innerText(), new RegExp(`tt128-${nonce}-sunday`));
      await page.getByRole("button", { name: "Agenda", exact: true }).click();
      assert.match(await page.getByTestId("planner-completion").innerText(), new RegExp(`done today ${todayCount} · this week ${weekCount}`));
    } finally { await context.close(); }
  });
} finally {
  for (const id of created) await api("DELETE", `/api/tasks?id=${id}`);
  if (original.row?.state) {
    const last = await api<{ row?: { revision?: number } }>("GET", "/api/state?id=default");
    await api("PUT", "/api/state", { id: "default", revision: Number(last.row?.revision ?? 1) + 1000, state: original.row.state });
  }
  await browser.close(); finish();
}
