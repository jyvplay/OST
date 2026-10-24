/**
 * Real-browser suite "e2e-whiteboard" (TT23): the Whiteboard module driven with real pointer and keyboard input in
 * headless Chromium against the production build. It covers:
 *   • drawing shapes, a pen stroke and a sticky note with text;
 *   • an arrow that binds to two shapes and follows when a shape is dragged;
 *   • keyboard nudge / duplicate / delete / undo, marquee selection + align;
 *   • save to .fboard, reopen, SVG export, and a hostile .fboard being repaired;
 *   • axe in three states.
 * Run: BASE=http://localhost:3999 node --experimental-strip-types --no-warnings --import ./scripts/register-hook.mjs scripts/e2e-whiteboard.mts
 */
import { readFileSync } from "node:fs";
import type { Browser, Locator, Page } from "playwright";
import { launchChromium } from "./browser-launch.mts";
import { makeHarness } from "./harness.mts";

const BASE = process.env.BASE ?? "http://localhost:3999";
const { test, finish } = makeHarness("e2e-whiteboard");
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const win = (id: string, props: Record<string, unknown> = {}) => ({ id, module: "whiteboard", title: "Whiteboard", x: 20, y: 10, w: 1380, h: 800, z: 11, minimized: false, maximized: false, workspace: 1, host: "tab", props });
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.json.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const browser: Browser = await launchChromium();
async function open(props: Record<string, unknown> = {}): Promise<{ page: Page; w: Locator; cv: Locator; at: (x: number, y: number) => Promise<[number, number]>; close: () => Promise<void> }> {
  await desktop([win("wb1", props)]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  const w = page.locator('.fs-window[aria-label="Whiteboard"]');
  await w.locator('[data-testid="whiteboard"]').waitFor({ timeout: 30_000 });
  const cv = w.getByTestId("wb-canvas");
  // camera starts at (0,0) zoom 1, so world (x, y) = canvas top-left + (x, y)
  const at = async (x: number, y: number): Promise<[number, number]> => { const b = (await cv.boundingBox())!; return [b.x + x, b.y + y]; };
  return { page, w, cv, at, close: () => ctx.close() };
}
async function dragW(page: Page, at: (x: number, y: number) => Promise<[number, number]>, from: [number, number], to: [number, number]) {
  const [ax, ay] = await at(...from), [zx, zy] = await at(...to);
  await page.mouse.move(ax, ay); await page.mouse.down(); await page.mouse.move(zx, zy, { steps: 8 }); await page.mouse.up();
}
const els = (w: Locator) => w.locator("[data-el]");
const kindCount = (w: Locator, k: string) => w.locator(`[data-el][data-kind="${k}"]`).count();
const geom = (w: Locator, k: string) => w.locator(`[data-el][data-kind="${k}"]`).last().evaluate((g) => {
  const all = g.querySelectorAll("rect,ellipse"); const r = all[all.length - 1];          // a sticky's first rect is its shadow
  if (r.tagName === "ellipse") { const cx = +r.getAttribute("cx")!, cy = +r.getAttribute("cy")!, rx = +r.getAttribute("rx")!, ry = +r.getAttribute("ry")!; return { id: g.getAttribute("data-el")!, x: cx - rx, y: cy - ry, w: rx * 2, h: ry * 2 }; }
  return { id: g.getAttribute("data-el")!, x: +r.getAttribute("x")!, y: +r.getAttribute("y")!, w: +r.getAttribute("width")!, h: +r.getAttribute("height")! };
});
const lineOf = (w: Locator, id: string) => w.locator(`[data-el="${id}"] path[data-line]`).getAttribute("d").then((d) => { const m = /M([-\d.]+) ([-\d.]+)L([-\d.]+) ([-\d.]+)/.exec(d!)!; return { ax: +m[1], ay: +m[2], zx: +m[3], zy: +m[4] }; });
async function poll(fn: () => Promise<boolean>, what: string, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 120)); } throw new Error(`timed out: ${what}`); }

await test("starter board: sticky + ellipse joined by a BOUND arrow, Layers list names them, module is in the launcher", { "WB-05": "partial", "WB-02": "partial" }, async () => {
  const { page, w, close } = await open();
  ok(await els(w).count() === 3, `3 elements, got ${await els(w).count()}`);
  const arrow = w.locator('[data-el][data-kind="arrow"]');
  ok((await arrow.getAttribute("data-start")) !== "" && (await arrow.getAttribute("data-end")) !== "", "arrow bound at both ends");
  const layers = await w.getByTestId("wb-layers").locator("button").allInnerTexts();
  ok(layers[0] === "Arrow from Ideas go here to Next step", `top layer: ${layers[0]}`);
  await page.getByTestId("launcher-button").click();
  ok(await page.getByRole("button", { name: /Whiteboard/ }).count() >= 1, "Whiteboard listed in the launcher");
  await close();
});

