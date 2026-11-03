/**
 * TT71 NC-02 — focus rules end to end (Chromium 143, production build, real routes, real Postgres).
 *  1. server: POST /api/alerts evaluates the stored rules against the LIVE desktop state (active workspace, focus mode)
 *     and the stored time zone; a held alert records the rule id + reason; PATCH deliver releases it; GET reports the
 *     active rules; malformed rules / zones are refused by PUT /api/settings (422) and never stored.
 *  2. Alerts UI: the status line names the active rule, held alerts are listed apart with their reason, "Deliver now"
 *     moves one into the normal list; "Create test alert" while held shows the reason and raises NO OS notification
 *     (Notification is replaced by a recorder — headless Chromium has no notification centre).
 *  3. editor: rules are built with real controls; a bad workspace entry shows the parser's message and saves nothing;
 *     a valid rule is persisted, becomes active and the status line updates; Remove + Save clears it.
 *  4. reminders (ShellDaemons): an overdue task's reminder is held by a rule that lets nothing through — no toast, no
 *     OS notification, a held alert with the reason; with no rules the same path toasts and notifies (control).
 * Restores every setting and the desktop state it changes; deletes the alerts and tasks it creates.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --use-system-ca --import ./scripts/register-hook.mjs scripts/e2e-tt71-focus.mts
 */
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt71-focus");
const COV = { "NC-02": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
const getSetting = async (k: string) => ((await api("GET", "/api/settings")).json.rows as { key: string; value: string }[]).find((r) => r.key === k)?.value;
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
const rules = (r: unknown[]) => setSetting("alerts.focusRules", JSON.stringify(r));
async function putDesktop(activeWorkspace = 1, focusMode = false) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Second" }], activeWorkspace, focusMode, nextZ: 40, viewport: { w: 1440, h: 900 } } });
}
const created: number[] = [];
async function alert(app: string, priority = "normal", title = `t71 ${app} ${Date.now()}`) {
  const r = await api("POST", "/api/alerts", { app, title, priority }); created.push(r.json.row.id); return r.json;
}

const RECORDER = `window.__notes = []; window.Notification = class { static permission = "granted"; static requestPermission() { return Promise.resolve("granted"); } constructor(t, o) { window.__notes.push(t + "|" + ((o && o.body) || "")); } };`;
const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } }); ctx.setDefaultTimeout(20_000);
  await ctx.addInitScript(RECORDER);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  return page;
}
const saved: [string, string][] = [];
for (const k of ["alerts.focusRules", "alerts.timeZone", "appearance.desktopView"]) saved.push([k, (await getSetting(k)) ?? ""]);
ok(saved[0][1] !== undefined && (await getSetting("alerts.focusRules")) !== undefined, "alerts.focusRules is seeded");
await setSetting("appearance.desktopView", "classic");
const savedDesk = (await api("GET", "/api/state?id=default")).json.row?.state;

