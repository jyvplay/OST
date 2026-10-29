/**
 * Real-browser suite "e2e-layout" (TT25): the Business (Windows-style taskbar) and Art (Mac-style menu bar + dock)
 * layouts in headless Chromium against the production build, plus the two professional styles.
 * Everything is driven through the UI (clicks, hover, keyboard) and checked in the DOM, by measured geometry, through
 * the persisted settings and with axe-core. The layout is reset to Fusion afterwards (other suites expect it).
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-layout.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";
import { MODULES } from "../src/lib/registry.ts";
import { DOCK_MAX_SCALE } from "../src/lib/layout-core.ts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-layout");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const setSetting = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
const getSetting = async (key: string) => (await api("GET", "/api/settings")).json.rows.find((r: { key: string }) => r.key === key)?.value as string | undefined;
async function desktop(windows: unknown[] = []) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Build" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const win = (id: string, module: string, title: string, extra: Record<string, unknown> = {}) => ({ id, module, title, x: 60, y: 40, w: 900, h: 640, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props: {}, ...extra });
async function poll(fn: () => Promise<boolean>, what: string, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 100)); } throw new Error(`timed out: ${what}`); }
const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
interface Violation { id: string; impact: string; help: string; nodes: { target: string[] }[] }
async function axe(page: Page): Promise<Violation[]> {
  if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, o: unknown) => Promise<{ violations: Violation[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] }, resultTypes: ["violations"] });
    return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => ({ target: n.target })) }));
  });
}

const browser: Browser = await launchChromium();
async function boot(vw = 1440, vh = 900, opts: Record<string, unknown> = {}): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, ...opts });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await poll(async () => (await page.locator("[data-testid=launcher-button], [data-testid=dock]").count()) > 0, "shell chrome", 30_000);
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
  return { page, close: () => ctx.close() };
}
const layoutOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.layout);
const box = async (l: Locator) => { const b = await l.boundingBox(); if (!b) throw new Error("no box"); return b; };
const scaleOf = async (page: Page, id: string) => Number(await page.getByTestId(`dock-${id}`).getAttribute("data-scale"));

await setSetting("appearance.style", "poolside"); await setSetting("appearance.theme", "dark"); await setSetting("appearance.textScale", "125");
await setSetting("appearance.wallpaper", "auto"); await setSetting("appearance.dockMagnify", "on");

try {
  await test("Settings → Layout: picking Business swaps the top bar + shelf for a bottom taskbar; persisted across a reload", { "LY-03": "full", "LY-01": "partial" }, async () => {
    await setSetting("appearance.layout", "fusion");
    await desktop([win("s1", "settings", "Settings", { w: 1200, h: 760, x: 20, y: 10 })]);
    const { page, close } = await boot();
    ok(await layoutOf(page) === "fusion" && await page.locator('[role="banner"]').count() === 1 && await page.locator('[aria-label="Shelf"]').count() === 1, "starts as Fusion");
    const radio = page.getByTestId("settings-layout-business");
    ok(await radio.getAttribute("type") === "radio", "native radio (keyboard + screen reader semantics)");
    await radio.check();
    await poll(async () => (await layoutOf(page)) === "business", "data-layout=business");
    ok(await page.getByTestId("taskbar").isVisible(), "taskbar visible");
    ok(await page.locator('[role="banner"]').count() === 0 && await page.locator('[aria-label="Shelf"]').count() === 0, "no top bar, no shelf");
    const tb = await box(page.getByTestId("taskbar"));
    ok(Math.abs(tb.y + tb.height - 900) <= 1 && tb.width >= 1439, `taskbar spans the bottom edge: ${JSON.stringify(tb)}`);
    await poll(async () => (await getSetting("appearance.layout")) === "business", "persisted");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("taskbar").waitFor({ timeout: 30_000 });
    ok(await layoutOf(page) === "business", "still Business after reload");
    // keyboard: arrow keys move through the native radio group
    await page.getByTestId("settings-layout-business").focus();
    await page.keyboard.press("ArrowRight");
    await poll(async () => (await layoutOf(page)) === "art", "ArrowRight → Art");
    await page.getByTestId("dock").waitFor();
    await poll(async () => (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "settings-layout-art", "focus stays on the Art radio across the re-layout");
    await page.keyboard.press("ArrowLeft");
    await poll(async () => (await layoutOf(page)) === "business", "ArrowLeft → Business");
    await close();
  });

  await test("Business taskbar: open → minimise → restore on click, Shift+click new window, jump list, Show desktop round trip, clock → Planner", { "LY-01": "full" }, async () => {
    await setSetting("appearance.layout", "business");
    await desktop([]);
    const { page, close } = await boot();
    const files = page.getByTestId("taskbar-files");
    const fw = page.locator('.fs-window[aria-label="Files"]');
    await files.click();
    await fw.first().waitFor();
    await poll(async () => (await files.getAttribute("data-focused")) === "true", "focused indicator");
    const ind = files.locator(".fs-tb-ind");
    ok((await box(ind)).width > 12, "focused → long accent bar");
    await files.click();
    await poll(async () => (await fw.count()) === 0, "clicking the focused app minimises it");
    await poll(async () => (await box(ind)).width < 10 && (await files.getAttribute("data-focused")) === null, "running but not focused → short bar");
    await files.click();
    await poll(async () => (await fw.count()) === 1, "click again restores");
    await files.click({ modifiers: ["Shift"] });
    await poll(async () => (await fw.count()) === 2, "Shift+click → second window");
    ok(/2 windows/.test((await files.getAttribute("aria-label")) ?? ""), `label counts windows: ${await files.getAttribute("aria-label")}`);
    // jump list
    await files.click({ button: "right" });
    const jl = page.getByTestId("jump-list");
    await jl.waitFor();
    ok(await page.evaluate(() => document.activeElement?.getAttribute("role")?.startsWith("menuitem")), "focus moves into the jump list");
    await page.keyboard.press("Escape");
    await poll(async () => (await jl.count()) === 0, "Esc closes the jump list");
    await files.click({ button: "right" });
    await page.getByTestId("jump-close-files").click();
    await poll(async () => (await fw.count()) === 0, "jump list Close all windows");
    // Show desktop
    await page.getByTestId("taskbar-terminal").click();
    await page.getByTestId("taskbar-writer").click();
    await page.locator(".fs-window").first().waitFor();
    const before = await page.locator(".fs-window").count();
    ok(before >= 2, `two windows open (${before})`);
    await page.getByTestId("show-desktop").click();
    await poll(async () => (await page.locator(".fs-window").count()) === 0, "Show desktop hides every window");
    await page.getByTestId("show-desktop").click();
    await poll(async () => (await page.locator(".fs-window").count()) === before, "second press brings exactly those back");
    // clock → Planner (Windows opens the calendar flyout)
    await page.getByTestId("taskbar-clock").click();
    await page.locator('.fs-window[aria-label="Planner"]').waitFor();
    ok(/\d/.test(await page.getByTestId("taskbar-clock").innerText()) && (await page.getByTestId("taskbar-clock").innerText()).split("\n").length === 2, "stacked time / date");
    await close();
  });

  await test("Business: Start menu opens above the taskbar at bottom-left, search + Enter launches; Quick settings and toasts sit bottom-right; Windows caption buttons", { "LY-01": "full" }, async () => {
    await setSetting("appearance.layout", "business");
    await desktop([win("c1", "calculator", "Calculator", { w: 460, h: 560 })]);
    const { page, close } = await boot();
    const tb = await box(page.getByTestId("taskbar"));
    await page.getByTestId("launcher-button").click();
    const sm = page.getByTestId("start-menu");
    await sm.waitFor();
    const s = await box(sm);
    ok(s.x <= 16 && Math.abs(s.y + s.height - (tb.y - 8)) <= 2, `Start menu bottom-left above the taskbar: ${JSON.stringify(s)} taskbar y ${tb.y}`);
    ok(await page.getByTestId("launcher-button").getAttribute("aria-expanded") === "true", "Start reports expanded");
    ok(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "start-search", "search field focused");
    await page.keyboard.type("whitebo");
    ok(await sm.getByTestId("start-all-whiteboard").count() === 1 && await sm.getByTestId("start-all-files").count() === 0, "filters");
    await page.keyboard.press("Enter");
    await page.locator('.fs-window[aria-label="Whiteboard"]').waitFor();
    ok(await sm.count() === 0, "Start closes after launch");
    // Quick settings anchored bottom-right
    await page.getByTestId("taskbar-quick").click();
    const qp = page.locator('[role="dialog"][aria-label="Quick panel"]');
    await qp.waitFor();
    const q = await box(qp);
    ok(await qp.getAttribute("data-anchor") === "bottom" && q.x + q.width >= 1440 - 14 && Math.abs(q.y + q.height - (tb.y - 8)) <= 2, `Quick panel bottom-right: ${JSON.stringify(q)}`);
    // toast position: switching style from the Quick panel raises a toast
    await page.getByTestId("quick-style-enterprise").click();
    const toast = page.getByTestId("toasts").locator(".fs-panel").first();
    await toast.waitFor();
    const t = await box(toast);
    ok(t.x + t.width >= 1440 - 14 && t.y + t.height <= tb.y, `toast bottom-right above the taskbar: ${JSON.stringify(t)}`);
    await page.keyboard.press("Escape");
    // caption buttons: Minimise, Maximise, Close at the far right of the title bar, Close last; Close hover is red
    const cw = page.locator('.fs-window[aria-label="Calculator"]');
    await cw.locator(".fs-titlebar").click({ position: { x: 120, y: 10 } });
    const labels = await cw.locator(".fs-caption button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    ok(JSON.stringify(labels) === JSON.stringify(["Minimise", "Maximise or restore", "Close window"]), `caption order ${JSON.stringify(labels)}`);
    const tbar = await box(cw.locator(".fs-titlebar")), close_ = await box(cw.locator(".fs-cap-close"));
    ok(Math.abs(close_.x + close_.width - (tbar.x + tbar.width)) <= 1.5 && close_.height >= tbar.height - 2, `Close fills the top-right corner ${JSON.stringify(close_)} / ${JSON.stringify(tbar)}`);
    await cw.locator(".fs-cap-close").hover();
    await poll(async () => (await cw.locator(".fs-cap-close").evaluate((e) => getComputedStyle(e).backgroundColor)) === "rgb(196, 43, 28)", "Close hover is Windows red");
    await cw.locator(".fs-cap-maximize").click();
    await poll(async () => { const b = await box(cw); return Math.abs(b.y + b.height - tb.y) <= 2 && b.width >= 1438; }, "maximised window stops at the taskbar");
    await close();
    await setSetting("appearance.style", "poolside");
  });

  await test("Quick panel → Layout: Art gives a menu bar and a centred dock holding EVERY app (+ Launchpad, Trash); no taskbar", { "LY-03": "full", "LY-02": "partial" }, async () => {
    await setSetting("appearance.layout", "fusion");
    await desktop([]);
    const { page, close } = await boot();
    await page.getByRole("button", { name: "Quick panel" }).click();
    await page.getByTestId("quick-layout-art").check();
    await poll(async () => (await layoutOf(page)) === "art", "data-layout=art");
    await page.getByTestId("dock").waitFor();
    ok(await page.getByTestId("menubar").isVisible() && await page.getByTestId("taskbar").count() === 0 && await page.locator('[aria-label="Shelf"]').count() === 0, "menu bar, no taskbar/shelf");
    // TT26: every app is reachable from the dock — as its own icon or inside its group's stack (no slot-maxing)
    const folded = ((await page.getByTestId("dock").getAttribute("data-folded")) ?? "").split(",").filter(Boolean);
    const missing: string[] = [];
    for (const m of MODULES) {
      if ((await page.getByTestId(`dock-${m.id}`).count()) === 1) continue;
      if (!folded.includes(m.group)) { missing.push(m.id); continue; }
      await page.getByTestId(`dock-stack-${m.group}`).click();
      if ((await page.getByTestId(`dock-stack-app-${m.id}`).count()) !== 1) missing.push(m.id);
      await page.keyboard.press("Escape");
    }
    ok(missing.length === 0, `every module reachable from the dock; missing: ${missing.join(",")}`);
    ok(await page.getByTestId("dock-launchpad").count() === 1 && await page.getByTestId("dock-trash").count() === 1, "Launchpad + Trash");
    // measure the dock at rest: the stack clicks above leave the pointer on it and (after Esc) keyboard focus on a stack
    // button — magnification follows both the pointer and focus, and widens the dock
    await page.mouse.move(720, 300);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // "at rest" = no slot magnified (every slot ≤ the base size) AND the width is stable; two equal samples alone can
    // both land before the blur re-render starts the shrink transition (seen in TT28's full run)
    let prevW = -1;
    await poll(async () => {
      const unmagnified = await page.evaluate(() => { const d = document.querySelector("[data-testid=dock]") as HTMLElement; const base = Number(d.dataset.base); return [...d.querySelectorAll(".fs-dock-slot")].every((c) => c.getBoundingClientRect().width <= base + 0.5); });
      const w = (await box(page.getByTestId("dock"))).width; const same = Math.abs(w - prevW) < 0.5; prevW = w; return unmagnified && same;
    }, "dock at rest");
    const d = await box(page.getByTestId("dock"));
    ok(Math.abs(d.x + d.width / 2 - 720) <= 2, `dock centred (${d.x + d.width / 2})`);
    ok(d.y + d.height <= 900 - 3 && d.x > 0 && d.x + d.width < 1440, `dock floats inside the screen ${JSON.stringify(d)}`);
    const kids = d.width <= 1440 * 0.9 + 1 ? "" : await page.evaluate(() => [...document.querySelector("[data-testid=dock]")!.children].map((c) => `${(c.querySelector("[data-testid]") as HTMLElement | null)?.dataset.testid ?? c.className}:${Math.round(c.getBoundingClientRect().width)}`).join(" "));
    ok(d.width <= 1440 * 0.9 + 1, `dock leaves breathing room (${d.width} ≤ 90%) ${kids}`);
    const base = Number(await page.getByTestId("dock").getAttribute("data-base"));
    ok(base >= 44 && base <= 64 && base % 4 === 0, `aesthetic base icon size on the 4-px grid: ${base}`);
    ok(await getSetting("appearance.layout") === "art", "persisted");
    await close();
  });

  await test("Art dock: aesthetic size + stacks — size from the screen not the app count, groups fold into stacks (grid popover, arrows, Esc), a launched app from a folded group shows as its own running icon, size presets", { "LY-05": "full" }, async () => {
    await setSetting("appearance.layout", "art"); await setSetting("appearance.dockSize", "auto");
    await desktop([]);
    const { page, close } = await boot();
    const base = Number(await page.getByTestId("dock").getAttribute("data-base"));
    ok(base === 48, `1440×900 → 48 px (got ${base})`);
    const icons = page.locator(".fs-dock-item");
    for (let i = 0; i < await icons.count(); i++) { const b = await box(icons.nth(i)); ok(Math.abs(b.width - base) <= 1 && Math.abs(b.height - base) <= 1, `icon ${i} square at rest ${b.width}×${b.height}`); }
    const folded = ((await page.getByTestId("dock").getAttribute("data-folded")) ?? "").split(",");
    // TT79 added an app to Core, so at 1440 the plan folds it as well: what matters is that the dock fits,
    // folds whole groups (biggest saving first) rather than clipping, and keeps the pinned apps out
    ok(folded.includes("Create") && folded.includes("System"), `the two biggest groups fold first: ${folded}`);
    ok(await page.getByTestId("dock").getAttribute("data-magnify") === "on", "folded dock still fits (magnification on)");
    ok(await page.getByTestId("dock-settings").count() === 1 && await page.getByTestId("dock-files").count() === 1, "pinned Settings + Files stay out");
    const stack = page.getByTestId("dock-stack-Create");
    ok(await stack.getAttribute("aria-haspopup") === "dialog" && await stack.getAttribute("aria-expanded") === "false", "stack is a dialog button");
    await stack.click();
    const pop = page.getByTestId("dock-stack-pop");
    await pop.waitFor();
    ok(await stack.getAttribute("aria-expanded") === "true", "expanded");
    // the popover springs in (translateY + scale), so judge its resting position
    let pb = await box(pop), db = await box(page.getByTestId("dock"));
    await poll(async () => { pb = await box(pop); db = await box(page.getByTestId("dock")); return pb.y + pb.height <= db.y + 1; }, "popover settles above the dock", 4000).catch(() => {});
    ok(pb.y + pb.height <= db.y + 1, `popover above the dock (${pb.y + pb.height} ≤ ${db.y})`);
    ok(await page.getByTestId("dock").getAttribute("data-magnify") === "off", "dock frozen while a stack is open");
    // TT111: the stack lists only the apps that are actually in it (running apps are excluded), so read the
    // real button order out of the popover instead of deriving it from the module registry.
    const ids = await pop.locator("[data-testid^=dock-stack-app-]").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-testid")));
    ok(ids.length >= 2, `the stack lists its apps: ${ids.join(",")}`);
    ok(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === ids[0],
      `focus moves to the first app in the stack (${ids[0]}): got ${await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))}`);
    await page.keyboard.press("ArrowRight");
    ok(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === ids[1], `ArrowRight → next app (${ids[1]})`);
    await page.keyboard.press("Escape");
    await poll(async () => (await pop.count()) === 0, "Esc closes");
    ok(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "dock-stack-Create", "focus back on the stack tile");
    await stack.click();
    await page.getByTestId("dock-stack-app-notes").click();
    await poll(async () => (await page.locator('.fs-window').count()) === 1, "Notes window opened from the stack");
    await poll(async () => (await page.getByTestId("dock-notes").count()) === 1, "running app of a folded group appears as its own icon");
    ok(await page.getByTestId("dock-notes").locator("xpath=..").locator(".fs-dock-dot").count() === 1, "with a running dot");
    await setSetting("appearance.dockSize", "large");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("dock").waitFor({ timeout: 30_000 });
    await poll(async () => Number(await page.getByTestId("dock").getAttribute("data-base")) === 64, "Large preset → 64 px");
    ok((await box(page.getByTestId("dock"))).width <= 1440 * 0.9 + 1, "still within 90% of the screen at 64 px");
    await setSetting("appearance.dockSize", "auto");
    ok((await setSetting("appearance.dockSize", "huge")).status === 422, "unknown size refused");
    await close();
    // a smaller screen keeps the same pleasing size and folds more instead of shrinking
    await desktop([]);
    const small = await boot(1024, 768);
    const b2 = Number(await small.page.getByTestId("dock").getAttribute("data-base"));
    const d2 = await box(small.page.getByTestId("dock"));
    ok(b2 === 44 && d2.width <= 1024 * 0.9 + 1, `1024×768 → 44 px, dock ${d2.width}px`);
    await small.close();
  });

  await test("Art dock magnification: measured peak under the pointer, cosine falloff, name bubble, stable under the pointer, reset on leave; off switch", { "LY-02": "full" }, async () => {
    await setSetting("appearance.layout", "art");
    await desktop([]);
    const { page, close } = await boot();
    const base = Number(await page.getByTestId("dock").getAttribute("data-base"));
    // TT79 grew Core to 11 apps, so at 1440 the dock folds it into a stack: launch two of its apps from the
    // stack, and they stay in the dock as running icons (the plan keeps running apps out of the stack)
    // launching one app from the stack also unfolds Core (the plan keeps a group open once its apps are running),
    // so the dock then shows every Core app as its own icon — which is what the magnification maths is measured on
    const stack = page.getByTestId("dock-stack-Core");
    await stack.click();
    await page.getByTestId("dock-stack-app-calculator").click();
    await poll(async () => (await page.getByTestId("dock-calculator").count()) === 1 && (await page.getByTestId("dock-clock").count()) === 1, "launched apps are dock icons");
    const target = "calculator", left1 = "clock", left4 = "files";
    const t0 = await box(page.getByTestId(`dock-${target}`));
    ok(Math.abs(t0.width - base) <= 1, `resting width ${t0.width} ≈ base ${base}`);
    const cx = t0.x + t0.width / 2, cy = t0.y + t0.height / 2;
    await page.mouse.move(cx, cy, { steps: 6 });
    await poll(async () => Math.abs((await scaleOf(page, target)) - DOCK_MAX_SCALE) < 0.03, `peak scale under the pointer (${await scaleOf(page, target)})`);
    await poll(async () => Math.abs((await box(page.getByTestId(`dock-${target}`))).width - base * DOCK_MAX_SCALE) <= 2, "measured width = base × max");
    const sNear = await scaleOf(page, left1), sFar = await scaleOf(page, left4);
    ok(sNear > 1.2 && sNear < DOCK_MAX_SCALE - 0.05, `neighbour partly enlarged (${sNear})`);
    ok(sFar === 1, `4 icons away stays at 1 (${sFar})`);
    const tip = page.locator('[role="tooltip"].fs-dock-label');
    ok((await tip.innerText()).trim() === MODULES.find((m) => m.id === target)!.title, `name bubble: ${await tip.innerText()}`);
    // TT111: the bubble springs up with the icon, so judge its RESTING position — the same rule this suite
    // already applies to the stack popover. Mid-animation it can still be behind the growing icon.
    let tb = await box(tip), tb2 = await box(page.getByTestId(`dock-${target}`));
    await poll(async () => { tb = await box(tip); tb2 = await box(page.getByTestId(`dock-${target}`)); return tb.y + tb.height <= tb2.y; },
      "name bubble settles above the icon", 4000);
    ok(tb.y + tb.height <= tb2.y, `bubble above the magnified icon (${tb.y + tb.height} ≤ ${tb2.y})`);
    // stability: the magnified icon stays under the pointer while the dock widens around it
    for (const dx of [-base * 0.3, 0, base * 0.3]) {
      await page.mouse.move(cx + dx, cy);
      await page.waitForTimeout(150);
      const b = await box(page.getByTestId(`dock-${target}`));
      ok(cx + dx >= b.x - 1 && cx + dx <= b.x + b.width + 1, `pointer ${dx.toFixed(1)} still over the icon (${b.x.toFixed(1)}–${(b.x + b.width).toFixed(1)})`);
    }
    // icons grow upward, the dock itself keeps its height
    const dockH = (await box(page.getByTestId("dock"))).height;
    ok(Math.abs(dockH - (base + 16)) <= 2, `dock height unchanged (${dockH})`);
    await page.mouse.move(700, 300);
    await poll(async () => (await scaleOf(page, target)) === 1 && (await tip.count()) === 0, "leave → back to rest, bubble gone");
    // off switch in Settings
    await page.getByTestId("dock-settings").click();
    await page.getByTestId("settings-dock-magnify").uncheck();
    await poll(async () => (await page.getByTestId("dock").getAttribute("data-magnify")) === "off", "magnify off");
    const t1 = await box(page.getByTestId(`dock-${target}`));
    await page.mouse.move(t1.x + t1.width / 2, t1.y + t1.height / 2, { steps: 4 });
    await page.waitForTimeout(250);
    ok((await scaleOf(page, target)) === 1 && (await tip.count()) === 1, "no magnification when off, name bubble still shown");
    await page.getByTestId("settings-dock-magnify").check();
    await close();
  });

  await test("Art dock: launch bounces and shows a running dot; minimise (traffic light) parks the window after the separator, click restores; right-click Quit", { "LY-02": "full" }, async () => {
    await setSetting("appearance.layout", "art");
    await desktop([]);
    const { page, close } = await boot();
    const calc = page.getByTestId("dock-files");   // Files is pinned, so it is always a dock icon
    await calc.click();
    ok(await calc.getAttribute("data-bounce") === "true", "bounce on launch");
    const cw = page.locator('.fs-window[aria-label="Files"]');
    await cw.waitFor();
    ok(/running/.test((await calc.getAttribute("aria-label")) ?? ""), "label says running");
    ok(await calc.locator("xpath=..").locator(".fs-dock-dot").count() === 1, "running dot");
    await poll(async () => (await calc.getAttribute("data-bounce")) === null, "bounce ends", 3000);
    ok(await page.getByTestId("menubar-app").innerText() === "Files", "menu bar shows the focused app");
    await cw.locator('.fs-traffic button[aria-label="Minimise"]').click();
    await poll(async () => (await cw.count()) === 0, "minimised");
    const minItem = page.locator('[data-testid^="dock-min-"]');
    await minItem.waitFor();
    const order = await page.getByTestId("dock").locator("[data-testid]").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    ok(order.indexOf(order.find((x) => x?.startsWith("dock-min-"))!) > order.indexOf("dock-settings") && order.at(-1) === "dock-trash", `minimised after the apps, Trash last: …${order.slice(-3).join(",")}`);
    await minItem.click();
    await cw.waitFor();
    ok(await minItem.count() === 0, "restored window leaves the dock");
    await calc.click({ button: "right" });
    await page.getByTestId("dock-quit-files").click();
    await poll(async () => (await cw.count()) === 0 && !/running/.test((await calc.getAttribute("aria-label")) ?? ""), "Quit closes the app");
    // Trash opens Files on the trash view
    await page.getByTestId("dock-trash").click();
    const tw = page.locator('.fs-window[aria-label="Trash"]');
    await tw.waitFor();
    await poll(async () => (await tw.getByRole("button", { name: "Trash", exact: true }).getAttribute("aria-pressed")) === "true", "Files opened on Trash");
    await close();
  });

  await test("Art window chrome + menus: traffic lights left (close, minimise, zoom), centred title, Window menu tiles/zooms, zoomed window stops above the dock, Launchpad", { "LY-02": "full" }, async () => {
    await setSetting("appearance.layout", "art");
    await desktop([win("n1", "notes", "Notes"), win("w1", "writer", "Writer", { x: 200, y: 80, z: 12 })]);
    const { page, close } = await boot();
    const ww = page.locator('.fs-window[aria-label="Writer"]');
    const labels = await ww.locator(".fs-traffic button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    ok(JSON.stringify(labels) === JSON.stringify(["Close window", "Minimise", "Maximise or restore"]), `traffic-light order ${JSON.stringify(labels)}`);
    const tl = await box(ww.locator(".fs-traffic")), title = await box(ww.locator(".fs-title-centre span")), wb = await box(ww);
    ok(tl.x - wb.x < 20 && tl.x < title.x, "traffic lights at the left edge");
    ok(Math.abs(title.x + title.width / 2 - (wb.x + wb.width / 2)) < 60, `title centred (${(title.x + title.width / 2 - (wb.x + wb.width / 2)).toFixed(1)} px off)`);
    // inactive window → grey lights
    const nw = page.locator('.fs-window[aria-label="Notes"]');
    const grey = await nw.locator(".fs-tl-close").evaluate((e) => getComputedStyle(e, "::before").backgroundColor);
    const red = await ww.locator(".fs-tl-close").evaluate((e) => getComputedStyle(e, "::before").backgroundColor);
    ok(red === "rgb(255, 95, 87)" && grey !== red, `focused red ${red}, inactive ${grey}`);
    // Frame menu (keyboard: ArrowDown opens and focuses the first item, which is "New <app> window")
    await page.getByTestId("menu-window").focus();
    await page.keyboard.press("ArrowDown");
    await page.locator('[role="menu"][aria-label="Frame"]').waitFor();
    await poll(async () => /New .* window/.test(await page.evaluate(() => document.activeElement?.textContent ?? "")), "first item focused");
    await page.keyboard.press("ArrowDown");
    await poll(async () => Boolean(await page.evaluate(() => document.activeElement?.textContent?.includes("Close window"))), "second item is Close window");
    await page.keyboard.press("ArrowDown");
    await poll(async () => Boolean(await page.evaluate(() => document.activeElement?.textContent?.includes("Quit"))), "third item is Quit");
    await page.keyboard.press("ArrowDown");
    await poll(async () => Boolean(await page.evaluate(() => document.activeElement?.textContent?.includes("Minimise"))), "fourth item is Minimise");
    ok(await page.locator('[role="menu"][aria-label="Frame"] [role="menuitemcheckbox"]').count() === 2, "window list in the menu");
    await page.getByTestId("menu-tile-left").click();
    const desk = await page.evaluate(() => { const m = document.querySelector("[data-testid=menubar]")!.getBoundingClientRect(); const d = document.querySelector("[data-testid=dock-row]")!.getBoundingClientRect(); return { top: m.bottom, bottom: d.top }; });
    await poll(async () => { const b = await box(ww); return Math.abs(b.x) <= 1 && Math.abs(b.width - 720) <= 2; }, "Window → Move to Left Side");
    await page.getByTestId("menu-window").click();
    await page.getByTestId("menu-zoom").click();
    await poll(async () => { const b = await box(ww); return Math.abs(b.y - desk.top) <= 2 && Math.abs(b.y + b.height - desk.bottom) <= 2; }, `zoomed window fills menu bar → dock (${JSON.stringify(desk)})`);
    // Launchpad
    await page.getByTestId("dock-launchpad").click();
    const lp = page.getByTestId("launchpad");
    await lp.waitFor();
    ok(await lp.locator(".fs-lp-item").count() === MODULES.length, "Launchpad lists every app");
    await page.keyboard.type("contac");
    await page.keyboard.press("Enter");
    await page.locator('.fs-window[aria-label="Contacts"]').waitFor();
    ok(await lp.count() === 0, "Launchpad closes after launch");
    await page.getByTestId("dock-launchpad").click(); await lp.waitFor();
    await page.keyboard.press("Escape");
    await poll(async () => (await lp.count()) === 0, "Esc closes Launchpad");
    await close();
  });

  await test("keyboard + motion: Tab focus magnifies a dock icon and shows its name; reduced motion → no bounce, no transitions", { "LY-02": "partial", "AX-09": "partial" }, async () => {
    await setSetting("appearance.layout", "art");
    await desktop([]);
    const { page, close } = await boot(1440, 900, { reducedMotion: "reduce" });
    await page.getByTestId("dock-files").focus();
    await poll(async () => (await scaleOf(page, "files")) > 1.7, "focused icon magnified");
    ok((await page.locator('[role="tooltip"].fs-dock-label').innerText()).trim() === "Files", "name bubble for keyboard users");
    await page.keyboard.press("Tab");
    await poll(async () => (await scaleOf(page, "files")) < 1.7, "focus moved on");
    const td = await page.getByTestId("dock-files").evaluate((e) => getComputedStyle(e).transitionDuration);
    ok(td.split(",").every((x) => parseFloat(x) === 0), `no transition under reduced motion (${td})`);
    await page.getByTestId("dock-files").click();
    ok(await page.getByTestId("dock-files").evaluate((e) => getComputedStyle(e).animationName) === "none", "no bounce animation under reduced motion");
    await close();
  });

  await test("phone 360×640 in Art: the page never scrolls sideways; every group folds into a stack and the dock fits at ≥32 px; with many minimised windows it scrolls inside itself, magnification off (honest fallback)", { "LY-02": "partial", "LY-05": "partial", "AX-09": "partial" }, async () => {
    await setSetting("appearance.layout", "art");
    await desktop([]);
    const { page, close } = await boot(360, 640);
    const r = await page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: innerWidth }));
    ok(r.sw <= r.iw, `no page overflow ${JSON.stringify(r)}`);
    const d = page.getByTestId("dock");
    ok(((await d.getAttribute("data-folded")) ?? "").split(",").length === 4, `all four groups folded: ${await d.getAttribute("data-folded")}`);
    const base = Number(await d.getAttribute("data-base"));
    ok(base >= 32, `icons stay ≥32 px (${base})`);
    const s0 = await d.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }));
    ok(s0.sw <= s0.cw + 1, `dock fits without scrolling ${JSON.stringify(s0)}`);
    const b = await box(d);
    ok(b.x >= 0 && b.x + b.width <= 360, "dock inside the screen");
    await close();
    // many minimised windows: the honest fallback is an inner scroll, never page overflow
    await desktop(Array.from({ length: 8 }, (_, i) => win(`m${i}`, "calculator", `Calc ${i}`, { minimized: true })));
    const p2 = await boot(360, 640);
    const d2 = p2.page.getByTestId("dock");
    ok(await d2.getAttribute("data-magnify") === "off", "magnify off when the dock cannot fit");
    const s = await d2.evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX }));
    ok(s.ox === "auto" && s.sw > s.cw, `dock scrolls ${JSON.stringify(s)}`);
    const r2 = await p2.page.evaluate(() => ({ sw: document.scrollingElement!.scrollWidth, iw: innerWidth }));
    ok(r2.sw <= r2.iw, `still no page overflow ${JSON.stringify(r2)}`);
    await p2.close();
  });

  await test("axe-core: Business with Enterprise and Art with Graphite, dark + light, Start menu / Launchpad / menus open — no serious or critical violations", { "LY-04": "full", "LY-01": "partial", "LY-02": "partial", "AX-08": "partial" }, async () => {
    const bad: string[] = [];
    for (const [layout, style] of [["business", "enterprise"], ["art", "graphite"]] as const) {
      for (const theme of ["dark", "light"]) {
        await setSetting("appearance.layout", layout); await setSetting("appearance.style", style); await setSetting("appearance.theme", theme);
        await desktop([win("f1", "files", "Files", { w: 900, h: 560 })]);
        const { page, close } = await boot();
        ok(await page.evaluate(() => document.documentElement.dataset.style) === style, `${style} applied`);
        ok(await page.locator(`.fs-wallpaper-${style}`).count() === 1, `${style} wallpaper`);
        await page.waitForTimeout(500);
        for (const v of await axe(page)) bad.push(`${layout}/${style}/${theme} chrome: ${v.id} ${JSON.stringify(v.nodes.map((n) => n.target))}`);
        if (layout === "business") { await page.getByTestId("launcher-button").click(); await page.getByTestId("start-menu").waitFor(); }
        else { await page.getByTestId("menu-window").click(); await page.locator('[role="menu"]').waitFor(); }
        await page.waitForTimeout(400);
        for (const v of await axe(page)) bad.push(`${layout}/${style}/${theme} open: ${v.id} ${JSON.stringify(v.nodes.map((n) => n.target))}`);
        if (layout === "art") {
          await page.keyboard.press("Escape");
          await page.getByTestId("dock-launchpad").click(); await page.getByTestId("launchpad").waitFor(); await page.waitForTimeout(400);
          for (const v of await axe(page)) bad.push(`art/${style}/${theme} launchpad: ${v.id} ${JSON.stringify(v.nodes.map((n) => n.target))}`);
        }
        await close();
      }
    }
    ok(bad.length === 0, bad.slice(0, 8).join("\n"));
  });

  await test("API: unknown layout and dockMagnify values are refused (422); the setting is searchable by 'taskbar' and 'dock'", { "LY-03": "full" }, async () => {
    for (const v of ["windows", "", "Art", "art;"]) ok((await setSetting("appearance.layout", v)).status === 422, `layout ${JSON.stringify(v)} refused`);
    ok((await setSetting("appearance.dockMagnify", "maybe")).status === 422, "dockMagnify refused");
    const rows = (await api("GET", "/api/settings")).json.rows as { key: string; aliases?: string }[];
    const row = rows.find((r) => r.key === "appearance.layout");
    ok(row && /taskbar/.test(row.aliases ?? "") && /dock/.test(row.aliases ?? ""), `aliases ${row?.aliases}`);
  });
} finally {
  await setSetting("appearance.layout", "fusion"); await setSetting("appearance.style", "poolside"); await setSetting("appearance.theme", "dark");
  await setSetting("appearance.dockMagnify", "on"); await setSetting("appearance.dockSize", "auto");
  await desktop([]);
  await browser.close();
}
finish();