await test("draw shapes with the pointer: rect by drag (snapped), ellipse by click (default size), pen stroke, sticky note with two lines of text", { "WB-01": "full", "WB-05": "partial" }, async () => {
  const { page, w, cv, at, close } = await open();
  await w.getByTestId("wb-tool-rect").click();
  await dragW(page, at, [100, 300], [253, 388]);                                      // snap 10 → 150 × 90
  let g = await geom(w, "rect");
  ok(g.x === 100 && g.y === 300 && g.w === 150 && g.h === 90, `rect ${JSON.stringify(g)}`);
  ok(await w.getByTestId("wb-tool-select").getAttribute("aria-pressed") === "true", "tool returns to Select after drawing");
  await w.getByTestId("wb-tool-ellipse").click();
  const [ex, ey] = await at(500, 330); await page.mouse.click(ex, ey);
  g = await geom(w, "ellipse");
  ok(g.w === 140 && g.h === 80 && g.x === 500 && g.y === 330, `click → default 140×80 ellipse: ${JSON.stringify(g)}`);
  await w.getByTestId("wb-tool-pen").click();
  const pts: [number, number][] = [[700, 300], [720, 340], [760, 320], [800, 380]];
  let [px, py] = await at(...pts[0]); await page.mouse.move(px, py); await page.mouse.down();
  for (const p of pts.slice(1)) { [px, py] = await at(...p); await page.mouse.move(px, py, { steps: 6 }); }
  await page.mouse.up();
  const d = await w.locator('[data-el][data-kind="pen"]').getAttribute("d");
  ok(d && (d.match(/L/g) ?? []).length >= 3 && (d.match(/L/g) ?? []).length < 30, `pen kept its corners but was simplified: ${d?.slice(0, 80)}`);
  await cv.focus(); await page.keyboard.press("s");
  ok(await w.getByTestId("wb-tool-sticky").getAttribute("aria-pressed") === "true", "S selects the sticky tool");
  const [sx, sy] = await at(100, 480); await page.mouse.click(sx, sy);
  const ed = w.getByTestId("wb-text-editor");
  await ed.waitFor(); await ed.fill("Hello\nWorld"); await page.keyboard.press("Control+Enter");
  await poll(async () => (await w.locator('[data-el][data-kind="sticky"]').last().locator("tspan").allTextContents()).join("|").includes("Hello|World"), "sticky text rendered as two lines");
  ok(await els(w).count() === 7, `7 elements, got ${await els(w).count()}`);
  // Escape cancels an edit (TT23 repair: the blur that follows used to commit it anyway); undo history gets one entry
  await w.locator('[data-el][data-kind="sticky"]').last().dblclick();
  await ed.waitFor(); await ed.fill("SHOULD NOT STICK"); await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const after = (await w.locator('[data-el][data-kind="sticky"]').last().locator("tspan").allTextContents()).join("|");
  ok(after === "Hello|World", `Escape cancelled the edit: ${after}`);
  await close();
});