try {
  await test("server: rules see the live workspace / focus mode / time zone; held alerts record rule + reason; deliver releases; bad rules are refused", COV, async () => {
    await setSetting("alerts.timeZone", "UTC");
    eq((await rules([{ id: "deep", name: "Deep work", workspaces: [2], allowApps: ["Planner"], allowPriorities: [] }, { id: "film", name: "Film", focusMode: true }])).status, 200, "save rules");
    await putDesktop(1, false);
    let g = (await api("GET", "/api/alerts")).json.focus;
    eq(g.active, [], "nothing active on workspace 1"); eq(g.timeZone, "UTC"); eq(g.activeWorkspace, 1);
    eq((await alert("Mail")).delivered, true, "ws 1 delivers");
    await putDesktop(2, false);
    g = (await api("GET", "/api/alerts")).json.focus; eq(g.active, ["Deep work"]); eq(g.activeWorkspace, 2);
    const h = await alert("Mail", "high");
    eq(h.delivered, false, "Deep work holds even high"); eq(h.row.heldBy, "deep");
    ok(/Held by focus rule “Deep work” \(workspace 2\): Mail is not on its allow list and no priority breaks through \(this alert is high\)\./.test(h.reason), h.reason);
    eq(h.row.heldReason, h.reason, "stored reason = returned reason");
    eq((await alert("planner", "low")).delivered, true, "allow list case-insensitive");
    await putDesktop(1, true);
    const f = await alert("Mail", "normal"); eq(f.row.heldBy, "film", "focus mode on → Film holds");
    eq((await alert("Mail", "high")).delivered, true, "Film lets high through");
    eq((await api("PATCH", "/api/alerts", { ids: [h.row.id], deliver: true })).status, 200);
    const rows = (await api("GET", "/api/alerts")).json.rows as { id: number; heldBy: string | null; heldReason: string | null }[];
    eq(rows.find((r) => r.id === h.row.id)?.heldBy, null, "deliver clears heldBy"); eq(rows.find((r) => r.id === h.row.id)?.heldReason, null);
    eq(rows.find((r) => r.id === f.row.id)?.heldBy, "film", "others stay held");
    for (const body of [{ app: 5 }, { app: "Mail", priority: ["high"] }, { app: "Mail", priority: "urgent" }]) {
      const r = await api("POST", "/api/alerts", body); eq(r.status, 400, `repair: ${JSON.stringify(body)} refused (was 500 / garbage)`);
    }
    const before = await getSetting("alerts.focusRules");
    for (const badRules of ["[{\"id\":\"x\"}]", "{}", "[{\"id\":\"a\",\"name\":\"A\",\"schedule\":{\"days\":[1],\"from\":\"10:00\",\"to\":\"10:00\"}}]"]) {
      const r = await setSetting("alerts.focusRules", badRules); eq(r.status, 422, badRules); ok(typeof r.json?.error === "string", "error text");
    }
    for (const z of ["Mars/Olympus", "../x"]) eq((await setSetting("alerts.timeZone", z)).status, 422, z);
    eq(await getSetting("alerts.focusRules"), before, "refused values never stored");
    // schedule in the stored zone: an always-on window from 00:00 to 23:59 every day in Pacific/Chatham (+12:45/+13:45)
    await setSetting("alerts.timeZone", "Pacific/Chatham");
    await rules([{ id: "day", name: "Daytime", schedule: { days: [0, 1, 2, 3, 4, 5, 6], from: "00:00", to: "23:59" }, allowPriorities: [] }]);
    await putDesktop(1, false);
    const lt = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Chatham", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const d = await alert("Mail");
    eq(d.delivered, lt === "23:59", `Chatham local ${lt}`);
  });

  await test("Alerts UI: status line, held alerts listed apart with their reason, Deliver now, held test alert raises no OS notification", COV, async () => {
    await setSetting("alerts.timeZone", "UTC");
    await rules([{ id: "quiet", name: "Quiet", allowApps: ["Planner"], allowPriorities: ["high"] }]);
    await putDesktop(1, false);
    const held = await alert("Mail", "low", `t71 held ${Date.now()}`); eq(held.delivered, false);
    const page = await newPage();
    await page.goto(`${BASE}/?open=alerts`, { waitUntil: "domcontentloaded" });
    const win = page.locator('[role=dialog][aria-label="Alerts"]').first(); await win.waitFor({ timeout: 25_000 });
    await win.getByTestId("focus-active-line").filter({ hasText: "Quiet" }).waitFor();
    const row = win.getByTestId(`held-${held.row.id}`);
    await row.waitFor();
    ok((await row.innerText()).includes("Held by focus rule “Quiet” (always): Mail is not on its allow list and only high priority breaks through (this alert is low)."), await row.innerText());
    ok((await win.getByRole("button", { name: /Focus rules · 1 active/ }).count()) === 1, "toolbar shows 1 active");
    await win.getByRole("button", { name: "Create test alert" }).click();
    await page.getByText(/Held: Held by focus rule “Quiet”/).first().waitFor();
    await poll(async () => (await win.getByTestId("alerts-held").locator(".fs-list-item").count()) >= 2, "test alert listed as held");
    eq(await page.evaluate(() => (window as unknown as { __notes: string[] }).__notes), [], "no OS notification for a held alert");
    const testRow = ((await api("GET", "/api/alerts")).json.rows as { id: number; title: string; heldBy: string | null }[]).find((r) => r.title === "Test alert" && r.heldBy === "quiet");
    ok(testRow, "test alert stored as held"); created.push(testRow!.id);
    await row.getByRole("button", { name: "Deliver now" }).click();
    await poll(async () => (await win.getByTestId(`held-${held.row.id}`).count()) === 0, "released from the held list");
    await win.getByText(held.row.title).first().waitFor();
    eq(((await api("GET", "/api/alerts")).json.rows as { id: number; heldBy: string | null }[]).find((r) => r.id === held.row.id)?.heldBy, null);
    await rules([]);
    await win.getByRole("button", { name: "Create test alert" }).click();
    await poll(async () => (await page.evaluate(() => (window as unknown as { __notes: string[] }).__notes.length)) === 1, "control: delivered alert notifies");
    const last = ((await api("GET", "/api/alerts")).json.rows as { id: number; title: string; heldBy: string | null }[]).find((r) => r.title === "Test alert" && !r.heldBy);
    if (last) created.push(last.id);
    await page.context().close();
  });

  await test("editor: real controls build a rule; a bad workspace shows the parser's message and saves nothing; a valid rule activates; Remove clears", COV, async () => {
    await rules([]); await setSetting("alerts.timeZone", "UTC"); await putDesktop(1, false);
    const page = await newPage();
    await page.goto(`${BASE}/?open=alerts`, { waitUntil: "domcontentloaded" });
    const win = page.locator('[role=dialog][aria-label="Alerts"]').first(); await win.waitFor({ timeout: 25_000 });
    await win.getByRole("button", { name: /^Focus rules/ }).click();
    const ed = win.getByTestId("focus-rules"); await ed.waitFor();
    ok((await ed.getByTestId("focus-status").innerText()).includes("no rule is active right now"), "initial status");
    await ed.getByLabel("Focus time zone").fill("UTC");
    await ed.getByRole("button", { name: "Add rule" }).click();
    await ed.getByLabel("Rule 1 name").fill("Workspace one");
    await ed.getByLabel("Rule 1 has schedule").uncheck();
    await ed.getByLabel("Rule 1 workspaces").fill("one");
    await ed.getByRole("button", { name: "Save focus rules" }).click();
    await ed.getByRole("alert").filter({ hasText: "workspaces must be numbers 1–99" }).waitFor();
    eq(await getSetting("alerts.focusRules"), "[]", "nothing saved");
    await ed.getByLabel("Rule 1 workspaces").fill("1");
    await ed.getByLabel("Rule 1 lets high priority through").uncheck();
    await ed.getByLabel("Rule 1 allowed apps").fill("Planner, Calls");
    ok((await ed.innerText()).includes("on workspace 1 · lets through: Planner, Calls"), "summary line");
    await ed.getByRole("button", { name: "Save focus rules" }).click();
    await poll(async () => (await getSetting("alerts.focusRules")) !== "[]", "saved");
    eq(JSON.parse((await getSetting("alerts.focusRules"))!), [{ id: "rule-1", name: "Workspace one", enabled: true, allowApps: ["Planner", "Calls"], allowPriorities: [], workspaces: [1] }]);
    await ed.getByTestId("focus-status").filter({ hasText: "active now: Workspace one" }).waitFor();
    eq((await alert("Mail", "high")).row.heldBy, "rule-1", "the saved rule holds");
    eq((await alert("calls", "low")).delivered, true);
    await ed.getByRole("button", { name: "Remove" }).click();
    await ed.getByRole("button", { name: "Save focus rules" }).click();
    await poll(async () => (await getSetting("alerts.focusRules")) === "[]", "cleared");
    await ed.getByTestId("focus-status").filter({ hasText: "no rule is active" }).waitFor();
    await page.context().close();
  });

  await test("reminders: a held overdue-task reminder raises no toast and no OS notification and is stored with its reason; with no rules it does (control)", COV, async () => {
    await setSetting("alerts.timeZone", "UTC"); await putDesktop(1, false);
    await rules([{ id: "silence", name: "Silence", allowPriorities: [] }]);
    const title = `t71 reminder ${Date.now()}`;
    const t = await api("POST", "/api/tasks", { title, dueAt: new Date(Date.now() - 60_000).toISOString() }); ok(t.json?.ok, "task created");
    const tid = t.json.row?.id as number;
    const page = await newPage();
    try {
      await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
      let row: { id: number; heldBy: string | null; heldReason: string | null } | undefined;
      await poll(async () => { row = ((await api("GET", "/api/alerts")).json.rows as { id: number; title: string; heldBy: string | null; heldReason: string | null }[]).find((r) => r.title === `Reminder: ${title}`); return !!row; }, "reminder alert stored", 40_000);
      created.push(row!.id);
      eq(row!.heldBy, "silence"); ok(/Planner is not on its allow list and no priority breaks through \(this alert is high\)/.test(row!.heldReason ?? ""), row!.heldReason ?? "");
      await page.waitForTimeout(800);
      eq(await page.getByText(`Reminder: ${title}`).count(), 0, "no toast");
      eq(await page.evaluate(() => (window as unknown as { __notes: string[] }).__notes), [], "no OS notification");
      await rules([]);
      const title2 = `${title} b`;
      const t2 = await api("POST", "/api/tasks", { title: title2, dueAt: new Date(Date.now() - 60_000).toISOString() });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByText(`Reminder: ${title2}`).first().waitFor({ timeout: 40_000 });
      await poll(async () => (await page.evaluate(() => (window as unknown as { __notes: string[] }).__notes)).some((n) => n.includes(title2)), "control notification");
      const r2 = ((await api("GET", "/api/alerts")).json.rows as { id: number; title: string; heldBy: string | null }[]).find((r) => r.title === `Reminder: ${title2}`);
      ok(r2 && r2.heldBy === null, "control delivered"); created.push(r2!.id);
      await api("DELETE", `/api/tasks?id=${t2.json.row?.id}`);
    } finally { await api("DELETE", `/api/tasks?id=${tid}`); await page.context().close(); }
  });
} finally {
  for (const [k, v] of saved) await setSetting(k, v);
  for (const id of created) await api("DELETE", `/api/alerts?id=${id}`);
  if (savedDesk) { const cur = await api("GET", "/api/state?id=default"); await api("PUT", "/api/state", { id: "default", revision: Number(cur.json.row?.revision ?? 1) + 1000, state: savedDesk }); }
  await browser.close();
  if (errors.length) console.log("page errors:", errors.slice(0, 5));
}
finish();
