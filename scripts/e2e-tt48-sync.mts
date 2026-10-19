/**
 * TT48 e2e — desktop state written from two places (SH-08 fix in Shell.tsx):
 *  - hydrate takes max(row.revision, state.revision) so a fresh tab never saves with a stale revision;
 *  - a debounced save that the server answers 409 (another tab/window saved a newer desktop) no longer fails
 *    silently forever: the newer server state is adopted, the user is told, and the next save succeeds on top of it.
 * The "other tab" is a direct PUT to /api/state, which is exactly what a second tab's save does.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt48-sync.mts
 */
import { type Browser } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { initialDesktop, reduce } from "../src/lib/windowing/state.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt48-sync");
const COV = { "SH-08": "full" } as const;
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => { const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const row = async () => (await api("GET", "/api/state?id=default")).json.row as { revision: number; state: { revision?: number; workspaces?: { id: number; name: string }[]; windows?: { module?: string }[] } };
const poll = async (f: () => Promise<boolean>, what: string, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return; await new Promise((r) => setTimeout(r, 200)); } throw new Error(`timeout: ${what}`); };
/** app launchers in any layout: Fusion shelf, Art dock, Business taskbar pins */
const APPS = '[data-testid^="shelf-"], [data-testid=dock] button, [data-testid=taskbar] button[data-testid^="taskbar-"]:not([data-testid="taskbar-search"]):not([data-testid="taskbar-taskview"])';
const desk = (rev: number, extra: Record<string, unknown> = {}) => ({ revision: rev, windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, ...extra });

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function boot() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator(APPS).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500); // initial hydrate + first debounced save settle
  return { page, close: () => ctx.close() };
}

await test("reducer 'reconcile': the newer desktop's shared data wins, this tab keeps exactly its own windows/focus, z order stays monotonic, revision never goes back", COV, () => {
  let mine = initialDesktop(); mine = reduce(mine, { t: "open", id: "w-here", module: "notes", title: "Here" });
  const zHere = mine.windows[0].z;
  const theirs = { ...initialDesktop(), revision: mine.revision + 50, workspaces: [{ id: 1, name: "Main" }, { id: 9, name: "Theirs" }], nextZ: 3,
    windows: [{ ...mine.windows[0], id: "w-there", title: "There" }], focus: "w-there", icons: [{ id: "i1", path: "/Documents/x.txt", x: 1, y: 2 }] };
  const r = reduce(mine, { t: "reconcile", state: theirs });
  ok(r.windows.length === 1 && r.windows[0].id === "w-here", `own windows only: ${r.windows.map((w) => w.id)}`);
  ok(r.focus === mine.focus, "own focus kept");
  ok(r.workspaces.some((w) => w.name === "Theirs") && r.icons.some((i) => i.id === "i1"), "their workspaces and icons adopted");
  // the revision is the max of both (never lower than the row's); nextZ is the last z handed out (open uses nextZ + 1)
  ok(r.revision >= theirs.revision && r.revision >= mine.revision && r.nextZ >= zHere, `revision ${r.revision} ≥ ${theirs.revision}, nextZ ${r.nextZ} ≥ ${zHere}`);
  const older = reduce(r, { t: "reconcile", state: { ...theirs, revision: 1 } });
  ok(older.revision >= r.revision, "a reconcile with an older row never lowers the revision");
  const gone = reduce({ ...mine, activeWorkspace: 3 }, { t: "reconcile", state: { ...theirs, activeWorkspace: 1 } });
  ok(gone.activeWorkspace === 1, "active workspace falls back when the other tab deleted it");
});

await test("a fresh tab hydrates at the row revision even when the stored state JSON lacks one, so its first save is accepted (no 409)", COV, async () => {
  const base = Number((await row())?.revision ?? 1) + 1000;
  // a row whose inner state has NO revision (older clients / external writers) — the pre-fix client hydrated at 1
  await api("PUT", "/api/state", { id: "default", revision: base, state: { ...desk(0), revision: undefined } });
  const t = await boot();
  const conflicts: number[] = []; t.page.on("response", (r) => { if (r.url().includes("/api/state") && r.request().method() === "PUT" && r.status() === 409) conflicts.push(409); });
  await t.page.locator(APPS).first().click();
  await poll(async () => Number((await row()).revision) > base, "the tab's save lands above the stored revision");
  ok(conflicts.length === 0, `no 409 conflicts (${conflicts.length})`);
  await t.close();
});

await test("another tab saves a newer desktop → this tab's stale save gets 409 → it adopts the newer desktop, says so, and its next save builds on it (nothing lost on either side)", COV, async () => {
  const base = Number((await row())?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: base, state: desk(base) });
  const t = await boot();
  // the "other tab": a newer desktop with a second workspace
  const other = base + 500;
  const put = await api("PUT", "/api/state", { id: "default", revision: other, state: desk(other, { workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "OtherTab48" }] }) });
  ok(put.status < 300, `other tab saved (${put.status})`);
  // this tab changes its (stale) desktop
  await t.page.locator(APPS).first().click();
  await t.page.locator('[data-testid="toasts"]', { hasText: /also changed in another tab or window/ }).waitFor({ timeout: 15_000 });
  const r1 = await row();
  ok(r1.state.workspaces?.some((w) => w.name === "OtherTab48"), "the other tab's desktop was not overwritten by the stale save");
  // after reconciling, a new change saves on top of the newer revision and keeps the other tab's workspace
  await t.page.waitForTimeout(800);
  await t.page.locator(APPS).nth(1).click();
  await poll(async () => { const r = await row(); return Number(r.revision) > other && !!r.state.workspaces?.some((w) => w.name === "OtherTab48") && (r.state.windows?.length ?? 0) >= 2; }, "next save above the other tab's revision, with its workspace and this tab's two windows (none closed by the merge)", 20_000);
  ok(await t.page.locator('[role=dialog]').count() >= 2, "both windows opened in this tab are still on screen after the merge");
  await t.close();
});

await test("no uncaught page errors", COV, () => { ok(errors.length === 0, errors.join(" | ")); });
await browser.close();
// leave a clean desktop for later suites
{ const r = await row(); const rev = Number(r?.revision ?? 1) + 1000; await api("PUT", "/api/state", { id: "default", revision: rev, state: desk(rev) }); }
await finish();
process.exit(0);
