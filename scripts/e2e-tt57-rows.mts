/**
 * TT57 — rows whose spec acceptance criteria had never been asserted, checked in a real Chromium against ground truth
 * outside the component's state:
 *   PR-10 clock / timers: elapsed time from performance.now anchors — under Playwright's fake clock a 10-minute jump in
 *         which timers fire at most once (a throttled / frozen tab) still shows 10:00 (tick counting would show ~0:01);
 *         stopwatch, laps and pause measured to ±1 frame; a seconds-level timer fires on time even when
 *         requestAnimationFrame never runs (hidden-tab emulation: rAF replaced by a no-op before the app loads)
 *   PR-12 clipboard history: copies reach the system clipboard (read back with navigator.clipboard under granted
 *         permission, independent of the history list), dedupe-move-to-top, pin survives Clear, search, remove
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-tt57-rows.mts
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type Browser, type Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-tt57-rows");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
async function poll(f: () => Promise<boolean>, what: string, ms = 15_000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f().catch(() => false)) return; await new Promise((r) => setTimeout(r, 150)); } throw new Error(`timeout: ${what}`); }
async function putDesktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
}
const walk = (dir: string, out: string[] = []): string[] => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); } return out; };
const browser: Browser = await launchChromium();
const errors: string[] = [];
async function clockPage(init?: string): Promise<{ page: Page; win: ReturnType<Page["locator"]> }> {
  await putDesktop([]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); ctx.setDefaultTimeout(20_000);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install({ time: new Date("2026-10-21T12:00:00Z") });
  await page.goto(BASE + "/?open=clock", { waitUntil: "domcontentloaded" });
  // the app boots under the fake clock: let it run (fake) time until the window is there
  for (let i = 0; i < 200 && !(await page.locator('[role=dialog][aria-label="Clock"]').count()); i++) await page.clock.runFor(100);
  const win = page.locator('[role=dialog][aria-label="Clock"]').first(); await win.waitFor();
  // freeze fake time: from here only runFor / fastForward advance it, so Playwright's own click latency (real time) never
  // leaks into a measured duration
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  return { page, win };
}
/** "mm:ss.cc" / "h:mm:ss.cc" → ms */
const parseT = (t: string) => { const m = /^(?:(\d+):)?(\d{2}):(\d{2})\.(\d{2})$/.exec(t.trim()); if (!m) throw new Error(`bad time ${t}`); return ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]) * 10; };
const near = (a: number, b: number, tol: number, m: string) => ok(Math.abs(a - b) <= tol, `${m}: ${a} not within ${tol} ms of ${b}`);

await test("PR-10 stopwatch: start → 65.43 s → lap → 10-minute jump with timers firing at most once (throttled tab) → still exact; pause holds; reset", { "PR-10": "full" }, async () => {
  const { page, win } = await clockPage();
  const sw = win.getByTestId("clock-sw");
  await win.getByRole("button", { name: "Start stopwatch" }).click();
  await page.clock.runFor(65_430);
  near(parseT(await sw.innerText()), 65_430, 34, "after 65.43 s of running time");
  await win.getByRole("button", { name: "Lap", exact: true }).click();
  near(parseT(await win.getByTestId("clock-lap").first().innerText().then((t) => t.replace(/^lap \d+: /, ""))), 65_430, 34, "lap 1");
  // fastForward jumps the clock: every due timer/frame fires at most once — like a frozen background tab waking up
  await page.clock.fastForward(600_000);
  await page.clock.runFor(100);
  near(parseT(await sw.innerText()), 665_530, 50, "after a 10-minute jump");
  await win.getByRole("button", { name: "Pause", exact: true }).click();
  const held = parseT(await sw.innerText());
  await page.clock.runFor(5_000);
  eq(parseT(await sw.innerText()), held, "paused stopwatch does not advance");
  await win.getByRole("button", { name: "Reset", exact: true }).click();
  eq(await sw.innerText(), "00:00.00", "reset");
  await page.context().close();
});

