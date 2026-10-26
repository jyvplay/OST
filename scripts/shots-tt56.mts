/** TT56 visual check: switcher overlay, OSD pill, (Paste Special is covered visually by e2e-tt56's grid assertions). Writes docs/screens/tt56-*.png */
import { launchChromium } from "./browser-launch.mts";
const BASE = process.env.BASE ?? "http://localhost:3999";
const api = (m: string, p: string, b?: unknown) => fetch(BASE + p, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined }).then((r) => r.json());
const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1000;
const w = (id: string, module: string, title: string, i: number) => ({ id, module, title, x: 60 + i * 180, y: 60 + i * 50, w: 520, h: 380, z: 10 + i, minimized: false, maximized: false, workspace: 1, host: "tab", props: {} });
await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows: [w("a", "calculator", "Calculator", 0), w("b", "clock", "Clock", 1), w("c", "notes", "Notes", 2)], focus: "c", workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 40, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
const b = await launchChromium(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); const page = await ctx.newPage();
await page.goto(BASE + "/", { waitUntil: "domcontentloaded" }); await page.getByTestId("launcher-button").waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
await page.locator('.fs-window[aria-label="Notes"] .fs-titlebar').click({ position: { x: 300, y: 8 } });
await page.keyboard.down("Control"); await page.keyboard.press("Backquote"); await page.waitForTimeout(400);
await page.screenshot({ path: "docs/screens/tt56-switcher.png" });
await page.keyboard.press("Escape"); await page.keyboard.up("Control");
await page.keyboard.press("Meta+Shift+F"); await page.waitForTimeout(500);
await page.screenshot({ path: "docs/screens/tt56-focusmode-osd.png" });
await page.keyboard.press("Meta+Shift+F"); await page.waitForTimeout(300);
await b.close();
await api("PUT", "/api/state", { id: "default", revision: rev + 50, state: { windows: [], focus: null, workspaces: [{ id: 1, name: "Main" }], activeWorkspace: 1, nextZ: 10, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false } });
