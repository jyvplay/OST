/**
 * TT19 visual inspection: spreadsheet defined names (Name Box + Names panel), vector Pathfinder result, and
 * the private-search badges in Find (amnesic session, RAM-only file — no host write).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/shots-tt19.mts
 */
import { launchChromium } from "./browser-launch.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const browser = await launchChromium();
const api = (method: string, path: string, body?: unknown) => fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
async function reset() {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}

// 1. spreadsheet names
await reset();
let ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let page = await ctx.newPage();
await page.goto(`${BASE}/?open=sheet`, { waitUntil: "domcontentloaded" });
const dlg = page.locator('[role=dialog][aria-label="Spreadsheet"]').first();
await dlg.locator('[data-testid="sheet-grid"]').waitFor({ timeout: 25_000 });
const cell = (r: string) => dlg.locator(`[data-cell="${r}"]`);
await cell("F2").click(); await page.keyboard.type("0.0825"); await page.keyboard.press("Enter");
await cell("F2").click();
const box = dlg.getByLabel("Name Box", { exact: true });
await box.click(); await box.fill("TaxRate"); await box.press("Enter");
await cell("C2").click(); await cell("C5").click({ modifiers: ["Shift"] });
await box.click(); await box.fill("Prices"); await box.press("Enter");
await cell("F4").click(); await page.keyboard.type("=SUM(Prices)*(1+TaxRate)"); await page.keyboard.press("Enter");
await dlg.getByRole("button", { name: /^Name Manager/ }).click();
await cell("F4").click();
await page.waitForTimeout(400);
await page.screenshot({ path: "docs/screenshots/tt19-sheet-names.png" });
console.log("F4 =", await cell("F4").innerText());
await ctx.close();

// 2. vector pathfinder
await reset();
ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
page = await ctx.newPage();
await page.goto(`${BASE}/?open=vector`, { waitUntil: "domcontentloaded" });
const root = page.locator('[data-testid="vector-studio"]').first();
await root.waitFor({ timeout: 25_000 });
const svg = root.locator('[data-testid="vector-canvas"]');
const at = (x: number, y: number) => svg.evaluate((s: SVGSVGElement, [x, y]) => { const p = new DOMPoint(x, y).matrixTransform(s.getScreenCTM()!); return { x: p.x, y: p.y }; }, [x, y]);
const drag = async (a: [number, number], b: [number, number]) => { const p = await at(...a), q = await at(...b); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 8 }); await page.mouse.up(); };
await root.getByRole("button", { name: /^Ellipse tool/ }).click(); await drag([540, 330], [700, 470]);
await root.getByRole("button", { name: /^Rect tool/ }).click(); await drag([620, 380], [760, 520]);
await root.getByRole("button", { name: /^Select tool/ }).click();
const p1 = await at(560, 400); await page.keyboard.down("Shift"); await page.mouse.click(p1.x, p1.y); await page.keyboard.up("Shift");
await root.getByRole("button", { name: "Exclude", exact: true }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "docs/screenshots/tt19-vector-pathfinder.png" });
console.log("vector:", await root.locator('[data-testid="vector-message"]').innerText());
await ctx.close();

// 3. Find with private-search provenance (amnesic session: RAM file, nothing written to the host)
ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
page = await ctx.newPage();
await page.goto(`${BASE}/?amnesia=1`, { waitUntil: "domcontentloaded" });
await page.locator('[data-testid="amnesic-badge"]').waitFor({ timeout: 30_000 });
await page.evaluate(() => fetch("/api/fs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "write", path: "/Documents/ram-only-plan.txt", content: "quarterly plan: falcon budget review" }) }));
await page.keyboard.press("Control+Space");
const pal = page.locator('[role=dialog][aria-label="Command palette"]'); await pal.waitFor();
await page.keyboard.type("Find"); await pal.getByText("Index search with provenance").first().click();
const find = page.locator('[role=dialog][aria-label="Find"]').first(); await find.waitFor();
await find.getByLabel("Search query").fill("falcon budget");
await find.getByRole("button", { name: "Search", exact: true }).click();
await find.getByText("ram-only-plan.txt").first().waitFor({ timeout: 10_000 });
await page.waitForTimeout(300);
await page.screenshot({ path: "docs/screenshots/tt19-find-private.png" });
await ctx.close();
await browser.close();
console.log("shots done");