await test("PR-10 timer fires on time with requestAnimationFrame never running (hidden-tab emulation): 0 min 3 s → 'Timer finished' at 3 s, not before", { "PR-10": "full" }, async () => {
  const { page, win } = await clockPage("window.requestAnimationFrame = () => 1; window.cancelAnimationFrame = () => {};");
  await win.getByLabel("Minutes").fill("0"); await win.getByLabel("Seconds").fill("3");
  eq(await win.getByTestId("clock-timer").innerText(), "00:03.00", "timer set to 3 s");
  await win.getByRole("button", { name: "Start timer" }).click();
  const toast = page.getByText("Timer finished");
  await page.clock.runFor(2_500);
  eq(await toast.count(), 0, "not fired at 2.5 s");
  await page.clock.runFor(1_000);
  await toast.first().waitFor({ timeout: 5_000 });
  ok(await win.getByRole("button", { name: "Start timer" }).isVisible(), "timer reset to Start after firing");
  // zero-length timers cannot be started (the old UI coerced 0 minutes to 1)
  await win.getByLabel("Seconds").fill("0");
  ok(await win.getByRole("button", { name: "Start timer" }).isDisabled(), "0:00 timer disabled");
  await page.context().close();
});

await test("PR-12 clipboard history: Fusion copies land in the system clipboard (read back independently) and the history; same text twice = one entry moved to top; pin survives Clear; search filters", { "PR-12": "full" }, async () => {
  const w = (id: string, module: string, title: string, x: number) => ({ id, module, title, x, y: 40, w: 560, h: 520, z: 20 + x, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
  await putDesktop([w("w-calc", "calculator", "Calculator", 20), w("w-clip", "clipboard", "Clipboard", 620)]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); ctx.setDefaultTimeout(20_000);
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(BASE).origin });
  const page = await ctx.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const calc = page.locator('[role=dialog][aria-label="Calculator"]').first(); const clip = page.locator('[role=dialog][aria-label="Clipboard"]').first();
  await calc.waitFor({ timeout: 30_000 }); await clip.waitFor();
  const items = clip.getByTestId("clip-list").locator("[role=listitem]");
  const texts = async () => (await items.locator(".fs-mono").allTextContents()).map((t) => t.trim());
  const sys = () => page.evaluate(() => navigator.clipboard.readText());
  const compute = async (expr: string) => { await calc.getByLabel("Expression").fill(expr); await calc.getByLabel("Expression").press("Enter"); };
  await compute("6*7");
  await calc.getByRole("button", { name: "Copy", exact: true }).click();
  await poll(async () => (await sys()) === "42", "system clipboard holds 42");
  await calc.getByRole("button", { name: "Copy", exact: true }).click();
  await compute("2+2"); await calc.getByRole("button", { name: "Copy", exact: true }).click();
  await poll(async () => (await sys()) === "4", "system clipboard holds 4");
  await poll(async () => JSON.stringify(await texts()) === JSON.stringify(["4", "42"]), "two entries, newest first, no duplicate 42");
  await compute("6*7"); await calc.getByRole("button", { name: "Copy", exact: true }).click();
  await poll(async () => JSON.stringify(await texts()) === JSON.stringify(["42", "4"]), "copying 42 again moves it to the top");
  // pin 4 → shown first; Clear keeps only pinned
  await clip.getByRole("button", { name: "Pin entry 2" }).click();
  await poll(async () => JSON.stringify(await texts()) === JSON.stringify(["4", "42"]), "pinned entry first");
  await clip.getByRole("button", { name: "Clear unpinned entries" }).click();
  await poll(async () => JSON.stringify(await texts()) === JSON.stringify(["4"]), "Clear kept the pinned entry");
  await clip.getByLabel("Search clipboard history").fill("zzz");
  await clip.getByTestId("clip-none").waitFor();
  await clip.getByLabel("Search clipboard history").fill("4");
  await poll(async () => (await items.count()) === 1, "search finds it");
  await clip.getByRole("button", { name: "Remove entry 1" }).click();
  await poll(async () => (await clip.getByTestId("clip-list").locator("[role=listitem]").count()) === 0, "removed");
  await ctx.close();
});

await test("no uncaught page errors during the TT57 rows session", { "PR-10": "full" }, () => { eq(errors, [], "page errors"); });

await browser.close();
await putDesktop([]);
await finish();
process.exit(0);