await test("connector follows: an arrow drawn from the rect to the ellipse binds both ends and stays on the rect's outline when the rect is dragged", { "WB-02": "full" }, async () => {
  const { page, w, at, close } = await open();
  await w.getByTestId("wb-tool-rect").click(); await dragW(page, at, [100, 300], [250, 390]);
  await w.getByTestId("wb-tool-ellipse").click(); const [ex, ey] = await at(500, 330); await page.mouse.click(ex, ey);
  const rect = await geom(w, "rect"), ell = await geom(w, "ellipse");
  await w.getByTestId("wb-tool-arrow").click();
  await dragW(page, at, [170, 340], [570, 370]);
  const arrow = w.locator('[data-el][data-kind="arrow"]').last();
  const id = (await arrow.getAttribute("data-el"))!;
  ok(await arrow.getAttribute("data-start") === rect.id && await arrow.getAttribute("data-end") === ell.id, `bound ${await arrow.getAttribute("data-start")}→${await arrow.getAttribute("data-end")}`);
  const before = await lineOf(w, id);
  // centres (175,345) → (570,370): leaves the rect at x = 250 (t = 75/395); meets the ellipse (rx 70, ry 40) on its outline
  ok(Math.abs(before.ax - 250) < 0.01, `start on the rect's right edge: ${JSON.stringify(before)}`);
  ok(Math.abs(((before.zx - 570) / 70) ** 2 + ((before.zy - 370) / 40) ** 2 - 1) < 1e-3 && before.zx < 520, `end on the ellipse outline: ${JSON.stringify(before)}`);
  // drag the rect (select tool) 100 down — the arrow must follow
  await dragW(page, at, [120, 320], [120, 420]);
  const r2 = await geom(w, "rect");
  ok(r2.y === 400, `rect moved to y 400: ${JSON.stringify(r2)}`);
  const after = await lineOf(w, id);
  const onEdge = (Math.abs(after.ax - r2.x) < 0.01 || Math.abs(after.ax - (r2.x + r2.w)) < 0.01 || Math.abs(after.ay - r2.y) < 0.01 || Math.abs(after.ay - (r2.y + r2.h)) < 0.01)
    && after.ax >= r2.x - 0.01 && after.ax <= r2.x + r2.w + 0.01 && after.ay >= r2.y - 0.01 && after.ay <= r2.y + r2.h + 0.01;
  ok(onEdge && after.ay !== before.ay, `start re-resolved on the moved rect's outline: ${JSON.stringify(after)} rect ${JSON.stringify(r2)}`);
  ok(await arrow.getAttribute("data-start") === rect.id, "still bound");
  await close();
});

await test("keyboard: Layers list selects, arrows nudge (Shift = 10), Ctrl+D duplicates, Delete removes, Ctrl+Z undoes; the text field edits", { "WB-05": "full", "WB-03": "partial" }, async () => {
  const { page, w, cv, close } = await open();
  await w.getByTestId("wb-layers").getByRole("button", { name: /^Ellipse: Next step/ }).click();
  ok(await w.getByTestId("wb-selection").count() === 1, "selected via the Layers list");
  const g0 = await geom(w, "ellipse");
  await cv.focus(); await page.keyboard.press("Shift+ArrowRight"); await page.keyboard.press("Shift+ArrowRight"); await page.keyboard.press("ArrowDown");
  const g1 = await geom(w, "ellipse");
  ok(g1.x === g0.x + 20 && g1.y === g0.y + 1, `nudged: ${JSON.stringify(g0)} → ${JSON.stringify(g1)}`);
  await page.keyboard.press("Control+d");
  ok(await els(w).count() === 4, "duplicated");
  await page.keyboard.press("Delete");
  ok(await els(w).count() === 3, "deleted the copy");
  await w.getByTestId("wb-layers").getByRole("button", { name: /^Ellipse: Next step/ }).click(); await cv.focus();
  await page.keyboard.press("Delete");                                                 // delete the original: the arrow survives, detached
  ok(await els(w).count() === 2 && (await w.locator('[data-el][data-kind="arrow"]').getAttribute("data-end")) === "", "arrow kept, end detached");
  await page.keyboard.press("Control+z");
  ok(await els(w).count() === 3 && (await w.locator('[data-el][data-kind="arrow"]').getAttribute("data-end")) !== "", "undo restores the ellipse and the binding");
  await w.getByTestId("wb-layers").getByRole("button", { name: /^Sticky note/ }).click();
  await w.getByTestId("wb-text-field").fill("Renamed idea");
  await poll(async () => (await w.getByTestId("wb-layers").locator("button").allInnerTexts()).some((t) => t === "Sticky note: Renamed idea"), "layer name follows the text");
  ok((await w.getByTestId("wb-layers").locator("button").first().innerText()).startsWith("Arrow from Renamed idea"), "connector description follows too");
  await close();
});

await test("arrange: marquee selects only enclosed elements, Align Left lines them up, Group makes one selection", { "WB-03": "full" }, async () => {
  const { page, w, at, close } = await open();
  await dragW(page, at, [40, 40], [560, 240]);                                          // encloses sticky (60..230) + ellipse (360..520) + arrow
  ok((await w.getByTestId("wb-count").innerText()).includes("3 selected"), await w.getByTestId("wb-count").innerText());
  await w.getByRole("button", { name: "Align Left" }).click();
  const s = await geom(w, "sticky"), e = await geom(w, "ellipse");
  ok(s.x === 60 && e.x === 60, `left-aligned: sticky ${s.x}, ellipse ${e.x}`);
  await w.getByRole("button", { name: "Group" }).click();
  await w.getByRole("button", { name: "To back" }).click();
  const [cx, cy] = await at(900, 600); await page.mouse.click(cx, cy);                  // empty → clears
  ok((await w.getByTestId("wb-count").innerText()).includes("0 selected"), "cleared");
  const [sx, sy] = await at(100, 100); await page.mouse.click(sx, sy);                  // one member → the whole group
  ok((await w.getByTestId("wb-count").innerText()).includes("3 selected"), `group (sticky + ellipse + arrow) selected as one: ${await w.getByTestId("wb-count").innerText()}`);
  await close();
});

