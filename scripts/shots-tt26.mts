/** Visual-inspection screenshots for TT26 (not a test suite). Writes /home/user/shots/tt26-*.png and resets to Fusion/classic. */
import { launchChromium } from "./browser-launch.mts";
const BASE = process.env.BASE ?? "http://localhost:3999";
const api = (method: string, path: string, body?: unknown) => fetch(BASE + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json().catch(() => ({})));
const set = (key: string, value: string) => api("PUT", "/api/settings", { key, value });
async function desktop(windows: unknown[], extra: Record<string, unknown> = {}) {
  const cur = await api("GET", "/api/state?id=default"); const rev = Number(cur.row?.revision ?? 1) + 1000;
  await api("PUT", "/api/state", { id: "default", revision: rev, state: { windows, focus: (windows.at(-1) as { id?: string } | undefined)?.id ?? null, workspaces: [{ id: 1, name: "Main" }, { id: 2, name: "Build" }], activeWorkspace: 1, nextZ: 30, viewport: { w: 1440, h: 900 }, icons: [], focusMode: false, revision: rev, ...extra } });
}
const w = (id: string, module: string, title: string, x: number, y: number, ww: number, h: number, z: number, extra = {}) => ({ id, module, title, x, y, w: ww, h, z, minimized: false, maximized: false, workspace: 1, host: "tab", props: {}, ...extra });
const browser = await launchChromium();
const openWall = async (p: import("playwright").Page, w: string) => { const b = (await p.getByTestId(`tt-open-${w}`).boundingBox())!; await p.mouse.dblclick(b.x + b.width * (w === "north" || w === "south" ? 0.2 : 0.5), b.y + b.height * (w === "north" || w === "south" ? 0.5 : 0.3));
  // wait until the wall has really unfolded to fill the table (the transition can start late in software-rendered Chromium)
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const [f, t] = await Promise.all([p.getByTestId(`tt-wall-${w}`).boundingBox(), p.getByTestId("tabletop").boundingBox()]);
    if (f && t && Math.abs(f.width - t.width) < 2 && Math.abs(f.height - t.height) < 2) break;
    await p.waitForTimeout(100);
  }
};
const only = (process.env.ONLY ?? "").split(",").filter(Boolean);
const W = Number(process.env.W ?? 1440), H = Number(process.env.H ?? 900);
type Shot = [string, string, string, string, string, (p: import("playwright").Page) => Promise<void>, unknown[]?];
const minWin = [w("c1", "calculator", "Calculator", 900, 80, 320, 420, 11, { minimized: true })];
const shots: Shot[] = [
  ["art-dock-auto", "art", "poolside", "dark", "classic", async () => {}],
  ["art-dock-stack", "art", "poolside", "light", "classic", async (p) => { await p.getByTestId("dock-stack-Create").click(); await p.waitForTimeout(500); }],
  ["tabletop-floor", "fusion", "poolside", "dark", "tabletop", async () => {}],
  ["tabletop-floor-light", "art", "graphite", "light", "tabletop", async () => {}],
  ["tabletop-north", "fusion", "poolside", "dark", "tabletop", async (p) => { await openWall(p, "north"); await p.waitForTimeout(1200); }, minWin],
  ["tabletop-west", "fusion", "vice", "dark", "tabletop", async (p) => { await openWall(p, "west"); await p.waitForTimeout(1200); }],
  ["tabletop-east", "business", "enterprise", "light", "tabletop", async (p) => { await openWall(p, "east"); await p.waitForTimeout(1200); }],
  ["tabletop-south", "fusion", "poolside", "light", "tabletop", async (p) => { await openWall(p, "south"); await p.waitForTimeout(1200); }],
  ["tabletop-mid", "fusion", "poolside", "dark", "tabletop", async (p) => { await openWall(p, "north"); await p.waitForTimeout(300); }],
  ["tabletop-zoom", "fusion", "poolside", "dark", "tabletop", async (p) => { const c = p.getByTestId("tt-card").first(); await c.hover(); await p.waitForTimeout(1200); }],
  ["desk-icons", "fusion", "poolside", "dark", "classic", async () => {}],
];
for (const [name, layout, style, theme, view, act, wins] of shots) {
  if (only.length && !only.includes(name)) continue;
  await set("appearance.layout", layout); await set("appearance.style", style); await set("appearance.theme", theme); await set("appearance.desktopView", view);
  await desktop(wins ?? []);
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.locator("text=Starting Fusion Shell").waitFor({ state: "detached", timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(2500);
  await act(page);
  await page.screenshot({ path: `/home/user/shots/tt26-${name}${W !== 1440 ? `-${W}` : ""}.png` });
  await ctx.close();
  console.log("shot", name);
}
await set("appearance.layout", "fusion"); await set("appearance.style", "poolside"); await set("appearance.theme", "dark"); await set("appearance.desktopView", "classic"); await desktop([]);
await browser.close();
