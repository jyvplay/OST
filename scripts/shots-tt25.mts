/** Visual-inspection screenshots for TT25 (not a test suite). Writes /home/user/shots/tt25-*.png and resets to Fusion. */
import { launchChromium } from "./browser-launch.mts";
const BASE = process.env.BASE ?? "http://localhost:3999";
const api = (method: string, path: string, body?: unknown) => fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json().catch(() => ({})));
const set = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
async function desktop(windows: unknown[]) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Build" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev } });
}
const w = (id: string, module: string, title: string, x: number, y: number, ww: number, h: number, z: number, extra = {}) => ({ id, module, title, x, y, w: ww, h, z, minimized: false, maximized: false, workspace: 1, host: "tab", props: {}, ...extra });
const browser = await launchChromium();
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
const shots: [string, string, string, string, (p: import("playwright").Page) => Promise<void>][] = [
  ["business-enterprise-light", "business", "enterprise", "light", async () => {}],
  ["business-enterprise-dark-start", "business", "enterprise", "dark", async (p) => { await p.getByTestId("launcher-button").click(); await p.waitForTimeout(400); }],
  ["art-graphite-light", "art", "graphite", "light", async () => {}],
  ["art-graphite-dark-magnify", "art", "graphite", "dark", async (p) => { const b = (await p.getByTestId("dock-writer").boundingBox())!; await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 }); await p.waitForTimeout(400); }],
  ["art-poolside-dark-launchpad", "art", "poolside", "dark", async (p) => { await p.getByTestId("dock-launchpad").click(); await p.waitForTimeout(500); }],
  ["fusion-enterprise-dark", "fusion", "enterprise", "dark", async () => {}],
  ["fusion-graphite-light", "fusion", "graphite", "light", async () => {}],
  ["business-vice-dark-jump", "business", "vice", "dark", async (p) => { await p.getByTestId("taskbar-files").click({ button: "right" }); await p.waitForTimeout(300); }],
];
for (const [name, layout, style, theme, act] of shots) {
  if (only.length && !only.includes(name)) continue;
  await set("appearance.layout", layout); await set("appearance.style", style); await set("appearance.theme", theme);
  await desktop([w("f1", "files", "Files", 40, 30, 760, 470, 11), w("s1", "sheet", "Spreadsheet", 520, 160, 820, 520, 12)]);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  await act(page);
  await page.screenshot({ path: `/home/user/shots/tt25-${name}.png` });
  await ctx.close();
  console.log("shot", name);
}
await set("appearance.layout", "fusion"); await set("appearance.style", "poolside"); await set("appearance.theme", "dark"); await desktop([]);
await browser.close();
