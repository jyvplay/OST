/**
 * TT55 e2e — shell rows whose spec acceptance criteria were never asserted (SH-01, SH-02, SH-04), driven through the
 * real UI in Chromium against the real server. Ground truth: the module registry source (src/lib/registry.ts), the
 * persisted desktop state (/api/state) and the fs API — never the UI's own state.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt55-shell.mts
 */
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const RUN = `s${Date.now().toString(36)}`;
const { test, finish } = makeHarness("e2e-tt55-shell");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
// These assertions target the Fusion launcher and shelf, and classic desktop icons. Restore the user's actual view/layout.
const savedSettings = (await api("GET", "/api/settings")).json?.rows as { key: string; value: string }[] | undefined;
const prevView = savedSettings?.find((r) => r.key === "appearance.desktopView")?.value;
const prevLayout = savedSettings?.find((r) => r.key === "appearance.layout")?.value;
if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: "classic" });
if (prevLayout && prevLayout !== "fusion") await api("PUT", "/api/settings", { key: "appearance.layout", value: "fusion" });
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
const win = (id: string, module: string, workspace = 1, x = 60) => ({ id, module, title: MODULES.find((m) => m.id === module)!.title, x, y: 60, w: 640, h: 420, z: 11, minimized: false, maximized: false, workspace, host: "tab", props: {} });
async function putDesktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Two" }], activeWorkspace: 1, nextZ: 20, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
/** the persisted state, as the server has it */
const serverWindows = async (): Promise<{ id: string; module: string; workspace: number }[]> => (await api("GET", "/api/state?id=default")).json.row?.state?.windows ?? [];

const browser: Browser = await launchChromium();
const errors: string[] = [];
async function newPage(share?: Page): Promise<Page> {
  const ctx = share ? share.context() : await browser.newContext({ viewport: { width: 1440, height: 900 } }); ctx.setDefaultTimeout(20_000);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("launcher-button").waitFor({ timeout: 30_000 });
  return page;
}

await test("SH-01 one registry: launcher tiles = palette app results = src/lib/registry.ts (same ids, titles, count); a tile and a palette row each open their module", { "SH-01": "full" }, async () => {
  await putDesktop([]);
  const page = await newPage();
  const want = MODULES.map((m) => m.title).sort();
  ok(new Set(want).size === want.length, "registry titles are unique (otherwise the comparison below is ambiguous)");
  // launcher
  await page.getByTestId("launcher-button").click();
  const L = page.getByRole("dialog", { name: "Launcher" });
  await L.waitFor();
  const tiles = (await L.locator("button[title]").allTextContents()).map((t) => t.trim()).sort();
  ok(JSON.stringify(tiles) === JSON.stringify(want), `launcher ≠ registry: missing ${want.filter((t) => !tiles.includes(t))} extra ${tiles.filter((t) => !want.includes(t))}`);
  const pick = MODULES.find((m) => m.id === "planner") ?? MODULES[MODULES.length - 1];
  await L.locator("button[title]", { hasText: pick.title }).first().click();
  await page.locator(`.fs-window[aria-label="${pick.title}"]`).first().waitFor({ timeout: 15_000 });
  await poll(async () => (await serverWindows()).some((w) => w.module === pick.id), `launcher tile opened ${pick.id} (server state)`, 30_000);
  // palette, apps scope, empty query
  await page.getByRole("button", { name: "Search", exact: true }).first().click();
  const P = page.getByRole("dialog", { name: "Command palette" });
  await P.waitFor();
  await P.getByRole("button", { name: "apps", exact: true }).click();
  const rows = P.locator(".fs-list-item");
  await poll(async () => (await rows.count()) === MODULES.length, `palette lists ${MODULES.length} apps`);
  const labels: string[] = [];
  for (let i = 0; i < await rows.count(); i++) labels.push((await rows.nth(i).locator("div").first().textContent())!.trim());
  labels.sort();
  ok(JSON.stringify(labels) === JSON.stringify(want), `palette ≠ registry: missing ${want.filter((t) => !labels.includes(t))} extra ${labels.filter((t) => !want.includes(t))}`);
  // a query narrows by title, and Enter opens the first hit
  const q = MODULES.find((m) => m.id === "terminal")!;
  await P.locator("input").fill(q.title);
  await poll(async () => ((await rows.first().locator("div").first().textContent()) ?? "").trim() === q.title, "the matching app is the first row");
  await P.locator("input").press("Enter");
  await page.locator(`.fs-window[aria-label="${q.title}"]`).first().waitFor({ timeout: 15_000 });
  await poll(async () => (await serverWindows()).some((w) => w.module === q.id), "palette Enter opened Terminal (server state)", 30_000);
  await page.context().close();
});