await test("files: Save .fboard, reopen it from its path, Export SVG (escaped, no script); a hostile .fboard is repaired and the count reported", { "WB-04": "full" }, async () => {
  const path = "/Documents/E2E board.fboard", svgPath = "/Documents/E2E board.svg";
  for (const p of [path, svgPath]) await api("POST", "/api/fs", { op: "delete", path: p }).catch(() => undefined);
  let { w, close } = await open();
  await w.getByLabel("Board name").fill("E2E board");
  await w.getByTestId("wb-layers").getByRole("button", { name: /^Sticky note/ }).click();
  await w.getByTestId("wb-text-field").fill("<script>alert(1)</script>");
  await w.getByRole("button", { name: "Save .fboard" }).click();
  await poll(async () => (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).status === 200, "board written");
  const saved = JSON.parse((await api("GET", `/api/fs?op=read&path=${encodeURIComponent(path)}`)).json.node.content);
  ok(saved.format === "fusion-board-1" && saved.els.length === 3, `saved ${saved.format} ${saved.els?.length}`);
  await w.getByRole("button", { name: "Export SVG" }).click();
  await poll(async () => (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(svgPath)}`)).status === 200, "svg written");
  const svg = (await api("GET", `/api/fs?op=read&path=${encodeURIComponent(svgPath)}`)).json.node.content as string;
  ok(svg.startsWith("<svg") && !svg.includes("<script") && svg.includes("&lt;script&gt;"), "export escaped");
  await close();
  ({ w, close } = await open({ path, title: "E2E board.fboard" }));
  await poll(async () => (await els(w).count()) === 3, "reopened with 3 elements");
  ok((await w.getByTestId("wb-layers").locator("button").allInnerTexts()).some((t) => t.startsWith("Sticky note: <script>")), "text survived as text");
  await close();
  const evil = { ...saved, els: saved.els.map((e: { kind: string }) => (e.kind === "arrow" ? { ...e, end: "e999" } : e)) };
  await api("POST", "/api/fs", { op: "write", path: "/Documents/E2E evil.fboard", content: JSON.stringify(evil), reason: "test" });
  ({ w, close } = await open({ path: "/Documents/E2E evil.fboard", title: "E2E evil.fboard" }));
  await poll(async () => (await w.getByTestId("wb-status").innerText()).includes("repaired 1"), "repair reported");
  ok(await w.locator('[data-el][data-kind="arrow"]').getAttribute("data-end") === "", "dangling binding detached");
  await close();
  await api("POST", "/api/fs", { op: "delete", path: "/Documents/E2E evil.fboard" }).catch(() => undefined);
  await desktop([]);
});

await test("axe-core: default, with a selection (style + arrange panels), and with the text editor open — no serious/critical violations", { "WB-05": "partial", "AX-08": "partial" }, async () => {
  const AXE = readFileSync("node_modules/axe-core/axe.min.js", "utf8");
  const { page, w, close } = await open();
  const bad: string[] = [];
  const scan = async (where: string) => {
    await page.waitForTimeout(500);
    if (!(await page.evaluate(() => "axe" in window))) await page.addScriptTag({ content: AXE });
    const vs = await page.evaluate(async () => {
      const ax = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
      const r = await ax.run({ include: ['.fs-window[aria-label="Whiteboard"]'] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
      return r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} ${v.nodes[0]?.target.join(" ")}`);
    });
    for (const v of vs) bad.push(`${where}: ${v}`);
  };
  await scan("default");
  await w.getByTestId("wb-layers").getByRole("button", { name: /^Ellipse/ }).click(); await scan("selection");
  await w.getByTestId("wb-layers").getByRole("button", { name: /^Ellipse/ }).dblclick(); await w.getByTestId("wb-text-editor").waitFor(); await scan("text editor");
  await close(); await desktop([]);
  ok(bad.length === 0, bad.join("\n      "));
});

await browser.close();
finish();
