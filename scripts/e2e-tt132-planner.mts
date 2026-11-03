/** Real Chromium + real tasks API. Only the named failure cases intercept
 * requests; optimistic-edit races mutate the actual disposable PostgreSQL. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright";
import { makeHarness } from "./harness.mts";
import { disposableShell } from "./tt132-fixture.mts";
import type { PlannerTask } from "../src/lib/task-model.ts";

const fx = await disposableShell(), { test, finish } = makeHarness("e2e-tt132-planner"), covers = { "PR-03": "partial", "PR-04": "partial" } as const;
const tag = `tt132-ui-${randomUUID().slice(0, 8)}`, owned = new Set<number>();
mkdirSync("docs/screens", { recursive: true });
async function all(): Promise<PlannerTask[]> { return (await fx.api<{ rows: PlannerTask[] }>("GET", "/api/tasks")).rows; }
async function create(suffix: string, extra: Record<string, unknown> = {}): Promise<PlannerTask> {
  const row = (await fx.api<{ row: PlannerTask }>("POST", "/api/tasks", { title: `${tag}-${suffix}`, ...extra })).row; owned.add(row.id); return row;
}
async function withPlanner(fn: (page: Page, context: BrowserContext) => Promise<void>, options: BrowserContextOptions = {}, count = 1, setup?: (ctx: BrowserContext) => Promise<void>, time?: Date) {
  await fx.windows("planner", count, options.viewport?.width ?? 1500); const ctx = await fx.context(options);
  try {
    if (setup) await setup(ctx);
    const page = await ctx.newPage(), errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
    if (time) await page.clock.install({ time });
    await fx.ready(page, "planner"); await page.locator('[data-win-id="w1"]').getByLabel("Filter tasks", { exact: true }).fill(tag);
    await fn(page, ctx); assert.deepEqual(errors, [], "no unhandled page errors");
  } finally {
    await ctx.close();
    // New items created THROUGH the browser are owned by their random prefix.
    for (const row of await all()) if (row.title.startsWith(tag)) owned.add(row.id);
  }
}
const editor = (page: Page) => page.getByRole("form", { name: "Edit planner item", exact: true });
async function edit(page: Page, title: string) { await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click(); await editor(page).waitFor(); }
async function save(page: Page) {
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/tasks" && r.request().method() === "PATCH");
  await editor(page).getByRole("button", { name: "Save changes", exact: true }).click();
  assert.equal((await response).status(), 200); await editor(page).waitFor({ state: "detached" });
}
try {
  await test("create an undated task with literal multiline notes using the real form", covers, () => withPlanner(async (page) => {
    const form = page.getByRole("form", { name: "New planner item", exact: true }), title = `${tag}-created`;
    await form.getByLabel("Task title", { exact: true }).fill(title); await form.locator("summary").click();
    const notes = "First line\n<b>Literal, not HTML</b>"; await form.getByLabel("New item notes", { exact: true }).fill(notes);
    await form.getByRole("button", { name: "Add", exact: true }).click(); await page.getByRole("button", { name: `Edit ${title}`, exact: true }).waitFor();
    const rows = (await all()).filter((r) => r.title === title); assert.equal(rows.length, 1); assert.equal(rows[0].notes, notes); assert.equal(rows[0].dueAt, null);
  }));
  await test("Enter submits the focused Planner window, not another window's duplicate global ID", covers, () => withPlanner(async (page) => {
    const a = page.locator('[data-win-id="w1"]'), b = page.locator('[data-win-id="w2"]');
    const first = `${tag}-first-draft`, second = `${tag}-second-submit`;
    await a.getByLabel("Task title", { exact: true }).fill(first); await b.getByLabel("Task title", { exact: true }).fill(second);
    await b.getByLabel("Task title", { exact: true }).press("Enter"); await b.getByRole("button", { name: `Edit ${second}`, exact: true }).waitFor();
    const rows = await all(); assert.equal(rows.filter((r) => r.title === first).length, 0); assert.equal(rows.filter((r) => r.title === second).length, 1);
    assert.equal(await a.getByLabel("Task title", { exact: true }).inputValue(), first);
  }, {}, 2));
  await test("create a timed event and preserve both endpoints through API and ICS export", covers, () => withPlanner(async (page) => {
    const form = page.getByRole("form", { name: "New planner item", exact: true }), title = `${tag}-event-created`;
    await form.getByLabel("Task title", { exact: true }).fill(title); await form.getByLabel("Item type", { exact: true }).selectOption("event");
    await form.getByLabel("Start", { exact: true }).fill("2030-01-07T07:30:00.123"); await form.getByLabel("Event end", { exact: true }).fill("2030-01-07T08:45:00.456");
    await form.getByRole("button", { name: "Add", exact: true }).click(); await page.getByRole("button", { name: `Edit ${title}`, exact: true }).waitFor();
    const row = (await all()).find((r) => r.title === title)!; assert.equal(row.kind, "event"); assert.equal(row.dueAt, "2030-01-07T07:30:00.123Z"); assert.equal(row.endAt, "2030-01-07T08:45:00.456Z");
    const response = await fetch(fx.BASE + "/api/tasks?format=ics"); assert.equal(response.status, 200); const exported = await response.text(); assert.ok(exported.includes(`UID:fusion-${row.id}@fusion.local`));
  }));
  await test("rename and edit task notes without changing its ID or millisecond due time", covers, async () => {
    const row = await create("rename", { notes: "before", dueAt: "2030-01-01T10:11:12.345Z" });
    await withPlanner(async (page) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit title", { exact: true }).fill(`${tag}-renamed`); await editor(page).getByLabel("Edit notes", { exact: true }).fill("after\nnotes"); await save(page);
      const actual = (await all()).find((r) => r.id === row.id)!; assert.equal(actual.title, `${tag}-renamed`); assert.equal(actual.notes, "after\nnotes"); assert.equal(actual.dueAt, row.dueAt);
    });
  });
  await test("reschedule a reminder and then clear its due date from the editor", covers, async () => {
    const row = await create("reschedule", { dueAt: "2030-01-01T10:00:00Z" }); await fx.api("PATCH", "/api/tasks", { id: row.id, reminded: true });
    await withPlanner(async (page) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit due or start", { exact: true }).fill("2030-02-01T12:00"); await save(page);
      let actual = (await all()).find((r) => r.id === row.id)!; assert.equal(actual.dueAt, "2030-02-01T12:00:00.000Z"); assert.equal(actual.reminded, false);
      await edit(page, row.title); await editor(page).getByRole("button", { name: "Clear due", exact: true }).click(); await save(page);
      actual = (await all()).find((r) => r.id === row.id)!; assert.equal(actual.dueAt, null);
    });
  });
  await test("edit event start/end and refuse an inverted interval without discarding typed fields", covers, async () => {
    const row = await create("event-edit", { kind: "event", dueAt: "2030-01-01T10:00:00Z", endAt: "2030-01-01T11:00:00Z" });
    await withPlanner(async (page) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit due or start", { exact: true }).fill("2030-01-01T12:00");
      await editor(page).getByRole("button", { name: "Save changes", exact: true }).click(); await editor(page).getByRole("alert").getByText(/event end must be after/).waitFor();
      assert.equal((await all()).find((r) => r.id === row.id)!.dueAt, row.dueAt); assert.match(await editor(page).getByLabel("Edit due or start", { exact: true }).inputValue(), /12:00/);
      await editor(page).getByLabel("Edit event end", { exact: true }).fill("2030-01-01T13:15"); await save(page);
      assert.equal((await all()).find((r) => r.id === row.id)!.endAt, "2030-01-01T13:15:00.000Z");
    });
  });
  await test("convert task to event and back and edit completion without losing notes", covers, async () => {
    const row = await create("convert", { notes: "Carry me", dueAt: "2030-01-01T10:00:00Z" });
    await withPlanner(async (page) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit item type", { exact: true }).selectOption("event"); await editor(page).getByLabel("Edit event end", { exact: true }).fill("2030-01-01T11:00"); await save(page);
      assert.equal((await all()).find((r) => r.id === row.id)!.kind, "event");
      await edit(page, row.title); await editor(page).getByLabel("Edit item type", { exact: true }).selectOption("task"); await editor(page).getByLabel("Edit completed", { exact: true }).check(); await save(page);
      const actual = (await all()).find((r) => r.id === row.id)!; assert.equal(actual.kind, "task"); assert.equal(actual.endAt, null); assert.equal(actual.done, true); assert.equal(actual.notes, "Carry me");
    });
  });
  await test("stale save returns a real 409, retains the draft, and explicit reload shows the new server item", covers, async () => {
    const row = await create("conflict", { notes: "baseline" });
    await withPlanner(async (page) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit notes", { exact: true }).fill("my unsaved draft");
      await fx.api("PATCH", "/api/tasks", { id: row.id, notes: "other window committed" });
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/tasks" && r.request().method() === "PATCH");
      await editor(page).getByRole("button", { name: "Save changes", exact: true }).click(); assert.equal((await response).status(), 409);
      await editor(page).getByText(/changed in another window/).waitFor(); assert.equal(await editor(page).getByLabel("Edit notes", { exact: true }).inputValue(), "my unsaved draft");
      await page.screenshot({ path: "docs/screens/tt132-planner-conflict.png", animations: "disabled" });
      await editor(page).getByRole("button", { name: "Reload item (discard draft)", exact: true }).click();
      await page.waitForFunction(() => (document.querySelector('[aria-label="Edit notes"]') as HTMLTextAreaElement)?.value === "other window committed");
      assert.equal((await all()).find((r) => r.id === row.id)!.notes, "other window committed");
    });
  });
  await test("delete asks for confirmation, Cancel preserves the row, and a changed item refuses deletion", covers, async () => {
    const row = await create("delete");
    await withPlanner(async (page) => {
      const remove = page.getByRole("button", { name: `Delete ${row.title}`, exact: true });
      await remove.click(); await page.getByTestId("ask-cancel").click(); assert.ok((await all()).some((r) => r.id === row.id));
      await remove.click(); await page.getByTestId("ask-dialog").waitFor(); await fx.api("PATCH", "/api/tasks", { id: row.id, notes: "changed during confirmation" });
      await page.getByTestId("ask-ok").click(); await page.getByRole("alert").getByText(/changed in another window/).waitFor(); assert.ok((await all()).some((r) => r.id === row.id));
      await page.getByRole("button", { name: "Retry loading", exact: true }).click();
      await edit(page, row.title);
      await page.waitForFunction(() => (document.querySelector('[aria-label="Edit notes"]') as HTMLTextAreaElement)?.value === "changed during confirmation");
      await editor(page).getByRole("button", { name: "Cancel edit", exact: true }).click();
      await remove.click(); await page.getByTestId("ask-ok").click(); await remove.waitFor({ state: "detached" });
      assert.equal((await all()).some((r) => r.id === row.id), false); owned.delete(row.id);
    });
  });
  await test("dirty editor close is guarded; Cancel keeps it open and Save actually commits before closing", covers, async () => {
    const row = await create("close-guard");
    await withPlanner(async (page) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit notes", { exact: true }).fill("save on close");
      const close = page.locator('[data-win-id="w1"]').getByRole("button", { name: "Close window", exact: true });
      await close.click(); await page.getByTestId("close-confirm").waitFor(); await page.getByTestId("close-confirm-cancel").click();
      assert.equal(await editor(page).getByLabel("Edit notes", { exact: true }).inputValue(), "save on close");
      await close.click(); await page.getByTestId("close-confirm-save").click(); await page.locator('[data-win-id="w1"]').waitFor({ state: "detached" });
      assert.equal((await all()).find((r) => r.id === row.id)!.notes, "save on close");
    });
  });
  await test("switching or cancelling a dirty editor offers Cancel, Discard and real Save", covers, async () => {
    const first = await create("switch-first", { notes: "first baseline" }), second = await create("switch-second", { notes: "second baseline" });
    await withPlanner(async (page) => {
      await edit(page, first.title); await editor(page).getByLabel("Edit notes", { exact: true }).fill("uncommitted first draft");
      await page.getByRole("button", { name: `Edit ${second.title}`, exact: true }).click(); await page.getByTestId("close-confirm").waitFor();
      await page.getByTestId("close-confirm-cancel").click(); assert.equal(await editor(page).getByLabel("Edit notes", { exact: true }).inputValue(), "uncommitted first draft");
      await page.getByRole("button", { name: `Edit ${second.title}`, exact: true }).click(); await page.getByTestId("close-confirm-discard").click();
      await page.waitForFunction((title) => (document.querySelector('[aria-label="Edit title"]') as HTMLInputElement)?.value === title, second.title);
      assert.equal((await all()).find((r) => r.id === first.id)!.notes, "first baseline");
      await editor(page).getByLabel("Edit notes", { exact: true }).fill("saved through cancel-edit prompt");
      await editor(page).getByRole("button", { name: "Cancel edit", exact: true }).click(); await page.getByTestId("close-confirm-save").click();
      await editor(page).waitFor({ state: "detached" }); assert.equal((await all()).find((r) => r.id === second.id)!.notes, "saved through cancel-edit prompt");
    });
  });
  await test("closing during a held real save cannot dismiss the window or duplicate the request", covers, async () => {
    const row = await create("in-flight");
    await withPlanner(async (page) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit notes", { exact: true }).fill("save in flight");
      let release!: () => void, entered!: () => void, count = 0;
      const hold = new Promise<void>((resolve) => { release = resolve; }), reached = new Promise<void>((resolve) => { entered = resolve; });
      await page.route("**/api/tasks", async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        count++; entered(); await hold; const response = await route.fetch(); await route.fulfill({ response });
      });
      try {
        await editor(page).getByRole("button", { name: "Save changes", exact: true }).click();
        const timeout = setTimeout(() => entered(), 10_000); await reached; clearTimeout(timeout); assert.equal(count, 1, "PATCH reached the held boundary");
        await page.locator('[data-win-id="w1"]').getByRole("button", { name: "Close window", exact: true }).click(); await page.getByTestId("close-confirm-save").click();
        await page.getByTestId("close-confirm").waitFor({ state: "detached" }); assert.equal(await page.locator('[data-win-id="w1"]').count(), 1);
        assert.equal((await all()).find((r) => r.id === row.id)!.notes, ""); assert.equal(count, 1);
        release(); await editor(page).waitFor({ state: "detached" }); assert.equal(count, 1);
        assert.equal((await all()).find((r) => r.id === row.id)!.notes, "save in flight");
        await page.locator('[data-win-id="w1"]').getByRole("button", { name: "Close window", exact: true }).click(); await page.locator('[data-win-id="w1"]').waitFor({ state: "detached" });
      } finally { release(); }
    });
  });
  await test("local edit preserves the second DST fold occurrence and rejects a nonexistent local time", covers, async () => {
    const row = await create("dst", { dueAt: "2030-11-03T06:30:12.345Z" });
    await withPlanner(async (page) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit notes", { exact: true }).fill("only note changed"); await save(page);
      assert.equal((await all()).find((r) => r.id === row.id)!.dueAt, row.dueAt);
      await edit(page, row.title); await editor(page).getByLabel("Edit due or start", { exact: true }).fill("2030-03-10T02:30");
      await editor(page).getByRole("button", { name: "Save changes", exact: true }).click(); await editor(page).getByText(/local time does not exist/).waitFor();
      assert.equal((await all()).find((r) => r.id === row.id)!.dueAt, row.dueAt);
    }, { timezoneId: "America/New_York" });
  });
  await test("week navigation crosses DST by calendar dates and event buttons open the real editor", covers, async () => {
    const row = await create("week", { kind: "event", dueAt: "2030-03-10T13:00:00Z", endAt: "2030-03-10T14:00:00Z" });
    await withPlanner(async (page) => {
      await page.getByRole("button", { name: "Week view", exact: true }).click(); const original = await page.getByTestId("planner-week-range").innerText();
      await page.getByRole("button", { name: "Previous week", exact: true }).click();
      await page.getByTestId("planner-week").getByRole("button", { name: `Edit ${row.title}`, exact: true }).waitFor();
      const days = await page.getByTestId("planner-day").allTextContents(); assert.equal(days.length, 7); assert.ok(days[6].includes("10"));
      await page.getByRole("button", { name: "Next week", exact: true }).click(); assert.equal(await page.getByTestId("planner-week-range").innerText(), original);
      await page.getByRole("button", { name: "Previous week", exact: true }).click(); await edit(page, row.title); assert.equal(await editor(page).getByLabel("Edit item type", { exact: true }).inputValue(), "event");
    }, { timezoneId: "America/New_York" }, 1, undefined, new Date("2030-03-12T12:00:00Z"));
  });
  await test("held-out read failure is visible and Retry loading reaches the actual server", covers, async () => {
    let deny = true;
    const row = await create("load-retry");
    await withPlanner(async (page) => {
      await page.getByRole("alert").getByText(/held-out load failure/).waitFor(); assert.equal(await page.getByText("Nothing planned", { exact: true }).count(), 0);
      deny = false; await page.getByRole("button", { name: "Retry loading", exact: true }).click(); await page.locator('[data-win-id="w1"]').getByRole("alert").waitFor({ state: "detached" });
      await page.getByRole("button", { name: `Edit ${row.title}`, exact: true }).waitFor();
    }, {}, 1, async (ctx) => {
      await ctx.route("**/api/tasks", async (route) => { if (deny && route.request().method() === "GET") await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "held-out load failure" }) }); else await route.continue(); });
    });
  });
  await test("browser-offline save stays unsaved with its draft intact, then a real online retry commits", covers, async () => {
    const row = await create("offline-save", { notes: "server baseline" });
    await withPlanner(async (page, context) => {
      await edit(page, row.title); await editor(page).getByLabel("Edit notes", { exact: true }).fill("draft survives offline");
      await context.setOffline(true);
      try {
        await editor(page).getByRole("button", { name: "Save changes", exact: true }).click(); await editor(page).getByRole("alert").waitFor();
        assert.equal(await editor(page).getByLabel("Edit notes", { exact: true }).inputValue(), "draft survives offline");
        assert.equal((await all()).find((r) => r.id === row.id)!.notes, "server baseline", "independent Node HTTP read confirms no false save");
      } finally { await context.setOffline(false); }
      await save(page); assert.equal((await all()).find((r) => r.id === row.id)!.notes, "draft survives offline");
    });
  });
  await test("populated editor has named original icon controls and no serious axe failures at a narrow viewport", covers, async () => {
    const row = await create("accessible", { notes: "Readable notes", dueAt: "2030-01-01T10:00:00Z" });
    await withPlanner(async (page) => {
      await edit(page, row.title); await page.addScriptTag({ path: resolve("node_modules/axe-core/axe.min.js") });
      const violations = await page.evaluate(async () => (await (window as any).axe.run('[data-win-id="w1"]')).violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => ({ id: v.id, nodes: v.nodes.map((n: any) => n.target) })));
      assert.deepEqual(violations, []);
      assert.ok(await page.getByRole("button", { name: `Edit ${row.title}`, exact: true }).locator("svg").count());
      const bounds = await editor(page).evaluate((el) => ({ client: el.clientWidth, scroll: el.scrollWidth })); assert.ok(bounds.scroll <= bounds.client + 1, JSON.stringify(bounds));
      await page.screenshot({ path: "docs/screens/tt132-planner-editor.png", animations: "disabled" });
    }, { viewport: { width: 900, height: 960 } });
  });
} finally {
  await fx.close();
  const present = new Set((await all()).map((row) => row.id));
  for (const id of owned) if (present.has(id)) await fx.api("DELETE", `/api/tasks?id=${id}`);
  finish();
}