await test("SH-02 shelf = windows: one shelf button per window of the active workspace (= persisted state), through open, middle-click close, and a workspace with other windows", { "SH-02": "full" }, async () => {
  await putDesktop([win("a1", "files"), win("a2", "editor", 1, 120), win("a3", "terminal", 1, 180), win("b1", "planner", 2)]);
  const page = await newPage();
  const shelf = page.getByRole("toolbar", { name: "Shelf" });
  const btns = shelf.locator('button[title$="middle-click to close"]');
  const check = async (what: string) => {
    await poll(async () => {
      const srv = (await serverWindows()).filter((w) => w.workspace === 1);
      const titles = (await btns.allTextContents()).map((t) => t.trim()).sort();
      const want = srv.map((w) => MODULES.find((m) => m.id === w.module)!.title).sort();
      return titles.length === srv.length && JSON.stringify(titles) === JSON.stringify(want)
        && ((await shelf.textContent()) ?? "").includes(`${srv.length} window${srv.length === 1 ? "" : "s"}`);
    }, what);
  };
  await check("initial: 3 buttons (workspace 2's window is not on this shelf)");
  ok(await btns.count() === 3, "exactly 3");
  await btns.filter({ hasText: "Editor" }).click({ button: "middle" });
  await check("after middle-click close: 2");
  ok(await btns.count() === 2 && !(await serverWindows()).some((w) => w.id === "a2"), "Editor closed on the server too");
  await shelf.getByTestId("shelf-browser").click();
  await check("after opening Browser from a pinned button: 3");
  // a pinned button for a running app focuses it instead of opening a second window
  await shelf.getByTestId("shelf-files").click();
  await page.waitForTimeout(600);
  ok((await serverWindows()).filter((w) => w.module === "files").length === 1, "pinned Files focused the existing window");
  await check("still 3");
  await page.context().close();
});

await test("SH-04 desktop icons follow the file system: a folder trashed in Files disappears from the desktop with no reload — in the same tab and in a second tab of the browser — and the icon set always equals the server listing", { "SH-04": "full" }, async () => {
  await putDesktop([]);
  const name = `000-sh04-${RUN}`; const path = `/Documents/${name}`;
  await api("POST", "/api/fs", { op: "mkdir", path });
  /** oracle: what the desktop should show = the first 30 non-dot entries of the server's /Documents listing */
  const oracle = async () => ((await api("GET", "/api/fs?op=list&path=/Documents")).json.nodes as { name: string; path: string }[]).filter((n) => !n.name.startsWith(".")).slice(0, 30).map((n) => n.path).sort();
  ok((await oracle()).includes(path), "test precondition: the folder is within the desktop's first 30 entries");
  const icons = async (p: Page) => (await p.getByTestId("desk-icon").evaluateAll((els) => els.map((e) => e.getAttribute("data-path") ?? ""))).sort();
  const A = await newPage(); const B = await newPage(A); // two tabs of ONE browser profile
  for (const p of [A, B]) await poll(async () => JSON.stringify(await icons(p)) === JSON.stringify(await oracle()), "desktop icons = server listing (before)");
  // trash it from a Files window in tab A
  await A.goto(`${BASE}/?open=files&path=${encodeURIComponent("/Documents")}`, { waitUntil: "domcontentloaded" });
  const row = A.locator(`.fs-list-item[data-path="${path}"]`);
  await row.waitFor({ timeout: 30_000 });
  await row.click(); await A.keyboard.press("Delete");
  await poll(async () => !(await oracle()).includes(path), "trashed on the server");
  const t0 = Date.now();
  await poll(async () => !(await icons(A)).includes(path), "icon gone in tab A", 5_000);
  await poll(async () => !(await icons(B)).includes(path), "icon gone in tab B (no reload)", 5_000);
  const lag = Date.now() - t0;
  for (const p of [A, B]) ok(JSON.stringify(await icons(p)) === JSON.stringify(await oracle()), "desktop icons = server listing (after)");
  // restore through the API and bring tab B back to the foreground: a hidden tab re-reads when it becomes visible
  await api("POST", "/api/fs", { op: "restore", path });
  await B.bringToFront(); await B.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await poll(async () => (await icons(B)).includes(path), "restored folder reappears in tab B after it becomes visible", 8_000);
  await api("POST", "/api/fs", { op: "trash", path }); await api("POST", "/api/fs", { op: "purge", path });
  console.log(`    icon removal lag after the server confirmed: ${lag} ms`);
  await A.context().close();
});

ok(errors.length === 0, `page errors: ${errors.join(" | ")}`);
await browser.close();
await putDesktop([]);
if (prevView && prevView !== "classic") await api("PUT", "/api/settings", { key: "appearance.desktopView", value: prevView });
if (prevLayout && prevLayout !== "fusion") await api("PUT", "/api/settings", { key: "appearance.layout", value: prevLayout });
finish();
