/**
 * Real-browser suite "e2e-tables" (TT22): the Tables module driven through its UI in headless Chromium against the
 * production build — cell editing with validation + undo, live formulas, a new formula field, filter/sort, two-way
 * links through the link picker (and the rollup on the other table), kanban moves (select + drag-and-drop), save to
 * .ftable and reopen, CSV export to the VFS and CSV import from a file.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tables.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tables");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const win = (id: string, props: Record<string, unknown> = {}) => ({ id, module: "tables", title: "Tables", x: 20, y: 10, w: 1380, h: 800, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const browser: Browser = await launchChromium();
async function open(props: Record<string, unknown> = {}): Promise<{ page: Page; w: Locator; close: () => Promise<void> }> {
  await desktop([win("tb1", props)]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const w = page.locator('.fs-window[aria-label="Tables"]');
  await w.locator('[data-testid="tables"]').waitFor({ timeout: 30_000 });
  return { page, w, close: () => ctx.close() };
}
// NB: a `has:` locator is resolved relative to the row, so it must not be scoped to the window again
const row = (w: Locator, name: string) => w.locator("tbody tr").filter({ has: w.page().locator('td[data-field="Name"]', { hasText: new RegExp(`^${name}$`) }) });
const cell = (w: Locator, name: string, field: string) => row(w, name).locator(`td[data-field="${field}"]`);
const text = async (l: Locator) => (await l.innerText()).trim();
async function poll(fn: () => Promise<boolean>, what: string, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`timed out: ${what}`); }

await test("sample base renders: Tasks grid, lookup-driven formula (6.5 h × 65 = 422.5), footer sum, table tabs", { "TB-05": "partial", "TB-03": "partial" }, async () => {
  const { w, close } = await open();
  ok(await w.locator("tbody tr[data-record]").count() === 4, "4 task records");
  ok(await text(cell(w, "Design poolside theme", "Cost")) === "422.5", `cost ${await text(cell(w, "Design poolside theme", "Cost"))}`);
  ok(await text(w.locator('td[data-summary="Hours"]')) === "Sum 15.5", `footer ${await text(w.locator('td[data-summary="Hours"]'))}`);
  ok(await w.getByTestId("table-tab-People").count() === 1, "People tab");
  await close();
});

await test("editing: a number cell commits on Enter and recomputes the formula; a non-number is refused; Undo restores", { "TB-05": "full", "TB-01": "partial" }, async () => {
  const { page, w, close } = await open();
  const hours = cell(w, "Ship release", "Hours");
  await hours.dblclick();
  await hours.locator("input").fill("5"); await page.keyboard.press("Enter");
  await poll(async () => (await text(cell(w, "Ship release", "Cost"))) === "400", "cost 5 h × Ana 80 = 400");
  await hours.dblclick();
  await hours.locator("input").fill("lots"); await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  ok(await text(hours) === "5.0", `refused input left the value alone: ${await text(hours)}`);
  await w.getByRole("button", { name: "Undo" }).click();
  await poll(async () => (await text(cell(w, "Ship release", "Cost"))) === "160", "undo → 2 h × 80 = 160");
  await w.getByRole("button", { name: "Redo" }).click();
  await poll(async () => (await text(cell(w, "Ship release", "Cost"))) === "400", "redo");
  // keyboard: arrow navigation + Delete clears
  await hours.click(); await page.keyboard.press("ArrowUp"); await page.keyboard.press("Delete");
  await poll(async () => (await text(cell(w, "Accessibility pass", "Hours"))) === "", "ArrowUp + Delete cleared the cell above");
  await close();
});

await test("add a formula field: live validation disables Create on a bad formula; a good one adds a computed column", { "TB-03": "full" }, async () => {
  const { w, close } = await open();
  await w.getByRole("button", { name: "+ Field" }).click();
  const ed = w.getByTestId("field-editor");
  await ed.getByLabel("Field name").fill("Double");
  await ed.getByLabel("Field type").selectOption("formula");
  await ed.getByLabel("Formula").fill("{Hours} * (2");
  ok(await ed.getByRole("button", { name: "Create field" }).isDisabled(), "bad formula → disabled");
  await ed.getByLabel("Formula").fill("{Nope} * 2");
  ok(/unknown field/.test(await ed.getByRole("status").innerText()), "unknown field reported");
  await ed.getByLabel("Formula").fill("{Hours} * 2");
  await ed.getByRole("button", { name: "Create field" }).click();
  await poll(async () => (await text(cell(w, "Design poolside theme", "Double"))) === "13", "6.5 × 2 = 13");
  await close();
});

await test("filter + sort: Status is Doing leaves 2 records; sorting Hours descending orders them; badges count the conditions", { "TB-04": "full" }, async () => {
  const { w, close } = await open();
  await w.getByRole("button", { name: "Filter" }).click();
  await w.getByRole("button", { name: "+ Add condition" }).click();
  await w.getByLabel("Filter 1 field").selectOption({ label: "Status" });
  await w.getByLabel("Filter 1 operator").selectOption("is");
  await w.getByLabel("Filter 1 value").selectOption("Doing");
  await poll(async () => (await w.locator("tbody tr[data-record]").count()) === 2, "2 Doing records");
  await w.getByRole("button", { name: "Sort", exact: true }).click();
  await w.getByRole("button", { name: "+ Add sort" }).click();
  await w.getByLabel("Sort 1 field").selectOption({ label: "Hours" });
  await w.getByLabel("Sort 1 direction").selectOption("desc");
  await poll(async () => (await w.locator('tbody tr[data-record] td[data-field="Name"]').allInnerTexts()).join("|") === "Design poolside theme|Accessibility pass", "6.5 h before 4 h");
  ok(await w.getByRole("button", { name: "Filter · 1" }).count() === 1 && await w.getByRole("button", { name: "Sort · 1" }).count() === 1, "badges");
  await w.locator('input[aria-label="Search records"]').fill("poolside");
  await poll(async () => (await w.locator("tbody tr[data-record]").count()) === 1, "search narrows further");
  await close();
});

await test("two-way link through the picker: linking Cy to a task shows on People (inverse field) and updates the Open hours rollup", { "TB-02": "full" }, async () => {
  const { w, close } = await open();
  await row(w, "Write brief").getByRole("button", { name: /Expand record/ }).click();
  const panel = w.getByTestId("record-panel");
  await panel.getByRole("button", { name: "Edit links · Owner" }).click();
  const picker = w.getByTestId("link-picker");
  await picker.getByLabel("Cy").check();
  await picker.getByRole("button", { name: "Done" }).click();
  await poll(async () => /Cy/.test(await text(cell(w, "Write brief", "Owner"))), "Owner shows Ana, Cy");
  await w.getByTestId("table-tab-People").click();
  await poll(async () => /Write brief/.test(await text(cell(w, "Cy", "Tasks"))), "inverse link on People");
  // Cy had Accessibility pass (4 h); + Write brief (3 h) = 7
  ok(await text(cell(w, "Cy", "Open hours")) === "7", `rollup ${await text(cell(w, "Cy", "Open hours"))}`);
  await close();
});

await test("kanban: columns by Status; moving a card with its Move select and by drag-and-drop updates the counts and the grid", { "TB-04": "full" }, async () => {
  const { page, w, close } = await open();
  await w.getByTestId("view-Board").click();
  const count = async (label: string) => w.locator(`section[data-column="${label}"] article`).count();
  ok(await count("Todo") === 1 && await count("Doing") === 2 && await count("Done") === 1, "1 / 2 / 1");
  await w.getByLabel("Move Ship release to").selectOption("Done");
  await poll(async () => (await count("Done")) === 2 && (await count("Todo")) === 0, "select move");
  await w.locator('article[data-card="Accessibility pass"]').dragTo(w.locator('section[data-column="Todo"]'));
  await poll(async () => (await count("Todo")) === 1 && (await count("Doing")) === 1, "drag-and-drop move");
  await w.getByTestId("view-Grid view").click();
  ok(/Todo/.test(await text(cell(w, "Accessibility pass", "Status"))), "grid reflects the move");
  void page;
  await close();
});

await test("save .ftable, reopen it from the VFS with the edits intact; export CSV to the VFS; import a CSV file as a new table", { "TB-05": "full", "TB-01": "full" }, async () => {
  const path = "/Documents/E2E tables.ftable";
  await api("POST", "/api/fs", { op: "delete", path }).catch(() => undefined);
  let s = await open();
  await s.w.getByLabel("Base name").fill("E2E tables");
  const hours = cell(s.w, "Write brief", "Hours");
  await hours.dblclick(); await hours.locator("input").fill("9"); await s.page.keyboard.press("Enter");
  await poll(async () => (await text(hours)) === "9.0", "edited");
  await s.w.getByRole("button", { name: "Save .ftable" }).click();
  await poll(async () => (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).status === 200, "file written");
  await s.w.getByRole("button", { name: "Export CSV" }).click();
  await poll(async () => (await api("GET", `/api/fs?op=read&path=${encodeURIComponent("/Documents/Tasks.csv")}`)).status === 200, "csv written");
  const csv = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent("/Documents/Tasks.csv")}`)).json.node.content as string;
  ok(csv.startsWith("Name,Status,Owner,Hours,Due,Owner rate,Cost\r\n") && csv.includes("Write brief,Done,Ana,9.0,2026-10-01,80,720"), csv.split("\r\n").slice(0, 2).join(" | "));
  await s.close();
  s = await open({ path });
  ok(await s.w.getByLabel("Base name").inputValue() === "E2E tables", "name restored");
  ok(await text(cell(s.w, "Write brief", "Hours")) === "9.0" && await text(cell(s.w, "Write brief", "Cost")) === "720", "edit + formula restored");
  await s.w.getByTestId("tables-csv-input").setInputFiles({ name: "Deals.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Amount,Paid\nAcme,1200,yes\nBeta,99,no\n") });
  await s.w.getByTestId("table-tab-Deals").waitFor({ timeout: 5000 });
  ok(await text(cell(s.w, "Acme", "Amount")) === "1200" && await cell(s.w, "Acme", "Paid").locator('svg[aria-label="checked"]').count() === 1, "imported with inferred number + checkbox");
  await s.close();
  await desktop([]);
});

await test("axe-core on the deeper states (field editor, filter panel, record panel, link picker, kanban): no serious/critical violations", { "TB-05": "partial", "AX-08": "partial" }, async () => {
  const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
  const { page, w, close } = await open();
  const bad: string[] = [];
  const scan = async (where: string) => {
    if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
    const vs = await page.evaluate(async () => {
      const ax = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
      const r = await ax.run({ include: ['.fs-window[aria-label="Tables"]'] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
      return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ${v.nodes[0]?.target.join(" ")}`);
    });
    for (const v of vs) bad.push(`${where}: ${v}`);
  };
  await w.getByRole("button", { name: "+ Field" }).click(); await w.getByTestId("field-editor").getByLabel("Field type").selectOption("rollup"); await scan("field editor");
  await w.getByRole("button", { name: "Filter" }).click(); await w.getByRole("button", { name: "+ Add condition" }).click(); await w.getByRole("button", { name: "+ Add condition" }).click(); await scan("filter panel");
  await w.getByRole("button", { name: "Close Filter" }).click();
  await row(w, "Write brief").getByRole("button", { name: /Expand record/ }).click(); await scan("record panel");
  await w.getByTestId("record-panel").getByRole("button", { name: "Edit links · Owner" }).click(); await scan("link picker");
  await w.getByTestId("link-picker").getByRole("button", { name: "Done" }).click();
  await w.getByTestId("view-Board").click(); await page.waitForTimeout(500); /* let the button colour transition finish */ await scan("kanban");
  await close(); await desktop([]);
  ok(bad.length === 0, bad.join("\n      "));
});

await browser.close();
finish();
